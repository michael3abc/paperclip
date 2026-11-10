# Paperclip fork

Upstream reference: `upstream/master` (fetch-only). Recorded merge base: `0eaabe5c0b37c99d827f78a1a8598e7b3534078a`.
The local release line is `michael/main`; previous releases and consolidation merges remain ancestors.

## Custom history

The first-parent inventory below includes retained consolidation history; it is not a claim that every upstream change was authored locally.

- `088f43e2ae` Port managed AI, native runner, SSH execution and chat fixes to source
- `188fb2eecf` Make native routing and runtime tools deployment-configurable
- `6865974a18` Bind agent sessions to an existing fixed workspace on their execution host
- `9911c081fe` Recognize plain workspace paths across filesystem mount boundaries
- `062c5c15c0` Stabilize fork regression fixtures under isolated parallel checks
- `7e5521319f` Isolate HTTPS backfill fixture ports and remaining cold route imports
- `bd3306666c` Initialize lazy route fixtures before request deadlines
- `f8064702b7` fix(native-routing): accept opaque operator user IDs
- `4878ce64e3` test: drain heartbeat teardown and isolate cold route setup
- `1e4e3405fb` Show agent workspace beside reporting manager
- `2cc6be9c21` feat(agents): add project_pm workspace binding with claim-time role
- `80150bb60d` feat(heartbeat): queue project PM runs by role capacity
- `c813b80995` feat(agents): let an agent's own run write its memory/ files
- `be9e737688` feat(agents): add PM intake, issue continue and pm-workspaces endpoints
- `eeed05c9f8` feat(ui): show a project PM workspace binding read-only in the agent form
- `c3d1afcf1f` fix(heartbeat): keep coalesced comment wakes at queued claim
- `a284e1bfe4` fix(heartbeat): wake a parent held only by its cancelled children
- `1283bbc244` fix(heartbeat): accept acknowledged issue reassignment stops
- `5b93d5dd76` fix(test): allow explicit fixture filesystem for stable test runs
- `e51c78b0a0` test: isolate cold setup and bound large fixture I/O
- `eed103b8b1` feat(agents): bind CC Pocket workers to remote project hosts
- `cb355d16fe` test(routines): load cold route modules during fixture setup
- `3474a6cdb2` fix(chat): bind project agent conversations before dispatch
- `741ab0067d` test(runtime): probe wildcard ports for exposure fixtures
- `0e37aad859` fix(recovery): stop retries for uncertain native session ownership
- `8d57873777` fix(heartbeat): run controller git setup outside remote worker roots
- `a5deb8fb29` feat(costs): price Compass receipts from a versioned vendor rate card
- `07e119a600` feat(project-pm): run a project PM natively on its worker host
- `59bb84bc26` fix(artifacts): hide artifacts of archived projects from the company list
- `8f12284c1d` feat(artifacts): sync media files from run workspaces into issue attachments
- `08468d14bd` fix(api): document workspace artifact discovery route
- `a741991978` fix(runner): join staged presentation batches before authority commits
- `b4884b7b1d` fix(rebase): align fixtures with upstream admission and lifecycle
- `d6b6eead3b` fix(server): decouple workspace artifact sweep from execution status delivery
- `e97596a526` test(runner): pin external authority commit over an in-flight event batch
- `e124379c70` test(server): cover fixed workspace policy conflicts
- `818a9e81e5` test(server): pin that cleanup never deletes a fixed project_primary directory
- `bbe8e4ad2c` refactor(server): extract project PM run admission from the heartbeat coordinator
- `c7b2517c16` fix(server): guarantee a final artifact scan per run before the sweep retires
- `2d2aadc341` test(server): exercise fixed-workspace close with cleanup hooks
- `b1338b9ad4` fix(server): probe tailnet bind host once per process
- `617a59fd01` test(recovery): publish the remote export fixture under .paperclip-workspaces
- `d230e87f0d` fix(artifacts): keep an idle server quiet after terminal runs
- `713f597114` test(server): wait for the first scheduled-retry pass explicitly
- `017b3de1d7` test(server): pay the agent-route cold transform in beforeAll
- `5d293288a6` test(cli): give the import/export e2e child server a 120 s startup budget
- `40076514c4` test(server): use the embedded-postgres hook budget for two DB suites
- `8d22e191c5` test(server): give the Muse python client contract a 120 s budget
- `9a973861c8` test(server): use the embedded-postgres hook budget for the status corpus
- `beaf4cc2d9` test(server): isolate voice reconcile tests and pin recovery retry timing
- `65975215fa` test(db): give the command-tree drain test a cold-start budget
- `a18b941b86` fix(recovery): skip review-path recovery for plugin-managed issues
- `9696cab4da` feat(ui): continue markdown lists on Shift+Enter in chat composer
- `a6afe037f7` feat(ui): add Agents section to the Coordinator sidebar
- `f8d1e645b0` feat(ui): show each agent's own avatar in the Coordinator sidebar Agents section
- `392a2fcbdb` feat(ui): hide process-adapter service agents from the Coordinator Agents section
- `6f354182d0` feat(ui): outline working agents in the coordinator AGENTS list (superseded by shared project PM status below)
- `4168242bfc` fix(ui): continue lists on Shift+Enter in the MDXEditor chat composer
- `46812a8808` feat(agents): let agents decide design and scope themselves; ask humans only for human matters
- `076b4007af` Merge pull request #1 from michael3abc/fix/dot-oauth-renewable-refresh
- `06587df42d` Merge pull request #2 from michael3abc/fix/dot-finish-feedback
- `f1bae10c35` feat(project-pm): allowCrossProject whitelist for general PM agents
- `c85b332217` fix(tool-gateway): omit structuredContent when a tool returns no object data
- `fdcdb2fc59` Add per-project worker list limiting task adapter overrides
- `29da67e3ba` test(project-worker-policy): seed a real responsible user for the service test
- `a1408b96a0` fix(connections): keep setup page after choosing Composio in the provider chooser
- `e60ebffa28` fix(ui): drop execCommand from chat composer list continuation
- `bf71060f0f` fix(runtime): isolate native PM review from worker task settings
- `2fa8751de0` fix(workers): fail invalid model policy instead of substituting defaults
- `b4ba1a8e94` docs(costs): use the canonical checkout for Compass ledger pricing
- `b9cc0742bc` feat(voice): integrate default-off local control plane with event-driven recovery
- `708c47741e` merge: consolidate rebased Paperclip while preserving local main history
- `b337eafaaa` fix(agents): recognize proven pre-dispatch PM rejection during stop
- `4e5fe15ef8` fix(ui): show only CEO and PM agents in coordinator sidebar
- `eae364398f` feat: restrict PM execution and support shared workers with task worktrees
- `4a3c581493` fix: show the personal primary agent in coordinator navigation
- `bf7c5500c5` fix: pin the primary agent above other sidebar agents
- `a42a90b714` fix: settle external runner reads and fence completion lifecycle
- `1e6646ec12` fix: preserve complete external runner assignments and receipts
- `561c611e79` fix: deliver scoped completion guidance with Dot assignments
- `6edbee0648` Merge PM coordination and review capability policy
- `4d76133be2` feat: manage PM worker policies and native project records
- `88b1c98277` feat: support scoped Codex PM dispatch and JSON worker purpose settings
- `de642e245a` Merge branch 'michael/main' into michael/pm-worker-settings
- `8781cfd7bd` docs: require related-only fork validation
- `3536783857` fix: retain verified PM home on pre-provider Retry
- `524a494735` fix: pin PM worker models to existing AI connections
- `2c6666f7cd` feat: route project decisions through PM and Owner-delegated agent
- `d6d2c8c0d7` fix: synchronize delegated decision contracts and validation fixtures

