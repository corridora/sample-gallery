# Set up Corridora for the Cloudflare gallery

Published 2026-10-11 · Updated 2026-10-11

## Destination, project and credentials

Contributors select `CORRIDORA_TARGET=own` and create a project in their own
Corridora organization. Create an ingestion key for backend traces, logs and
metrics, and a separate RUM/browser key allowed for the app's exact origin. A
browser key is deliberately visible in the install tag; the backend key is
privileged and stays in Worker secrets. Management credentials are never needed
by the app.

Maintained deployments select `demo`, which sets environment `demo`. An authorized
operator provides the Demo backend and RUM credentials. The Demo organization's
canonical UUID is `00000000-0000-4000-8000-000000000201`; ingestion routing comes
from the supplied keys, not from sending that UUID. Do not mint keys through a
public Demo persona. Local tests use a mock sink, never the shared Demo keys.

Use these stable service identities when configuring the project:

| Service | Role |
| --- | --- |
| `sample-gallery-web` | Svelte browser RUM and manual framework action spans |
| `sample-gallery-api` | Hono SERVER, D1/R2/KV and cross-cloud spans; logs/metrics |
| `sample-gallery-worker` | Queues CONSUMER and Cron probe |
| `sample-gallery-tracker` | Optional controlled third-party simulator |
| `sample-gallery-cloudflare-adapter` | Native Analytics metrics bridge |

Namespace defaults to `corridora-samples.gallery`. Actual version is the clean
Git commit or a digest of source and lockfile content, computed in `setup`.
Injected regression revisions appear in `demo.release`, with
`demo.scenario=cache-key-change` and `demo.phase=regression`.

## Run the setup wizard

```sh
npm ci
./setup configure
./setup deploy --plan
./setup deploy
./setup run
```

Bare `./setup` guides configure, deploy/start and verification. `--help` requires
only Python. For noninteractive use, set environment variables or pass a
mode-600 JSON file with `--config /path/config.json --non-interactive` to
`configure`. Environment variables override saved values. Do not put secrets in
shell history or command-line flags. `.env.example` lists supported names; the
script does not automatically source shell files.

| Prompt group | Meaning and defaults |
| --- | --- |
| Mode/target | Local by default; own tenant by default. Cloud requires both telemetry keys and scoped Cloudflare credentials. |
| Endpoint/RUM URL | Ingest base e.g. `https://ingest.corridora.com`; script defaults to `https://rum.corridora.com/corridora-rum.js`. An empty ingest endpoint disables export only for local mode. |
| Keys | Masked backend ingest key and control token; visible RUM key. An empty local control answer generates a cryptographically random token. Downstream auth is independent. |
| Identity | API name, namespace, environment. `demo` target forces environment `demo`; version is generated from actual code. |
| Resources | Cloudflare account, unique lowercase prefix, optional existing dedicated D1/R2/KV/Queue, optional custom hostname and zone. Empty IDs create or discover prefixed resources. |
| Run | Port 4101, daily UTC start 13:00, duration 600 seconds; finite durations must stay 1–600. Provider and synthetic schedules default off. |
| Integrations | HTTPS controlled recommender and tracker script; empty values use fixtures/no tracker. Only local loopback HTTP is permitted in local mode. |
| GitHub | Published repository and existing `gh` login when hosted browser/provider workflows are enabled. Setup writes repository secrets via stdin and nonsecret variables, then the checked-in workflows supply the schedule. |
| Provider forwarding | Optional native OTLP destination creation plus separate read-only Analytics token for metrics; the Analytics token stays outside the Worker. |

The scoped deployment token needs Workers Scripts Write, D1 Write, Workers KV
Storage Write, Workers R2 Storage Write, Queues Write and Account Settings Read;
add Workers Observability Write for native destinations. Custom hostnames need
zone/Worker route permissions. Scope the token to the chosen account and zone.
A separate read-only token needs Account Analytics Read. The script uses the
Cloudflare REST control plane to inventory create/reuse operations and Wrangler
for binding data, secrets and deployment. It asks for an API token, never an
account password.

