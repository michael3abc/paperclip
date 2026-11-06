import { createHash, createHmac, randomBytes } from "node:crypto";
import { describe, expect, it } from "vitest";
import { CHAT_PROVIDERS, startVoiceSessionSchema, voiceConfirmedTextSchema } from "@paperclipai/shared";
import {
  LOCAL_VOICE_CONTROL_LIMIT, LocalVoiceProtocolError, localVoiceCommand, localVoiceToolDefinitions, localVoiceToolResult, parseLocalVoiceToolMessage,
} from "../services/voice/local-voice-protocol.js";
import { spekoToolCommand, spekoToolDefinitions, spekoToolEnvelopeSchema, verifySpekoToolRequest } from "../services/voice/speko-protocol.js";
import { LOCAL_VOICE_CAPABILITIES, SPEKO_VOICE_CAPABILITIES } from "../services/voice/voice-provider-port.js";

const sha256 = (value: string) => createHash("sha256").update(value).digest("hex");
const operationId = "6f1f3b5e-8d0a-4c7c-9b8e-1f2a3b4c5d6e", draftId = "0a1b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c4d";
const interactionId = "1b2c3d4e-5f6a-4b7c-8d9e-0f1a2b3c4d5e";
const submit = { v: 1, type: "tool", toolCallId: "call_1", tool: "submit_request", operationId, confirmation: { draftId, revision: 2 }, args: { text: "Book the train" } };
const answer = { v: 1, type: "tool", toolCallId: "call_2", tool: "answer_question", operationId, args: { interactionId, answers: [{ questionId: "color", optionIds: ["cobalt"] }] } };
const updates = { v: 1, type: "tool", toolCallId: "call_3", tool: "get_updates", args: { cursor: 4, repeat: true } };
const parse = (value: unknown) => parseLocalVoiceToolMessage(Buffer.from(typeof value === "string" ? value : JSON.stringify(value)));
const code = (fn: () => unknown) => { try { fn(); } catch (error) { return error instanceof LocalVoiceProtocolError ? error.code : `unexpected:${String(error)}`; } return "accepted"; };

describe("voice.control.v1 strict parser", () => {
  it("accepts exactly the three tools", () => {
    expect(parse(submit)).toEqual(submit);
    expect(parse(answer)).toEqual(answer);
    expect(parse(updates)).toEqual(updates);
    expect(localVoiceToolDefinitions().map((tool) => tool.name)).toEqual(["submit_request", "answer_question", "get_updates"]);
  });
  it("rejects non-JSON, unknown tools, wrong versions, identity fields and malformed ids", () => {
    const cases: Array<[string, unknown, string]> = [
      ["non-JSON", "submit please", "invalid_json"],
      ["empty body", "", "invalid_json"],
      ["null", "null", "invalid_message"],
      ["cancel_work is out of scope", { ...submit, tool: "cancel_work" }, "invalid_message"],
      ["v0 / missing version", { ...submit, v: undefined }, "invalid_message"],
      ["v2", { ...submit, v: 2 }, "invalid_message"],
      ["string version", { ...submit, v: "1" }, "invalid_message"],
      ["wrong frame type", { ...submit, type: "tool_result" }, "invalid_message"],
      ["companyId", { ...submit, companyId: operationId }, "invalid_message"],
      ["agentId", { ...updates, agentId: operationId }, "invalid_message"],
      ["sessionId", { ...updates, sessionId: operationId }, "invalid_message"],
      ["args.issueId", { ...submit, args: { text: "x", issueId: operationId } }, "invalid_message"],
      ["args.projectId", { ...updates, args: { cursor: 0, projectId: operationId } }, "invalid_message"],
      ["answer assignee", { ...answer, args: { ...answer.args, assigneeAgentId: operationId } }, "invalid_message"],
      ["non-uuid operation", { ...submit, operationId: "op-1" }, "invalid_message"],
      ["non-uuid interaction", { ...answer, args: { ...answer.args, interactionId: "q1" } }, "invalid_message"],
      ["missing confirmation", { ...submit, confirmation: undefined }, "invalid_message"],
      ["revision zero", { ...submit, confirmation: { draftId, revision: 0 } }, "invalid_message"],
      ["empty text", { ...submit, args: { text: "" } }, "invalid_message"],
      ["whitespace text", { ...submit, args: { text: " \n " } }, "invalid_message"],
      ["padded text", { ...submit, args: { text: " Book the train " } }, "invalid_message"],
      ["text over limit", { ...submit, args: { text: "x".repeat(16_001) } }, "invalid_message"],
      ["answer without operation", { ...answer, operationId: undefined }, "invalid_message"],
      ["negative cursor", { ...updates, args: { cursor: -1 } }, "invalid_message"],
      ["toolCallId injection", { ...updates, toolCallId: "a b" }, "invalid_message"],
      ["Speko envelope is not v1", { session_id: "s", tool_call_id: "c", idempotency_key: "s:c", tool: "get_updates", args: { cursor: 0 } }, "invalid_message"],
      ["oversized", "x".repeat(LOCAL_VOICE_CONTROL_LIMIT + 1), "body_too_large"],
    ];
    for (const [label, value, expected] of cases) expect(code(() => parse(value)), label).toBe(expected);
  });
  it("tool definitions expose no identity fields and forbid additional properties", () => {
    const json = JSON.stringify(localVoiceToolDefinitions());
    for (const field of ["companyId", "agentId", "issueId", "projectId", "assignee", "sessionId", "userId"]) expect(json).not.toContain(field);
    for (const tool of localVoiceToolDefinitions()) expect(tool.parameters.additionalProperties).toBe(false);
  });
  it("translates to the provider-neutral command with a fingerprint over the exact validated message", () => {
    const command = localVoiceCommand(parse(submit), { sessionId: draftId, providerSessionId: `local:${draftId}` });
    expect(command).toEqual({
      provider: "local_voice", providerSessionId: `local:${draftId}`, toolCallId: "call_1", fingerprint: sha256(JSON.stringify(submit)),
      webhookId: `local:${draftId}:call_1`, command: { tool: "submit_request", args: { text: "Book the train" } }, operationId, confirmation: { draftId, revision: 2 },
    });
    expect(localVoiceCommand(parse(updates), { sessionId: draftId, providerSessionId: `local:${draftId}` })).not.toHaveProperty("operationId");
  });
  it("wraps results so a tool status never overwrites the frame status", () => {
    expect(localVoiceToolResult("call_1", 200, { status: "accepted", receipt: { operationId } })).toEqual({ v: 1, type: "tool_result", toolCallId: "call_1", status: 200, result: { status: "accepted", receipt: { operationId } } });
  });
  it("confirmed text must be canonical and non-empty", () => {
    expect(voiceConfirmedTextSchema.safeParse("Line one\r\n  line two").success).toBe(true);
    for (const value of ["", " ", "\n", " padded", "padded\n"]) expect(voiceConfirmedTextSchema.safeParse(value).success, JSON.stringify(value)).toBe(false);
  });
});

