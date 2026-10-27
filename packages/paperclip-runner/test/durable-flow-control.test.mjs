import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { EventEmitter } from 'node:events';
import { createCipheriv } from 'node:crypto';

const vendor = fileURLToPath(new URL('../dist/', import.meta.url));
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'paperclip-flow-'));
const patched = fs.readFileSync(path.join(vendor, 'control-plane/durable-prp-control-plane.js'), 'utf8');
const modulePath = path.join(root, 'control.mjs');
// Expose private admission only in this disposable copy. Wire crypto is left
// intact in production; tests below separately exercise socket framing.
function instrument(source) {
  return source.replace(/from "(\.\.?\/[^"\n]+)"/g, (_, rel) => `from ${JSON.stringify(pathToFileURL(path.resolve(vendor, 'control-plane', rel)).href)}`)
    .replace('isAuthenticated: () => connection.secureChannel !== null,', 'isAuthenticated: () => connection.secureChannel !== null, testConnection: connection,')
    .replace('writeFileSync(descriptor, contents, "utf8");', 'writeFileSync(descriptor, contents, "utf8"); globalThis.runnerTestFault?.("write");')
    .replace('fsyncSync(descriptor);\n        closeSync(descriptor);', 'fsyncSync(descriptor); globalThis.runnerTestFault?.("file_fsync");\n        closeSync(descriptor);')
    .replace('renameSync(temporary, path);', 'renameSync(temporary, path); globalThis.runnerTestFault?.("rename");')
    .replace('syncParentDirectory(path);', 'syncParentDirectory(path); globalThis.runnerTestFault?.("directory_fsync");')
    .replace('export class DurablePrpControlPlane {', `export class DurablePrpControlPlane {
      testConnection() {
        const connection = { lease: { protocolVersion: 3, leaseId: 'lease' }, connectionId: 'conn', terminalLifecycleCommandId: null, replayOnly: false,
          sent: [], sendJson(value) { this.sent.push(value); },
          close: () => this.#connections.delete(connection) };
        this.#connections.add(connection); return connection;
      }
      testEvent(connection, envelope) { return this.#event(connection, envelope); }
      testResult(connection, result) { this.#commandResult(connection, { payload: result }); }
      testDrain() { return this.#authorityProcessing; }
      testQueueBudget() { return { frames: this.#queuedFrames, bytes: this.#queuedBytes }; }
    `)
    + '\nexport { DurableCoreStore, RawWebSocketWireConnection, canonicalDigest };\n';
}
fs.writeFileSync(modulePath, instrument(patched));
const { DurablePrpControlPlane: Core, DurableCoreStore: Store, RawWebSocketWireConnection: Wire, canonicalDigest } = await import(pathToFileURL(modulePath));
const identity = { runnerInstanceId: 'runner', environmentLeaseId: 'env', runId: 'run', normalizedSessionId: 'session', turnId: 'turn', itemId: 'item' };
function fixture(onSemanticToolInput, onCommittedEvent) {
  const stateDirectory = fs.mkdtempSync(path.join(root, 'state-'));
  const core = new Core({ stateDirectory, identity, expectedRunnerVersion: 'test', expectedRunnerDigest: 'sha256:' + 'a'.repeat(64), onSemanticToolInput, onCommittedEvent });
  return { core, conn: core.testConnection(), stateDirectory };
}
function event(seq, type = 'item.delta', payload = { text: `字${seq}`, kind: 'agentMessage', channel: 'unknown' }) {
  return { ...identity, protocol: 'paperclip.runner', version: 3, kind: 'event', envelopeId: `envelope_${seq}`, payload: {
    schema: 'paperclip.prp.event.v1', sourceKind: 'runner', sourceInstanceId: identity.runnerInstanceId,
    runId: identity.runId, normalizedSessionId: identity.normalizedSessionId, turnId: identity.turnId, itemId: identity.itemId,
    sourceEventId: `event_${seq}`, sourceSeq: seq, eventType: type, schemaVersion: 1, priority: 1,
    emittedAt: '2026-10-26T00:00:00.000Z', payload,
  } };
}
function semantic(seq, callId = 'finish') {
  const input = { summary: 'fixture completed' };
  return event(seq, 'semantic_tool.input', { semantic_tool: { schema: 'paperclip.prp.semantic_tool.v1', schemaVersion: 1,
    phase: 'input', callId, operationId: 'paperclip_finish', input, idempotencyKey: null,
    content: { digest: `sha256:${canonicalDigest(input)}`, redactionDisposition: 'digest_only', references: [] },
    correlation: { runId: 'run', normalizedSessionId: 'session', turnId: 'turn', itemId: 'item' },
  } });
}
const tick = () => new Promise(resolve => setImmediate(resolve));

