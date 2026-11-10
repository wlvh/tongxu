import {parseMergeCommand,type MergeCommand,type MergeRead} from './merge-request.js';
export {parseMergeCommand,mergeHttpRequest,type MergeCommand,type MergeRead} from './merge-request.js';
import {selectExternalExecutable,assertExternalExecutable,capturedExternalExecutable,type ExternalExecutable} from './external-executable.js';
import { readFile, realpath, lstat, writeFile } from 'node:fs/promises';
import { isAbsolute, resolve, join } from 'node:path';
import { canonical } from './comparison.js';
import { hash, privateDirectory } from './snapshot.js';
import { exactKeys, isAuthorityDigest } from './authority-contract.js';
import { repoPattern, validBranchRef } from './contract.js';
import { LiveProcess, checkCapture } from './live-process.js';
import { regular } from './repair-workspace.js';
import { type ManagedMergeBinding, type MergeWire } from './merge-contract.js';

/** This is trusted deployment configuration, never supplied by a model report.
 * The configured publisher owns its verified credential source. The queue
 * process sends no token, HOME, SSH agent, gh config or API-key environment. */
export type MergeProfile = {
  schemaVersion: 1; kind: 'tongxu-managed-publisher'; repository: string;
  repositoryId: number; targets: string[]; actorId: number;
  executable: string; executableSha256: string;
  executionKind: 'fixture' | 'external'; timeoutMs: number;
  /** Deployment-verified credential class, not a permission or identity proof.
   * Omitted legacy profiles cannot prove classic absence through another API. */
  credentialKind?: 'github_app_installation' | 'github_app_user' | 'fine_grained_pat' | 'oauth_repo_admin';
  /** Explicit deployment choice, not an action grant or identity proof. */
  sharedAccountPublisher?: {decisionReference:{kind:'recorded_user_decision';sha256:string}};
};
export type MergeReply = {
  protocol: 'tongxu-managed-merge-v1'; inputSha256: string;
  result: { kind: 'http'; status: number; body: string; nextPage: boolean } |
    { kind: 'capabilities'; credentialState: 'available' | 'unavailable' | 'unknown';
      actorId: number | null; identity: 'isolated_publisher' | 'account_publisher' | 'fixture' | 'unknown';
      repositoryIds: number[]; targetRefs: string[]; merge: boolean; bypass: false;
      synchronousHeadCondition: boolean; sourceReference: string | null };
};
export type MergeObservation = { executableSelection?:ExternalExecutable; profileSha256: string; inputSha256: string; reply: MergeReply; raw: Buffer; directory: string; capturedAt: string };
const observations = new WeakSet<object>();

export function parseMergeProfile(raw: Buffer): MergeProfile {
  const p = JSON.parse(new TextDecoder('utf8', { fatal: true }).decode(raw));
  if (!exactKeys(p, ['schemaVersion','kind','repository','repositoryId','targets','actorId','executable','executableSha256','executionKind','timeoutMs',...(p?.credentialKind!==undefined?['credentialKind']:[]),...(p&&Object.hasOwn(p,'sharedAccountPublisher')?['sharedAccountPublisher']:[])]) || p.schemaVersion !== 1 || p.kind !== 'tongxu-managed-publisher' || typeof p.repository !== 'string' || !repoPattern.test(p.repository) || ![p.repositoryId,p.actorId].every(n=>Number.isSafeInteger(n)&&n>0) || !Array.isArray(p.targets) || !p.targets.length || p.targets.length > 8 || new Set(p.targets).size !== p.targets.length || !p.targets.every(validBranchRef) || typeof p.executable !== 'string' || !isAbsolute(p.executable) || resolve(p.executable) !== p.executable || !isAuthorityDigest(p.executableSha256) || !['fixture','external'].includes(p.executionKind) || !Number.isSafeInteger(p.timeoutMs) || p.timeoutMs < 100 || p.timeoutMs > 60000 || p.credentialKind!==undefined&&!['github_app_installation','github_app_user','fine_grained_pat','oauth_repo_admin'].includes(p.credentialKind)) throw new Error('managed_publisher_profile_invalid');
  if(Object.hasOwn(p,'sharedAccountPublisher')&&(!exactKeys(p.sharedAccountPublisher,['decisionReference'])||!exactKeys(p.sharedAccountPublisher.decisionReference,['kind','sha256'])||p.sharedAccountPublisher.decisionReference.kind!=='recorded_user_decision'||!isAuthorityDigest(p.sharedAccountPublisher.decisionReference.sha256)))throw new Error('managed_publisher_shared_account_policy_invalid');
  return p;
}
/** Only new shared profiles add a projection. The current actor remains in the
 * original capability observation; this configured ID is not authentication. */