- `672478c734` fix: authorize PM project reads and enforce decision boundaries
- `18c527ba2d` feat(ui): show project PM working and needs-input status in the sidebar

Current change: admit configured non-Git document directories with exclusive physical-path ownership, including beneath an ancestor ignore-only `.git/info/exclude` directory; retain Git validation for real repository metadata, repository/ref and worktree operations.
Earlier permission repair: audited PM project reads, formal decision routing and execution-review API boundaries.
Earlier dispatch repair: live schema, readiness/session diagnostics and pre-creation workspace admission.
Acceptance follow-up: scoped saved-response asset reads and preservation of task worktree bindings during PM review.
PM autonomy follow-up: native assigned-review decisions, independent Owner-scoped project PM authority, exclusive development checkouts with queued writers, commit-pinned reads and safe worktree reclamation; workspace maintenance preserves review state.

## Release

Develop on `michael/<topic>` with exclusive use of the project development checkout; create an additional worktree only for parallel work or an independent version. Merge into `michael/main` before building.
Run only related tests, with commit/baseline-bound selection; never fall back to a full suite.
Use the managed build/cutover procedures in `/home/michael/services/README.md`: build integrity, DB backup/history, required isolated upgrade, owned cutover and readiness.
Preserve prior release for rollback and historical tasks/sessions; new dispatch is not a retry of old work.

