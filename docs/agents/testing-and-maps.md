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

