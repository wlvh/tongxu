import {join} from 'node:path';
import {randomUUID} from 'node:crypto';
import {mkdir} from 'node:fs/promises';
import {QueueStore} from './queue-store.js';
import {parseCoordinationPlan,coordinationPlanId,type CoordinationPlan} from './coordination-contract.js';
import {exactKeys,isAuthorityDigest} from './authority-contract.js';
import {messageId,messagePath} from './message-contract.js';
import {readOwnerSource,type OwnerObservation} from './authority-source.js';
import {regular} from './repair-workspace.js';
import {hash} from './snapshot.js';
import {canonical} from './comparison.js';

type Source={id:string;title:string;store:string;item:string};
type Choice={id:string;title:string;plan:{path:string;sha256:string}};
type Group={id:string;title:string;sources:string[];choices:Choice[];delegation:{adoption:string;authorization:string}|null};
type Frozen={group:Group;sources:Source[];name:string;choices:Array<{choice:Choice;plan:CoordinationPlan}>};
type Catalog={schemaVersion:1;kind:'tongxu-workbench-organization';groups:Group[]};
const title=(v:unknown):v is string=>typeof v==='string'&&Boolean(v.trim())&&v.length<=160&&!/[\x00-\x1f]/.test(v);
const reason=(e:unknown)=>e instanceof Error&&/^[a-z0-9_]+$/.test(e.message)?e.message:'organization_source_unavailable';
function parse(raw:Buffer):Catalog{
  if(raw.length>64*1024)throw new Error('organization_catalog_limit');const p=JSON.parse(new TextDecoder('utf8',{fatal:true}).decode(raw));
  if(!exactKeys(p,['schemaVersion','kind','groups'])||p.schemaVersion!==1||p.kind!=='tongxu-workbench-organization'||!Array.isArray(p.groups)||!p.groups.length||p.groups.length>8)throw new Error('organization_catalog_invalid');
  const ids=new Set();for(const g of p.groups){
    if(!exactKeys(g,['id','title','sources','choices','delegation'])||!messageId(g.id)||ids.has(g.id)||!title(g.title)||!Array.isArray(g.sources)||g.sources.length<2||g.sources.length>8||new Set(g.sources).size!==g.sources.length||g.sources.some((s:unknown)=>typeof s!=='string'||!/^[a-z0-9-]{1,64}$/.test(s))||!Array.isArray(g.choices)||!g.choices.length||g.choices.length>3||!(g.delegation===null||exactKeys(g.delegation,['adoption','authorization'])&&isAuthorityDigest(g.delegation.adoption)&&isAuthorityDigest(g.delegation.authorization)))throw new Error('organization_group_invalid');ids.add(g.id);
    const choices=new Set();for(const c of g.choices){if(!exactKeys(c,['id','title','plan'])||!messageId(c.id)||choices.has(c.id)||!title(c.title)||!exactKeys(c.plan,['path','sha256'])||!messagePath(c.plan.path)||!isAuthorityDigest(c.plan.sha256))throw new Error('organization_choice_invalid');choices.add(c.id);}
  }
  return p;
}
function planView(p:CoordinationPlan,sources:Source[]){return structuredClone({name:p.name,revision:p.revision,previous:p.previous,mode:p.mode,tasks:p.tasks.map(t=>({id:t.id,source:sources.find(s=>s.item===t.item)!.id,title:sources.find(s=>s.item===t.item)!.title,actor:t.actor,originActor:t.originActor,dispatch:t.dispatch,stages:t.stages,independentPaths:t.independentPaths,outputs:t.outputs,writerTransferConfirmed:false})),shared:p.shared.map(s=>({id:s.id,tasks:s.tasks,paths:s.paths,contract:s.contract,feedbackFrom:s.feedbackFrom,blockedStages:s.blockedStages})),dependencies:p.dependencies});}
function arrangement(p:CoordinationPlan){const {revision,previous,authorityIntent,source,...content}=p;return canonical(content);}

/** Explicit choices change the original coordination records. No role is
 * launched and no writing responsibility or grant is inferred from this UI. */
