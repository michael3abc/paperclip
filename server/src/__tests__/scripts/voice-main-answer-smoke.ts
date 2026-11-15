/**
 * Bounded synthetic gateway smoke; no production DB, real microphone or native
 * ccpocket session. The fixture main performs exactly one Responses request.
 * Run from the repository root, with inherited DB configuration removed:
 *   env -u DATABASE_URL -u PAPERCLIP_TEST_POSTGRES_ADMIN_URL \
 *     pnpm --filter @paperclipai/server exec tsx src/__tests__/scripts/voice-main-answer-smoke.ts \
 *     --owned-test-db --main-model gpt-6.1-sol --realtime-model gpt-realtime-1.5
 * Stdout: one safe JSON receipt. No transcript, provider payload or credential.
 */
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { homedir } from "node:os";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { parseArgs } from "node:util";
import { eq } from "drizzle-orm";
import { agents, companies, companyMemberships, createDb, heartbeatRuns, issues, startEmbeddedPostgresTestDatabase } from "@paperclipai/db";
import type { LocalVoiceRelayServerEvent } from "@paperclipai/shared";
import { issueService } from "../../services/issues.js";
import { instanceSettingsService } from "../../services/instance-settings.js";
import { publishLiveEvent } from "../../services/live-events.js";
import { recordChatInputDispatch } from "../../services/heartbeat/chat-input-provenance.js";
import { ensureLocalVoiceEndpoint } from "../../services/voice/local-voice-endpoints.js";
import { authorizeLocalVoiceRelay, createLocalVoiceTaskPort } from "../../services/voice/local-voice-relay-port.js";
import { OpenAIRealtimeRelay } from "../../services/voice/openai-realtime-relay.js";
import { voiceSessionService } from "../../services/voice/voice-session-service.js";
import { MAIN_ANSWER_POLICY } from "../../services/voice/voice-chat-policy.js";
import { extractVoiceSummary, recitationCoverage } from "../../services/voice/voice-summary.js";

const { values } = parseArgs({ options: {
  "owned-test-db": { type: "boolean" }, "main-model": { type: "string" },
  "realtime-model": { type: "string" }, gateway: { type: "string", default: "ws://192.168.66.11:8792" },
} });
// Refuse inherited provider/admin DB selection even when the ownership flag is set.
if (!values["owned-test-db"] || process.env.DATABASE_URL || process.env.PAPERCLIP_TEST_POSTGRES_ADMIN_URL) {
  throw new Error("Requires --owned-test-db and no inherited DATABASE_URL or PAPERCLIP_TEST_POSTGRES_ADMIN_URL");
}
if (!values["main-model"] || !values["realtime-model"]) throw new Error("Explicit --main-model and --realtime-model are required");
const gateway = new URL(values.gateway!);
if (!["ws:", "wss:"].includes(gateway.protocol) || gateway.username || gateway.password || gateway.search || gateway.pathname !== "/") {
  throw new Error("Gateway must be a credential-free ws(s) origin");
}
const httpOrigin = new URL(gateway); httpOrigin.protocol = gateway.protocol === "wss:" ? "https:" : "http:";
const require = createRequire(import.meta.url);
const { WebSocket } = require("ws") as { WebSocket: new (url: string, options: Record<string, unknown>) => any };
const startedAt = performance.now();
const elapsed = () => Math.round(performance.now() - startedAt);
const abort = new AbortController();
const sockets = new Set<any>();
const deadline = setTimeout(() => abort.abort(new Error("smoke_deadline")), 120_000);
abort.signal.addEventListener("abort", () => { for (const socket of sockets) socket.terminate(); }, { once: true });
let database: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | undefined;
let db: ReturnType<typeof createDb> | undefined;
let service: ReturnType<typeof voiceSessionService> | undefined;
let relay: OpenAIRealtimeRelay | undefined;
let mic: ReturnType<typeof setInterval> | undefined;
let playback: ReturnType<typeof setTimeout> | undefined;
let stage = "setup";
const receipt: Record<string, unknown> = { case: "synthetic_main_answer_gateway", passed: false,
  nativeSessionTested: false, physicalMicrophoneTested: false, timingsMs: {}, audioBytes: { tts: 0, relay: 0, answer: 0 } };
