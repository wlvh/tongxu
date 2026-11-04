import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile,mkdir} from 'node:fs/promises';
import {fixture} from './repair-fixture.js';
import {RepairTools,acquireWorkspace,releaseWorkspace,tree,type Grant} from '../../src/repair-workspace.js';

for(const at of ['before_registration','before_atomic_replace'])test('a closed native tool turn ('+at+') refuses the actual write even while the workspace and host grant remain valid',async t=>{const f=await fixture(t),grant=JSON.parse(await readFile(f.grantPath,'utf8')) as Grant;await mkdir(f.operation,{mode:0o700});const before=await tree(f.workspace),lease=await acquireWorkspace(f.workspace,f.operation,false,grant),gate=new RepairTools(f.workspace,f.operation,grant,lease,process.execPath,structuredClone(before));await gate.handoff('explicit-native-turn-boundary-fixture');let checks=0;await assert.rejects(gate.call({tool:'tongxu_replace_file',arguments:{path:'clamp.mjs',expectedSha256:before['clamp.mjs']!.sha256,text:'This must never be written after its native turn ends.'},callId:'closed-native-turn'},()=>{if(++checks>=(at==='before_registration'?1:2))throw new Error('native_tool_request_after_terminal');}),/native_tool_request_after_terminal/);assert.deepEqual(await tree(f.workspace),before);await releaseWorkspace(f.workspace,lease,'explicit rejected tool boundary');});
