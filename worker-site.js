/**
 * Stackd site Worker — serves the app straight from GitHub.
 *
 * Why it works this way:
 *   The page is a single 147KB HTML file. Writing it into a Worker script means
 *   retyping the whole file into every deploy call — slow, and one wrong
 *   character corrupts the app silently. Git sends the file from disk instead,
 *   byte-exact, so the deployed Worker never has to change. It just reads
 *   whatever is currently on the branch.
 *
 * Deploying a new version is therefore:  git push
 *
 * The repo is public, so no credential is involved. index.html is already
 * handed verbatim to every visitor, and the only keys in it (Supabase URL and
 * anon key) are public by design and guarded by row-level security. The Odds
 * API key lives on the stackd-api Worker as a secret and is never in this file.
 *
 * Deliberately written with no backticks or template literals, so the whole
 * source can be embedded in a deploy call without escaping hazards.
 *
 * CONFIG — Settings -> Variables and Secrets:
 *   GITHUB_REPO   (Text)    devgmsoftware-code/stackd-site
 *   GITHUB_BRANCH (Text)    main                (optional, defaults to main)
 *   PURGE_KEY     (Secret)  random string, used by /__purge
 */

var FILE = "index.html";
var EDGE_TTL = 60;      // how long a fetched page is held at our edge
var ORIGIN_BUCKET = 30; // seconds; granularity of the GitHub CDN cache-buster

function pageHeaders(extra) {
  var h = {
    "content-type": "text/html; charset=utf-8",
    // Short, so a push goes live on its own, while still collapsing a burst of
    // traffic into a single origin read.
    "cache-control": "public, max-age=" + EDGE_TTL,
    "x-content-type-options": "nosniff",
    "referrer-policy": "strict-origin-when-cross-origin"
  };
  if (extra) { for (var k in extra) h[k] = extra[k]; }
  return h;
}

async function fetchPage(env) {
  var repo = env.GITHUB_REPO;
  if (!repo) throw new Error("GITHUB_REPO is not set on this Worker.");
  var branch = env.GITHUB_BRANCH || "main";

  /* raw.githubusercontent.com tells intermediaries to cache for five minutes,
     which would delay a push by that long. A query string does not change what
     GitHub serves but does change its cache key, so bucketing the clock into
     30s slots gets a fresh copy without hammering the origin on every hit. */
  var bust = Math.floor(Date.now() / (ORIGIN_BUCKET * 1000));
  var url = "https://raw.githubusercontent.com/" + repo + "/" + branch + "/" + FILE + "?cb=" + bust;

  var res = await fetch(url, {
    headers: {
      "User-Agent": "stackd-site-worker",
      "Accept": "text/html",
      // Ask intermediaries not to hand back a stored copy. Not every CDN
      // honours this, which is what the cb= parameter above is for.
      "Cache-Control": "no-cache"
    },
    cf: { cacheTtl: 0, cacheEverything: false }
  });

  if (!res.ok) {
    throw new Error("GitHub returned " + res.status + " for " + repo + "@" + branch + "/" + FILE);
  }

  var html = await res.text();
  /* A truncated or wrong-branch read would otherwise be cached and served as a
     blank page, which is far harder to diagnose than a loud failure. */
  if (!/<\/html>\s*$/i.test(html)) {
    throw new Error("Fetched page looks truncated (" + html.length + " bytes, no closing html tag).");
  }
  return html;
}

/**
 * Stackd — server-rendered pages for search engines.
 *
 * The app itself is a single-page React build transpiled in the browser,
 * which is close to the worst possible shape for indexing: a crawler has to
 * execute Babel over 200KB before any content exists. These pages sidestep
 * that entirely by rendering real HTML on the edge, with the comparison
 * table already in the markup.
 *
 * The economics work because one board request returns every game in a
 * league. Twenty-eight NFL game pages cost a single upstream call, already
 * cached by the proxy, so a crawler sweeping the whole site spends almost
 * nothing.
 *
 * Deliberately NOT mass-produced. A page exists only where there is a real
 * priced market to show, finished games are removed rather than left to rot,
 * and each page carries the actual numbers rather than spun text around a
 * team name. Thin programmatic pages are actively demoted, and a few hundred
 * useful ones beat ten thousand empty ones.
 *
 * No backticks anywhere: this file is embedded in a deploy call inside a
 * template literal.
 */

