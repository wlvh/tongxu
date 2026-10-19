#!/usr/bin/env node
import { pathToFileURL } from 'node:url';
import { runPairedReception } from './paired-reception.js';
export async function pairMain(args: string[]) {
  if (args.length !== 3 || args[0] !== 'run' || args[1] !== '--plan' || !args[2]) throw new Error('invalid_pair_command');
  return runPairedReception(args[2]);
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try { process.stdout.write(JSON.stringify(await pairMain(process.argv.slice(2))) + '\n'); }
  catch (e) { process.stderr.write(JSON.stringify({ error: e instanceof Error ? e.message : 'paired_reception_failed', automaticResend: false }) + '\n'); process.exitCode = 1; }
}
