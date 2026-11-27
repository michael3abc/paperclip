# testing-and-maps

Moved verbatim from `AGENTS.md` on 2026-11-13. These rules and records stay binding; read this file before acting on the topic. Scheduler test rules, feature/access/storybook maps and their check commands

Database-backed scheduler tests must separate fake deadline advancement from
wall-time batch completion and join execution cleanup before fixture teardown.
Assert persisted absolute deadlines after I/O; never assume a fixed startup duration.
Isolate each test's database-client work-signal owner; truncation cannot clear
uncertain transaction notifications retained in memory after deliberate rollback.
Timing-only recovery fixtures retain real Drizzle query/locking composition;
event persistence, rollback and contention require owned PostgreSQL coverage.

[maps/feature-map/README.md](maps/feature-map/README.md) is an optional reference for user
entry points, verification recipes, and coverage gaps. The map records coverage
scope, not proof that a live journey passed.

The sibling [agent access map](maps/agent-access-map/README.md) records APIs,
agent entry points and permission boundaries using the same capability IDs.
Follow [the feature-map scope rule](rules/feature-map-scope.mdc): additions require
substantial new features. Routine fixes, polish, refactors, and test changes do
not require map updates. Follow [the map contract](maps/README.md) for minimal
corrections when existing entries become materially inaccurate, and run
`node scripts/check-maps.mjs` after map edits.
Its structural checks do not prove live behavior or authorization.

Storybook has a downstream [feature catalog](maps/storybook-map/README.md).
Use `maintain-storybook` for story/fixture drift and `review-storybook` for browser
evidence. Keep the feature-map skills independent of this catalog. After story or recipe changes, update the affected source annotations or
recipe and run `node scripts/storybook-catalog.mjs`. Indexes are generated and
ignored; never commit aggregate catalogs, refresh review fingerprints, or append
a shared review journal. Use Git diffs and keep review evidence in the PR or issue.
Structural checks are not production acceptance.

## Repository agent rules (HOM-777)

Moved verbatim from `AGENTS.md` on 2026-11-27. These rules remain binding;
read the matching topic before changing it. Repository policy precedence is unchanged.

The Owner policy in `AGENTS.md` section 7 (2026-11-07) overrides the
historical full-suite options quoted below: never run the full suite or use it
as a selector fallback. Keep related-test scope explicit.

### Owned test resources

Use owned disposable databases and dedicated test notifications; do not wake real
agents. Non-Git workspace tests require a clean owned temporary root with no
ancestor Git metadata. Chromium injection tests do not qualify APNs or physical iPhone delivery.

### Local verification workflow

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

### Preparation Retry fixtures

Preparation Retry fixtures must promote an actually due durable retry. Preserve
saved directory identity and content; do not assert placement from adapter config.
