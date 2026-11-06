/**
 * Stackd — daily content engine.
 *
 * Runs on a Cron Trigger, scans every sport for the day's widest price
 * discrepancies, and composes ready-to-post copy. For now it EMAILS the
 * drafts for review rather than posting anywhere: nothing is published
 * without a human reading it first. Swapping in a posting API later means
 * changing deliver() and nothing else.
 *
 * Why a separate Worker from the site: a bug here must not be able to take
 * down stackdpicks.com or its SEO pages. The small helpers below are
 * deliberately duplicated from worker-site.js to keep that boundary real.
 *
 * Secrets:
 *   RESEND_API_KEY   from resend.com
 *   REVIEW_EMAIL     where drafts are sent
 *   ODDS_BASE        e.g. https://api.stackdpicks.com  (plain text is fine)
 */

export const SPORTS = [
  { key: "americanfootball_nfl",   label: "NFL",   tag: "#NFL" },
  { key: "basketball_nba",         label: "NBA",   tag: "#NBA" },
  { key: "icehockey_nhl",          label: "NHL",   tag: "#NHL" },
  { key: "americanfootball_ncaaf", label: "CFB",   tag: "#CFB" }
];

/* How far ahead to consider. Beyond a couple of days the books have not
   really disagreed yet; the gaps are noise, not signal. */
export const HORIZON_HOURS = 48;

/* A gap smaller than this is not worth a post — it is within the normal
   spread between books and makes Stackd look like it is manufacturing
   outrage over nothing. */
export const MIN_GAP_DOLLARS = 8;

