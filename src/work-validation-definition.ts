import {dirname,join} from 'node:path';
import {canonical} from './comparison.js';
import {hash} from './snapshot.js';
import {regular} from './repair-workspace.js';
import {readWorkProposal} from './project-work-preparation.js';
type Row=Record<string,any>;
export const readableValidationConstraint=(sha:string)=>'Implementer may read this frozen validation definition; no write permission: '+sha;
/** Only the product-created work catalogue can identify this material. A
 * matching test hash alone, or an arbitrary installed catalogue, cannot. */
export async function workValidationDefinition(entry:Row,request:Row){
 if(entry.materialView!=='selected_files'||!entry.workRequestId||!/^work-[a-f0-9-]{36}-v[1-9]\d*$/.test(entry.id)||!([request.id,request.continuation?.originalTarget?.requestId].includes(entry.workRequestId)))throw new Error('work_validation_definition_not_product_work');
 const root=dirname(entry.root);if(entry.root!==join(root,'executions')||entry.testPlan!==join(root,'tests.json'))throw new Error('work_validation_definition_source_changed');
 const input=JSON.parse((await regular(join(root,'preparation/input.json'),512*1024)).toString());
 const prepared=await readWorkProposal(join(root,'preparation'),{path:entry.objects,H:entry.H0,repository:entry.repository}),bytes=await regular(entry.testPlan),p=JSON.parse(bytes.toString()),script=prepared.proposal.validation.script;
 if(prepared.validationProblem)throw new Error(prepared.validationProblem);
 if(input.issue?.bodySha256!==request.issue.bodySha256||canonical(entry.allowedPaths)!==canonical(prepared.proposal.allowedPaths)||canonical(entry.materialPaths)!==canonical(prepared.proposal.materialPaths)||canonical(entry.protectedPaths)!==canonical(prepared.proposal.protectedPaths)||!prepared.ready||hash(bytes)!==entry.testPlanSha256||request.workspaceRequest.testPlanSha256!==entry.testPlanSha256||p.tools?.length!==1||p.dependencyDirectory||canonical(p.tools[0])!==canonical({id:'work-acceptance',argv:[p.executor?.node,'--input-type=module','--eval',script],timeoutMs:30000}))throw new Error('work_validation_definition_source_changed');
 return {kind:'work-frozen-validation-definition' as const,source:entry.id,workRequestId:entry.workRequestId,adoption:request.adoptedScope.adoption,preparationSha256:prepared.captureSha256,testPlanSha256:entry.testPlanSha256,scriptSha256:hash(script),description:prepared.proposal.validation.description,script,readOnly:true as const};
}
/** These are actual goals, material rules and evidence limits, not an action
 * grant or a claim that the failed implementation has passed. */
export function definitionConsentContents(d:Row){return {
 goals:canonical({kind:'work-validation-material-goals',source:d.source,workRequestId:d.workRequestId,adoption:d.adoption,goal:'Keep the original adopted work and execution scope unchanged.'}),
 rules:canonical({kind:'work-validation-material-rules',source:d.source,adoption:d.adoption,scriptSha256:d.scriptSha256,testPlanSha256:d.testPlanSha256,readableBy:'original_work_implementer',readOnly:true,executionPermissionGranted:false,additionalPathsGranted:false,logsReadable:false}),
 capabilities:canonical({kind:'work-validation-material-evidence',preparationSha256:d.preparationSha256,scriptSha256:d.scriptSha256,testPlanSha256:d.testPlanSha256,technicalPass:false,userOutcomeAccepted:false,description:'Only this exact frozen definition is readable; no capability or result acceptance.'})
};}
export function definitionScopeAllows(request:Row,d:Row){return request.adoptedScope.body.constraints.includes(readableValidationConstraint(d.scriptSha256));}
