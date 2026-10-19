#!/usr/bin/env node
import { isAbsolute, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { runReception, reconcileReception, supplementReception } from './receiver.js';
import { QueueStore } from './queue-store.js';
export async function receiverMain(args: string[]): Promise<any> {
  const command = args[0], keys = command === 'run' || command === 'supplement' ? ['plan'] : command === 'enable' || command === 'enable-supplements' ? ['store'] : command === 'reconcile' ? ['store', 'operation'] : command === 'close-ended' ? ['store', 'operation', 'source'] : [];
  if (!keys.length || args.length !== 1 + 2 * keys.length) throw new Error('invalid_receiver_command');
  const values: Record<string, string> = {};
  for (let i = 1; i < args.length; i += 2) { const key = args[i]?.slice(2), value = args[i + 1]; if (!args[i]?.startsWith('--') || !key || !keys.includes(key) || !value || value.startsWith('--') || values[key]) throw new Error('invalid_receiver_option'); values[key] = value; }
  for (const key of ['plan', 'store']) if (values[key] && (!isAbsolute(values[key]) || resolve(values[key]) !== values[key])) throw new Error('receiver_path_not_absolute');
  if (command === 'enable' || command === 'enable-supplements') { const q = await QueueStore.open(values.store!); try { return command === 'enable' ? q.enableReceiver() : q.enableSupplements(); } finally { q.close(); } }
  if (command === 'supplement') return supplementReception(values.plan!);
  return command === 'run' ? runReception(values.plan!) : reconcileReception(values.store!, values.operation!, values.source);
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try { const r = await receiverMain(process.argv.slice(2)); process.stdout.write(JSON.stringify(r) + '\n'); process.exitCode = r.blocked || r.status === 'receiver_unknown' ? 2 : 0; }
  catch (e) { process.stderr.write(JSON.stringify({ error: e instanceof Error ? e.message : 'receiver_failed', newTaskResent: false }) + '\n'); process.exitCode = 1; }
}
