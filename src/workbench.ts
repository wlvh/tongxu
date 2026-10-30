import {ProjectChat} from './project-chat.js';
import {AISettings,validateAISettingsConfig,withAIPreferences,type AISettingsConfig} from './ai-settings.js';
import type {inspectAIProvider} from './ai-catalog.js';
import {validateProjectChatConfig,type ProjectChatConfig} from './project-chat-contract.js';
import {GitHubProjects,GitHubProjectError,type GitHubReaderFactory} from './github-projects.js';
import { readFile } from 'node:fs/promises';
import { isAbsolute, resolve } from 'node:path';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { QueueStore } from './queue-store.js';
import { regular } from './repair-workspace.js';
import { hash } from './snapshot.js';
import {TaskControls,TaskControlRegistrationError} from './task-controls.js';
import {exactKeys,isAuthorityDigest} from './authority-contract.js';
import {messagePath} from './message-contract.js';
import type {DeliverySelection} from './delivery-controls.js';
import {DeliveryWorkspaceControls} from './delivery-workspace-controls.js';
import {DeliveryExecutionControls} from './delivery-execution-controls.js';
import {OwnerControls} from './owner-controls.js';
import {ScopeFollowupControls} from './scope-followup-controls.js';
import {OrganizationControls} from './organization-controls.js';
import {OverallControls,validateOverallSelections,type OverallSelection} from './overall-controls.js';
import type {WorkbenchRuntimeIdentity} from './workbench-launch.js';
import {QueueEventControls} from './queue-event-controls.js';
import {SourceTickLoop,validateEventPolling,type EventPollingSelection} from './event-loop.js';
import {SecretaryControls} from './secretary-controls.js';
import {ReturnControls} from './return-controls.js';

