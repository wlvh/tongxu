import {parse} from 'acorn';
/** Facts of ProjectWork's existing executor, not an execution tool. */
export const workValidationInvocation=(node:string)=>({kind:'node-esm-eval-cwd-v1',node,argv:[node,'--input-type=module','--eval','<frozen validation.script>'],cwd:'/work',timeoutMs:30000,scriptArguments:[],globalRequire:false,source:'selected material only; no .git or unselected blobs'});
export const workPreparationBudgets={selectedFileBytes:256*1024,initialEditableRawBytes:384*1024,initialMaterialSerializedBytes:768*1024,taskObservationRawBytes:384*1024,ownerContextBytes:512*1024,observation:'Host chooses a small existing representative file, within allowedPaths and at most64KiB, for generic task observation. This is not write scope; full selected-tree/index/protection checks remain mandatory.',meaning:'Preparation/context limits are not business acceptance assertions. Leave growth headroom and do not bake initial-size limits into the project validation script.'};
/** Only two known invocation mismatches are rejected. This is not a JS
 * correctness/security analyzer, and never executes the proposed script. */
export function workValidationProblem(script:string):string|null{
 let ast:any;try{ast=parse(script,{sourceType:'module',ecmaVersion:'latest'});}catch{return 'project_work_validation_esm_syntax_required';}
 const boundRequire=ast.body.some((s:any)=>s.type==='ImportDeclaration'&&s.specifiers.some((x:any)=>x.local?.name==='require')||s.type==='VariableDeclaration'&&s.declarations.some((x:any)=>x.id.type==='Identifier'&&x.id.name==='require'));
 let problem:string|null=null;const walk=(n:any)=>{if(!n||typeof n!=='object')return;if(n.type==='MemberExpression'&&n.object?.type==='Identifier'&&n.object.name==='process'&&(!n.computed&&n.property?.name==='argv'||n.computed&&n.property?.value==='argv'))problem='project_work_validation_no_script_arguments';if(n.type==='CallExpression'&&n.callee?.type==='Identifier'&&n.callee.name==='require'&&!boundRequire)problem='project_work_validation_esm_import_required';for(const v of Object.values(n))if(Array.isArray(v))v.forEach(walk);else if(v&&typeof v==='object')walk(v);};walk(ast);return problem;
}
