# AGENTS.md

Fork note: this is the `michael3abc/paperclip` fork. Paragraphs that cite the
Owner, HOM issue keys or `/home/michael` paths are the maintainer's host rules and
bind every agent on that host. Public host/company examples are fictional;
retain executable default-host, model/billing/routing contracts and real canonical
host policy paths. Cleanup applies to the tip only, not Git history. See
`docs/fork/host-operations.md`. On another machine, read
`docs/fork/host-operations.md` to see which rules apply to you.

Guidance for human and AI contributors working in this repository.

Execution is liveness-first (Owner 2026-11-13):
`/home/michael/services/docs/agents/liveness-first.md` overrides conflicting
fail-closed rules here. Unknown outcomes abandon, release gates and resend with
「上一次可能已部分執行，先檢查現況再做」; terminal runs release gates while stop
proof is collected in the background. Owner Stop/cancel/pause still apply.
See `docs/agents/execution-semantics.md` for retry and input rules.

Workspace = directory: resolve run cwd > agent fixed cwd > project default > per-agent
cwd, create if missing, never gate dispatch on Git registration or initialize Git
for dispatch; see `docs/agents/workspace-admission.md`, including safe retirement.

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

`rules/*.mdc` contains scoped architecture rules: `description` states the rule,
`globs` its files, and `alwaysApply: true` covers the repository. List headers:

```sh
grep -E '^(description|globs|alwaysApply):' rules/*.mdc
```

Follow applicable descriptions and nested `AGENTS.md` files. Read a rule body
when making a design decision in its area, when its description leaves compliance
unclear, or when a reviewer cites it. See `rules/README.md` for authoring and Greptile.

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

1. Keep changes company-scoped.
Every domain entity should be scoped to a company and company boundaries must be enforced in routes/services.

Instance-wide exceptions must preserve company membership checks and grant no
authority; see `rules/company-scope-exceptions.mdc` before changing them.

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

6. Attach inspectable generated artifacts.
Follow the `paperclip` skill and `doc/AGENT-ARTIFACTS.md`: upload deliverables,
register work products, link them in the final issue comment, then set status.
Use workspace-relative work-product metadata for intentionally workspace-only files;
a bare local path is insufficient. Match delivery to the actual runtime.

6. Keep deployment policy out of Core.
Do not hardcode Cloud allowlists, provider choices, or deployment-specific
defaults here. Core provides generic, documented configuration mechanisms;
the deployment repository supplies and owns its policy. Changing a Cloud
policy must not require a Core code change. See
[harness availability](doc/harness-availability.md) for an example contract.

7. Name the three data paths correctly.
Apply Telemetry, Observability and run-log review by file path, not word matches;
see `rules/data-paths.mdc` and `docs/agents/platform-notes.md` for paths and review levels.

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

Run the smallest relevant checks first; keep behavior with its owning module
(`rules/module-boundaries.mdc`). Use owned disposable DBs/test notifications;
never wake real agents. See `docs/agents/testing-and-maps.md` before changing
test fixtures, verification, maps, stories or recipes.

`pnpm verify --base <ref>` runs affected checks; add `--explain` to inspect selection.
Reuse passing evidence only while inputs and required coverage are unchanged.
Exit 2 requires explicit scoped verification, never a full-suite fallback. Browser
suites stay opt-in for changes touching them or explicit CI/release verification.
For PR handoff, require applicable CI checks for the final revision and record scope,
revision, environment and result links. Local selection does not replace release,
browser or platform acceptance. Invalidate changed evidence; report failures,
interruptions and gaps. Attach deliverables per `doc/AGENT-ARTIFACTS.md`.

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

## 8. API and Auth

Every route under `server/src/routes/` that reads or writes company data checks
company access and actor permissions, logs mutations to the activity log, and
returns consistent HTTP errors. See [`rules/api-route-expectations.mdc`](rules/api-route-expectations.mdc).

Connected-account saved sign-ins cannot be deleted or disabled while referenced
by an active connection/grant; see `docs/api/secrets.md`. Responsibility rollups
include routine agent IDs and the dashboard routine filter; see `doc/PRODUCT.md`.

## 9. UI Expectations

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

# Moved details (read the file when the task touches the topic)

Moved rules stay binding. Read the matching file before acting.

- `/home/michael/services/docs/agents/liveness-first.md` — Binding execution policy; overrides conflicting rules.
- `docs/agents/execution-semantics.md` — Retry/cancel, classifiers, monitors, wake admission, LRH, preflight, Runner replay, input receipts.
- `docs/agents/workspace-admission.md` — Directory resolution, preparation, safe retirement and agent-pinned catalogs.
- `docs/agents/worktree-observed-state.md` — Main worktree API, Git state and idempotent operations.
- `docs/agents/pm-agents.md` — Zero-slot PMs, shared-worker policy/capacity, bundles, dispatch, read scope, watchdog and homes.
- `docs/agents/decisions-and-review.md` — Questions, decisions, review recovery, cancellation, AI-request expiry.
- `docs/agents/ui-features.md` — Sidebar/live cards, Chat pins/origins, pending status, PDF preview and image gallery.
- `docs/agents/session-bridge.md` — Startup recovery, compaction, steering, requester ownership, bridge keys, session-only MCP.
- `docs/agents/platform-notes.md` — Host sign-in/terminals/quotas, Web Push, Runner/PRP, Dot, artifacts, data paths, skill/capability contracts.
- `docs/agents/testing-and-maps.md` — Owned fixtures, scheduler/Retry tests, verification, maps/Storybook.
- `docs/api/issues.md` — Inbox archive and conversation-ownership reads.
- `docs/api/attention.md` — Attention caching, invalidation and scoped overlapping reads.
- `docs/guides/board-operator/costs-and-budgets.md` — Compass receipts, cache TTL pricing and incomplete usage.
- `doc/connections/AI-CONNECTIONS.md` — AI request lifecycle, cost reports, subscription estimates and project usage.
- `doc/connections/LOCAL-VOICE.md` — Voice preferences/media, endpoints, answer provenance, natural Chat routing, Speko outbound opening messages and voice-owned health; report projection is in `doc/idle-voice-call-reports.md`.
- `doc/connections/GENERIC-REMOTE-MCP.md` — Human browser login and vault/access boundaries.
- `docs/fork/artifacts-and-mobile.md` — Artifact PDF thumbnails and mobile preview.
- `docs/adapters/agy-local.md` — Antigravity shared CLI workers, subscription bindings and permissions.
- `rules/README.md` — Scoped rule loading, authoring and Greptile setup.
- `rules/company-scope-exceptions.mdc` — Instance-wide data exceptions and membership/authority limits.
