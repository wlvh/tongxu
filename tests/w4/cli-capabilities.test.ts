import test from 'node:test';
import assert from 'node:assert/strict';
import {cliVersion,inspectCodexCapabilities,inspectClaudeCapabilities} from '../../src/cli-capabilities.js';
import {currentCodexProtocol,validateBinding} from '../../src/codex-results.js';

test('release labels are observations, while actual requested methods and parameter support gate use',()=>{
  assert.equal(cliVersion('codex-cli 99.7.0-preview.12','codex'),'99.7.0-preview.12');
  assert.equal(cliVersion('99.7.0 (Claude Code)','claude'),'99.7.0');
  assert.throws(()=>cliVersion('different-program 99.7.0','codex'),/identity_not_observed/);
  const schema={definitions:{Read:{type:'object',properties:{threadId:{type:'string'},includeTurns:{type:'boolean'},newOptionalField:{type:'string'}}}},oneOf:[{properties:{method:{enum:['thread/read']},params:{$ref:'#/definitions/Read'}}}]};
  assert.ok(inspectCodexCapabilities(schema,['thread/read']).methods['thread/read']!.includes('newOptionalField'));
  assert.throws(()=>inspectCodexCapabilities(schema,['thread/resume']),/capability_missing_thread_resume/);
  const missing=structuredClone(schema);delete (missing.definitions.Read.properties as any).includeTurns;
  assert.throws(()=>inspectCodexCapabilities(missing,['thread/read']),/capability_missing_thread_read_includeturns/);
  assert.throws(()=>inspectCodexCapabilities({...schema,oneOf:[...schema.oneOf,...schema.oneOf]},['thread/read']),/capability_missing_thread_read/);
});
test('Claude flags must be actual option names; a similar prefix does not establish a boundary',()=>{
  const flags=['--safe-mode','--setting-sources','--tools','--permission-mode','--strict-mcp-config','--mcp-config','--no-chrome','--no-session-persistence','--disable-slash-commands','--output-format','--verbose','--system-prompt','--input-format','--replay-user-messages','--session-id'];
  const help=flags.map(f=>'  '+f+' <value>\n').join('');
  assert.equal(inspectClaudeCapabilities(help).kind,'claude-stream-command-v1');
  assert.throws(()=>inspectClaudeCapabilities(help.replace('--tools ','--tools-unsafe ')),/capability_missing___tools/);
});
test('new result contracts require the actual observed thread version, while historical contracts remain readable',()=>{
  const b={schemaVersion:1,...currentCodexProtocol('99.7.0'),sourceKind:'fixture',role:'reviewer',run:'run',sessionId:'s',threadId:'t',turnIds:['u'],workspace:'/fixture',scopeSource:'fixture:scope',arrangementSource:'fixture:arrangement',inputManifestSha256:'a'.repeat(64),promptSha256:'b'.repeat(64),candidate:{repository:'fixture/repo',pr:1,H:'a'.repeat(40),B:'b'.repeat(40),target:'base'}};
  assert.equal(validateBinding(b).runtimeVersion,'99.7.0');
  assert.throws(()=>validateBinding({...b,runtimeVersion:undefined}),/invalid_result_binding/);
  const {runtimeVersion,...old}=b;assert.equal(validateBinding({...old,protocol:'codex-app-server/0.159.2'}).protocol,'codex-app-server/0.159.2');
});
