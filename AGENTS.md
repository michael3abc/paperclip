# AGENTS.md

Guidance for human and AI contributors working in this repository.

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
or unknown (3 transient retries, then deterministic); see
`server/src/services/recovery/failure-classification.ts`. Owner Stop/cancel and
manual pause still apply and revoke automatic retry. New human or project-main
input supersedes automatic retry of a failed predecessor and keeps its own input
receipt. See `docs/agents/execution-semantics.md`.

Dashboard subscription quota sources are company-scoped operator configuration; remote credentials stay on the selected host, with no local fallback. See docs/agents/platform-notes.md and doc/DEVELOPING.md.
Codex Business/Enterprise monthly credit quotas come from RPC individualLimit; preserve its remaining percentage and reset. Metadata-only credits are not reported quota, and RPC credit amounts are not dollars.
Plain Bridge workers may opt into runtimeConfig.bridgeWorkerHostCapacity (host ID to independent concurrent-run limit). Task models retain full host/provider IDs; validate and pin their route before workspace preparation. Catalogs probe only the dispatch owner's host. Preserve historical worker/session identities and never fail over to another host. See docs/agents/pm-agents.md.

## 1. Purpose

Paperclip is a control plane for AI-agent companies.
The current implementation target is V1 and is defined in `doc/SPEC-implementation.md`.

## 2. Read This First

Before making changes, read in this order:

1. `doc/GOAL.md`
2. `doc/PRODUCT.md`
3. `doc/SPEC-implementation.md`
4. `doc/DEVELOPING.md`
5. `doc/DATABASE.md`

`doc/SPEC.md` is long-horizon product context.
`doc/SPEC-implementation.md` is the concrete V1 build contract.

When adding or changing an Apps catalog connection, also follow
`doc/connections/CONNECTOR-PLAYBOOK.md`. It is the canonical connection
authoring runbook for provider research, supported transport/auth patterns,
credential handling, branding, implementation, testing, live proof, and PR
submission.

### Scoped repository rules

Before editing or reviewing files, read the matching rules in `rules/*.mdc`.
Each rule has Markdown content and YAML frontmatter: `globs` contains
comma-separated, repository-relative file patterns, and `alwaysApply: true`
means the rule applies throughout the repository. Read all rules whose scope
matches the affected files. These rules supplement this file and any applicable
nested `AGENTS.md` instructions.

For `server/src/services/chat-channels.ts` and everything under
`server/src/services/chat-channels/`, read
[`rules/chat-channel-platform-boundaries.mdc`](rules/chat-channel-platform-boundaries.mdc).
For `server/src/services/heartbeat.ts`, `server/src/services/heartbeat/`,
heartbeat-prefixed sibling services, and heartbeat regression tests, read
[`rules/heartbeat-execution-boundaries.mdc`](rules/heartbeat-execution-boundaries.mdc).
For ACPX provider profiles, their release attestations and pins, the provider-pack
contract registry, and ACPX driver and provider code under
`packages/paperclip-runner/`, read
[`rules/acpx-profile-identity.mdc`](rules/acpx-profile-identity.mdc).
See [`rules/README.md`](rules/README.md) for rule authoring and Greptile setup.

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

## 4. Dev Setup (Auto DB)

Use embedded PGlite in dev by leaving `DATABASE_URL` unset.

```sh
pnpm install
pnpm dev
```

This starts:

- API: `http://localhost:3100`
- UI: `http://localhost:3100` (served by API server in dev middleware mode)

Quick checks:

```sh
curl http://localhost:3100/api/health
curl http://localhost:3100/api/companies
```

Reset local dev DB:

```sh
rm -rf data/pglite
pnpm dev
```

## 5. Core Engineering Rules

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

```sh
pnpm test
```

This is the cheap default and only runs the Vitest suite. Browser suites stay opt-in:

```sh
pnpm test:e2e
pnpm test:release-smoke
```

Run the browser suites only when your change touches them or when you are explicitly verifying CI/release flows.

