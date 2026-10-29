import { execFile } from 'node:child_process';
import { writeFile } from 'node:fs/promises';
import { isAbsolute, join } from 'node:path';
import { promisify } from 'node:util';
import { hash, privateDirectory } from './snapshot.js';
import { canonical } from './comparison.js';
import { authorityTime, exactKeys, isAuthorityDigest, parseAuthorityProfile, type AuthorityProfile } from './authority-contract.js';
import {selectGhExecutable,assertGhExecutableUnchanged} from './gh-executable.js';

export type OwnerObservation = {
  profileSha256:string; proposalSha256:string; commentId:number; sourceNodeId:string; issue:number; repository:string;
  authorId:number; editorId:number|null; executorId:number; createdAt:string; updatedAt:string; lastEditedAt:string|null; readAt:string;
  semanticSha256:string; sourceBodySha256:string; sourceUrl:string; executionKind:'github'|'fixture';
  graphRaw:Buffer; commentRaw:Buffer;
};
const verifiedObservations=new WeakSet<object>();
/** Only the bounded provider reader constructs observations. A serialized
 * verified flag is not authority. Author AND last-editor attribution matter. */
function verifyOwnerObservation(profile:AuthorityProfile,profileSha256:string,proposalSha256:string,commentId:number,graphRaw:Buffer,commentRaw:Buffer,readAt:string):OwnerObservation {
  if(hash(canonical(parseAuthorityProfile(Buffer.from(canonical(profile)))))!==profileSha256)throw new Error('authority_profile_hash_mismatch');
  if(!isAuthorityDigest(profileSha256)||!isAuthorityDigest(proposalSha256)||!Number.isSafeInteger(commentId)||commentId<=0||!authorityTime(readAt))throw new Error('owner_observation_identity_invalid');
  const decoder=new TextDecoder('utf8',{fatal:true}),graph=JSON.parse(decoder.decode(graphRaw)),comment=JSON.parse(decoder.decode(commentRaw)),actor=graph?.data?.viewer,node=graph?.data?.node;
  if(!graph||graph.errors?.length||!actor||!node||node.__typename!=='IssueComment'||!comment||typeof comment!=='object'||Array.isArray(comment))throw new Error('owner_provider_response_invalid');
  if(actor.databaseId!==profile.executorId)throw new Error('authority_execution_identity_mismatch');
  if(profile.ownerId===actor.databaseId)throw new Error('shared_account_is_not_owner_confirmation');
  const url=`https://github.com/${profile.repository}/issues/${profile.issue}#issuecomment-${commentId}`;
  if(comment.id!==commentId||typeof comment.node_id!=='string'||node.id!==comment.node_id||String(node.fullDatabaseId)!==String(commentId)||node.issue?.number!==profile.issue||node.issue?.repository?.nameWithOwner!==profile.repository||node.url!==url||node.author?.__typename!=='User'||node.author.databaseId!==profile.ownerId||comment.user?.id!==profile.ownerId||comment.user?.type!=='User'||comment.issue_url!==`https://api.github.com/repos/${profile.repository}/issues/${profile.issue}`||comment.html_url!==url||typeof comment.body!=='string'||Buffer.byteLength(comment.body)>16384||node.body!==comment.body||node.createdAt!==comment.created_at||node.updatedAt!==comment.updated_at||![comment.created_at,comment.updated_at].every(authorityTime)||Date.parse(comment.created_at)>Date.parse(comment.updated_at)||Date.parse(comment.updated_at)>Date.parse(readAt)+60000)throw new Error('owner_original_source_mismatch');
  if(node.lastEditedAt!==null&&!authorityTime(node.lastEditedAt))throw new Error('owner_editor_attribution_unavailable');
  if(node.editor!==null&&(node.editor?.__typename!=='User'||node.editor.databaseId!==profile.ownerId))throw new Error('owner_source_edited_by_another_identity');
  if(node.lastEditedAt!==null&&(node.editor===null||Date.parse(node.lastEditedAt)>Date.parse(node.updatedAt)||Date.parse(node.lastEditedAt)<Date.parse(node.createdAt)))throw new Error('owner_editor_attribution_unavailable');
  const body=comment.body.trim(),fence=/^```(?:json)?\r?\n([\s\S]*)\r?\n```$/.exec(body);let decision:any;
  try{decision=JSON.parse(fence?fence[1]!:body);}catch{throw new Error('owner_source_not_an_exact_decision');}
  if(!exactKeys(decision,['schemaVersion','kind','proposalSha256','decision'])||decision.schemaVersion!==1||decision.kind!=='tongxu-owner-decision'||decision.proposalSha256!==proposalSha256||decision.decision!=='approve')throw new Error('owner_source_not_an_exact_decision');
  const value=Object.freeze({profileSha256,proposalSha256,commentId,sourceNodeId:node.id as string,issue:profile.issue,repository:profile.repository,authorId:node.author.databaseId as number,editorId:node.editor?.databaseId??null,executorId:actor.databaseId as number,createdAt:comment.created_at as string,updatedAt:comment.updated_at as string,lastEditedAt:node.lastEditedAt as string|null,readAt,semanticSha256:hash(canonical(decision)),sourceBodySha256:hash(comment.body),sourceUrl:url,executionKind:profile.executionKind,graphRaw:Buffer.from(graphRaw),commentRaw:Buffer.from(commentRaw)});
  verifiedObservations.add(value);return value;
}

