/**
 * Stackd odds proxy — Cloudflare Worker  (stackd-api)
 *
 * Why this exists:
 *   1. The Odds API key lives here as a secret instead of in the page source,
 *      where every visitor could read it.
 *   2. Responses are cached at the edge, so ten people refreshing the board
 *      cost one upstream call instead of ten. Credits stop scaling with users
 *      and start scaling with how often we refresh.
 *
 * It mirrors The Odds API's own URL shape, so the client only had to swap its
 * base URL and drop the apiKey parameter.
 *
 * V1.4 — lead-time-aware caching.
 *   Odds for a game three days out do not move, but testing against them was
 *   burning a credit every minute. Odds responses are now cached according to
 *   how soon the earliest game in them starts: far out, 20 minutes; inside two
 *   hours of kickoff, back to the old short TTL so live prices stay honest.
 *
 * Deliberately written with no backticks or template literals, so the whole
 * source can be embedded in a deploy call without escaping hazards.
 *
 * CONFIG — Settings -> Variables and Secrets:
 *   ODDS_API_KEY    (Secret)  key from the-odds-api.com
 *   ALLOWED_ORIGINS (Text)    the site origin, e.g.
 *                             https://stackd.dev-gm-software.workers.dev
 *   Leaving ALLOWED_ORIGINS unset allows any origin.
 */

var UPSTREAM = "https://api.the-odds-api.com";

/* How close a game has to be before we stop caching it hard. Inside this
   window prices actually move, and a stale number is worse than a credit. */
var LIVE_WINDOW = 2 * 60 * 60; // 2 hours, seconds
var FAR_TTL = 20 * 60;         // 20 minutes, seconds

/* Only these shapes are proxied. Without an allowlist this would be an open
   proxy to anything on the upstream host, and eventually to your whole quota.
   timeAware routes get the lead-time treatment above; the rest keep a fixed
   TTL, either because they carry no kickoff times (/sports) or because they
   are inherently live (/scores). */
var ROUTES = [
  { re: /^\/v4\/sports\/?$/,                               ttl: 3600, timeAware: false },
  { re: /^\/v4\/sports\/[\w-]+\/odds\/?$/,                 ttl: 60,   timeAware: true  },
  { re: /^\/v4\/sports\/[\w-]+\/events\/?$/,               ttl: 300,  timeAware: false },
  { re: /^\/v4\/sports\/[\w-]+\/events\/[\w-]+\/odds\/?$/, ttl: 120,  timeAware: true  },
  { re: /^\/v4\/sports\/[\w-]+\/scores\/?$/,               ttl: 120,  timeAware: false }
];

/* Query params we forward upstream. Anything else (notably a client-supplied
   apiKey) is dropped — the key always comes from the secret. */
var PASS_PARAMS = new Set([
  "regions", "markets", "oddsFormat", "dateFormat",
  "daysFrom", "eventIds", "commenceTimeFrom", "commenceTimeTo", "bookmakers"
]);

/* Earliest commence_time in a response, as epoch seconds, or null if there
   isn't one. Handles both the array shape (a board of games) and the single
   object shape (one event's odds). */
function earliestCommence(body) {
  var items = Array.isArray(body) ? body : [body];
  var earliest = null;
  for (var i = 0; i < items.length; i++) {
    var it = items[i];
    if (!it || typeof it !== "object" || !it.commence_time) continue;
    var t = Date.parse(it.commence_time);
    if (isNaN(t)) continue;
    t = Math.floor(t / 1000);
    if (earliest === null || t < earliest) earliest = t;
  }
  return earliest;
}

/* The whole point of V1.4. Returns the TTL in seconds plus a label, so the
   decision is visible in response headers instead of being a mystery. */
