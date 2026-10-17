// Minimal DOM/localStorage stub so the original HTML script can be evaluated and its functions called directly.
const fs=require('fs');
const src=fs.readFileSync(process.argv[2],'utf8');
const js=src.slice(src.indexOf('<script>')+8, src.lastIndexOf('</script>'));
const el=()=>({style:{},value:'',textContent:'',hidden:false,innerHTML:'',classList:{add(){},remove(){},toggle(){}},addEventListener(){},focus(){},querySelector:()=>null,dataset:{}});
const stubs=new Proxy({}, {get:(t,k)=> (t[k] ??= el())});
global.document={documentElement:el(),body:el(),querySelector:(s)=>stubs[s],querySelectorAll:()=>[],addEventListener(){},activeElement:null,createElement:()=>({click(){},href:'',download:''})};
global.window={scrollTo(){},__tongxuDemo:null};
global.navigator={clipboard:{writeText:async()=>{}}};
global.localStorage={getItem:()=>null,setItem(){}};
global.URL={createObjectURL:()=>'',revokeObjectURL(){}};
global.Blob=class{};
// Run timers synchronously so "later()" effects are visible immediately.
const queue=[]; global.setTimeout=(fn)=>{queue.push(fn);return queue.length;}; global.clearTimeout=()=>{};
// Expose inner functions by appending exports to the evaluated script.
const expose=['s','pr','ses','task','flow','checks','mergeEligibility','mutate','runReview','dispatchTask','deliver','act','headFreshReview','submitMerge'];
const body=js.replace(/^'use strict';/,'')+`\n;module.exports={${expose.map(n=>`${n}:()=>${n}`).join(',')}, setS:(v)=>{s=v;},setModal:(v)=>{modalState=v;}};`;
const m={exports:{}}; new Function('module','require',body)(m,require);
m.exports.flush=()=>{while(queue.length){queue.shift()();}}; module.exports=m.exports;
