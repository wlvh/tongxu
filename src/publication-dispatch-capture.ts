import {join} from 'node:path';
import {regular} from './repair-workspace.js';
import {canonical} from './comparison.js';
import {hash} from './snapshot.js';
import type {PublicationPlan} from './publication-contract.js';
import {requirePublicationExit,requirePublicationProcessEnded,type PublicationProcessIdentity,type PublicationProcessRecord} from './publication-process.js';
import {capturedGhExecutableMatches} from './gh-executable.js';

type Row=Record<string,any>;
export type PublicationDispatchCapture={directory:string;preparedSha256:string;phase:'ended_possible';observedPid:number|null;processIdentity?:PublicationProcessIdentity;originals:Map<string,Buffer>;digest:string};
const issued=new WeakSet<object>();
const digest=(v:Omit<PublicationDispatchCapture,'digest'>)=>hash(canonical({...v,originals:[...v.originals].map(([n,b])=>[n,hash(b)])}));
/** Read an original prepared request. Absence of a database intent or a reply
 * is never evidence that POST did not occur. This reader cannot send. */
export async function readPublicationDispatchCapture(p:PublicationPlan,prepared:Row,requestBytes:Buffer,registered?:PublicationProcessRecord){
  const originals=new Map<string,Buffer>(),directory=prepared.directory;
  const read=async(name:string,optional=false)=>{try{const b=await regular(join(directory,name),8*1024*1024);originals.set(name,b);return b;}catch(e){if(optional&&(e as NodeJS.ErrnoException).code==='ENOENT')return undefined;throw e;}};
  const request=JSON.parse((await read('request.json'))!.toString()),input=(await read('stdin.json'))!;
  const args=['api','--hostname','github.com','--method','POST','--include','-H','Accept: application/vnd.github+json','-H','X-GitHub-Api-Version: 2022-11-28','--input','-',prepared.endpoint];
  const currentArgs=args.filter((_,i)=>i!==8&&i!==9);
  if(!capturedGhExecutableMatches(request,p.ghExecutable,p.ghSha256)||request.method!=='POST'||request.endpoint!==prepared.endpoint||(canonical(request.args)!==canonical(args)&&canonical(request.args)!==canonical(currentArgs))||request.bodySha256!==hash(requestBytes)||!input.equals(requestBytes))throw new Error('publication_original_dispatch_changed');
  const processBytes=await read('process.json',true),exitBytes=await read('exit.json',true),intent=await read('submission-intent.json',true),submitted=await read('submitted.json',true);await read('dispatch-error.json',true);
  // Preserve the uncertain invocation; recovery may read the remote original
  // but this ended-possible capture never authorizes resending that POST.
  await read('executable-changed.json',true);
  await read('stdout.http');await read('stderr.txt');
  for(const bytes of [intent,submitted])if(bytes){const v=JSON.parse(bytes.toString());if(v.bodySha256!==hash(requestBytes)||v.bytes!==requestBytes.length||!Number.isFinite(Date.parse(v.at)))throw new Error('publication_original_submission_changed');}
  let observedPid:number|null=null;
  {
    if(!processBytes)throw new Error('publication_original_process_unknown');const process=JSON.parse(processBytes.toString());
    if(!Number.isSafeInteger(process.pid)||process.pid<2)throw new Error('publication_original_process_unknown');observedPid=process.pid;
    if(registered&&(registered.pid!==process.pid||registered.identity&&canonical(registered.identity)!==canonical(process.identity??null)))throw new Error('publication_original_process_changed');
    if(exitBytes)requirePublicationExit(JSON.parse(exitBytes.toString()));
    requirePublicationProcessEnded(process.pid,registered?.identity);
  }
  const v={directory,preparedSha256:hash(canonical(prepared)),phase:'ended_possible' as const,observedPid,...(registered?.identity?{processIdentity:registered.identity}:{}),originals};const value=Object.freeze({...v,digest:digest(v)});issued.add(value);return value;
}
export function requirePublicationDispatchCapture(value:PublicationDispatchCapture){const {digest:saved,...v}=value;if(!issued.has(value)||saved!==digest(v))throw new Error('publication_original_dispatch_capture_required');return value;}
