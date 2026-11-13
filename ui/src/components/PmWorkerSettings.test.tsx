// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { PmWorkerPolicyView } from "@paperclipai/shared";
import { PmWorkerSettings } from "./PmWorkerSettings";

const api = vi.hoisted(() => ({ workerPolicy: vi.fn(), saveWorkerPolicy: vi.fn() }));
vi.mock("../api/agents", () => ({ agentsApi: api }));
const workerId = "10000000-0000-4000-8000-000000000001";
const choiceId = "10000000-0000-4000-8000-000000000002";
const fixture = (): PmWorkerPolicyView => ({ documentPath: "WORKERS.md", policy: null, revision: null, documentHash: null,
  document: "Handwritten review rules", warnings: ["Review legacy settings explicitly."],
  catalog: [{ agentId: workerId, name: "Shared Codex", harness: "codex_local", permissions: ["deny-all", "approve-reads"],
    models: [{ id: "gpt-6.1-sol", label: "Sol", thinking: ["low", "high"], speeds: ["standard", "fast"] },
      { id: "restricted-model", label: "Restricted", thinking: [], speeds: ["standard"] }] }],
});
let root: Root, container: HTMLDivElement, client: QueryClient;
async function render() {
  await act(async () => root.render(<QueryClientProvider client={client}><PmWorkerSettings agentId="pm" /></QueryClientProvider>));
  await vi.waitFor(() => expect(container.textContent).toContain("Add worker option"));
}
function button(text: string) { return [...container.querySelectorAll("button")].find(button => button.textContent === text)!; }
async function click(element: HTMLElement) { await act(async () => element.click()); }
async function select(field: string, value: string) {
  const element = container.querySelector<HTMLSelectElement>(`[aria-label="Worker 1 ${field}"]`)!;
  await act(async () => { element.value = value; element.dispatchEvent(new Event("change", { bubbles: true })); });
}
async function purpose(value: string) {
  const element = container.querySelector<HTMLInputElement>('[aria-label="Worker 1 purpose"]')!;
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(element, value);
    element.dispatchEvent(new Event("input", { bubbles: true }));
  });
}
function preview() { return JSON.parse(container.querySelector('[aria-label="Worker settings JSON"]')!.textContent!); }
beforeEach(() => {
  vi.clearAllMocks(); api.workerPolicy.mockResolvedValue(fixture());
  container = document.createElement("div"); document.body.append(container); root = createRoot(container);
  client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } });
});
afterEach(async () => { await act(async () => root.unmount()); container.remove(); client.clear(); });

