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

## Edge Functions

`create-checkout`, `billing-portal`, `claim-referral` and `stripe-webhook` are
deployed to Supabase directly, not from this repo. The copies under
`functions/` are reference snapshots and **may lag the deployed version** —
the live code is in the Supabase dashboard under Edge Functions.

Secrets they read: `STRIPE_SECRET_KEY`, `STRIPE_PRICE_ID`,
`STRIPE_WEBHOOK_SECRET`, `SITE_URL`.

## Referrals

One free month per referred account that starts paying.

- Every profile gets a `referral_code`; the invite link is `/?ref=CODE`.
- The code is parked in localStorage on arrival and redeemed on first signed-in
  load, because email confirmation means there's no session at signup.
- `claim-referral` enforces the rules: one per account, never your own code,
  only while the account is new.
- The reward is paid by the webhook on `invoice.payment_succeeded` with
  `billing_reason = subscription_create` — real money, not merely an active
  subscription, so a trial or a reversed card earns nothing.
- Credit is spent at checkout as trial days and returned by
  `checkout.session.expired` if the checkout is abandoned.

## Developer view

Request diagnostics (cache state, feed usage, per-game scan detail) are shown
only to accounts with `profiles.is_dev = true`. The browser has no UPDATE
privilege on that column, so it cannot be switched on from the console.

```sql
update public.profiles set is_dev = true where email = '...';
```

## Known gaps

- Free-tier quotas live in browser-writable columns, so they are soft limits.
  Real enforcement belongs in `worker-api.js`, checking the caller's Supabase
  JWT before the upstream call.
- No custom domain yet, which is what blocks custom SMTP, branded auth emails
  and working password reset.
- Stripe checkout endpoint is not wired up; `plan` is set manually via `sql/`.
