import fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
export async function privateWrite(file, value) {
  await fs.mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
  const tmp = `${file}.${randomUUID()}.tmp`;
  const handle = await fs.open(tmp, 'wx', 0o600);
  try { await handle.writeFile(JSON.stringify(value, null, 2) + '\n'); await handle.sync(); }
  finally { await handle.close(); }
  await fs.rename(tmp, file);
  const dir = await fs.open(path.dirname(file), 'r'); try { await dir.sync(); } finally { await dir.close(); }
}
export const activeStatuses = ['running', 'queued', 'scheduled_retry'];
/** Reserve a new operation journal before its first mutation; never overwrite history. */
export async function reserveReceipt(file) {
  await fs.mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
  const handle = await fs.open(file, 'wx', 0o600);
  try { await handle.writeFile('{}\n'); await handle.sync(); } finally { await handle.close(); }
}
/** Kernel ownership lasts until release or parent exit; no stale lock deletion. */
export async function operationLock(file) {
  await fs.mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
  const handle = await fs.open(file, 'a', 0o600); await handle.close();
  const child = spawn('/usr/bin/flock', ['--exclusive', '--nonblock', '--conflict-exit-code', '73', file, '/bin/sh', '-c', 'printf "locked\\n"; cat >/dev/null'], { stdio: ['pipe', 'pipe', 'pipe'] });
  child.stdin.on('error', () => {});
  const closed = new Promise(resolve => child.once('close', resolve));
  try { await new Promise((resolve, reject) => {
    child.once('error', reject);
    child.once('close', code => reject(new Error(code === 73 ? 'Another native runtime operation is active' : 'Runtime lock unavailable')));
    child.stdout.once('data', chunk => chunk.toString() === 'locked\n' ? resolve() : reject(new Error('Invalid runtime lock handshake')));
  }); } catch (e) { child.stdin.end(); await closed; throw e; }
  return async () => { child.stdin.end(); await closed; };
}
