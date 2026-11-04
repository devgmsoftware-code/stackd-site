/**
 * Stackd site Worker — serves the app from a private GitHub repo.
 *
 * Why it works this way:
 *   The page is a single 147KB HTML file. Deploying it by writing it into a
 *   Worker script means the whole file has to be retyped into the deploy call
 *   every time, which is slow and risks silent corruption. Git pushes the file
 *   straight from disk instead, byte-exact. So the deployed Worker never
 *   changes — it just reads whatever is on the branch.
 *
 * Deploying a new version is therefore:  git push   (then optionally /__purge)
 *
 * SETUP — Settings -> Variables and Secrets:
 *   GITHUB_TOKEN  (Secret)  fine-grained PAT, Contents: Read-only on the repo
 *   GITHUB_REPO   (Text)    e.g. gabemassaro/stackd-site
 *   GITHUB_BRANCH (Text)    main            (optional, defaults to main)
 *   PURGE_KEY     (Secret)  any random string, used by /__purge
 */

const FILE = "index.html";
const EDGE_TTL = 60; // seconds a built page is held at the edge

function htmlHeaders(extra = {}) {
  return {
    "content-type": "text/html; charset=utf-8",
    // Short max-age so a push goes live on its own within a minute, while
    // still collapsing a burst of traffic into one origin read.
    "cache-control": `public, max-age=${EDGE_TTL}`,
    "x-content-type-options": "nosniff",
    "referrer-policy": "strict-origin-when-cross-origin",
    ...extra,
  };
}

async function fetchPage(env) {
  const repo = env.GITHUB_REPO;
  const branch = env.GITHUB_BRANCH || "main";
  if (!repo) throw new Error("GITHUB_REPO is not set on this Worker.");
  if (!env.GITHUB_TOKEN) throw new Error("GITHUB_TOKEN secret is not set on this Worker.");

  const api = `https://api.github.com/repos/${repo}/contents/${FILE}?ref=${encodeURIComponent(branch)}`;
  const res = await fetch(api, {
    headers: {
      Authorization: `Bearer ${env.GITHUB_TOKEN}`,
      // GitHub rejects API calls without one.
      "User-Agent": "stackd-site-worker",
      // Hands back the raw file instead of a base64 JSON envelope.
      Accept: "application/vnd.github.raw",
    },
  });

  if (!res.ok) {
    const detail = await res.text().catch(() => "");
    throw new Error(`GitHub ${res.status} fetching ${repo}@${branch}/${FILE}: ${detail.slice(0, 300)}`);
  }
  return await res.text();
}

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const cache = caches.default;
    // One cache entry for the whole site, keyed independently of the visitor's
    // path so that deep links share the cached page.
    const cacheKey = new Request(new URL("/__page", url).toString(), { method: "GET" });

    // --- instant cache drop, for when 60s is too long to wait -------------
    if (url.pathname === "/__purge") {
      if (!env.PURGE_KEY || url.searchParams.get("key") !== env.PURGE_KEY) {
        return new Response("Forbidden", { status: 403 });
      }
      const dropped = await cache.delete(cacheKey);
      return Response.json({ purged: dropped });
    }

    // --- health check, safe to visit, exposes no secret -------------------
    if (url.pathname === "/__status") {
      let ok = true, error = null, bytes = null;
      try {
        bytes = (await fetchPage(env)).length;
      } catch (e) {
        ok = false; error = e.message;
      }
      return Response.json({
        service: "stackd-site",
        ok,
        error,
        pageBytes: bytes,
        repo: env.GITHUB_REPO || null,
        branch: env.GITHUB_BRANCH || "main",
        tokenConfigured: Boolean(env.GITHUB_TOKEN),
        purgeConfigured: Boolean(env.PURGE_KEY),
      }, { headers: { "cache-control": "no-store" } });
    }

    if (request.method !== "GET" && request.method !== "HEAD") {
      return new Response("Method not allowed", { status: 405 });
    }

    const hit = await cache.match(cacheKey);
    if (hit) {
      const headers = new Headers(hit.headers);
      headers.set("x-stackd-cache", "HIT");
      return new Response(hit.body, { status: 200, headers });
    }

    let html;
    try {
      html = await fetchPage(env);
    } catch (e) {
      // Fail loudly but readably, and never cache a failure.
      return new Response(
        `<!doctype html><meta charset="utf-8"><title>Stackd — temporarily unavailable</title>` +
        `<body style="font:16px system-ui;max-width:40rem;margin:4rem auto;padding:0 1rem">` +
        `<h1>Stackd is temporarily unavailable</h1>` +
        `<p>The site could not be loaded from its source repository.</p>` +
        `<pre style="white-space:pre-wrap;color:#a33">${e.message.replace(/[<&]/g, c => ({ "<": "&lt;", "&": "&amp;" }[c]))}</pre>`,
        { status: 503, headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" } });
    }

    // Store a clean copy for the next visitor, then answer this one.
    const toCache = new Response(html, { status: 200, headers: htmlHeaders() });
    ctx.waitUntil(cache.put(cacheKey, toCache.clone()));

    return new Response(html, { status: 200, headers: htmlHeaders({ "x-stackd-cache": "MISS" }) });
  },
};