All saved setup files use owner-only permissions in ignored `.sample/`. Keep
`inventory.json` for resume and teardown. Each created resource is recorded
immediately. If setup fails, fix the reported prerequisite and rerun deploy.
Provider errors are redacted to avoid leaking response bodies/secrets.

## Instrumentation and origins

`worker/telemetry.ts` uses the real OpenTelemetry trace, logs and metrics SDKs,
with the pinned official JSON OTLP serializers. Each request/queue lifecycle gets
its own providers, avoiding mutable global request state. W3C extraction occurs
before SERVER or CONSUMER creation. Parent context is passed explicitly to child
binding spans. The Cache API stores only internal R2 metadata for 60 seconds;
healthy cold starts still perform a real read, and `cache.hit` reflects an actual
lookup. The bad revision bypasses that cache and performs three bounded reads. Recommender HTTP CLIENT and queue PRODUCER spans inject their own
context; queue messages carry it for CONSUMER extraction. There is no fan-in in
this example, so no fake span links are invented.

Exporter paths are `/v1/traces`, `/v1/logs`, `/v1/metrics`, HTTP JSON, using only
backend `X-CORRIDORA-KEY`. Requests flush all three providers with a two-second
HTTP timeout and 2.5-second processor limits before ending their lifecycle;
queues flush before return; Cron uses `waitUntil`. Export errors go to structured
console logs without recursively instrumenting the export HTTP call. `/healthz`
reports whether export is configured, not whether Corridora has stored it.

`worker/index.ts` injects the **blocking** Corridora RUM script at the opening of
`<head>` before Svelte's bootstrap can make its first fetch. It supplies `ckid`,
endpoint, web service/namespace/environment/version, full sampling, long tasks,
and the exact same API origin in `data-trace-origins`. RUM owns the browser
provider. `src/routes/+page.svelte` uses only `@opentelemetry/api` manual action
spans, entering the captured context synchronously for every fetch even after an
`await`. It creates no competing browser provider.

Frontend and API share one origin. API responses and diagnostics have
`Cache-Control: no-store`; no wildcard CORS is needed or enabled. CSP derives
RUM, ingest and controlled-tracker origins from saved configuration. Svelte's
inline boot code requires the included `'unsafe-inline'` allowance; there is no
user-supplied HTML. If splitting the API into a second browser origin later,
explicitly allow that origin plus `traceparent` in API preflights and RUM's exact
HTTPS allowlist. HTTP trace context never acts as authorization.

## Native Cloudflare data

Application SDK export and native provider export are separate paths.
`ENABLE_PROVIDER_FORWARDING=true` creates account destinations named
`<prefix>-logs` and `<prefix>-traces`, with per-signal Corridora URLs and backend
authentication headers. The generated Wrangler config attaches those destination
names with `persist=false`. Distinguish native platform spans from application
SDK spans when investigating; do not assume Cloudflare's automatic traces have
identical parentage or all binding detail. Check destination delivery status in
Cloudflare after deployment and confirm corresponding native records in
Corridora. Native delivery can take several minutes.

Cloudflare's native OTLP export supports logs/traces, not infrastructure/custom
metrics. `scripts/provider_metrics.py` queries a single bounded aggregate of
requests/errors/subrequests and emits properly bounded DELTA OTLP metrics. The
included provider workflow runs four times hourly with a read-only Analytics
token. Metrics are sampled estimates, do not carry fabricated browser trace IDs,
and can miss intervals when a runner is delayed. Repeating a manual poll can
export the same interval twice; this adapter does not claim exactly-once delivery. No queue-specific or R2 billing
metrics are claimed by this adapter. Keep polling small and review usage.

