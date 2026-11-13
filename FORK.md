# Paperclip fork

Dashboard subscription quota sources are company-scoped operator configuration:
Shopee uses shopee-e through a finite SSH collector. Credentials remain remote;
cache keys include company and source, without local fallback. See doc/DEVELOPING.md.

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
- liveness-first (branch `michael/liveness-first`, Owner 2026-11-13; binding source `/home/michael/services/docs/agents/liveness-first.md`): single failure classifier (transient backoff 30s×2ⁿ capped at 30 min, deterministic notify-once, unknown→3 retries); last-writer-wins Bridge session authority (generation+1, `takeoverFrom`); removal of stop settlement, workspace holders, shared-checkout claims, workspace binding, host inspection and execution-reconciliation gates (workspace = directory with `mkdir -p`); per-host circuit breaker; 30/35 min inactivity fallback; shutdown/startup `process_lost`; `paperclip ops liveness-reset` CLI; docs; automatic transient retries re-carry their source run's comment input (2e5002e72f). Released as a5edd4056-r2 then 6106df83a-r1 under the Owner waiver 「一次全上，免驗證」; receipts in /home/michael/artifacts/liveness-first-20261113
  Commits: 53c1616a33 (WIP snapshot: classifier, gates, shutdown, docs), 5f5df1bfd4 (classification-driven retries and backoff),
  22738ede57 (liveness-reset service and CLI), 42205503bd (last-writer-wins session authority), 889d27e32e (shutdown marking,
  process-loss resend), 0886b8c497 (adapter 0.5.0 codes), 360318e5b6 (35 min inactivity fallback), 082787a058, 72b66c6c53,
  f8c6f832dd, 63d74fb700 (terminal releases every gate, abandon unknown priors), 9a7dd08744, 86932dd82f, c7a4743d3b,
  760f585562 (workspace = directory), d67e998d07 (workspace repair backoff, Retry placement); this list is updated by the
  commit that adds it.

## Release

Shopee shared worker consolidation adds opt-in per-host Bridge worker capacity,
host-scoped discovery, and immutable task routes; implementation history is on
`michael/shopee-shared-workers` for review; it is not deployed. Existing fixed workers
and Bridge task/session identities remain unchanged (docs/agents/pm-agents.md).

Develop on `michael/<topic>` with exclusive use of the project development checkout; create an additional worktree only for parallel work or an independent version. Merge into `michael/main` before building.
Run only related tests, with commit/baseline-bound selection; never fall back to a full suite.
Use the managed build/cutover procedures in `/home/michael/services/README.md`: build integrity, DB backup/history, required isolated upgrade, owned cutover and readiness.
Preserve prior release for rollback and historical tasks/sessions; new dispatch is not a retry of old work, but runs interrupted by cutover (preempt-restart, no idle-fleet quiescence) are resent under liveness-first rule 1.

# Moved details (read the file when the task touches the topic)

Liveness-first (`/home/michael/services/docs/agents/liveness-first.md`) supersedes the execution gates, stop proof, never-replay and Owner-escalation rules in the workspace, Bridge lifecycle, retry/recovery and PM/main-agent files below; their feature descriptions remain.

- `docs/fork/workspace-git-admission.md` — Git workspace registration, shared worktree admission, fixed directories, placement
- `docs/fork/bridge-run-lifecycle.md` — Bridge stop settlement/proof, interrupt handoff, resident authority, chat preemption
- `docs/fork/retry-and-recovery.md` — Retry/recovery authority, creator/original-main notices, supersession rules
- `docs/fork/pm-and-main-agents.md` — PM and main-agent features: follow-through, instructions, workers, dispatch, permissions
- `docs/fork/sidebar-and-live-panels.md` — Sidebar status, live work panels, worker/subagent cards, mobile task panel
- `docs/fork/artifacts-and-mobile.md` — Artifacts page filters/folders/preview and mobile PDF return
- `docs/fork/session-bridge-and-dashboard.md` — Session bridge, host subscription dashboard, Compass pricing, capability inventory

### 2026-11-13 — Antigravity CLI workers

- Port upstream PR #21121 at 46b4510cae7d7dbbb73df5ce1c147c96fa73a45a (joshuacox).
- Register agy_local, connection setup and the fork's main/shared-worker policy.
  Preserve Bridge agents and sessions. Shared CLI workers use subscriptions only;
  all CLI invocations disable paid extra credits. Additive provider constraints.
- Branch: michael/agy-cli-integration. Release only from michael/main through the
  managed workflow after merge. No production rollout is part of this PR.
