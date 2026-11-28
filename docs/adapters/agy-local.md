---
title: Antigravity CLI
summary: Antigravity (agy) CLI local adapter setup, configuration, and advanced features
---

The `agy_local` adapter runs Google's Antigravity (`agy`) CLI locally. It supports multi-turn session persistence with `--conversation`, multi-workspace directory context via `--add-dir`, reasoning effort, subagent personas, structured JSON schema enforcement, deterministic execution modes, and automatic brain artifact discovery.

This fork integrates upstream PR #21121 at `46b4510cae7d7dbbb73df5ce1c147c96fa73a45a`.
Worker settings can select an active CLI shared worker, its model, effort,
permission and explicit subscription connection for new tasks. Existing Bridge
workers retain their separate harness. Google native ACP connections cannot
authenticate this CLI adapter.

Shared CLI workers set `subscriptionOnly:true` and reject API keys. All CLI runs
and probes disable paid extra credits with `useG1Credits:false`. Plan cannot skip
permissions; auto is unsupported. Model discovery failures are reported directly.

## Prerequisites

- Antigravity CLI installed (`agy` command available on PATH)
- Antigravity authenticated (`agy` auth configured or `GEMINI_API_KEY` available)

## Configuration Fields

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `cwd` | string | No | Working directory for the agent process (absolute path; defaults to workspace directory) |
| `model` | string | No | Model ID to use (e.g. `gemini-3.8-flash-high`, `gemini-3.8-flash-medium`, `gemini-3.8-flash-low`, `gemini-3.7-flash-high`, `claude-sonnet-4-6`). Defaults to `gemini-3.8-flash-high`. |
| `effort` | string | No | Reasoning effort (`low`, `medium`, `high`, `xhigh`, `max`). Models with a tier suffix encode effort in the model ID and omit the conflicting `--effort` flag. |
| `mode` | string | No | Execution mode: `accept-edits` (full autonomous edit capability) or `plan` (non-mutating planning and research) |
| `project` | string | No | Antigravity project name or ID for conversation and memory grouping (`--project`) |
| `printTimeout` | string | No | CLI print mode wait timeout (e.g. `15m`, `30m`, `1h`). Defaults to aligned Paperclip `timeoutSec` or `24h` |
| `disableSlashCommands` | boolean | No | Disable slash command and skill expansion in print mode (`--disable-slash-commands`) |
| `agent` | string | No | Antigravity subagent persona name passed via `--agent <name>` |
| `jsonSchema` | string | No | JSON schema string or path to a schema file to enforce structured output (`--json-schema`) |
| `sandbox` | boolean | No | Run in sandbox mode with terminal restrictions enabled (`--sandbox`) |
| `dangerouslySkipPermissions` | boolean | No | Auto-approve tool calls without prompting (`--dangerously-skip-permissions`). Defaults to `false` |
| `workspaceStrategy` | object | No | Workspace strategy configuration, e.g. `{ type: "git_worktree", baseRef, branchTemplate, worktreeParentDir }` |
| `instructionsFilePath` | string | No | Absolute path to markdown instructions file (e.g. `AGENTS.md`) prepended to prompt |
| `promptTemplate` | string | No | Custom prompt template for agent runs |
| `addDirs` | string[] | No | Additional workspace directories injected via `--add-dir` |
| `command` | string | No | Executable command name or path (defaults to `agy`) |
| `extraArgs` | string[] | No | Additional CLI args passed to `agy`. `--settings` is reserved for Paperclip credit controls and is rejected here. |
| `env` | object | No | Environment variables (supports plain and secret bindings) |
| `timeoutSec` | number | No | Process timeout in seconds (0 = no timeout) |
| `graceSec` | number | No | SIGTERM grace period before force-kill (defaults to 15) |

## Session Persistence & Continuity

The adapter persists Antigravity conversation IDs across heartbeats using `--conversation <id>`.
- **Target identity preservation**: Remote execution targets maintain session identity across host migrations.
- **Self-healing recovery**: If a session was deleted or pruned, the adapter automatically detects the missing session error and re-executes cleanly with a fresh session.

## Multi-Workspace Context

Paperclip automatically passes all relevant workspace directories using repeatable `--add-dir` flags:
1. The primary workspace directory (`cwd`)
2. Any secondary workspaces in multi-project companies (`paperclipWorkspaces`)
3. Any custom directories specified in `addDirs`

## Brain Artifacts Auto-Discovery

Antigravity writes deliverable artifacts (such as `implementation_plan.md`, `walkthrough.md`, diagrams, and scratch deliverables) to the session's brain directory (`~/.gemini/antigravity/brain/<sessionId>`). At the end of each run, the adapter discovers these artifacts, logs them to the Paperclip run log, and includes them in `resultJson.artifacts`.

## Environment Test

Use the "Test Environment" button in the agent configuration UI to validate:
- Antigravity CLI binary exists and is executable
- Working directory is resolvable and accessible
- Authentication and credentials are valid
- Live probe execution succeeds with the configured model and permissions, stream JSON input/output, and `--settings '{"useG1Credits":false}'`. Invalid worker authentication, permission and credit settings fail before probe execution.

The Antigravity CLI catalog entry (agy-local) stores AI provider antigravity
and reconnects to that entry. Upstream Antigravity (antigravity) stores provider
google and uses Runner ACPX. Their accounts are not interchangeable. Cloud starter
inference migration selects agy_local explicitly for CLI accounts.

## Repository agent rules (HOM-777)

Moved verbatim from `AGENTS.md` on 2026-11-27. These rules remain binding;
read the matching topic before changing it. Repository policy precedence is unchanged.

### Antigravity shared workers

The fork ports upstream PR #21121 as `agy_local`, separate from the pending
Google ACP runtime and from `ccpocket_bridge`. Preserve explicit subscription
bindings and model/effort/permission through the revision-checked worker policy.
Shared CLI workers set `subscriptionOnly:true`; all CLI invocations disable
paid extra credits with `useG1Credits:false`. Plan never skips permissions;
auto is unsupported. Preserve existing Bridge agents, policies, sessions and
credentials. See `doc/DEVELOPING.md` and `docs/adapters/agy-local.md`.

### Provider quota and Antigravity ACP (HOM-728)

Provider quota without a reported reset remains transient under the fork classifier;
upstream account-action hints never gate automatic retry. Antigravity
ACP 1.5.2 uses one platform-aware admission source with Linux `/proc/self/exe`,
per-distribution helper digests and the existing remote-browser paste-back;
`agy_local` and Bridge remain separate. The agy-local catalog entry retains
provider antigravity; upstream antigravity stores provider google. Keep account
creation/reconnect and Cloud trial migration routes separate. See doc/DATABASE.md and doc/DEVELOPING.md.
