import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { DelegatedDecisionContext } from "@paperclipai/shared";
import { DelegatedDecisionStatus } from "./DelegatedDecisionStatus";

const delegation = { level: "pm", recipientAgentId: "main", revision: "r1" } as DelegatedDecisionContext;
const text = (value: Partial<DelegatedDecisionContext>) =>
  renderToStaticMarkup(<DelegatedDecisionStatus delegation={{ ...delegation, ...value }} status="pending" recipientName="Driving-XSAM" />);

describe("DelegatedDecisionStatus", () => {
  it("distinguishes a retrying delivery from a stopped one", () => {
    expect(text({})).toContain("已交 Driving-XSAM");
    expect(text({ deliveryError: "delegate_wake_not_admitted", deliveryRetryAt: "2026-11-19T09:00:00.000Z" }))
      .toContain("尚未送達，將自動重試");
    expect(text({ deliveryError: "delegation_changed" })).toContain("未能送達，仍待決議");
  });
});