type Row = Record<string, any>;
export type WorkbenchPlan = {
  schemaVersion: 1; kind: 'tongxu-local-workbench'|'tongxu-controlled-workbench'; title: string; goal: string;
  sources: Array<{ id: string; title: string; store: string; item: string }>;
  controls?:{path:string;sha256:string};
  deliveries?:DeliverySelection[];
  deliveryExecutions?:{path:string;sha256:string};
  ownerControls?:string[];
  organization?:{path:string;sha256:string};
  overallReviews?:OverallSelection[];
  eventControls?:{path:string;sha256:string};
  eventPolling?:EventPollingSelection[];
  secretary?:{path:string;sha256:string};
  returnControls?:{path:string;sha256:string};
  githubProjects?:true;
  projectSecretary?:ProjectChatConfig;
  aiSettings?:AISettingsConfig;
};
const text = (v: unknown, max: number): v is string => typeof v === 'string' && !!v.trim() && v.length <= max && !v.includes('\0');
export function parseWorkbenchPlan(bytes: Buffer): WorkbenchPlan {
  const p = JSON.parse(bytes.toString());
  if (p.schemaVersion !== 1 || !['tongxu-local-workbench','tongxu-controlled-workbench'].includes(p.kind) || !text(p.title, 100) || !text(p.goal, 1000) || !Array.isArray(p.sources) || !p.sources.length&&!p.githubProjects || p.sources.length > 8) throw new Error('invalid_workbench_plan');
  if(p.kind==='tongxu-controlled-workbench'?(p.controls?!exactKeys(p.controls,['path','sha256'])||!messagePath(p.controls.path)||!isAuthorityDigest(p.controls.sha256):!p.deliveries?.length&&!p.ownerControls?.length&&!p.organization&&!p.overallReviews?.length&&!p.eventControls&&!p.eventPolling&&!p.secretary&&!p.returnControls):Object.hasOwn(p,'controls')||Object.hasOwn(p,'ownerControls')||Object.hasOwn(p,'organization')||Object.hasOwn(p,'overallReviews')||Object.hasOwn(p,'deliveryExecutions')||Object.hasOwn(p,'eventControls')||Object.hasOwn(p,'eventPolling')||Object.hasOwn(p,'secretary')||Object.hasOwn(p,'returnControls'))throw new Error('invalid_workbench_controls');
  if(Object.hasOwn(p,'returnControls')&&(!exactKeys(p.returnControls,['path','sha256'])||!messagePath(p.returnControls.path)||!isAuthorityDigest(p.returnControls.sha256)))throw new Error('invalid_workbench_return_controls');
  if(Object.hasOwn(p,'eventControls')&&(!exactKeys(p.eventControls,['path','sha256'])||!messagePath(p.eventControls.path)||!isAuthorityDigest(p.eventControls.sha256)))throw new Error('invalid_workbench_event_controls');
  if(Object.hasOwn(p,'secretary')&&(!exactKeys(p.secretary,['path','sha256'])||!messagePath(p.secretary.path)||!isAuthorityDigest(p.secretary.sha256)))throw new Error('invalid_workbench_secretary');
  if(Object.hasOwn(p,'deliveryExecutions')&&(!p.ownerControls?.length||!exactKeys(p.deliveryExecutions,['path','sha256'])||!messagePath(p.deliveryExecutions.path)||!isAuthorityDigest(p.deliveryExecutions.sha256)))throw new Error('invalid_workbench_delivery_executions');
  if(Object.hasOwn(p,'organization')&&(!exactKeys(p.organization,['path','sha256'])||!messagePath(p.organization.path)||!isAuthorityDigest(p.organization.sha256)))throw new Error('invalid_workbench_organization');
  if(Object.hasOwn(p,'githubProjects')&&p.githubProjects!==true)throw new Error('invalid_workbench_github_projects');
  if(p.projectSecretary!==undefined){if(!p.githubProjects)throw new Error('project_chat_requires_github');validateProjectChatConfig(p.projectSecretary);}
  if(p.aiSettings!==undefined){if(!p.githubProjects)throw new Error('ai_settings_requires_github');validateAISettingsConfig(p.aiSettings);}
  const ids = new Set(), tasks = new Set();
  for (const s of p.sources) {
    if (!s || typeof s.id !== 'string' || !/^[a-z0-9-]{1,64}$/.test(s.id) || !text(s.title, 100) || !/^[a-f0-9]{64}$/.test(s.item) || typeof s.store !== 'string' || !isAbsolute(s.store) || resolve(s.store) !== s.store || ids.has(s.id) || tasks.has(s.store + ':' + s.item)) throw new Error('invalid_workbench_source');
    ids.add(s.id); tasks.add(s.store + ':' + s.item);
  }
  if(Object.hasOwn(p,'deliveries')){if(!Array.isArray(p.deliveries)||!p.deliveries.length||p.deliveries.length>8)throw new Error('invalid_workbench_deliveries');const entries=new Set(),batches=new Set();for(const d of p.deliveries){if(!exactKeys(d,['id','source','batchSha256'])||typeof d.id!=='string'||!/^[a-z0-9-]{1,64}$/.test(d.id)||entries.has(d.id)||!ids.has(d.source)||!isAuthorityDigest(d.batchSha256)||batches.has(d.source+':'+d.batchSha256))throw new Error('invalid_workbench_delivery');entries.add(d.id);batches.add(d.source+':'+d.batchSha256);}}
  if(Object.hasOwn(p,'ownerControls')&&(!Array.isArray(p.ownerControls)||!p.ownerControls.length||p.ownerControls.length>8||new Set(p.ownerControls).size!==p.ownerControls.length||p.ownerControls.some((id:unknown)=>!ids.has(id))))throw new Error('invalid_workbench_owner_controls');
  if(Object.hasOwn(p,'overallReviews'))validateOverallSelections(p.overallReviews,[...ids] as string[]);
  if(Object.hasOwn(p,'eventPolling'))validateEventPolling(p.eventPolling,p.sources);
  return { schemaVersion: 1, kind: p.kind, title: p.title, goal: p.goal, sources: p.sources.map((s: Row) => ({ id: s.id, title: s.title, store: s.store, item: s.item })),...(p.controls?{controls:p.controls}:{}),...(p.deliveries?{deliveries:p.deliveries}:{}),...(p.deliveryExecutions?{deliveryExecutions:p.deliveryExecutions}:{}),...(p.ownerControls?{ownerControls:p.ownerControls}:{}),...(p.organization?{organization:p.organization}:{}),...(p.overallReviews?{overallReviews:p.overallReviews}:{}),...(p.eventControls?{eventControls:p.eventControls}:{}),...(p.eventPolling?{eventPolling:p.eventPolling}:{}),...(p.secretary?{secretary:p.secretary}:{}),...(p.returnControls?{returnControls:p.returnControls}:{}),...(p.githubProjects?{githubProjects:true as const}:{}),...(p.projectSecretary?{projectSecretary:p.projectSecretary}:{}),...(p.aiSettings?{aiSettings:p.aiSettings}:{}) };
}
export function receptionStage(o: Row) {
  const r = o.result?.receiver;
  if (!r) return o.status === 'running' ? 'local_inspection_pending' : 'not_dispatched';
  if (r.phase === 'returned' && r.judgment) return r.currentMaterialMatches === false ? 'historical_result' : 'returned';
  if (r.invalidResult) return 'returned_invalid';
  if (r.phase === 'closed_unresolved') return 'closed_unresolved';
  return r.phase === 'reserved' ? 'preparing' : 'submitted_or_unknown';
}
const safeError = (e: unknown) => e instanceof Error && /^[a-z0-9_]+$/.test(e.message) ? e.message : 'source_unavailable';
type StoreSnapshot = { value: Row; observedAt: string } | { error: string; observedAt: string };
async function stores(p: WorkbenchPlan) {
  return new Map<string, StoreSnapshot>(await Promise.all([...new Set(p.sources.map(s => s.store))].map(async store => {
    try { const selected=p.sources.filter(s=>s.store===store).map(s=>s.item);return [store, { value: await QueueStore.observe(store, selected, [], selected), observedAt: new Date().toISOString() }] as const; }
    catch (e) { return [store, { error: safeError(e), observedAt: new Date().toISOString() }] as const; }
  })));
}
function judgment(o: Row) {
  const j = o.result?.receiver?.judgment;
  return j ? { id: j.judgmentId, verdict: j.verdict, reportSha256: hash(j.report), findings: [0, 1, 2].map(priority => ({ priority, count: j.findings.filter((f: Row) => f.priority === priority).length })) } : null;
}
function publication(pub: Row | undefined) {
  if (!pub) return null;
  const { githubState, ...record } = pub;
  // The publisher records verified only after exact remote readback. Its
  // desired value alone is not evidence of a send or a current GitHub state.
  return { ...record, plannedGithubState: githubState, recordedGithubState: pub.status === 'verified' ? githubState : null, remoteRechecked: false };
}
export async function workbenchState(p: WorkbenchPlan) {
  const snapshots = await stores(p), tasks: Row[] = [], events: Row[] = [];
  for (const s of p.sources) {
    const snapshot = snapshots.get(s.store)!, base = { id: s.id, title: s.title, observedAt: snapshot.observedAt };
    if ('error' in snapshot) { tasks.push({ ...base, available: false, error: snapshot.error }); continue; }
    const q = snapshot.value, item = q.items.find((i: Row) => i.id === s.item);
    if (!item) { tasks.push({ ...base, available: false, error: 'selected_task_not_found' }); continue; }
    const ops = q.operations.filter((o: Row) => o.item === s.item);
    if (ops.length > 64) { tasks.push({ ...base, available: false, error: 'operation_history_limit' }); continue; }
    const operations = ops.map((o: Row) => ({
      id: o.id, packet: o.packet, currentPacket: o.packet === item.currentPacket, stage: receptionStage(o),
      startedAt: o.started_at, finishedAt: o.finished_at, judgment: judgment(o),
      invalidOutput: o.result?.receiver?.invalidResult ?? null,
      correctionOf: o.result?.receiver?.correctionOf ?? null,
      consumedPrerequisite: o.result?.receiver?.judgment?.consumedPrerequisite ?? null,
      nativeExecution: o.nativeExecution,
      ...(o.result?.receiver?.subject?{subject:o.result.receiver.subject,subjectSha256:o.result.receiver.subjectSha256}:{}),
      publication: publication(q.publications.find((pub: Row) => pub.operation === o.id)),
      recovery: o.recovery, productionActionAllowed: false
    }));
    let judgmentFeedback:Row;try{judgmentFeedback={available:true,...await QueueStore.observeJudgmentFeedback(s.store,s.item)};}catch(e){judgmentFeedback={available:false,reason:safeError(e)};}
    tasks.push({ ...base, available: true, judgmentFeedback,candidate: item.candidate, ...(item.developmentTask?{developmentTask:item.developmentTask}:{}), ...(item.summary.composition?{composition:item.summary.composition,compositionCurrent:item.compositionCurrent}:{}), currentPacket: item.currentPacket,
      observationConflict: item.observationConflict, evidenceComplete: item.summary.evidenceComplete,
      sourceObservedAt: item.latestSourceObservation, executionObservedAt: item.latestObservation,
      scope: item.context.scope, arrangement: item.context.arrangement, dependencyGaps: item.dependencyGaps,
      controls: q.controls.filter((c: Row) => c.scope === item.context.scope.id).map((c: Row) => ({ kind: c.kind, stopped: !!c.stopped, revision: c.revision, effectiveAt: c.effective_at })),
      operations, collaboration:q.collaboration[s.item], eventRevision: q.events.at(-1)?.id ?? 0, productionActionAllowed: false });
    for (const e of q.events.filter((e: Row) => ops.some((o: Row) => o.id === e.object) && ['receiver_reserved', 'receiver_dispatch_registered', 'receiver_judgment_recorded', 'receiver_closed_unresolved','receiver_invalid_result_recorded','receiver_correction_registered'].includes(e.kind))) events.push({ id: s.id + ':' + e.id, source: s.id, title: s.title, kind: e.kind, observedAt: e.observed_at });
  }
  for (const [store, snapshot] of snapshots) {
    if (!('value' in snapshot)) continue;
    const selected = p.sources.filter(s => s.store === store), q = snapshot.value;
    for (const e of q.events.filter((e: Row) => e.kind === 'pair_registered')) {
      const pair = JSON.parse(e.data), a = selected.find(s => s.item === pair.first.item), b = selected.find(s => s.item === pair.second.item);
      if (!a || !b) continue;
      for (const ev of q.events.filter((ev: Row) => ev.object === e.object && ['pair_registered', 'pair_independent_inspection', 'pair_shared_waiting', 'pair_shared_consumed'].includes(ev.kind))) events.push({ id: a.id + ':' + ev.id, source: a.id, title: a.title + ' → ' + b.title, kind: ev.kind, observedAt: ev.observed_at });
    }
  }
  return { schemaVersion: 1, title: p.title, goal: p.goal, mode: p.controls?'bounded_task_contacts':p.kind==='tongxu-controlled-workbench'?'bounded_delivery_outcomes':'read_only', tasks, events: events.sort((a, b) => a.observedAt.localeCompare(b.observedAt) || a.id.localeCompare(b.id)), ...(p.controls?{modelCallsStartedByThisRead:0}:{modelCallsStartedByWorkbench:0}),...(p.deliveries||p.ownerControls?{deliveries:await new DeliveryWorkspaceControls(p.deliveries??[],p.ownerControls??[],p.sources,p.kind==='tongxu-controlled-workbench').state(),deliveryPreparation:await new DeliveryWorkspaceControls(p.deliveries??[],p.ownerControls??[],p.sources,p.kind==='tongxu-controlled-workbench').preparation()}:{}), crossStoreAtomic: false, remoteRechecked: false, productionActionAllowed: false };
}
async function workbenchReport(p: WorkbenchPlan, source: string, operation: string) {
  const s = p.sources.find(s => s.id === source); if (!s) throw new Error('report_not_found');
  return {source,...await QueueStore.observeReceptionReport(s.store,s.item,operation)};
}
export async function startWorkbench(planPath: string,runtimeIdentity?:WorkbenchRuntimeIdentity,dependencies?:{githubReader?:GitHubReaderFactory;aiProbe?:typeof inspectAIProvider}) {
  const planBytes=await regular(planPath);if(runtimeIdentity&&hash(planBytes)!==runtimeIdentity.planSha256)throw new Error('workbench_runtime_plan_changed');
  const p = parseWorkbenchPlan(planBytes), token = randomBytes(32).toString('hex');
  const github=p.githubProjects?new GitHubProjects(dependencies?.githubReader):null;
  const ai=p.aiSettings?await AISettings.open(p.aiSettings,dependencies?.aiProbe):null;
  let closing=false,host='';
  const loadLocal=async(plan:WorkbenchPlan,selectedSources?:ReadonlySet<string>)=>{
    // Catalogue hashes still cover the original complete files. Only entries
    // belonging to this project's original sources load templates or controls.
    const controls=plan.controls?await TaskControls.load(plan.controls.path,plan.controls.sha256,p.sources,selectedSources):null;
    const deliveryControls=plan.deliveries||plan.ownerControls?new DeliveryWorkspaceControls(plan.deliveries??[],plan.ownerControls??[],plan.sources,plan.kind==='tongxu-controlled-workbench'):null;
    const deliveryExecution=plan.deliveryExecutions?await DeliveryExecutionControls.load(deliveryControls!,plan.deliveryExecutions.path,plan.deliveryExecutions.sha256,p.ownerControls??[],selectedSources):null;
    const ownerControls=plan.ownerControls?new OwnerControls(plan.ownerControls,plan.sources):null;
    const scopeFollowups=plan.ownerControls?new ScopeFollowupControls(plan.ownerControls,plan.sources):null;
    const organization=plan.organization?await OrganizationControls.load(plan.organization.path,plan.organization.sha256,p.sources,selectedSources):null;
    const overall=plan.overallReviews?await OverallControls.load(plan.overallReviews,plan.sources,plan.ownerControls??[]):null;
    const queueActions=plan.eventControls?await QueueEventControls.load(plan.eventControls.path,plan.eventControls.sha256,p.sources,undefined,undefined,selectedSources):null;
    const polling=plan.eventPolling?await SourceTickLoop.load(plan.eventPolling,plan.sources):null;
    const secretary=plan.secretary?await SecretaryControls.load(plan.secretary.path,plan.secretary.sha256,p.sources,selectedSources):null;
    const returns=plan.returnControls?await ReturnControls.load(plan.returnControls.path,plan.returnControls.sha256,p.sources,selectedSources):null;
    return {controls,deliveryControls,deliveryExecution,ownerControls,scopeFollowups,organization,overall,queueActions,polling,secretary,returns};
  };
  type Local=Awaited<ReturnType<typeof loadLocal>>;
  const locals=new Map<string,{sources:string;value:Promise<Local>}>(),knownRepositories=new Map<string,string>();
  const openLocal=(plan:WorkbenchPlan,key='legacy',selectedSources?:ReadonlySet<string>,cacheable=true)=>{
    if(closing)throw new Error('workbench_closing');const sources=plan.sources.map(s=>s.id).sort().join(','),old=locals.get(key);
    if(old){if(old.sources!==sources)throw new Error('workbench_project_sources_changed');return old.value;}
    // An initially unknown source may recover. Until all bindings are known,
    // reads use temporary non-running controls; no incomplete cache or action
    // is created. Existing running controllers always retain their identity.
    if(!cacheable)return loadLocal(plan,selectedSources);
    const entry={sources,value:loadLocal(plan,selectedSources).then(value=>{if(host&&!closing)value.polling?.start();return value;}).catch(error=>{locals.delete(key);throw error;})};locals.set(key,entry);return entry.value;
  };
  const projectPlan=async(selection:ReturnType<GitHubProjects['selection']>)=>{
    const repository=selection.repository.fullName.toLowerCase(),allowed=new Set<string>();let unresolvedSourceCount=0,selectedSourcesUnknown=false;
    for(const store of new Set(p.sources.map(s=>s.store))){
      const sources=p.sources.filter(s=>s.store===store);
      try{const name=await QueueStore.observeWorkbenchRepository(store,sources.map(s=>s.item));for(const source of sources){knownRepositories.set(source.id,name);if(name===repository)allowed.add(source.id);}}
      catch{for(const source of sources){const known=knownRepositories.get(source.id);if(known===repository){allowed.add(source.id);selectedSourcesUnknown=true;}if(!known||known===repository)unresolvedSourceCount++;}}
    }
    github!.assertSelection(selection);
    const plan:WorkbenchPlan={...p,title:selection.repository.fullName,goal:'本项目的任务、完整报告、协作与秘书记录。选择项目不会自动启动执行或授予新权限。',sources:p.sources.filter(s=>allowed.has(s.id))};
    if(!plan.sources.length){for(const key of ['controls','deliveries','deliveryExecutions','ownerControls','organization','overallReviews','eventControls','eventPolling','secretary','returnControls'] as const)delete plan[key];plan.kind='tongxu-local-workbench';}
    else{
      if(plan.deliveries){plan.deliveries=plan.deliveries.filter(d=>allowed.has(d.source));if(!plan.deliveries.length)delete plan.deliveries;}
      if(plan.ownerControls){plan.ownerControls=plan.ownerControls.filter(id=>allowed.has(id));if(!plan.ownerControls.length){delete plan.ownerControls;delete plan.deliveryExecutions;}}
      if(plan.overallReviews){plan.overallReviews=plan.overallReviews.filter(r=>allowed.has(r.source));if(!plan.overallReviews.length)delete plan.overallReviews;}
      if(plan.eventPolling){plan.eventPolling=plan.eventPolling.filter(r=>allowed.has(r.source));if(!plan.eventPolling.length)delete plan.eventPolling;}
    }
    return {plan,allowed,selectedSourcesUnknown,project:{account:selection.account,repository:selection.repository,unresolvedSourceCount}};
  };
  const verifyProject=async(scope:ReturnType<GitHubProjects['selection']>)=>{if(closing)throw new Error('workbench_closing');await github!.confirmSelection(scope.account.id,scope.repository.id);github!.assertSelection(scope);};
  let projectChat:Promise<ProjectChat>|undefined;
  const openProjectChat=()=>{
    if(!p.projectSecretary||!github)throw new Error('project_chat_not_configured');
    return projectChat??=ProjectChat.open(p.projectSecretary,async(scope,tool,args)=>{
      if(!args||typeof args!=='object'||Array.isArray(args))throw new Error('project_chat_tool_arguments_invalid');
      if(tool==='tongxu_project_info'){if(!exactKeys(args,[]))throw new Error('project_chat_tool_arguments_invalid');await verifyProject(scope);return github!.selection(scope.account.id,scope.repository.id);}
      if(tool==='tongxu_project_items'||tool==='tongxu_project_item'){
        const detail=tool==='tongxu_project_item';if(Object.keys(args).some(k=>!(detail?['kind','number']:['kind','state','page','cursor']).includes(k))||!['issues','pulls'].includes(args.kind)||detail&&(!Number.isSafeInteger(args.number)||args.number<1))throw new Error('project_chat_tool_arguments_invalid');
        const path='/api/github/repositories/'+scope.repository.id+'/'+args.kind+(detail?'/'+args.number:'');const url=new URL('http://127.0.0.1'+path);url.searchParams.set('account',String(scope.account.id));if(!detail)for(const key of ['state','page','cursor'])if(args[key]!==undefined)url.searchParams.set(key,String(args[key]));return github!.read(url);
      }
      const context=await projectPlan(scope);
      if(tool==='tongxu_project_tasks'){if(!exactKeys(args,[]))throw new Error('project_chat_tool_arguments_invalid');return {...await workbenchState(context.plan),project:context.project};}
      if(tool==='tongxu_project_report'){if(!exactKeys(args,['source','operation'])||typeof args.source!=='string'||typeof args.operation!=='string')throw new Error('project_chat_tool_arguments_invalid');return workbenchReport(context.plan,args.source,args.operation);}
      throw new Error('project_chat_tool_not_allowed');
    },verifyProject).catch(error=>{projectChat=undefined;throw error;});
  };
  const initial=p.githubProjects?null:await openLocal(p);
  const assets = new Map<string, { type: string; bytes: Buffer }>();
  for (const [path, name, type] of [['/', 'index.html', 'text/html'], ['/app.js', 'app.js', 'text/javascript'], ['/project-chat.js','project-chat.js','text/javascript'], ['/ai-settings.js','ai-settings.js','text/javascript'], ['/app.css', 'app.css', 'text/css'], ['/favicon.svg', 'favicon.svg', 'image/svg+xml']]) assets.set(path!, { type: type! + '; charset=utf-8', bytes: await readFile(new URL('../../web/workbench/' + name!, import.meta.url)) });
  function reply(res: ServerResponse, status: number, type: string, data: string | Buffer) {
    res.writeHead(status, { 'content-type': type, 'cache-control': 'no-store', 'x-content-type-options': 'nosniff', 'referrer-policy': 'no-referrer', 'x-frame-options': 'DENY', 'content-security-policy': "default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'self'; base-uri 'none'; frame-ancestors 'none'; form-action 'none'" }); res.end(data);
  }
  const json = (res: ServerResponse, code: number, value: unknown) => reply(res, code, 'application/json; charset=utf-8', JSON.stringify(value));
  const authorized = (req: IncomingMessage) => {
    const supplied = Buffer.from(req.headers.authorization ?? ''), expected = Buffer.from('Bearer ' + token);
    return supplied.length === expected.length && timingSafeEqual(supplied, expected);
  };
  const server = createServer(async (req, res) => {
    try {
      if (req.headers.host !== host || req.headers.origin && req.headers.origin !== 'http://' + host) { json(res, 403, { error: 'local_origin_required' }); return; }
      const url = new URL(req.url ?? '/', 'http://' + host);
      if(closing){json(res,503,{error:'workbench_closing'});return;}
      if(url.pathname==='/api/entry'||url.pathname.startsWith('/api/github/')){
        if(!authorized(req)){json(res,401,{error:'viewer_key_required'});return;}
        if(req.method!=='GET'){json(res,405,{error:'github_read_only'});return;}
        if(url.pathname==='/api/entry'){if(url.search){json(res,400,{error:'query_not_supported'});return;}json(res,200,{githubProjects:!!github,hasLocalSources:p.sources.length>0,projectSecretary:!!p.projectSecretary,aiSettings:!!p.aiSettings,runtime:runtimeIdentity??null});return;}
        if(!github){json(res,404,{error:'github_projects_not_enabled'});return;}
        json(res,200,await github.read(url));return;
      }

      if (url.search&&!/^\/api\/judgment-feedback-report\/[a-z0-9-]{1,64}$/.test(url.pathname)) { json(res, 400, { error: 'query_not_supported' }); return; }
      const asset=assets.get(url.pathname);if(req.method==='GET'&&asset){reply(res,200,asset.type,asset.bytes);return;}
      if(!authorized(req)){json(res,401,{error:'viewer_key_required'});return;}
      // Stopping an already owned request is cleanup, not new investment. It
      // remains available when GitHub or the login connection is unavailable.
      if(url.pathname==='/api/project-secretary/stop'&&req.method==='POST'){
        if(req.headers.origin!=='http://'+host||req.headers['content-type']!=='application/json'){json(res,403,{error:'same_origin_json_required'});return;}
        const chunks:Buffer[]=[];let size=0;for await(const chunk of req){size+=chunk.length;if(size>4096){json(res,413,{error:'project_chat_stop_invalid'});return;}chunks.push(Buffer.from(chunk));}
        const body=JSON.parse(new TextDecoder('utf8',{fatal:true}).decode(Buffer.concat(chunks)));if(!exactKeys(body,['requestId']))throw new Error('project_chat_stop_invalid');
        const chat=await openProjectChat();json(res,200,await chat.stopSelected(Number(req.headers['x-tongxu-account']),Number(req.headers['x-tongxu-project']),body.requestId));return;
      }
      const selection=github?await github.confirmSelection(Number(req.headers['x-tongxu-account']),Number(req.headers['x-tongxu-project'])):null;
      const withAI=<T>(fn:()=>T)=>ai&&selection?withAIPreferences(ai.snapshot(selection),fn):fn();
      if(url.pathname.startsWith('/api/ai-settings')){
        if(!ai||!selection)throw new Error('ai_settings_not_configured');
        if(req.method==='GET'&&url.pathname==='/api/ai-settings'){json(res,200,ai.state(selection));return;}
        if(req.method!=='POST'||!['/api/ai-settings/scan','/api/ai-settings/role'].includes(url.pathname)){json(res,405,{error:'ai_settings_route_not_allowed'});return;}
        if(req.headers.origin!=='http://'+host||req.headers['content-type']!=='application/json'){json(res,403,{error:'same_origin_json_required'});return;}
        const chunks:Buffer[]=[];let bytes=0;for await(const chunk of req){bytes+=chunk.length;if(bytes>8192){json(res,413,{error:'ai_settings_request_invalid'});return;}chunks.push(Buffer.from(chunk));}
        const body=JSON.parse(new TextDecoder('utf8',{fatal:true}).decode(Buffer.concat(chunks)));await verifyProject(selection);
        if(url.pathname.endsWith('/scan')){if(!exactKeys(body,[]))throw new Error('ai_settings_request_invalid');const result=await ai.scan(selection);await verifyProject(selection);json(res,200,result);}else json(res,200,await ai.change(selection,body));return;
      }
      if(url.pathname.startsWith('/api/project-secretary')){
        if(!selection)throw new Error('project_chat_requires_github');
        if(!p.projectSecretary){if(req.method!=='GET')throw new Error('project_chat_not_configured');json(res,200,{available:false,reason:'project_chat_not_configured',conversations:[],newModelInputs:0});return;}
        const chat=await openProjectChat(),conversation=/^\/api\/project-secretary\/conversations\/([0-9a-f-]{36})$/.exec(url.pathname);
        if(req.method==='GET'){
          if(url.pathname==='/api/project-secretary'){const settings=ai?.state(selection),choice=settings?.choices.secretary,provider=settings?.catalog.find(p=>p.id===choice?.providerId);json(res,200,{...await chat.list(selection),aiChoice:choice?{tool:provider?.tool??null,model:choice.model,resolvedModel:provider?.models.find(m=>m.id===choice.model)?.resolvedId??null,effort:choice.effort,configured:true}:null});}
          else if(conversation)json(res,200,await chat.conversation(selection,conversation[1]!));else json(res,404,{error:'route_not_found'});return;
        }
        if(req.method!=='POST'||!['/api/project-secretary/ask','/api/project-secretary/stop'].includes(url.pathname)){json(res,405,{error:'project_chat_route_not_allowed'});return;}
        if(req.headers.origin!=='http://'+host||req.headers['content-type']!=='application/json'){json(res,403,{error:'same_origin_json_required'});return;}
        const chunks:Buffer[]=[];let bytes=0;for await(const chunk of req){bytes+=chunk.length;if(bytes>64*1024){json(res,413,{error:'project_chat_question_limit'});return;}chunks.push(Buffer.from(chunk));}
        const body=JSON.parse(new TextDecoder('utf8',{fatal:true}).decode(Buffer.concat(chunks)));await verifyProject(selection);
        if(url.pathname.endsWith('/ask'))json(res,202,await withAI(()=>chat.begin(selection,body)));else{if(!exactKeys(body,['requestId']))throw new Error('project_chat_stop_invalid');json(res,200,await chat.stopSelected(selection.account.id,selection.repository.id,body.requestId));}return;
      }
      const context=selection?await projectPlan(selection):null,plan=context?.plan??p;
      const deferred=!!context?.project.unresolvedSourceCount&&!locals.has('project:'+selection?.repository.id);
      if(req.method!=='GET'&&(context?.selectedSourcesUnknown||deferred))throw new Error('workbench_project_sources_unknown');
      const {controls,deliveryControls,deliveryExecution,ownerControls,scopeFollowups,organization,overall,queueActions,polling,secretary,returns}=await openLocal(plan,selection?'project:'+selection.repository.id:'legacy',context?.allowed,!deferred);
      if(selection)github!.assertSelection(selection);
      if(req.method!=='GET'){
        if(!controls&&!deliveryControls?.writable&&!ownerControls&&!organization&&!overall&&!queueActions&&!secretary&&!returns){json(res,405,{error:'read_only_workbench'});return;}
        if(!authorized(req)){json(res,401,{error:'viewer_key_required'});return;}
        const action=/^\/api\/task-control\/([A-Za-z0-9][A-Za-z0-9_.:-]{0,127})\/(start|cancel|native|close-interrupted)$/.exec(url.pathname);
        const scope=/^\/api\/scope-control\/([A-Za-z0-9][A-Za-z0-9_.-]{0,63})\/(stopped|open)$/.exec(url.pathname);
        const delivery=/^\/api\/delivery\/([a-z0-9-]{1,64})\/(prepare|apply)$/.exec(url.pathname);
        const deliveryWork=/^\/api\/delivery-work\/([a-z0-9-]{1,64})\/(prepare|owner-apply|run|reconcile|close-unstarted)$/.exec(url.pathname);
        const batchPreparation=/^\/api\/delivery-preparation\/([a-z0-9-]{1,64})\/register$/.exec(url.pathname);
        const owner=/^\/api\/owner-control\/([a-z0-9-]{1,64})\/(prepare|apply)$/.exec(url.pathname);
        const followup=/^\/api\/scope-followup\/([a-z0-9-]{1,64})\/(prepare|observe|owner-prepare|owner-apply|start|cancel|native|close-interrupted)$/.exec(url.pathname);
        const arrangement=/^\/api\/organization\/([A-Za-z0-9][A-Za-z0-9_.-]{0,63})\/apply$/.exec(url.pathname);
        const overallBaseline=/^\/api\/overall-baseline\/([a-z0-9-]{1,64})\/prepare$/.exec(url.pathname);
        const retrospective=/^\/api\/overall-review\/([a-z0-9-]{1,64})\/(prepare|run|reconcile|close-unstarted)$/.exec(url.pathname);
        const queueAction=/^\/api\/queue-action\/([A-Za-z0-9][A-Za-z0-9_.:-]{0,127})\/run$/.exec(url.pathname);
        const returnAction=/^\/api\/return-work\/([A-Za-z0-9][A-Za-z0-9_.:-]{0,127})\/(start|reconcile|close-unstarted)$/.exec(url.pathname);
        const secretaryAction=/^\/api\/secretary\/([a-z0-9-]{1,64})\/(ask|close-unstarted)$/.exec(url.pathname);
        if(req.method!=='POST'||!(controls&&(action||scope)||deliveryControls?.writable&&(delivery||batchPreparation)||deliveryExecution&&deliveryWork||ownerControls&&owner||scopeFollowups&&followup||organization&&arrangement||overall&&(retrospective||overallBaseline)||queueActions&&queueAction||secretary&&secretaryAction||returns&&returnAction)){json(res,405,{error:'task_control_route_not_allowed'});return;}
        if(req.headers.origin!=='http://'+host||req.headers['content-type']!=='application/json'){json(res,403,{error:'same_origin_json_required'});return;}
        const chunks:Buffer[]=[];let size=0;for await(const chunk of req){const bytes=Buffer.from(chunk);size+=bytes.length;if(size>(owner||followup||batchPreparation||deliveryWork?98304:delivery||secretaryAction?16384:1024)){json(res,413,{error:'task_control_body_limit'});return;}chunks.push(bytes);}
        let body:any;try{body=JSON.parse(new TextDecoder('utf8',{fatal:true}).decode(Buffer.concat(chunks)));}catch{json(res,400,{error:'task_control_invalid_json'});return;}
        if(selection){await github!.confirmSelection(selection.account.id,selection.repository.id);github!.assertSelection(selection);}
        if(returnAction){json(res,202,await withAI(()=>returns!.begin(returnAction[1]!,returnAction[2]!,body)));return;}
        if(secretaryAction){if(secretaryAction[2]==='ask')json(res,202,await withAI(()=>secretary!.begin(secretaryAction[1]!,body)));else{if(!exactKeys(body,['requestId']))throw new Error('secretary_question_invalid');json(res,200,await secretary!.closeUnstarted(secretaryAction[1]!,body.requestId));}return;}
        if(queueAction){if(!exactKeys(body,['requestId']))throw new Error('event_control_request_id_invalid');json(res,200,await queueActions!.execute(queueAction[1]!,body.requestId));return;}
        if(delivery){json(res,200,delivery[2]==='prepare'?await deliveryControls!.prepare(delivery[1]!,body):await deliveryControls!.apply(delivery[1]!,body));return;}
        if(deliveryWork){const id=deliveryWork[1]!,action=deliveryWork[2]!;if(action==='prepare')json(res,200,await deliveryExecution!.prepare(id,body));else if(action==='owner-apply')json(res,200,await deliveryExecution!.applyOwner(id,body));else json(res,202,await withAI(()=>deliveryExecution!.begin(id,action as 'run'|'reconcile'|'close-unstarted',body)));return;}
        if(batchPreparation){json(res,200,await deliveryControls!.register(batchPreparation[1]!,body));return;}
        if(owner){json(res,200,owner[2]==='prepare'?await ownerControls!.prepare(owner[1]!,body):await ownerControls!.apply(owner[1]!,body));return;}
        if(followup){const action=followup[2]!,source=followup[1]!;if(action==='prepare')json(res,200,await withAI(()=>scopeFollowups!.prepare(source,body)));else if(action==='observe')json(res,200,await scopeFollowups!.observe(source,body));else if(action==='owner-prepare'||action==='owner-apply')json(res,200,await scopeFollowups!.owner(source,action==='owner-prepare'?'prepare':'apply',body));else if(action==='native')json(res,200,await scopeFollowups!.native(source,body));else json(res,202,withAI(()=>scopeFollowups!.begin(source,action as 'start'|'cancel'|'close-interrupted',body)));return;}
        if(overallBaseline){json(res,200,await overall!.prepareFromBaseline(overallBaseline[1]!,body));return;}
        if(retrospective){json(res,202,await withAI(()=>overall!.begin(retrospective[1]!,retrospective[2]! as any,body)));return;}
        if(arrangement){json(res,200,await organization!.apply(arrangement[1]!,body));return;}
        if(scope){if(!exactKeys(body,['revision'])||!Number.isSafeInteger(body.revision)||body.revision<0){json(res,400,{error:'scope_control_revision_required'});return;}json(res,200,await controls!.setScope(scope[1]!,scope[2]!,body.revision));return;}
        if(action![2]==='native'){json(res,200,await controls!.controlNative(action![1]!,body));return;}
        if(!exactKeys(body,[])){json(res,400,{error:'task_control_no_runtime_arguments'});return;}
        if(action![2]==='close-interrupted'){json(res,200,await controls!.closeInterrupted(action![1]!));return;}
        json(res,action![2]==='start'?202:200,action![2]==='start'?await withAI(()=>controls!.begin(action![1]!)):await controls!.cancel(action![1]!));return;
      }

      if (!authorized(req)) { json(res, 401, { error: 'viewer_key_required' }); return; }
      if (url.pathname === '/api/state') { const snapshot=await workbenchState(plan);if(selection)github!.assertSelection(selection);json(res, 200, {...snapshot,...(context?{project:{...context.project,controlsDeferred:deferred}}:{}),...(deliveryExecution?{deliveryExecution:await Promise.all((snapshot.deliveries??[]).filter(d=>d.available).map(async d=>{try{return {...await deliveryExecution.state(d.id),available:true};}catch(e){return {batchId:d.id,available:false,reason:safeError(e)};}}))}:{}),...(runtimeIdentity?{runtime:runtimeIdentity}:{}),...(returns?{returnWork:await returns.state(),mode:controls?.mode??'bounded_return_work'}:{}),...(queueActions?{queueActions:await queueActions.state(),queueOptions:queueActions.manifest(),mode:controls?.mode??'bounded_queue_controls'}:{}),...(polling?{sourcePolling:polling.state()}:{}),...(secretary?{secretaries:await secretary.state(),mode:controls?.mode??'bounded_secretary'}:{}),...(controls?{mode:controls.mode,taskControls:await controls.state(),scopeControls:await controls.scopeState()}: {}),...(scopeFollowups?{scopeFollowups:await scopeFollowups.state()}:{}),...(ownerControls?{ownerControls:await ownerControls.state(),mode:controls?.mode??'bounded_owner_proposals'}:{}),...(organization?{organization:await organization.state(),mode:controls?.mode??(ownerControls?'bounded_owner_proposals':'bounded_organization')}:{}),...(overall?{overallReviews:await overall.state(),...(!controls&&!ownerControls&&!organization&&!deliveryControls?{mode:'bounded_overall_review'}:{})}: {})}); return; }
      const returnReport=/^\/api\/return-report\/([A-Za-z0-9][A-Za-z0-9_.:-]{0,127})$/.exec(url.pathname);if(returnReport){if(!returns)throw new Error('report_not_found');json(res,200,await returns.report(returnReport[1]!));return;}
      const contactReport=/^\/api\/task-control-report\/([A-Za-z0-9][A-Za-z0-9_.:-]{0,127})$/.exec(url.pathname);if(contactReport){if(!controls)throw new Error('report_not_found');json(res,200,await controls.report(contactReport[1]!));return;}
      const deliveryWorkReport=/^\/api\/delivery-work-report\/([a-z0-9-]{1,64})\/([A-Za-z0-9][A-Za-z0-9_.-]{0,63})$/.exec(url.pathname);if(deliveryWorkReport){if(!deliveryExecution)throw new Error('report_not_found');json(res,200,await deliveryExecution.report(deliveryWorkReport[1]!,deliveryWorkReport[2]!));return;}
      const secretaryReport=/^\/api\/secretary-report\/([a-z0-9-]{1,64})\/([A-Za-z0-9][A-Za-z0-9_.:-]{0,127})$/.exec(url.pathname);if(secretaryReport){if(!secretary)throw new Error('report_not_found');json(res,200,await secretary.report(secretaryReport[1]!,secretaryReport[2]!));return;}
      const overallReport=/^\/api\/overall-report\/([a-z0-9-]{1,64})$/.exec(url.pathname);if(overallReport){if(!overall)throw new Error('report_not_found');json(res,200,await overall.report(overallReport[1]!));return;}
      const scopeReport=/^\/api\/scope-followup-report\/([a-z0-9-]{1,64})\/([a-f0-9]{64})$/.exec(url.pathname);if(scopeReport){if(!scopeFollowups)throw new Error('report_not_found');json(res,200,await scopeFollowups.report(scopeReport[1]!,scopeReport[2]!));return;}
      const assessment=/^\/api\/delivery-report\/([a-z0-9-]{1,64})\/([A-Za-z0-9][A-Za-z0-9_.-]{0,63})$/.exec(url.pathname);
      if(assessment){if(!deliveryControls)throw new Error('report_not_found');json(res,200,await deliveryControls.report(assessment[1]!,assessment[2]!));return;}
      const message=/^\/api\/message-report\/([a-z0-9-]{1,64})\/([a-f0-9]{64})\/([A-Za-z0-9][A-Za-z0-9_.:-]{0,127})$/.exec(url.pathname);
      if(message){const source=plan.sources.find(s=>s.id===message[1]);if(!source)throw new Error('report_not_found');json(res,200,await QueueStore.observeMessageReport(source.store,source.item,message[2]!,message[3]!));return;}
      const feedback=/^\/api\/judgment-feedback-report\/([a-z0-9-]{1,64})$/.exec(url.pathname);
      if(feedback){const source=plan.sources.find(s=>s.id===feedback[1]),keys=[...url.searchParams.keys()].sort();if(!source||keys.join()!=='feedback,judgment'||!text(url.searchParams.get('judgment'),128)||!text(url.searchParams.get('feedback'),128))throw new Error('judgment_feedback_not_selected');json(res,200,await QueueStore.observeJudgmentFeedback(source.store,source.item,{judgment:url.searchParams.get('judgment')!,feedback:url.searchParams.get('feedback')!}));return;}
      const baseline=/^\/api\/owner-baseline\/([a-z0-9-]{1,64})\/([a-f0-9]{64})$/.exec(url.pathname);if(baseline){if(!ownerControls)throw new Error('baseline_not_selected');json(res,200,await ownerControls.baseline(baseline[1]!,baseline[2]!));return;}
      const match = /^\/api\/report\/([a-z0-9-]{1,64})\/([a-f0-9-]{36})$/.exec(url.pathname);
      if (match) { json(res, 200, await workbenchReport(plan, match[1]!, match[2]!)); return; }
      json(res, 404, { error: 'route_not_found' });
    } catch (e) { json(res, e instanceof Error && e.message === 'report_not_found' ? 404 : 503, { error: safeError(e),...(e instanceof GitHubProjectError&&e.retryAfterSeconds?{retryAfterSeconds:e.retryAfterSeconds}:{}),...(e instanceof TaskControlRegistrationError?e.diagnostic:{}) }); }
  });
  await new Promise<void>((ok, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', () => { server.removeListener('error', reject); ok(); }); });
  const address = server.address(); if (!address || typeof address === 'string') throw new Error('workbench_address_unavailable');
  host = '127.0.0.1:' + address.port;
  const {controls,ownerControls,organization,overall,deliveryControls,secretary,returns,queueActions,polling}=initial??{};
  polling?.start();
  return { url: 'http://' + host + '/#' + token,mode:github?'github_projects':controls?.mode??(ownerControls?'bounded_owner_proposals':organization?'bounded_organization':overall?'bounded_overall_review':deliveryControls?.writable?'bounded_delivery_outcomes':secretary?'bounded_secretary':returns?'bounded_return_work':queueActions||polling?'bounded_queue_controls':'read_only'),close:async()=>{closing=true;const closed=new Promise<void>((ok,reject)=>server.close(e=>e?reject(e):ok()));await Promise.allSettled([github?.close(),projectChat?.then(chat=>chat.drain()),ai?.close()]);await Promise.allSettled([...locals.values()].map(async entry=>{const {returns,controls,polling,secretary,scopeFollowups,deliveryExecution,overall}=await entry.value.catch(()=>null)??{};await Promise.allSettled([returns?.drain(),controls?.drain(),polling?.drain(),secretary?.drain(),scopeFollowups?.drain(),deliveryExecution?.drain(),overall?.drain()]);}));await closed;} };
}
