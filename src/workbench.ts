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
import {DeliveryControls,type DeliverySelection} from './delivery-controls.js';

type Row = Record<string, any>;
export type WorkbenchPlan = {
  schemaVersion: 1; kind: 'tongxu-local-workbench'|'tongxu-controlled-workbench'; title: string; goal: string;
  sources: Array<{ id: string; title: string; store: string; item: string }>;
  controls?:{path:string;sha256:string};
  deliveries?:DeliverySelection[];
};
const text = (v: unknown, max: number): v is string => typeof v === 'string' && !!v.trim() && v.length <= max && !v.includes('\0');
export function parseWorkbenchPlan(bytes: Buffer): WorkbenchPlan {
  const p = JSON.parse(bytes.toString());
  if (p.schemaVersion !== 1 || !['tongxu-local-workbench','tongxu-controlled-workbench'].includes(p.kind) || !text(p.title, 100) || !text(p.goal, 1000) || !Array.isArray(p.sources) || !p.sources.length || p.sources.length > 8) throw new Error('invalid_workbench_plan');
  if(p.kind==='tongxu-controlled-workbench'?(p.controls?!exactKeys(p.controls,['path','sha256'])||!messagePath(p.controls.path)||!isAuthorityDigest(p.controls.sha256):!p.deliveries?.length):Object.hasOwn(p,'controls'))throw new Error('invalid_workbench_controls');
  const ids = new Set(), tasks = new Set();
  for (const s of p.sources) {
    if (!s || typeof s.id !== 'string' || !/^[a-z0-9-]{1,64}$/.test(s.id) || !text(s.title, 100) || !/^[a-f0-9]{64}$/.test(s.item) || typeof s.store !== 'string' || !isAbsolute(s.store) || resolve(s.store) !== s.store || ids.has(s.id) || tasks.has(s.store + ':' + s.item)) throw new Error('invalid_workbench_source');
    ids.add(s.id); tasks.add(s.store + ':' + s.item);
  }
  if(Object.hasOwn(p,'deliveries')){if(!Array.isArray(p.deliveries)||!p.deliveries.length||p.deliveries.length>8)throw new Error('invalid_workbench_deliveries');const entries=new Set(),batches=new Set();for(const d of p.deliveries){if(!exactKeys(d,['id','source','batchSha256'])||typeof d.id!=='string'||!/^[a-z0-9-]{1,64}$/.test(d.id)||entries.has(d.id)||!ids.has(d.source)||!isAuthorityDigest(d.batchSha256)||batches.has(d.source+':'+d.batchSha256))throw new Error('invalid_workbench_delivery');entries.add(d.id);batches.add(d.source+':'+d.batchSha256);}}
  return { schemaVersion: 1, kind: p.kind, title: p.title, goal: p.goal, sources: p.sources.map((s: Row) => ({ id: s.id, title: s.title, store: s.store, item: s.item })),...(p.controls?{controls:p.controls}:{}),...(p.deliveries?{deliveries:p.deliveries}:{}) };
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
    tasks.push({ ...base, available: true, candidate: item.candidate, ...(item.developmentTask?{developmentTask:item.developmentTask}:{}), ...(item.summary.composition?{composition:item.summary.composition,compositionCurrent:item.compositionCurrent}:{}), currentPacket: item.currentPacket,
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
  return { schemaVersion: 1, title: p.title, goal: p.goal, mode: p.controls?'bounded_task_contacts':p.kind==='tongxu-controlled-workbench'?'bounded_delivery_outcomes':'read_only', tasks, events: events.sort((a, b) => a.observedAt.localeCompare(b.observedAt) || a.id.localeCompare(b.id)), ...(p.controls?{modelCallsStartedByThisRead:0}:{modelCallsStartedByWorkbench:0}),...(p.deliveries?{deliveries:await new DeliveryControls(p.deliveries,p.sources,p.kind==='tongxu-controlled-workbench').state()}:{}), crossStoreAtomic: false, remoteRechecked: false, productionActionAllowed: false };
}
async function workbenchReport(p: WorkbenchPlan, source: string, operation: string) {
  const s = p.sources.find(s => s.id === source); if (!s) throw new Error('report_not_found');
  const q = await QueueStore.observe(s.store, [s.item], [operation]), o = q.operations.find((o: Row) => o.item === s.item && o.id === operation), j = o?.result?.receiver?.judgment;
  if (o?.invalidOutput !== undefined) return { source,operation,judgmentId:null,verdict:'INVALID_RESULT',report:o.invalidOutput,reportSha256:hash(o.invalidOutput), ...(o.result.receiver.subject?{subject:o.result.receiver.subject,subjectSha256:o.result.receiver.subjectSha256}:{}),stage:receptionStage(o),nativeExecution:o.nativeExecution,invalidResult:o.result.receiver.invalidResult,findings:[],productionActionAllowed:false };
  if (!j) throw new Error('report_not_found');
  return { source, operation, judgmentId: j.judgmentId, verdict: j.verdict, report: j.report, reportSha256: hash(j.report), ...(o.result.receiver.subject?{subject:o.result.receiver.subject,subjectSha256:o.result.receiver.subjectSha256}:{}), stage: receptionStage(o), nativeExecution: o.nativeExecution, findings: j.findings, productionActionAllowed: false };
}
export async function startWorkbench(planPath: string) {
  const p = parseWorkbenchPlan(await regular(planPath)), token = randomBytes(32).toString('hex');
  const controls=p.controls?await TaskControls.load(p.controls.path,p.controls.sha256,p.sources):null;
  const deliveryControls=p.deliveries?new DeliveryControls(p.deliveries,p.sources,p.kind==='tongxu-controlled-workbench'):null;
  const assets = new Map<string, { type: string; bytes: Buffer }>();
  for (const [path, name, type] of [['/', 'index.html', 'text/html'], ['/app.js', 'app.js', 'text/javascript'], ['/app.css', 'app.css', 'text/css'], ['/favicon.svg', 'favicon.svg', 'image/svg+xml']]) assets.set(path!, { type: type! + '; charset=utf-8', bytes: await readFile(new URL('../../web/workbench/' + name!, import.meta.url)) });
  let host = '';
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
      if (url.search) { json(res, 400, { error: 'query_not_supported' }); return; }
      if(req.method!=='GET'){
        if(!controls&&!deliveryControls?.writable){json(res,405,{error:'read_only_workbench'});return;}
        if(!authorized(req)){json(res,401,{error:'viewer_key_required'});return;}
        const action=/^\/api\/task-control\/([A-Za-z0-9][A-Za-z0-9_.:-]{0,127})\/(start|cancel)$/.exec(url.pathname);
        const scope=/^\/api\/scope-control\/([A-Za-z0-9][A-Za-z0-9_.-]{0,63})\/(stopped|open)$/.exec(url.pathname);
        const delivery=/^\/api\/delivery\/([a-z0-9-]{1,64})\/(prepare|apply)$/.exec(url.pathname);
        if(req.method!=='POST'||!(controls&&(action||scope)||deliveryControls?.writable&&delivery)){json(res,405,{error:'task_control_route_not_allowed'});return;}
        if(req.headers.origin!=='http://'+host||req.headers['content-type']!=='application/json'){json(res,403,{error:'same_origin_json_required'});return;}
        const chunks:Buffer[]=[];let size=0;for await(const chunk of req){const bytes=Buffer.from(chunk);size+=bytes.length;if(size>(delivery?16384:1024)){json(res,413,{error:'task_control_body_limit'});return;}chunks.push(bytes);}
        let body:any;try{body=JSON.parse(new TextDecoder('utf8',{fatal:true}).decode(Buffer.concat(chunks)));}catch{json(res,400,{error:'task_control_invalid_json'});return;}
        if(delivery){json(res,200,delivery[2]==='prepare'?await deliveryControls!.prepare(delivery[1]!,body):await deliveryControls!.apply(delivery[1]!,body));return;}
        if(scope){if(!exactKeys(body,['revision'])||!Number.isSafeInteger(body.revision)||body.revision<0){json(res,400,{error:'scope_control_revision_required'});return;}json(res,200,await controls!.setScope(scope[1]!,scope[2]!,body.revision));return;}
        if(!exactKeys(body,[])){json(res,400,{error:'task_control_no_runtime_arguments'});return;}
        json(res,action![2]==='start'?202:200,action![2]==='start'?await controls!.begin(action![1]!):await controls!.cancel(action![1]!));return;
      }
      const asset = assets.get(url.pathname); if (asset) { reply(res, 200, asset.type, asset.bytes); return; }
      if (!authorized(req)) { json(res, 401, { error: 'viewer_key_required' }); return; }
      if (url.pathname === '/api/state') { json(res, 200, {...await workbenchState(p),...(controls?{mode:controls.mode,taskControls:await controls.state(),scopeControls:await controls.scopeState()}: {})}); return; }
      const message=/^\/api\/message-report\/([a-z0-9-]{1,64})\/([a-f0-9]{64})\/([A-Za-z0-9][A-Za-z0-9_.:-]{0,127})$/.exec(url.pathname);
      if(message){const source=p.sources.find(s=>s.id===message[1]);if(!source)throw new Error('report_not_found');json(res,200,await QueueStore.observeMessageReport(source.store,source.item,message[2]!,message[3]!));return;}
      const match = /^\/api\/report\/([a-z0-9-]{1,64})\/([a-f0-9-]{36})$/.exec(url.pathname);
      if (match) { json(res, 200, await workbenchReport(p, match[1]!, match[2]!)); return; }
      json(res, 404, { error: 'route_not_found' });
    } catch (e) { json(res, e instanceof Error && e.message === 'report_not_found' ? 404 : 503, { error: safeError(e),...(e instanceof TaskControlRegistrationError?e.diagnostic:{}) }); }
  });
  await new Promise<void>((ok, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', () => { server.removeListener('error', reject); ok(); }); });
  const address = server.address(); if (!address || typeof address === 'string') throw new Error('workbench_address_unavailable');
  host = '127.0.0.1:' + address.port;
  return { url: 'http://' + host + '/#' + token,mode:controls?.mode??(deliveryControls?.writable?'bounded_delivery_outcomes':'read_only'),close:async()=>{const closed=new Promise<void>((ok,reject)=>server.close(e=>e?reject(e):ok()));await controls?.drain();await closed;} };
}
