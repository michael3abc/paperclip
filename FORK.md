# Paperclip fork

HOM-458 (michael/main-context-compact): server-owned idle context-maintenance policy
for ccpocket_bridge main Chats, default 150K / 0 off. Requires the paired CC Pocket
adapter/Bridge commit. No migration, deployment or restart; see docs/agents/session-bridge.md.

`michael3abc/paperclip` is a personal fork of
[paperclipai/paperclip](https://github.com/paperclipai/paperclip). It runs one
maintainer's agent company. The release line is `michael/main`. If you only want
Paperclip, use upstream; this fork is useful if you want the features below.
Terms such as Owner, HOM-123, CC Pocket and `/home/michael` paths are explained
in [docs/fork/host-operations.md](docs/fork/host-operations.md).

## Feature overview

| Area | What the fork adds | Read | Needs outside this repo |
| --- | --- | --- | --- |
| Native sessions | Agents run as resident Claude Code / Codex sessions; Chat input steers the live turn; native questions appear as Chat cards | `docs/agents/session-bridge.md`, `docs/fork/bridge-run-lifecycle.md` | CC Pocket Bridge and adapter |
| Project main and PM agents | One main agent per project, zero-slot PMs, shared Claude/Codex workers with a per-project worker table, main continuation of worker tasks, delegated decisions, `@agent` mentions that create subtasks | `docs/agents/pm-agents.md`, `docs/agents/decisions-and-review.md`, `docs/fork/pm-and-main-agents.md` | CC Pocket for native mains and Bridge workers; mention subtasks and decision routing are server-only |
| Liveness-first execution | One failure classifier, unlimited transient retry with backoff, 30-minute inactivity timeout, per-host circuit breaker, workspace = directory, `paperclip ops liveness-reset` | `docs/agents/execution-semantics.md`, `docs/agents/workspace-admission.md`, `docs/fork/retry-and-recovery.md` | None |
| Worktree API | Main agents create, merge and retire Git worktrees from observed Git state | `docs/agents/worktree-observed-state.md` | CC Pocket adapter (shared `@paperclipai/adapter-utils` peer) |
| Agent Chat and sidebar UI | TODO tab, project main status in the sidebar, live work and worker cards, chat pins, `/plan`, orange `pending` for Owner decisions, touch-keyboard Return | `docs/agents/ui-features.md`, `docs/fork/sidebar-and-live-panels.md` | TODO content comes from the CC Pocket adapter; the rest is UI-only |
| Artifacts | Company Artifacts page, media sync from run workspaces, image zoom, mobile PDF return | `docs/fork/artifacts-and-mobile.md` | None |
| Local voice | Voice calls into an agent Chat; small talk answered by Realtime, work forwarded to the main agent | `doc/connections/LOCAL-VOICE.md` | OpenAI or Gemini Realtime credentials; off by default |
| Dashboard | Host Claude/Codex subscription quotas, host Claude sign-in, project usage, Compass rate card | `doc/DEVELOPING.md`, `doc/connections/AI-CONNECTIONS.md`, `docs/fork/session-bridge-and-dashboard.md` | CC Pocket host registry and SSH hosts; Compass gateway for its pricing |
| Connections | Custom MCP browser sign-in, approval cards for Test-path calls, 60 s Test-path budget | `doc/connections/GENERIC-REMOTE-MCP.md` | A browser-login companion for the MCP server |
| Antigravity CLI workers | `agy_local` adapter (upstream PR #21121) with subscription-only shared workers | `docs/adapters/agy-local.md` | Antigravity CLI subscription |

The sections below are the maintainer's change log: upstream sync records, then
one entry per custom branch with the Owner's decision.

Dashboard subscription quota sources are company-scoped operator configuration:
Shopee uses shopee-e through a finite SSH collector. Credentials remain remote;
cache keys include company and source, without local fallback. See doc/DEVELOPING.md.

Upstream reference: `upstream/master` (fetch-only). Recorded upstream tip: `9502a12252208d314f61a23c30589b9f31dc82f2` (2026-11-25 integration; not deployed). Previous sync base: `ff68490d03601cdced37e21d919affb079fafc61`.
The local release line is `michael/main`; previous releases and consolidation merges remain ancestors.

## 2026-11-25 upstream merge (HOM-604; not deployed)

Integrate 64 upstream commits through `9502a12252208d314f61a23c30589b9f31dc82f2`
on HOM-562 `ea2bf05a9e`. Retain upstream 0500–0505; move fork SQL to
0506–0518 with identical bytes and journal timestamps. Owned empty/main/HOM-562
migration paths pass (517 / 511→517 / 514→517), fork replay 0. Keep 31 fork UI
regression suites; accept three fixture-only deletions. Preserve liveness-first,
main Chat Native plan, chatPinned and project pinning together. Decisions:
[sync-decisions](/HOM/issues/HOM-604#document-sync-decisions).
Wednesday integration only; no deployment, restart or merge into michael/main.

## 2026-11-24 upstream merge (HOM-562; not deployed)

Integrate 80 upstream commits through `ff68490d03`. Retain upstream migrations
0500–0502 and renumber fork SQL 0500–0512 to 0503–0515 with identical bytes and
original journal timestamps. Rebuild the combined snapshot from Drizzle schema.
An owned empty database migrates successfully; an owned `cc06f5e1a7` database
applies only the three upstream migrations (511 to 514 history rows).
Upstream 0500 requires staging: Sunday release needs T4, a production-clone
upgrade and confirmation that local Areas & Responsibilities has no active writers.
Antigravity ACP uses upstream 1.5.2 with Linux executable/helper admission and
fork browser paste-back. Preserve delegated external-write review alongside
human direct-review policy, and retain fork Retry and agent-binding behavior.
Decisions and verification: [sync-decisions](/HOM/issues/HOM-562#document-sync-decisions).
Tuesday integration only; no deployment or restart.

## 2026-11-21 upstream merge (HOM-460; not deployed)

Merge 52 upstream commits through `2898acee`; preserve fork failure classification,
host circuit outcomes and workspace policy. Exclude the new Chat retry stop-wait
poller under liveness-first; classify sandbox disk exhaustion as deterministic.
No DB or migration changes. Decisions and checks:
[sync-decisions](/HOM/issues/HOM-460#document-sync-decisions). Saturday integration
only; no release build, deployment or restart.
2026-11-23 validation repair: unify both disk-full aliases and permanent interaction
delivery denial; retain liveness-first admission and verified pre-dispatch Retry,
with the original saved snapshot intact when the successor needs a fresh attempt.
Final validation: 185 residual failures match main's actual assertions; recovery
120/120 passes after joining background wakes before fixture cleanup. Source
build, low-memory typecheck, token gates and MCP 18/18 pass; no deployment.

## 2026-11-20 upstream merge (HOM-421; not deployed)

Upstream tip `806440d12cf3cc5b6e28f546a5e0f4fb625df48c`; 16 upstream commits
since `1355f935`. Preserve upstream admission hooks with fork liveness-first,
conversation ownership, workspace/main validation and durable handoffs. Upstream
`0499_numerous_whizzer.sql` stays byte-identical; twelve fork SQL files move
0499–0510 to 0500–0511 with unchanged SHA-256 and journal timestamps.
The merged journal has 510 entries. Decisions and verification:
[sync-decisions](/HOM/issues/HOM-421#document-sync-decisions).
Friday integration only; no deployment, release ID or restart. Production clone
upgrade and release-tool reconciliation remain part of the Sunday deployment.

| Published fork file | Merged file |
| --- | --- |
| `0499_productive_changeling.sql` | `0500_productive_changeling.sql` |
| `0500_ambitious_the_order.sql` | `0501_ambitious_the_order.sql` |
| `0501_sturdy_maestro.sql` | `0502_sturdy_maestro.sql` |
| `0502_giant_thunderbird.sql` | `0503_giant_thunderbird.sql` |
| `0503_woozy_blizzard.sql` | `0504_woozy_blizzard.sql` |
| `0504_sparkling_puma.sql` | `0505_sparkling_puma.sql` |
| `0505_curved_luckman.sql` | `0506_curved_luckman.sql` |
| `0506_cloudy_dark_phoenix.sql` | `0507_cloudy_dark_phoenix.sql` |
| `0507_fine_leper_queen.sql` | `0508_fine_leper_queen.sql` |
| `0508_robust_ironclad.sql` | `0509_robust_ironclad.sql` |
| `0509_loose_masque.sql` | `0510_loose_masque.sql` |
| `0510_square_doorman.sql` | `0511_square_doorman.sql` |

## 2026-11-19 upstream merge (HOM-415; not deployed)

Upstream tip `1355f93546b44017bdf71212c437ae7a57f8b5e7`; 62 upstream commits
since `8282d386`. Keep upstream wake-queue admission ownership while preserving
fork liveness-first, Bridge steering, PM policy and saved-input receipts.
Decisions and verification: [sync-decisions](/HOM/issues/HOM-415#document-sync-decisions).
Thursday integration only; no deployment or restart.

## 2026-11-18 upstream merge (HOM-396; deployed 2026-11-19)

Merge upstream tip 8282d386da5a36ae2c4d8846f227c3d26e2b4049 into the
92b9f2a7cf980cacd38bf18f1989b83eb4cd450e fork history, retaining custom
behavior and the original commit graph. Initial conflicts: 233 files. Decisions
and measured checks: [sync-decisions](/HOM/issues/HOM-396#document-sync-decisions).
Deployed from michael/main commit 279a18c3a45825480669f0df04c1af51512b7fda
as 279a18c3a-r1 on 2026-11-19 at 13:01 UTC, replacing 3f6eed15d-r1.
The retained baseline remains the release-only rollback target; no DB restore
is required. Deployment preimages and receipts remain in the HOM-396 artifacts.

Upstream 0432–0498 stays unchanged. Fork migration SQL bytes and hashes stay
unchanged, so the published hash-only migration history recognizes them after
renumbering. The merged journal has 509 entries; a reconciled baseline has
442 applied entries, leaving 67 upstream migrations. Both histories were reviewed
and proved on an isolated production DB clone before the production upgrade.
The source-candidate clone applied those 67 migrations once (442 to 509),
recognized all twelve fork hashes, and preserved the original data under the
documented lifecycle-default transformation. The retained a614a7c5a-r1 passed
isolated boot/health, project and session reads on the upgraded clone. Receipts
and verifier corrections are in sync-decisions. Project main approved T4 deployment
conditionally on 2026-11-19; the Owner then moved deployment to immediate execution.
The fresh sealed clone and production both upgraded 442 to 509 with the twelve
fork hashes retained. Main-only low-memory typecheck/build, closure verification,
13 candidate smoke checks, service health and startupRecovery readiness passed.
The two preempted tasks resumed with observed successors and no unresolved entries.
Deployment config and the active adapter-utils peer point to 279a18c3a-r1.
Related-test results remain attributed to their original commits and targeted
fix-forward runs (including MCP 18 and Runner 250); no full suite or post-deploy
rerun was performed. RELEASE.json retains pending-related-tests preparation
metadata rather than claiming a fresh final-tree suite pass.
The follow-up merge includes main 2ced42e393 and preserves both manual
context-compaction and trusted delegated-decision conversation wake causes.

Integration follow-ups retain the selected project source when creating or
reassigning a cooperative task, remove local Git-copy admission locks, break a
dispatch/recovery initialization cycle, and keep PRP control replies responsive
during replay while retaining hard queue bounds. Test fixtures track the actual
CLI startup, monitor, workspace API and liveness-first retry contracts.
The subsequent main-line merge b71e7abf13 includes d29db6287a and retains
attention-read authorization and privacy boundaries. Restart recovery keeps
the durable transient backoff counter; a persisted bootstrap certificate keeps
preparation retries separate after terminal settlement clears execution stage.
Only interruption/process-loss/controller-loss certificates select that lane;
ordinary bootstrap failures retain charged transient retries and provider deadlines.
Terminal queue regressions preserve original cleanup/recovery/input evidence while
allowing new input; stranded review recovery hands the participant run to the
durable retry scheduler. Tests retain the operator Stop and authority boundaries.
Historical provider evidence does not hold a distinct authorized human input.
Human Chat wakes also validate the requester against the conversation owner
before persisting a run or wake; saved owner messages cannot lend authority.
Stranded-message recovery releases terminal native sources without waiting for
committed finalization; original failed/unfinished records remain unchanged.
Preparation-only workspace reuse recognizes the host retry-exhaustion event
with matching failure classification and durable accounting; provider evidence
and invalid promotion timing still reject that certificate.
Failed validation receipts and baseline-comparison limitations remain recorded
in sync-decisions; these fixes do not certify every historical test as passing.

| Published fork file | Merged file |
| --- | --- |
| `0432_productive_changeling.sql` | `0499_productive_changeling.sql` |
| `0433_ambitious_the_order.sql` | `0500_ambitious_the_order.sql` |
| `0434_sturdy_maestro.sql` | `0501_sturdy_maestro.sql` |
| `0435_giant_thunderbird.sql` | `0502_giant_thunderbird.sql` |
| `0436_woozy_blizzard.sql` | `0503_woozy_blizzard.sql` |
| `0437_sparkling_puma.sql` | `0504_sparkling_puma.sql` |
| `0438_curved_luckman.sql` | `0505_curved_luckman.sql` |
| `0439_cloudy_dark_phoenix.sql` | `0506_cloudy_dark_phoenix.sql` |
| `0440_fine_leper_queen.sql` | `0507_fine_leper_queen.sql` |
| `0441_robust_ironclad.sql` | `0508_robust_ironclad.sql` |
| `0442_loose_masque.sql` | `0509_loose_masque.sql` |
| `0443_square_doorman.sql` | `0510_square_doorman.sql` |

## Custom history

- HOM-543 (`michael/lrh-completion-wake`, server HOM-544): additive `0512`
  `issue_external_waits`, assignee/board APIs and one completion wake through
  ordinary heartbeat admission. Outstanding LRH waits are durable recovery and
  run-end dispositions; busy completion wakes remain queued. Agent monitor
  scheduling stays disabled under HOM-539. No deployment or main-branch merge.

- Dashboard host Codex sign-in (`michael/host-codex-login`, HOM-471): the Codex
  quota card offers human-only instance-admin device authorization for explicitly
  logged-out company hosts. Registry `codexLogin` pins the native CLI and home;
  users open OpenAI's device page and enter the displayed copyable code. A bounded
  ten-minute session verifies native ChatGPT login before refreshing quotas.
  Commands and credentials stay on the configured host; device URLs/codes and CLI
  diagnostics are never persisted or logged. Includes service, route, redaction,
  OpenAPI coverage and UI regressions; no schema or dependency change.

- Empty `.git` placeholder (`michael/hom428-empty-git-placeholder`, HOM-428): an empty `.git` directory left by a
  sandbox mount point is treated like the info/exclude-only placeholder, so it no longer fails run preparation with
  `workspace_git_source_unproven`. Server only (`server/src/services/workspace-git-source-roots.ts`).

- Google subscription on Linux (`michael/antigravity-linux`, HOM-480/HOM-485): Connect Google sign-in and Antigravity agent sessions on
  linux-x64, pinned to the official `agy-acp-server-1.4.3-linux-x86_64.zip`, with a Linux admission twin (`/proc/self/exe` plus the Linux
  helper digest) and a remote-browser paste-back of the loopback redirect. macOS admission bytes and pins unchanged. No schema change.

- Sidebar working for running subagents (`michael/subagent-working-status`, HOM-484, Owner 2026-11-21 「有 subagent 在跑的時候也要顯示 working」):
  the Agent Chat list adds `hasRunningSubagents`/`runningSubagentsUntil`, derived from background subagent events in the chat's latest
  succeeded run log (bounded to 30 minutes, cleared when the next run starts); the sidebar shows the existing blue `working`. No schema change.

- Agent TODO tab (`michael/todo-panel`, Owner 2026-11-19 「放這邊加一個 TODO」, 「最多 3 項，而且只顯示 6 小時內完成的」,
  「可以在待辦那邊加上一個 cancel，s.t. 讓 main 去取消這個 task」, 「介面好看一點，不要只用 .md 渲染」): the task side panel's
  launcher offers a `TODO` tab (always in an agent chat, on a task once it has one). It reads the conversation's
  `todo` issue document, which the CC Pocket adapter stores as JSONL records (`ui/src/lib/todo-document.ts` has the
  format), and shows the goal with progress, Owner matters, open items with the live status of their linked tasks,
  and finished items (at most 3 from the last 6 hours; older ones collapsed). Cancel posts a comment asking the agent
  to cancel that item; the UI never cancels a task. The `todo` document is hidden from the generic document lists.
  The task page's full Documents section (which also shows `plan`) renders a JSONL `todo` as a read-only checklist
  and offers no markdown edit, because issue documents only have the `markdown` format and the adapter stores the
  JSONL under it (Owner 2026-11-19 「為啥現在todo是jsonl然後用md存」, HOM-411). A markdown TODO stays editable.
  Frontend only (`ui/src`); no server, schema or dependency change.

- Delegated decision delivery and unchanged-model saves (`michael/delegated-wake-delivery`, Owner 2026-11-19
  「好，一次發布」): the delegation sweep can wake an idle (waiting) main Chat; dropped deliveries retry with
  liveness-first backoff instead of stopping at `delegate_wake_not_admitted`, so pending legacy failures are
  redelivered once. Agent updates no longer re-validate an unchanged company-catalog model, so a host that stops
  advertising it (Shopee `opus` → `opus[1m]`) does not block secret or permission edits. Server-only, no migration.

- Main agents read Owner attention (`michael/main-attention-read`, Owner 2026-11-19 「1.」 approving agent reads of
  the pending list): an agent with an explicit `inbox:manage` grant may read `GET /attention`, `/attention/summary`
  and `/attention/tasks` for its run's responsible user only, if that user's inbox agent policy admits it. Results
  keep the agent's task-read privacy; history and every decide/dismiss/triage route stay board-only.
  Server-only, no migration.

- Host Claude login (`michael/host-claude-login`): Dashboard administrators can
  sign into logged-out company hosts inside the Claude quota card, restoring
  normal quota content on success. Company-enrolled local/SSH hosts use native Claude
  browser authorization and code submission. Native host credentials remain
  on their host; one bounded session per host, scoped to company and user.
  No migration or new dependency. See doc/DEVELOPING.md.

- Pending request lifecycle (`michael/pending-request-lifecycle`, HOM-394): an
  authorized explicit cancellation abandons review without a rejection or worker
  wake. Task-scoped obsolete AI authentication cards formally expire on canonical
  reads, including blocked tasks, without accepting/granting/resuming anything.
  Matching missing-auth requests, real questions and tool permission gates remain.
  Server-only, no migration.

- Worker steer and sidebar pending (`michael/worker-steer-pending`, HOM-381/HOM-391): project-main
  comments to an active worker default to its current turn, preserving explicit queue, idle and direct-input
  receipts. Owner-actionable plan/approval requests show orange `pending` ahead of working/waiting.
  Paired ccpocket adapter required for plain Codex worker steering; Claude main Chat steering is retained.
  No migration or new dependency. See docs/agents/session-bridge.md and docs/agents/ui-features.md.
- Claude Chat steering (`michael/claude-chat-steering`, Owner 2026-11-18 「幫我改 設一個時間（例如 5 分鐘），超過就自動改成打斷」):
  a ccpocket Bridge main-agent Chat run with provider `claude` (or a `/claude/` model) uses the same Bridge
  chat-steering receipt path as Codex. The Bridge (`paperclip_claude_steer_v1`) delivers the supplement into the
  live turn, and Claude absorbs it at its next tool boundary; an input still unabsorbed after 5 minutes interrupts
  the turn once. Bridges without the capability answer `unsupported`. Server-only, no migration.
- Mention subtasks (`michael/mention-subtasks`, Owner 2026-11-18 「改成 @ 表示 系統自動開一個連到原任務的子任務指派給它，
  內容是你那則留言；它做完後把結果回貼到原任務。這樣 @ 就有實際作用，又不會兩個 agent 搶同一個任務。」): a board user's own
  comment (standalone, issue update, client retry or queued-comment edit) that mentions an active agent of the company
  other than the task's assignee creates one child task per agent (same project, `todo`, assigned to it,
  `originKind=mention_subtask`, `originId=<commentId>:<agentId>`) carrying the full comment, a link back and the
  instruction to answer in a final comment and mark it done; the normal assignment wake starts it. When the child is
  done, the `mention-subtask-results` delivery queue posts the child assignee's last comment (4000 characters, link when
  truncated) on the parent as that agent and wakes the parent's assignee like any other author's comment; it waits up to
  40 minutes for the child's running run so a reply written after the status change is kept. A cancelled child gets a
  short system note without a wake. Idempotent per (comment, agent) by advisory lock and origin, and per child by the
  parent comment's clientRequestId. Agent/run comments, the assignee and paused/terminated/pending/unknown agents are
  skipped; failures never fail the comment. Upstream 2de43fc909's rules hold: the mentioned agent never runs on the
  original task and each task keeps one assignee. Server-only, no migration.
- Main task continuation with protections (`michael/main-continue-relaxed`, Owner 2026-11-16 「我覺得 B 不錯」):
  any current run of the project's lead main may continue its worker's task with its own nonempty handoff
  comment and an idempotency key. Done and worker/system-cancelled tasks reopen; Owner-cancelled tasks,
  paused/archived projects, Owner main pauses/holds, Agent Chat issues and newer human task comments still
  refuse. Pinned worker models are kept (optional same-worker workerSelectionId); observations are advisory;
  continuationCount on receipts and the issue detail. Server/shared source, no migration; released with a T4 change.
- Continuation retry admission (`michael/continuation-retry-claim`, Owner 2026-11-17 「要修這個 bug」):
  a transient retry of a continued worker run (any depth) is admitted at claim through its durable
  retry_of_run_id chain (same company, agent and task) back to the run the `issue-continue:` wake
  admitted for the same continuationReceiptId; the Owner-control recheck still runs against that run
  (Owner stop, lead change, main pause/hold, project pause, assignee change, task closed again). Runs
  outside the chain cannot borrow a copied receipt. Release recovery (`issue_continuation_needed`) keeps
  its fresh context without the receipt. Fixes SHO-74/SHO-66 retries cancelled `queued_run_claim_rejected`.
  Server-only, no migration.
- Shared home directory repositories (`michael/shared-home-repositories`, Owner 2026-11-18 「你先人工處理一下這個」
  on HOM-377, where every michael follow-up run failed at setup): a shared local workspace (mode
  `shared_workspace`, provider `local_fs`) whose directory has only an ignore-only `.git` (no HEAD) is a plain directory, so sibling project repositories are
  no longer copied into it; workspace hints keep their own cwd. A home directory with an ignore-only `~/.git`
  plus a sibling project workspace with a repository URL made `git rev-parse --git-path info/exclude` fail every
  run. Server-only, no migration.
- Touch keyboard Return (`michael/touch-enter-newline`, Owner 2026-11-17 「我現在ios pwa按那個 回車會直接送出而不是換行
  幫我改一下」): on touch-primary devices (`(hover: none) and (pointer: coarse)`, e.g. the iOS PWA) chat Enter-to-send
  is off, so Return inserts a new line; the send button and Cmd/Ctrl+Enter still send. Hardware keyboards are
  unchanged. UI only.
- Test-path call budget (`michael/test-call-timeout`, Owner 2026-11-17 「啊這個又怎麼了」 on the 104 resume
  dry run that timed out): connection Test-path calls, which agents use for connected apps and which run
  approved Ask-first calls with no caller left, take the 60 s gateway cap instead of the 10 s interactive
  default (provider budgets such as Railway still apply). The completion event records `timeoutMs`.
  Server-only, no migration.
- Dashboard project usage (`michael/project-cost-usage`): same-period project
  token breakdown and recorded spend below the model charts, retaining
  Unattributed and separating subscription estimates/fees. UI-only overlay.

- Custom MCP browser sign-in (`michael/connector-ui-login`): human-only, vault-backed
  companion requests and an Apps login panel for the 104 browser and SeaTalk QR.
  Preserves grants, tools and company scope; no login material in tool receipts.

- Connector browser voice boundary (`michael/connector-local-voice`): internal
  `local_voice` endpoints stay in the shared API/cache but do not enter external
  connector sorting, setup or agent Channels. UI-only; preserves Voice bindings.
- Caller-delivered question answers: `continuationPolicy: none` saves the response
  without a competing continuation; Runner requests with `runtimeRequestId` retain
  durable native delivery. Paired with Bridge Agent Chat native question cards.

- Observed-state worktree API (Owner 2026-11-16 「好，做 2」; `469123df63`, `0af37f4d18`, `2d0ebc88a2`):
  main-managed worktree create/merge/retire/initialize decide from the tree's observed Git state and are
  idempotent; host receipts and `workspace_operations` rows are audit only. Create makes a missing parent
  below a real directory; retire skips unreadable processes and still never force-removes or deletes dirty
  files (ignored files are archived first); Git output is uncapped; git/tar 10 minutes each. A pending
  operation is superseded by the next one, generation is advisory, host refusals are 409 with the host code.
  No migration. Changes the `@paperclipai/adapter-utils` peer (T4); pair with ccpocket adapter
  `michael/worktree-observed-state` (30-minute worktree SSH cap). Stale pre-liveness-first assertions in
  three workspace suites were rewritten. See `docs/agents/worktree-observed-state.md`.
- Main dispatch without forced review; completion replies count (Owner 2026-11-16 「開始 1~3」): a main's
  dispatched worker task no longer gets an automatic main review stage (the main may still add one); a succeeded
  completion turn that answered in its conversation through a plain comment counts as the delivered completion
  reply, so the main is not re-woken every minute for the same task. Server-only.
- Release cutover backup bound (2026-11-16): the operator API helper used by release cutovers
  allows 15 minutes for the production database backup (it now exceeds 120 s); other calls keep
  120 s. Ops script only.
- Shared Bridge worker model change (Owner 2026-11-16 「阿為啥他沒有被切到 compass?」): a task
  pinned to a shared worker route keeps its host and provider, but its model may change on the
  same host/provider (for example to the auto-rotating `family:` route); retries re-pin the new
  model instead of failing with BRIDGE_WORKER_ROUTE_CHANGED. Server-only.
- Codex main Chat direct steering: freeze the effective Bridge dispatch's
  routing identity before invocation; Enter immediately delivers to the original
  native turn and waits for acknowledgement, including a stale browser run cache.
  Keep other harnesses' delivery behavior, original receipts and failure evidence.
- Compass rate card `compass-official-2026-11-16` (Owner 2026-11-16 「跟 compass 計費」):
  official list prices for compass-6.1-terra, compass-6-luna, compass-fable5.2,
  compass-fable5 and compass-opus5; existing rates unchanged. Server-only.
- Native subagent hint (Owner 2026-11-16 「C. 指定 subagent 用的模型，s.t. 會自動匯入我 worker 那邊設定的」):
  a CC Pocket main agent's worker settings say what its native subagents use with the
  selected default (the default's model when it runs on the main's harness, otherwise the
  main's own model). The setting itself is applied by the CC Pocket adapter/Bridge
  (`subagent_settings_v1`). UI-only overlay.

- `/plan` command (Owner 2026-11-16): in main-agent Agent Chat, `/plan` alone
  switches the composer to Native plan; `/plan <text>` sends the text as a Native
  plan turn. Elsewhere `/plan` stays ordinary text. UI-only overlay.

- Shared voice preference (HOM-265): one browser-local timbre for all agents,
  configured only on the Voice page; Chat call cards consume it without a picker.
  Changes apply to subsequent calls, including across tabs. UI-only overlay.

- Natural voice conversation (HOM-265): new calls let Realtime answer small talk
  immediately and forward work using current-turn tokens and original text.
  Verified main-answer playback and voice authorization restrictions remain.
  No migration; existing calls retain their policy.


- Main-agent voice answers (HOM-335): new agent_chat calls pin `main_answer_v1`;
  OpenAI and Gemini carry speech while the original main Chat supplies substantive
  answers. Explicit source-operation declarations are verified against scoped
  input comments and the fixed dispatch/steering boundary, then saved per answer.
  Turn-based waiting, playback deduplication, interruption and explicit replay
  preserve agent work and existing calls. No migration; see
  `doc/connections/LOCAL-VOICE.md`. Test and deployment receipts belong to HOM-335.

- Artifact image preview zoom (HOM-265): reuse the shared zoom/pan viewer in the Artifacts dialog, including fit/reset and existing file actions. UI-only overlay.

- Local voice call continuity (HOM-265): a company/user-scoped provider keeps media and the original agent binding across chat/page navigation; a global call bar preserves hang-up and microphone controls. Scope changes still clean up media.

- Agent chat pin buttons (HOM-265): roster and detail header share explicit nullable `chatPinned` membership preferences. Unpin hides even the primary agent while preserving its identity and stars. Additive database column, agent membership API and UI; existing automatic defaults remain until changed.

- Shared image gallery zoom (HOM-265): fitted 1–5x images with zoom controls,
  wheel/keyboard/double-click, bounded drag and touch pinch; reset on navigation
  and reopen. Video/download/focus behavior stays in the existing gallery.
  UI-only overlay release; related gallery interaction tests.

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
- `0cb993e80b`, `74724fd441` feat(voice): agent_chat binding — speak and it is sent to the Owner's Chat (HOM-326; branch `michael/voice-agent-chat`, migration 0442 widens `chat_voice_sessions.binding_mode` and lets agent_chat sessions omit `conversation_id`; see doc/connections/LOCAL-VOICE.md)
- `c7d7c4add7`, `bc43362bae` feat(ui): voice-call button at the right end of every Chat's top bar (HOM-265; agent_chat call in place via a floating card; Breadcrumb gains `actions`/`actionsKey`; T1 UI overlay)
- `06f057e366`, `85438a6ff1` feat(ui): ringback tone while a voice call connects; call status, timer and Pause stay inline in the Chat top bar, captions open on demand (HOM-265)
- `b80e056a9d` fix(voice): drop transcripts gpt-4o-transcribe invents for noise — plain transcription prompt with read-back drop, transcription logprobs (mean < -0.7 dropped), far_field noise reduction; dropped lines show as not sent (HOM-265; T3 server)
- `c7310498b5` feat(voice): agent_chat model chats with the caller and forwards requests with `send_to_agent` (caller's own words only; small talk stays in the call; Gemini unchanged) (HOM-265 Owner choice b)
- `d4458d7cd0` feat(voice): per-agent OpenAI voice remembered in the browser, sent as the `pcvv.<voice>` subprotocol, validated server-side (HOM-265 Owner choice a)
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
- `a8764b3e43` fix(tool-gateway): create the human-only approval card for agent Test-path Ask first calls (branch `michael/tool-test-review-card`, merged in `20ee2706a0`; released as `a8764b3e4-r2` on 2026-11-17, Owner-waived candidate smoke, related tests 8/8). A delegated connection Test call made from a task or chat only recorded an action request, so no card reached the chat and the request expired after an hour; it now reuses the gateway's approval builder when the call has an issue.
- `9159ee0e36`, `d9be0cfbd8` fix(tool-gateway): settle the linked formal approval when the human accepts the request's card (branch `michael/tool-card-formal-approval`, fast-forwarded as `942c8748bc`; released as `942c8748b-r1` on 2026-11-17, Owner-waived candidate smoke, related tests 6/6). A high-risk tool action creates a formal board approval next to its human-only chat card, and accepting the card failed with a 409 shown as an internal error; the Owner's accept on the request's own card now approves the approval this gateway created for that request, while decisions made anywhere else still need it.

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

- HOM-454: optional Compass one-hour cache-write subset; card
  compass-official-2026-11-20-ttl prices the remainder at five-minute rates,
  preserves unknown-TTL one-hour estimates and historical prices. Lost final
  receipts can price saved Compass counters as a lower bound. Source-only;
  deployment and the external usage-ledger card update remain separate.
