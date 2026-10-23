import {isAbsolute,resolve} from 'node:path';
import {canonical} from './comparison.js';
import {hash} from './snapshot.js';
import {exactKeys,isAuthorityDigest} from './authority-contract.js';

export type PublicationGovernance={authorityIntent:string;resourceRequests:string[]};
export type PublicationPlan={schemaVersion:1;kind:'tongxu-reception-publication';store:string;operation:string;channel:'commit-status';ghExecutable:string;ghSha256:string;repositoryId:number;actor:{id:number;login:string};source:string;governance?:PublicationGovernance};

export function parsePublicationPlan(bytes:Buffer):PublicationPlan{
  const p=JSON.parse(new TextDecoder('utf8',{fatal:true}).decode(bytes));
  const keys=['schemaVersion','kind','store','operation','channel','ghExecutable','ghSha256','repositoryId','actor','source',...(p&&Object.hasOwn(p,'governance')?['governance']:[])];
  if(!exactKeys(p,keys)||p.schemaVersion!==1||p.kind!=='tongxu-reception-publication'||p.channel!=='commit-status'||!/^[a-f0-9-]{36}$/.test(p.operation)||!isAuthorityDigest(p.ghSha256)||!Number.isSafeInteger(p.repositoryId)||p.repositoryId<1||!exactKeys(p.actor,['id','login'])||!Number.isSafeInteger(p.actor.id)||p.actor.id<1||typeof p.actor.login!=='string'||!/^[A-Za-z0-9-]{1,39}$/.test(p.actor.login)||typeof p.source!=='string'||!p.source.trim()||p.source.length>2048||p.source.includes('\0'))throw new Error('invalid_publication_plan');
  for(const path of [p.store,p.ghExecutable])if(typeof path!=='string'||!isAbsolute(path)||resolve(path)!==path)throw new Error('invalid_publication_path');
  if(p.governance!==undefined){
    const g=p.governance;
    if(!exactKeys(g,['authorityIntent','resourceRequests'])||typeof g.authorityIntent!=='string'||!/^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/.test(g.authorityIntent)||!Array.isArray(g.resourceRequests)||g.resourceRequests.length>32||new Set(g.resourceRequests).size!==g.resourceRequests.length||!g.resourceRequests.every(isAuthorityDigest))throw new Error('invalid_publication_governance');
  }
  return p;
}

/** The exact public material and executable belong to the permission. Its
 * reservation/resource IDs are excluded so that they can bind this digest. */
export function publicationAuthorityPayload(p:PublicationPlan,documentSha256:string){
  if(!isAuthorityDigest(documentSha256))throw new Error('invalid_publication_document_digest');
  return {schemaVersion:1,kind:'tongxu-publication-action',store:p.store,operation:p.operation,channel:p.channel,ghExecutable:p.ghExecutable,ghSha256:p.ghSha256,repositoryId:p.repositoryId,actor:p.actor,sourceSha256:hash(p.source),documentSha256};
}
export const publicationAuthorityPayloadSha=(p:PublicationPlan,documentSha256:string)=>hash(canonical(publicationAuthorityPayload(p,documentSha256)));