- Native review recovery binds the current server-owned pending stage for recovery/Owner wakes that lack the original stage envelope; preserves status, run and reviewer checks.

- Cached PM review homes skip configured sibling repository synchronization; worker repository publication keeps its existing binding checks.

- PM permission audit follow-up: own-project comments, sessions/run diagnostics and
  captured worker output; Owner-authorized .env/source/task-workspace reads with
  nested-project isolation; formal delegated approval HTTP routing; execution-review
  generic mutation denial. Preserve shared-worker management and human gates.

### PM follow-through repair (2026-11-07)

The michael/pm-task-followthrough change adds durable five-minute PM tracking,
versioned continuation receipts, verified coordination-child authority, retained
non-Git Recovery reuse and runtime-specific worker delivery guidance. Release from
michael/main only, with additive migrations 0437/0438 and scoped related-test receipts.
Enable tracking after readiness for the five current PMs and register only explicitly
selected historical tasks. Keep completed/cancelled work and the prior release.

HOM-240 acceptance exposed a second preparation path: project-bound Recovery
copies resolved as task_session were validated against the current git_worktree
default before their saved project_primary restoration. Base validation now follows
the same persisted strategy as restoration, retaining drift diagnostics and current
admission/ownership checks. Assembled heartbeat regression preserves the original
delivery and workspace through provider execution; negative cases cover foreign
ownership, missing directories and Git-required workers. Scope is limited to
project-bound copies with matching ownership and the copy-only receipt; source-free
Retry retains its existing explicit Git, path and recovery validation. No migration is added.

HOM-236 acceptance exposed saved-review finalization after shutdown failure released
its execution lock. Finalizer-only recovery rechecks original failure/accepted-result
receipts, review scope, process stop, leases, pauses and successor absence under
transaction locks. Live tools retain strict execution-lock authority; formal review
effects and dependency wakes remain atomic and idempotent. No migration is added.

Postdeployment continuation exposed two further faults: active non-Git Recovery
anchors lost their local-path contract at Claude/Codex launch, and company-wide
watchdog updates under producer locks deadlocked native finalization. Retain the
verified anchor contract and append independent events in migration 0439; the
existing scheduler consumes them atomically with bounded, ordered watchdog updates.
Preserve original failed runs, pending finalizations and the original business tasks.

The ten-file related check found a stale recovery timing fixture: it rejected the
new event INSERT and lacked the locked-select chain, leaving synthetic retry debt.
Use real Drizzle query composition with explicit event/legacy-row execution doubles;
preserve idle/deadline invariants and the PostgreSQL event-consumption coverage.
Assert the watchdog's one-second event coalescing separately from other recovery
scopes' thirty-second reconstruction, without moving the existing lease deadline.
Keep the failed qualification receipt alongside the corrected scoped rerun.

The next scoped run exposed a separate timing assumption in the PostgreSQL
deadline test: pumping I/O advanced its fake clock before a fixed 298-second
jump. A controlled startup delay reproduces the early-call assertion failure.
Use the persisted absolute deadline across restart, retain drain/resume checks,
and verify both query and transaction silence after terminal settlement.

The stronger startup assertion then exposed cross-case work-signal state: a
deliberately rolled-back producer left uncertainty on the suite's shared client,
although its rows had been truncated. A two-case reproduction confirms the leak.
Give each test a fresh client owner and close it after joined cleanup; preserve
the production transaction-reconciliation path and the exact startup deadline.

HOM-240's next live continuation exposed a PM/worker preparation race: creating
the watchdog's PM home marked its borrowed active worker directory idle between
environment selection and binding validation. PM coordination no longer retires
that row. Preserve the original task, workspace and stop evidence; regressions
cover unchanged worker metadata and an assembled Claude continuation with PM
preparation interleaved before the canonical Recovery-directory recheck.

### Explicit PM source ownership (2026-11-08)

HOM-249 exposed an explicitly authorized source registered at the same physical
root by two projects. Permit that exact-root sharing within the company only
when the PM selects its own projectWorkspaceId; retain foreign nested roots,
cross-company registrations, issue privacy and inode/symlink checks. Definite
bridge read denials return a bounded scope error rather than a generic failure.
Keep worker write ownership and task recovery separate from read authorization.

