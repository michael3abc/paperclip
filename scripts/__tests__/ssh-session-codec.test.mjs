import test from 'node:test';
import assert from 'node:assert/strict';
import {sessionCodec} from '../../packages/adapters/codex-local/src/server/index.ts';
import {remoteExecutionSessionMatches} from '../../packages/adapter-utils/src/remote-managed-runtime.ts';

test('source codec preserves SSH identity through storage and rejects another host',()=>{
  const remoteExecution={transport:'ssh',host:'example.invalid',port:2222,username:'worker',remoteCwd:'/project'};
  const input={sessionId:'test',cwd:'/project',remoteExecution:{...remoteExecution,privateKey:'must-not-persist'}};
  const stored=sessionCodec.serialize(input);
  const restored=sessionCodec.deserialize(JSON.parse(JSON.stringify(stored)));
  assert.deepEqual(restored.remoteExecution,remoteExecution);
  assert.equal(remoteExecutionSessionMatches(restored.remoteExecution,remoteExecution),true);
  assert.equal(remoteExecutionSessionMatches(restored.remoteExecution,{...remoteExecution,port:2223}),false);
  assert.equal(sessionCodec.deserialize({sessionId:'legacy',cwd:'/project'}).remoteExecution,undefined);
  assert.deepEqual(sessionCodec.serialize({sessionId:'local',cwd:'/tmp'}),{sessionId:'local',cwd:'/tmp'});
});
