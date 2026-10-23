#!/usr/bin/env node
import { readPacket } from './queue-evidence.js';
import { QueueStore } from './queue-store.js';
import { regular } from './repair-workspace.js';
import { resolve } from 'node:path';
try {
  const a=process.argv.slice(2);let result:unknown;
  if(a.length===3&&a[0]==='enable'&&a[1]==='--store'){const q=await QueueStore.open(a[2]!);try{result=q.enableCompositions();}finally{q.close();}}
  else if(a.length===3&&a[0]==='import'&&a[1]==='--plan'){
    const p=JSON.parse((await regular(a[2]!)).toString());
    if(p.schemaVersion!==1||p.kind!=='tongxu-composition-import'||!Array.isArray(p.snapshots)||p.snapshots.length<2||p.snapshots.length>8||Object.keys(p).sort().join()!=='context,kind,schemaVersion,snapshots,store,verification')throw new Error('invalid_composition_import_plan');
    for(const path of [p.store,p.verification,p.context,...p.snapshots])if(typeof path!=='string'||resolve(path)!==path)throw new Error('composition_path_not_canonical');
    const packet=await readPacket(p.snapshots.at(-1),p.verification,p.context,p.snapshots),q=await QueueStore.open(p.store);
    try{result=q.import(packet);}finally{q.close();}
  }else throw new Error('usage: enable --store ABS | import --plan ABS');
  process.stdout.write(JSON.stringify(result)+'\n');
}catch(e){process.stderr.write(JSON.stringify({error:e instanceof Error?e.message:'composition_error'})+'\n');process.exitCode=1;}
