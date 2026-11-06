import { describe, expect, it } from "vitest";
import { externalOperationRejection } from "../../contracts/external-provider.js";
import {
  DOT_EXTERNAL_CODEC, GROK_EXTERNAL_CODEC, MUSE_EXTERNAL_CODEC, externalCompletionFeedback,
} from "./runnerd-external-driver.js";

const serverFeedback = "Completion report accepted. Task status will be committed after this turn and workspace finalization finish. Describe the completed work in your final response.";
const blockerFeedback = "Blocker report accepted. Explain why work cannot continue in your final response.";

it("exposes only fixed actionable completion rejections", () => {
  expect(externalOperationRejection("Dot completion requires settled tool calls")).toMatchObject({ code: "unsettled_tool_calls" });
  expect(externalOperationRejection("Dot completion is pending")).toMatchObject({ code: "completion_pending" });
  expect(externalOperationRejection("Dot completion was already accepted")).toMatchObject({ code: "completion_already_accepted" });
  const unknown = externalOperationRejection("private-provider-body-and-credential");
  expect(unknown).toEqual({ status: "rejected", message: "Runner rejected this operation; inspect the assignment and arguments before proceeding." });
});

describe("external completion feedback", () => {
  it("tells a Dot to call its finish tool and not to answer only in chat", () => {
    const feedback = externalCompletionFeedback(DOT_EXTERNAL_CODEC, serverFeedback);
    expect(feedback.startsWith(serverFeedback)).toBe(true);
    expect(feedback).toContain("paperclip_dot_finish");
    expect(feedback).toContain("exactly the same structured result");
    expect(feedback).toContain("does not end the external turn");
    expect(feedback).toContain("do not answer only in chat");
  });

  it("gives a Dot the same next step after a blocker report", () => {
    const feedback = externalCompletionFeedback(DOT_EXTERNAL_CODEC, blockerFeedback);
    expect(feedback.startsWith(blockerFeedback)).toBe(true);
    expect(feedback).toContain("paperclip_dot_finish");
  });

  it("keeps the next step when the server supplies no feedback", () => {
    const feedback = externalCompletionFeedback(DOT_EXTERNAL_CODEC);
    expect(feedback.startsWith("Completion accepted; finish the external turn.")).toBe(true);
    expect(feedback).toContain("paperclip_dot_finish");
  });

  it("leaves Grok and Muse feedback unchanged", () => {
    for (const codec of [GROK_EXTERNAL_CODEC, MUSE_EXTERNAL_CODEC]) {
      expect(externalCompletionFeedback(codec, serverFeedback)).toBe(serverFeedback);
      expect(externalCompletionFeedback(codec)).toBe("Completion accepted; finish the external turn.");
    }
  });
});
