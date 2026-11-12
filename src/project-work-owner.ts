import {randomBytes} from 'node:crypto';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {canonical} from './comparison.js';
import type {ProjectChatScope} from './project-chat.js';
const exec=promisify(execFile);
type Confirmation={scope:ProjectChatScope;work:string;payload:{version:number;proposalSha256:string};preview:unknown;expiresAt:number;decision:null|'approved'|'declined'};
/** Read access can request a local prompt, never receive its approval secret.
 * The short-lived, single-use capability goes only to the host's browser. */
export class ProjectWorkOwner{
  private pending=new Map<string,Confirmation>();
  constructor(private host:()=>string,private open:(url:string)=>Promise<void>=async url=>{const binary=process.platform==='darwin'?'/usr/bin/open':process.platform==='linux'?'/usr/bin/xdg-open':null;if(!binary)throw new Error('project_work_local_owner_window_unavailable');await exec(binary,[url],{timeout:10000,maxBuffer:16384});}){}
  async request(scope:ProjectChatScope,work:string,payload:Confirmation['payload'],preview:unknown){
    for(const [token,value] of this.pending)if(value.expiresAt<Date.now())this.pending.delete(token);
    let token=[...this.pending].find(([,v])=>v.decision===null&&v.work===work&&v.scope.account.id===scope.account.id&&v.scope.repository.id===scope.repository.id&&v.scope.repository.nodeId===scope.repository.nodeId&&canonical(v.payload)===canonical(payload))?.[0];
    if(!token){if(this.pending.size>=128)throw new Error('project_work_owner_windows_pending');token=randomBytes(32).toString('hex');this.pending.set(token,{scope:structuredClone(scope),work,payload:structuredClone(payload),preview:structuredClone(preview),expiresAt:Date.now()+10*60000,decision:null});}
    // Never return/log this URL to the read-only browser or model context.
    try{await this.open('http://'+this.host()+'/owner-confirmation#'+token);}catch{throw new Error('project_work_local_owner_window_unavailable');}
    return {id:work,waitingForOwner:true,ownerWindowOpened:true,expiresAt:new Date(this.pending.get(token)!.expiresAt).toISOString()};
  }
  private record(token:string){const value=/^[a-f0-9]{64}$/.test(token)?this.pending.get(token):undefined;if(!value||value.expiresAt<Date.now())throw new Error('project_work_owner_confirmation_expired');return value;}
  view(token:string){const v=this.record(token);return {work:v.work,preview:v.preview,expiresAt:new Date(v.expiresAt).toISOString(),used:v.decision!==null,decision:v.decision};}
  pendingFor(scope:ProjectChatScope){return [...this.pending.values()].filter(v=>v.decision===null&&v.expiresAt>=Date.now()&&v.scope.account.id===scope.account.id&&v.scope.repository.id===scope.repository.id&&v.scope.repository.nodeId===scope.repository.nodeId).map(v=>v.work);}
  async approve(token:string,perform:(scope:ProjectChatScope,id:string,payload:Confirmation['payload'])=>Promise<unknown>){const v=this.record(token);if(v.decision==='approved')return {accepted:true,duplicate:true};if(v.decision==='declined')throw new Error('project_work_owner_confirmation_declined');v.decision='approved';return {accepted:true,result:await perform(v.scope,v.work,v.payload)};}
  decline(token:string){const v=this.record(token);if(v.decision==='approved')return {declined:false,alreadyApproved:true};const duplicate=v.decision==='declined';v.decision='declined';return {declined:true,duplicate,implementationStarted:false};}
  close(){this.pending.clear();}
}

export const workOwnerPage=`<!doctype html><html lang="zh-CN"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>同序 · 本人确认</title><link rel="stylesheet" href="/app.css"><script src="/project-owner.js" defer></script><main class="owner-confirmation panel"><h1>本人确认这项工作</h1><p>这个窗口由本机同序打开。普通工作台查看链接只能请求确认，不能取得本窗口的批准能力。</p><div id="preview">正在核对准确工作…</div><p class="small">确认后，程序会以已登记 GitHub 账号代发本次准确范围与实施／测试批准，并读回核验。不会因此授权合并、部署、额外计费或重置；模型不能操作本窗口。</p><button id="approve" disabled>确认这份范围并开始</button><button id="decline" class="outline" disabled>暂不批准</button><p id="status" role="status"></p></main></html>`;
