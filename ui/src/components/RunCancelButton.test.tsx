// @vitest-environment jsdom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, expect, it, vi } from "vitest";
import { RunCancelButton } from "./RunCancelButton";
const { cancel } = vi.hoisted(() => ({ cancel: vi.fn() }));
vi.mock("@/api/heartbeats", () => ({ heartbeatsApi: { cancel } }));
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
const container = document.createElement("div");
const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
let root: ReturnType<typeof createRoot>;
afterEach(() => { act(() => root.unmount()); client.clear(); cancel.mockReset(); });
async function render(finishCancellation = false) {
  root = createRoot(container);
  await act(async () => { root.render(<QueryClientProvider client={client}>
    <RunCancelButton runId="old-run" issueId="task" companyId="company" agentId="agent" finishCancellation={finishCancellation} />
  </QueryClientProvider>); });
}
async function flush() { await act(async () => { await new Promise(resolve => setTimeout(resolve, 10)); }); }
it("cancels the displayed waiting run once and confirms its receipt", async () => {
  cancel.mockResolvedValue({ id:"old-run", companyId:"company", runtimeMode:"legacy", status:"cancelled", resultJson:null });
  await render();
  await act(async () => container.querySelector("button")!.click()); await flush();
  expect(cancel).toHaveBeenCalledExactlyOnceWith("old-run");
  expect(container.textContent).toContain("Cancelled");
  expect(container.querySelector("button")!.disabled).toBe(true);
});
it("shows an unverified cancellation without replaying it or claiming release", async () => {
  cancel.mockRejectedValue(new Error("Cancellation remains unverified"));
  await render(true);
  expect(container.textContent).toContain("重新檢查");
  await act(async () => container.querySelector("button")!.click()); await flush();
  expect(container.querySelector('[role="alert"]')?.textContent).toContain("Cancellation remains unverified");
  expect(cancel).toHaveBeenCalledTimes(1);
  expect(container.querySelector("button")!.disabled).toBe(false);
});
