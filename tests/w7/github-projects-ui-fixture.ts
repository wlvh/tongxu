import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {createContext,runInContext} from 'node:vm';

/** Execute the actual page's request/state functions with a controlled network.
 * Browser rendering and real GitHub are checked separately in the local trial. */
export async function page(network?:{hash:string;fetch:(path:string,options:any)=>Promise<any>}){
  const full=await readFile(new URL('../../../web/workbench/app.js',import.meta.url),'utf8'),end=full.lastIndexOf("document.querySelectorAll('[data-view]').forEach");assert.ok(end>0);
  const calls:Array<{path:string;resolve:(value:any)=>void;reject:(error:Error)=>void}>=[];
  class Element{
    [key:string]:any;children:any[]=[];attributes=new Map<string,string>();dataset:Record<string,string>={};open=false;disabled=false;textContent='';
    constructor(readonly tag:string){}
    append(...children:any[]){this.children.push(...children);}
    contains(node:any):boolean{return this===node||this.children.some(c=>c?.contains?.(node));}
    replaceChildren(...children:any[]){if(this.children.some(c=>c?.contains?.(document.activeElement)))document.activeElement=null;this.children=children;}
    get id(){return this.elementId;}
    set id(value:string){this.elementId=value;nodes.set(value,this);}
    focus(){document.activeElement=this;}
    setSelectionRange(start:number,end:number){this.selectionStart=start;this.selectionEnd=end;}

    get firstChild(){return this.children[0];}
    setAttribute(k:string,v:string){this.attributes.set(k,v);}
    removeAttribute(k:string){this.attributes.delete(k);}
    show(){this.open=true;this.modal=false;}
    showModal(){this.open=true;this.modal=true;}
    close(){this.open=false;}
  }
  const nodes=new Map<string,Element>(),get=(id:string)=>{if(!nodes.has(id))nodes.set(id,new Element(id));return nodes.get(id)!;},navigation=['projects','github','local-history','overview','tasks','events'].map(view=>{const n=new Element('button');n.dataset.view=view;return n;});
  const document:{[key:string]:any}={activeElement:null,getElementById:get,createElement:(tag:string)=>new Element(tag),createTextNode:(text:string)=>Object.assign(new Element('text'),{textContent:text}),querySelector:(selector:string)=>get(selector),querySelectorAll:()=>navigation};
  const fetchCalls:Array<{path:string;options:any;resolve:(value:any)=>void;reject:(error:Error)=>void}>=[];
  const context=createContext({structuredClone,renderProjectChat:()=>{},loadProjectChat:()=>{},setSecretaryOpen:()=>{},fetch:(path:string,options:any)=>network?network.fetch(path,options):new Promise((resolve,reject)=>fetchCalls.push({path,options,resolve,reject})),location:{hash:network?.hash??'#'+'a'.repeat(64)},document,setTimeout,clearTimeout});runInContext(full.slice(0,end),context);runInContext(await readFile(new URL('../../../web/workbench/reception.js',import.meta.url),'utf8'),context);
  (context as any).fakeRead=(path:string)=>new Promise((resolve,reject)=>calls.push({path,resolve,reject}));
  runInContext("githubApi=fakeRead;gh.account={id:7,login:'fixture'};entryInfo={githubProjects:true};",context);
  const run=(text:string)=>runInContext(text,context),state=()=>JSON.parse(run('JSON.stringify(gh)'));const findFilter=():Element=>{const visit=(n:Element):Element|undefined=>n.tag==='input'&&n.type==='search'?n:n.children.map((x:Element)=>visit(x)).find(Boolean);return visit(get('content'))!;};return {calls,fetchCalls,run,state,nodes,document,findFilter};
}
