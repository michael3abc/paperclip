# AGENTS.md

Fork note: this is the `michael3abc/paperclip` fork. Paragraphs that cite the
Owner, HOM issue keys or `/home/michael` paths are the maintainer's host rules and
bind every agent on that host. On another machine, read
`docs/fork/host-operations.md` to see which rules apply to you.

Host Claude sign-in replaces the Claude quota card body only for hosts whose native
status explicitly reports logged out; signed-in/unknown states keep quota content.
Check company hosts while Dashboard is visible and refresh quota after sign-in.
Sign-in is human-only and instance-admin-only. Use the
company-scoped CC Pocket host registry and its explicit `claudeLogin.command`
and optional `configDir`; never accept a client command, path or SSH target. Run
native `claude auth login --claudeai` on that host; credentials stay there. Bind
temporary sessions to company/user/host, allow one active login per host, expire
after five minutes, and confirm `auth status --json` reports a Claude.ai login.
Never persist authorization URLs, codes, CLI output or credentials in audit/logs.
Codex uses the same company/host/human/admin boundary with registry `codexLogin.command`
and optional `codexHome`: run `codex login --device-auth`, expire sessions after ten
minutes, and confirm `codex login status` reports `Logged in using ChatGPT`. Show the
device URL/code only to the initiating administrator; never log or persist either.

Guidance for human and AI contributors working in this repository.

The issue-list inboxArchive filter is board-user-only and cannot be combined
with attention; preserve the viewer-scoped isArchivedForMe projection. See
docs/api/issues.md. Upstream Chat retry stop-wait polling is intentionally
excluded: terminal cleanup remains background work under liveness-first.
Due monitors and claimed wake_owner recovery can wake a waiting main Chat only through their persisted schedule
and claim guard. Named admission waits retain the monitor; unclassified null
admissions consume the existing attempt ledger and clear at three total attempts
or the smaller configured limit. Record static refusal reasons; preserve stale
wake rejection and the agent scheduling API switch. See doc/execution-semantics.md.

Execution is liveness-first (Owner 2026-11-13). The binding source is
`/home/michael/services/docs/agents/liveness-first.md`; it supersedes every
fail-closed rule in this repository's docs (stop proof, settlement ladders,
never-replay of unknown input, session-authority CAS, workspace admission gates,
system-set pause/`needs_attention`/`uncertain`). Historical runs and receipts stay
unchanged. An unknown prior outcome abandons that run, releases every lock, claim,
holder and slot, and resends in the original native session if it still exists,
else a new one, prefixed 「上一次可能已部分執行，先檢查現況再做」. A terminal status
releases every gate; stop evidence is background best-effort. Failures are
transient (30s×2ⁿ backoff capped at 30 min, unlimited, one notice at the 5th
consecutive failure), deterministic (no auto retry, one notice per issue and code)
or unknown (3 transient retries, then deterministic). Bridge model_provider_mismatch
is deterministic. Board/project-main assignee or status changes supersede only
not-started automatic retries; running and ordinary queued ownership stay protected.
Main Bridge runs use their own adapter/AI settings despite retained task worker
selections. Shutdown/process-loss retries
retain the durable backoff counter instead of opening a fresh restart window; see
`server/src/services/recovery/failure-classification.ts`. Owner Stop/cancel and
manual pause still apply and revoke automatic retry. New human or project-main
input supersedes automatic retry of a failed predecessor and keeps its own input
receipt. See `docs/agents/execution-semantics.md`.
Sandbox disk exhaustion (native_sandbox_disk_full, sandbox_disk_full) and permanent
agent_interaction_delivery_denied are deterministic in the unified classifier.
Bootstrap non-delivery alone does not select interrupted-preparation retry accounting:
require system interruption, process loss or controller loss. Ordinary failures keep
their failure counter and provider retry deadline.

Host terminals require a signed-in human instance-admin session, active company access
and registry `terminal.enabled: true`; never accept client commands, cwd, SSH targets
or env. Keep the PTY environment allowlisted, tokens single-use, and terminal contents
out of logs/storage; see `docs/agents/platform-notes.md`.