function decideTtl(route, text) {
  if (!route.timeAware) return { ttl: route.ttl, tier: "fixed", leadSeconds: null };

  var body;
  try { body = JSON.parse(text); }
  catch (e) { return { ttl: route.ttl, tier: "unparsed", leadSeconds: null }; }

  var earliest = earliestCommence(body);
  if (earliest === null) return { ttl: route.ttl, tier: "no-kickoff", leadSeconds: null };

  var lead = earliest - Math.floor(Date.now() / 1000);

  /* Inside the live window, or already under way: short TTL, as before. */
  if (lead <= LIVE_WINDOW) {
    return { ttl: route.ttl, tier: "live", leadSeconds: lead };
  }

  /* Far out: cache hard, but never past the edge of the live window, so the
     first request after a game enters that window gets fresh prices rather
     than up to 20 minutes of staleness. */
  var headroom = lead - LIVE_WINDOW;
  var ttl = Math.max(route.ttl, Math.min(FAR_TTL, headroom));
  return { ttl: ttl, tier: "far", leadSeconds: lead };
}

function corsHeaders(request, env) {
  var origin = request.headers.get("Origin");
  var allowed = (env.ALLOWED_ORIGINS || "").split(",").map(function (s) { return s.trim(); })
    .filter(Boolean);

  /* No Origin header means this isn't a cross-origin browser request: it's a
     direct navigation, curl, or a server calling us. CORS is a browser-side
     rule that stops OTHER WEBSITES from reading our responses — it never could
     stop a non-browser client, which simply omits the header. Rejecting these
     would break the status page and debugging while adding no real security,
     so they pass through. */
  var allow = !origin ? "*"
    : allowed.length === 0 ? origin
    : allowed.indexOf(origin) !== -1 ? origin
    : null;

  if (allow === null) return null;

  return {
    "Access-Control-Allow-Origin": allow,
    "Vary": "Origin",
    // The app reads these; cross-origin reads of a custom header need it named
    // here or the browser hides it.
    "Access-Control-Expose-Headers":
      "x-requests-remaining, x-requests-used, x-stackd-cache, x-stackd-ttl, x-stackd-tier, x-stackd-lead",
    "Access-Control-Allow-Methods": "GET, OPTIONS",
    "Access-Control-Max-Age": "86400"
  };
}

