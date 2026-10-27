import test from 'node:test';
import assert from 'node:assert/strict';
import { isUndispatchedCredentialWait, sshSessionIdentity, blocksAutomaticSshReplay, stopInPlaceLease, resolveInPlaceAnchor, existingWorkspaceCommand, prepareInPlaceRuntime } from '../../packages/adapter-utils/src/ssh-in-place.ts';

test('credential wait proof excludes launched, unknown and user-cancelled runs',()=>{
  const run={status:'cancelled',errorCode:'ai_connection_busy',runtimeMode:'legacy',executionStage:'settled',finishedAt:'now',runnerProfileJson:{adapterDispatch:{adapterType:'codex_local'}},resultJson:{executionRecovery:{kind:'ai_connection_wait',providerWorkStarted:false},cancellation:{source:'control_plane',expected:true,initiator:{type:'system'}}}};
  assert.equal(isUndispatchedCredentialWait(run),true);
  for(const patch of [{processPid:123},{processStartedAt:'now'},{sessionIdAfter:'s'},{controllerLeaseExpiresAt:'past'},{errorCode:'cancelled'},{resultJson:{}},{executionStage:'preparing'}])assert.equal(isUndispatchedCredentialWait({...run,...patch}),false);
});

test('SSH session identity is explicit and strips credentials',()=>{
  const identity={transport:'ssh',host:'host',port:2222,username:'fixture-user',remoteCwd:'/project'};
  assert.deepEqual(sshSessionIdentity({...identity,privateKey:'secret',knownHosts:'secret'}),identity);
  for(const value of [undefined,{}, {...identity,port:0},{...identity,remoteCwd:'relative'}])assert.equal(sshSessionIdentity(value),null);
});

test('remote dispatch is never automatically replayed; pre-dispatch deferral remains allowed',()=>{
  const agent={adapterType:'codex_local',adapterConfig:{command:'/home/fixture-user/.local/lib/paperclip-ssh/codex-managed'}};
  assert.equal(blocksAutomaticSshReplay({processStartedAt:'2026-10-26T09:00:00Z'},agent),true);
  assert.equal(blocksAutomaticSshReplay({processStartedAt:null},agent),false);
  assert.equal(blocksAutomaticSshReplay({processStartedAt:'now'},{adapterType:'codex_local',adapterConfig:{command:'codex'}}),false);
  const saved={processStartedAt:'now',runnerProfileJson:{adapterDispatch:{adapterType:'codex_local'}},contextSnapshot:{paperclipEnvironment:{driver:'ssh',workspaceRealization:{mode:'in_place'}}}};
  assert.equal(blocksAutomaticSshReplay(saved,{adapterType:'process',adapterConfig:{command:'other'}}),true);
});

test('remote lease receipt requires exact run identity and original host',async()=>{
  const lease={companyId:'co',heartbeatRunId:'run',provider:'ssh',providerLeaseId:'ssh://host/path',metadata:{agentId:'agent',host:'host',port:22,username:'fixture-user',workspaceRealization:{mode:'in_place'}}};
  const spec={host:'host',port:22,username:'fixture-user'};
  const ssh=async(s,c)=>({stdout:c.startsWith('printf')?'/home/fixture-user':JSON.stringify({stopped:true,runId:'run',unit:'paperclip-ssh-run.scope'})});
  assert.deepEqual(await stopInPlaceLease(lease,spec,ssh),{providerLeaseId:'ssh://host/path',state:'stopped'});
  await assert.rejects(stopInPlaceLease(lease,{...spec,host:'other'},ssh),/host changed/);
  await assert.rejects(stopInPlaceLease(lease,spec,async(s,c)=>({stdout:c.startsWith('printf')?'/home/fixture-user':'{"stopped":true,"runId":"other"}'})),/unverified/);
});

const row = { id: 'w1', sourceType: 'remote_managed', cwd: '/home/fixture-user/project', isPrimary: true };
const input = { rows: [row], driver: 'ssh', config: { workspaceMode: 'in_place', remoteWorkspacePath: row.cwd }, projectId: 'p1', workspaceHints: [] };
test('remote project resolves without controller filesystem access', () => {
  assert.equal(resolveInPlaceAnchor(input).cwd, row.cwd);
  assert.equal(resolveInPlaceAnchor(input).workspaceId, 'w1');
});
test('wrong, empty, ambiguous, local and clone bindings fail closed', () => {
  for (const change of [{ rows: [] }, { preferredId: 'other' }, { rows: [{...row, cwd:'/other'}] },
    { rows: [{...row, sourceType:'local_path'}] }, { rows: [{...row, repoUrl:'https://example.invalid/repo'}] },
    { rows: [{...row,isPrimary:false}, {...row,id:'w2',isPrimary:false}] }]) {
    assert.throws(() => resolveInPlaceAnchor({...input,...change}), /requires an explicit/);
  }
});
test('copy and local modes retain their original resolver', () => {
  assert.equal(resolveInPlaceAnchor({...input,driver:'local'}), null);
  assert.equal(resolveInPlaceAnchor({...input,config:{workspaceMode:'copy'}}), null);
});
test('existing-directory command has no mutation and safely quotes paths', () => {
  assert.match(existingWorkspaceCommand("/tmp/a'b $x"), /test -d/);
  assert.doesNotMatch(existingWorkspaceCommand('/missing'), /mkdir|rm |git /);
  assert.throws(() => existingWorkspaceCommand('relative'));
});
test('runtime is per-agent outside workspace and has bounded SSH calls', async () => {
  const calls=[];
  const root=await prepareInPlaceRuntime({inPlaceRuntime:true,syncWorkspace:false, runtimeOwnerId:'company/agent', adapterKey:'codex',workspaceRemoteDir:row.cwd,spec:{}},async(s,c)=>{calls.push(c);return {stdout:'/home/fixture-user'};});
  assert.equal(root,'/home/fixture-user/.local/state/paperclip-ssh/company/agent/codex');
  assert.equal(calls.length,2);
  assert.match(calls[1], /Unsafe runtime path/);
  assert.equal(await prepareInPlaceRuntime({syncWorkspace:true},()=>{throw Error();}),null);
  assert.equal(await prepareInPlaceRuntime({syncWorkspace:false},()=>{throw Error();}),null);
});
test('runtime refuses absent owner, invalid home and project overlap', async () => {
  const base={inPlaceRuntime:true,syncWorkspace:false,runtimeOwnerId:'company/agent',adapterKey:'codex',workspaceRemoteDir:row.cwd,spec:{}};
  await assert.rejects(prepareInPlaceRuntime({...base,runtimeOwnerId:undefined},async()=>({stdout:'/home/fixture-user'})));
  await assert.rejects(prepareInPlaceRuntime(base,async()=>({stdout:'/'})));
  await assert.rejects(prepareInPlaceRuntime({...base,workspaceRemoteDir:'/home/fixture-user'},async()=>({stdout:'/home/fixture-user'})));
});