export function sharedPublisherProjection(p:MergeProfile){
  return p.sharedAccountPublisher?{publisherAccount:{mode:'shared_account' as const,configuredActorId:p.actorId,operatorSeparationProven:false as const,decisionReference:{...p.sharedAccountPublisher.decisionReference,verification:'registered_not_rechecked' as const}}}:{};
}
export const mergePublisherIdentity=(p:MergeProfile)=>p.executionKind==='fixture'?'fixture':p.sharedAccountPublisher?'account_publisher':'isolated_publisher';
function parseReply(raw: Buffer, p: MergeProfile, c: MergeCommand): MergeReply {
  if (raw.length > 4 * 1024 * 1024) throw new Error('managed_publisher_reply_limit');
  const x = JSON.parse(new TextDecoder('utf8', { fatal: true }).decode(raw));
  if (!exactKeys(x,['protocol','inputSha256','result']) || x.protocol !== c.protocol || x.inputSha256 !== hash(canonical(c))) throw new Error('managed_publisher_reply_binding_mismatch');
  const r = x.result;
  if (c.command === 'capabilities') {
    if (!exactKeys(r,['kind','credentialState','actorId','identity','repositoryIds','targetRefs','merge','bypass','synchronousHeadCondition','sourceReference']) || r.kind !== 'capabilities' || !['available','unavailable','unknown'].includes(r.credentialState) || !(r.actorId === null || Number.isSafeInteger(r.actorId)&&r.actorId>0) || !['isolated_publisher','account_publisher','fixture','unknown'].includes(r.identity) || !Array.isArray(r.repositoryIds) || r.repositoryIds.length > 32 || !r.repositoryIds.every((n:unknown)=>Number.isSafeInteger(n)&&(n as number)>0) || !Array.isArray(r.targetRefs) || r.targetRefs.length > 32 || !r.targetRefs.every(validBranchRef) || typeof r.merge !== 'boolean' || r.bypass !== false || typeof r.synchronousHeadCondition !== 'boolean' || !(r.sourceReference === null || typeof r.sourceReference === 'string' && r.sourceReference.length > 0 && r.sourceReference.length <= 256)) throw new Error('managed_publisher_capability_invalid');
    if (p.executionKind === 'external' && r.identity === 'fixture') throw new Error('fixture_publisher_cannot_be_external');
  } else if (!exactKeys(r,['kind','status','body','nextPage']) || r.kind !== 'http' || !Number.isSafeInteger(r.status) || r.status < 100 || r.status > 599 || typeof r.body !== 'string' || typeof r.nextPage !== 'boolean' || c.command === 'merge' && r.nextPage) throw new Error('managed_publisher_http_reply_invalid');
  return x;
}
export function requireMergeObservation(x: MergeObservation, p: MergeProfile, c: MergeCommand) {
  if (!observations.has(x) || x.profileSha256 !== hash(canonical(p)) || x.inputSha256 !== hash(canonical(c)) || Date.now()-Date.parse(x.capturedAt)>60000 || Date.parse(x.capturedAt)>Date.now()+1000) throw new Error('actual_managed_publisher_observation_required');
  if (canonical(parseReply(x.raw,p,c)) !== canonical(x.reply)) throw new Error('managed_publisher_original_reply_changed');
}
export function mergeWire(x: MergeObservation): MergeWire {
  if (x.reply.result.kind !== 'http') throw new Error('merge_http_observation_required');
  return { status: x.reply.result.status, body: Buffer.from(x.reply.result.body) };
}
export function mergeCommand(b: ManagedMergeBinding, command: MergeCommand['command'], read: Partial<MergeRead> | null = null): MergeCommand {
  return { protocol:'tongxu-managed-merge-v1', command, binding:b, read: read ? { kind:read.kind!,page:read.page??1,commit:read.commit??null,tip:read.tip??null,...(read.reviewer!==undefined?{reviewer:read.reviewer}:{}) } : null };
}
export async function callMergeProvider(profile: MergeProfile, command: MergeCommand, directory: string, beforeDispatch?: (directory:string)=>void,expected?:ExternalExecutable): Promise<MergeObservation> {
  const p = parseMergeProfile(Buffer.from(canonical(profile))), c = parseMergeCommand(JSON.parse(canonical(command)),p);
  if (c.command === 'merge' && !beforeDispatch) throw new Error('persisted_managed_merge_gate_required');
  await privateDirectory(directory,true);
  const selected=expected??selectExternalExecutable(p.executable);
  if(selected.configuredPath!==p.executable)throw new Error('provider_executable_selection_mismatch');
  assertExternalExecutable(selected);
  await writeFile(join(directory,'executable.json'),canonical(selected),{flag:'wx',mode:0o600});
  const input = canonical(c)+'\n'; await writeFile(join(directory,'fixed-input.json'),input,{flag:'wx',mode:0o600});
  // No personal credentials are inherited. The configured publisher must obtain
  // its own bounded identity; absence never falls back to a personal CLI.
  const env: NodeJS.ProcessEnv = {PATH:'/usr/bin:/bin',LANG:'C.UTF-8',TMPDIR:directory};
  assertExternalExecutable(selected);beforeDispatch?.(directory);
  const live = new LiveProcess(directory,p.executable,['--tongxu-managed-merge-v1'],directory,env,undefined,selected);
  let timer:ReturnType<typeof setTimeout>|undefined;
  try {
    live.writeText(input);
    await Promise.race([live.closed,new Promise<never>((_,reject)=>{timer=setTimeout(()=>reject(new Error('managed_merge_provider_timeout_unknown')),p.timeoutMs);})]);
    if (live.exit?.code!==0 || live.exit.signal!==null || live.failure) throw new Error('managed_publisher_execution_incomplete');
    await checkCapture(directory);
    if (live.events.length!==1) throw new Error('managed_publisher_one_reply_required');
    const raw = await readFile(join(directory,'stdout.ndjson')), reply = parseReply(raw,p,c);
    const observation = Object.freeze({executableSelection:Object.freeze({...selected}),profileSha256:hash(canonical(p)),inputSha256:hash(canonical(c)),reply,raw:Buffer.from(raw),directory,capturedAt:new Date().toISOString()});
    observations.add(observation); return observation;
  } finally { if(timer)clearTimeout(timer); await live.close(); }
}
/** Reconsume a known original completed capture; never launches a helper. */
export async function readMergeProviderCapture(p:MergeProfile,c:MergeCommand,directory:string):Promise<MergeObservation>{
  parseMergeCommand(c,p);await privateDirectory(directory,false);
  const input=JSON.parse((await regular(join(directory,'fixed-input.json'),128*1024)).toString());
  const launch=JSON.parse((await regular(join(directory,'launch.json'),16384)).toString()),exit=JSON.parse((await regular(join(directory,'exit.json'),4096)).toString());
  if(canonical(input)!==canonical(c)||launch.command!==p.executable||canonical(launch.args)!==canonical(['--tongxu-managed-merge-v1'])||launch.cwd!==directory||exit.code!==0||exit.signal!==null)throw new Error('original_managed_publisher_capture_incomplete');
  if(launch.executableSelection!==undefined&&!capturedExternalExecutable(launch.executableSelection,p.executable))throw new Error('original_managed_publisher_selection_invalid');
  await checkCapture(directory);const raw=await regular(join(directory,'stdout.ndjson'),4*1024*1024);
  if(raw.toString().trim().split('\n').length!==1)throw new Error('managed_publisher_one_reply_required');
  const reply=parseReply(raw,p,c),value=Object.freeze({...(launch.executableSelection?{executableSelection:launch.executableSelection}:{}),profileSha256:hash(canonical(p)),inputSha256:hash(canonical(c)),reply,raw,directory,capturedAt:new Date().toISOString()});observations.add(value);return value;
}
