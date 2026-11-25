import { expect, it, vi } from "vitest";
import { attentionReadCoalescer, attentionReaderKey } from "./attention-read-coalescer.js";

it("shares only overlapping work, and clears successful and failed reads", async () => {
  const scope = attentionReadCoalescer<number>();
  const read = vi.fn(async () => 3);
  const first = scope.run("reader", read);
  expect(scope.run("reader", read)).toBe(first);
  expect(await first).toBe(3); expect(read).toHaveBeenCalledTimes(1);
  expect(scope.get("reader")).toBeUndefined();
  await scope.run("reader", read); expect(read).toHaveBeenCalledTimes(2);
  const failure = new Error("database unavailable");
  await expect(scope.run("reader", async () => { throw failure; })).rejects.toBe(failure);
  expect(scope.get("reader")).toBeUndefined();
});

it("isolates company, viewer and every public authorization field", () => {
  const actor = { type: "agent" as const, agentId: "a", companyId: "c", onBehalfOfUserId: "u", runId: "r" };
  const key = attentionReaderKey("c", "u", actor);
  expect(attentionReaderKey("other", "u", actor)).not.toBe(key);
  expect(attentionReaderKey("c", "other", actor)).not.toBe(key);
  for (const change of [{ agentId: "b" }, { runId: "other" }, { authorizingUserId: "other" },
    { isInstanceAdmin: true }, { keyScope: { type: "task" } },
    { onBehalfOfMemberships: [{ companyId: "c", status: "active", membershipRole: "viewer" }] }]) {
    expect(attentionReaderKey("c", "u", { ...actor, ...change } as typeof actor)).not.toBe(key);
  }
  expect(attentionReaderKey("c", "u", { ...actor, __responsibleUserSnapshotMemo: new Map() } as typeof actor)).toBe(key);
});
