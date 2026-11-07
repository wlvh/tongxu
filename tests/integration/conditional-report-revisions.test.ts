import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, writeFile, readdir, cp, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { integrationFixture } from './fixture.js';
import { messageFixture } from '../w6/message-fixture.js';
import { readPacket } from '../../src/queue-evidence.js';
import { canonical } from '../../src/comparison.js';
import { hash } from '../../src/snapshot.js';
import { runIntegration } from '../../src/integration.js';
import type {CoordinationPlan} from '../../src/coordination-contract.js';
import type {CoordinationExecution} from '../../src/coordination-execution-contract.js';
import type {ConditionalEntryPlan} from '../../src/conditional-entry-contract.js';
import {coordinationMessageAuthority,coordinationMessageId,coordinationTaskBody} from '../../src/coordination-execution-contract.js';
import {runMessages} from '../../src/messages.js';
import type {MessagePlan} from '../../src/message-contract.js';
for (const scenario of ['refresh', 'wait', 'unknown'] as const)
    test('report revisions reach exact downstream inputs with never-sent selection ' + scenario, async (t) => {
        const refreshUnsent = scenario === 'refresh';
        const f = await integrationFixture(t), roles = await messageFixture(t), sources: Record<string, string> = {};
        // Member queue verification is an explicit protocol fixture here. The
        // original combination and its failed prefixes are actual Docker results.
        // Git construction and Docker tests are real. The published association and
        // model roles below are explicit fixtures, not real remote publication.
        for (const [task, pr, H] of [['A1', 10, f.A], ['B1', 11, f.C], ['A2', 12, f.C], ['A3', 13, f.A3], ['A4', 14, f.A3]] as const) {
            await f.addPacket({ pr, H, B: f.B });
            let selected: string | undefined;
            for (const name of await readdir(f.root))
                if (/^snapshot-\d+$/.test(name)) {
                    const path = join(f.root, name), manifest = JSON.parse(await readFile(join(path, 'manifest.json'), 'utf8'));
                    if (manifest.candidate?.pr === pr && manifest.candidate.H === H)
                        selected = path;
                }
            assert.ok(selected);
            const index = selected.split('snapshot-').at(-1), packet = await readPacket(selected, join(f.root, 'verification-' + index), join(f.root, 'integration-context.json'));
            sources[task] = f.q.import(packet).item;
        }
        const taskIds=['A1','B1','A2','A3','A4'];
        const plan: CoordinationPlan = {
          schemaVersion:1,kind:'tongxu-task-coordination',name:'report-revisions-five-task-units',
          revision:'r1',previous:null,source:'Explicit protocol roles for actual Git/Docker integration',
          authorityIntent:null,mode:'stage_serial',
          actors:taskIds.map(id=>({id:'owner-'+id,tool:'codex'})),
          tasks:taskIds.map(id=>({
            id,item:sources[id]!,actor:'owner-'+id,originActor:'owner-'+id,dispatch:'owner_backlog',
            stages:['investigate','implement'],independentPaths:['independent/'+id+'.ts'],
            workspace:null,publishBranch:null,
            outputs:['A1','B1','A3'].includes(id)?[{id:id==='A3'?'A3-analysis':id+'-report',stage:'investigate',kind:'message_report'}]:[]
          })),
          shared:[{
            id:'units-api',tasks:['A1','B1','A2'],paths:['scale.json','consumer.json'],
            contract:'The exact producer and consumer travel together. A2 reads their precise accepted combination.',
            feedbackFrom:['A1','B1','A2'],blockedStages:['implement'],earlyReceiverAdvice:true
          }],
          dependencies:[
            {task:'B1',stage:'implement',producer:'A1',capability:'A1-report'},
            {task:'A2',stage:'implement',producer:'B1',capability:'B1-report'},
            {task:'A3',stage:'investigate',producer:'B1',capability:'selected-pair-accepted'},
            {task:'A2',stage:'enable',producer:'A3',capability:'A3-analysis'},
            {task:'A4',stage:'investigate',producer:'A3',capability:'A3-analysis'}
          ]
        };
        plan.tasks.find(t=>t.id==='B1')!.stages.push('receive');
        plan.tasks.find(t=>t.id==='B1')!.outputs.push({
          id:'selected-pair-accepted',stage:'receive',kind:'integration_receiver_judgment',members:['A1','B1']
        });
        plan.tasks.find(t=>t.id==='A2')!.stages.push('enable');
    const a4Control=join(roles.root,'a4-control.json');await writeFile(a4Control,canonical({mode:'quota'}));
    const roleControl = join(roles.root, 'late-role-response.json');
        await writeFile(roleControl, canonical({ mode: 'complete' }));
        let script = await readFile(roles.codex, 'utf8');
        const modeMarker = 'mode="complete"';
        assert.ok(script.includes(modeMarker));
        script = script.replace(modeMarker, 'mode=JSON.parse(fs.readFileSync(' + JSON.stringify(roleControl) + ',"utf8")).mode');
        const marker = "report:'明确标记的进程夹具；核对了固定 sample.js 与前序报告，未调用真实模型。回复 '+x.messageId";
        assert.ok(script.includes(marker));
        script = script.replace(marker, "report:JSON.stringify((()=>{const e=x.material.find(m=>m.name==='early-receiver-context.json');if(e){const c=JSON.parse(e.text);return {schemaVersion:1,kind:'tongxu-early-receiver-advice',relationSha256:c.relationSha256,materialSha256:e.sha256,parts:c.shared.map(p=>({id:p.id,hash:p.hash,position:'compatible',report:'Explicit fixture: both selected units changes are necessary together.'})),report:'Protocol advice only, not independent technical reception.'};}const c=JSON.parse(x.material.find(m=>m.name==='coordination-context.json').text),task=x.body.split('\\n')[0].slice(18);return {kind:'tongxu-coordination-feedback',task,revision:c.revision,parts:c.shared.filter(p=>p.feedbackFrom.includes(task)).map(p=>({id:p.id,hash:p.hash,position:'agreed',report:'Explicit task response after consuming the full original material.'})),report:'Probe exact inputs '+JSON.stringify(c.outputs.map(o=>({task:o.task,sha256:o.sha256})))};})())");
        await writeFile(roles.codex, script);
        const { item, role, parent, ...profile } = roles.plan.participants[0]!, actor = { ...profile, executableSha256: hash(script) };
        const execution: CoordinationExecution = {
          schemaVersion:1,kind:'tongxu-coordination-readonly-execution',
          source:'Once-configured normal-entry protocol role capability',executionKind:'fixture',
          actors:plan.actors.map(a=>({...actor,id:a.id})),
          taskBodies:Object.fromEntries(plan.tasks.map(t=>[t.id,'Read exact registered upstream results and revisit affected conclusions.'])),
          authorityIntents:Object.fromEntries(plan.tasks.map(t=>[t.id,null])),
          billing:roles.plan.billing,timeoutMs:3000,refreshUnsent,
          earlyReceiver:{
            actor:{...actor,id:'early-units-receiver'},authorityIntent:null,objects:f.objects,
            sourcePaths:Object.fromEntries(['A1','B1','A2'].map(id=>[id,['scale.json','consumer.json']]))
          }
        };
        const a4Program=join(roles.root,'codex-a4.mjs'),a4Script=script.replace(JSON.stringify(roleControl),JSON.stringify(a4Control)); await writeFile(a4Program,a4Script,{mode:0o700}); const a4Actor=execution.actors.find(a=>a.id==='owner-A4')!;a4Actor.executable=a4Program;a4Actor.executableSha256=hash(a4Script);
        const planPath = join(f.root, 'normal-coordination.json'), executionPath = join(f.root, 'normal-execution.json'), receiverPath = join(f.root, 'normal-final-receiver-template.json');
        await writeFile(planPath, canonical(plan));
        await writeFile(executionPath, canonical(execution));
        await writeFile(receiverPath, canonical({ ...f.plan, sourcePaths: ['scale.json', 'consumer.json'] }));
        const ref = async (path: string) => ({ path, sha256: hash(await readFile(path)) });
        const sourceProgram = join(f.root, 'source-fixture.mjs'), providerState = join(f.root, 'source-provider-state.json'), providerTrace = join(f.root, 'source-trace.jsonl');
        // Only the fake external service state changes after production. The user
        // never writes a manifest, internal packet, or per-action child plan.
        const provider = `#!${process.execPath}
import fs from 'node:fs';
const args=process.argv.slice(2),endpoint=args.at(-1),state=JSON.parse(fs.readFileSync(${JSON.stringify(providerState)},'utf8'));
if(args[args.indexOf('--method')+1]!=='GET')process.exit(4);
fs.appendFileSync(${JSON.stringify(providerTrace)},JSON.stringify({endpoint,method:'GET',hasCredential:Boolean(process.env.GH_TOKEN||process.env.GITHUB_TOKEN),home:process.env.HOME,cwd:process.cwd()})+'\\n');
const repository={id:1,full_name:'fixture/reception'},match=/^repos\\/fixture\\/reception\\/pulls\\/([1-9][0-9]*)$/.exec(endpoint);
let value,status=200;
if(endpoint==='repos/fixture/reception')value=repository;
else if(match){const n=Number(match[1]);value={id:n,number:n,state:'open',merged:false,draft:false,head:{sha:state.H,ref:'private-integration',repo:state.fork?{id:2,full_name:'fixture/other-head-repository'}:repository},base:{sha:state.B,ref:'fixture',repo:repository},body:state.body??'Explicit published-association fixture; no actual remote write.',html_url:'https://github.com/fixture/reception/pull/'+n,updated_at:state.updatedAt??'2026-11-06T00:00:00Z',comments:(state.comments??[]).length,review_comments:0,commits:1,changed_files:2};}
else if(endpoint==='repos/fixture/reception/git/ref/heads/fixture')value={ref:'refs/heads/fixture',object:{type:'commit',sha:state.B}};
else if(endpoint==='repos/fixture/reception/pulls/99/commits?per_page=100&page=1')value=[{sha:state.H,commit:{message:'Actual private combination, explicit source fixture'}}];
else if(endpoint==='repos/fixture/reception/pulls/99/files?per_page=100&page=1')value=[{filename:'consumer.json'},{filename:'scale.json'}];
else if(endpoint==='repos/fixture/reception/issues/99/comments?per_page=100&page=1')value=state.comments??[];
else if(endpoint==='repos/fixture/reception/commits/'+state.H+'/check-runs?filter=latest&per_page=100&page=1')value={total_count:0,check_runs:[]};
else if(endpoint==='repos/fixture/reception/commits/'+state.H+'/statuses?per_page=100&page=1')value=[];
else if(/^repos\\/fixture\\/reception\\/(?:issues\\/99\\/comments|pulls\\/99\\/(?:reviews|comments))\\?per_page=100&page=1$/.test(endpoint))value=[];
else {status=404;value={message:'fixture route absent'};}
process.stdout.write('HTTP/1.1 '+status+' Fixture\\r\\nDate: Fri, 06 Nov 2026 00:00:00 GMT\\r\\n\\r\\n'+JSON.stringify(value));
process.exitCode=state.exitCode??0;
`;
        await writeFile(sourceProgram, provider, { mode: 0o700 });
        await writeFile(providerState, canonical({ H: f.A, B: f.B }));
        const parallelPath = join(f.root, 'normal-parallel-coordination.json');
        await writeFile(parallelPath, canonical({ ...plan, mode: 'parallel' }));
        const entry: ConditionalEntryPlan = { schemaVersion: 1, kind: 'tongxu-conditional-delivery-entry', id: 'fixed-four-task-units', title: 'Four task normal entry with explicit protocol roles', store: f.store, repository: 'fixture/reception', target: 'fixture', coordination: { plan: await ref(planPath), execution: await ref(executionPath), choices: [{ id: 'parallel', title: 'Declared parallel arrangement with exact stage dependencies', plan: await ref(parallelPath), execution: await ref(executionPath) }] }, integration: { item: f.imported.item, members: ['A1', 'B1'], gateStage: 'implement', objects: f.objects, selectionReason: 'The exact producer and consumer must travel together; preserve both failed standalone/prefix cases and exclude unrelated author work.', authorization: null, testPlan: await ref(join(f.root, 'units-test.json')), receiverTemplate: await ref(receiverPath), receiverAuthorization: null, sourceReader: { repositoryId: 1, ghExecutable: sourceProgram, ghSha256: hash(provider), issues: [], executionKind: 'fixture' } } };
        const entryPath = join(f.root, 'normal-entry.json');
        await writeFile(entryPath, canonical(entry));
        const execute = promisify(execFile), cli = fileURLToPath(new URL('../../src/conditional-entry-cli.js', import.meta.url));
        const run = async (action: string, ...options: string[]) => { const returned = await execute(process.execPath, [cli, action, '--entry', entryPath, ...options], { cwd: f.root, timeout: 60000, maxBuffer: 16 * 1024 * 1024 }); return JSON.parse(returned.stdout); };
        await run('prepare');
        await run('advice');
        const investigation = await run('investigate');
        assert.equal(investigation.results['A1:investigate'].completed,true);
        const before = await f.authorState(), existing = await runIntegration(f.store, f.path);
        assert.equal(existing.phase, 'produced');
        assert.ok('directory' in existing);
        const oldProducer = JSON.parse(await readFile(join(existing.directory, 'producer.json'), 'utf8'));
        const built = await run('integrate');
        assert.ok('phase' in built && built.phase === 'produced', JSON.stringify(built));
        assert.equal(built.id, existing.id);
        assert.equal(built.newGitProcesses, 0);
        assert.deepEqual(JSON.parse(await readFile(join(existing.directory, 'producer.json'), 'utf8')), oldProducer);
        assert.equal(f.q.integrations().forOperation(f.operation).length, 1);
        assert.deepEqual(await f.authorState(), before);
        assert.ok('result' in built && built.result && typeof built.result === 'object');
        const produced = built.result as any;
        assert.equal(produced.candidate.B, f.B);
        assert.equal(produced.requiresOwnValidation, true);
        assert.equal(produced.requiresOwnReception, true);
        assert.equal(produced.candidate.T, f.packet.summary.composition!.subject.testedTree);

    const records=f.q.coordination();
    await writeFile(providerState,canonical({H:produced.candidate.H,B:f.B}));
    await run('collect','--pr','99');
    await run('validate');
    await run('attach');
    await run('receive');
    const firstReceipt=await run('reuse','--task','B1');
    const first=await run('investigate'),coord=first.coordination;
    const currentReport=()=>records.context(coord).value.outputs.find(o=>o.task==='A3')!;
    const original=currentReport();
    assert.ok(original.text.includes(firstReceipt.sha256));
    assert.equal(records.stage(coord,'A2','enable').phasePrerequisitesMet,true);
    const oldA4=records.dispatchSelection(coord,'A4','investigate')!;
    const oldA4Context=Buffer.from(oldA4.context);
    assert.equal(f.q.messages().submitted(oldA4.run,'owner-A4').length,0);
    const summaries: any[]=[];
    const ownerRead=async()=>{
      const purpose=records.consumptionPurpose(coord,'A3','investigate')!;
      const context=records.context(coord,['A3'],'investigate');
      const request=records.execution(coord,Buffer.from(canonical(execution)));
      const task=plan.tasks.find(t=>t.id==='A3')!;
      const directory=join(f.store,'coordination-'+coord,'dispatch-'+hash(canonical(['A3',purpose])),'attempt-1');
      const message:MessagePlan={
        schemaVersion:1,kind:'tongxu-addressed-readonly-messages',executionKind:execution.executionKind,
        source:execution.source+'; coordination '+coord+' task A3 '+purpose,
        ...coordinationMessageAuthority(execution,coord,'A3',purpose,1),
        participants:[{...execution.actors.find(a=>a.id===task.actor)!,item:task.item,role:'issue_owner',parent:null}],
        messages:[{id:coordinationMessageId('A3',purpose),from:null,to:task.actor,body:coordinationTaskBody(execution,'A3',purpose),replies:[]}],
        material:[{name:'coordination-context.json',path:join(directory,'context.json'),sha256:context.sha256}],
        consumeMaterial:['coordination-context.json'],billing:execution.billing,timeoutMs:execution.timeoutMs
      };
      records.selectDispatch(coord,'A3',purpose,request.requestSha256,Buffer.from(canonical(message)),context.sha256);
      const selected=records.dispatchSelection(coord,'A3',purpose)!;
      records.bindMessages(coord,selected.plan,selected.contextSha256,[{task:'A3',messageId:message.messages[0]!.id}]);
      await mkdir(directory,{recursive:true,mode:0o700});
      await writeFile(join(directory,'context.json'),selected.context);
      await writeFile(join(directory,'plan.json'),selected.plan);
      const reply=await runMessages(f.store,join(directory,'plan.json'),false,selected.run);
      assert.equal(reply.completed,true);
      assert.equal(reply.resourcesSettled,true);
      // This is the same no-nested-transaction records callback used by
      // QueueStore.taskInbox, after its selected message completes.
      const callback=(f.q as any).coordinationRecords((fn:()=>unknown)=>fn());
      const output=callback.ownerFeedback(coord,'A3',selected.run,message.messages[0]!.id);
      assert.equal(output.outputs[0].run,selected.run);
      assert.equal(callback.ownerFeedback(coord,'A3',selected.run,message.messages[0]!.id).outputs[0].duplicate,true);
      return reply;
    };
    for(const revision of [2,3]){
      await writeFile(providerState,canonical({H:produced.candidate.H,B:f.B,body:'Material revision '+revision}));
      await run('collect','--pr','99');
      await run('attach');
      await run('receive');
      const receipt=await run('reuse','--task','B1');
      assert.equal(records.stage(coord,'A2','enable').phasePrerequisitesMet,false);
      const previous=currentReport();
      assert.equal(previous.sourceCurrent,false);
      if(scenario==='unknown')await writeFile(roleControl,canonical({mode:'partial-answer'}));
      const updated=revision===3?await ownerRead():await run('investigate'),report=currentReport();
      if(scenario==='unknown'){
        assert.equal(report.sha256,original.sha256);
        assert.equal(report.sourceCurrent,false);
        const selected=records.dispatchSelection(coord,'A3','consume')!;
        assert.equal(updated.results['A3:consume'].completed,false);
        const calls=await readFile(roles.trace);
        assert.equal((await run('investigate')).newModelRequests,0);
        await writeFile(providerState,canonical({H:produced.candidate.H,B:f.B,body:'Material revision 3'}));
        await run('collect','--pr','99');await run('attach');await run('receive');await run('reuse','--task','B1');
        const blocked=await run('investigate');
        assert.equal(blocked.newModelRequests,0);
        assert.equal(records.dispatchSelection(coord,'A3','consume')!.run,selected.run);
        assert.equal(records.dispatchSelection(coord,'A3','consume_investigate'),null);
        assert.equal(records.stage(coord,'A2','enable').phasePrerequisitesMet,false);
        assert.equal(f.q.messages().submitted(oldA4.run,'owner-A4').length,0);
        assert.deepEqual(await readFile(roles.trace),calls);
        if(process.env.TONGXU_TEST_CONDITIONAL_EVIDENCE){
          await cp(f.root,join(process.env.TONGXU_TEST_CONDITIONAL_EVIDENCE,'report-unknown'),{recursive:true});
          await cp(roles.root,join(process.env.TONGXU_TEST_CONDITIONAL_EVIDENCE,'report-roles-unknown'),{recursive:true});
        }
        return;
      }
      assert.notEqual(report.sha256,previous.sha256);
      assert.equal(report.sourceCurrent,true);
      const value=JSON.parse(report.text);
      const submitted=f.q.messages().submitted(value.run,'owner-A3')[0]!;
      const context=JSON.parse(submitted.material.find((m:any)=>m.name==='coordination-context.json')!.text);
      assert.equal(context.outputs.find((o:any)=>o.capability==='selected-pair-accepted').sha256,receipt.sha256);
      assert.equal(value.inputSha256,hash(canonical(submitted)));
      assert.equal(report.text.includes(receipt.sha256),true);
      assert.equal(records.stage(coord,'A2','enable').phasePrerequisitesMet,false);
      assert.equal(f.q.messages().submitted(oldA4.run,'owner-A4').length,0);
      await writeFile(a4Control,canonical({mode:'complete'}));
      const next=await run('investigate');
      assert.equal(records.stage(coord,'A2','enable').phasePrerequisitesMet,true);
      assert.equal(records.stage(coord,'A2','enable').executionAuthorized,false);
      const a2=Object.entries(next.prepared).find(([key])=>key.startsWith('A2:consume'))![1] as any;
      const a2Input=f.q.messages().submitted(a2.run,'owner-A2')[0]!;
      const a2Context=JSON.parse(a2Input.material.find((m:any)=>m.name==='coordination-context.json')!.text);
      assert.equal(a2Context.outputs.find((o:any)=>o.task==='A3').sha256,report.sha256);
      assert.equal(next.results['A2:'+a2.purpose].newModelRequests,1);
      const a4=records.dispatchSelection(coord,'A4','investigate')!;
      if(refreshUnsent){
        const input=f.q.messages().submitted(a4.run,'owner-A4')[0]!;
        const received=JSON.parse(input.material.find((m:any)=>m.name==='coordination-context.json')!.text).outputs.find((o:any)=>o.task==='A3');
        if(revision===2){
          assert.notEqual(a4.run,oldA4.run);
          assert.equal(f.q.messages().submitted(oldA4.run,'owner-A4').length,0);
          assert.equal(received.sha256,report.sha256);
          assert.equal(received.sourceCurrent,true);
          assert.equal(next.results['A4:investigate'].newModelRequests,1);
          const old=await runMessages(f.store,join(oldA4.directory,'plan.json'),false,oldA4.run);
          assert.equal(old.newModelRequests,0);
          assert.match(JSON.stringify(old.problems),/coordination_old_dispatch_selection_superseded/);
        }
        assert.equal(records.stage(coord,'A4','implement').phasePrerequisitesMet,true);
      }else{
        assert.equal(a4.run,oldA4.run);
        assert.equal(f.q.messages().submitted(oldA4.run,'owner-A4').length,0);
        assert.match(JSON.stringify(next),/coordination_precise_upstream_input_required/);
      }
      assert.deepEqual(records.dispatchSelection(coord,'A4','investigate')!.run,a4.run);
      const calls=await readFile(roles.trace);
      assert.equal((await run('investigate')).newModelRequests,0);
      assert.deepEqual(await readFile(roles.trace),calls);
      const history=records.outputOriginal(coord,original.sha256);
      assert.equal(history.complete,true);
      assert.equal(hash(canonical(history.value)),original.sha256);
      const all=await run('report');
      assert.ok(all.reports.some((r:any)=>r.kind==='capability'&&r.complete&&r.result.value.run===original.run));
      summaries.push({revision,receipt:receipt.sha256,report,updated:updated.newModelRequests,next:next.newModelRequests,a4Run:a4.run});
    }
    assert.deepEqual(oldA4.context,oldA4Context);
    const reports=(await run('report')).reports.filter((report:any)=>report.kind==='capability'&&report.key.startsWith('capability:A3:'));
    assert.equal(reports.length,3);
    // Receiver and output versions share the existing three-material limit.
    await writeFile(providerState,canonical({H:produced.candidate.H,B:f.B,body:'Material revision 4'}));
    await run('collect','--pr','99');
    await run('attach');
    await assert.rejects(()=>run('receive'),/receiver_three_batch_limit/);
    if(process.env.TONGXU_TEST_CONDITIONAL_EVIDENCE){
      const parent=process.env.TONGXU_TEST_CONDITIONAL_EVIDENCE;
      await cp(f.root,join(parent,'report-'+scenario),{recursive:true});
      await cp(roles.root,join(parent,'report-roles-'+scenario),{recursive:true});
      await writeFile(join(parent,'report-summary-'+scenario+'.json'),JSON.stringify(summaries,null,2));
    }
});
