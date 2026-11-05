import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile,writeFile,mkdir,rm} from 'node:fs/promises';
import {join} from 'node:path';
import {fixture} from './repair-fixture.js';
import {BoundedCodexSession,implementationSchema,implementationOutputSchema,readRepairSession} from '../../src/repair-native.js';
import {hash} from '../../src/snapshot.js';

async function sessionFixture(t:test.TestContext,role:'implementer'|'verifier_fact'='implementer'){
 const f=await fixture(t,'',false),path=f.config.codexExecutable,script=await readFile(path,'utf8'),needle="if(m.params.outputSchema.properties.verdict){";
 assert.ok(script.includes(needle));await writeFile(path,script.replace(needle,"if(m.params.outputSchema.properties.decision?.enum?.includes('implemented')){finish({candidateH:context.candidate.H,decision:'no_change',report:'Explicit implementation schema fixture; no official model or source write.'});return;}"+needle));
 const operation=join(f.root,'implementation-profile');await mkdir(operation);const candidate=JSON.parse(await readFile(f.plan,'utf8')).candidate,session=await BoundedCodexSession.start({executable:path,directory:join(operation,'native'),operation,candidate,role,system:'Explicit no-write protocol fixture.',inputManifestSha256:hash('fixed fixture input'),scopeSource:'fixture only',arrangementSource:'Exact implementation report identity, no actual implementation authority',disabledMcpServers:[],allowedInstructionSources:[],timeoutMs:3000,executionKind:'fixture',projectRepair:true,gate:{async check(){},async call(){throw Error('fixture_tool_not_authorized');}}});t.after(async()=>{await session.close();await rm(f.root,{recursive:true,force:true});});
 return {...f,operation,candidate,session};
}
for(const legacy of [false,true])test('implementation output profile preserves original H0 and cold report with legacy='+legacy,async t=>{
 const f=await sessionFixture(t),schema=legacy?implementationSchema:implementationOutputSchema(f.candidate.H),report=await f.session.turn(JSON.stringify({candidate:f.candidate}),f.candidate,schema);assert.equal(report.candidateH,f.candidate.H);assert.equal(report.decision,'no_change');await f.session.close();
 const cold=await readRepairSession(join(f.operation,'native'));assert.equal(cold.turns[0]!.final!.text,JSON.stringify(report));assert.equal(cold.turns.length,1);
});
for(const variant of ['foreign-head','extra-property','expanded-decision','wrong-role'] as const)test('implementation schema '+variant+' is rejected before an actual model input',async t=>{
 const f=await sessionFixture(t,variant==='wrong-role'?'verifier_fact':'implementer'),schema:any=implementationOutputSchema(variant==='foreign-head'?'f'.repeat(40):f.candidate.H);
 if(variant==='extra-property')schema.properties.unselected={type:'string'};if(variant==='expanded-decision')schema.properties.decision={type:'string',enum:['implemented','no_change','needs_owner','PASS']};
 await assert.rejects(f.session.turn(JSON.stringify({candidate:f.candidate}),f.candidate,schema),/native_implementation_output_profile_mismatch/);const sent=(await readFile(join(f.operation,'native/stdin.ndjson'),'utf8')).trim().split('\n').map(s=>JSON.parse(s));assert.equal(sent.filter(m=>m.method==='turn/start').length,0);
});
