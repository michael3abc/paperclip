# session-bridge-and-dashboard

Moved verbatim from `FORK.md` on 2026-11-13. These rules and records stay binding; read this file before acting on the topic. Session bridge, host subscription dashboard, Compass pricing, capability inventory

- Integrated capability inventory synchronization (2026-11-11): refresh both
  Runner inventories after worker-secret guidance changes, retain the existing
  eval corpus and verify normative source headings in the contract regression.

- Compass `[1m]` pricing (2026-11-09): main agents run `compass-opus5.5[1m]`, and the
  exact-match Compass rate card left those receipts unpriced. Claude Code strips the
  `[1m]` context-window suffix before the request reaches Compass, and Anthropic 5.5 has a
  single price tier, so an Anthropic Compass selector with a trailing `[1m]` now uses its
  base card and notes the 1M window in the evidence; the receipt model id is unchanged and
  OpenAI selectors stay exact-match. Feature commit `d3b28fea5`; no schema change.
  Receipts already recorded as unpriced are not repriced automatically.
- Native session bridge pilot (michael/session-bridge, 2026-11-10): scoped non-run
  keys, durable bidirectional conversation receipts, approved worker MCP dispatch
  and assigned connector gateway calls. Additive JSON/text contracts, no migration.
  See doc/plans/2026-11-10-session-bridge-key-scope.md. Release from michael/main;
  preserve the previous release and verify only related tests.
- Host subscription dashboard (2026-11-10): opt-in administrator-only cards read
  this host's Codex, Claude and Antigravity subscription logins independently of
  managed AI connections. Visible-page refreshes coalesce behind a 60-second
  cache; provider work respects maintenance admission and starts no inference.
  Quota groups, unknown values and failures stay explicit. Codex RPC duration
  determines the label even when a weekly bucket is primary. No schema change.

- Session bridge catalog repair (2026-11-10): isolate session-only MCP definitions
  from the Runner legacy inventory, regenerate source anchors, and align connector
  decision-text and capability-count regressions with the existing contracts.
- Session bridge connector errors (michael/session-bridge-errors, 2026-11-10):
  preserve the assigned gateway's typed status, reason and public receipts at
  the HTTP boundary; unknown failures remain redacted and calls are never retried.
  Native SeaTalk acceptance exposed an expired upstream login and a masked 500.


