// Generic loader: evaluates an extracted <script> body under DOM/localStorage stubs and exposes named internals.
const fs=require('fs');
module.exports=function load(jsPath, expose, pre={}){
  const js=fs.readFileSync(jsPath,'utf8');
  const el=()=>({style:{},value:'',textContent:'',hidden:false,innerHTML:'',checked:false,dataset:{},classList:{add(){},remove(){},toggle(){},contains(){return false}},addEventListener(){},removeEventListener(){},focus(){},blur(){},append(){},remove(){},click(){},scrollIntoView(){},setAttribute(){},getAttribute(){return null},querySelector:()=>el(),querySelectorAll:()=>[],closest:()=>null,getBoundingClientRect:()=>({top:0}),offsetParent:null,isConnected:false});
  const stubs={}; const Q=(s)=>(stubs[s] ??= el()); for(const [k,v] of Object.entries(pre)){Q(k).textContent=v;}
  global.document={documentElement:el(),body:el(),querySelector:Q,querySelectorAll:()=>[],getElementById:(id)=>Q('#'+id),addEventListener(){},activeElement:null,createElement:()=>el()};
  global.window={scrollTo(){},addEventListener(){},confirm:()=>true,innerHeight:800,scrollY:0,print(){},location:{hash:''}};
  global.location={hash:''}; global.history={replaceState(){}};
  global.navigator={clipboard:{writeText:async()=>{}}};
  global.localStorage={getItem:()=>null,setItem(){},removeItem(){}};
  global.URL={createObjectURL:()=>'',revokeObjectURL(){}}; global.Blob=class{};
  global.requestAnimationFrame=(fn)=>0;
  const queue=[]; global.setTimeout=(fn)=>{queue.push(fn);return queue.length;}; global.clearTimeout=()=>{};
  const body=js.replace(/^'use strict';/,'')+`\n;module.exports={${expose.map(n=>`${n}:()=>${n}`).join(',')}, __set:(n,v)=>{__v=v;eval(n+'=__v');}, __eval:(code)=>eval(code)};`;
  const m={exports:{}}; new Function('module','require','__v',body)(m,require);
  m.exports.flush=()=>{let n=0;while(queue.length){queue.shift()();n++;}return n;};
  m.exports.stubs=stubs; m.exports.Q=Q;
  return m.exports;
};