describe("PM worker settings", () => {
  it("keeps the CLI worker and subscription distinct from Bridge choices", async () => {
    const data = fixture();
    const binding = { mode: "shared" as const, provider: "antigravity" as const, method: "subscription" as const,
      connectionId: workerId, grantId: choiceId };
    data.catalog = [{ agentId: workerId, name: "Shared Antigravity CLI", harness: "agy_local", permissions: ["default", "full-access"],
      models: [{ id: "gemini-4-argon-high", label: "Argon · Subscription", thinking: ["high"], speeds: ["standard"], aiConnection: binding }] }];
    api.workerPolicy.mockResolvedValue(data);
    await render(); await click(button("Add worker option"));
    expect(container.querySelector('[aria-label="Worker 1 harness"]')!.textContent).toContain("Antigravity CLI");
    await select("harness", workerId);
    await select("model", 'gemini-4-argon-high::shared:' + binding.connectionId + ':' + binding.grantId);
    await select("thinking", "high"); await select("permission", "full-access");
    await click(container.querySelector("input[type=radio]")!);
    expect(button("Save workers").disabled).toBe(false);
    expect(preview().workers[0]).toMatchObject({ harness: "agy_local", selections: [{ aiConnection: binding, model: "gemini-4-argon-high" }] });
  });
  it.each(["WORKERS.md", "PROJECT.md"] as const)("saves settings into %s and reloads the projection receipt", async (documentPath) => {
    api.workerPolicy.mockResolvedValue({ ...fixture(), documentPath });
    await render(); await click(button("Add worker option"));
    expect(container.textContent).not.toContain("Review legacy settings explicitly.");
    expect(container.textContent).not.toContain("Handwritten review rules");
    expect(container.textContent).not.toContain("Choose the default and allowed worker settings");
    await select("harness", workerId); await select("model", "gpt-6.1-sol");
    await select("thinking", "high"); await select("speed", "fast");
    await purpose('一般 coding | "檢查"');
    await click(container.querySelector("input[type=radio]")!);
    expect(button("Save workers").disabled).toBe(true);
    await select("permission", "approve-reads");
    expect(preview().workers[0].selections[0]).toMatchObject({ model: "gpt-6.1-sol", thinking: "high", speed: "fast", purpose: '一般 coding | "檢查"' });
    api.saveWorkerPolicy.mockImplementation(async (_id, input) => {
      api.workerPolicy.mockResolvedValue({ ...fixture(), documentPath, policy: input.policy, revision: "revision-1", documentHash: "a".repeat(64), warnings: [] });
      return { policy: input.policy, revision: "revision-1", documentHash: "a".repeat(64) };
    });
    await click(button("Save workers"));
    await vi.waitFor(() => expect(container.textContent).toContain(`Worker settings and ${documentPath} saved.`));
    const payload = api.saveWorkerPolicy.mock.calls[0]![1];
    expect(payload).toMatchObject({ baseRevision: null, baseHash: null, policy: { version: 2,
      workers: [{ agentId: workerId, harness: "codex_local", selections: [{ model: "gpt-6.1-sol", thinking: "high", permission: "approve-reads", speed: "fast", purpose: '一般 coding | "檢查"' }] }] } });
    expect(payload.policy.defaultSelectionId).toBe(payload.policy.workers[0].selections[0].id);
    await click(button("Discard and reload"));
    expect(container.querySelector<HTMLSelectElement>('[aria-label="Worker 1 speed"]')!.value).toBe("fast");
    expect(container.querySelector<HTMLInputElement>('[aria-label="Worker 1 purpose"]')!.value).toBe('一般 coding | "檢查"');
    await purpose("未儲存用途");
    expect(preview().workers[0].selections[0].purpose).toBe("未儲存用途");
    await click(button("Discard and reload"));
    expect(preview().workers[0].selections[0].purpose).toBe('一般 coding | "檢查"');
  });
  it("disables unsupported speed and retains the draft on a conflict", async () => {
    const initial = fixture(); initial.revision = "old"; initial.documentHash = "a".repeat(64);
    initial.policy = { version: 2, defaultSelectionId: choiceId, workers: [{ agentId: workerId, harness: "codex_local",
      selections: [{ id: choiceId, model: "gpt-6.1-sol", thinking: "high", permission: "deny-all", speed: "standard" }] }] };
    api.workerPolicy.mockResolvedValue(initial); await render(); await select("model", "restricted-model");
    expect(preview().workers[0].selections[0].purpose).toBe("");
    expect(container.querySelector<HTMLOptionElement>('[aria-label="Worker 1 speed"] option[value=fast]')!.disabled).toBe(true);
    expect(container.querySelector<HTMLSelectElement>('[aria-label="Worker 1 thinking"]')!.disabled).toBe(true);
    api.saveWorkerPolicy.mockRejectedValue(new Error("WORKERS.md changed. Reload before saving."));
    await click(button("Save workers"));
    await vi.waitFor(() => expect(container.querySelector('[role=alert]')?.textContent).toContain("changed"));
    expect(container.querySelector<HTMLSelectElement>('[aria-label="Worker 1 model"]')!.value).toBe("restricted-model");
    expect(container.textContent).not.toContain("WORKERS.md saved.");
    expect(api.saveWorkerPolicy.mock.calls[0]![1]).toMatchObject({ baseRevision: "old", baseHash: "a".repeat(64) });
  });
  it("does not report success when readback differs from the save receipt", async () => {
    const initial = fixture(); initial.policy = { version: 2, defaultSelectionId: choiceId, workers: [{ agentId: workerId, harness: "codex_local",
      selections: [{ id: choiceId, model: "gpt-6.1-sol", thinking: null, permission: "deny-all", speed: "standard" }] }] };
    api.workerPolicy.mockResolvedValue(initial); api.saveWorkerPolicy.mockResolvedValue({ revision: "different", documentHash: "b".repeat(64) });
    await render(); await click(button("Save workers"));
    await vi.waitFor(() => expect(container.querySelector('[role=alert]')?.textContent).toContain("changed after saving"));
    expect(container.textContent).not.toContain("WORKERS.md saved.");
  });
  it("pins the selected model's connection and retains it in the saved JSON", async () => {
    const binding = { mode: "delegated" as const, provider: "anthropic" as const, method: "api_key" as const,
      connectionId: "10000000-0000-4000-8000-000000000003", grantId: "10000000-0000-4000-8000-000000000004" };
    const data = fixture(); data.catalog[0]!.harness = "claude_local";
    data.catalog[0]!.models = [{ id: "Qwen3.8_RTX2080ti_Strata", label: "Qwen · Local", thinking: ["high"], speeds: ["standard"], aiConnection: binding }];
    api.workerPolicy.mockResolvedValue(data);
    await render(); await click(button("Add worker option")); await select("harness", workerId);
    await select("model", `Qwen3.8_RTX2080ti_Strata::delegated:${binding.connectionId}:${binding.grantId}`);
    await select("thinking", "high"); await select("permission", "approve-reads");
    await click(container.querySelector("input[type=radio]")!);
    expect(button("Save workers").disabled).toBe(false);
    expect(preview().workers[0].selections[0]).toMatchObject({ model: "Qwen3.8_RTX2080ti_Strata", aiConnection: binding });
    await select("harness", workerId);
    expect(preview().workers[0].selections[0].aiConnection).toBeUndefined();
    expect(button("Save workers").disabled).toBe(true);
  });
  it("labels a CC Pocket Antigravity worker and saves its explicit Full access choice", async () => {
    const data = fixture();
    data.catalog = [{ agentId: workerId, name: "Antigravity worker", harness: "ccpocket_bridge", permissions: ["default", "full-access"],
      models: [{ id: "michael-server/antigravity/gemini-test", label: "Antigravity · gemini-test", thinking: ["low", "high"], speeds: ["standard"] }] }];
    api.workerPolicy.mockResolvedValue(data);
    await render(); await click(button("Add worker option"));
    expect(container.querySelector('[aria-label="Worker 1 harness"]')!.textContent).toContain("Antigravity · Antigravity worker");
    await select("harness", workerId); await select("model", "michael-server/antigravity/gemini-test");
    await select("thinking", "high"); await select("permission", "full-access");
    await click(container.querySelector("input[type=radio]")!);
    expect(button("Save workers").disabled).toBe(false);
    expect(preview().workers[0]).toMatchObject({ agentId: workerId, harness: "ccpocket_bridge",
      selections: [{ model: "michael-server/antigravity/gemini-test", thinking: "high", permission: "full-access", speed: "standard" }] });
  });

});
