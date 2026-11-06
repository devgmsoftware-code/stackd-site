
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