export default {
  async fetch(request, env, ctx) {
    var url = new URL(request.url);
    var cors = corsHeaders(request, env);

    // Status first, so it stays reachable even if an origin is refused — it is
    // the quickest way to confirm the Worker is live and configured, and it
    // exposes no secret.
    if (url.pathname === "/" || url.pathname === "/__status") {
      return Response.json({
        service: "stackd-odds-proxy",
        version: "1.4",
        ok: true,
        keyConfigured: Boolean(env.ODDS_API_KEY),
        originsConfigured: (env.ALLOWED_ORIGINS || "").split(",").filter(Boolean).length,
        callerOrigin: request.headers.get("Origin") || "(none - direct visit)",
        originAccepted: cors !== null,
        caching: {
          liveWindowSeconds: LIVE_WINDOW,
          farTtlSeconds: FAR_TTL,
          note: "Odds responses cache for up to 20 min while the earliest game is more than 2h out, then revert to the short TTL."
        },
        routes: ROUTES.map(function (r) { return String(r.re) + (r.timeAware ? " [time-aware]" : " [" + r.ttl + "s]"); })
      }, { headers: cors || {} });
    }

    if (cors === null) {
      return new Response(
        JSON.stringify({ error: "Origin not allowed", origin: request.headers.get("Origin") }),
        { status: 403, headers: { "Content-Type": "application/json" } });
    }
    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: cors });
    }
    if (request.method !== "GET") {
      return new Response("Method not allowed", { status: 405, headers: cors });
    }

    var route = null;
    for (var i = 0; i < ROUTES.length; i++) {
      if (ROUTES[i].re.test(url.pathname)) { route = ROUTES[i]; break; }
    }
    if (!route) {
      return new Response(
        JSON.stringify({ error: "Not a proxied endpoint", path: url.pathname }),
        { status: 404, headers: Object.assign({}, cors, { "Content-Type": "application/json" }) });
    }

    if (!env.ODDS_API_KEY) {
      return new Response(
        JSON.stringify({ error: "ODDS_API_KEY secret is not set on this Worker." }),
        { status: 500, headers: Object.assign({}, cors, { "Content-Type": "application/json" }) });
    }

    // Rebuild the upstream URL from allowlisted params only, sorted so that
    // the same logical request always produces the same cache key.
    var upstream = new URL(UPSTREAM + url.pathname);
    var params = Array.from(url.searchParams.entries())
      .filter(function (e) { return PASS_PARAMS.has(e[0]); })
      .sort(function (a, b) { return a[0].localeCompare(b[0]); });
    for (var j = 0; j < params.length; j++) upstream.searchParams.set(params[j][0], params[j][1]);

    // Cache key deliberately excludes the API key, so it never lands in the
    // cache index. Shared site-wide, so one visitor's refresh serves everyone
    // routed through the same datacenter.
    var cacheKey = new Request(upstream.toString(), { method: "GET" });
    var cache = caches.default;

    var hit = await cache.match(cacheKey);
    if (hit) {
      var hh = new Headers(hit.headers);
      for (var k in cors) hh.set(k, cors[k]);
      hh.set("x-stackd-cache", "HIT");
      return new Response(hit.body, { status: hit.status, headers: hh });
    }

    upstream.searchParams.set("apiKey", env.ODDS_API_KEY);

    var res;
    try {
      res = await fetch(upstream.toString(), {
        headers: { "Accept": "application/json" },
        cf: { cacheTtl: 0, cacheEverything: false }
      });
    } catch (e) {
      return new Response(
        JSON.stringify({ error: "Upstream request failed: " + e.message }),
        { status: 502, headers: Object.assign({}, cors, { "Content-Type": "application/json" }) });
    }

    var body = await res.text();
    var headers = new Headers(Object.assign(
      { "Content-Type": "application/json" }, cors, { "x-stackd-cache": "MISS" }));

    // Forward the credit counters so the app's "N credits" display keeps working.
    var counters = ["x-requests-remaining", "x-requests-used"];
    for (var c = 0; c < counters.length; c++) {
      var v = res.headers.get(counters[c]);
      if (v !== null) headers.set(counters[c], v);
    }

    // Only cache successes. Caching an error would pin a transient failure in
    // place for the whole TTL.
    if (res.ok) {
      var decision = decideTtl(route, body);
      headers.set("Cache-Control", "public, max-age=" + decision.ttl);
      headers.set("x-stackd-ttl", String(decision.ttl));
      headers.set("x-stackd-tier", decision.tier);
      if (decision.leadSeconds !== null) {
        headers.set("x-stackd-lead", String(decision.leadSeconds));
      }
      var toCache = new Response(body, { status: 200, headers: new Headers(headers) });
      ctx.waitUntil(cache.put(cacheKey, toCache.clone()));
    } else {
      headers.set("Cache-Control", "no-store");
    }

    return new Response(body, { status: res.status, headers: headers });
  }
};

/* ---------------------------------------------------------------------------
 * NOT DONE YET, deliberately:
 *
 * Quota enforcement. The free-plan limits (3 searches, 1 scan per day) still
 * live in client-writable columns, so a determined user can reset them from
 * the browser console. The fix belongs here: verify the caller's Supabase JWT,
 * read their plan and counters with the service-role key, and refuse the
 * request before the upstream call.
 *
 * Cache scope. caches.default is per-datacenter, so one upstream fetch serves
 * everyone routed through that colo rather than everyone globally. At your
 * scale that's the difference between one call and dozens. If it ever needs to
 * be one call worldwide, a scheduled Cron Trigger writing to KV would do it —
 * but KV's free tier allows only ~1K writes/day, so that trade needs care.
 * ------------------------------------------------------------------------- */