### Per-PM compact instructions (2026-11-08)

`f3eb006cf6` adds Owner-selected `pmInstructionLayout=compact-v1`: AGENTS.md and
PROJECT.md are required per run, while MEMORY.md is optional. Tool schemas,
file permissions, read receipts, worker policy projection and session compatibility
follow that per-agent setting; unselected PMs keep the existing split layout.
The worker-policy API reports its actual documentPath and protects its generated
table. No model, connection, approval grant, service or database schema changes.
Switch michael only after external backups and idle/collection checks, using
native file/configuration CAS. Preserve history and never replay old work.
The layout-transition regression normalizes stored policy through the same schema
as the worker-policy API before rendering its target document.

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

### Mobile PDF return (2026-11-08)

Feature branch michael/mobile-pdf-return adds one local-state PDF preview dialog
across attachment entry points. Back restores the task/sheet, with separate raw
and download actions; browser Back remains normal navigation. The authenticated
PDF stream is bounded and validated before embedding, and URLs/reads are released
on close. See AGENTS.md and doc/DEVELOPING.md for the contract and device limits.
Publish from michael/main through the existing UI overlay after relevant UI
tests, typecheck, token gates and build; retain rollback assets. No backend,
schema, restart, worker retry or workspace-policy changes are part of this fix.

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

### Main agent workers (2026-11-08)

Feature branch michael/main-agent-workers lets a ccpocket_bridge main agent
(`role: main` with a project UUID) dispatch the Owner-configured shared workers.
The Owner saves the same v2 worker policy through `PUT /agents/:id/worker-policy`;
for main agents it renders as the `main-v1` "Worker 選用" table with option IDs in
PROJECT.md, between the managed worker-policy markers, which agent-side bundle
writes cannot change. A main agent's `POST /companies/:id/issues` that names a
worker option or a policy worker is checked like a PM dispatch: same project,
configured source selection, option expansion into worker/model overrides,
serialized shared workspace and a review stage back to the main agent. Other
issue creation by the main agent is unchanged. Without a saved policy nothing
changes. The main agent is not a zero-slot PM and gains no PM decision authority.
Commit `f92bdcc5b`. Released as a backend release (no schema change) after
related tests and a candidate smoke; b6ae191596-r1 is kept for rollback.

- Artifacts media filter (HOM-241, released by HOM-249): the company Artifacts API
  accepts an opt-in `mediaOnly` flag, enabled only by the Artifacts page. The filter
  runs in SQL so counts, pagination and grouping agree, keeps image/video/audio/PDF
  attachments and hides task documents, text/JSON/Markdown attachments and non-attachment
  work products. Stored records are unchanged and other listing callers keep their result.
  Feature commit `ffec9110d`, merged as `2bfd909f8`; no schema change; fc0350d9af-r1 is
  kept for rollback.
- Compass `[1m]` pricing (2026-11-09): main agents run `compass-opus5.5[1m]`, and the
  exact-match Compass rate card left those receipts unpriced. Claude Code strips the
  `[1m]` context-window suffix before the request reaches Compass, and Anthropic 5.5 has a
  single price tier, so an Anthropic Compass selector with a trailing `[1m]` now uses its
  base card and notes the 1M window in the evidence; the receipt model id is unchanged and
  OpenAI selectors stay exact-match. Feature commit `d3b28fea5`; no schema change.
  Receipts already recorded as unpriced are not repriced automatically.
- Coordinator starred agents (2026-11-09): project main agents use an ordinary role, so
  the Coordinator sidebar's Agents section (primary, `ceo` and `pm` only) never listed
  them. It now also lists agents the person starred, through the existing per-user
  agent membership stars; terminated, `process` and left agents stay hidden, the
  primary-first/alphabetical order and PM status rules are unchanged, and dispatch and
  roles are untouched. No schema change.
