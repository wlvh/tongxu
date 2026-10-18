import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import type { Candidate, GitResult } from './contract.js';
import { repoPattern, shaPattern } from './contract.js';
const exec = promisify(execFile);
const gitEnvironment = () => ({ ...Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('GIT_'))), GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null', GIT_TERMINAL_PROMPT: '0' });
const git = async (directory: string, ...args: string[]) => (await exec('git', ['-c', 'core.hooksPath=/dev/null', '-c', 'protocol.file.allow=never', '-C', directory, ...args], { env: gitEnvironment(), timeout: 60_000, maxBuffer: 64 * 1024 * 1024, encoding: 'buffer' })).stdout;

export async function readGit(candidate: Candidate, cache: string): Promise<GitResult> {
  if (!repoPattern.test(candidate.repository) || !shaPattern.test(candidate.H) || !shaPattern.test(candidate.B)) throw new Error('invalid_git_candidate');
  // Bare, fresh, caller-owned cache: no target checkout, hooks, index or target command execution.
  await exec('git', ['init', '--bare', '--template=', cache], { env: gitEnvironment(), timeout: 10_000 });
  await git(cache, 'fetch', '--no-tags', '--depth=128', `https://github.com/${candidate.repository}.git`, candidate.B, candidate.H);
  return readFixedObjects(candidate, cache);
}
export async function readFixedObjects(candidate: Candidate, cache: string): Promise<GitResult> {
  if (!shaPattern.test(candidate.H) || !shaPattern.test(candidate.B)) throw new Error('invalid_git_candidate');
  const run = (...args: string[]) => git(cache, ...args);
  for (const sha of [candidate.B, candidate.H]) {
    if ((await run('rev-parse', '--verify', `${sha}^{commit}`)).toString().trim() !== sha) throw new Error('git_object_mismatch');
  }
  const mergeBase = (await run('merge-base', candidate.B, candidate.H)).toString().trim();
  if (!shaPattern.test(mergeBase)) throw new Error('merge_base_unavailable');
  const patch = await run('diff', '--no-ext-diff', '--no-textconv', '--binary', mergeBase, candidate.H, '--');
  const files = (await run('diff', '--no-ext-diff', '--no-textconv', '--name-only', '-z', mergeBase, candidate.H, '--')).toString().split('\0').filter(Boolean);
  const commits = (await run('rev-list', `${candidate.B}..${candidate.H}`)).toString().trim().split('\n').filter(Boolean);
  return { mergeBase, patch, files, commits };
}