/** Deterministic test observations cannot be applied to a GitHub profile. */
export function fixtureOwnerObservation(profile:AuthorityProfile,proposalSha256:string,commentId:number,graphRaw:Buffer,commentRaw:Buffer,readAt:string):OwnerObservation {
  if(profile.executionKind!=='fixture')throw new Error('fixture_owner_source_only');
  return verifyOwnerObservation(profile,hash(canonical(profile)),proposalSha256,commentId,graphRaw,commentRaw,readAt);
}

/** Revalidate stored originals for a historical view. The returned copy is
 * deliberately not an issued OwnerObservation and cannot authorize an action. */
export function inspectStoredOwnerSource(profile:AuthorityProfile,proposalSha256:string,commentId:number,graphRaw:Buffer,commentRaw:Buffer,readAt:string){
  const checked=verifyOwnerObservation(profile,hash(canonical(profile)),proposalSha256,commentId,graphRaw,commentRaw,readAt),{graphRaw:_graph,commentRaw:_comment,...source}=checked;
  return {source,freshForAction:false as const};
}

export const ownerCommentQuery=`query($id: ID!) {
  viewer { id login databaseId }
  node(id: $id) {
    __typename
    ... on IssueComment {
      id fullDatabaseId body createdAt updatedAt lastEditedAt url
      author { __typename login ... on User { databaseId } }
      editor { __typename login ... on User { databaseId } }
      issue { number repository { nameWithOwner } }
    }
  }
}`;
const exec=promisify(execFile);
/** This adapter has only two fixed reads. It accepts neither arbitrary queries
 * nor user supplied stdout, cookies, URLs or mutation flags. */
