# workspace-admission

Moved from `AGENTS.md` on 2026-11-13 and rewritten the same day for liveness-first.
Binding source: `/home/michael/services/docs/agents/liveness-first.md` (rule 3,
workspace = directory). Read this file before changing workspace resolution,
worktree creation or retirement.

## Workspace = directory

- Resolve the execution directory as: run-requested cwd > agent fixed cwd > project
  default cwd > `~/.paperclip/instances/default/workspaces/<agentId>`.
- Create it with `mkdir -p` (over ssh on remote hosts). A remote agent's directory is
  created on its configured host; never fall through to local execution. A non-Git
  directory is a valid workspace and is never Git-initialized for dispatch.
- Superseded as execution gates and never allowed to fail a run: workspace
  registration/admission, revision-checked selection, lifecycle generation/operation
  receipts, shared-checkout claims and holders, fixed/isolated conflicts
  (`fixed_workspace_policy_conflict`, `workspace_binding_mismatch`), remote host
  inspection, `shared_worktree_unsupported`, configured-source-only selection,
  "missing configuration fails before dispatch" and the three-admission startup
  recovery budget. Mismatches are logged only; preparation failures fall back to
  the resolved cwd.
- Paths, aliases and parent/child overlaps never serialize runs. The per-issue
  execution lock remains and keeps one run per issue.
- Configuration changes (model, provider, cwd, PM settings) start a new session for
  the next run instead of failing; they never reinterpret an in-flight run.
- Bridge main-agent configuration records the same session cwd in adapter settings
  and `runtimeConfig.workspaceBinding`.

## Worktrees created by main agents

- Main agents may explicitly create a Git worktree with the worktree tool and point
  a task's cwd at it. Explicit initialize creates only Git metadata (no add, commit
  or remote); never infer initialization authority from dispatch.
- Convergence, reopen and retire are main's lifecycle choices, not execution gates.
- An unknown host Git operation outcome is resolved by re-inspecting the current
  host state, then retrying if needed; it never holds unrelated runs.
- Include ignored target files in merge overlap checks before any shared effect.
- Read-only source tools share files; fixed-version reads never switch branch.
  Production sources, Owner holds, permissions and real provider capacity stay intact.

## Safe retirement (kept)

- Never delete a directory with dirty or ignored files (including `.lmas`); never
  force-remove a worktree. Back up dirty/ignored files and confirm commits are
  reachable from a kept branch before non-force removal.
- `execution_workspaces.metadata.mainManagedWorktree` is server-owned and only marks
  a tree as not deletable: legacy terminal/idle retention, compaction, rehome, branch
  repair and archive never modify or destroy a marked tree. Generic PATCH preserves it.
- Repository-root retirement only unregisters metadata; it never removes the
  directory or merges a linked tree.
- Retirement does not wait for stop evidence, but it still never deletes files.
- Warm sandbox adoption requires the exported source digest to equal the final host
  digest; missing export proof makes a new turn seed the current host.

## Company-scoped adapter catalogs (unchanged)

Company-scoped adapter catalogs declare catalogScope=company. Model discovery and
config-schema requests require authorized companyId plus the unsaved host/provider
selection. Never serve these from global schema caches or declared fallback lists.
Keep qualified model IDs in persistence; names and source badges are display only.
Bridge host companyIds live in the external host registry. See doc/DEVELOPING.md.
Bind manual refresh feedback to the exact selection/request and reject forbidden
schema hosts before probing; never substitute another host on an invalid query.
