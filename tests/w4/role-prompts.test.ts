import test from 'node:test';
import assert from 'node:assert/strict';
import { assembleRolePrompt,inspectRolePrompt,requireIssuedRolePrompt,upstreamRevision } from '../../src/role-prompts.js';
import { hash } from '../../src/snapshot.js';
import { mkdir,cp,readFile,writeFile,rm,symlink } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath,pathToFileURL } from 'node:url';
import { setup } from '../w3/receiver-fixture.js';

test('reviewer receives complete fixed review and workflow originals while secretary gets only its own role',async()=>{
  const reviewer=await assembleRolePrompt('reviewer','Fixed task-specific review scope.');
  assert.equal(requireIssuedRolePrompt(reviewer,'reviewer').permissionGranted,false);assert.equal(reviewer.parts.length,5);
  const original=reviewer.parts.find(p=>p.source.endsWith(':zh/prompts/pr_review_system.md'))!;assert.equal(original.bytes,7404);assert.equal(original.sha256,'08e491ed00e59294408d9a97dd6b64bfa1b5d1d3bd44ba51ada4a6c85585ebe9');assert.ok(original.source.includes(upstreamRevision));
  const secretary=await assembleRolePrompt('secretary');assert.deepEqual(secretary.parts.map(p=>p.kind),['runtime','role']);assert.equal(secretary.parts[1]!.source,'tongxu:prompts/secretary.md');assert.throws(()=>requireIssuedRolePrompt(secretary,'reviewer'),/binding_invalid/);
});
test('serialized fields cannot substitute for actual assembly; missing, summarized and changed upstream is rejected',async()=>{
  const assembly=await assembleRolePrompt('reviewer'),copy=structuredClone(assembly);assert.equal(inspectRolePrompt(copy,'reviewer').executionProvenanceVerified,false);assert.throws(()=>requireIssuedRolePrompt(copy,'reviewer'),/actual_role_prompt/);
  copy.parts.splice(2,1);assert.throws(()=>inspectRolePrompt(copy,'reviewer'),/parts_required/);
  const summarized=structuredClone(assembly),p=summarized.parts[2]!;p.text='Summary of the adopted upstream.';p.bytes=Buffer.byteLength(p.text);p.sha256=hash(p.text);summarized.system=summarized.parts.map(p=>p.text).join('\n\n');summarized.sha256=hash(summarized.system);assert.throws(()=>inspectRolePrompt(summarized,'reviewer'),/fixed_upstream_prompt_changed/);
  assembly.parts[0]!.text+='\nchanged';assert.throws(()=>requireIssuedRolePrompt(assembly,'reviewer'),/actual_role_prompt/);
});
test('issue owner and verification roles record their exact required sources and never combine unrelated role templates',async()=>{
  const owner=await assembleRolePrompt('issue_owner'),fact=await assembleRolePrompt('verifier_fact'),impact=await assembleRolePrompt('verifier_impact');
  assert.ok(owner.parts.some(p=>p.source.endsWith(':zh/prompts/issue_agent.md')));for(const value of [owner,fact,impact]){assert.equal(value.parts.filter(p=>p.kind==='role').length,1);assert.ok(value.parts.some(p=>p.source.endsWith(':zh/docs/development_workflow/README.md')));requireIssuedRolePrompt(value,value.role);}
  await assert.rejects(assembleRolePrompt('reviewer','x'.repeat(65*1024)),/request_invalid/);
});
test('a packaged receiver with missing or changed mandatory upstream refuses before any model call and resumes the same local operation after exact restoration',async t=>{
  const f=await setup(t),copy=join(f.root,'isolated-runtime');await mkdir(join(copy,'dist'),{recursive:true});await cp(fileURLToPath(new URL('../../src/',import.meta.url)),join(copy,'dist/src'),{recursive:true});await cp(fileURLToPath(new URL('../../../prompts/',import.meta.url)),join(copy,'prompts'),{recursive:true});await writeFile(join(copy,'package.json'),'{"type":"module"}');await symlink(fileURLToPath(new URL('../../../node_modules',import.meta.url)),join(copy,'node_modules'));
  const receiver=await import(pathToFileURL(join(copy,'dist/src/receiver.js')).href),upstream=join(copy,'prompts/upstream',upstreamRevision,'workflow.md'),original=await readFile(upstream);await rm(upstream);
  await assert.rejects(receiver.runReception(f.path));assert.equal(await f.count(),0);const operation=f.q.status().operations[0].id;assert.equal(f.q.status().claims.length,0);
  await writeFile(upstream,'A short replacement summary is not the adopted full workflow.');await assert.rejects(receiver.runReception(f.path),/fixed_upstream_prompt_changed/);assert.equal(await f.count(),0);assert.equal(f.q.status().operations.length,1);
  await writeFile(upstream,original);const done=await receiver.runReception(f.path);assert.equal(done.operation,operation);assert.equal(await f.count(),1);assert.ok(done.receiver.promptAssemblySha256);
});
