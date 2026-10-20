import { canonical } from './comparison.js';
import { hash } from './snapshot.js';
import { repoPattern, shaPattern, validBranchRef } from './contract.js';
import { isAbsolute, resolve } from 'node:path';

export type AuthorityRole = 'background' | 'implementer' | 'receiver' | 'secretary' | 'coordinator';
export type AuthorityAction = 'implement' | 'test' | 'receive' | 'publish' | 'merge' | 'coordinate';
export type AuthorityProfile = {
  schemaVersion: 1; kind: 'tongxu-owner-source-profile'; repository: string; issue: number;
  ownerId: number; executorId: number; ghExecutable: string; ghSha256: string;
  executionKind: 'github' | 'fixture'; maxObservationAgeMs: number; maxGrantDurationMs: number;
};
export type ScopeBody = { goals: string[]; nonGoals: string[]; preserve: string[]; acceptance: string[]; constraints: string[] };
export type ActionRequest = {
  schemaVersion: 1; scopeId: string; scopeVersion: string; scopeBodySha256: string;
  repository: string; target: string; action: AuthorityAction; item: string | null;
  candidate: { H: string; B: string; subjectSha256: string | null } | null;
  paths: string[]; resourceRefs: string[];
  payloadSha256?: string;
};
export type OwnerProposal =
  { kind: 'adopt_scope'; scopeId: string; scopeVersion: string; body: ScopeBody; previousAdoption: string | null } |
  { kind: 'accept_baseline'; adoption: string; material: Record<'goals'|'rules'|'capabilities',{name:string;sha256:string}> } |
  { kind: 'confirm_action'; adoption: string; performerRole: AuthorityRole; request: ActionRequest; expiresAt: string } |
  { kind: 'delegate'; adoption: string; roles: AuthorityRole[]; targets: string[]; actions: AuthorityAction[]; paths: string[]; resourceRefs: string[]; expiresAt: string } |
  { kind: 'revoke'; decision: string } |
  { kind: 'control'; adoption: string; control: 'implementation' | 'investment' | 'merge'; state: 'stopped' | 'open' };
export type PreparedProposal = { schemaVersion: 1; requestId: string; profileSha256: string; repository: string; issue: number; createdAt: string; proposal: OwnerProposal };