export function slugify(s) {
  return String(s || "")
    .toLowerCase()
    .replace(/&/g, " and ")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

export function gameSlug(game) {
  return slugify(game.away_team) + "-vs-" + slugify(game.home_team);
}

export function americanStr(n) {
  if (n === null || n === undefined || isNaN(n)) return "n/a";
  return n > 0 ? "+" + n : String(n);
}

/* Profit on a $100 stake. This is the only honest way to compare two
   American prices: -110 and +110 are not 220 apart in any sense a bettor
   experiences. */
export function profitPer100(american) {
  if (american === null || american === undefined || isNaN(american)) return null;
  return american > 0 ? american : 10000 / Math.abs(american);
}

export function moneylineRows(game) {
  const rows = [];
  for (const bk of game.bookmakers || []) {
    const ml = (bk.markets || []).find(m => m.key === "h2h");
    if (!ml) continue;
    let away = null, home = null;
    for (const o of ml.outcomes || []) {
      if (o.name === game.away_team) away = o.price;
      if (o.name === game.home_team) home = o.price;
    }
    if (away === null && home === null) continue;
    rows.push({ book: bk.title || bk.key, away, home });
  }
  return rows;
}

/* The widest real payout gap on either side of one game. Returns null when
   no side has two differing prices. */
export function biggestGap(rows, game) {
  const sides = [
    { key: "away", team: game.away_team },
    { key: "home", team: game.home_team }
  ];
  let winner = null;
  for (const side of sides) {
    let best = null, worst = null, bestBook = null, worstBook = null;
    for (const r of rows) {
      const p = r[side.key];
      if (p === null || p === undefined) continue;
      if (best === null || p > best) { best = p; bestBook = r.book; }
      if (worst === null || p < worst) { worst = p; worstBook = r.book; }
    }
    if (best === null || worst === null || best === worst) continue;
    const delta = profitPer100(best) - profitPer100(worst);
    if (!winner || delta > winner.delta) {
      winner = { team: side.team, best, worst, bestBook, worstBook, delta };
    }
  }
  return winner;
}

export function dollars(n) {
  return "$" + (n < 10 ? n.toFixed(2) : String(Math.round(n)));
}

export function kickoffShort(iso, now) {
  const d = new Date(iso);
  const sameDay = now && d.toDateString() === new Date(now).toDateString();
  const t = d.toLocaleString("en-US", {
    hour: "numeric", minute: "2-digit", timeZone: "America/New_York", timeZoneName: "short"
  });
  if (sameDay) return "today " + t;
  return d.toLocaleString("en-US", {
    weekday: "short", month: "numeric", day: "numeric", timeZone: "America/New_York"
  }) + " " + t;
}

/* Rank every game in every sport by the size of its widest gap. */
export function rankDiscrepancies(bySport, now) {
  const out = [];
  const horizon = now + HORIZON_HOURS * 3600 * 1000;
  for (const { sport, games } of bySport) {
    for (const g of games || []) {
      const t = Date.parse(g.commence_time);
      if (!(t > now && t < horizon)) continue;
      const rows = moneylineRows(g);
      if (rows.length < 3) continue;       // too few books to claim a spread
      const gap = biggestGap(rows, g);
      if (!gap || gap.delta < MIN_GAP_DOLLARS) continue;
      out.push({
        sport, game: g, gap, books: rows.length,
        url: "https://stackdpicks.com/odds/" + sport.key + "/" + gameSlug(g),
        matchup: g.away_team + " vs " + g.home_team,
        kickoff: kickoffShort(g.commence_time, now)
      });
    }
  }
  out.sort((a, b) => b.gap.delta - a.gap.delta);
  return out;
}

/* ---- post composition -------------------------------------------------
   Each format is written for where it lands. The X post is one hook and one
   number; the Reddit post leads with the data and buries the link, because
   a post that reads like an ad gets removed. */

export function composeX(top) {
  const d = top[0];
  if (!d) return null;
  const lines = [
    `${d.matchup} — ${d.kickoff}`,
    ``,
    `${d.gap.team} moneyline:`,
    `${d.gap.bestBook} ${americanStr(d.gap.best)}`,
    `${d.gap.worstBook} ${americanStr(d.gap.worst)}`,
    ``,
    `Same bet. ${dollars(d.gap.delta)} difference per $100.`,
    ``,
    d.url
  ];
  return lines.join("\n");
}

/* `covered` is the list of sports whose feed actually answered. Claiming to
   have checked a sport whose feed errored would be a false statement in a
   post that goes out under the user's name. */
export function composeReddit(top, now, covered) {
  if (!top.length) return null;
  const date = new Date(now).toLocaleDateString("en-US", {
    weekday: "long", month: "long", day: "numeric", timeZone: "America/New_York"
  });
  const names = (covered && covered.length ? covered : SPORTS).map(s => s.label);
  const list = names.length > 1
    ? names.slice(0, -1).join(", ") + " and " + names[names.length - 1]
    : names[0];

  const out = [
    `**Widest moneyline gaps on the board today (${date})**`,
    ``,
    `Checked every ${list} game inside the next 48 hours. These are the spots ` +
    `where books disagree most, measured as profit on a $100 stake rather than ` +
    `raw American odds — which make a gap look bigger or smaller than it is ` +
    `depending on which side of even money it sits.`,
    ``
  ];
  for (const d of top) {
    out.push(`**${d.matchup}** — ${d.sport.label}, ${d.kickoff}`);
    out.push(`- ${d.gap.team}: ${d.gap.bestBook} has ${americanStr(d.gap.best)}, ` +
             `${d.gap.worstBook} has ${americanStr(d.gap.worst)}`);
    out.push(`- ${dollars(d.gap.delta)} difference per $100, across ${d.books} books`);
    out.push(`- Full table: ${d.url}`);
    out.push(``);
  }
  out.push(`Prices move, so confirm at the book before acting on any of this.`);
  return out.join("\n");
}

export function composeEmail(top, now, errors, covered) {
  const x = composeX(top);
  const reddit = composeReddit(top, now, covered);
  const esc = s => String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;");
  const body = [];
  body.push(`<div style="font:15px/1.6 -apple-system,Segoe UI,Helvetica,Arial,sans-serif;max-width:620px">`);
  body.push(`<h2 style="margin:0 0 4px">Stackd daily drafts</h2>`);
  body.push(`<p style="color:#5C6B85;margin:0 0 20px">${top.length} discrepanc` +
            `${top.length === 1 ? "y" : "ies"} over ${dollars(MIN_GAP_DOLLARS)} per $100. Nothing has been posted.</p>`);
  if (!top.length) {
    body.push(`<p>No gap cleared the ${dollars(MIN_GAP_DOLLARS)} threshold today. ` +
              `Skipping is the right call — posting a $3 difference trains people to ignore you.</p>`);
  } else {
    body.push(`<h3 style="margin:22px 0 6px">X / Twitter</h3>`);
    body.push(`<pre style="white-space:pre-wrap;background:#F4F6FA;border:1px solid #DDE3ED;` +
              `border-radius:8px;padding:12px;margin:0">${esc(x)}</pre>`);
    body.push(`<p style="color:#5C6B85;font-size:13px;margin:6px 0 0">${x.length} characters.</p>`);
    body.push(`<h3 style="margin:22px 0 6px">Reddit</h3>`);
    body.push(`<pre style="white-space:pre-wrap;background:#F4F6FA;border:1px solid #DDE3ED;` +
              `border-radius:8px;padding:12px;margin:0">${esc(reddit)}</pre>`);
  }
  if (errors && errors.length) {
    body.push(`<h3 style="margin:22px 0 6px;color:#B4442F">Feed problems</h3>`);
    body.push(`<ul>${errors.map(e => `<li>${esc(e)}</li>`).join("")}</ul>`);
  }
  body.push(`</div>`);
  return { subject: top.length
             ? `Stackd drafts — ${top[0].matchup}, ${dollars(top[0].gap.delta)} gap`
             : `Stackd — no gap worth posting today`,
           html: body.join("") };
}

/* ---- runtime ---------------------------------------------------------- */

async function loadSport(base, sport) {
  const url = `${base}/v4/sports/${sport.key}/odds/?regions=us,us2&markets=h2h&oddsFormat=american`;
  const res = await fetch(url, { headers: { Accept: "application/json" } });
  if (!res.ok) throw new Error(`${sport.label} feed ${res.status}`);
  const games = await res.json();
  if (!Array.isArray(games)) throw new Error(`${sport.label} feed returned a non-array`);
  return games;
}

export async function buildDrafts(env, now) {
  const base = env.ODDS_BASE || "https://api.stackdpicks.com";
  const bySport = [];
  const errors = [];
  for (const sport of SPORTS) {
    try { bySport.push({ sport, games: await loadSport(base, sport) }); }
    catch (e) { errors.push(e.message); }
  }
  const covered = bySport.map(b => b.sport);
  if (!covered.length) throw new Error("every odds feed failed: " + errors.join("; "));
  const ranked = rankDiscrepancies(bySport, now).slice(0, 3);
  return { ...composeEmail(ranked, now, errors, covered), count: ranked.length, errors };
}

async function deliver(env, draft) {
  const key = env.RESEND_API_KEY;
  const to = env.REVIEW_EMAIL;
  if (!key || !to) throw new Error("RESEND_API_KEY or REVIEW_EMAIL not configured");
  const res = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      from: "Stackd <drafts@stackdpicks.com>",
      to: [to],
      subject: draft.subject,
      html: draft.html
    })
  });
  if (!res.ok) throw new Error(`Resend ${res.status}: ${(await res.text()).slice(0, 200)}`);
  return true;
}

export default {
  async scheduled(event, env, ctx) {
    ctx.waitUntil((async () => {
      try {
        const draft = await buildDrafts(env, Date.now());
        await deliver(env, draft);
        console.log(`sent ${draft.count} draft(s)`);
      } catch (e) {
        console.error("daily content run failed:", e.message);
      }
    })());
  },

  /* A manual trigger so the run can be exercised without waiting for the
     cron. Key-gated: this spends odds credits and sends mail. */
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname !== "/__run") return new Response("Not found", { status: 404 });
    if (!env.RUN_KEY || url.searchParams.get("key") !== env.RUN_KEY) {
      return new Response("Forbidden", { status: 403 });
    }
    const draft = await buildDrafts(env, Date.now());
    if (url.searchParams.get("send") === "1") {
      await deliver(env, draft);
      return Response.json({ sent: true, count: draft.count, errors: draft.errors });
    }
    return new Response(draft.html, {
      headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" }
    });
  }
};