describe("provider capabilities", () => {
  it("local voice is browser-only with no phone, provider media, push, reports or signed webhooks", () => {
    expect(LOCAL_VOICE_CAPABILITIES).toEqual({ browser: true, outboundPhone: false, inboundPhone: false, providerMedia: false, replyPush: false, callReports: false, signedWebhooks: false });
    expect(Object.values(SPEKO_VOICE_CAPABILITIES).every(Boolean)).toBe(true);
    expect(CHAT_PROVIDERS).toContain("local_voice");
    expect(CHAT_PROVIDERS).toContain("speko");
  });
  it("only voice_task is a valid binding mode and Speko start bodies stay valid", () => {
    const base = { endpointId: operationId, idempotencyKey: draftId };
    expect(startVoiceSessionSchema.safeParse(base).success).toBe(true);
    expect(startVoiceSessionSchema.safeParse({ ...base, bindingMode: "voice_task" }).success).toBe(true);
    for (const bindingMode of ["owner_chat", "console", ""]) expect(startVoiceSessionSchema.safeParse({ ...base, bindingMode }).success).toBe(false);
  });
});

describe("Speko legacy compatibility", () => {
  function signed(body: string) {
    const secret = `whsec_${randomBytes(32).toString("base64")}`;
    const webhookId = "msg_test_1", timestamp = String(Math.floor(Date.now() / 1000));
    const signature = createHmac("sha256", Buffer.from(secret.slice(6), "base64")).update(`${webhookId}.${timestamp}.${body}`).digest("base64");
    return { body: Buffer.from(body), headers: { "webhook-id": webhookId, "webhook-timestamp": timestamp, "webhook-signature": `v1,${signature}` }, keys: [{ secret }] };
  }
  it("keeps the Speko fingerprint (sha256 of the parsed envelope JSON) and maps it to the neutral command unchanged", () => {
    const envelope = { session_id: "sess_1", tool_call_id: "call_9", idempotency_key: "sess_1:call_9", tool: "submit_request", args: { text: "  Book the train  " } };
    const verified = verifySpekoToolRequest(signed(JSON.stringify(envelope)));
    // Speko still trims through its schema; the stored fingerprint is computed exactly as before.
    expect(verified.envelope.args).toEqual({ text: "Book the train" });
    expect(verified.fingerprint).toBe(sha256(JSON.stringify({ ...envelope, args: { text: "Book the train" } })));
    expect(spekoToolCommand(verified)).toEqual({ provider: "speko", providerSessionId: "sess_1", toolCallId: "call_9", fingerprint: verified.fingerprint, webhookId: "msg_test_1", command: { tool: "submit_request", args: { text: "Book the train" } } });
  });
  it("Speko does not accept a v1 local control message and v1 does not accept a Speko envelope", () => {
    expect(spekoToolEnvelopeSchema.safeParse(updates).success).toBe(false);
    expect(() => verifySpekoToolRequest(signed(JSON.stringify(updates)))).toThrow("invalid_envelope");
  });
  it("keeps the Speko HTTPS rule and the exact tool definitions", () => {
    expect(() => spekoToolDefinitions("http://127.0.0.1/api/voice")).toThrow("HTTPS");
    const definitions = spekoToolDefinitions("https://paperclip.example/api/voice-webhooks/speko/tools");
    expect(definitions.map((tool) => tool.name)).toEqual(["submit_request", "answer_question", "get_updates"]);
    // Pinned: speko-protocol.ts changed only additively (spekoToolCommand) since base eb25e2472.
    expect(sha256(JSON.stringify(definitions))).toBe("c2b84f2c91cdfe1d0e0900e8dc4ed4f98069ed02f5e5ba5af33776c58fb6a0ee");
  });
});
