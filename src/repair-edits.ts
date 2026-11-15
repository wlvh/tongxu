import {canonical} from './comparison.js';
export type EditProfile='literal-edits-v1';
export function parseEditProfile(value:unknown):EditProfile|undefined {
 if(value===undefined)return undefined;if(value!=='literal-edits-v1')throw new Error('implementation_edit_profile_invalid');return value;
}
export function implementationEditProfile(request:any,plan:any,manifest?:any){
 const profile=parseEditProfile(request.editProfile);
 if(canonical(profile??null)!==canonical(plan.editProfile??null)||manifest&&canonical(profile??null)!==canonical(manifest.editProfile??null))throw new Error('implementation_edit_profile_changed');return profile;
}
function utf8(text:unknown):asserts text is string {
 if(typeof text!=='string'||text.includes('\0')||Buffer.from(text).toString('utf8')!==text)throw new Error('literal_edit_invalid_utf8');
}
/** All anchors address the original bytes. No regex or sequential replacement. */
export function replacementText(arguments_:any,before:Buffer,profile?:EditProfile){
 parseEditProfile(profile);
 const keys=arguments_&&typeof arguments_==='object'&&!Array.isArray(arguments_)?Object.keys(arguments_).sort().join():'';
 if(!profile){if(keys!=='expectedSha256,path,text'||typeof arguments_.text!=='string'||Buffer.byteLength(arguments_.text)>256*1024)throw new Error('write_outside_grant_or_stale_input');return arguments_.text as string;}
 if(!['edits,expectedSha256,path','expectedSha256,path,text'].includes(keys))throw new Error('literal_edit_arguments_invalid');
 if(Buffer.byteLength(JSON.stringify(arguments_))>(keys==='edits,expectedSha256,path'?64*1024:2*1024*1024))throw new Error('literal_edit_arguments_limit');
 const original=new TextDecoder('utf-8',{fatal:true,ignoreBOM:true}).decode(before);if(!Buffer.from(original).equals(before))throw new Error('literal_edit_invalid_utf8');utf8(original);
 let after:string;
 if(keys==='expectedSha256,path,text'){utf8(arguments_.text);after=arguments_.text;}
 else {
  const edits=arguments_.edits;if(!Array.isArray(edits)||edits.length<1||edits.length>16)throw new Error('literal_edit_count_limit');
  let total=0;const spans=edits.map((edit:any)=>{
   if(!edit||typeof edit!=='object'||Array.isArray(edit)||Object.keys(edit).sort().join()!=='newText,oldText')throw new Error('literal_edit_arguments_invalid');
   utf8(edit.oldText);utf8(edit.newText);const oldBytes=Buffer.byteLength(edit.oldText),newBytes=Buffer.byteLength(edit.newText);
   if(!oldBytes||oldBytes>16*1024||newBytes>16*1024||(total+=oldBytes+newBytes)>32*1024)throw new Error('literal_edit_text_limit');
   const start=original.indexOf(edit.oldText);if(start<0||original.indexOf(edit.oldText,start+1)>=0)throw new Error('literal_edit_anchor_not_unique');return {start,end:start+edit.oldText.length,text:edit.newText};
  }).sort((a,b)=>a.start-b.start);
  let offset=0;const parts:string[]=[];for(const span of spans){if(span.start<offset)throw new Error('literal_edit_ranges_overlap');parts.push(original.slice(offset,span.start),span.text);offset=span.end;}parts.push(original.slice(offset));after=parts.join('');
 }
 utf8(after);if(Buffer.byteLength(after)>256*1024)throw new Error('literal_edit_result_limit');
 // A source BOM is bytes, never an implicit decoder option or an editable prefix.
 if(original.startsWith('\uFEFF')!==after.startsWith('\uFEFF'))throw new Error('literal_edit_bom_changed');return after;
}
