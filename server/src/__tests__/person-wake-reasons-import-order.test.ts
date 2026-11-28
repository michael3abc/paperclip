import { EXTERNAL_CHAT_MESSAGE_WAKE_REASON } from "../services/queued-comment-delivery.js";
import { PERSON_WAKE_REASONS } from "../services/heartbeat/queued-run-dispatch-order.js";
import { expect, it } from "vitest";

it("retains both person wake reasons when delivery loads before the heartbeat dispatcher", () => {
  expect([...PERSON_WAKE_REASONS]).toEqual(["task_retry", EXTERNAL_CHAT_MESSAGE_WAKE_REASON]);
  expect([...PERSON_WAKE_REASONS]).toEqual(["task_retry", "External chat message received"]);
});
