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
