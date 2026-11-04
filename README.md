# Stackd

Sportsbook odds comparison — compares a pick across US-legal books and finds
the best book to parlay picks together across different books.

## Layout

| path | what it is |
|---|---|
| `index.html` | the entire app, one self-contained file (React via CDN) |
| `worker-site.js` | Cloudflare Worker that serves `index.html` from this repo |
| `worker-api.js` | Cloudflare Worker proxying The Odds API (holds the API key, caches at the edge) |
| `sql/` | Supabase schema + migrations, in order |
| `email-templates/` | branded auth emails (needs custom SMTP before Supabase will accept them) |

## Deploying

`index.html` is read live from this repo by the site Worker, so:

```
git push        # live within ~60s
```

For an instant update, hit `/__purge?key=<PURGE_KEY>` on the site.

`/__status` on either Worker reports whether its config and secrets are in place.

## Worker configuration

**stackd** (site) — `GITHUB_TOKEN` secret, `GITHUB_REPO`, `GITHUB_BRANCH`, `PURGE_KEY` secret.
**stackd-api** (odds proxy) — `ODDS_API_KEY` secret, `ALLOWED_ORIGINS`.