Dashboard subscription quota sources are company-scoped operator configuration; remote credentials stay on the selected host, with no local fallback. See docs/agents/platform-notes.md and doc/DEVELOPING.md.
Compass receipts optionally carry usage.cacheWrite1hTokens as a subset of cacheWriteTokens.
Price the remainder at 5m and unknown TTL at 1h with the versioned Compass card;
never reprice existing charges or backfill history. Invalid subsets stay incomplete.
Observed Compass usage without a final receipt can settle as an explicit lower bound;
missing counters stay unpriced. See docs/guides/board-operator/costs-and-budgets.md.

Cost reports expose ordinary input separately from cached input. Normalize inclusive Codex Bridge subscription counters when reading reports; preserve raw receipts and charged amounts. Dashboard subscription pies show API-equivalent USD estimates, separate from subscription fees. See `doc/connections/AI-CONNECTIONS.md`.
Dashboard project usage shares the model charts' period and company scope; sum ordinary input, cache reads and output once, retain Unattributed, and keep recorded spend separate from subscription estimates/fees.
Codex Business/Enterprise monthly credit quotas come from RPC individualLimit; preserve its remaining percentage and reset. Metadata-only credits are not reported quota, and RPC credit amounts are not dollars.
Plain Bridge workers may opt into runtimeConfig.bridgeWorkerHostCapacity (host ID to independent concurrent-run limit). Task models retain full host/provider IDs; validate and pin their route before workspace preparation. Catalogs probe only the dispatch owner's host. Preserve historical worker/session identities and never fail over to another host. See docs/agents/pm-agents.md.

Agent chat pins use an explicit nullable personal chatPinned preference, independent of stars and primary-agent identity; see `docs/agents/ui-features.md`.

Local voice timbre is one browser-wide preference, changed only on the Voice page and used by every agent on the next call. Do not restore per-agent overrides or mutate live call bindings. See `doc/connections/LOCAL-VOICE.md`.

Local voice media belongs to the company/user-scoped provider above routes; navigating chats must neither dispose it nor retarget the active agent. See `docs/agents/ui-features.md`.

Internal `local_voice` endpoints remain available to Voice but are excluded by the external chat connector visibility gate, including Connectors and agent Channels. Never filter them out of the shared endpoint API/cache.

New agent_chat voice sessions pin main_answer_v1 in providerSessionId; substantive answers come from the original main Chat and require per-answer, server-verified input provenance before automatic playback. Saved input is not execution evidence; barge-in stops audio only, and an unknown browser write is reconciled without resending. Preserve voice_task and existing calls' policies. See `doc/connections/LOCAL-VOICE.md`.

## 1. Purpose

Paperclip is a control plane for AI-agent companies.
The code and its tests are the source of truth for current behavior.
The focused docs under `doc/` are background. They can be out of date, so do not treat them as requirements when they disagree with the code or with the task.

## 2. Read This First

Read the doc that matches your change before you start:

| Your change touches | Read |
| --- | --- |
| Product behavior or scope | `doc/GOAL.md`, `doc/PRODUCT.md` |
| Setup, commands, testing, worktrees | `doc/DEVELOPING.md` |
| Schema, migrations, DB clients | `doc/DATABASE.md` |
| An Apps catalog connection | `doc/connections/CONNECTOR-PLAYBOOK.md` (the canonical connection authoring runbook) |
| Anything under `ui/` | `DESIGN.md` |

### Scoped repository rules

`rules/*.mdc` holds the architecture rules that reviewers apply to a pull
request. Each file starts with a short header: `description` is a one-sentence
summary of the rule, `globs` lists the files it covers, and `alwaysApply: true`
means it covers the whole repository.

You do not need to read the rule bodies before every change. List the headers to
see which rules exist and what each one asks for:

```sh
grep -E '^(description|globs|alwaysApply):' rules/*.mdc
```

Write the change so that it satisfies the descriptions of the rules that cover
your files. Read the full body of a rule only in these cases:

- You are making a design decision in the area the rule covers, such as adding a
  module, a background worker, or persisted state.
- The description does not tell you whether your change complies.
- A reviewer cites the rule.

These rules supplement this file and any applicable nested `AGENTS.md`
instructions. See [`rules/README.md`](rules/README.md) for rule authoring and
Greptile setup.

## 3. Repo Map