test('presentation stays invisible and unacknowledged until durable flush, survives reload', async () => {
  const { core, conn, stateDirectory } = fixture();
  await core.testEvent(conn, event(1));
  assert.equal(core.store.state.ackedSourceSeq, 0);
  assert.equal(conn.sent.length, 0);
  assert.equal(JSON.parse(fs.readFileSync(core.store.path)).ackedSourceSeq, 0);
  core.queueCommand('session.snapshot'); // control barrier
  assert.equal(core.store.state.ackedSourceSeq, 1);
  assert.equal(conn.sent[0].payload.ackedSourceSeq, 1);
  assert.equal(new Store(stateDirectory, identity).state.committedEvents[0].envelope.payload.payload.text, '字1');
  await core.stop();
});

test('timer flush, duplicate replay, out-of-order rejection and replay conflicts', async () => {
  const { core, conn } = fixture();
  await core.testEvent(conn, event(1));
  await new Promise(resolve => setTimeout(resolve, 25));
  assert.equal(core.store.state.ackedSourceSeq, 1);
  await core.testEvent(conn, event(1));
  assert.equal(core.store.state.replayDeliveries, 1);
  await core.testEvent(conn, event(3));
  assert.equal(core.activeRunnerConnectionCount(), 0);
  const next = core.testConnection();
  await core.testEvent(next, event(2));
  await core.testEvent(next, event(2, 'item.delta', { text: 'changed' }));
  assert.equal(core.activeRunnerConnectionCount(), 0);
  assert.equal(core.store.state.ackedSourceSeq, 2);
  await core.stop();
});

test('finish input flushes deltas; result is durable, replay does not repeat side effect, settlement requires delivery', async () => {
  let effects = 0;
  const { core, conn, stateDirectory } = fixture(async () => { effects++; return { ok: true }; });
  for (let i = 1; i <= 63; i++) await core.testEvent(conn, event(i));
  assert.equal(core.store.state.ackedSourceSeq, 0);
  const input = semantic(64);
  await core.testEvent(conn, input);
  await tick();
  assert.equal(effects, 1);
  assert.equal(core.semanticToolResultsSettled(), false);
  const command = core.store.state.commands.find(c => c.type === 'semantic_tool.result');
  assert.ok(command);
  assert.equal(new Store(stateDirectory, identity).state.commands[0].commandId, command.commandId);
  await core.testEvent(conn, input);
  assert.equal(effects, 1);
  const result = { commandId: command.commandId, controllerSeq: command.controllerSeq, commandType: command.type, status: 'completed' };
  core.testResult(conn, result);
  assert.equal(core.semanticToolResultsSettled(), true);
  core.testResult(conn, result);
  assert.equal(core.store.state.duplicateCommandResults, 1);
  await core.stop();
  const reloaded = new Core({ stateDirectory, identity, expectedRunnerVersion: 'test', expectedRunnerDigest: 'sha256:' + 'a'.repeat(64), onSemanticToolInput: async () => { effects++; } });
  await reloaded.testEvent(reloaded.testConnection(), input);
  assert.equal(effects, 1);
  await reloaded.stop();
});

test('uncertain semantic effect stays pending after restart, never redispatched', async () => {
  let effects = 0;
  const { core, conn, stateDirectory } = fixture(async () => { effects++; throw new Error('secret not for logs'); });
  await core.testEvent(conn, semantic(1));
  await tick();
  assert.equal(core.semanticToolResultsSettled(), false);
  assert.equal(JSON.stringify(core.semanticToolSettlementDiagnostics()).includes('secret'), false);
  await core.stop();
  const reloaded = new Core({ stateDirectory, identity, expectedRunnerVersion: 'test', expectedRunnerDigest: 'sha256:' + 'a'.repeat(64), onSemanticToolInput: async () => { effects++; } });
  await reloaded.testEvent(reloaded.testConnection(), semantic(1));
  assert.equal(effects, 1);
  assert.equal(reloaded.semanticToolResultsSettled(), false);
  await reloaded.stop();
});

test('write failure latches authority; no ACK or later overwrite', async () => {
  const { core, conn } = fixture();
  await core.testEvent(conn, event(1));
  fs.unlinkSync(core.store.path);
  fs.mkdirSync(core.store.path); // rename must fail, after temporary file fsync
  assert.throws(() => core.queueCommand('session.snapshot'));
  assert.equal(conn.sent.length, 0);
  assert.equal(core.store.state.ackedSourceSeq, 0);
  assert.throws(() => core.store.save(), /indeterminate/);
  await assert.rejects(core.stop(), /indeterminate/);
  assert.equal(core.activeRunnerConnectionCount(), 0);
  assert.doesNotThrow(() => core.disconnectActiveRunner());
  fs.rmdirSync(core.store.path);
  assert.throws(() => core.store.save(), /indeterminate/);
});

