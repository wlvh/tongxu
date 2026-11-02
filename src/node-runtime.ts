// Pure Node capability checks. No application imports or startup side effects.
export const minimumNodeVersion='24.0.0';
export function supportedNodeVersion(version:unknown){
  if(typeof version!=='string'||version.length>128)return false;
  const match=/^v?(\d+)\.(\d+)\.(\d+)(?:[-+][A-Za-z0-9._-]+)?$/.exec(version);
  return !!match&&match.slice(1,4).every(n=>Number.isSafeInteger(Number(n)))&&Number(match[1])>=24;
}
export async function requireNodeRuntime(){
  if(!supportedNodeVersion(process.version))throw new Error('node_minimum_version_24_0_0_required');
  let db:import('node:sqlite').DatabaseSync|undefined;
  try{
    const {DatabaseSync}=await import('node:sqlite');db=new DatabaseSync(':memory:');
    db.exec('CREATE TABLE runtime_probe(value INTEGER NOT NULL) STRICT; BEGIN IMMEDIATE; INSERT INTO runtime_probe VALUES (1)');
    if(db.isTransaction!==true||db.prepare('SELECT value FROM runtime_probe').get()?.value!==1)throw new Error('capability');
    db.exec('ROLLBACK');if(Boolean(db.isTransaction)||db.prepare('SELECT count(*) AS n FROM runtime_probe').get()?.n!==0)throw new Error('capability');
  }catch{throw new Error('node_sqlite_capability_unavailable');}finally{db?.close();}
  return {nodeVersion:process.version,nodeExecutable:process.execPath,minimumNodeVersion};
}
