import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { catalogGroups, runnerConfig, bindingFor } from './routing.mjs';
import { privateWrite } from './operation-files.mjs';
const health = () => ({ status: 'ok', router: 'compass-codex-kit',
  anthropic_aliases: [{ selector: 'claude-compass', model: 'claude' }], compass_aliases: [{ selector: 'codex-compass', model: 'codex' }],
  local_responses_aliases: [{ selector: 'local-ready', status: 'ready' }, { selector: 'local-offline', status: 'unavailable' }],
  anthropic_local_responses_aliases: [{ selector: 'local-ready', status: 'ready' }],
});
test('live catalog preserves protocol pairing and only available Local routes', () => {
  const groups = catalogGroups(health(), 'http://127.0.0.1:8790'); assert.equal(groups.length, 4);
  assert.equal(groups[0].routing.baseUrl, 'http://127.0.0.1:8790');
  assert.equal(groups[2].routing.baseUrl, 'http://127.0.0.1:8790/v1');
  assert.deepEqual(groups[3].routing.models.map(m => m.id), ['local-ready']);
  assert.equal(groups[2].provider, 'openai');
});
test('catalog fails explicitly for wrong identity, empty, duplicate, malformed or missing lists', () => {
  for (const mutate of [h => h.router = 'wrong', h => h.compass_aliases = [], h => h.compass_aliases.push(h.compass_aliases[0]), h => h.compass_aliases = [{}], h => delete h.compass_aliases]) {
    const h = health(); mutate(h); assert.throws(() => catalogGroups(h, 'http://127.0.0.1:8790'));
  }
});
test('catalog refresh derives newly added models rather than a fixed model list', () => {
  const h = health(); h.compass_aliases.push({ selector: 'new-model', model: 'new-upstream' });
  assert.ok(catalogGroups(h, 'http://127.0.0.1:8790')[2].routing.models.some(m => m.id === 'new-model'));
});
test('engine selection and subscription binding preserve permissions', () => {
  assert.equal(runnerConfig('codex', 'model', 'xhigh').codexPermissionMode, 'never');
  assert.equal(runnerConfig('codex', 'model', 'xhigh').modelReasoningEffort, 'xhigh');
  assert.equal(runnerConfig('claude', 'custom', 'xhigh').acpxPermissionMode, 'approve-all');
  assert.equal(bindingFor({ ownership: 'shared' }).mode, 'shared');
  assert.equal(bindingFor({ ownership: 'personal' }).mode, 'delegated');
  assert.throws(() => runnerConfig('unknown', 'model'));
});
test('receipt replacement is complete, private and leaves no temporary files', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'native-receipt-'));
  try { const file = path.join(dir, 'receipt.json'); await privateWrite(file, { a: 1 }); await privateWrite(file, { b: 2 });
    assert.deepEqual(JSON.parse(await fs.readFile(file)), { b: 2 }); assert.equal((await fs.stat(file)).mode & 0o777, 0o600);
    assert.deepEqual(await fs.readdir(dir), ['receipt.json']);
  } finally { await fs.rm(dir, { recursive: true }); }
});

test('deployment router origin is used for both protocols', () => {
  const groups = catalogGroups(health(), 'https://router.example.invalid');
  assert.equal(groups[0].routing.baseUrl, 'https://router.example.invalid');
  assert.equal(groups[3].routing.baseUrl, 'https://router.example.invalid/v1');
});