test('write/fsync/rename/directory-fsync faults never publish or ACK uncertain batch', async () => {
  for (const stage of ['write', 'file_fsync', 'rename', 'directory_fsync']) {
    const { core, conn, stateDirectory } = fixture();
    await core.testEvent(conn, event(1));
    globalThis.runnerTestFault = point => { if (point === stage) throw Object.assign(new Error(stage), { code: 'EIO' }); };
    try { assert.throws(() => core.queueCommand('session.snapshot')); }
    finally { delete globalThis.runnerTestFault; }
    assert.equal(conn.sent.length, 0);
    assert.equal(core.store.state.ackedSourceSeq, 0);
    assert.throws(() => core.store.assertWritable(), /indeterminate/);
    const recovered = new Store(stateDirectory, identity).state;
    assert.equal(recovered.ackedSourceSeq, ['rename', 'directory_fsync'].includes(stage) ? 1 : 0);
  }
});

class Peer {
  sent = []; pauses = 0; resumes = 0;
  onJson(fn) { this.receive = fn; }
  onClose(fn) { this.closed = fn; }
  close() { this.closed(); }
  sendJson(value) { this.sent.push(value); }
  pause() { this.pauses++; }
  resume() { this.resumes++; }
}
function encryptedPeer(core, suffix) {
  const wire = new Peer();
  const { testConnection: connection } = core.attachWireConnection(wire);
  const channel = { sendKey: Buffer.alloc(32, 1), receiveKey: Buffer.alloc(32, 2), sendCounter: 0n, receiveCounter: 0n, sessionId: suffix };
  connection.secureChannel = channel;
  connection.connectionId = suffix;
  connection.lease = { credentialId: suffix, leaseId: suffix, protocolVersion: 3, revokedAt: null, expiresAtUnixMs: Date.now() + 60000 };
  core.store.state.leases[suffix] = connection.lease;
  let counter = 0;
  return { wire, connection, send(value) {
    const nonce = Buffer.alloc(12); nonce.write('P3C1'); nonce.writeBigUInt64BE(BigInt(counter), 4);
    const cipher = createCipheriv('aes-256-gcm', channel.receiveKey, nonce);
    cipher.setAAD(Buffer.from(`paperclip.runner.secure-frame.v1\0${suffix}\0client_to_core\0${counter}`));
    const ciphertext = Buffer.concat([cipher.update(JSON.stringify(value)), cipher.final(), cipher.getAuthTag()]);
    wire.receive({ schema: 'paperclip.runner.secure-frame.v1', counter: counter++, ciphertext: ciphertext.toString('hex') });
  } };
}
test('encrypted burst has backpressure, yields, and serializes old/new peers across delayed commits', async () => {
  let release, admitted = false, concurrent = 0, maximum = 0;
  const blocked = new Promise(resolve => { release = resolve; });
  const { core, conn } = fixture(undefined, async e => {
    maximum = Math.max(maximum, ++concurrent);
    if (e.sourceSeq === 1 && !admitted) { admitted = true; await blocked; }
    concurrent--;
  });
  conn.close();
  const old = encryptedPeer(core, 'old'), next = encryptedPeer(core, 'next');
  old.send(event(1));
  await tick();
  old.connection.close();
  for (let i = 1; i <= 130; i++) next.send(event(i));
  assert.ok(next.wire.pauses > 0);
  release();
  await core.testDrain();
  await new Promise(resolve => setTimeout(resolve, 15));
  assert.equal(maximum, 1);
  assert.equal(core.store.state.ackedSourceSeq, 130);
  assert.ok(next.wire.resumes > 0);
  assert.ok(next.wire.sent.length > 0);
  await core.stop();
  await core.drainPendingConnectionProcessing();
});

