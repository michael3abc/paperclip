// @vitest-environment jsdom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AgentPermissionUpdate } from "../api/agents";
// The routed component: agents/:agentId/:tab → AgentDetailPage → ./AgentDetail.
import { ConfigurationTab } from "./AgentDetail";
import {
  PAPERCLIP_MANAGEMENT_PERMISSION_DESCRIPTION,
  PAPERCLIP_MANAGEMENT_PERMISSION_LABEL,
} from "../lib/paperclip-management-permission";

vi.mock("@/lib/router", () => ({
  useNavigate: () => vi.fn(),
  useParams: () => ({ tab: "permissions" }),
  useLocation: () => ({ pathname: "/agents/a/permissions", search: "", hash: "" }),
  useBeforeUnload: () => {},
  Link: ({ children }: { children: React.ReactNode }) => <a>{children}</a>,
  Navigate: () => null,
}));
vi.mock("../context/ToastContext", () => ({ useToastActions: () => ({ pushToast: vi.fn() }) }));
vi.mock("../components/TrustPresetSection", () => ({ TrustPresetSection: () => null }));
vi.mock("../components/AgentProjectAccessSettings", () => ({ AgentProjectAccessSettings: () => null }));
vi.mock("./agent-detail/AgentAllowedConnectors", () => ({ AgentAllowedConnectors: () => null }));

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

function agentRecord(permissions: Record<string, unknown>) {
  return {
    id: "agent-1",
    companyId: "company-1",
    urlKey: "yoyo",
    name: "yoyo",
    role: "general",
    adapterType: "ccpocket_bridge",
    adapterConfig: { role: "main" },
    runtimeConfig: {},
    permissions,
    access: { canAssignTasks: true, taskAssignSource: "explicit_grant" },
  } as never;
}

describe("routed AgentDetail permissions tab", () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
  });

  function render(permissions: Record<string, unknown>) {
    const mutate = vi.fn<(permissions: AgentPermissionUpdate) => void>();
    act(() => {
      root.render(
        <QueryClientProvider client={new QueryClient()}>
          <ConfigurationTab
            agent={agentRecord(permissions)}
            companyId="company-1"
            content="permissions"
            onDirtyChange={() => {}}
            onSaveActionChange={() => {}}
            onCancelActionChange={() => {}}
            onSavingChange={() => {}}
            updatePermissions={{ mutate, isPending: false }}
          />
        </QueryClientProvider>,
      );
    });
    return mutate;
  }

  const toggle = (label: string) =>
    container.querySelector<HTMLButtonElement>(`button[role="switch"][aria-label="${label}"]`);

  it("shows the board-granted Paperclip management switch with its saved value", () => {
    render({ canCreateAgents: false, canConfigureFixedWorkspace: true });
    expect(PAPERCLIP_MANAGEMENT_PERMISSION_LABEL).toBe("Paperclip management");
    expect(container.textContent).toContain("Paperclip management");
    expect(container.textContent).toContain(PAPERCLIP_MANAGEMENT_PERMISSION_DESCRIPTION);
    expect(container.textContent).not.toContain("Can set fixed working directories");
    expect(toggle(PAPERCLIP_MANAGEMENT_PERMISSION_LABEL)?.getAttribute("aria-checked")).toBe("true");
  });

  it("shows the switch off when the grant is absent and sends only an explicit change", () => {
    const mutate = render({ canCreateAgents: false });
    const fixed = toggle(PAPERCLIP_MANAGEMENT_PERMISSION_LABEL)!;
    expect(fixed.getAttribute("aria-checked")).toBe("false");
    act(() => fixed.click());
    expect(mutate).toHaveBeenCalledWith(expect.objectContaining({ canConfigureFixedWorkspace: true }));
  });

  it("leaves the grant out of other permission saves so the server keeps it", () => {
    const mutate = render({ canCreateAgents: false, canConfigureFixedWorkspace: true });
    const switches = [...container.querySelectorAll<HTMLButtonElement>('button[role="switch"]')];
    const createAgents = switches.find((button) =>
      button.parentElement?.textContent?.includes("Can create new agents"))!;
    act(() => createAgents.click());
    expect(mutate).toHaveBeenCalledTimes(1);
    const payload = mutate.mock.calls[0]![0];
    expect(payload.canCreateAgents).toBe(true);
    expect(Object.hasOwn(payload, "canConfigureFixedWorkspace")).toBe(false);
  });
});
