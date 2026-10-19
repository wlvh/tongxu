#!/usr/bin/env node
import { pathToFileURL } from 'node:url';
import { runSecretary } from './secretary.js';
export async function secretaryMain(args: string[]) {
  if (args.length !== 5 || args[0] !== 'run' || args[1] !== '--plan' || args[3] !== '--output' || !args[2] || !args[4]) throw new Error('invalid_secretary_command');
  return runSecretary(args[2], args[4]);
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try { process.stdout.write(JSON.stringify(await secretaryMain(process.argv.slice(2))) + '\n'); }
  catch (e) { process.stderr.write(JSON.stringify({ error: e instanceof Error ? e.message : 'secretary_failed', automaticResend: false }) + '\n'); process.exitCode = 1; }
}