test('consumer pump uses bounded indexed batches, retains gaps and epoch fencing', () => {
  const source = fs.readFileSync(path.join(vendor, 'live/runnerd-codex-transport.js'), 'utf8');
  const body = source.split('    #pumpEvents() {')[1].split('    #applyProviderIdentityEvent(event) {')[0].replace(/}\s*$/, '').replace(/this\.#/g, 'this._');
  const pump = new Function('recoveryIdentityMatches', 'record', 'performance', body);
  let accesses = 0;
  const events = Array.from({ length: 4096 }, (_, i) => ({ sourceSeq: i + 1, eventType: 'harness.ready', envelope: { payload: { payload: {} } } }));
  const observed = new Proxy(events, { get(target, key) { if (/^\d+$/.test(String(key))) accesses++; return target[key]; } });
  const got = [];
  const context = { _core: { store: { state: { identity, committedEvents: observed }, assertWritable() {} } }, _eventIdentity: identity,
    _flushPendingTraceRehydrations() {}, _eventSourceSeq: 0, _deferredTurnStartEvents: [], _applyProviderIdentityEvent(e) { got.push(e.sourceSeq); } };
  const run = () => pump.call(context, (a, b) => a === b, x => x, { now: () => 0 });
  run(); assert.equal(got.length, 128);
  while (context._eventSourceSeq < 4096) run();
  assert.deepEqual(got, events.map(e => e.sourceSeq));
  assert.ok(accesses < 5000, `indexed accesses=${accesses}`);
  const before = accesses; run(); assert.ok(accesses - before < 20, 'idle poll is logarithmic');
  context._eventIdentity = {}; run(); assert.equal(got.length, 4096);
  context._eventIdentity = identity; context._eventSourceSeq = 0;
  context._core.store.state.committedEvents = events.slice(10);
  assert.throws(run, /window advanced/);
});

test('many reconnecting peers share one queue budget and a stop joins delayed work', async () => {
  let release;
  const held = new Promise(resolve => { release = resolve; });
  let entered = false;
  const { core, conn } = fixture(undefined, async () => { entered = true; await held; });
  conn.close();
  const owner = encryptedPeer(core, 'owner');
  owner.send(event(1));
  await tick(); assert.equal(entered, true);
  const peers = Array.from({ length: 10 }, (_, i) => encryptedPeer(core, `peer${i}`));
  for (const peer of peers) for (let i = 0; i < 500; i++) peer.send(event(i + 1));
  const budget = core.testQueueBudget();
  assert.ok(budget.frames <= 4096);
  assert.ok(budget.bytes <= 8 * 1024 * 1024);
  await core.stop();
  assert.equal(core.activeRunnerConnectionCount(), 0);
  release();
  await core.drainPendingConnectionProcessing();
  assert.deepEqual(core.testQueueBudget(), { frames: 0, bytes: 0 });
  assert.equal(core.store.state.ackedSourceSeq, 0, 'closed callback cannot publish a new owner');
});

test('epoch rotation flushes old batch and delayed old callback cannot contaminate new identity', async () => {
  let release;
  const held = new Promise(resolve => { release = resolve; });
  const { core, conn, stateDirectory } = fixture(undefined, async e => { if (e.sourceSeq === 2) await held; });
  await core.testEvent(conn, event(1));
  const pending = core.testEvent(conn, event(2));
  await tick();
  const nextIdentity = { ...identity, runId: 'run_next', turnId: 'turn_next', itemId: 'item_next' };
  core.rotateRunIdentity(nextIdentity);
  release(); await pending;
  assert.equal(core.store.state.identity.runId, 'run_next');
  assert.equal(core.store.state.ackedSourceSeq, 0);
  assert.equal(core.store.state.committedEvents.length, 0);
  assert.equal(new Store(stateDirectory, nextIdentity).state.identity.runId, 'run_next');
  await core.stop();
});

test('finish result preceding start command ACK waits in durable command order', async () => {
  const { core, conn } = fixture(async () => ({ ok: true }));
  const start = core.queueCommand('turn.start', { text: 'fixture' });
  await core.testEvent(conn, semantic(1));
  await tick();
  const resultCommand = core.store.state.commands.find(c => c.type === 'semantic_tool.result');
  assert.ok(resultCommand);
  assert.equal(core.semanticToolResultsSettled(), false);
  const complete = command => ({ commandId: command.commandId, controllerSeq: command.controllerSeq, commandType: command.type, status: 'completed' });
  core.testResult(conn, complete(start));
  assert.ok(conn.sent.some(e => e.kind === 'command' && e.payload.commandId === resultCommand.commandId));
  core.testResult(conn, complete(resultCommand));
  assert.equal(core.semanticToolResultsSettled(), true);
  await core.stop();
});

