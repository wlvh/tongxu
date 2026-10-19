#!/usr/bin/env node
import { isAbsolute, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { readFile } from 'node:fs/promises';
import { reconcileDocker, parseDockerConfig } from './docker-sandbox.js';

export async function dockerRecoveryMain(args: string[]): Promise<number> {
  const [action, flag, directory, configFlag, configPath] = args;
  if (args.length !== 5 || !['inspect', 'stop'].includes(action ?? '') || flag !== '--execution' || configFlag !== '--config' || !directory || !isAbsolute(directory) || resolve(directory) !== directory || !configPath || !isAbsolute(configPath) || resolve(configPath) !== configPath) throw new Error('invalid_docker_recovery_arguments');
  const result = await reconcileDocker(directory, action as 'inspect' | 'stop', parseDockerConfig(JSON.parse(await readFile(configPath, 'utf8'))));
  process.stdout.write(JSON.stringify(result, null, 2) + '\n');
  return ['ended', 'not_started', 'original_completed_record', 'ended_from_original_recovery'].includes(result.outcome) && result.cleanup !== 'unknown' ? 0 : 2;
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  dockerRecoveryMain(process.argv.slice(2)).then(code => { process.exitCode = code; }, e => { process.stderr.write(`tongxu: ${e instanceof Error && /^[a-z0-9_]+$/.test(e.message) ? e.message : 'docker_recovery_failed'}\n`); process.exitCode = 1; });
}