- `server/`: Express REST API and orchestration services
- `ui/`: React + Vite board UI
- `packages/db/`: Drizzle schema, migrations, DB clients
- `packages/shared/`: shared types, constants, validators, API path constants
- `packages/adapters/`: agent adapter implementations (Claude, Codex, Cursor, etc.)
- `packages/adapter-utils/`: shared adapter utilities
- `packages/plugins/`: plugin system packages
- `packages/skills-catalog/`: app-shipped skills catalog (`@paperclipai/skills-catalog`)
- `packages/teams-catalog/`: app-shipped teams catalog (`@paperclipai/teams-catalog`)
- `cli/`: `paperclipai` CLI package (published bin, agent-facing commands)
- `skills/`: Paperclip runtime/operational skills (not part of the app catalog)
- `doc/`: operational and product docs
- `doc/plans/`: dated repo plan docs, named `YYYY-MM-DD-slug.md`. A plan for a Paperclip issue goes in the issue's `plan` document instead.
- `rules/`: scoped repository rules (see section 2)

## 4. Dev Setup

```sh
node scripts/agent-preflight.mjs   # prepare a new or updated worktree
pnpm dev                           # API and UI at http://localhost:3100
```

Leave `DATABASE_URL` unset to use the embedded database. See "Agent worktree
preflight", "Start Dev", "Quick Health Checks", and "Database in Dev" in
`doc/DEVELOPING.md`.

## 5. Core Engineering Rules

Custom remote MCP browser sign-in uses the human-only `/api/tool-connections/:id/browser-login` companion proxy. Resolve the acting human's vault grant, preserve company/configuration access, and never persist/cache/audit login URLs or QR codes. Poll only a visible, bounded login attempt; transport health is not provider-account login. See `doc/connections/GENERIC-REMOTE-MCP.md`.

Question answers with `continuationPolicy: none` are caller-delivered; save the answer
without a generic continuation outbox entry. `runtimeRequestId` retains Runner's native
response delivery. Preserve source runs and test both paths with owned PostgreSQL.
Worker-only explicit human audience requests go to the task main first; preserve
governance/quality/security reservations and use existing escalation. See docs/agents/decisions-and-review.md.

Use owned disposable databases and dedicated test notifications; do not wake real
agents. Non-Git workspace tests require a clean owned temporary root with no
ancestor Git metadata. Chromium injection tests do not qualify APNs or physical iPhone delivery.
1. Keep changes company-scoped.
Every domain entity should be scoped to a company and company boundaries must be enforced in routes/services.

Explicit exception: announcement dismissals are instance-wide user preferences,
keyed by user and announcement so they persist across companies. Their audit
context must still validate company membership. The announcement publication-ID
registry is instance-level feed metadata; it contains no company or user data.
Personal workspace presentation preferences are also instance-wide by user, with
validated company membership supplying audit context. They never grant execution
authority, change company capabilities or agent configuration, or rewrite canonical
work records. Optional conversation guidance must retain the same action permissions.
Project PMs can be restricted to coordination and review with
`runtimeConfig.workspaceBinding.workerSlots=0` (the default for new bindings).
Reject implementation children assigned to such a PM before adapter dispatch,
including stale worker-role contexts; preserve execution-policy reviews in the PM
home with the PM's own model. A shared Claude or Codex worker may serve multiple
projects: use issue-scoped model settings and task sessions,
and route review to the issuing project's PM. Never resume an Owner replanning
hold when changing this topology or reuse another task's native session. Any
directory may be shared; placement follows the workspace = directory rule below.
2. Keep contracts synchronized.
If you change schema/API behavior, update all impacted layers:
- `packages/db` schema and exports
- `packages/shared` types/constants/validators
- `server` routes/services
- `ui` API clients and pages

3. Preserve control-plane invariants.
- Single-assignee task model
- Atomic issue checkout semantics
- Approval gates for governed actions
- Budget hard-stop auto-pause behavior
- Activity logging for mutating actions
- A terminal run status releases every gate (workspace, holders, slots, retirement); stop evidence is collected best-effort in the background and never blocks admission or dispatch.
- External Runner reads classified by the server settle definite failures as tool errors. An unknown mutation outcome does not block: the run is resent with the liveness-first prefix so the agent checks current state before repeating it.
- The system never sets an agent pause, `needs_attention`, `uncertain` or an Owner-intervention requirement; only the Owner pauses or cancels.
4. Do not replace strategic docs wholesale unless asked.
Prefer additive updates. Keep `doc/SPEC.md` and `doc/SPEC-implementation.md` aligned.