export const authorityDigest = /^[a-f0-9]{64}$/;
export const isAuthorityDigest = (x:unknown):x is string => typeof x==='string' && authorityDigest.test(x);
export const authorityTime = (x:unknown):x is string => typeof x==='string' && /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d{3})?Z$/.test(x) && Number.isFinite(Date.parse(x)) && new Date(x).toISOString().replace('.000Z','Z')===x.replace('.000Z','Z');
const roles: AuthorityRole[] = ['background','implementer','receiver','secretary','coordinator'];
const actions: AuthorityAction[] = ['implement','test','receive','publish','merge','coordinate'];
const text = (x: unknown, max=2048): x is string => typeof x==='string' && Boolean(x.trim()) && x.length<=max && !/[\x00-\x08\x0b\x0c\x0e-\x1f]/.test(x);
export function exactKeys(x:any,keys:string[]) { return x && typeof x==='object' && !Array.isArray(x) && Object.keys(x).sort().join()===keys.sort().join(); }
const list = (x:unknown,check:(x:any)=>boolean,max=32): x is string[] => Array.isArray(x) && x.length<=max && new Set(x).size===x.length && x.every(check);
export const safeRelativePath = (p:unknown): p is string => typeof p==='string' && p.length>0 && p.length<=512 && !/[\\\x00-\x1f\x7f]/.test(p) && p.split('/').every(x=>x && x!=='.' && x!=='..' && x!=='.git');
export function parseAuthorityProfile(bytes:Buffer):AuthorityProfile {
  const p=JSON.parse(new TextDecoder('utf8',{fatal:true}).decode(bytes));
  if(!exactKeys(p,['schemaVersion','kind','repository','issue','ownerId','executorId','ghExecutable','ghSha256','executionKind','maxObservationAgeMs','maxGrantDurationMs'])||p.schemaVersion!==1||p.kind!=='tongxu-owner-source-profile'||(typeof p.repository!=='string'||!repoPattern.test(p.repository))||![p.issue,p.ownerId,p.executorId].every(x=>Number.isSafeInteger(x)&&x>0)||!text(p.ghExecutable)||!isAuthorityDigest(p.ghSha256)||!['github','fixture'].includes(p.executionKind)||!Number.isSafeInteger(p.maxObservationAgeMs)||p.maxObservationAgeMs<1000||p.maxObservationAgeMs>300000||!Number.isSafeInteger(p.maxGrantDurationMs)||p.maxGrantDurationMs<1000||p.maxGrantDurationMs>31*86400000)throw new Error('authority_profile_invalid');
  if(!isAbsolute(p.ghExecutable)||resolve(p.ghExecutable)!==p.ghExecutable)throw new Error('authority_executable_must_be_absolute');
  return p;
}
export function parseActionRequest(x:any):ActionRequest {
  if(!exactKeys(x,['schemaVersion','scopeId','scopeVersion','scopeBodySha256','repository','target','action','item','candidate','paths','resourceRefs',...(x&&Object.hasOwn(x,'payloadSha256')?['payloadSha256']:[])])||x.schemaVersion!==1||!text(x.scopeId,128)||!text(x.scopeVersion,128)||!isAuthorityDigest(x.scopeBodySha256)||(typeof x.repository!=='string'||!repoPattern.test(x.repository))||!validBranchRef(x.target)||!actions.includes(x.action)||!(x.item===null||isAuthorityDigest(x.item))||!list(x.paths,safeRelativePath)||!list(x.resourceRefs,y=>text(y,256)))throw new Error('authority_action_request_invalid');
  if(Object.hasOwn(x,'payloadSha256')&&(x.action!=='coordinate'||!isAuthorityDigest(x.payloadSha256)))throw new Error('authority_action_payload_invalid');
  if(x.candidate!==null&&(!exactKeys(x.candidate,['H','B','subjectSha256'])||typeof x.candidate.H!=='string'||!shaPattern.test(x.candidate.H)||typeof x.candidate.B!=='string'||!shaPattern.test(x.candidate.B)||!(x.candidate.subjectSha256===null||isAuthorityDigest(x.candidate.subjectSha256))))throw new Error('authority_action_candidate_invalid');
  if(x.action!=='coordinate'&&(x.item===null||x.candidate===null))throw new Error('authority_action_exact_candidate_required');
  if((x.item===null)!==(x.candidate===null))throw new Error('authority_action_item_candidate_mismatch');
  return x;
}
export function parseOwnerProposal(x:any,profile:AuthorityProfile,at:number):OwnerProposal {
  if(!x||typeof x!=='object'||Array.isArray(x))throw new Error('owner_proposal_invalid');
  if(x.kind==='adopt_scope') {
    if(!exactKeys(x,['kind','scopeId','scopeVersion','body','previousAdoption'])||!text(x.scopeId,128)||!text(x.scopeVersion,128)||!(x.previousAdoption===null||isAuthorityDigest(x.previousAdoption))||!exactKeys(x.body,['goals','nonGoals','preserve','acceptance','constraints'])||!Object.values(x.body).every(v=>list(v,s=>text(s,2048)))||!x.body.goals.length||!x.body.acceptance.length||Buffer.byteLength(canonical(x.body))>64*1024)throw new Error('owner_scope_proposal_invalid');
  } else if(x.kind==='accept_baseline') {
    if(!exactKeys(x,['kind','adoption','material'])||!isAuthorityDigest(x.adoption)||!exactKeys(x.material,['goals','rules','capabilities'])||!Object.values(x.material).every((m:any)=>exactKeys(m,['name','sha256'])&&text(m.name,128)&&isAuthorityDigest(m.sha256))||new Set(Object.values(x.material).map((m:any)=>m.name)).size!==3)throw new Error('owner_baseline_proposal_invalid');
  } else if(x.kind==='confirm_action') {
    if(!exactKeys(x,['kind','adoption','performerRole','request','expiresAt'])||!isAuthorityDigest(x.adoption)||!roles.includes(x.performerRole))throw new Error('owner_confirmation_invalid');
    parseActionRequest(x.request);if(x.request.repository.toLowerCase()!==profile.repository.toLowerCase())throw new Error('authority_repository_mismatch');
    if(!roleCanRequest(x.performerRole,x.request.action))throw new Error('owner_confirmation_role_cannot_perform_action');
  } else if(x.kind==='delegate') {
    if(!exactKeys(x,['kind','adoption','roles','targets','actions','paths','resourceRefs','expiresAt'])||!isAuthorityDigest(x.adoption)||!list(x.roles,r=>roles.includes(r))||!x.roles.length||!list(x.targets,validBranchRef)||!x.targets.length||!list(x.actions,a=>actions.includes(a))||!x.actions.length||!list(x.paths,safeRelativePath)||!list(x.resourceRefs,r=>text(r,256)))throw new Error('owner_delegation_invalid');
  } else if(x.kind==='revoke') {
    if(!exactKeys(x,['kind','decision'])||!isAuthorityDigest(x.decision))throw new Error('owner_revocation_invalid');
  } else if(x.kind==='control') {
    if(!exactKeys(x,['kind','adoption','control','state'])||!isAuthorityDigest(x.adoption)||!['implementation','investment','merge'].includes(x.control)||!['stopped','open'].includes(x.state))throw new Error('owner_control_invalid');
  } else throw new Error('owner_proposal_kind_invalid');
  if('expiresAt' in x){const end=Date.parse(x.expiresAt);if(!authorityTime(x.expiresAt)||!Number.isFinite(end)||end<=at||end-at>profile.maxGrantDurationMs)throw new Error('owner_authorization_expiry_invalid');}
  return x;
}
/** Role comes from the trusted endpoint/session binding, never the request JSON. */
export function roleCanRequest(role:AuthorityRole,action:AuthorityAction):boolean {
  const caps:Record<AuthorityRole,AuthorityAction[]>={background:actions,implementer:['implement','test'],receiver:['receive','test'],secretary:['coordinate'],coordinator:['coordinate']};
  return Object.hasOwn(caps,role)&&caps[role].includes(action);
}
export const scopeBodyHash=(body:ScopeBody)=>hash(canonical(body));
export const actionHash=(request:ActionRequest)=>hash(canonical(request));
export const ownerDecisionText=(proposalSha256:string)=>JSON.stringify({schemaVersion:1,kind:'tongxu-owner-decision',proposalSha256,decision:'approve'},null,2);

