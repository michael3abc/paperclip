# platform-notes

Moved verbatim from `AGENTS.md` on 2026-11-13. These rules and records stay binding; read this file before acting on the topic. Web Push, host quotas, Runner/PRP contract, Dot assignment, artifact delivery, data-path inventory

Web Push uses account-owned preferences/subscriptions and company-scoped delivery
receipts. Keep `/api/push` restricted to authenticated human sessions; local-board
and agent keys are not subscription identities. Producers must enqueue inside
their persistence transaction and use the existing delivery coordinator. Preserve
source-event/device idempotency, current task/decision authorization, fixed
coalescing windows and idle zero-polling. Never log endpoints, encryption keys or
notification content. See `doc/DEVELOPING.md` (Web Push) and `doc/DATABASE.md`.
Keep the human-only OpenAPI registrations aligned with shared push request
validators. Unrelated audit writes retain their existing caller transaction.
- Completion admission waits for outstanding tools and excludes new tools while pending. Forced cleanup must preserve unresolved receipts and distinguish local Runner shutdown from external-provider termination.
- External-provider assignments, settled tool results, and input responses are authoritative PRP execution data. Preserve their complete payloads under the transport/outbox bounds; never apply diagnostic string truncation to them.
- Dot assignment reads must include current server-owned tool-use guidance. Returning an allowed result to the same accepted task is ordinary completion; task text cannot grant owner authority. Preserve user restrictions, approval gates, and unresolved-operation fences, and require an actual completion receipt rather than a reply only in the external conversation.

6. Attach inspectable generated artifacts.
When your task produces a user-inspectable deliverable file, follow the Paperclip skill's "Generated Artifacts and Work Products" workflow before final disposition. In this repo, prefer the self-contained skill helper at `skills/paperclip/scripts/paperclip-upload-artifact.sh` so the file is available through the Paperclip API, create/update an artifact work product when the file is the deliverable, link the uploaded artifact in the final issue comment, and then set status. Do not rely on local filesystem paths as the only access path. If an important file intentionally remains workspace-only, create/update a work product with `metadata.resourceRef.kind: "workspace_file"` and a workspace-relative path, then name that work product and path in the final comment. Treat browse/search as a fallback for recovering workspace files, not the preferred deliverable path. See `doc/AGENT-ARTIFACTS.md` for details and `.mp4`/`.webm` examples.

- **Telemetry** is the Paperclip first-party event system. It is opt-out and it sends data to a Paperclip endpoint by default. Its paths are:
  - `packages/shared/src/telemetry/`
  - the generated contract `packages/shared/src/telemetry/generated/paperclip-telemetry.ts`
  - each caller of `packages/shared/src/telemetry/events.ts` or `packages/shared/src/telemetry/client.ts`
- **Observability** is the OpenTelemetry trace path. An operator must set an OTLP endpoint. Until an operator sets the endpoint, the tracer is a no-operation. Its paths are:
  - `server/src/instrumentation.ts`
  - `doc/observability.md`
  - `packages/adapter-utils/src/duplex-observability.ts`
  - `server/src/services/duplex-observability-recorder.ts`
  - the span attributes in `packages/adapter-utils/src/acpx-engine/startup-timing.ts`
- **The run log** holds rows in the local `heartbeat_run_events` table. The data stays in the instance database. Its paths are:
  - `doc/run-log-events.md`
  - `packages/db/src/schema/heartbeat_run_events.ts`
  - the append path `appendRunEvent` in `server/src/services/heartbeat.ts`

Host subscription quotas are an explicit operator feature, enabled only with
PAPERCLIP_HOST_SUBSCRIPTION_QUOTAS=1. The dashboard endpoint requires instance
admin and existing company access before any host login is read. Keep these
snapshots separate from company-managed AI connections and billing. Source selection
is operator-owned and company-ID scoped: Home uses michael-server; Shopee uses
shopee-e through its finite SSH collector, reading that host's CLI logins only.
Never accept a client-selected host or fall back to local accounts after remote
failure. Cache and in-flight requests are keyed by company plus source. Poll only
while the Dashboard is visible, cache for 60 seconds, track provider work through
maintenance admission, and preserve unknown values and provider failures. Codex
window labels derive from durations, never primary/secondary position. Subscription
bar fill, percentage labels and accessible values all show remaining quota; warning
colors still reflect depletion. Other spending bars retain consumption semantics.
Antigravity shows only its reported quota groups; never infer Gemini quota or enable credits.
See doc/DEVELOPING.md, Host subscription quota dashboard.