For normal issue work, run the smallest relevant verification first. Do not default to repo-wide typecheck/build/test on every heartbeat when a narrower check is enough to prove the change.

Owner policy for this fork (2026-11-07): never run the full test suite, including
at hand-off, deployment, recovery or as a selector fallback. Run only tests related
to the change. Use the managed `fork-checks.py --since-release <previous release>`
workflow; unsupported selection stops explicitly. If a selection expands to
essentially the whole suite, narrow it and record the file-level rationale before
execution. Keep build integrity, database backup/history and service readiness
checks. See `/home/michael/services/README.md` for the deployment contract.

If memory is limited, use `node scripts/typecheck-low-memory.mjs` instead of `pnpm -r typecheck`. See `doc/DEVELOPING.md`.

If anything cannot be run, explicitly report what was not run and why.

## 8. API and Auth Expectations

- Base path: `/api`
- Board access is treated as full-control operator context
- Agent access uses bearer API keys (`agent_api_keys`), hashed at rest
- Agent keys must not access other companies

When adding endpoints:

- apply company access checks
- enforce actor permissions (board vs agent)
- write activity log entries for mutations
- return consistent HTTP errors (`400/401/403/404/409/422/500`)

## 9. UI Expectations

- Keep routes and nav aligned with available API surface
- Use company selection context for company-scoped pages
- Surface failures clearly; do not silently ignore API errors
- Form and wizard footers: keep Save & exit (or Cancel/Back) left and the primary action right in the same vertically aligned row. Each step owns the entire footer; never append Save & exit as a separate row. See `DESIGN.md`.

## 10. Pull Request Requirements

When creating a pull request (via `gh pr create` or any other method), you **must** read and fill in every section of [`.github/PULL_REQUEST_TEMPLATE.md`](.github/PULL_REQUEST_TEMPLATE.md). Do not craft ad-hoc PR bodies — use the template as the structure for your PR description. Required sections:

- **Thinking Path** — trace reasoning from project context to this change (see `CONTRIBUTING.md` for examples)
- **What Changed** — bullet list of concrete changes
- **Verification** — how a reviewer can confirm it works
- **Risks** — what could go wrong
- **Model Used** — the AI model that produced or assisted with the change (provider, exact model ID, context window, capabilities). Write "None — human-authored" if no AI was used.
- **Checklist** — all items checked

## 11. Definition of Done

A change is done when all are true:

1. Behavior matches `doc/SPEC-implementation.md`
2. Typecheck, tests, and build pass
3. Contracts are synced across db/shared/server/ui
4. Docs updated when behavior or commands change
5. PR description follows the [PR template](.github/PULL_REQUEST_TEMPLATE.md) with all sections filled in (including Model Used)

## Design system

`DESIGN.md` at the repo root is the source of truth for UI design decisions. The token-only rule applies to all `ui/` changes: every color, spacing, radius, type, shadow, and motion value in `ui/src/components/**` and `ui/src/pages/**` comes from the token layer in `ui/src/index.css` — no hex, raw px, arbitrary Tailwind bracket values, or raw `font-size`/`fontSize` declarations in components, outside the documented allowlist in `ui/src/index.css`. Run `pnpm check:token-gates` (`scripts/check-token-gates.mjs`) before committing UI changes — it fails on any violation not covered by that allowlist.

Delivery guidance must match the actual runtime: native tools for Runner, authenticated Paperclip skill
and task APIs for legacy adapters. Never require a native-only tool in a legacy run.

## Native session bridge

Chat presentation uses the shared IssueComment origin type so native inbox and
mirrored messages retain their provenance through the UI adapter.

Skill heading changes must synchronize both Runner capability inventories
(`generated/capability` and `spec/capability`), their generated contracts/docs and
baseline-count tests. Verify both check:capability-contract and check:capability-inventory.

Session-bridge-only MCP definitions live in packages/mcp-server/src/session-bridge-tools.ts;
keep them separate from the Runner legacy MCP catalog in tools.ts. Regenerate the
Runner capability source anchors when legacy definitions move, and verify both
catalog surfaces without granting session-only tools to heartbeat clients.


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
