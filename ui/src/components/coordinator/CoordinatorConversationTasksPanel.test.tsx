// @vitest-environment jsdom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vitest";
import { CoordinatorConversationTasksPanel } from "./CoordinatorConversationTasksPanel";

vi.mock("@/lib/router", () => ({ Link: ({ to, children, ...props }: any) => <a href={to} {...props}>{children}</a> }));
vi.mock("./CoordinatorChatTaskHandoffs", () => ({ useCoordinatorChatTaskHandoffs: () => ({ handoffs: [
  { id: "one", issueId: "one", identifier: "T-1", title: "Executed task", status: "done", createdAt: "2026-11-11", runtimeIdentity: {
    basis: "run", runId: "run-one", harness: "codex", model: "gpt-6-astra", billingRoute: "compass",
  } },
  { id: "two", issueId: "two", identifier: "T-2", title: "Queued task", status: "todo", createdAt: "2026-11-10", runtimeIdentity: {
    basis: "configured", runId: null, harness: "claude", model: "sonnet", billingRoute: null,
  } },
] }) }));
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

it("renders runtime identity in the lower Task list and retains it through filtering", async () => {
  const host = document.createElement("div"); document.body.append(host);
  const root = createRoot(host);
  try {
    await act(() => root.render(<CoordinatorConversationTasksPanel conversationIssueId="chat" />));
    expect(host.textContent).toContain("Created from this conversation.");
    const cards = [...host.querySelectorAll(".coordinator-created-task")];
    expect(cards).toHaveLength(2);
    expect(cards[0].textContent).toContain("Last run: codex · 6 Astra · compass");
    expect(cards[1].textContent).toContain("Configured: claude · sonnet · source unknown");
    const status = host.querySelector('select[aria-label="Filter conversation tasks by status"]') as HTMLSelectElement;
    await act(() => { status.value = "todo"; status.dispatchEvent(new Event("change", { bubbles: true })); });
    expect(host.querySelectorAll(".coordinator-created-task")).toHaveLength(1);
    expect(host.textContent).toContain("Configured: claude · sonnet · source unknown");
    expect(host.textContent).not.toContain("6 Astra");
  } finally { await act(() => root.unmount()); host.remove(); }
});
