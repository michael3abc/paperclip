// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ToolConnection } from "@paperclipai/shared";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { McpBrowserLogin } from "./McpBrowserLogin";

const api = vi.hoisted(() => ({ browserLoginStatus: vi.fn(), startBrowserLogin: vi.fn() }));
vi.mock("@/api/tools", () => ({ toolsApi: api }));
const connection = { id: "104", name: "104 Job Hunter", transport: "mcp_remote", config: { browserLogin: { enabled: true, allowedOrigins: ["https://login.example"] } } } as unknown as ToolConnection;

describe("custom connector account login", () => {
  let root: Root;
  let container: HTMLDivElement;
  let client: QueryClient;
  const flush = async () => { await act(async () => { await new Promise(resolve => setTimeout(resolve, 0)); }); };
  const click = async (text: string) => {
    const button = [...document.querySelectorAll("button")].find(b => b.textContent === text)!;
    expect(button).toBeTruthy();
    await act(async () => { button.click(); });
    await flush(); await flush();
  };
  async function render(value = connection, canConfigure = true) {
    await act(async () => root.render(<QueryClientProvider client={client}><McpBrowserLogin connection={value} canConfigure={canConfigure} /></QueryClientProvider>));
    await flush(); await flush();
  }
  beforeEach(() => {
    vi.clearAllMocks();
    api.browserLoginStatus.mockResolvedValue({ status: "waiting", mode: "browser" });
    container = document.createElement("div"); document.body.append(container);
    root = createRoot(container);
    client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  });
  afterEach(async () => {
    await act(async () => root.unmount()); client.clear(); container.remove(); vi.restoreAllMocks();
  });
  it("stays absent and makes no request for ordinary MCP connections", async () => {
    await render({ ...connection, config: {} });
    expect(container.textContent).toBe(""); expect(api.browserLoginStatus).not.toHaveBeenCalled();
  });
  it("does not fetch login material without configuration access", async () => {
    await render(connection, false);
    expect(container.textContent).toContain("需要連線管理權限");
    expect(api.browserLoginStatus).not.toHaveBeenCalled();
  });
  it("opens 104 in a separate browser and clears its private link on close", async () => {
    const replace = vi.fn(); const popup = { opener: window, location: { replace }, close: vi.fn() };
    vi.spyOn(window, "open").mockReturnValue(popup as unknown as Window);
    api.startBrowserLogin.mockResolvedValue({ status: "waiting", mode: "browser", url: "https://login.example/login#token=owned" });
    await render(); await click("登入帳號");
    expect(popup.opener).toBeNull(); expect(replace).toHaveBeenCalledWith("https://login.example/login#token=owned");
    expect(document.querySelector('a[href*="token=owned"]')).toBeTruthy();
    await click("關閉"); expect(document.querySelector('a[href*="token=owned"]')).toBeNull();
  });
  it("shows the SeaTalk QR and only reports success after the service confirms it", async () => {
    api.browserLoginStatus.mockResolvedValue({ status: "waiting", mode: "qr" });
    api.startBrowserLogin.mockResolvedValue({ status: "waiting", mode: "qr", qrImage: "data:image/png;base64,iVBORw==" });
    await render({ ...connection, name: "SeaTalk" }); await click("登入帳號");
    expect(document.querySelector('img[alt="SeaTalk 登入 QR Code"]')).toBeTruthy();
    expect(container.textContent).not.toContain("已登入");
    api.browserLoginStatus.mockResolvedValue({ status: "logged_in", mode: "qr" });
    await click("檢查登入狀態");
    expect(container.textContent).toContain("已登入");
    expect(document.querySelector('img[alt="SeaTalk 登入 QR Code"]')).toBeNull();
    await click("完成");
  });
  it("keeps unknown and failed states explicit", async () => {
    api.browserLoginStatus.mockResolvedValue({ status: "unknown", mode: "browser" });
    await render(); expect(container.textContent).toContain("未確認");
    api.browserLoginStatus.mockRejectedValue(new Error("Login unavailable"));
    await click("檢查登入狀態"); expect(container.textContent).toContain("Login unavailable");
    expect(container.textContent).not.toContain("已登入");
  });
});
