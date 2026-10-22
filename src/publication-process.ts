import {execFileSync} from 'node:child_process';
import {readFileSync} from 'node:fs';
import {canonical} from './comparison.js';
import {processState} from './repair-workspace.js';

export type PublicationProcessIdentity={method:'darwin-ps-lstart-v1'|'linux-proc-starttime-v1';start:string};
export type PublicationProcessRecord={pid:number;identity?:PublicationProcessIdentity|null};

/** A start identity is recorded while the owned child is first launched, and
 * bound to its queue event. A later local file is not an identity authority.
 * macOS ps has second precision: same-second PID reuse stays conservatively
 * active. Linux uses boot id and kernel start ticks, never wall-clock age. */
export function publicationProcessIdentity(pid:number):PublicationProcessIdentity|null{
  if(!Number.isSafeInteger(pid)||pid<2)return null;
  try{
    if(process.platform==='darwin'){
      const start=execFileSync('/bin/ps',['-p',String(pid),'-o','lstart='],{encoding:'utf8',env:{PATH:'/usr/bin:/bin',LC_ALL:'C',TZ:'UTC'},timeout:2000,maxBuffer:4096,stdio:['ignore','pipe','pipe']}).trim();
      if(!/^[A-Z][a-z]{2} [A-Z][a-z]{2}\s+[0-9]{1,2} [0-9]{2}:[0-9]{2}:[0-9]{2} [0-9]{4}$/.test(start))return null;
      return {method:'darwin-ps-lstart-v1',start};
    }
    if(process.platform==='linux'){
      const stat=readFileSync(`/proc/${pid}/stat`,'utf8'),fields=stat.slice(stat.lastIndexOf(')')+2).trim().split(/\s+/),ticks=fields[19],boot=readFileSync('/proc/sys/kernel/random/boot_id','utf8').trim();
      if(!ticks||!/^\d+$/.test(ticks)||!/^[a-f0-9-]{36}$/.test(boot))return null;
      return {method:'linux-proc-starttime-v1',start:`${boot}:${ticks}`};
    }
  }catch{/* An unavailable probe cannot supply an ended proof. */}
  return null;
}
export function requirePublicationExit(value:any){
  if(!(Number.isSafeInteger(value.code)&&value.code>=0||value.code===null&&typeof value.signal==='string'&&value.signal.length>0)||!(value.signal===null||typeof value.signal==='string')||!Number.isFinite(Date.parse(value.finishedAt)))throw new Error('publication_exit_record_invalid');
}
export function requirePublicationProcessEnded(pid:unknown,identity?:PublicationProcessIdentity|null){
  const state=processState(pid);if(state==='ended')return;
  if(state==='unknown')throw new Error('publication_original_process_unknown');
  if(identity){
    const observed=publicationProcessIdentity(Number(pid));
    // Compare only identities from the same supported mechanism. Missing,
    // unsupported or unchanged observations never establish PID reuse.
    if(observed&&observed.method===identity.method&&typeof identity.start==='string'&&identity.start.length>0&&canonical(observed)!==canonical(identity))return;
  }
  // The process may have ended during the identity read. Otherwise a valid
  // exit file cannot override the actual live/unknown original process.
  if(processState(pid)==='ended')return;
  throw new Error('publication_original_process_active');
}
