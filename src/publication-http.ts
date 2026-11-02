import { spawn } from 'node:child_process';
import { writeFileSync, appendFileSync } from 'node:fs';
import { readFile, lstat, realpath } from 'node:fs/promises';
import { join, isAbsolute, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { hash, privateDirectory } from './snapshot.js';
import { parseGh } from './transport.js';
import { save } from './live-process.js';
import {publicationProcessIdentity,type PublicationProcessIdentity} from './publication-process.js';
import {selectGhExecutable,assertGhExecutableUnchanged,type GhExecutableSelection} from './gh-executable.js';

export type HttpReply = { status: number; value: any; directory: string; body: Buffer; headers:Record<string,string> };
export type DispatchHooks = { intent(directory: string): void; started(pid: number,identity:PublicationProcessIdentity|null): void; dispatch?(directory:string,effect:()=>void):void };
export async function ordinaryFile(path: string, limit: number): Promise<Buffer> {
  if (!isAbsolute(path) || resolve(path) !== path || await realpath(path) !== path) throw new Error('publication_path_not_canonical');
  const s = await lstat(path); if (!s.isFile() || s.isSymbolicLink() || s.nlink !== 1 || s.size > limit) throw new Error('publication_file_invalid');
  return readFile(path);
}
export class PublicationHttp {
  private selected?:GhExecutableSelection;
  get executableSelection(){return this.selected?{...this.selected}:undefined;}
  constructor(readonly directory: string, private executable: string, private executableHash: string, private repository: string, private pr: number, private H: string, private target: string, private readOnly = false, private existingGitHubAuth = true) {}
  private allowed(method: string, endpoint: string) {
    if(this.readOnly&&method!=='GET')throw new Error('readonly_source_mutation_denied');
    const repo = `repos/${this.repository}`, fixed = ['user', repo, `${repo}/pulls/${this.pr}`, `${repo}/git/ref/heads/${encodeURIComponent(this.target)}`];
    if (method === 'GET' && (fixed.includes(endpoint) || new RegExp(`^${repo.replaceAll('.', '\\.')}\/(?:issues\/${this.pr}\/comments|commits\/${this.H}\/statuses)\\?per_page=100&page=(?:[1-9]|10)$`).test(endpoint) || new RegExp(`^${repo.replaceAll('.', '\\.')}\/issues\/comments\/[1-9][0-9]*$`).test(endpoint))) return;
    if(this.readOnly&&method==='GET'&&(new RegExp(`^${repo.replaceAll('.', '\\.')}\/pulls\/${this.pr}\/(?:reviews|comments)\\?per_page=100&page=(?:[1-9]|10)$`).test(endpoint)||new RegExp(`^${repo.replaceAll('.', '\\.')}\/commits\/${this.H}\/check-runs\\?filter=latest&per_page=100&page=(?:[1-9]|10)$`).test(endpoint)))return;
    if (method === 'POST' && [`${repo}/issues/${this.pr}/comments`, `${repo}/statuses/${this.H}`].includes(endpoint)) return;
    throw new Error('publication_endpoint_denied');
  }
  async request(method: 'GET' | 'POST', endpoint: string, payload?: any, hooks?: DispatchHooks): Promise<HttpReply> {
    this.allowed(method, endpoint);
    if (method === 'POST' && (!hooks || !payload)) throw new Error('publication_dispatch_hooks_required');
    const selected=this.selected??=await selectGhExecutable(this.executable,this.executableHash);
    assertGhExecutableUnchanged(selected);
    const dir = join(this.directory, `http-${randomUUID()}`); await privateDirectory(dir, true);
    const args = ['api', '--hostname', 'github.com', '--method', method, '--include', '-H', 'Accept: application/vnd.github+json', ...(payload ? ['--input', '-'] : []), endpoint];
    const input = payload ? Buffer.from(JSON.stringify(payload)) : Buffer.alloc(0);
    writeFileSync(join(dir, 'stdin.json'), input, { flag: 'wx', mode: 0o600 });
    for (const name of ['stdout.http', 'stderr.txt']) writeFileSync(join(dir, name), '', { flag: 'wx', mode: 0o600 });
    save(join(dir, 'request.json'), { command: this.executable, executableHash: selected.sha256, executableSelection:selected, args, method, endpoint, bodySha256: hash(input), preparedAt: new Date().toISOString() });
    const env: NodeJS.ProcessEnv = { ...(this.readOnly?{PATH:'/usr/bin:/bin',HOME:this.existingGitHubAuth?process.env.HOME:dir,GH_CONFIG_DIR:this.existingGitHubAuth?process.env.GH_CONFIG_DIR:dir,GH_TOKEN:this.existingGitHubAuth?process.env.GH_TOKEN:undefined,GITHUB_TOKEN:this.existingGitHubAuth?process.env.GITHUB_TOKEN:undefined}:process.env), GH_HOST: 'github.com', GH_PROMPT_DISABLED: '1', GH_PAGER: 'cat', PAGER: 'cat' };
    delete env.GH_DEBUG; delete env.GH_FORCE_TTY;
    let failure:string|null=null,result:Promise<void>|undefined,stop=()=>{},invoked=false,accepting=true,spawnAttempted=false,inputMayHaveBeenSubmitted=false;
    // The controller can hold its original queue transaction through both
    // process creation and input submission. There is no await in this effect.
    const send=()=>{
      if(!accepting||invoked)throw new Error('publication_dispatch_effect_not_current');invoked=true;
      assertGhExecutableUnchanged(selected);
      hooks?.intent(dir);
      spawnAttempted=true;
      const child=spawn(selected.realpath,args,{cwd:dir,env,detached:true,stdio:['pipe','pipe','pipe']});
      stop=()=>{if(child.pid)try{process.kill(-child.pid,'SIGKILL');}catch{}};
      let size=0;
      const capture=(name:string,b:Buffer)=>{size+=b.length;if(size>8*1024*1024){failure='publication_http_output_limit';stop();return;}appendFileSync(join(dir,name),b);};
      result=new Promise<void>(resolve=>{
        child.once('error',()=>{failure='publication_gh_spawn_failed';});child.stdin.on('error',()=>{failure??='publication_gh_input_failed';});
        child.stdout.on('data',b=>capture('stdout.http',b));child.stderr.on('data',b=>capture('stderr.txt',b));
        child.once('close',(code,signal)=>{clearTimeout(timer);save(join(dir,'exit.json'),{code,signal,failure,finishedAt:new Date().toISOString()});resolve();});
      });
      const timer=setTimeout(()=>{failure='publication_http_timeout';stop();},30000);
      const identity=child.pid?publicationProcessIdentity(child.pid):null;
      save(join(dir,'process.json'),{pid:child.pid??null,identity});
      if(child.pid)hooks?.started(child.pid,identity);else failure='publication_gh_spawn_failed';
      if(!failure){
        save(join(dir,'submission-intent.json'),{bodySha256:hash(input),bytes:input.length,at:new Date().toISOString()});
        inputMayHaveBeenSubmitted=true;child.stdin.end(input);
        save(join(dir,'submitted.json'),{bodySha256:hash(input),bytes:input.length,at:new Date().toISOString(),remoteAcceptanceVerified:false});
      }else child.stdin.end();
    };
    try{
      const returned:unknown=hooks?.dispatch?hooks.dispatch(dir,send):send();
      if(returned&&typeof (returned as any).then==='function'){void Promise.resolve(returned).catch(()=>undefined);throw new Error('publication_dispatch_must_be_synchronous');}
      if(!invoked)throw new Error('publication_dispatch_effect_not_invoked');
    }catch(e){
      accepting=false;stop();await result;
      save(join(dir,'dispatch-error.json'),{reason:e instanceof Error?e.message:'publication_dispatch_unknown',spawnAttempted,inputMayHaveBeenSubmitted,remoteAcceptanceVerified:false,at:new Date().toISOString()});throw e;
    }finally{accepting=false;}
    await result;
    if (failure) throw new Error(failure);
    try{assertGhExecutableUnchanged(selected);}catch(e){save(join(dir,'executable-changed.json'),{reason:'gh_executable_changed_during_operation',phase:'after_process_exit',inputMayHaveBeenSubmitted,remoteAcceptanceVerified:false});throw e;}
    const raw = await readFile(join(dir, 'stdout.http'));
    let parsed: ReturnType<typeof parseGh>, value: any;
    try { parsed = parseGh(raw.toString()); value = JSON.parse(parsed.body); } catch { throw new Error('publication_http_response_unknown'); }
    const body = Buffer.from(parsed.body);
    save(join(dir, 'response.json'), { status: parsed.status, headers: parsed.headers, bodySha256: hash(body), rawSha256: hash(raw) });
    return { status: parsed.status, value, directory: dir, body, headers:parsed.headers };
  }
}