5. Keep repo plan docs dated and centralized.
When you are creating a plan file in the repository itself, new plan documents belong in `doc/plans/` and should use `YYYY-MM-DD-slug.md` filenames. This does not replace Paperclip issue planning: if a Paperclip issue asks for a plan, update the issue `plan` document per the `paperclip` skill instead of creating a repo markdown file.

7. Name the three data paths correctly.
This repo has three separate data paths. Do not confuse them. Match a change to a path by its file path, not by the word "observability" or "telemetry" alone.

Apply a review level that matches the path:

- **Telemetry change (strict review).** The author updates the generated contract first. The author updates `packages/shared/src/telemetry/README.md` in the same pull request. The author requests a privacy review. Reason: a Telemetry event goes to a Paperclip endpoint by default, so a mistake sends data immediately.
- **Observability change (lighter review).** The operator endpoint gate stays in place. The no-operation behaviour stays when no endpoint is set. A privacy review is not necessary while the change stays inside the closed span-attribute allowlist.
- **Run-log change (no extra review).** A run-log change needs neither review level above, because the data stays in the instance database.

**Exclusion.** The word "observability" in a file such as `server/src/services/recovery-observability.ts` names a different concept. Apply this rule by path, not by word match.

## 6. Database Change Workflow

Fork migration compatibility checks compare SQL blobs at ancestor merge bases of
`origin/michael/main` and `upstream/master`; published byte-preserving renumbers
are inherited history. This guard never substitutes for pending-migration review,
production backup/history reconciliation, or the isolated clone upgrade. Keep
published SQL bytes unchanged. See `doc/DATABASE.md`.

When changing data model:

1. Edit `packages/db/src/schema/*.ts`
2. Ensure new tables are exported from `packages/db/src/schema/index.ts`
3. Generate migration:

```sh
pnpm db:generate
```

4. Validate compile:

```sh
pnpm -r typecheck
```

Notes:
- `packages/db/drizzle.config.ts` reads compiled schema from `dist/schema/*.js`
- `pnpm db:generate` compiles `packages/db` first

## 7. Verification Before Hand-off

Default local/agent test path:

Keep behavior with its owning module; shared contracts stay narrow and normalized.
See `rules/module-boundaries.mdc`. Instance-wide exceptions are catalogued in
`rules/company-scope-exceptions.mdc`.

```sh
pnpm verify
```

This selects affected Vitest files with the same conservative dependency policy
as CI. It includes committed, staged, unstaged, and untracked changes against the
merge base with local `origin/master` (or `master`), and it reuses passing checks
whose inputs are unchanged. Use `--base <ref>` for another base, `--explain` to
inspect the selection, and `--no-cache` for fresh execution. See "Incremental
local verification" in `doc/DEVELOPING.md` for how reuse and invalidation work.

Follow these rules:

- **Exit 2 means the change needs broader verification.** Run focused checks and
  let required CI supply that coverage, or explicitly use `pnpm verify --full`
  for the full local Vitest suite. Do not automatically follow exit 2 with a full
  local run.
- **Do not default to repo-wide checks.** Do not run repo-wide typecheck, build,
  or test on every heartbeat when a narrower check is enough to prove the change.
  Use the broad checks below only when they resolve an actual remaining gap, such
  as a local platform fault or explicit full-suite qualification.
- **Browser suites stay opt-in.** Run `pnpm test:e2e` and
  `pnpm test:release-smoke` only when your change touches them or when you are
  explicitly verifying CI/release flows.
- **CI covers the final revision.** For a PR-ready handoff, run the relevant local
  checks and require the applicable CI typecheck, build, and test checks to pass
  for the final tested revision. Record their scope, revision, environment, and
  result links. Fresh CI can supply broad coverage; do not duplicate a full local
  run merely to prepare a PR, resume a chat, or repeat unchanged passing
  verification. A selected local pass does not replace required CI, release
  qualification, browser acceptance, or a local/platform-specific regression.
- **Evidence expires.** After edits or a rebase, rerun affected checks and
  invalidate evidence whose inputs or required coverage changed. Failed or
  interrupted attempts are never passes.
- **Report gaps.** If anything cannot be run, explicitly report what was not run
  and why.
- **Attach deliverables.** When you work a Paperclip issue and produce a file for
  the user to inspect, attach it as the `paperclip` skill and
  `doc/AGENT-ARTIFACTS.md` describe. A local filesystem path is not enough.

For normal issue work, run the smallest relevant verification first. Do not default to repo-wide typecheck/build/test on every heartbeat when a narrower check is enough to prove the change.

