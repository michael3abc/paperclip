# sidebar-and-live-panels

Moved verbatim from `FORK.md` on 2026-11-13. These rules and records stay binding; read this file before acting on the topic. Sidebar status, live work panels, worker/subagent cards, mobile task panel

2026-11-12 Antigravity worker-card proof: a provider-specific persisted Bridge
turn receipt binds the separately accepted input, native session and saved-answer
hash without inventing native input/turn IDs. Current authority and activity gates
remain required; no historical success backfill, replay or resource mutation.

2026-11-12 worker-card presentation: a project-scoped session-bridge read endpoint
proves the current worker run/input and saved successful result. Existing durable
status delivery and control events invalidate cards; late session publication
re-arms that same queue. The host additionally verifies native turn/tools/input
before display collapse. Unknown, pending, failed or superseded turns remain
visible. No native archive, stop, history removal or workspace release is involved.
Worker-card invalidations use their authorized issue binding independently of
generic status broadcasts, preserving canonical legacy identity redaction.

- Mobile conversation task-panel access (2026-11-11): show the page-owned
  panel control in mobile headers and route it to the mobile sheet, keeping the
  lower Tasks list reachable for runtime identity inspection.

The michael/codex-subagent-card-model feature adds run-owned and child-owned harness/model/source
labels to Agent Chat live work cards. It consumes normalized adapter activities, preserves unknown
metadata and does not create tasks, change agent configuration or add a database migration.
Deployment remains serialized by the existing Paperclip release writer on michael/main.

### PM sidebar status (2026-11-08)

Feature branch `sidebar-agent-status`. First feature commit `18c527ba2d` was presentation
only; follow-up commits on the same branch add the stored per-person exclusion list below,
so the branch now carries one additive migration (`0440_fine_leper_queen`; renumber if the
release line gained migrations meanwhile) and no dispatch, permission or agent-configuration
change. Project PM rows in the Agents section show blue `working` while a readable running
task of the PM's project (subtasks included) executes, and orange `needs input` (overriding
blue) while an Owner-addressed `issue_thread_interaction`, `approval` or `decision` of that
project is pending. Agents without a project PM binding (such as momo) get no
status. Zero-slot PMs work through shared
workers, so attribution uses `GET /companies/:id/pm-workspaces` plus a company-bound
`projectId` on `GET /companies/:id/live-runs` (omitted on redacted rows), never
`run.agentId`. The attention query reads the complete `all=true` snapshot. A `running`
row whose cached projection still says `queued` counts as working because
`heartbeat.run.status` patches only `status`. Sidebar rows use the neutral `ring-ring`
keyboard focus ring instead of the browser default outline. The plain and `.production`
sidebar chains change in lockstep. See `AGENTS.md` for the standing rule.

Follow-ups required by pre-release review:

- Approval attention items now carry `project` (`...issueContext(...)` from the existing
  readable-issue map in `server/src/services/attention.ts`); before, `project` was `null`,
  so a real pending approval never turned its PM orange. Cross-company and private-issue
  exclusions are unchanged; `attention-service.test.ts` asserts the real
  `GET /companies/:id/attention?all=true` response shape.
- A PM-bound agent can also be a person's own agent, and the binding alone cannot tell them
  apart (no existing agent, preference, membership or binding field does). The person's
  exclusion list is stored in `company_user_sidebar_preferences.excluded_pm_status_agent_ids`
  (jsonb array of agent IDs, `NOT NULL DEFAULT '[]'`, so every PM shows status by default
  and the previous release keeps working on the new schema). It is read and written by the
  existing `GET/PUT /companies/:companyId/sidebar-preferences/me` as
  `{ excludedPmStatusAgentIds }` under the existing board/membership checks; the PUT is
  patch-style, so a legacy `orderedIds`-only project-reorder PUT preserves the list, and the
  audit action `sidebar_preferences.pm_status_exclusions_updated` is written only when the
  list was sent. The repository holds no agent names or production IDs: after deploy the
  Owner writes the verified IDs for the Owner's own user and company.
- No silent fallback: both sidebar chains share one query. A list that cannot be read is not
  an empty list, so with no loaded list they claim no PM status and surface the failure through
  the existing toast (`Could not load PM status settings`); a failed refetch keeps the list that
  was already loaded. `useProjectOrder` has no rollback, and its optimistic cache write spreads
  the cached row, so the list survives reorders (an empty cache gets no list field, which readers
  treat as unknown).
- `sidebar-preferences-routes.test.ts` warms the one-time route-module import in a
  `beforeAll` (hook timeout 120s) so the file passes at the default 15s test timeout; the
  failing first test before the change is retained as release evidence.

