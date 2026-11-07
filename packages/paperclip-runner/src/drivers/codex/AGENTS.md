# Codex driver test ownership

The driver tests are split by contract:

- lifecycle: startup, session lifetime, shutdown and provider admission
- context-control: instructions, models, permissions, goals and turn controls
- events: canonical event and provider-notification projection
- runtime-requests: question and approval request/response protocols
- semantic-results: dynamic tools, completion receipts and unknown outcomes
- recovery: snapshot, resume, reconciliation and current tool refresh
- conformance: replay validation and controller-owned result contracts

Use the existing suites and `codex-app-server-driver.test-support.ts`. The
retired `codex-app-server-driver.test.ts` duplicated the split suites; do not
recreate it or replay one complete contract in multiple files. When splitting
another test file, move its cases and retire the old copies in the same change.
Preserve table rows, waits, actions and assertions, including failure cases.

Keep provider protocol and native lifecycle layers independent when they test
different owners. Test workspaces must use the disposable real `WORKSPACE`
fixture; do not use a managed Codex checkout as model-writable workspace.

Coordination-only PM startup/resume requires the generated exact-catalog hook to
be confirmed trusted in the disposable provider home before any turn. Never use
hook-trust bypass or trust a different hook source. Lifecycle tests own admission
and failure/readback checks; context-control owns repeated thread restrictions.
Qualify native execution/subagent denials with the pinned executable and a local
fake Responses endpoint, without provider credentials or production task replay.
