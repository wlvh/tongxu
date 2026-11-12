import {DatabaseSync} from 'node:sqlite';
import {writeFile} from 'node:fs/promises';
import {join} from 'node:path';
import {privateDirectory} from './snapshot.js';
import {regular,exists} from './repair-workspace.js';
import {canonical} from './comparison.js';
import type {ProjectChatScope} from './project-chat.js';
import type {WorkProposal} from './project-work-contract.js';
type Row=Record<string,any>;
export type ProjectWorkDraft={id:string;issue:{number:number;title:string;body:string;url:string;bodySha256:string};conversationId:string;goal:string;createdAt:string;updatedAt:string;revision:number;version:number;requestId:string;stage:string;problem:string|null;stopRequested?:boolean;preparation?:{directory:string;H:string;repositoryPath:string;inputSha256:string;proposal?:WorkProposal;captureSha256?:string;pid?:number;observedAt?:string};catalog?:{path:string;sha256:string};source?:string;delivery?:{H:string;previous:string|null;branch:string;workspace:string;status:'pending'|'received';problem:string|null};prior?:Array<Pick<ProjectWorkDraft,'version'|'requestId'|'source'|'catalog'|'preparation'|'delivery'>>;events:Array<{at:string;kind:string;detail:string}>};
export const workProjectKey=(scope:ProjectChatScope)=>canonical([scope.account.id,scope.repository.id,scope.repository.nodeId,scope.repository.fullName.toLowerCase()]);
/** Only preparation/settings and references live here. Execution, authority,
 * resource and report facts continue to belong to their existing queue. */
export class ProjectWorkStore{
  private constructor(private db:DatabaseSync){}
  static async open(root:string){
    await privateDirectory(root,!await exists(root));const path=join(root,'preparations.sqlite');
    try{await writeFile(path,'',{flag:'wx',mode:0o600});}catch(e:any){if(e.code!=='EEXIST')throw e;}
    await regular(path,64*1024*1024);const db=new DatabaseSync(path);
    db.exec(`PRAGMA journal_mode=WAL;PRAGMA synchronous=FULL;PRAGMA busy_timeout=5000;
      CREATE TABLE IF NOT EXISTS settings(project TEXT PRIMARY KEY,body TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS drafts(id TEXT PRIMARY KEY,project TEXT NOT NULL,issue INTEGER NOT NULL,revision INTEGER NOT NULL,body TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS project_work_drafts ON drafts(project,issue);`);
    return new ProjectWorkStore(db);
  }
  settings(scope:ProjectChatScope):{repositoryPath:string;verified?:boolean;problem?:string|null}|null{const r=this.db.prepare('SELECT body FROM settings WHERE project=?').get(workProjectKey(scope)) as Row|undefined;return r?JSON.parse(r.body):null;}
  setSettings(scope:ProjectChatScope,value:{repositoryPath:string;verified?:boolean;problem?:string|null}){this.db.prepare('INSERT INTO settings VALUES(?,?) ON CONFLICT(project) DO UPDATE SET body=excluded.body').run(workProjectKey(scope),canonical(value));}
  list(scope:ProjectChatScope){return (this.db.prepare('SELECT body FROM drafts WHERE project=? ORDER BY rowid DESC LIMIT 128').all(workProjectKey(scope)) as Row[]).map(r=>JSON.parse(r.body) as ProjectWorkDraft);}
  get(scope:ProjectChatScope,id:string){const r=this.db.prepare('SELECT project,body FROM drafts WHERE id=?').get(id) as Row|undefined;if(!r||r.project!==workProjectKey(scope))throw new Error('project_work_outside_project');return JSON.parse(r.body) as ProjectWorkDraft;}
  cleanupScope(account:number,repository:number,id:string):ProjectChatScope{
    const r=this.db.prepare('SELECT project FROM drafts WHERE id=?').get(id) as Row|undefined;
    const identity=r?JSON.parse(r.project):null;if(!identity||identity[0]!==account||identity[1]!==repository)throw new Error('project_work_outside_project');
    return {account:{id:account,login:''},repository:{id:repository,nodeId:identity[2],fullName:identity[3]}} as ProjectChatScope;
  }
  create(scope:ProjectChatScope,draft:ProjectWorkDraft,reuseCurrent=false){
    this.db.exec('BEGIN IMMEDIATE');try{
      const old=this.db.prepare('SELECT project,body FROM drafts WHERE id=?').get(draft.id) as Row|undefined;
      if(old){const value=this.get(scope,draft.id);if(value.issue.number!==draft.issue.number||value.conversationId!==draft.conversationId)throw new Error('project_work_id_is_fixed');this.db.exec('COMMIT');return value;}
      if(reuseCurrent){const previous=this.list(scope).find(d=>d.issue.number===draft.issue.number&&!['delivered','cancelled','no_change'].includes(d.stage));if(previous){this.db.exec('COMMIT');return previous;}}
      if(this.list(scope).length>=128)throw new Error('project_work_history_limit');
      this.db.prepare('INSERT INTO drafts VALUES(?,?,?,?,?)').run(draft.id,workProjectKey(scope),draft.issue.number,draft.revision,canonical(draft));this.db.exec('COMMIT');return draft;
    }catch(e){this.db.exec('ROLLBACK');throw e;}
  }
  save(scope:ProjectChatScope,draft:ProjectWorkDraft,expectedRevision:number){
    const next={...draft,revision:expectedRevision+1,updatedAt:new Date().toISOString()};
    const changed=this.db.prepare('UPDATE drafts SET revision=?,body=? WHERE id=? AND project=? AND revision=?').run(next.revision,canonical(next),draft.id,workProjectKey(scope),expectedRevision);
    if(changed.changes!==1)throw new Error('project_work_revision_changed');return next;
  }
  close(){this.db.close();}
}