Owner policy for this fork (2026-11-07): never run the full test suite, including
at hand-off, deployment, recovery or as a selector fallback. Run only tests related
to the change. Use the managed `fork-checks.py --since-release <previous release>`
workflow; unsupported selection stops explicitly. If a selection expands to
essentially the whole suite, narrow it and record the file-level rationale before
execution. Keep build integrity, database backup/history and service readiness
checks. See `/home/michael/services/README.md` for the deployment contract.

`pnpm test` and `pnpm test:run` run the full suite. If memory is limited, use
`node scripts/typecheck-low-memory.mjs` instead of `pnpm -r typecheck`. See
"Typecheck memory" in `doc/test-infrastructure.md`.

### Maps and Storybook

The [feature map](maps/feature-map/README.md) and the sibling
[agent access map](maps/agent-access-map/README.md) are optional references for
user entry points, agent entry points, permission boundaries, verification
recipes, and coverage gaps. They record coverage scope, not proof that a live
journey passed. Routine fixes, polish, refactors, and test changes do not require
map updates. When you do edit a map, follow
[the feature-map scope rule](rules/feature-map-scope.mdc) and
[the map contract](maps/README.md), then run `node scripts/check-maps.mjs`.

After story or recipe changes, update the affected source annotations or recipe
and run `node scripts/storybook-catalog.mjs`. Indexes are generated and ignored;
never commit them. See the [Storybook feature catalog](maps/storybook-map/README.md)
for the full workflow. Structural checks are not production acceptance.

## 8. API and Auth

Every route under `server/src/routes/` that reads or writes company data checks
company access and actor permissions, logs mutations to the activity log, and
returns consistent HTTP errors. See [`rules/api-route-expectations.mdc`](rules/api-route-expectations.mdc).

## 9. UI Expectations

Artifacts PDF thumbnails reuse the validated PDF read, render only page one near
the viewport, and retain the file icon on failure. Keep pdf.js lazy and bounded;
the shared PDF preview dialog still uses the native viewer. See
`docs/fork/artifacts-and-mobile.md`.

ImageGalleryModal owns shared media navigation; ZoomableGalleryImage owns image-only
zoom/pan gestures in both the gallery and ArtifactPreviewProvider. Give artifact images a bounded viewport. Reset its view on item changes and reopen, bound pan to the viewport,
and preserve video controls, download, Escape and focus restoration. See
`docs/agents/ui-features.md` for the interaction contract.

- Keep routes and nav aligned with available API surface
- Use company selection context for company-scoped pages
- Surface failures clearly; do not silently ignore API errors
- Follow `DESIGN.md` for every UI design decision, including the token-only rule and form footers.

## 10. Fixing a Bug

When you are asked to fix a bug, attempt to use test-driven development and prove the fix red-green:

1. Reproduce the error yourself.
2. Write a test that fails because of the bug.
3. Write the fix.
4. Run the test and confirm that it passes.
5. Verify that the fix worked: repeat the reproduction from step 1 and confirm that the error is gone.

## 11. Pull Requests

Fill in every section of [`.github/PULL_REQUEST_TEMPLATE.md`](.github/PULL_REQUEST_TEMPLATE.md), however you create the pull request. Do not write an ad-hoc body. See "PR Requirements" in `CONTRIBUTING.md` for the details and thinking-path examples.

## 12. Definition of Done

A change is done when all are true:

1. Behavior matches what the task asked for and preserves the invariants in section 5
2. Relevant local verification and required CI typecheck, test, and build checks pass for the final revision, with any acceptance or platform-specific gaps resolved (section 7)
3. Contracts are synced across db/shared/server/ui
4. Docs updated when behavior or commands change. `doc/DEVELOPING.md` holds setup, commands, and everyday workflow only, and `doc/DATABASE.md` holds database setup and the rules for every schema change. Put a note about how a subsystem behaves in that subsystem's doc (see "More documentation" in `doc/DEVELOPING.md`), or leave it in the PR description when the code and tests already say it.
5. PR description follows the [PR template](.github/PULL_REQUEST_TEMPLATE.md) with all sections filled in (including Model Used)

## Design system