export async function readOwnerSource(profile:AuthorityProfile,proposalSha256:string,commentId:number,evidenceDirectory:string):Promise<OwnerObservation> {
  profile=parseAuthorityProfile(Buffer.from(canonical(profile)));
  if(!isAuthorityDigest(proposalSha256)||!Number.isSafeInteger(commentId)||commentId<=0)throw new Error('github_owner_read_identity_invalid');
  if(!isAbsolute(evidenceDirectory))throw new Error('owner_evidence_directory_must_be_absolute');
  await privateDirectory(evidenceDirectory,true);
  const selected=await selectGhExecutable(profile.ghExecutable,profile.ghSha256),binary=selected.realpath;
  const profileSha256=hash(canonical(profile));
  await writeFile(join(evidenceDirectory,'profile.json'),canonical(profile),{flag:'wx',mode:0o600});
  await writeFile(join(evidenceDirectory,'executable.json'),canonical(selected),{flag:'wx',mode:0o600});
  const run=async(name:string,args:string[])=>{
    // Resolve/hash again at each boundary; the executable is trusted operator
    // configuration, not a role-provided command or a path copied from a report.
    assertGhExecutableUnchanged(selected);
    await writeFile(join(evidenceDirectory,name+'-request.json'),JSON.stringify({executable:binary,executableSelection:selected,args,startedAt:new Date().toISOString(),readOnly:true}),{flag:'wx',mode:0o600});
    let stdout=Buffer.alloc(0),stderr=Buffer.alloc(0),exit:unknown=0,signal:unknown=null;
    try{const r=await exec(binary,args,{timeout:30000,maxBuffer:4*1024*1024,encoding:'buffer',cwd:evidenceDirectory});stdout=r.stdout;stderr=r.stderr;}
    catch(e:any){stdout=Buffer.from(e.stdout??'');stderr=Buffer.from(e.stderr??'');exit=e.code??null;signal=e.signal??null;}
    await writeFile(join(evidenceDirectory,name+'-stdout.json'),stdout,{flag:'wx',mode:0o600});
    await writeFile(join(evidenceDirectory,name+'-stderr.txt'),stderr,{flag:'wx',mode:0o600});
    await writeFile(join(evidenceDirectory,name+'-exit.json'),JSON.stringify({exit,signal,finishedAt:new Date().toISOString()}),{flag:'wx',mode:0o600});
    if(exit!==0||signal)throw new Error('owner_original_source_unavailable');
    try{assertGhExecutableUnchanged(selected);}catch(e){await writeFile(join(evidenceDirectory,name+'-executable-changed.json'),canonical({reason:'gh_executable_changed_during_operation',phase:'after_process_exit',observationIssued:false}),{flag:'wx',mode:0o600});throw e;}return stdout;
  };
  const commentRaw=await run('comment',['api','--hostname','github.com','--method','GET','-H','Accept: application/vnd.github+json',`repos/${profile.repository}/issues/comments/${commentId}`]);
  const c=JSON.parse(new TextDecoder('utf8',{fatal:true}).decode(commentRaw));
  if(c.id!==commentId||typeof c.node_id!=='string'||!/^[-_A-Za-z0-9=]{1,256}$/.test(c.node_id))throw new Error('owner_comment_node_invalid');
  const graphRaw=await run('comment-editor',['api','--hostname','github.com','graphql','-f','query='+ownerCommentQuery,'-f','id='+c.node_id]);
  const observation=verifyOwnerObservation(profile,profileSha256,proposalSha256,commentId,graphRaw,commentRaw,new Date().toISOString());
  await writeFile(join(evidenceDirectory,'observation.json'),JSON.stringify({...observation,graphRaw:undefined,commentRaw:undefined}),{flag:'wx',mode:0o600});
  return observation;
}
export function requireOwnerObservation(value:OwnerObservation,profile:AuthorityProfile,profileSha256:string,at:number) {
  if(!verifiedObservations.has(value)||value.profileSha256!==profileSha256||value.repository!==profile.repository||value.issue!==profile.issue||value.authorId!==profile.ownerId||value.executorId!==profile.executorId||value.executionKind!==profile.executionKind||at-Date.parse(value.readAt)< -60000||at-Date.parse(value.readAt)>profile.maxObservationAgeMs)throw new Error('fresh_provider_owner_observation_required');
  // Buffers remain mutable after Object.freeze; consume their exact originals.
  const checked=verifyOwnerObservation(profile,profileSha256,value.proposalSha256,value.commentId,value.graphRaw,value.commentRaw,value.readAt);
  if(checked.semanticSha256!==value.semanticSha256||checked.sourceBodySha256!==value.sourceBodySha256||checked.updatedAt!==value.updatedAt||checked.createdAt!==value.createdAt||checked.lastEditedAt!==value.lastEditedAt||checked.editorId!==value.editorId)throw new Error('owner_observation_originals_changed');
}
