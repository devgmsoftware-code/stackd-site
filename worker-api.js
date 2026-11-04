/**
 * Stackd odds proxy — Cloudflare Worker
 * Deploy as its own code Worker: stackd-api.dev-gm-software.workers.dev
 * (separate from the static-assets Worker that serves the site)
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
 * SETUP (dashboard):
 *   Settings → Variables and Secrets
 *     ODDS_API_KEY    (Secret)  your key from the-odds-api.com
 *     ALLOWED_ORIGINS (Text)    the SITE's origin, i.e.
 *                               https://stackd.dev-gm-software.workers.dev
 *   Leaving ALLOWED_ORIGINS unset allows any origin — fine while testing,
 *   worth setting before the link spreads.
 */

const UPSTREAM = "https://api.the-odds-api.com";

/* Only these shapes are proxied. Without an allowlist this would be an open
   proxy to anything on the upstream host, and eventually to your whole quota. */
const ROUTES = [
  { re: /^\/v4\/sports\/?$/,                                      ttl: 3600 },
  { re: /^\/v4\/sports\/[\w-]+\/odds\/?$/,                        ttl: 60   },
  { re: /^\/v4\/sports\/[\w-]+\/events\/?$/,                      ttl: 300  },
  { re: /^\/v4\/sports\/[\w-]+\/events\/[\w-]+\/odds\/?$/,        ttl: 120  },
  { re: /^\/v4\/sports\/[\w-]+\/scores\/?$/,                      ttl: 120  },
];

/* Query params we forward upstream. Anything else (notably a client-supplied
   apiKey) is dropped — the key always comes from the secret. */
const PASS_PARAMS = new Set([
  "regions", "markets", "oddsFormat", "dateFormat",
  "daysFrom", "eventIds", "commenceTimeFrom", "commenceTimeTo", "bookmakers",
]);

function corsHeaders(request, env) {
  const origin = request.headers.get("Origin");
  const allowed = (env.ALLOWED_ORIGINS || "")
    .split(",").map(s => s.trim()).filter(Boolean);

  /* No Origin header means this isn't a cross-origin browser request: it's a
     direct navigation, curl, or a server calling us. CORS is a browser-side
     rule that stops OTHER WEBSITES from reading our responses — it never could
     stop a non-browser client, which simply omits the header. Rejecting these
     would break the status page and debugging while adding no real security,
     so they pass through. */
  const allow = !origin ? "*"
    : allowed.length === 0 ? origin          // no allowlist set → permissive
    : allowed.includes(origin) ? origin      // on the allowlist
    : null;                                  // a real cross-origin caller we don't know

  if (allow === null) return null;

  return {
    "Access-Control-Allow-Origin": allow,
    "Vary": "Origin",
    // The app reads this to show your remaining credits; cross-origin reads of
    // a custom header need it named here or the browser hides it.
    "Access-Control-Expose-Headers": "x-requests-remaining, x-requests-used, x-stackd-cache",
    "Access-Control-Allow-Methods": "GET, OPTIONS",
    "Access-Control-Max-Age": "86400",
  };
}

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const cors = corsHeaders(request, env);

    // Status first, so it stays reachable even if an origin is refused — it is
    // the quickest way to confirm the Worker is live and configured, and it
    // exposes no secret.
    if (url.pathname === "/" || url.pathname === "/__status") {
      return Response.json({
        service: "stackd-odds-proxy",
        ok: true,
        keyConfigured: Boolean(env.ODDS_API_KEY),
        originsConfigured: (env.ALLOWED_ORIGINS || "").split(",").filter(Boolean).length,
        callerOrigin: request.headers.get("Origin") || "(none — direct visit)",
        originAccepted: cors !== null,
        routes: ROUTES.map(r => String(r.re)),
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

    const route = ROUTES.find(r => r.re.test(url.pathname));
    if (!route) {
      return new Response(
        JSON.stringify({ error: "Not a proxied endpoint", path: url.pathname }),
        { status: 404, headers: { ...cors, "Content-Type": "application/json" } });
    }

    if (!env.ODDS_API_KEY) {
      return new Response(
        JSON.stringify({ error: "ODDS_API_KEY secret is not set on this Worker." }),
        { status: 500, headers: { ...cors, "Content-Type": "application/json" } });
    }

    // Rebuild the upstream URL from allowlisted params only, sorted so that
    // the same logical request always produces the same cache key.
    const upstream = new URL(UPSTREAM + url.pathname);
    const params = [...url.searchParams.entries()]
      .filter(([k]) => PASS_PARAMS.has(k))
      .sort(([a], [b]) => a.localeCompare(b));
    for (const [k, v] of params) upstream.searchParams.set(k, v);

    // Cache key deliberately excludes the API key, so it never lands in the
    // cache index.
    const cacheKey = new Request(upstream.toString(), { method: "GET" });
    const cache = caches.default;

    let hit = await cache.match(cacheKey);
    if (hit) {
      const headers = new Headers(hit.headers);
      Object.entries(cors).forEach(([k, v]) => headers.set(k, v));
      headers.set("x-stackd-cache", "HIT");
      return new Response(hit.body, { status: hit.status, headers });
    }

    upstream.searchParams.set("apiKey", env.ODDS_API_KEY);

    let res;
    try {
      res = await fetch(upstream.toString(), {
        headers: { "Accept": "application/json" },
        cf: { cacheTtl: 0, cacheEverything: false },
      });
    } catch (e) {
      return new Response(
        JSON.stringify({ error: `Upstream request failed: ${e.message}` }),
        { status: 502, headers: { ...cors, "Content-Type": "application/json" } });
    }

    const body = await res.text();
    const headers = new Headers({
      "Content-Type": "application/json",
      ...cors,
      "x-stackd-cache": "MISS",
    });

    // Forward the credit counters so the app's "N credits" display keeps working.
    for (const h of ["x-requests-remaining", "x-requests-used"]) {
      const v = res.headers.get(h);
      if (v !== null) headers.set(h, v);
    }

    // Only cache successes. Caching an error would pin a transient failure in
    // place for the whole TTL.
    if (res.ok) {
      headers.set("Cache-Control", `public, max-age=${route.ttl}`);
      const toCache = new Response(body, { status: 200, headers: new Headers(headers) });
      ctx.waitUntil(cache.put(cacheKey, toCache.clone()));
    } else {
      headers.set("Cache-Control", "no-store");
    }

    return new Response(body, { status: res.status, headers });
  },
};

/* ---------------------------------------------------------------------------
 * NOT DONE YET, deliberately:
 *
 * Quota enforcement. The free-plan limits (3 searches, 1 scan per day) still
 * live in client-writable columns, so a determined user can reset them from
 * the browser console. The fix belongs here: verify the caller's Supabase JWT,
 * read their plan and counters with the service-role key, and refuse the
 * request before the upstream call. That needs the Supabase JWT secret added
 * to this Worker and is a clean next step once this proxy is proven.
 *
 * Cache scope. caches.default is per-datacenter, so one upstream fetch serves
 * everyone routed through that colo rather than everyone globally. At your
 * scale that's the difference between one call and dozens. If it ever needs to
 * be one call worldwide, a scheduled Cron Trigger writing to KV would do it —
 * but KV's free tier allows only ~1K writes/day, so that trade needs care.
 * ------------------------------------------------------------------------- */
