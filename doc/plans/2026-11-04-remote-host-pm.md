# Native project PM on its worker host (`pmHome`)

Date: 2026-11-04

## Problem

A `project_pm` binding with `workerHostId` runs workers on the remote host, but
the PM itself still runs in its local agent home on the controller. Project
environment questions (toolchains, data paths, GPU state) then reach the PM
only through worker turns, and PM turns repeatedly hit environment gaps.

## Decision

Add an optional binding field `pmHome`:

- A canonical absolute POSIX path (no empty, `.` or `..` segments, no trailing
  slash). It requires `workerHostId`; otherwise the binding resolves to
  `project_pm_invalid`.
- The PM role cwd is `pmHome ?? agentHome`. Workers are unchanged.
- `agentHome` stays mandatory and local. `controllerLocalCwd` already returns
  it for any binding with `workerHostId`, so controller-local setup is
  unchanged.
- The claim context (`paperclipPmWorkspace`) and the `pm-workspaces` listing
  carry `pmHome` only when set. `readWorkspaceBinding` refuses a run whose
  context and stored binding disagree on it.
- The server never stats `pmHome`; the local-directory check is skipped for a
  PM turn with `pmHome`. The `ccpocket_bridge` adapter creates and verifies it
  on the host before admitting the session.
- `pmHome` is not a host-noise fingerprint key, so changing it is a
  meaningful config change.

## Rollout

1. Ship this field (no stored binding uses it yet).
2. Ship the adapter and CC Pocket Console support.
3. Migrate one PM at a time with a new `pmSessionGeneration`; the old local
   session remains as history.

## Rollback

Restore the previous binding (without `pmHome`), host, model and session
generation. Older servers reject `pmHome` because the binding schema is strict,
so the field must be removed before downgrading.
