// @vitest-environment jsdom

import { act } from "react";
import type { ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Inbox } from "lucide-react";
import { SidebarNavItem } from "./SidebarNavItem";
import { TooltipProvider } from "@/components/ui/tooltip";

const sidebarState = vi.hoisted(() => ({
  isMobile: false,
  setSidebarOpen: () => {},
}));

vi.mock("@/lib/router", () => ({
  NavLink: ({ children, to, className, ...props }: {
    children: ReactNode | ((state: { isActive: boolean }) => ReactNode);
    to: string;
    className?: string | ((state: { isActive: boolean }) => string);
  }) => {
    const resolvedClassName = typeof className === "function" ? className({ isActive: false }) : className;
    const resolvedChildren = typeof children === "function" ? children({ isActive: false }) : children;
    return (
      <a href={to} className={resolvedClassName} {...props}>
        {resolvedChildren}
      </a>
    );
  },
}));

vi.mock("../context/SidebarContext", () => ({
  useSidebar: () => sidebarState,
}));

// eslint-disable-next-line @typescript-eslint/no-explicit-any
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

describe("SidebarNavItem", () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => {
      root.unmount();
    });
    container.remove();
    vi.clearAllMocks();
  });

  function render(node: ReactNode) {
    act(() => {
      root.render(<TooltipProvider>{node}</TooltipProvider>);
    });
  }

  function link() {
    return container.querySelector("a") as HTMLAnchorElement;
  }

  function classTokens(element: Element | null | undefined) {
    return element?.className.toString().split(/\s+/).filter(Boolean) ?? [];
  }

  // The status label sits inside a wrapper span with identical text, so take the
  // innermost match (the one that carries the colour classes).
  function statusLabel(text: string) {
    return Array.from(container.querySelectorAll("span"))
      .filter((el) => el.textContent === text && el.children.length === 0)
      .at(-1);
  }

  it("shows the full label and numeric badge when expanded", () => {
    render(<SidebarNavItem to="/inbox" label="Inbox" icon={Inbox} badge={28} badgeLabel="unread" />);

    const label = Array.from(container.querySelectorAll("span")).find((el) => el.textContent === "Inbox");
    expect(label?.className).not.toContain("sr-only");
    // The numeric badge is rendered in full (not a dot) and no rail aria-label is set.
    expect(container.textContent).toContain("28");
    expect(link().getAttribute("aria-label")).toBeNull();
  });

  it("outlines icon alert badges with the streamlined sidebar surface", () => {
    render(<SidebarNavItem to="/inbox" label="Inbox" icon={Inbox} alert />);

    const alertBadge = container.querySelector('[data-slot="sidebar-icon-alert-badge"]');
    expect(alertBadge).not.toBeNull();
    expect(classTokens(alertBadge)).toContain("shadow-(--shadow-sidebar-icon-badge)");
    expect(classTokens(alertBadge)).not.toContain("shadow-(--shadow-extract-12)");
  });

  it("omits the icon slot when an item has no icon", () => {
    render(<SidebarNavItem to="/issues/one" label="Recent task" />);

    expect(link().querySelector('[data-slot="sidebar-nav-icon"]')).toBeNull();
    expect(link().firstElementChild?.textContent).toBe("Recent task");
  });

  it("uses the sidebar accent surface for the active item", () => {
    render(<SidebarNavItem to="/issues" label="Tasks" icon={Inbox} active />);

    expect(classTokens(link())).toContain("bg-sidebar-accent");
    expect(classTokens(link())).toContain("text-sidebar-accent-foreground");
    expect(classTokens(link())).not.toContain("bg-background");
  });

  it("uses the legible sidebar accent surface for hover", () => {
    render(<SidebarNavItem to="/issues" label="Tasks" icon={Inbox} />);

    expect(classTokens(link())).toContain("hover:bg-sidebar-accent");
    expect(classTokens(link())).toContain("hover:text-sidebar-accent-foreground");
    expect(classTokens(link())).not.toContain("hover:bg-background");
  });

  describe("agent status", () => {
    it("frames a working row in blue and labels it working", () => {
      render(<SidebarNavItem to="/agents/all-set" label="All-Set" icon={Inbox} status="working" />);

      expect(link().getAttribute("data-agent-status")).toBe("working");
      expect(classTokens(link())).toContain("ring-1");
      expect(classTokens(link())).toContain("ring-inset");
      expect(classTokens(link()).some((token) => token.startsWith("ring-blue-"))).toBe(true);
      expect(classTokens(link()).some((token) => token.startsWith("ring-orange-"))).toBe(false);
      const label = statusLabel("working");
      expect(label).toBeTruthy();
      expect(classTokens(label)).toContain("text-blue-600");
    });

    it("frames a row that pending in orange and labels it pending", () => {
      render(<SidebarNavItem to="/agents/all-set" label="All-Set" icon={Inbox} status="needs_input" />);

      expect(link().getAttribute("data-agent-status")).toBe("needs_input");
      expect(classTokens(link()).some((token) => token.startsWith("ring-orange-"))).toBe(true);
      expect(classTokens(link()).some((token) => token.startsWith("ring-blue-"))).toBe(false);
      const label = statusLabel("pending");
      expect(label).toBeTruthy();
      expect(classTokens(label)).toContain("text-orange-600");
    });

    it("replaces the live count with the status label, so the two never stack", () => {
      render(<SidebarNavItem to="/agents/all-set" label="All-Set" icon={Inbox} liveCount={2} status="working" />);

      expect(container.textContent).toContain("working");
      expect(container.textContent).not.toContain("2 live");
    });

    it("shows the status label for a row that is not live-counted", () => {
      render(<SidebarNavItem to="/agents/all-set" label="All-Set" icon={Inbox} status="needs_input" />);

      expect(container.textContent).toContain("pending");
    });

    it("pulses the working dot", () => {
      render(<SidebarNavItem to="/agents/a" label="A" icon={Inbox} status="working" />);

      expect(container.querySelector("[class*='animate-pulse']")).not.toBeNull();
    });

    it("keeps the needs-input dot still", () => {
      render(<SidebarNavItem to="/agents/a" label="A" icon={Inbox} status="needs_input" />);

      expect(container.querySelector("[class*='animate-pulse']")).toBeNull();
    });

    it("leaves a row without a status untouched", () => {
      render(<SidebarNavItem to="/agents/momo" label="momo" icon={Inbox} />);

      expect(link().hasAttribute("data-agent-status")).toBe(false);
      expect(classTokens(link()).some((token) => token.startsWith("ring-blue-"))).toBe(false);
      expect(classTokens(link()).some((token) => token.startsWith("ring-orange-"))).toBe(false);
      expect(container.textContent).not.toContain("working");
      expect(container.textContent).not.toContain("pending");
    });
  });

  it("uses an explicit neutral keyboard focus ring instead of the browser default outline", () => {
    render(<SidebarNavItem to="/agents/momo" label="momo" icon={Inbox} />);

    const tokens = classTokens(link());
    expect(tokens).toContain("focus-visible:outline-none");
    expect(tokens).toContain("focus-visible:ring-2");
    expect(tokens).toContain("focus-visible:ring-inset");
    expect(tokens).toContain("focus-visible:ring-ring");
    expect(tokens.some((token) => token.startsWith("focus-visible:ring-blue-"))).toBe(false);
  });
});
