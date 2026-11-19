# Host operations: reading this fork from outside

This fork runs one maintainer's agent company on one host. Many rules in
`AGENTS.md`, `FORK.md`, `docs/agents/` and `docs/fork/` were written for the
agents on that host. This page tells a reader on another machine which parts
describe the code and which parts describe the maintainer's host.

## Words you will see

| Word | Meaning |
| --- | --- |
| Owner | The maintainer. "Owner 2026-11-13" marks a decision record with its date. Quoted Chinese text is the Owner's original words. |
| `HOM-123`, `SHO-74` | Issue keys in the maintainer's own Paperclip instance. They are not GitHub issues. |
| CC Pocket, Bridge, `ccpocket_bridge` | The maintainer's native-session runtime. It runs Claude Code and Codex as resident sessions. It lives in a separate `ccpocket` repository and is loaded as an external adapter; it is not in this repository. |
| Compass | The maintainer's model gateway. The Compass rate card only prices receipts from that gateway. |
| Shopee, michael-server | Hosts in the maintainer's fleet. |
| T0–T4, `fork-checks.py`, cutover, preempt | The maintainer's release tiers and tools. The tools live under `/home/michael/services` on the host, not in this repository. |

## Host paths

These paths exist only on the maintainer's host:

| Path | What it is | Equivalent in this repository |
| --- | --- | --- |
| `/home/michael/AGENTS.md` | Host-wide agent rules | None |
| `/home/michael/services/docs/agents/liveness-first.md` | Source of the liveness-first execution policy | The implemented behavior is in `docs/agents/execution-semantics.md` and `server/src/services/recovery/failure-classification.ts` |
| `/home/michael/services/README.md`, `services/systemd/platform/paperclip/` | Release, test-selection and cutover tools | None; use the upstream build and test commands |
| `/home/michael/docs/git-fork-workflow.md` | How the maintainer syncs upstream | `FORK.md` "Release" |
| `~/.config/paperclip-ccpocket/hosts.json` | CC Pocket host registry (also read for Dashboard host quotas) | `doc/DEVELOPING.md` describes the format |

Files that name `/home/michael` today: `AGENTS.md`, `FORK.md`, `doc/DEVELOPING.md`,
`doc/SPEC-implementation.md`, `doc/execution-semantics.md`, `doc/task-recovery.md`,
`doc/native-workspace-finalization-recovery.md`,
`doc/plans/2026-11-10-session-bridge-key-scope.md`, `docs/agents/*.md` (six files),
`docs/guides/board-operator/costs-and-budgets.md`,
`rules/heartbeat-execution-boundaries.mdc`, and three server files where the path
appears only in comments (`server/src/services/recovery/failure-classification.ts`,
`server/src/services/recovery/liveness-reset.ts`,
`server/src/services/heartbeat/workspace-preparation.ts`) plus one test fixture.
No runtime code reads a `/home/michael` path.

## Which rules apply to you

On the maintainer's host every rule in `AGENTS.md` applies as written, including
the Owner policies. This page does not relax any of them there.

In your own clone:

- **Code rules apply.** Company scoping, contract synchronization across
  db/shared/server/ui, activity logging, the token-only UI rule, the database
  change workflow and the scoped `rules/*.mdc` files describe how this code is
  built. Follow them.
- **Behavior descriptions apply.** Liveness-first execution (failure classes,
  retry backoff, 30-minute inactivity, workspace = directory, terminal status
  releases every gate) is what this fork's server does. You need it to change
  run execution correctly, even though its policy file is on the maintainer's host.
- **Host procedures do not apply.** The related-tests-only policy, the managed
  release tools, the T0–T4 tiers, preempt/cutover steps and fleet-specific
  instructions (Shopee hosts, Compass, named agents and worker IDs) exist for the
  maintainer's host and its memory limits. Use the normal upstream verification
  (`pnpm test`, `pnpm -r typecheck`, `pnpm build`) and release flow instead.

## Features that need something outside this repository

| Needs | Features |
| --- | --- |
| CC Pocket Bridge and its `ccpocket_bridge` adapter | Resident Claude Code / Codex sessions for agents, main-agent Chat steering, native question cards, project main and shared Bridge workers, worker/subagent cards, the main-managed worktree API, the TODO tab content (the adapter writes the `todo` document) |
| CC Pocket host registry and SSH access to hosts | Dashboard host subscription quotas and host Claude login |
| OpenAI or Gemini Realtime credentials | Local voice calls (off by default) |
| A browser-login companion for the MCP server | Custom MCP browser sign-in |
| Antigravity CLI subscription | `agy_local` workers |

Without CC Pocket, the built-in adapters (`claude_local`, `codex_local` and the
others under `packages/adapters/`) work as they do upstream, and the features in
the first row stay unused. The maintainer has not tested this fork on a host
without CC Pocket, so report problems you find.
