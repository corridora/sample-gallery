# Controlled third-party tracker simulator

Published 2026-10-11 · Updated 2026-10-11

The optional simulator in `worker/tracker.ts` supports `/tracker.js`,
`/tracker.js?mode=regression`, `/pixel` (503), and `/healthz`. Regression adds a
one-second script delivery delay, a bounded 250-ms main-thread task and an ad
slot layout shift. It is a fictional dependency; no Facebook/Google signup or ad
spend is involved. The gallery asks for explicit consent before adding the tag.

Local: `npm run tracker`, then configure gallery's `TRACKER_SIMULATOR_URL` to
`http://localhost:4108/tracker.js?mode=regression`. The simulator's protected
runtime environment can supply `CORRIDORA_OTLP_ENDPOINT` and backend ingest key;
empty values disable its export. Its service is `sample-gallery-tracker`. Set
`TRACKER_ALLOWED_ORIGIN` to the gallery origin for Resource Timing access.

For a cloud simulator, create an independent Wrangler JSON configuration from
`wrangler.tracker.jsonc`, replace `TRACKER_ALLOWED_ORIGIN`, namespace/environment
and actual build version, inject the backend key using `wrangler secret put`,
and deploy it to an independent workers.dev hostname. Then set that exact script
URL in the gallery wizard. This is an optional second deployment, managed
separately from the gallery setup inventory; delete it with `wrangler delete
--config wrangler.tracker.jsonc`. The simulator uses the same $5 account minimum
and its bounded requests consume included allowance. Do not deploy the local
placeholder configuration without setting your account and values.

The timing header exposes resource timing only. Script downloads and pixels do
not become browser-fetch parent/child traces. The simulator's own SDK server
spans export independently. Do not add its static/script origin to the browser's
trace allowlist just to fabricate correlation. Real vendor tags, if added later,
need isolated test properties, explicit consent, updated CSP and no synthetic
records, session IDs, Corridora keys or trace headers sent to vendors. Their
backend spans remain unavailable without vendor support.