const times = receipt.timingsMs as Record<string, number>;
const bytes = receipt.audioBytes as Record<string, number>;
let relayConnections = 0, mainRequests = 0, ttsConnections = 0;
// Error messages, stacks and provider/DB payloads can contain sensitive inputs.
// Copy only known diagnostic identifiers, including wrapped driver causes.
function safeFailure(error: unknown) {
  const classes = new Set(["Error", "AssertionError", "TypeError", "RangeError", "HttpError", "PostgresError", "DrizzleQueryError", "AbortError", "ZodError", "TestPostgresShutdownError"]);
  const codes = new Set(["ENOENT", "EACCES", "EPERM", "ECONNREFUSED", "ECONNRESET", "ETIMEDOUT", "EADDRINUSE", "ERR_ASSERTION",
    "23502", "23503", "23505", "23514", "42P01", "42703", "53300", "57P01", "08006"]);
  const labels = new Set(["gateway_key_missing", "missing_media", "tts_audio_length", "relay_reconnect_forbidden",
    "synthetic_transcription_mismatch", "main_answer_missing_or_incorrect", "main_summary_missing_or_incorrect",
    "answer_provenance_missing", "answer_recitation_mismatch", "duplicate_input", "smoke_deadline", "db_start_deadline",
    "tts_transport", "tts_closed", "tts_failed", "tts_provider", "tts_protocol", "relay_transport"]);
  const chain: { class: string; code?: string; label?: string; constraint?: string }[] = [];
  let current = error;
  for (let depth = 0; depth < 3 && current && typeof current === "object"; depth++) {
    const candidate = current as { name?: unknown; code?: unknown; message?: unknown; constraint_name?: unknown; cause?: unknown };
    const name = typeof candidate.name === "string" ? candidate.name : "";
    const code = typeof candidate.code === "string" ? candidate.code : "";
    const message = typeof candidate.message === "string" ? candidate.message : "";
    chain.push({ class: classes.has(name) ? name : "OtherError",
      ...(codes.has(code) ? { code } : {}),
      ...(labels.has(message) || /^main_http_[1-5]\d\d$/.test(message) ? { label: message } : {}),
      ...(candidate.constraint_name === "issues_conversation_identity_check" ? { constraint: "issues_conversation_identity_check" } : {}) });
    current = candidate.cause;
  }
  return chain;
}
function check() { abort.signal.throwIfAborted(); }
function bounded<T>(work: Promise<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    const stop = () => reject(new Error("smoke_deadline"));
    if (abort.signal.aborted) return stop();
    abort.signal.addEventListener("abort", stop, { once: true });
    work.then(resolve, reject).finally(() => abort.signal.removeEventListener("abort", stop));
  });
}
async function until(test: () => boolean) {
  while (!test()) { check(); await delay(50, undefined, { signal: abort.signal }); }
}
let key = "";
function socketForModel() {
  check();
  const socket = new WebSocket(`${gateway.origin}/v1/realtime?model=${encodeURIComponent(values["realtime-model"]!)}`,
    { headers: { Authorization: `Bearer ${key}` }, maxPayload: 16 * 1024 * 1024, handshakeTimeout: 10_000 });
  sockets.add(socket);
  // Never print provider errors (which can include request metadata).
  socket.on("error", () => {});
  return socket;
}
async function synthesize(): Promise<Buffer> {
  assert.equal(++ttsConnections, 1);
  const socket = socketForModel();
  const chunks: Buffer[] = [];
  let requested = false;
  try {
    await bounded(new Promise<void>((resolve, reject) => {
      socket.on("error", () => reject(new Error("tts_transport")));
      socket.on("close", () => reject(new Error("tts_closed")));
      socket.on("message", (data: Buffer) => {
        try {
          const message = JSON.parse(data.toString());
          if (message.type === "session.created") socket.send(JSON.stringify({ type: "session.update", session: {
            type: "realtime", output_modalities: ["audio"], instructions: "逐字朗讀使用者提供的句子，不回答問題，不加其他文字。",
            audio: { input: { turn_detection: null }, output: { format: { type: "audio/pcm", rate: 24000 }, voice: "cedar" } },
          } }));
          if (message.type === "session.updated" && !requested) {
            requested = true;
            socket.send(JSON.stringify({ type: "conversation.item.create", item: { type: "message", role: "user", content: [{ type: "input_text", text: "八加五等於多少？" }] } }));
            socket.send(JSON.stringify({ type: "response.create" }));
          }
          if (message.type === "response.output_audio.delta") chunks.push(Buffer.from(message.delta, "base64"));
          if (message.type === "response.done") message.response?.status === "completed" ? resolve() : reject(new Error("tts_failed"));
          if (message.type === "error") reject(new Error("tts_provider"));
        } catch { reject(new Error("tts_protocol")); }
      });
    }));
    const pcm = Buffer.concat(chunks); assert(pcm.length > 0 && pcm.length < 48000 * 15, "tts_audio_length");
    return pcm;
  } finally { socket.terminate(); sockets.delete(socket); }
}
try {
  stage = "setup_gateway_credential";
  key = (await readFile(path.join(homedir(), ".config/ccpocket/compass-gateway-key"), "utf8")).trim();
  assert(key.length > 0, "gateway_key_missing");
  // This helper allocates and owns its cluster. It never consumes DATABASE_URL.
  stage = "setup_owned_database";
  const allocation = startEmbeddedPostgresTestDatabase("paperclip-voice-main-smoke-").then(async (owned) => {
    if (abort.signal.aborted) { await owned.cleanup(); throw new Error("db_start_deadline"); }
    return owned;
  });
  database = await bounded(allocation);
  stage = "setup_database_client";
  db = createDb(database.connectionString, { maxConnections: 3 });
  const companyId = randomUUID(), agentId = randomUUID(), issueId = randomUUID(), runId = randomUUID(), userId = `voice-smoke-${randomUUID()}`;
  stage = "setup_company";
  await db.insert(companies).values({ id: companyId, name: "Owned synthetic voice smoke", issuePrefix: "VSM" });
  stage = "setup_agent";
  await db.insert(agents).values({ id: agentId, companyId, name: "Fixture main", role: "operator", status: "idle", adapterType: "paperclip_runner" });
  stage = "setup_membership";
  await db.insert(companyMemberships).values({ companyId, principalType: "user", principalId: userId, status: "active", membershipRole: "member" });
  stage = "setup_chat";
  await db.insert(issues).values({ id: issueId, companyId, title: "Synthetic main voice smoke", assigneeAgentId: agentId,
    status: "in_review", conversationAgentId: agentId, conversationUserId: userId, conversationState: "waiting", conversationSessionGeneration: 0, createdByUserId: userId });
  stage = "setup_feature_settings";
  await instanceSettingsService(db).updateExperimental({ enableChatConnectors: true, enableLocalVoice: true, enableAgentChat: true });
  stage = "setup_voice_service";
  service = voiceSessionService(db, { allowLocalBoard: false, credentials: async () => { throw new Error("unexpected_provider_credentials"); }, onQuestionAnswered: () => { throw new Error("unexpected_question_mutation"); } });
  const caller = { id: userId, authority: "member" as const };
  stage = "setup_voice_endpoint";
  const endpoint = await ensureLocalVoiceEndpoint(db, { companyId, agentId, caller, allowLocalBoard: false });
  stage = "setup_voice_session";
  const session = await service.local.start({ companyId, endpointId: endpoint.endpointId, issueId, caller,
    idempotencyKey: randomUUID(), maxDurationSeconds: 180, bindingMode: "agent_chat" });
  assert(session.media, "missing_media");
  stage = "setup_relay_authorization";
  const binding = await authorizeLocalVoiceRelay(db, service, { companyId, sessionId: session.session.id, caller, token: session.media.transportToken, allowLocalBoard: false });
  stage = "setup_relay_port";
  const port = createLocalVoiceTaskPort(db, service, { binding, caller, token: session.media.transportToken, allowLocalBoard: false });
  const comments = issueService(db);
  const events: LocalVoiceRelayServerEvent[] = [];
  let answerId: string | undefined, answerStarted = false, playbackUntil = 0;
  let spokenAnswer = "", expectedSummary = "", answerRequested = false;
  stage = "setup_relay_controller";
  relay = new OpenAIRealtimeRelay({ binding: { ...binding.issue, issueId, issueIdentifier: null, issueTitle: binding.issue.title,
    agentName: "Fixture main", mode: "agent_chat", policyVersion: MAIN_ANSWER_POLICY },
    model: values["realtime-model"], voiceName: "marin", port, reconnectDelaysMs: [],
    browser: {
      sendEvent(event) {
        events.push(event);
        if (event.type === "voice_turn" && event.state === "speaking" && event.answerCommentId === answerId) answerStarted = true;
        // Caption deltas may precede the first audio packet; capture from the
        // actual answer request, not the first playback callback.
        if (event.type === "transcript" && event.role === "model" && answerRequested) spokenAnswer += event.text;
      },
      sendAudio(pcm) {
        bytes.relay += pcm.length;
        if (answerStarted) { bytes.answer += pcm.length; times.answerAudioStart ??= elapsed(); }
        times.firstPlayback ??= elapsed();
        void relay!.handleBrowserMessage({ type: "playback", playing: true });
        playbackUntil = Math.max(Date.now(), playbackUntil) + pcm.length / 48;
        if (playback) clearTimeout(playback);
        playback = setTimeout(() => void relay!.handleBrowserMessage({ type: "playback", playing: false }), playbackUntil - Date.now() + 50);
      }, close() {},
    },
    connectUpstream: async (handlers) => {
      assert.equal(++relayConnections, 1, "relay_reconnect_forbidden");
      const socket = socketForModel();
      socket.on("message", (data: Buffer) => handlers.onMessage(data.toString()));
      socket.on("close", (code: number) => handlers.onClose(code, "smoke_transport_closed"));
      await bounded(new Promise<void>((resolve, reject) => { socket.once("open", resolve); socket.once("error", () => reject(new Error("relay_transport"))); }));
      return { send: (json: string) => {
        const frame = JSON.parse(json);
        if (expectedSummary && frame.type === "conversation.item.create"
          && frame.item?.content?.some((part: { text?: string }) => part.text?.includes(JSON.stringify(expectedSummary)))) answerRequested = true;
        socket.send(json);
      }, close: () => { socket.terminate(); sockets.delete(socket); } };
    },
  });
  stage = "tts"; const pcm = await synthesize(); bytes.tts = pcm.length; times.ttsReady = elapsed();
  stage = "relay"; await bounded(relay.start());
  const frames: Buffer[] = []; for (let offset = 0; offset < pcm.length; offset += 4800) frames.push(pcm.subarray(offset, offset + 4800));
  mic = setInterval(() => {
    if (abort.signal.aborted) return;
    const frame = frames.shift(); relay!.handleBrowserAudio(frame ?? Buffer.alloc(4800));
    if (!frames.length) times.speechEnd ??= elapsed();
  }, 100);
  await until(() => events.some(event => event.type === "dictation"));
  const dictation = events.find((event): event is Extract<LocalVoiceRelayServerEvent, { type: "dictation" }> => event.type === "dictation")!;
  assert(/(?:八|8).*(?:加|\+).*(?:五|5)/u.test(dictation.text), "synthetic_transcription_mismatch");
  stage = "chat_receipt";
  const input = await comments.addComment(issueId, dictation.body, { userId }, { authorType: "user", clientRequestId: dictation.operationId,
    metadata: { version: 1, sections: [{ rows: [{ type: "text", text: "Synthetic test input" }] }], voiceInput: { sessionId: session.session.id } } });
  times.chatStored = elapsed(); Object.assign(receipt, { operationId: dictation.operationId, inputCommentId: input.id, runId });
  await relay.handleBrowserMessage({ type: "dictation_result", operationId: dictation.operationId, commentId: input.id, status: "sent" });
  const context = { issueId, conversationSessionGeneration: 0, wakeCommentIds: [input.id] };
  await db.insert(heartbeatRuns).values({ id: runId, companyId, agentId, issueId, scopeKind: "issue", status: "running", startedAt: new Date(), contextSnapshot: context });
  await recordChatInputDispatch(db, { companyId, agentId, issueId, runId }, context);
  stage = "main_model"; assert.equal(++mainRequests, 1);
  const response = await fetch(`${httpOrigin.origin}/v1/responses`, { method: "POST", signal: abort.signal,
    headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" }, body: JSON.stringify({
      model: values["main-model"], stream: false, max_output_tokens: 1200,
      instructions: "你是此隔離測試 Chat 指定的 main。只回答使用者這一道算術題，遵守訊息中的語音來源與摘要格式。不用工具、不執行動作。",
      input: [{ role: "user", content: [{ type: "input_text", text: input.body }] }],
    }) });
  assert(response.ok, `main_http_${response.status}`);
  const generated = await response.json() as { output?: { content?: { type?: string; text?: string }[] }[] };
  const body = (generated.output ?? []).flatMap(item => item.content ?? []).filter(item => item.type === "output_text").map(item => item.text ?? "").join("\n");
  assert(body.length > 0 && /13|十三/u.test(body), "main_answer_missing_or_incorrect");
  const summary = extractVoiceSummary(body); assert(summary && /13|十三/u.test(summary), "main_summary_missing_or_incorrect");
  expectedSummary = summary;
  stage = "verified_answer";
  const answer = await comments.addComment(issueId, body, { agentId, runId });
  assert.deepEqual(answer.metadata?.voiceReply?.sourceCommentIds, [input.id], "answer_provenance_missing");
  assert.equal(answer.metadata?.voiceReply?.runId, runId);
  answerId = answer.id; receipt.answerCommentId = answerId; times.mainReply = elapsed();
  await db.update(heartbeatRuns).set({ status: "succeeded", finishedAt: new Date() }).where(eq(heartbeatRuns.id, runId));
  publishLiveEvent({ companyId, type: "activity.logged", payload: { entityId: issueId, entityType: "issue" } });
  stage = "answer_audio";
  await until(() => bytes.answer > 0 && events.some(event => event.type === "voice_turn" && event.answerCommentId === answerId && event.state === "completed"));
  const normalizeNumbers = (text: string) => text.replaceAll("13", "十三").replaceAll("8", "八").replaceAll("5", "五").replaceAll("+", "加").replaceAll("=", "等於");
  const coverage = recitationCoverage(normalizeNumbers(summary), normalizeNumbers(spokenAnswer));
  receipt.recitation = { coverage, expectedCharacters: summary.length, spokenCharacters: spokenAnswer.length, answerRequested };
  assert(coverage >= 0.8, "answer_recitation_mismatch");
  assert.equal(events.filter(event => event.type === "dictation").length, 1, "duplicate_input");
  times.speechToStored = times.chatStored - times.speechEnd;
  times.replyToAudio = times.answerAudioStart - times.mainReply;
  receipt.passed = true;
} catch (error) {
  // Keep the failed stage and safe identifiers; never emit provider bodies.
  receipt.failedStage = stage;
  receipt.failure = abort.signal.aborted ? "deadline" : error instanceof assert.AssertionError ? "assertion" : "operation_failed";
  receipt.diagnostics = safeFailure(error);
  process.exitCode = 1;
} finally {
  clearTimeout(deadline); if (mic) clearInterval(mic); if (playback) clearTimeout(playback);
  abort.abort(); for (const socket of sockets) socket.terminate(); sockets.clear();
  try { await relay?.end("caller_ended"); } catch { receipt.cleanupRelay = "failed"; process.exitCode = 1; }
  service?.unregisterAgentTools();
  try { await db?.$client.end({ timeout: 1 }); await database?.cleanup(); }
  catch { receipt.cleanupDatabase = "failed"; process.exitCode = 1; }
  receipt.elapsedMs = elapsed(); receipt.requests = { tts: ttsConnections, main: mainRequests, relay: relayConnections };
  if (process.exitCode) receipt.passed = false;
  console.log(JSON.stringify(receipt));
}