- Chat always interrupts (2026-11-09): in Agent Chat a message sent while the agent is
  working now stops that turn through the existing queued-comment interrupt (owner-only,
  `enableAgentChat`), so it is delivered next instead of waiting. Each chat message keeps
  its own saved receipt, so the queue stays interruptible once every later message is
  saved, and the interrupt's successor adopts all of the same user's still-deferred chat
  messages into one run (coalesced, never cancelled; other users' messages keep waiting).
  A CC Pocket bridge turn's acknowledged, unforced stop receipt now counts as stop proof
  for that explicit user turn when the historical and current adapters are both
  `ccpocket_bridge`; forced, failed or mismatched cases stay blocked. Tasks are unchanged.
  No schema change.
- Artifacts project folders (HOM-266, 2026-11-09): the Artifacts page opens on a
  Projects view, one folder per project plus a "No project" folder, built from the
  `mediaOnly` projection through the new opt-in `groupBy=project` grouping; opening a
  folder (`groupProjectId`, a project id or `none`) filters every source in SQL and pages
  by cursor, and archived or foreign projects return no folder. `mediaOnly` now also
  admits Office files (pptx/ppt/key/odp, docx/doc/odt, xlsx/xls/ods) by content type,
  using the extension only for generic types, so Markdown/JSON named like media stay out.
  The project page's Artifacts tab requests `mediaOnly` too, so task plans and notes no
  longer appear there. Task grouping stays in the Group by menu, and saved
  `?groupIssueId=` links still open their stack. Stored records are unchanged; no schema
  change.
- Artifacts chat project (HOM-265, 2026-11-09): agent chats carry no project, so their
  media fell into "No project". The artifacts listing now files an issue under
  `coalesce(issues.project_id, <the one active project led by its conversation agent>)`
  for project folders, the `projectId` filter (project page tab), the archived-project
  filter and each artifact's `project`. An explicit project wins; an agent leading none
  or several active projects stays under "No project". Read-only; no stored issue or
  project changes, no schema change.
- Remote Bridge shared workers (Shopee, 2026-11-10): a plain shared `ccpocket_bridge`
  worker whose `hostId` is another CC Pocket host runs in the project's `remote_managed`
  source registered on that host (`metadata.hostId`). Its shared-checkout claim keys on
  `ccpocket:<host>` plus the canonical registered path; the controller skips local
  filesystem, service, process and Git-dirty checks it cannot see, while writers on the
  same remote source still queue. Worker policies and the worker catalog accept such a
  worker only for projects with a source on the same host. No schema change.
- Failed bridge turn handoff (HOM-265, 2026-11-10): a `ccpocket_bridge` run the adapter
  reports as `failed` (for example a provider error after a failed context compaction)
  may leave its resident session working, and it has no stop record, so the next explicit
  user message was held forever with `process_identity_missing`. `bridgeSessionHandoffFor`
  now also admits a legacy `failed` run that has both session IDs and no
  `executionCancellation`, as a same-session handoff: the adapter waits for the session
  to settle before delivering. The failed run is not rewritten as acknowledged; a stop
  request on record (forced or not), missing IDs or adapter mismatches stay blocked.
  Nothing is replayed; no schema change.
- Never-started Bridge runs (AI_Video_Detection SHO-14, 2026-11-10): a legacy
  `ccpocket_bridge` run that failed with `session_start_failed`, `session_busy`,
  `session_not_found` or `adapter_error` before owning any session work (no process,
  no native session id, no `executionCancellation`, no Bridge session id except the
  vanished card named by `session_not_found`) counts as stopped for the next explicit
  user turn. `execution_uncertain` is excluded. The adapter still re-checks that the
  resident session is idle before delivery. No run is rewritten or replayed; no schema
  change.
- Chat preempts the main agent's task (2026-11-09): an owner Agent Chat message
  (`enableAgentChat`) that waits for capacity behind its own main agent's running turn on
  a different, ordinary task now gracefully interrupts that turn with the chat-interrupt
  stop semantics. `GET /issues/:id/queued-comments` reports `preemptibleRunId` only to the
  conversation owner, and the chat send interrupts that run instead of returning on
  "queued". The chat run carries a `paperclipChatPreemption` marker so the scheduler starts
  it first; after an acknowledged, unforced CC Pocket stop the task continues behind it
  through the existing task Retry receipt `chat-preempt:<runId>` (one per preempted run,
  never a replay). The task records an `issue.chat_preempted` activity receipt. Forced,
  failed or mismatched stops keep the existing blocked/hold behavior. Other users' messages,
  other agents' runs and same-issue chat behavior are unchanged. Main agents are also told
  to implement in chat and create tasks only when separate tracking is needed
  (`890f9672d`). No schema change.
- Bridge stop re-verification (2026-11-09): a cancelled, legacy `ccpocket_bridge` run whose
  unforced Stop stayed `requested` (the adapter could not confirm it at cancel time) blocked
  that task's queued messages with `process_identity_missing` forever. Adapters may now expose
  a read-only `reverifyCancelledRunStop` hook. Before a deferred-receipt sweep releases or
  promotes a held message, and after a remote-stop acknowledgement, the server asks it for
  `ccpocket.bridge-stop-reverification.v1` proof bound to this run and its recorded bridge and
  native sessions, with known and empty background work. Only that proof is persisted, through a
  compare-and-set on the exact requested cancellation (`proof: bridge_session_reverified`); the
  run status event is published afterwards. Unverified, timed-out, failed or mismatched checks
  keep the hold, forced or failed stops are never acknowledged, attempts are limited to one per
  run per minute, and nothing is replayed (`30a30590e`). No schema change.
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
- Bridge interrupt handoff (2026-11-09): an explicit Agent Chat message that interrupts a
  `ccpocket_bridge` turn whose unforced Stop stayed `requested` (the Bridge had not returned
  the turn's result within the adapter's 30-second window) no longer waits for stop proof.
  When both the historical and current adapters are `ccpocket_bridge` and the run records
  its bridge and native session IDs, explicit continuation admits it as a same-session
  handoff (`continuation.bridgeSessionHandoff`, only for the latest previous run). The
  adapter re-interrupts that session, waits for the old turn to settle within its own run
  timeout and delivers the message in the same session. When the successor finishes, a
  valid `resultJson.bridgeHandoff.proof` (`ccpocket.bridge-stop-reverification.v1`)
  acknowledges the predecessor through the same compare-and-set as re-verification
  (`proof: bridge_handoff_settled`). Without that proof the predecessor stays `requested`.
  Forced stops, missing session IDs, adapter mismatches and automatic recovery remain
  blocked, and nothing is replayed (`4dbb3aadf`). No schema change.
- Deferred sweep re-check (2026-11-09): stuck interrupt messages were only re-processed after an
  unrelated write, because the deferred receipt worker drops an entry after one resume pass and
  only reconstructs on startup or a committed notification (its 30-second interval throttles;
  it never polls). Interrupt receipts whose legacy run was cancelled now wait the same 30s
  `updatedAt` grace as the owner-only interrupt resume instead of being checked inside it; a
  receipt held by a cancelled `ccpocket_bridge` run whose unforced stop is still `requested`
  is re-checked on a 30s-doubling backoff capped at 10 minutes (that gate opens only on
  external Bridge evidence); and acknowledging a bridge stop notifies deferred receipts in the
  same transaction. All other closed gates stay notification-driven and idle-quiet. Nothing is
  replayed and no stop proof is synthesized (`4198469a5`). No schema change.
  Addendum (`6b300f0c2`): Drizzle renders column references in a select-field `sql` template
  unqualified, so the `interruptedLegacy` subquery bound its `id`/`company_id`/`agent_id` to
  `heartbeat_runs` itself and the flag was always false; the outer `agent_wakeup_requests` row is
  now named explicitly. The pending re-arm read runs only for receipts whose owner-only interrupt
  cancelled a legacy run, so ordinary saved backlog rows skip it; and the invalidated-backlog
  Retry test's `scheduled_retry` wait uses a 15s deadline (its first attempt joins worker passes
  settling the saved backlog, which the 1s default could not cover).