`DESIGN.md` at the repo root is the source of truth for UI design decisions. The token-only rule applies to all `ui/` changes: every color, spacing, radius, type, shadow, and motion value in `ui/src/components/**` and `ui/src/pages/**` comes from the token layer in `ui/src/index.css` — no hex, raw px, arbitrary Tailwind bracket values, or raw `font-size`/`fontSize` declarations in components, outside the documented allowlist in `ui/src/index.css`. Run `pnpm check:token-gates` (`scripts/check-token-gates.mjs`) before committing UI changes — it fails on any violation not covered by that allowlist.

Delivery guidance must match the actual runtime: native tools for Runner, authenticated Paperclip skill
and task APIs for legacy adapters. Never require a native-only tool in a legacy run.

LRH external waits settle with their one-shot heartbeat receipt under issue admission; see docs/agents/execution-semantics.md.
Issue wake admission belongs to wake-queue.admitIssueWake: retain the company-scoped
issue row lock and durable receipt writes in one transaction, run fork workspace/main
policy in its callback, and dispatch only after commit. Do not restore automatic
blocked recovery or transaction-scope compatibility shims. See
docs/agents/execution-semantics.md.
Lightweight preflight preserves conversation-requester ownership; prepareRecovery
checks saved Retry and queued-comment ownership before busy/fresh admission. Keep
one-shot execution review/approval/changes handoffs durable in recovery deferral.
Verified pre-dispatch cancellation receipts need no provider delivery evidence.
Keep a fresh attempt when that admission never owned the preserved workspace.
Fresh task Retry keeps its exact terminal source in interruptedRunId for the
inspect-existing-work prompt, without borrowing preparation continuation authority.
Only after queue admission may it lift its ancestry's system failure block;
preserve human, declared, dependency and newer blocks.

## Native session bridge

HOM-458 main Chat compaction scope is rebuilt in task-context from the assigned ccpocket_bridge main. mainContextCompactThresholdTokens defaults to 150000, 0 disables. Keep maintenance at the adapter/Bridge idle boundary; never replay unknown maintenance or turn its failure into a user-input retry. Preserve canonical TODO/cards/decisions. See docs/agents/session-bridge.md.

Explicit task cancellation by an authorized reviewer, project lead or board actor
abandons execution review without a changes-requested decision or worker wake. AI
connection requests expire only on task closure, ownership change or proven changes
to that task's effective AI requirement. Preserve worker overrides and reviewer
isolation, including blocked reviews; time, failed source runs and other Chat
successes prove nothing. Task/card/attention reads share canonical expiry; cleanup
never grants access or resumes work. See doc/connections/AI-CONNECTIONS.md and
docs/agents/decisions-and-review.md.

Main→worker comments default to active-turn steer for a running worker of the lead main's project;
explicit deliveryMode=queue, idle and already queued inputs keep their boundary. Direct-input
receipts are never replayed or silently queued after rejection/unknown acknowledgement. Agent Chat
cards show orange `pending` for Owner-actionable plan/approval decisions, ahead of working/waiting;
resolved, expired, draft and agent-delegated requests do not qualify. See docs/agents/session-bridge.md
and docs/agents/ui-features.md.

Codex main Chat sends use native steer by default, including Enter during an
active response. Persist the effective role/provider/model before Bridge dispatch;
never derive the active run's routing from subsequently edited agent settings.
Await native acknowledgement and retain original run/thread/turn correlation.
See `docs/agents/session-bridge.md` for queue and unavailable-turn semantics.

Chat presentation uses the shared IssueComment origin type so native inbox and
mirrored messages retain their provenance through the UI adapter.

Human Chat wake requesters must be the conversation owner before queue admission;
an owner-authored saved message never grants another requester's authority. See
docs/agents/session-bridge.md.

Saved input behind a terminal native run must not wait for finalization to become
committed; retain the original evidence. See docs/agents/execution-semantics.md.
Queued-message Interrupt returns after durable intent and cancellation fencing;
Stop and ordered queue promotion continue under their original owner in the
background. A 200 is acceptance, not process-stop proof, including main Chat task
preemption. See docs/agents/session-bridge.md.
Preparation Retry fixtures must promote an actually due durable retry. Preserve
saved directory identity and content; do not assert placement from adapter config.

Skill heading changes must synchronize both Runner capability inventories
(`generated/capability` and `spec/capability`), their generated contracts/docs and
baseline-count tests. Verify both check:capability-contract and check:capability-inventory.