Validation was related-only: the sidebar/live-run/preference UI tests, the heartbeat
privacy-routes, attention-service, sidebar-preferences routes and DB-backed service server
tests, the DB migration tests, the token gates and Chromium runs against a mocked,
local-only API; no full suite and no real agent was woken. Known
limits: runs the viewer cannot read are not attributed; the attention query runs only
when the company has PM workspaces; the initial revision did not cover the `.production`
chain; the Coordinator follow-up below adds equivalent behavioral tests; the narrow sidebar truncates PM names beside the
wider `needs input` label; the non-delegation legacy privileged-approval path was not
exercised; there is no UI to edit the exclusion list (written through the API). Release
ordering, the combined-release backup/history/isolated-upgrade of migration 0440 and
deployment remain with the Owner via the release line.

### Coordinator PM status convergence (2026-11-08)

Feature branch michael/coordinator-pm-status corrects the active Coordinator entry,
which still used the 6f354182d0 task-tree/chat outline after classic PM status shipped.
Coordinator and both classic variants now share useProjectPmSidebarStatus and the
existing row rendering. Remove the unused agent-activity helper and open-work scan.
The shared hook requires binding/preference/attention snapshots, reports first and
refetch failures, retains loaded data and shares the complete attention cache with
the pages. This deliberately permits bound PM navigation to fetch all=true, unlike
the general count-only rule; no bindings means no full feed. See the Coordinator
contract in doc/SPEC-implementation.md and focused checks in doc/DEVELOPING.md.

Frontend-only overlay on b6ae191596-r1: no backend, migrations, restart, agent wakes
or permission changes. The exact Storybook preview fixture is development-only.
Publish from michael/main with targeted status/attention tests, typecheck, token
gates, build, catalog and read-only production DOM/network evidence; retain the old
UI and index-hash receipt for atomic rollback. Empty live state proves empty state
only; deterministic consumer tests establish blue/orange behavior.

### Main agent live work panel (2026-11-08)

Feature branch michael/main-agent-panel adds a live work panel above the agent
chat's task list. The top card shows the agent's current or most recent run: issue,
in-progress checklist step (`plan` provider activity), last tool, elapsed time and
run link. Each card below is one native subagent (`delegation` activity merged by
`delegationId`), with status, type, tool/token usage and the result after completion.
It reads the existing run transcript; adapters without these activities show only
the top card. Publish from michael/main through the existing UI overlay after
relevant UI tests, typecheck, token gates and build; retain rollback assets. No
backend, schema, restart or agent-state changes are part of this panel.

Commits: `01cc81f48` (panel), `9e29855c0` (context fill and subagent progress) and
`1749aacfe`. The last one fixes an upstream bug: the sandboxed adapter UI parser
worker never started in Chromium, so external adapters' run transcripts were empty
in the browser. Its lockdown assigned to getter-only WorkerGlobalScope accessors
such as `indexedDB`, which throws in strict mode. The bootstrap now shadows each
blocked global with a non-writable own property and fails closed when a global
cannot be hidden. `ccb7f7e4b` makes the panel independent of parse order: the
sandboxed parser is one shared, line-cached instance per page, so a tail-only
reader (compact chat) could freeze a partial checklist and name a subagent card
from progress text. The panel rebuilds the checklist from the TodoWrite /
TaskCreate / TaskUpdate tool entries and their results, names a subagent only
from its `started` event, and reads the run log from the start (up to 2 MB).
Published as UI-only overlays on b6ae191596-r1.

- Coordinator starred agents (2026-11-09): project main agents use an ordinary role, so
  the Coordinator sidebar's Agents section (primary, `ceo` and `pm` only) never listed
  them. It now also lists agents the person starred, through the existing per-user
  agent membership stars; terminated, `process` and left agents stay hidden, the
  primary-first/alphabetical order and PM status rules are unchanged, and dispatch and
  roles are untouched. No schema change.
- Main agent working status (2026-11-09): project main agents have no `project_pm`
  binding, so the Coordinator Agents section never showed blue `working` for them, even
  while their own run (and the native subagents inside it) was executing; the classic
  sidebar's live dot was the only signal. The Coordinator now passes its listed agents
  to `useProjectPmSidebarStatus` as `selfRunAgentIds`: an unbound listed agent is
  `working` while its own readable run is working (`run.agentId` only; queued, answer
  waits and ended or failed runs clear it), after the bindings and the viewer's
  exclusion list load. It gets no project attribution and no `needs input`, starts no
  full attention read, and excluded agents (such as momo) stay plain. PM rules and the
  classic sidebars are unchanged. Frontend only; no schema change.
