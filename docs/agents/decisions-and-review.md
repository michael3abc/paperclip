# decisions-and-review

Moved from `AGENTS.md` on 2026-11-13; read this file before acting on the topic. `/home/michael/services/docs/agents/liveness-first.md` (Owner 2026-11-13) is binding and wins over any conflicting statement here. PM decision authority, review decisions, decision delegation, secret delegation, review recovery

Owner-issued `project-pm-decision-authority` is separate from company delegation.
Its revision and explicit project list authorize current project PMs to decide
ordinary plans, one-shot Allow and approvals, including their own proposals when
allowed. It does not depend on momo or Dot, expand worker/model/budget access,
grant shell, approve hiring/budget overrides or override human/security gates.
PMs decide within scope directly; do not create unnecessary self-addressed questions.
Only the human Owner may grant or revoke this authority; never migrate old requests.
Review decisions require evidence-linked reasons and the current assigned review;
they grant no general approval authority. For execution-policy review stages, Runner
pins the assigned stage, policy/state hashes and status version before advertising
`resolve_review`. Its receipt records a pending decision without releasing the
reviewer's execution lock. Only successful run/workspace finalization may commit
that decision, audit/comment and the original task's next wake atomically. Recheck
the saved scope under row locks; preserve later human stages and independent
approval cards. Generic status PATCH and board-only stalled-review APIs remain
unavailable to PMs. During an execution-policy review, generic HTTP mutations
are also denied; hiding create_task from the tool catalog alone is insufficient.
If shutdown failure released the review lock, only the finalizer may settle its
saved decision. Require the original failed assessment, unchanged
stage/version/assignment, a terminal original run (stop evidence is not required),
no successor run and no Owner task/agent pause. Recheck in the commit transaction;
never grant lock-free tool authority or rerun the provider to recover a saved decision.
Completion-review interactions keep their existing route. Formal delegated approval
POSTs require a current assigned request revision, an evidence-linked decision note
and the independent Owner grant; generic API access never bypasses those checks.
Company decision delegation remains a separate
human-Owner-managed permission grant. Outside an independently authorized project,
new worker questions route through their task project's PM; PM questions route to the company delegate via
`request_human_input`, not by adding the delegate to the worker catalog. Omit
`resolverPolicy` for ordinary delegated questions; explicit human gates stay human.
Use the assigned request's current revision with the controlled resolve/escalate
tools. Preserve worker checkout and the original provider callback. Never replay
old pending cards or revive cancelled work when enabling delegation. Only the
granting human may change the grant or resolve a human-reserved request; Markdown
and an agent's risk label cannot widen it. Record agent decisions as agents with
grant version, run and reason. A missing delegate or expired provider request is
an explicit unresolved failure, not consent. Test the real pinned ACP/SDK under
approve-all as well as HTTP scope, dispatch/review and save/finalization behavior.

Main-agent secret delegation is task-scoped API access through existing bindings,
not an agent-wide shared-worker grant. Reauthorize the running standard JWT,
current project lead, own task, v2 worker policy, same-host eligibility and original
source binding; pin the version and preserve structured provenance. Never copy
values, modify worker env/config, auto-answer human-only questions or wake/replay
work. Revoke source changes and ownership/policy changes at read time; preserve
transactional grant/revoke audit. See doc/DEVELOPING.md and the agent API reference.


Native execution-review recovery and explicit Owner wakes bind the current locked
issue stage even without an old executionStage envelope. Require the same active
run/assignee, pending review stage and policy; never infer authority from a prior
run or caller payload, and never reopen blocked tasks during binding.

