<!--
  GitHub shows .github/README.md on the repository page before the root README.md.
  This file is the fork's own front page; the root README.md stays the upstream
  README so daily upstream syncs merge without conflicts.
-->

<h1 align="center">Paperclip — michael3abc edition</h1>

<p align="center"><strong>Your whole AI company, run from one chat.</strong></p>

<p align="center">
  <a href="https://github.com/michael3abc/paperclip/releases/download/demo-v5/Paperclip_demo_v5.mp4">
    <img src="https://github.com/michael3abc/paperclip/raw/michael/main/doc/assets/fork/demo-preview.webp" alt="Paperclip fork demo: main agent chat, task board, live workers, decisions, voice, routines, artifacts and the model picker" width="820" />
  </a>
</p>

<p align="center">
  <a href="https://github.com/michael3abc/paperclip/releases/download/demo-v5/Paperclip_demo_v5.mp4"><strong>▶ Watch the 83-second demo, with sound</strong></a>
  &middot;
  <a href="https://github.com/michael3abc/paperclip/blob/michael/main/FORK.md"><strong>Feature list</strong></a>
  &middot;
  <a href="#run-it"><strong>Run it</strong></a>
  &middot;
  <a href="https://github.com/paperclipai/paperclip"><strong>Upstream Paperclip</strong></a>
</p>

---

This is a personal fork of [Paperclip](https://github.com/paperclipai/paperclip),
the open-source control plane for companies of AI agents. Upstream Paperclip gives
you the company: org chart, tasks, budgets, approvals. This fork is what one
person runs every day to get real work done with it. Every project gets a **main
agent you talk to in one chat**. It plans the work, hands it to Codex, Claude and
Antigravity workers, checks the result and keeps going on its own, and it asks
you only when something needs your call.

Everything in the demo is real Paperclip UI from this fork. The company in it
(Northwind Labs and its "Lumen" lamp) is made up.

## What the fork adds

| Feature | What you get |
| --- | --- |
| **One main agent per project** | Tell it what you want in Agent Chat. It plans, builds and verifies the work, keeps its own to-do list, decides routine questions itself and sends close calls to a consultant agent. You see a pending badge only when a decision is really yours. |
| **Native Claude Code and Codex sessions** | Agents run as resident Claude Code and Codex sessions, not one-shot prompts. A message you send while it works steers the running turn. Native questions show up as one-tap forms in the chat. |
| **Shared workers you can watch** | Mains hand tasks to shared Codex, Claude and Antigravity CLI workers, chosen per project. Live work cards show every worker and subagent while it runs. |
| **Liveness first** | Runs prefer running over blocking: transient failures retry with backoff, a run silent for 30 minutes is stopped and retried, and an unclear outcome is resent with a note to check the current state first. Only you pause or cancel. |
| **Decisions in one queue** | Reviews, approvals and blockers wait in one decision queue. Approve, or send the work back. |
| **Voice calls** | Call an agent from your phone. Small talk is answered right away; work questions go to the project's main agent, and it answers out loud. |
| **Artifacts** | Every image, video, deck and PDF an agent makes lands in one folder per project, with previews, zoom and mobile-friendly PDF viewing. |
| **Models and cost** | Pick any model, effort and speed per agent. With CC Pocket, subscription models fall back to a pay-as-you-go route when a quota runs out. The dashboard shows subscription quotas and what each model costs. |
| **Worktrees on demand** | Main agents create, merge and retire Git worktrees through an API that reads Git as the source of truth. |

The full list, with the design document for each area, is in
[FORK.md](https://github.com/michael3abc/paperclip/blob/michael/main/FORK.md).

## Run it

```sh
git clone https://github.com/michael3abc/paperclip.git
cd paperclip
git switch michael/main
pnpm install
pnpm dev            # API and UI at http://localhost:3100
```

`npx paperclipai` installs upstream Paperclip, not this fork. Leave
`DATABASE_URL` unset to use the embedded database. See
[doc/DEVELOPING.md](https://github.com/michael3abc/paperclip/blob/michael/main/doc/DEVELOPING.md)
for the full setup.

**Good to know before you try it**

- The native-session features (main agents, shared Bridge workers, steering, the
  to-do list) need **CC Pocket Bridge** and its `ccpocket_bridge` adapter, which
  live in a separate repository. Without them the built-in adapters work as in
  upstream and those features stay off.
- Voice calls need OpenAI or Gemini Realtime credentials and are off by default.
- `AGENTS.md` and many docs contain rules written for the maintainer's own host
  ("Owner" decisions, `HOM-123` issue keys, `/home/michael` paths).
  [docs/fork/host-operations.md](https://github.com/michael3abc/paperclip/blob/michael/main/docs/fork/host-operations.md)
  explains which ones apply to you.
- The release line is `michael/main`. It merges upstream regularly; the
  [upstream README](https://github.com/michael3abc/paperclip/blob/michael/main/README.md),
  docs and Discord describe upstream Paperclip and do not cover this fork.

## Credits and license

Built on [paperclipai/paperclip](https://github.com/paperclipai/paperclip) by the
Paperclip team, under the [MIT License](https://github.com/michael3abc/paperclip/blob/michael/main/LICENSE).
Fork changes are released under the same license.
