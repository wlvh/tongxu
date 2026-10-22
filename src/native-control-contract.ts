import {exactKeys} from './authority-contract.js';

export type NativeControlRequest={
  id:string;action:'steer'|'interrupt';threadId:string;sessionId:string;turnId:string;input:string|null;
};
const id=(v:unknown):v is string=>typeof v==='string'&&/^[-A-Za-z0-9_.:]{1,128}$/.test(v);
export function parseNativeControlRequest(value:unknown):NativeControlRequest{
  const p=value as NativeControlRequest;
  if(!exactKeys(p,['id','action','threadId','sessionId','turnId','input'])||![p.id,p.threadId,p.sessionId,p.turnId].every(id)||!['steer','interrupt'].includes(p.action)||!(p.action==='interrupt'?p.input===null:typeof p.input==='string'&&Boolean(p.input.trim())&&Buffer.byteLength(p.input)<=256*1024&&!p.input.includes('\0')))throw new Error('native_control_request_invalid');
  return p;
}
export type NativeControlReceipt={
  request:NativeControlRequest;requestSha256:string;operation:string;directory:string;role:string;
  result:unknown;acknowledged:true;turnTerminationVerified:false;newTurnCreated:false;
};
/** These callbacks belong to the existing owning controller, not model
 * reports. The final synchronous callback must check the exact queued action
 * and current authority in the same turn as the actual native send. */
export type NativeControlPolicy={
  beforeControl:(request:NativeControlRequest)=>Promise<void>;
  beforeControlSendSync:(request:NativeControlRequest,send:()=>void)=>void;
};
