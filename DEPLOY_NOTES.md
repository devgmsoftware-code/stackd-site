
## 2026-11-06 — SEO worker deploy (v2.5)

The `stackd` Worker was deployed with source typed inline into the Cloudflare
API call, NOT pasted byte-for-byte from `worker-site.js`. Consequences:

- Deployed script: 19,973 bytes. Repo `worker-site.js`: 26,160 bytes.
- The gap is comment lines (4,107 bytes of them) plus inline trailing
  comments, which were condensed during transcription.
- All 27 top-level declarations in the repo file are present in the deployed
  script, and Cloudflare's upload validator accepted it (so it parses and the
  default export is well-formed).
- The two texts are nonetheless NOT identical. Treat the deployed script as
  the live truth until a byte-exact redeploy from this file is possible.

Open: the sandbox used for deploys cannot fetch raw.githubusercontent.com
(403) or stackdpicks.com (403), so neither deploy-from-file nor post-deploy
self-verification works from there yet. A KV-staged or Worker-pull deploy
path would remove the transcription hazard permanently.

## 2026-11-06 — stackd-content deploy (byte-exact method)

`worker-content.js` deployed to the `stackd-content` Worker, verified
byte-identical to the committed file (12,006 bytes, sha256 prefix
c9457d950ce337f3 on both sides).

The method that makes this reliable, use it for every future deploy:

1. Hash the repo file locally: `sha256(file)`.
2. Mechanically escape it for embedding (`\` → `\\`, then `` ` `` → `` \` ``,
   then `${` → `\${`) with a script. Never escape by hand — worker-content.js
   had 137 escape sites.
3. Read the escaped file and copy it into the deploy call's template literal.
4. In the deploy call, hash the evaluated string and REFUSE to deploy on
   mismatch. A warning after the fact is not good enough; the guard has to
   be before the PUT.

Cron: `0 13 * * *` (08:00 America/New_York).
Manual run: https://stackd-content.dev-gm-software.workers.dev/__run?key=<RUN_KEY>
  (add `&send=1` to actually email; without it the draft renders in-browser
  and nothing is sent).

Still needed as Worker secrets before the first run can send:
  RESEND_API_KEY, RUN_KEY

Permanent fix worth doing: Cloudflare Workers Builds connected to this repo
would deploy on push and remove the transcription step entirely.
