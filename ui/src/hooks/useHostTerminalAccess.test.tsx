// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { useHostTerminalAccess } from "./useHostTerminalAccess";
const mocks = vi.hoisted(() => ({ access: vi.fn(), userId: "owner", settled: true, failed: false }));
vi.mock("@/api/access", () => ({ accessApi: { getCurrentBoardAccess: mocks.access } }));
vi.mock("@/api/client", () => ({ detachInflightGet: vi.fn() }));
vi.mock("@/api/companies-query", () => ({ useAccountIdentity: () => mocks }));
let root: Root, container: HTMLDivElement, query: QueryClient, allowed: boolean;
const owner = { source: "session", userId: "owner", isInstanceAdmin: true, companyIds: ["company"] };
function Probe() { allowed = useHostTerminalAccess("company").allowed; return null; }
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
beforeEach(() => {
  mocks.userId = "owner"; mocks.settled = true; mocks.failed = false;
  mocks.access.mockReset().mockResolvedValue(owner);
  container = document.createElement("div"); document.body.appendChild(container); root = createRoot(container);
  query = new QueryClient({ defaultOptions: { queries: { retry: false } } });
});
afterEach(async () => { await act(async () => root.unmount()); query.clear(); container.remove(); });
async function render() {
  await act(async () => root.render(<QueryClientProvider client={query}><Probe /></QueryClientProvider>));
  await act(async () => { await new Promise(resolve => setTimeout(resolve, 20)); });
}
it("allows only a current signed-in admin in the selected company", async () => { await render(); expect(allowed).toBe(true); });
it.each([{ source: "board_key" }, { source: "local_implicit" }, { isInstanceAdmin: false }, { companyIds: ["foreign"] }, { userId: "previous-account" }])("rejects other access: %j", async patch => {
  mocks.access.mockResolvedValue({ ...owner, ...patch }); await render(); expect(allowed).toBe(false);
});
it("does not preserve cached admin authority after an access-read failure", async () => {
  await render(); expect(allowed).toBe(true);
  mocks.access.mockRejectedValue(new Error("Forbidden"));
  await act(async () => { await query.invalidateQueries({ queryKey: ["host-terminal-access", "owner"] }); });
  await act(async () => { await new Promise(resolve => setTimeout(resolve, 20)); });
  expect(allowed).toBe(false);
});
