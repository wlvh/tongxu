import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {createContext,runInContext} from 'node:vm';
import {randomUUID} from 'node:crypto';
async function ui(extra:Record<string,unknown>={}){const calls:any[]=[],context=createContext({crypto:{randomUUID},gh:{account:{id:7},selected:{id:1}},key:'fixture-key',readableReason:(s:string)=>s,render:()=>{},setTimeout:()=>0,api:async()=>({available:true,entries:[]}),workspaceFetch:(path:string,options:any)=>new Promise(resolve=>calls.push({path,options,resolve})),...extra});runInContext(await readFile(new URL('../../../web/workbench/formal-review.js',import.meta.url),'utf8'),context);return {calls,run:(s:string)=>runInContext(s,context)};}
test('a formal action error survives its successful follow-up GET refresh',async()=>{const f=await ui(),run=f.run("formalWork('registered','prepare')");assert.equal(f.calls.length,1);f.calls[0].resolve({ok:false,json:async()=>({error:'formal_current_candidate_material_not_imported'})});await run;assert.equal(f.run('formalData().error'),'当前 PR 材料还没有与最新来源核对，请补查原来源后继续。');assert.equal(f.run('formalData().pending'),false);});
test('a project switch during formal preparation cannot start its prepared operation or post an old notice',async()=>{const f=await ui(),run=f.run("formalWork('registered','prepare')");f.run('gh.selected={id:2}');f.calls[0].resolve({ok:true,json:async()=>({operation:'original-operation'})});await run;assert.equal(f.calls.length,1);assert.equal(f.run('formalData().error'),null);const before=f.calls.length;await f.run("formalWork('registered','start','old-operation','7:1')");assert.equal(f.calls.length,before);});
for(const fix of [false,true])test('formal owner report displays the original question and Issue handoff; fix='+fix,async()=>{
 const elements:Record<string,any>={},element=(id:string)=>elements[id]??={textContent:'',hidden:true},question='Choose acceptance requirement A or B',report={candidate:{pr:1,H:'h',B:'b',target:'main'},phase:'owner_decision',material:{issue:{url:'https://github.com/fixture/reception/issues/72'}},fullStages:[{role:fix?'verifier_fact':'reviewer',key:fix?'round-1/fix':'round-1/refutation-review',result:{report:fix?question:'All prior findings refuted; a business choice remains'}}],result:fix?{report:{decision:'needs_owner',report:question}}:{review:{ownerQuestions:[question]}}},f=await ui({reportNonce:0,$:element,showWorkbenchReport:()=>{},document:{querySelector:()=>element('summary')},api:async()=>report});
 await f.run("formalReport('registered','original')");assert.match(element('report-body').textContent,/Choose acceptance requirement A or B/);assert.match(element('report-body').textContent,/需要本人决定/);assert.match(element('report-body').textContent,/https:\/\/github.com\/fixture\/reception\/issues\/72/);assert.match(element('report-body').textContent,/影响范围和答复理由/);assert.equal(element('report-original').hidden,false);
});

test('formal needs-evidence report displays the complete rejected native text and its separate rejection record',async()=>{
 const elements:Record<string,any>={},element=(id:string)=>elements[id]??={textContent:'',hidden:true};
 const original=JSON.stringify({verdict:'PASS',report:'Explicit complete native fixture text',coverageGaps:['The caller was not checked']});
 const report={candidate:{pr:1,H:'h',B:'b',target:'main'},phase:'needs_evidence',
  fullStages:[{role:'reviewer',key:'round-1/review',result:{report:original,protocolRejection:'formal_pass_has_unresolved_work',formalJudgmentAccepted:false}}],
  result:{status:'needs_evidence',reason:'formal_pass_has_unresolved_work',formalJudgmentAccepted:false}};
 const f=await ui({reportNonce:0,$:element,showWorkbenchReport:()=>{},document:{querySelector:()=>element('summary')},api:async()=>report});
 await f.run("formalReport('registered','original')");
 assert.ok(element('report-body').textContent.includes(original));
 assert.ok(!element('report-body').textContent.includes('[object Object]'));
 assert.match(element('report-meta').textContent,/needs_evidence/);
 assert.match(element('report-raw').textContent,/formal_pass_has_unresolved_work/);
 assert.equal(JSON.parse(element('report-raw').textContent).result.formalJudgmentAccepted,false);
 assert.equal(element('report-original').hidden,false);
});

for(const mode of ['exhausted','waiting','active','legacy'])test('formal waiting refresh follows automatic continuation state: '+mode,async()=>{
 let timers=0;
 const request={operation:'original',phase:'awaiting_publication',stopped:false,controllerActive:mode==='active',
  ...(mode==='legacy'?{}:{automaticContinuation:{used:mode==='waiting'?1:360,limit:360,exhausted:mode!=='waiting'}})};
 const f=await ui({setTimeout:()=>{timers++;return 0;},api:async()=>({available:true,entries:[{requests:[request]}]})});
 await f.run('loadFormalReviews()');
 assert.equal(timers,mode==='exhausted'?0:1);
});

test('formal automatic exhaustion shows its limit and leaves the manual check usable',async()=>{
 type Element={tag:string;textContent:string;children:Element[];disabled:boolean;onclick?:()=>Promise<void>;append:(...children:Element[])=>void};
 const element=(tag:string,text='',className=''):Element=>({tag,textContent:text,children:[],disabled:false,
  append(...children:Element[]){this.children.push(...children);}});
 const request={operation:'original',phase:'awaiting_publication',stopped:false,controllerActive:false,round:1,
  candidate:{H:'a'.repeat(40),target:'main'},automaticContinuation:{used:360,limit:360,exhausted:true}};
 const entry={id:'registered',source:'source',requests:[request]};
 const f=await ui({el:element,append:(node:Element,...children:Element[])=>{node.append(...children);return node;},
  api:async()=>({available:true,entries:[entry]})});
 await f.run('loadFormalReviews()');
 const panel=f.run("formalReviewPanel('source')") as Element;
 const nodes:Element[]=[];
 const visit=(node:Element)=>{nodes.push(node);node.children.forEach(visit);};visit(panel);
 assert.match(nodes.map(node=>node.textContent).join('\n'),/自动核对.*360.*手动/);
 const manual=nodes.find(node=>node.tag==='button'&&node.textContent==='核对已发布的新候选');
 assert.ok(manual);assert.equal(manual.disabled,false);
 const action=manual.onclick!();
 assert.equal(f.calls.length,1);assert.match(f.calls[0].path,/registered\/check$/);
 f.calls[0].resolve({ok:true,json:async()=>({})});await action;
});
