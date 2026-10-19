#!/usr/bin/env node
import { pathToFileURL } from 'node:url';
import { publication } from './publisher.js';
export async function publisherMain(args: string[]) {
  const command = args[0];
  if (!['prepare', 'publish', 'reconcile', 'retry-rejected'].includes(command ?? '') || args[1] !== '--plan' || !args[2] || args.length !== (command === 'retry-rejected' ? 5 : 3) || command === 'retry-rejected' && (args[3] !== '--source' || !args[4])) throw new Error('invalid_publisher_command');
  return publication(args[2], command as 'prepare' | 'publish' | 'reconcile' | 'retry-rejected', args[4]);
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try { const result = await publisherMain(process.argv.slice(2)); process.stdout.write(JSON.stringify(result) + '\n'); process.exitCode = ['prepared_not_sent', 'published_verified'].includes(result.status) ? 0 : 2; }
  catch (e) { process.stderr.write(JSON.stringify({ error: e instanceof Error ? e.message : 'publication_failed', automaticResend: false }) + '\n'); process.exitCode = 1; }
}
