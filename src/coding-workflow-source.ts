import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { exactKeys } from './authority-contract.js';
import { canonical } from './comparison.js';
import { regular } from './repair-workspace.js';
import { hash } from './snapshot.js';

const repository = 'wlvh/coding-workflow';
export const firstCodingWorkflowRevision = '11cf57b34698e6f7b38ee73468e84103cde8f963';
const revision=firstCodingWorkflowRevision;
const packageSha256 = '61c96895fd565eab71c2e302144ad69f8fcb19d2713f15bc7055e13a464465ad';
const indexPath = 'zh/prompts/coding_workflow.json';
const entrypoint = 'zh/docs/development_workflow/README.md';
const adoption = 'zh/docs/development_workflow/version_adoption.md';
const promptReadme = 'zh/prompts/README.md';
const executionContract = 'coding-loop-v2';
const uses = [
  'issue_author', 'issue_review_completion', 'issue_review_minimality', 'engineering_owner',
  'pr_review_correctness', 'pr_review_impact', 'finding_verification_fact',
  'finding_verification_impact', 'integration_acceptance', 'delivery_explanation',
] as const;
export type CodingWorkflowUse = typeof uses[number];
const includedSource = fileURLToPath(new URL(`../../workflow-candidates/${revision}`, import.meta.url));

function parseIndex(text: string) {
  let index;
  try {
    index = JSON.parse(text);
  } catch {
    throw new Error('coding_workflow_index_invalid');
  }
  if (!exactKeys(index, ['schemaVersion', 'workflowId', 'workflowVersion', 'executionContract', 'language', 'entrypoint', 'roles']) ||
      index.schemaVersion !== 1 || index.workflowId !== 'coding-loop' || index.workflowVersion !== 2 ||
      index.executionContract !== executionContract || index.language !== 'zh' || index.entrypoint !== entrypoint) {
    throw new Error('coding_workflow_index_unsupported');
  }
  if (!exactKeys(index.roles, [...uses])) throw new Error('coding_workflow_uses_mismatch');
  const roles = new Map<CodingWorkflowUse, string[]>();
  for (const use of uses) {
    const role = index.roles[use];
    if (!exactKeys(role, ['promptPaths']) || !Array.isArray(role.promptPaths) || !role.promptPaths.length || role.promptPaths.length > 8) {
      throw new Error('coding_workflow_use_invalid');
    }
    const paths: unknown[] = role.promptPaths;
    if (new Set(paths).size !== paths.length || !paths.every((p): p is string => typeof p === 'string' && /^zh\/prompts\/(?:[a-zA-Z0-9_-]+\/)*[a-zA-Z0-9_-]+\.md$/.test(p))) {
      throw new Error('coding_workflow_source_path_invalid');
    }
    roles.set(use, paths);
  }
  return roles;
}

async function readSource(root: string, path: string) {
  const raw = await regular(join(root, path), 128 * 1024).catch(() => {
    throw new Error('coding_workflow_source_unavailable');
  });
  let text;
  try {
    text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(raw);
  } catch {
    throw new Error('coding_workflow_source_invalid');
  }
  if (!text.trim() || text.includes('\0')) throw new Error('coding_workflow_source_invalid');
  return { path, sha256: hash(raw), bytes: raw.length, text };
}

/** The packaged source can be inspected without declaring that the runtime supports its controls. */
export async function readCodingWorkflowSource(root = includedSource) {
  const index = await readSource(root, indexPath);
  const roles = parseIndex(index.text);
  const paths = [...new Set([entrypoint, adoption, promptReadme, ...Array.from(roles.values()).flat()])];
  const files = new Map((await Promise.all(paths.map(path => readSource(root, path)))).map(source => [source.path, source]));
  files.set(indexPath, index);
  const ordered = [...files.keys()].sort().map(path => files.get(path)!);
  if (hash(canonical(ordered.map(({path, sha256}) => [path, sha256]))) !== packageSha256) {
    throw new Error('coding_workflow_source_digest_mismatch');
  }
  const identity = { repository, revision, workflowId: 'coding-loop', workflowVersion: 2, executionContract, packageSha256 } as const;
  const reference = ({path, sha256, bytes}: typeof index) => ({path, sha256, bytes});
  return {
    identity,
    entrypoint,
    entrypointSource: files.get(entrypoint)!,
    adoption,
    sources: ordered.map(reference),
    manifest: [...roles].map(([use, promptPaths]) => ({ use, promptPaths: [...promptPaths] })),
    prompt(use: string) {
      const promptPaths = roles.get(use as CodingWorkflowUse);
      if (!promptPaths) throw new Error('coding_workflow_use_invalid');
      const parts = promptPaths.map(path => ({ ...files.get(path)! }));
      const system = parts.map(part => part.text).join('\n\n');
      return { ...identity, use, parts, system, sha256: hash(system) };
    },
  };
}

export type CodingWorkflowPrompt=ReturnType<Awaited<ReturnType<typeof readCodingWorkflowSource>>['prompt']>;

export async function readCodingWorkflowUpstream():Promise<{main:string;firstMerged:boolean}>{
  const root='https://api.github.com/repos/'+repository;
  const read=async(path:string)=>{
    const response=await fetch(root+path,{redirect:'error',signal:AbortSignal.timeout(15000),headers:{Accept:'application/vnd.github+json'}});
    if(!response.ok)throw new Error('coding_workflow_upstream_unavailable');
    return response.json();
  };
  let main:string;
  try{
    const branch=await read('/branches/main');
    main=branch.commit?.sha;
    if(branch.name!=='main'||!/^[a-f0-9]{40}$/.test(main))throw new Error('coding_workflow_upstream_invalid');
    if(main===revision)return {main,firstMerged:true};
    const comparison=await read('/compare/'+revision+'...'+main);
    return {main,firstMerged:comparison.status==='ahead'&&comparison.base_commit?.sha===revision&&comparison.merge_base_commit?.sha===revision};
  }catch(error){
    if(error instanceof Error&&error.message.startsWith('coding_workflow_'))throw error;
    throw new Error('coding_workflow_upstream_unavailable');
  }
}