test('a semantic-pinned window never evicts new events within an unobserved batch', async () => {
  const { core, conn } = fixture();
  const retained = Array.from({ length: 4095 }, (_, i) => ({ sourceSeq: i + 1, sourceEventId: `event_${i + 1}`,
    eventType: 'semantic_tool.input', priority: 1, envelope: semantic(i + 1, `call_${i}`), deliveryCount: 1, logicalEffectCount: 1 }));
  retained.push({ sourceSeq: 4096, sourceEventId: 'event_4096', eventType: 'item.delta', priority: 1,
    envelope: event(4096), deliveryCount: 1, logicalEffectCount: 1 });
  core.store.commit({ ...core.store.state, committedEvents: retained, ackedSourceSeq: 4096 });
  for (let i = 4097; i <= 4160; i++) await core.testEvent(conn, event(i));
  assert.equal(core.store.state.ackedSourceSeq, 4097);
  assert.equal(core.store.state.committedEvents.filter(e => e.eventType === 'semantic_tool.input').length, 4095);
  assert.equal(core.store.state.committedEvents.at(-1).sourceSeq, 4097);
  assert.equal(Math.max(...conn.sent.filter(e => e.kind === 'ack').map(e => e.payload.ackedSourceSeq)), 4097);
  assert.equal(core.activeRunnerConnectionCount(), 0);
  await core.stop();
});

class Socket extends EventEmitter {
  writes = []; destroyed = false;
  write(data) { this.writes.push(data); }
  destroy() { this.destroyed = true; }
  pause() {} resume() {}
}
function frame(opcode, payload, final = true) {
  const data = Buffer.from(payload), mask = Buffer.from([1, 2, 3, 4]);
  let header;
  if (data.length < 126) header = Buffer.from([(final ? 128 : 0) | opcode, 128 | data.length]);
  else { header = Buffer.alloc(4); header[0] = (final ? 128 : 0) | opcode; header[1] = 254; header.writeUInt16BE(data.length, 2); }
  return Buffer.concat([header, mask, Buffer.from(data.map((byte, i) => byte ^ mask[i % 4]))]);
}
test('fragmented JSON, UTF-8 and TCP headers with interleaved ping', () => {
  const socket = new Socket(), wire = new Wire(socket), received = [];
  wire.onJson(value => received.push(value));
  const text = Buffer.from(JSON.stringify({ text: '繁體中文' }));
  const packets = Buffer.concat([frame(1, text.subarray(0, 11), false), frame(9, 'ping'), frame(0, text.subarray(11))]);
  for (const byte of packets) socket.emit('data', Buffer.from([byte]));
  assert.deepEqual(received, [{ text: '繁體中文' }]);
  assert.equal(socket.destroyed, false);
  assert.equal(socket.writes.length, 1);
  wire.close();
});
test('invalid continuation, RSV, nested message, fragmented control and excessive aggregate close', () => {
  const cases = [frame(0, '{}'), Buffer.from([0xc1, 0x80, 1, 2, 3, 4]),
    Buffer.concat([frame(1, '{', false), frame(1, '}')]), frame(9, 'x', false),
    Buffer.concat(Array.from({ length: 4097 }, (_, i) => frame(i ? 0 : 1, '', false))),
    Buffer.concat(Array.from({ length: 18 }, (_, i) => frame(i ? 0 : 1, Buffer.alloc(65535), false)))];
  for (const data of cases) {
    const socket = new Socket(), wire = new Wire(socket);
    socket.emit('data', data);
    assert.equal(socket.destroyed, true);
  }
});

test('5006 and 20000 deltas preserve byte content with bounded snapshots and prompt finish delivery', async t => {
  for (const count of [5006, 20000]) {
    let writes = 0, bytes = 0, effects = 0;
    const seen = [], expected = [];
    const { core, conn } = fixture(async () => { effects++; return { ok: true }; }, e => { if (e.eventType === 'item.delta') seen.push(e.payload.text); });
    const commit = core.store.commit.bind(core.store);
    core.store.commit = candidate => { writes++; bytes += Buffer.byteLength(JSON.stringify(candidate)); commit(candidate); };
    const start = performance.now();
    for (let i = 1; i <= count; i++) {
      expected.push(`字${i}`);
      await core.testEvent(conn, event(i));
    }
    const finishStart = performance.now();
    await core.testEvent(conn, semantic(count + 1));
    await tick();
    const finishMs = performance.now() - finishStart;
    assert.equal(effects, 1);
    assert.equal(seen.join(''), expected.join(''));
    assert.equal(core.store.state.ackedSourceSeq, count + 1);
    assert.ok(writes <= Math.ceil(count / 64) + 3, `writes=${writes}`);
    assert.ok(core.store.state.committedEvents.length <= 4096);
    assert.ok(finishMs < 2000, `finish latency ${finishMs}`);
    t.diagnostic(JSON.stringify({ count, snapshots: writes, bytes, durationMs: performance.now() - start, finishMs }));
    await core.stop();
  }
});

test.after(() => fs.rmSync(root, { recursive: true, force: true }));