- Antigravity shared worker (2026-11-09): worker policies admit a third harness, `ccpocket_bridge`,
  only for a plain CC Pocket Antigravity shared worker (provider `antigravity`, no main role,
  project_pm binding or Bridge worker preset). Its catalog lists the host's Antigravity models,
  rejects AI connections and offers Default or explicit Full access; dispatch, diagnostics and save
  re-checks fail an agent that stops being eligible. Policies hold up to three workers
  (`64a101064`). No schema change.
- Remote-host main agents (2026-11-10, Shopee): a fixed workspace binding may name a `hostId`
  for a CC Pocket main agent on a non-shared host (`60ceedfb9`). The run keeps the Local
  execution environment and never stats the remote cwd on the controller (its local cwd is the
  agent home); the binding requires a `remote_managed` project workspace with the same canonical
  path, the local driver, and a `ccpocket_bridge` adapter whose `adapterConfig.hostId` matches.
  Agents without `hostId` are unchanged. No schema change.

- Native session bridge pilot (michael/session-bridge, 2026-11-10): scoped non-run
  keys, durable bidirectional conversation receipts, approved worker MCP dispatch
  and assigned connector gateway calls. Additive JSON/text contracts, no migration.
  See doc/plans/2026-11-10-session-bridge-key-scope.md. Release from michael/main;
  preserve the previous release and verify only related tests.