var SEO_SPORTS = [
  { key: "americanfootball_nfl", label: "NFL",  noun: "NFL football" },
  { key: "basketball_nba",       label: "NBA",  noun: "NBA basketball" },
  { key: "icehockey_nhl",        label: "NHL",  noun: "NHL hockey" },
  { key: "americanfootball_ncaaf", label: "College football", noun: "college football" }
];

var SEO_TTL = 600;          // seconds a rendered page is held at the edge
var STALE_AFTER = 6 * 3600; // a game this long past kickoff is delisted

function sportByKey(key) {
  for (var i = 0; i < SEO_SPORTS.length; i++) {
    if (SEO_SPORTS[i].key === key) return SEO_SPORTS[i];
  }
  return null;
}

function slugify(s) {
  return String(s || "")
    .toLowerCase()
    .replace(/&/g, " and ")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

function gameSlug(game) {
  return slugify(game.away_team) + "-vs-" + slugify(game.home_team);
}

function esc(s) {
  return String(s === null || s === undefined ? "" : s)
    .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function americanStr(n) {
  if (n === null || n === undefined || isNaN(n)) return "—";
  return n > 0 ? "+" + n : String(n);
}

/* Higher American odds pay more on the same stake, on both sides of a
   moneyline, so "best" is simply the maximum. */
function bestOf(rows, side) {
  var best = null;
  for (var i = 0; i < rows.length; i++) {
    var p = rows[i][side];
    if (p === null || p === undefined) continue;
    if (best === null || p > best) best = p;
  }
  return best;
}

/* Flattens one game's bookmaker list into a row per book, moneyline only.
   Spreads and totals live in the app; duplicating them here would make a
   page that is mostly table and no reason to click through. */
function moneylineRows(game) {
  var rows = [];
  var books = game.bookmakers || [];
  for (var i = 0; i < books.length; i++) {
    var bk = books[i];
    var mkts = bk.markets || [];
    var ml = null;
    for (var m = 0; m < mkts.length; m++) if (mkts[m].key === "h2h") ml = mkts[m];
    if (!ml) continue;
    var away = null, home = null;
    var outs = ml.outcomes || [];
    for (var o = 0; o < outs.length; o++) {
      if (outs[o].name === game.away_team) away = outs[o].price;
      if (outs[o].name === game.home_team) home = outs[o].price;
    }
    if (away === null && home === null) continue;
    rows.push({ book: bk.title || bk.key, away: away, home: home });
  }
  rows.sort(function (a, b) { return String(a.book).localeCompare(String(b.book)); });
  return rows;
}

function kickoffText(iso) {
  try {
    return new Date(iso).toLocaleString("en-US", {
      weekday: "long", month: "long", day: "numeric",
      hour: "numeric", minute: "2-digit", timeZone: "America/New_York",
      timeZoneName: "short"
    });
  } catch (e) { return ""; }
}

function layout(opts) {
  var canonical = "https://stackdpicks.com" + opts.path;
  var out = [];
  out.push("<!doctype html><html lang='en'><head><meta charset='utf-8'>");
  out.push("<meta name='viewport' content='width=device-width, initial-scale=1'>");
  out.push("<title>" + esc(opts.title) + "</title>");
  out.push("<meta name='description' content='" + esc(opts.description) + "'>");
  out.push("<link rel='canonical' href='" + esc(canonical) + "'>");
  if (opts.noindex) out.push("<meta name='robots' content='noindex,follow'>");
  out.push("<meta property='og:title' content='" + esc(opts.title) + "'>");
  out.push("<meta property='og:description' content='" + esc(opts.description) + "'>");
  out.push("<meta property='og:url' content='" + esc(canonical) + "'>");
  out.push("<meta property='og:type' content='website'>");
  if (opts.jsonld) {
    out.push("<script type='application/ld+json'>" + JSON.stringify(opts.jsonld) + "<\/script>");
  }
  out.push("<style>");
  out.push(":root{--ink:#101A33;--slate:#5C6B85;--line:#DDE3ED;--paper:#F4F6FA;--flare:#FF5A45;--card:#fff}");
  out.push("*{box-sizing:border-box}body{margin:0;background:var(--paper);color:var(--ink);");
  out.push("font:16px/1.6 -apple-system,BlinkMacSystemFont,'Segoe UI',Helvetica,Arial,sans-serif}");
  out.push(".wrap{max-width:760px;margin:0 auto;padding:24px 16px 56px}");
  out.push("header{background:var(--ink);padding:14px 0;margin-bottom:28px}");
  out.push("header .wrap{padding:0 16px}");
  out.push("header a{color:#fff;font-weight:800;font-size:19px;text-decoration:none;letter-spacing:-.4px}");
  out.push("header a span{color:var(--flare)}");
  out.push("h1{font-size:27px;line-height:1.25;margin:0 0 8px}");
  out.push("h2{font-size:18px;margin:32px 0 10px}");
  out.push("p{margin:0 0 14px}.sub{color:var(--slate);margin-bottom:22px}");
  out.push("table{width:100%;border-collapse:collapse;background:var(--card);");
  out.push("border:1px solid var(--line);border-radius:10px;overflow:hidden;font-size:15px}");
  out.push("th,td{padding:10px 12px;text-align:left;border-bottom:1px solid var(--line)}");
  out.push("th{font-size:12px;text-transform:uppercase;letter-spacing:.06em;color:var(--slate)}");
  out.push("tr:last-child td{border-bottom:0}");
  out.push("td.num{font-variant-numeric:tabular-nums;text-align:right}");
  out.push("td.best{color:var(--flare);font-weight:700}");
  out.push(".cta{display:inline-block;margin:10px 0 0;background:var(--flare);color:#fff;");
  out.push("padding:11px 20px;border-radius:8px;text-decoration:none;font-weight:600}");
  out.push("ul{padding-left:20px}li{margin:6px 0}");
  out.push("a{color:var(--ink)}");
  out.push("footer{margin-top:40px;padding-top:18px;border-top:1px solid var(--line);");
  out.push("color:var(--slate);font-size:12.5px}");
  out.push("</style></head><body>");
  out.push("<header><div class='wrap'><a href='/'>STACK<span>D</span></a></div></header>");
  out.push("<div class='wrap'>");
  out.push(opts.body);
  out.push("<footer><p><strong>Stackd compares prices. It never takes wagers.</strong> ");
  out.push("Odds come from a third-party feed and can lag a book's own app — confirm at the ");
  out.push("sportsbook before betting. Not affiliated with any sportsbook.</p>");
  out.push("<p><strong>21+</strong>. If gambling stops being fun, call 1-800-GAMBLER. ");
  out.push("<a href='/privacy'>Privacy</a> · <a href='/terms'>Terms</a></p></footer>");
  out.push("</div></body></html>");
  return out.join("");
}

/* Payout on a $100 stake, so the two sides of a game can be compared on the
   same scale instead of on American odds, where -470 and +400 are not
   remotely comparable numbers. */
function profitPer100(american) {
  if (american === null || american === undefined || isNaN(american)) return null;
  return american > 0 ? american : 10000 / Math.abs(american);
}

function biggestGap(rows, game) {
  var sides = [
    { key: "away", team: game.away_team },
    { key: "home", team: game.home_team }
  ];
  var winner = null;
  for (var s = 0; s < sides.length; s++) {
    var best = null, worst = null;
    for (var i = 0; i < rows.length; i++) {
      var p = rows[i][sides[s].key];
      if (p === null || p === undefined) continue;
      if (best === null || p > best) best = p;
      if (worst === null || p < worst) worst = p;
    }
    if (best === null || worst === null || best === worst) continue;
    var delta = profitPer100(best) - profitPer100(worst);
    if (!winner || delta > winner.delta) {
      winner = {
        team: sides[s].team, best: best, worst: worst, delta: delta,
        perHundred: "$" + (delta < 10 ? delta.toFixed(2) : Math.round(delta))
      };
    }
  }
  return winner;
}

function gamePage(sport, game, updatedISO) {
  var rows = moneylineRows(game);
  var bestAway = bestOf(rows, "away");
  var bestHome = bestOf(rows, "home");
  var matchup = game.away_team + " vs " + game.home_team;
  var kickoff = kickoffText(game.commence_time);
  var started = Date.parse(game.commence_time) < Date.now();

  var body = [];
  body.push("<h1>" + esc(matchup) + " odds</h1>");
  body.push("<p class='sub'>Moneyline compared across " + rows.length +
            " sportsbook" + (rows.length === 1 ? "" : "s") +
            (kickoff ? ". " + esc(kickoff) : "") + ".</p>");

  if (rows.length === 0) {
    body.push("<p>No sportsbook is posting a moneyline for this game yet. " +
              "Prices usually appear closer to kickoff.</p>");
  } else {
    /* The spread between best and worst is the entire argument for the
       product, so it is stated in words rather than left to be inferred from
       the table. Whichever side has the larger gap in actual payout is the
       one worth quoting: on a heavy favourite, -470 against -520 is true but
       dull, while +400 against +430 on the other side is the same game and
       far more obviously money. */
    var gap = biggestGap(rows, game);
    if (gap) {
      body.push("<p>On " + esc(gap.team) + " alone, the best price is " +
                "<strong>" + americanStr(gap.best) + "</strong> and the worst is " +
                "<strong>" + americanStr(gap.worst) + "</strong> \u2014 a " +
                gap.perHundred + " difference on a $100 bet. Same wager, different payout.</p>");
    }

    body.push("<table><thead><tr><th>Sportsbook</th>");
    body.push("<th class='num'>" + esc(game.away_team) + "</th>");
    body.push("<th class='num'>" + esc(game.home_team) + "</th></tr></thead><tbody>");
    for (var r = 0; r < rows.length; r++) {
      var row = rows[r];
      body.push("<tr><td>" + esc(row.book) + "</td>");
      body.push("<td class='num" + (row.away !== null && row.away === bestAway ? " best" : "") +
                "'>" + americanStr(row.away) + "</td>");
      body.push("<td class='num" + (row.home !== null && row.home === bestHome ? " best" : "") +
                "'>" + americanStr(row.home) + "</td></tr>");
    }
    body.push("</tbody></table>");
    body.push("<p style='color:var(--slate);font-size:13px;margin-top:10px'>" +
              "Best price on each side in red. Updated " + esc(updatedISO) + ".</p>");
  }

  body.push("<p><a class='cta' href='/'>Compare spreads, totals and props &rarr;</a></p>");

  body.push("<h2>Why the same bet pays differently</h2>");
  body.push("<p>Sportsbooks price independently. They start from similar numbers, " +
            "then move on their own customers' bets, so the same outcome can be " +
            "worth noticeably more at one book than another at the same moment. " +
            "Taking the best available price costs nothing and compounds over a season.</p>");
  body.push("<p>Stackd also prices a whole parlay at each book at once — the book with " +
            "the best price on one leg often is not the best on the slip.</p>");

  var jsonld = {
    "@context": "https://schema.org",
    "@type": "SportsEvent",
    "name": matchup,
    "startDate": game.commence_time,
    "eventStatus": "https://schema.org/EventScheduled",
    "competitor": [
      { "@type": "SportsTeam", "name": game.away_team },
      { "@type": "SportsTeam", "name": game.home_team }
    ]
  };

  return layout({
    path: "/odds/" + sport.key + "/" + gameSlug(game),
    title: matchup + " odds — every sportsbook compared | Stackd",
    description: "Compare " + matchup + " moneyline odds across every major sportsbook. " +
                 "See which book pays most on each side" + (kickoff ? ", " + kickoff : "") + ".",
    /* A finished game keeps its page for anyone holding the link, but asks
       not to be indexed: a search result promising live odds for a game that
       ended yesterday is a bad result. */
    noindex: started,
    jsonld: jsonld,
    body: body.join("")
  });
}

function indexPage(sport, games) {
  var body = [];
  body.push("<h1>" + esc(sport.label) + " odds comparison</h1>");
  body.push("<p class='sub'>Every upcoming " + esc(sport.noun) +
            " game, priced at every major sportsbook.</p>");
  if (games.length === 0) {
    body.push("<p>No upcoming games are posted right now. Check back closer to the next slate.</p>");
  } else {
    body.push("<ul>");
    for (var i = 0; i < games.length; i++) {
      var g = games[i];
      body.push("<li><a href='/odds/" + sport.key + "/" + gameSlug(g) + "'>" +
                esc(g.away_team) + " vs " + esc(g.home_team) + "</a> — " +
                esc(kickoffText(g.commence_time)) + "</li>");
    }
    body.push("</ul>");
  }
  body.push("<p><a class='cta' href='/'>Open the live board &rarr;</a></p>");
  return layout({
    path: "/odds/" + sport.key,
    title: sport.label + " odds — compare every sportsbook | Stackd",
    description: "Compare " + sport.noun + " odds across every major sportsbook. " +
                 "Find the best price on each side of every upcoming game.",
    body: body.join("")
  });
}


/* ---------------------------------------------------------------------------
 * SEO routing
 * ------------------------------------------------------------------------- */

/* One board request returns every game in a league, so a whole league's pages
   are rendered from a single fetch that the proxy has usually already cached.
   The board endpoint is one of the open ones, so no token is involved. */
async function loadBoard(sportKey) {
  var url = "https://api.stackdpicks.com/v4/sports/" + sportKey +
            "/odds/?regions=us,us2&markets=h2h&oddsFormat=american";
  var res = await fetch(url, { headers: { "Accept": "application/json" } });
  if (!res.ok) throw new Error("board " + res.status);
  return await res.json();
}

function upcoming(games) {
  var cutoff = Date.now() - STALE_AFTER * 1000;
  return games.filter(function (g) { return Date.parse(g.commence_time) > cutoff; })
              .sort(function (a, b) {
                return Date.parse(a.commence_time) - Date.parse(b.commence_time);
              });
}

async function handleSeo(url, cache) {
  var parts = url.pathname.split("/").filter(Boolean); // ["odds", sport, slug?]
  var sport = sportByKey(parts[1] || "");
  if (!sport) return null;

  var cached = await cache.match(new Request(url.toString()));
  if (cached) return cached;

  var games;
  try { games = await loadBoard(sport.key); }
  catch (e) { return { upstreamDown: true }; }
  if (!Array.isArray(games)) return { upstreamDown: true };

  var html, status = 200;

  if (parts.length === 2) {
    html = indexPage(sport, upcoming(games));
  } else {
    var slug = parts[2];
    var match = null;
    for (var i = 0; i < games.length; i++) {
      if (gameSlug(games[i]) === slug) { match = games[i]; break; }
    }
    /* A slug that matches nothing is almost always a game that has finished
       and dropped out of the feed. 404 is the honest answer and keeps it out
       of the index. */
    if (!match) return null;
    html = gamePage(sport, match, new Date().toISOString().slice(0, 16).replace("T", " ") + " UTC");
  }

  var res = new Response(html, {
    status: status,
    headers: {
      "content-type": "text/html; charset=utf-8",
      "cache-control": "public, max-age=" + SEO_TTL,
      "x-stackd-rendered": "edge"
    }
  });
  return res;
}

async function sitemap() {
  var out = [];
  out.push("<?xml version='1.0' encoding='UTF-8'?>");
  out.push("<urlset xmlns='http://www.sitemaps.org/schemas/sitemap/0.9'>");
  function add(loc, freq, pri) {
    out.push("<url><loc>https://stackdpicks.com" + loc + "</loc>" +
             "<changefreq>" + freq + "</changefreq>" +
             "<priority>" + pri + "</priority></url>");
  }
  add("/", "hourly", "1.0");
  add("/privacy", "yearly", "0.2");
  add("/terms", "yearly", "0.2");

  for (var s = 0; s < SEO_SPORTS.length; s++) {
    var sport = SEO_SPORTS[s];
    add("/odds/" + sport.key, "hourly", "0.8");
    try {
      var games = upcoming(await loadBoard(sport.key));
      for (var i = 0; i < games.length; i++) {
        /* Only games with a real priced market are listed. Submitting empty
           pages is how a site teaches Google that its pages are empty. */
        if (moneylineRows(games[i]).length === 0) continue;
        add("/odds/" + sport.key + "/" + gameSlug(games[i]), "hourly", "0.7");
      }
    } catch (e) { /* skip a league the feed is unhappy about */ }
  }
  out.push("</urlset>");
  return out.join("");
}

function robots() {
  return [
    "User-agent: *",
    "Allow: /",
    "Disallow: /__status",
    "Disallow: /__purge",
    "",
    "Sitemap: https://stackdpicks.com/sitemap.xml",
    ""
  ].join("\n");
}

export default {
  async fetch(request, env, ctx) {
    var url = new URL(request.url);
    var cache = caches.default;
    // One entry for the whole site, keyed independently of the visitor's path
    // so deep links share the cached page.
    var cacheKey = new Request(new URL("/__page", url).toString(), { method: "GET" });

    // --- instant cache drop, for when waiting 60s is too slow --------------
    if (url.pathname === "/__purge") {
      if (!env.PURGE_KEY || url.searchParams.get("key") !== env.PURGE_KEY) {
        return new Response("Forbidden", { status: 403 });
      }
      var purged = await cache.delete(cacheKey);
      return Response.json({ purged: purged }, { headers: { "cache-control": "no-store" } });
    }

    // --- health check; safe to visit, exposes no secret -------------------
    if (url.pathname === "/__status") {
      var ok = true, error = null, bytes = null;
      try { bytes = (await fetchPage(env)).length; }
      catch (e) { ok = false; error = e.message; }
      return Response.json({
        service: "stackd-site",
        ok: ok,
        error: error,
        pageBytes: bytes,
        repo: env.GITHUB_REPO || null,
        branch: env.GITHUB_BRANCH || "main",
        purgeConfigured: Boolean(env.PURGE_KEY)
      }, { headers: { "cache-control": "no-store" } });
    }

    if (url.pathname === "/robots.txt") {
      return new Response(robots(), {
        headers: { "content-type": "text/plain; charset=utf-8",
                   "cache-control": "public, max-age=86400" } });
    }

    if (url.pathname === "/sitemap.xml") {
      var sm = await cache.match(new Request(url.toString()));
      if (!sm) {
        sm = new Response(await sitemap(), {
          headers: { "content-type": "application/xml; charset=utf-8",
                     "cache-control": "public, max-age=1800" } });
        ctx.waitUntil(cache.put(new Request(url.toString()), sm.clone()));
      }
      return sm;
    }

    /* Server-rendered pages for crawlers. Checked before the catch-all that
       serves the app, and falls through to it if the league or game is not
       one we render. */
    if (url.pathname.indexOf("/odds/") === 0) {
      var seoRes = await handleSeo(url, cache);
      /* A feed hiccup must not answer 404: that is how a crawler learns to
         drop pages that are perfectly real. 503 asks it to come back. */
      if (seoRes && seoRes.upstreamDown) {
        return new Response("Odds feed unavailable, try again shortly.", {
          status: 503,
          headers: { "content-type": "text/plain", "retry-after": "600",
                     "cache-control": "no-store" } });
      }
      if (seoRes) {
        ctx.waitUntil(cache.put(new Request(url.toString()), seoRes.clone()));
        return seoRes;
      }
      return new Response("Not found", {
        status: 404,
        headers: { "content-type": "text/plain", "cache-control": "no-store" } });
    }

    if (url.pathname === "/favicon.ico") {
      return new Response(null, { status: 204, headers: { "cache-control": "public, max-age=86400" } });
    }

    if (request.method !== "GET" && request.method !== "HEAD") {
      return new Response("Method not allowed", { status: 405 });
    }

    /* ?fresh=<PURGE_KEY> skips every layer of caching and does not store the
       result. This exists because when the site serves a stale page there is
       otherwise no way to tell which cache is holding it — ours, Cloudflare's
       subrequest cache, or GitHub's CDN. Gated on the key so it can't be used
       to bypass caching for real traffic. */
    var forceFresh = Boolean(env.PURGE_KEY) && url.searchParams.get("fresh") === env.PURGE_KEY;
    if (forceFresh) {
      try {
        var fresh = await fetchPage(env);
        return new Response(fresh, {
          status: 200,
          headers: pageHeaders({ "cache-control": "no-store", "x-stackd-cache": "BYPASS" })
        });
      } catch (e2) {
        return new Response("bypass fetch failed: " + e2.message, {
          status: 502, headers: { "content-type": "text/plain", "cache-control": "no-store" } });
      }
    }

    var hit = await cache.match(cacheKey);
    if (hit) {
      var hh = new Headers(hit.headers);
      hh.set("x-stackd-cache", "HIT");
      return new Response(hit.body, { status: 200, headers: hh });
    }

    var html;
    try {
      html = await fetchPage(env);
    } catch (e) {
      var safe = String(e.message).replace(/&/g, "&amp;").replace(/</g, "&lt;");
      return new Response(
        '<!doctype html><meta charset="utf-8"><title>Stackd - temporarily unavailable</title>' +
        '<body style="font:16px/1.5 system-ui;max-width:40rem;margin:4rem auto;padding:0 1rem">' +
        "<h1>Stackd is temporarily unavailable</h1>" +
        "<p>The page could not be loaded from its source repository.</p>" +
        '<pre style="white-space:pre-wrap;color:#a33">' + safe + "</pre>",
        // Never cache a failure: it would pin the outage in place for the TTL.
        { status: 503, headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" } });
    }

    ctx.waitUntil(cache.put(cacheKey, new Response(html, { status: 200, headers: pageHeaders() })));
    return new Response(html, { status: 200, headers: pageHeaders({ "x-stackd-cache": "MISS" }) });
  }
};