export class OrganizationControls{
  private constructor(private frozen:Frozen[],readonly catalogSha256:string){}
  static async load(path:string,sha256:string,sources:Source[]){
    const raw=await regular(path,64*1024);if(hash(raw)!==sha256)throw new Error('organization_catalog_changed');const p=parse(raw),groups:Frozen[]=[],identities=new Set<string>();
    for(const g of p.groups){const selected=g.sources.map(id=>{const s=sources.find(s=>s.id===id);if(!s)throw new Error('organization_source_not_selected');return structuredClone(s);});if(new Set(selected.map(s=>s.store)).size!==1||new Set(selected.map(s=>s.item)).size!==selected.length)throw new Error('organization_one_original_queue_required');
      const choices:Frozen['choices']=[],modes=new Set();let name:string|undefined;
      for(const c of g.choices){const bytes=await regular(c.plan.path,256*1024);if(hash(bytes)!==c.plan.sha256)throw new Error('organization_template_changed');const plan=parseCoordinationPlan(bytes);
        if(plan.previous!==null||plan.authorityIntent!==null||name&&name!==plan.name||modes.has(plan.mode)||canonical(plan.tasks.map(t=>t.item).sort())!==canonical(selected.map(s=>s.item).sort()))throw new Error('organization_template_scope_invalid');name=plan.name;modes.add(plan.mode);choices.push({choice:structuredClone(c),plan});
      }
      const identity=canonical([selected[0]!.store,name]);if(identities.has(identity))throw new Error('organization_duplicate_name');identities.add(identity);groups.push({group:structuredClone(g),sources:selected,name:name!,choices});
    }
    return new OrganizationControls(groups,sha256);
  }
  private selected(id:string){const f=this.frozen.find(g=>g.group.id===id);if(!f)throw new Error('organization_group_not_selected');return f;}
  private proposal(f:Frozen,choice:string,previous:string|null){
    const selected=f.choices.find(c=>c.choice.id===choice);if(!selected)throw new Error('organization_choice_not_selected');const seed=hash(canonical([this.catalogSha256,f.group.id,choice,previous])),plan=structuredClone(selected.plan);
    plan.previous=previous;plan.revision='r-'+seed.slice(0,24);plan.authorityIntent=f.group.delegation?'organization-'+seed.slice(0,48):null;plan.source+='\nFixed workbench choice '+f.group.id+'/'+choice+' from catalog '+this.catalogSha256;
    const raw=Buffer.from(canonical(plan));parseCoordinationPlan(raw);return {plan,raw};
  }
  async state(){return Promise.all(this.frozen.map(async f=>{
    const base={id:f.group.id,title:f.group.title,sources:f.group.sources,choices:f.choices.map(c=>({id:c.choice.id,title:c.choice.title,...planView(c.plan,f.sources)})),newModelRequests:0,writingPermissionGranted:false};
    try{const s=await QueueStore.observeOrganization(f.sources[0]!.store,f.name,f.sources.map(s=>s.item));return {...base,available:true,expectedPrevious:s.current?.id??null,current:s.current?{id:s.current.id,...planView(s.current.plan,f.sources),current:s.current.current,stages:s.current.tasks}:null,currentChoice:f.choices.find(c=>s.current&&arrangement(c.plan)===arrangement(s.current.plan))?.choice.id??null,ownerSourceConfigured:s.ownerSourceConfigured,delegationConfigured:f.group.delegation!==null,authorityMustBeRechecked:true};}
    catch(e){return {...base,available:false,reason:reason(e)};}
  }));}
  async apply(id:string,value:unknown){
    const body=structuredClone(value) as any;if(!exactKeys(body,['choice','expectedPrevious'])||!messageId(body.choice)||!(body.expectedPrevious===null||isAuthorityDigest(body.expectedPrevious)))throw new Error('organization_exact_choice_required');
    const f=this.selected(id),{plan,raw}=this.proposal(f,body.choice,body.expectedPrevious),q=await QueueStore.open(f.sources[0]!.store);
    try{
      // Exact duplicate reads remain available without refreshing a revoked
      // permission. They cannot make this old choice current again.
      try{const old=q.coordination().status(coordinationPlanId(plan));return {id,planId:old.id,duplicate:true,current:old.current,newModelRequests:0,writingPermissionGranted:false,externalStateRechecked:false};}catch(e){if((e as Error).message!=='coordination_plan_not_registered')throw e;}
      const current=q.coordination().current(f.name);
      if((current?.id??null)!==body.expectedPrevious)throw new Error('coordination_exact_previous_revision_required');
      if(current&&arrangement(current.plan)===arrangement(plan))return {id,planId:current.id,duplicate:true,current:true,newModelRequests:0,writingPermissionGranted:false,externalStateRechecked:false};
      const observations:OwnerObservation[]=[],d=f.group.delegation;
      if(d){const a=q.authority(),{profile}=a.configuration(),root=join(q.directory,'workbench-organization-sources');await mkdir(root,{recursive:true,mode:0o700});for(const ref of a.sourceRequests(d.authorization))observations.push(await readOwnerSource(profile,ref.proposalSha256,ref.commentId,join(root,randomUUID())));}
      const check=await q.refreshSelectedTaskSources(f.sources.map(s=>s.item)),result=q.registerWorkbenchOrganization(raw,f.sources.map(s=>s.item),d,observations,check);
      return {id,planId:result.state.id,duplicate:result.duplicate,current:result.state.current,arrangement:planView(result.state.plan,f.sources),authority:'authority' in result?result.authority:null,newModelRequests:0,writingPermissionGranted:false,ownerAdoptionCreated:false};
    }finally{q.close();}
  }
}