See [native OTLP configuration](https://developers.cloudflare.com/workers/observability/opentelemetry-export/),
[destination API](https://developers.cloudflare.com/api/resources/workers/subresources/observability/subresources/destinations/methods/create/),
and [Analytics query API](https://developers.cloudflare.com/analytics/graphql-api/tutorials/querying-workers-metrics/).
Cloudflare documents observability billing changes on December 1, 2026; recheck
pricing then. Persistence is disabled in this sample.

## Verify a complete incident

```sh
npx playwright install chromium
./setup verify
./setup scenario --phase regression --duration 120
./setup scenario --phase recover --duration 120
```

The browser journey selects Orbit lamp, prepares queued image metadata, enables
a bounded bad release, observes the extra reads/1.5-second delay, selects healthy
Fern planter, then recovers Orbit lamp. It records a same-day heartbeat only
after all actions succeed. Scenario writes require a nonempty bearer control
token of at least 16 characters. Expiry is checked on requests and queue work.
When a RUM tag is configured, its initialization status must be `ready` before
the journey proceeds or writes a heartbeat. Local runs with no RUM key report
`disabled-workflow-only`; those heartbeats do not prove browser correlation.
Cleanup leaves a healthy override for ten minutes so the natural daily window
cannot immediately undo a tested recovery.

In Corridora, find the fresh `sample-gallery-web` session. Open a fetch CLIENT
span and confirm its trace ID equals the `sample-gallery-api` SERVER trace ID
and its span ID equals the server's parent span ID. Then inspect D1/R2/KV spans,
the optional GCP/AWS downstream continuation, and the Queue PRODUCER → CONSUMER
parentage. Confirm a correlated application log, request-duration metric,
simulated deployment/feature-flag event, healthy control, recovery, and at least
one native Cloudflare record if forwarding is enabled. A 200 ingest response or
an injected test trace header proves neither stored browser correlation nor
native coverage. This repository does not ship a management/query credential;
stored-telemetry verification is an operator UI check.

The local OTLP/browser suite can use `RUM_BUNDLE_PATH` pointing to a separately
obtained real RUM bundle and proves actual browser/server parentage in capture.
It uses mock keys and never accesses Demo credentials. Without that bundle, the
suite deliberately reports correlation as unasserted. A live cloud deployment,
provider destination delivery, hosted daily recurrence and measured bill still
require operator validation.

## Troubleshooting, replay and removal

- A missing catalog/image means the local seed or deployed binding was not
  initialized. Rerun `./setup deploy`; it reapplies idempotent D1 inserts and
  known fixture objects. Rerunning the browser test resets only test bindings.
- A disabled exporter means local endpoint/key config is empty. A configured
  exporter that fails emits `telemetry.export.failed` or
  `telemetry.flush.failed` in native console logs. Check URL/key scope and
  native destination delivery separately.
- Deployment/recovery transitions remain pending in D1 until the OTLP log
  export is accepted. Later requests or Cron retry up to ten pending events per
  lifecycle. `demo.event.id` identifies the original transition and
  `demo.event.observed_at` preserves its time. Delivery is at least once:
  concurrent requests or a crash between export acceptance and D1 acknowledgement
  can duplicate the same event ID. An ingest response does not prove storage.
- Missing browser spans: verify the tag is first in `<head>`, check CDN
  `ckid` eligibility, CSP and ingest CORS, then confirm no competing provider
  initialized first. Use the actual API response `X-Trace-Id` and the session
  to locate the request. Never paste backend keys into browser config.
- A thumbnail queued forever: inspect the Queues consumer/DLQ. Missing R2
  fixtures retry twice with a three-second delay before dead-lettering.
  Source messages expire after ten minutes and cannot sustain old incidents.
  Restore fixtures, remove the failed seeded job from D1, and replay it.
- Daily schedules rely on real runner availability. Inspect `/api/demo/heartbeat`;
  run `scripts/watchdog.py` from an existing protected runner to reopen a bounded
  override and execute the full browser journey when evidence is missing.

For key rotation, create replacement keys in the correct Corridora organization,
run `./setup configure`, then `./setup deploy`. This updates Worker secret
bindings, RUM tag config, destinations and optional repository secrets. Revoke old
keys only after a fresh browser/backend/native check. Never change a shared
destination owned by another application.

Run `./setup destroy --plan`, then `./setup destroy`. Only resources marked owned
in the matching account inventory are removed. Reused stores, other apps,
GitHub repositories and organization accounts are retained. Disable the two
repository workflow flags and remove their secrets separately after teardown.
Local destroy removes local binding state while preserving saved answers.
