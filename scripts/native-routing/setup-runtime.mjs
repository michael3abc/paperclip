#!/usr/bin/env node
// Install an immutable qualified closure; activate with a write-ahead rollback receipt.
import fs from 'node:fs/promises';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { parseArgs } from 'node:util';
import { privateWrite, activeStatuses, operationLock } from './operation-files.mjs';
import { admin, companyId, deployment, app } from './deployment.mjs';
const { values: o } = parseArgs({ options: { release: { type: 'string' }, apply: { type: 'boolean' }, restore: { type: 'boolean' } } });
if (!o.release || !path.isAbsolute(o.release) || (o.apply && o.restore)) throw new Error('--release ABSOLUTE_PATH; select apply or restore');
const releaseLock = await operationLock(path.join(deployment.runtimeRoot, 'operation.flock'));
try {
const release = o.release;
const server = deployment.serverPackagePath;
const nodeRoot = deployment.nodeBin;
const receiptFile = path.join(release, 'activation.json');
process.umask(0o022);
const readLink = async file => { try { return await fs.readlink(file); } catch (e) { if (e.code === 'ENOENT') return null; throw e; } };
async function linkTo(file, target) {
  await fs.mkdir(path.dirname(file), { recursive: true });
  const tmp = `${file}.native-${process.pid}`;
  await fs.symlink(target, tmp); await fs.rename(tmp, file);
}
async function requireQuiescentRunners() {
  const api = await admin();
  const agents = await api.call('GET', `/api/companies/${companyId}/agents`);
  if (agents.some(a => a.adapterType === 'paperclip_runner' && !['paused', 'terminated'].includes(a.status))) throw new Error('Pause native Runner agents before changing runtime links');
  const runs = await api.call('GET', `/api/companies/${companyId}/heartbeat-runs`);
  if (runs.some(r => activeStatuses.includes(r.status))) throw new Error('Paperclip has active work; runtime change refused');
}
if (o.restore) {
  const receipt = JSON.parse(await fs.readFile(receiptFile, 'utf8'));
  await requireQuiescentRunners();
  for (const entry of [...receipt.links].reverse()) {
    const current = await readLink(entry.link);
    if (current === entry.previous) continue;
    if (current !== entry.target) throw new Error('Runtime link drift; restore refused');
    if (entry.previous === null) await fs.unlink(entry.link); else await linkTo(entry.link, entry.previous);
  }
  for (const c of receipt.modes) {
    const mode = (await fs.stat(c.path)).mode & 0o777;
    if (mode === c.before) continue;
    if (mode !== c.after) throw new Error('Runtime mode drift; restore refused');
    await fs.chmod(c.path, c.before);
  }
  console.log('Runtime links and modes restored; immutable releases retained'); process.exit(0);
}
// Never run npm or chmod in an activated release, including partially activated ones.
try { await fs.access(receiptFile); throw new Error('Release was activated; create a new release instead'); } catch (e) { if (e.code !== 'ENOENT') throw e; }
try { await fs.access(path.join(release, 'links.json')); throw new Error('Legacy activated release; choose a new path'); } catch (e) { if (e.code !== 'ENOENT') throw e; }
if (o.apply) await requireQuiescentRunners();
const manifest = { name: 'paperclip-qualified-native-runtime', private: true, version: '1.0.0', dependencies: {
  '@agentclientprotocol/claude-agent-acp': '0.73.0', '@openai/codex': '0.160.0',
}, overrides: { '@anthropic-ai/claude-agent-sdk': '0.3.286', '@agentclientprotocol/sdk': '1.4.0', zod: '4.4.3' } };
await fs.mkdir(release, { recursive: true, mode: 0o700 });
try { const old = JSON.parse(await fs.readFile(path.join(release, 'package.json'))); if (JSON.stringify(old) !== JSON.stringify(manifest)) throw new Error('Release manifest differs'); }
catch (e) { if (e.code !== 'ENOENT') throw e; await fs.writeFile(path.join(release, 'package.json'), JSON.stringify(manifest, null, 2) + '\n'); }
const install = spawnSync(`${nodeRoot}/node`, [`${nodeRoot}/../lib/node_modules/npm/bin/npm-cli.js`, 'install', '--ignore-scripts', '--no-audit', '--no-fund'], {
  cwd: release, env: { ...process.env, PATH: `${nodeRoot}:${process.env.PATH}` }, stdio: 'inherit', timeout: 300000,
});
if (install.status !== 0) throw new Error('Pinned runtime installation failed');
async function modesUnder(root, changes) {
  const stat = await fs.lstat(root); if (stat.isSymbolicLink()) return;
  const mode = stat.mode & 0o777;
  if (mode & 0o022) changes.push({ path: root, before: mode, after: mode & ~0o022 });
  if (stat.isDirectory()) for (const name of await fs.readdir(root)) await modesUnder(path.join(root, name), changes);
}
const candidateModes = []; await modesUnder(release, candidateModes);
for (const c of candidateModes) await fs.chmod(c.path, c.after);
if (!o.apply) { console.log('Candidate installed; live application unchanged'); process.exit(0); }
await requireQuiescentRunners();
// ACPX's rooted resolver requires the complete closure inside its owning server.
const closure = `${server}/node_modules/.native-${path.basename(release)}`;
try { await fs.access(closure); throw new Error('Closure destination exists; choose a new release'); } catch (e) { if (e.code !== 'ENOENT') throw e; }
await fs.cp(release, closure, { recursive: true, errorOnExist: true, force: false, verbatimSymlinks: true });
const links = [
  [`${server}/node_modules/@agentclientprotocol/claude-agent-acp`, `${closure}/node_modules/@agentclientprotocol/claude-agent-acp`],
  [`${app}/node_modules/.bin/codex`, `${release}/node_modules/@openai/codex/bin/codex.js`],
];
const receipt = { release, closure, links: [], modes: [] };
for (const [link, target] of links) receipt.links.push({ link, target, previous: await readLink(link) });
await modesUnder(`${server}/node_modules/acpx`, receipt.modes);
await modesUnder(`${server}/dist/vendor/paperclip-runner/cli/acpx-runtime-sidecar.cjs`, receipt.modes);
await privateWrite(receiptFile, receipt);
for (const c of receipt.modes) await fs.chmod(c.path, c.after);
for (const e of receipt.links) await linkTo(e.link, e.target);
console.log(JSON.stringify({ release, closure, links: receipt.links.length }));
} finally { await releaseLock(); }
