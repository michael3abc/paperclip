// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { HostTerminals } from "./HostTerminals";
const mocks = vi.hoisted(() => ({ allowed: true, companyId: "company", list: vi.fn(), create: vi.fn(), breadcrumbs: vi.fn(), dispose: vi.fn(), input: undefined as ((data: string) => void) | undefined }));
vi.mock("@/api/host-terminals", () => ({ hostTerminalsApi: mocks }));
vi.mock("@/hooks/useHostTerminalAccess", () => ({ useHostTerminalAccess: () => ({ allowed: mocks.allowed, isPending: false, userId: "owner" }) }));
vi.mock("@/context/CompanyContext", () => ({ useCompany: () => ({ selectedCompanyId: mocks.companyId }) }));
vi.mock("@/context/BreadcrumbContext", () => ({ useBreadcrumbs: () => ({ setBreadcrumbs: mocks.breadcrumbs }) }));
vi.mock("@xterm/xterm", () => ({ Terminal: class {
  cols = 80; rows = 24; options = {};
  attachCustomKeyEventHandler() {} hasSelection() { return false; } loadAddon() {} open() {} focus() {} write() {} dispose = mocks.dispose;
  onData(callback: (data: string) => void) { mocks.input = callback; return { dispose() {} }; }
} }));
vi.mock("@xterm/addon-fit", () => ({ FitAddon: class { fit() {} } }));
class Socket {
  static OPEN = 1; static instances: Socket[] = [];
  readyState = 0; sent: Record<string, unknown>[] = [];
  onopen?: () => void; onmessage?: (event: { data: string }) => void;
  onclose?: () => void; onerror?: () => void;
  close = vi.fn(() => { this.readyState = 3; this.onclose?.(); });
  constructor(readonly url: URL) { Socket.instances.push(this); }
  send(data: string) { this.sent.push(JSON.parse(data)); }
  open() { this.readyState = 1; this.onopen?.(); }
  frame(data: unknown) { this.onmessage?.({ data: JSON.stringify(data) }); }
}
let container: HTMLDivElement, root: Root, query: QueryClient;
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
beforeEach(() => {
  vi.clearAllMocks(); mocks.allowed = true; mocks.companyId = "company"; Socket.instances = [];
  mocks.list.mockResolvedValue([{ id: "local", label: "Local" }]);
  mocks.create.mockResolvedValue({ id: "s1", token: "ephemeral-token", expiresAt: "later", wsPath: "/api/companies/company/host-terminals/local/ws" });
  vi.stubGlobal("WebSocket", Socket);
  vi.stubGlobal("ResizeObserver", class { observe() {} disconnect() {} });
  container = document.createElement("div"); document.body.appendChild(container); root = createRoot(container);
  query = new QueryClient({ defaultOptions: { queries: { retry: false } } });
});
afterEach(async () => { await act(async () => root.unmount()); query.clear(); container.remove(); vi.unstubAllGlobals(); });
async function flush() { await act(async () => { await new Promise(resolve => setTimeout(resolve, 20)); }); }
async function render() { await act(async () => root.render(<QueryClientProvider client={query}><HostTerminals /></QueryClientProvider>)); await flush(); }
async function click(text: string) {
  const button = [...container.querySelectorAll("button")].find(button => button.textContent?.includes(text));
  expect(button).toBeDefined(); await act(async () => button!.click()); await flush();
}
it("lists enabled hosts, opens a terminal, shows close reason and reconnects with a new shell", async () => {
  await render(); expect(container.textContent).toContain("Local：開啟終端");
  await click("開啟終端");
  expect(mocks.create).toHaveBeenCalledWith("company", "local");
  const ws = Socket.instances[0]!;
  expect(ws.url.search).toBe(""); // A token never enters URLs, referrers or logs.
  await act(async () => { ws.open(); ws.frame({ type: "ready" }); });
  expect(ws.sent[0]).toEqual({ type: "auth", sessionId: "s1", token: "ephemeral-token" });
  expect(container.textContent).toContain("已連線");
  await click("Ctrl+C"); expect(ws.sent.at(-1)).toEqual({ type: "input", data: "\x03" });
  await act(async () => ws.frame({ type: "closed", reason: "idle_timeout", exitCode: null }));
  expect(container.textContent).toContain("閒置 30 分鐘");
  mocks.create.mockResolvedValue({ id: "s2", token: "fresh-token", wsPath: "/api/companies/company/host-terminals/local/ws" });
  await click("重新連線"); expect(mocks.create).toHaveBeenCalledTimes(2); expect(ws.close).toHaveBeenCalled();
  expect(Socket.instances).toHaveLength(2);
});
it("closes the websocket and disposes xterm when a tab closes", async () => {
  await render(); await click("開啟終端"); const ws = Socket.instances[0]!;
  const close = container.querySelector<HTMLButtonElement>('[aria-label="關閉 Local 1"]')!;
  await act(async () => close.click());
  expect(ws.close).toHaveBeenCalled(); expect(mocks.dispose).toHaveBeenCalled();
  expect(container.querySelector('[role="tabpanel"]')).toBeNull();
});
it("unmounts existing terminals on company changes", async () => {
  await render(); await click("開啟終端"); const ws = Socket.instances[0]!;
  mocks.companyId = "another"; await render(); expect(ws.close).toHaveBeenCalled();
});
it("denies non-admins without fetching hosts or opening sessions", async () => {
  mocks.allowed = false; await render(); expect(container.textContent).toContain("僅已登入的 instance admin");
  expect(mocks.list).not.toHaveBeenCalled(); expect(mocks.create).not.toHaveBeenCalled();
});
it("shows host-list and session-creation errors", async () => {
  mocks.list.mockRejectedValue(new Error("Registry unavailable")); await render();
  expect(container.textContent).toContain("Registry unavailable");
  mocks.list.mockResolvedValue([{ id: "local", label: "Local" }]); await click("重試");
  mocks.create.mockRejectedValue(new Error("Four sessions maximum")); await click("開啟終端");
  expect(container.textContent).toContain("Four sessions maximum");
});
