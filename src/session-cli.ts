#!/usr/bin/env node
import { join,dirname,isAbsolute,resolve } from 'node:path';
import { writeFile,mkdir } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import { QueueStore } from './queue-store.js';
import { regular } from './repair-workspace.js';
import { privateDirectory } from './snapshot.js';
import { readExactCodexSession,replaySessionRead } from './session-source.js';
import { readArchivedSession } from './session-capture.js';

const options:Record<string,string[]>={associate:['store','request','input'],link:['store','request','input'],status:['store','request'],reconcile:['store','request']};
export async function sessionMain(args:string[]){
  const action=args[0]??'',keys=options[action],v:Record<string,string>={};if(!keys||args.length!==keys.length*2+1)throw new Error('session_command_invalid');
  for(let i=1;i<args.length;i+=2){const key=args[i]!.slice(2),value=args[i+1];if(!args[i]!.startsWith('--')||!keys.includes(key)||!value||Object.hasOwn(v,key))throw new Error('session_option_invalid');v[key]=value;}
  if(!/^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/.test(v.request!))throw new Error('session_request_id_invalid');
  for(const key of keys.filter(k=>k!=='request'))if(!isAbsolute(v[key]!)||resolve(v[key]!)!==v[key])throw new Error('session_absolute_path_required');
  const q=await QueueStore.open(v.store!);let lock:DatabaseSync|undefined;
  try{
    if(action==='link'){
      const p=JSON.parse((await regular(v.input!,16384)).toString());if(!p||Object.keys(p).sort().join()!=='directory,format,item,role'||typeof p.directory!=='string'||!isAbsolute(p.directory)||resolve(p.directory)!==p.directory)throw new Error('session_archive_link_plan_invalid');
      return q.sessions().linkCapture(v.request!,p.item,p.role,await readArchivedSession(p.format,p.directory));
    }
    const records=q.sessions(),prepared=action==='associate'?records.prepare(v.request!,await regular(v.input!,16384)):records.status(v.request!);
    if(prepared.status==='archived_result_linked')return prepared;
    if(action==='status'||prepared.observation)return prepared;
    const directory=dirname(prepared.directory);try{await mkdir(directory,{mode:0o700});}catch(e:any){if(e.code!=='EEXIST')throw e;}await privateDirectory(directory,false);
    const path=join(directory,'controller.sqlite');try{await writeFile(path,'',{flag:'wx',mode:0o600});}catch(e:any){if(e.code!=='EEXIST')throw e;}await regular(path,4*1024*1024);
    lock=new DatabaseSync(path);try{lock.exec('PRAGMA busy_timeout=0;BEGIN IMMEDIATE');}catch{lock.close();lock=undefined;throw new Error('session_reader_controller_active');}
    const current=records.status(v.request!);if(current.observation)return current;
    if(action==='associate'&&current.status!=='prepared_not_started')return {...current,next:'reconcile_original_session_read',newReaderStarted:false};
    try{
      if(action==='associate')records.started(v.request!);
      const observation=action==='associate'?await readExactCodexSession(current.spec,current.directory):await replaySessionRead(current.spec,current.directory);
      return {...records.observe(v.request!,observation),newReaderStarted:action==='associate'};
    }catch(e){records.problem(v.request!,e instanceof Error?e.message:'session_read_unknown');throw e;}
  }finally{if(lock){lock.exec('ROLLBACK');lock.close();}q.close();}
}
if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href){try{process.stdout.write(JSON.stringify(await sessionMain(process.argv.slice(2)))+'\n');}catch(e){process.stderr.write(JSON.stringify({error:e instanceof Error?e.message:'session_operation_failed'})+'\n');process.exitCode=1;}}
