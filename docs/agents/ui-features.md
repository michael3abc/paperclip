# ui-features

Moved verbatim from `AGENTS.md` on 2026-11-13. These rules and records stay binding; read this file before acting on the topic. Sidebar status, coordinator sidebar, PDF preview, live work cards, worker-card collapse UI

Worker-card collapse is presentation only. The session-bridge proof endpoint
requires the current main's project/worker policy and issue read permission,
server session authority, the exact accepted native input and a saved successful
result. Pending input/questions and newer runs deny completion. The Bridge must
also prove its current turn, saved response and settled tools; idle alone is not
completion. Reuse execution-status delivery and control events, including session
publication after terminal status, without adding a card polling loop. Preserve
main/manual/pinned cards and all histories. Dedicated `workerCardOnly` keys can
only GET proof/events; never expose native controls, inbox or other API routes
to observers. See `doc/execution-semantics.md`.
Antigravity has no native input/turn ID: require the paired Bridge's persisted
`ccpocket.antigravity-turn-receipt.v1`, separately accepted bridgeInputId/prompt
hash, saved-answer hash and positive native turn counter. Never relabel host IDs
as native IDs, backfill old results or waive current authority/activity gates.
Worker-card control events may use the server privacy binding only behind current
issue authorization. Do not broaden generic status events with that binding:
their native/canonical legacy identity projection remains unchanged.

The Coordinator sidebar's Agents section includes the person's company-scoped
primary agent alongside `ceo` and `pm` roles and agents the person starred;
preserve lifecycle, service-account
and membership visibility restrictions regardless of primary selection or stars.
Pin the primary agent first and sort the remaining agents alphabetically.
Do not add a worker expansion control or change dispatch to implement this filter.

Project PM sidebar rows show a presentation-only status. CoordinatorSidebar and
both SidebarAgents variants use useProjectPmSidebarStatus; change all three in lockstep. Blue frame, `working` label and pulsing dot:
a readable running live run belongs to a task of the PM's project, subtasks included,
or is the PM's own run. Orange frame and `needs input`, which overrides blue: an
Owner-addressed `issue_thread_interaction`, `approval` or `decision` item of that
project is pending. Zero-slot PMs work through shared workers, so attribute through
`GET /companies/:id/pm-workspaces` and the live run's `projectId` (omitted on runs the
viewer cannot read), never `run.agentId`. In the Coordinator only, a listed agent that is
not a project PM (a project main agent; momo and personal agent rows unless the person
excluded them) shows blue `working` while its own readable run is working, by
`run.agentId` only: no project attribution, no `needs input`, no full attention read, and
the person's exclusion list must be loaded first. Classic SidebarAgents keeps its live dot
for such agents. Read the
complete attention snapshot (`attentionApi.list(..., { all: true })`), not the ranked
first page; `approval` attention items must carry their linked issue's `project`
(`issueContext`), and approvals the viewer cannot read stay excluded. Queued,
scheduled-retry, recovery and answer/access-wait runs are not
working; a `running` row whose cached projection still says `queued` has just started
(`heartbeat.run.status` patches only `status`). Known binding, viewer-preference and complete attention snapshots are required even
for blue. First loading is quiet; first failure shows no status and reports an error
through the nonoptional toast actions (company/source dedupe key and failure timestamp).
A failed refetch retains the loaded snapshots. Use coordinatorAttentionQueryKey for
the full feed, shared with Needs You/task attention pages and their invalidations,
with the existing 60-second cadence. Bound PM status is the explicit full-feed
navigation exception to upstream #18323; no bindings means no full-feed read. Keep
the count-only summary separate and live-run/shared-polling ownership in callers.
Do not restore the old Coordinator open-task query, chat inference or working ring.
The status never changes dispatch,
permissions, row order or agent configuration. Sidebar rows keep the neutral
`ring-ring` keyboard focus ring; do not restore the browser default outline.
A person may exclude PM agents from this status:
`company_user_sidebar_preferences.excluded_pm_status_agent_ids` is a jsonb agent-ID
array, default `[]` (every PM shows status), read and written by
`GET/PUT /companies/:companyId/sidebar-preferences/me` (`{ excludedPmStatusAgentIds }`)
under the existing board/membership checks. A PUT changes only the fields it sends, so
the project-reorder `orderedIds` PUT preserves the list. Both sidebar chains read the
same query; never hardcode agent names or production IDs in the repository, the person
saves verified IDs after deploy. An unreadable list is not an empty list: with no
loaded list claim no PM status and report the failure through the existing error toast;
a failed refetch keeps the list already loaded. The column is additive (`NOT NULL`
default `[]`) so the previous release still runs on the new schema.

