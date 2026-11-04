# Stackd

Sportsbook odds comparison — compares a pick across US-legal books and finds
the best book to parlay picks together across different books.

**Live:** https://stackdpicks.com

## Layout

| path | what it is |
|---|---|
| `index.html` | the entire app, one self-contained file (React via CDN) |
| `worker-site.js` | Cloudflare Worker `stackd` — serves `index.html` from this repo |
| `worker-api.js` | Cloudflare Worker `stackd-api` — proxies The Odds API, holds the key, caches at the edge |
| `sql/` | Supabase schema + migrations, apply in numbered order |
| `email-templates/` | branded auth emails (Supabase needs custom SMTP before it will accept them) |

## Deploying

`index.html` is read live from this repo, so a deploy is just:

```
git push
```

Live within about 60 seconds. For an immediate update, request
`/__purge?key=<PURGE_KEY>` — the key is a secret on the `stackd` Worker, not
stored here.

`/__status` on either Worker reports whether its config and secrets are in
place, and for the site Worker, how many bytes it is reading from this repo.

Rolling back is `git revert` + `git push`, or pushing any earlier commit.

### Why it reads from GitHub

The page is one 147KB file. Embedding it in the Worker script means rewriting
the whole file into every deploy, where a single wrong character breaks the app
silently. Git sends it from disk byte-exact instead, so the Worker never has to
change — it just reads whatever is on `main`. The Worker rejects a page that
arrives without a closing `</html>`, so a partial read fails loudly rather than
being cached as a blank screen.

## Worker configuration

**stackd** (site)
- `GITHUB_REPO` (text) — `devgmsoftware-code/stackd-site`
- `GITHUB_BRANCH` (text) — `main`
- `PURGE_KEY` (secret)

**stackd-api** (odds proxy)
- `ODDS_API_KEY` (secret)
- `ALLOWED_ORIGINS` (text) — site origins, comma separated

## Known gaps

- Free-tier quotas live in browser-writable columns, so they are soft limits.
  Real enforcement belongs in `worker-api.js`, checking the caller's Supabase
  JWT before the upstream call.
- No custom domain yet, which is what blocks custom SMTP, branded auth emails
  and working password reset.
- Stripe checkout endpoint is not wired up; `plan` is set manually via `sql/`.