Session-bridge-only MCP definitions live in packages/mcp-server/src/session-bridge-tools.ts;
keep them separate from the Runner legacy MCP catalog in tools.ts. Regenerate the
Runner capability source anchors when legacy definitions move, and verify both
catalog surfaces without granting session-only tools to heartbeat clients.

Runner replay must keep authenticated lease renewals and order-independent command
results responsive during slow event commits; bound the queue without pausing TCP ingress.


Local preparation never acquires Git source-copy locks; remote materialization
keeps source-copy coordination inside its own preparation path.
Workspace = directory. The run cwd is the run-requested cwd, else the agent's fixed
cwd, else the project default cwd, else `~/.paperclip/instances/default/workspaces/<agentId>`;
it is created with `mkdir -p` (over ssh on remote hosts). Admission, registration,
generation/operation receipts, shared-checkout claims, fixed/isolated conflicts and
host inspection never fail a run; mismatches are logged only. Any number of runs may
share a directory; the per-issue execution lock still keeps one run per issue. Main
agents may still create a Git worktree explicitly with the worktree tool; non-Git
directories are never Git-initialized for dispatch. Session authority is
last-writer-wins: a claim by a running, uncancelled run of the same task takes over
(generation+1, prior authority revoked, `takeoverFrom` recorded). 30 minutes without a
run event interrupts it as `inactivity_timeout`; the server cancels runs silent for 35
minutes. A per-host in-memory circuit breaker (`server/src/services/host-circuit-breaker.ts`)
defers wakes for an unavailable host instead of failing them. One-time cleanup:
`paperclip ops liveness-reset --dry-run|--apply --receipt <path>`. Worktree retirement
never force-removes and never deletes a directory with dirty or ignored files;
repository-root retirement only unregisters metadata.

# Moved details (read the file when the task touches the topic)

- `/home/michael/services/docs/agents/liveness-first.md` — Binding liveness-first policy (Owner 2026-11-13); wins over any conflicting rule below
- `docs/agents/execution-semantics.md` — Liveness-first run retry/cancel, unknown-outcome resend, failure classes, inactivity, session authority, input receipts
- `docs/agents/workspace-admission.md` — Workspace = directory resolution, explicit worktree creation and safe retirement
- `docs/agents/worktree-observed-state.md` — Main-managed worktree API: Git state is the truth, idempotent operations, receipts audit only
- `docs/agents/pm-agents.md` — Zero-slot PM policy, bundle layout, dispatch, read scope, worker policy, watchdog, homes
- `docs/agents/decisions-and-review.md` — PM decision authority, review decisions, decision delegation, secret delegation, review recovery
- `docs/agents/ui-features.md` — Sidebar status, coordinator sidebar, PDF preview, live work cards, worker-card collapse UI
- `docs/agents/session-bridge.md` — Native session bridge: startup recovery to main Chat, Codex steering, session-bridge keys
- `docs/agents/platform-notes.md` — Web Push, host quotas, Runner/PRP contract, Dot assignment, artifact delivery, data-path inventory
- `docs/agents/testing-and-maps.md` — Scheduler test rules, feature/access/storybook maps and their check commands

## Antigravity CLI shared workers

The fork ports upstream PR #21121 as `agy_local`, separate from the pending
Google ACP runtime and from `ccpocket_bridge`. Preserve explicit subscription
bindings and model/effort/permission through the revision-checked worker policy.
Shared CLI workers set `subscriptionOnly:true`; all CLI invocations disable
paid extra credits with `useG1Credits:false`. Plan never skips permissions;
auto is unsupported. Preserve existing Bridge agents, policies, sessions and
credentials. See `doc/DEVELOPING.md` and `docs/adapters/agy-local.md`.

## Local voice conversation

New agent-chat calls use `natural_chat_v2`: filtered small talk is answered by
Realtime; work and project questions forward only the server-held original input
through a current-turn token. Keep main-answer provenance, replay/deduplication,
barge-in and voice approval restrictions. Do not restore legacy latest-reply
routing. Changes require both engine regressions and a real routing smoke; see
`doc/connections/LOCAL-VOICE.md`. Existing call policies are not rewritten.

Agent-pinned company catalog reads accept agentId only after company/adapter and
explicit hostId match the saved agent. Pass serverVerifiedHostId internally, never
from query/config. Include agent identity in picker caches; keep company host
choices, terminals and quota scope unchanged. Same-host model saves may use the
trusted previous config. Preserve safe adapter failure codes in 422 responses.
See docs/agents/workspace-admission.md.