Coordinator Agents rows also show a presentation-only violet frame, tint and
`waiting for task` label (`--sidebar-waiting-*` tokens in `ui/src/index.css`) when the
viewer's chat with that agent reports `hasLiveChildTasks` from
`GET /companies/:id/chats` and the agent has no working run of its own. The server
sets it when a readable, unhidden task that chat created in its current session
(`chat_task_handoffs`) or a direct subtask of the chat has a `queued`, `running` or
`scheduled_retry` run (`server/src/services/agent-chat-live-tasks.ts`). Working and
needs input outrank it; it is computed from runs, not chat state, and does not read
the PM status exclusion list. Native subagents exist only in run transcripts and are
not included. Run lifecycle live events (queued, and every status except `running`)
refetch the viewer's chat list unless the run belongs to the chat itself; there is
no polling. Classic SidebarAgents rows are not chats and are unchanged.

PDF attachment opens use the shared PdfPreviewProvider under BrowserRouter.
Its local-state dialog keeps Back, Open original and Download visible without
changing task history, location state or scroll; a route change closes it.
System/browser Back keeps its normal navigation behavior. Intercept only plain,
unprevented primary clicks on same-origin attachment/asset content routes.
Validate the authenticated response (200, PDF MIME/header, bounded 32 MiB stream)
before embedding a PDF blob; abort/revoke on close. Download stays a separate
action. Preserve text tabs, media viewers and native modifier-click behavior.
Browser viewport tests do not qualify physical iPhone/Android PDF rendering.

Live work cards render runtime identity only from the run's model_identity activity or the child's
own delegation payload. Preserve harness, raw model/provider, billing route and unavailable metadata;
never use the current agent config or parent model to label a historical run or native child.
See doc/DEVELOPING.md (Main-agent live work cards).
Mobile conversation headers must open the actual task side-panel sheet through
the page's panel control, so Tasks remains reachable at phone widths.
The lower conversation Task list also shows each task's harness/model/source. Project only its
latest run's invocation/usage evidence through the authorized handoff page; never the creator run.
Label unstarted assignment settings Configured and unavailable historical fields unknown. Do not
expose adapter configs, credentials or transcripts, fetch each card separately, or poll for identity.

Project main-agent chats (`ccpocket_bridge` with `adapterConfig.role === "main"`) show a quiet
`Effort · Model` pill on the right of the composer (`MainAgentModelPicker`). It edits the agent's saved
`model`/`effort`, not per-message run settings: read `GET /agents/:id/configuration`, refuse if the
viewed model, effort, host or executor changed, then `PATCH /agents/:id` with only those two keys
(server merge) and `expectedConfigurationRevision`. Models come from the company-scoped Bridge
catalog for the agent's own host and executor, in Bridge order with qualified IDs; efforts come from
the selected model's `efforts` metadata, with no slider when it reports none. Editing is gated in the
UI by the viewer's default `agents:configure` role (local board, instance admin, owner, admin,
operator, member); others see the same pill read-only, and the server's `agent_config:update` check
stays authoritative. A saved change applies from the next turn in the same native session.
All copy is English. The popover (a bottom sheet on mobile) has two views: the main view shows the
effort label, the model name linking to the model view, a revert-to-opened-setting button and one
discrete pill slider without tick labels (Default, Low, Medium, High, Extra high, Max, limited to the
model's efforts); the model view groups models under Subscription, Compass and Local (from the
catalog `source`, else a `compass-` ID prefix). There is no Apply button: a picked model saves at
once, a released slider saves at once and keyboard changes save after a short debounce; saves run one
at a time and a failure reverts with a toast. Display names use a human catalog label, else a
humanized ID (`claude-fable-5-1[1m]` -> "Claude Fable 5.1 · 1M", `compass-opus5.5` -> "Opus 5.5");
the stored ID never changes.

