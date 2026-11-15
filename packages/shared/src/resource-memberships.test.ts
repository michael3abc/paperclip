import { describe, expect, it } from "vitest";
import {
  updateDocumentResourceMembershipSchema,
  updateAgentResourceMembershipSchema,
  updateResourceMembershipSchema,
} from "./validators/resource-memberships.js";

describe("resource membership contract", () => {
  it("accepts legacy state-only membership updates", () => {
    expect(updateResourceMembershipSchema.parse({ state: "left" })).toEqual({ state: "left" });
    expect(updateResourceMembershipSchema.parse({ state: "joined" })).toEqual({ state: "joined" });
  });

  it("accepts star-only updates without requiring a state mutation", () => {
    expect(updateResourceMembershipSchema.parse({ starred: true })).toEqual({ starred: true });
    expect(updateResourceMembershipSchema.parse({ starred: false })).toEqual({ starred: false });
  });

  it("rejects empty or contradictory star/state updates", () => {
    expect(() => updateResourceMembershipSchema.parse({})).toThrow("state or starred is required");
    expect(() => updateResourceMembershipSchema.parse({ state: "left", starred: true })).toThrow(
      "starred resources must be joined",
    );
  });

  it("accepts agent chat visibility independently of stars and join state", () => {
    expect(updateAgentResourceMembershipSchema.parse({ chatPinned: true })).toEqual({ chatPinned: true });
    expect(updateAgentResourceMembershipSchema.parse({ chatPinned: false })).toEqual({ chatPinned: false });
    expect(updateAgentResourceMembershipSchema.parse({ state: "left", chatPinned: false })).toEqual({ state: "left", chatPinned: false });
    expect(updateAgentResourceMembershipSchema.parse({ starred: true, chatPinned: false })).toEqual({ starred: true, chatPinned: false });
    expect(() => updateResourceMembershipSchema.parse({ chatPinned: true })).toThrow();
    expect(() => updateDocumentResourceMembershipSchema.parse({ starred: true, chatPinned: true })).toThrow();
  });

  it("rejects contradictory agent pin/leave requests, invalid values and caller identity fields", () => {
    for (const value of [{}, { state: "left", chatPinned: true }, { state: "left", starred: true },
      { chatPinned: null }, { chatPinned: "false" }, { chatPinned: false, userId: "someone-else" }]) {
      expect(() => updateAgentResourceMembershipSchema.parse(value)).toThrow();
    }
  });

  it("accepts document star updates without join state", () => {
    expect(updateDocumentResourceMembershipSchema.parse({ starred: true })).toEqual({ starred: true });
    expect(updateDocumentResourceMembershipSchema.parse({ starred: false })).toEqual({ starred: false });
    expect(() => updateDocumentResourceMembershipSchema.parse({ state: "joined", starred: true })).toThrow();
    expect(() => updateDocumentResourceMembershipSchema.parse({})).toThrow();
  });
});
