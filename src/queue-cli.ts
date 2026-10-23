import { isAbsolute, resolve } from 'node:path';
import { QueueStore } from './queue-store.js';
import { readPacket } from './queue-evidence.js';

const fields: Record<string, { required: string[]; optional?: string[] }> = {
  init: { required: ['store', 'repo'], optional: ['seats'] },
  add: { required: ['store', 'snapshot', 'verification', 'context'] },
  status: { required: ['store'] },
  control: { required: ['store', 'scope', 'kind', 'state', 'source'] },
  begin: { required: ['store', 'item', 'run'] },
  evaluate: { required: ['store', 'operation'] },
};
export function parseQueueArgs(args: string[]): { command: string; values: Record<string, string> } {
  const command = args[0] ?? '', spec = fields[command];
  if (!spec) throw new Error('invalid_queue_command');
  const values: Record<string, string> = {};
  for (let i = 1; i < args.length; i += 2) {
    const flag = args[i], value = args[i + 1], key = flag?.slice(2);
    if (!flag?.startsWith('--') || !key || ![...spec.required, ...(spec.optional ?? [])].includes(key) || !value || value.startsWith('--') || values[key] !== undefined) throw new Error('invalid_queue_option');
    values[key] = value;
  }
  if (spec.required.some(k => !values[k])) throw new Error('missing_queue_option');
  for (const key of ['store', 'snapshot', 'verification', 'context']) if (values[key] && (!isAbsolute(values[key]) || resolve(values[key]) !== values[key])) throw new Error('queue_path_must_be_absolute');
  if (values.item && !/^[0-9a-f]{64}$/.test(values.item)) throw new Error('invalid_item_id');
  if (values.operation && !/^[0-9a-f-]{36}$/.test(values.operation)) throw new Error('invalid_operation_id');
  if (values.seats && !/^[1-8]$/.test(values.seats)) throw new Error('invalid_reception_seats');
  return { command, values };
}
export async function queueMain(args: string[]): Promise<{ exit: number; result: Record<string, unknown> }> {
  const { command, values: v } = parseQueueArgs(args);
  const q = command === 'init' ? await QueueStore.create(v.store!, v.repo!, Number(v.seats ?? 2)) : await QueueStore.open(v.store!);
  try {
    let result: Record<string, any>;
    if (command === 'init') result = { mode: 'shadow', repository: v.repo, created: true, productionActionAllowed: false };
    else if (command === 'add') result = q.import(await readPacket(v.snapshot!, v.verification!, v.context!));
    else if (command === 'status') result = q.status();
    else if (command === 'control') result = q.control(v.scope!, v.kind!, v.state!, v.source!);
    else if (command === 'begin') result = q.begin(v.item!, v.run!);
    else result = q.evaluate(v.operation!);
    return { exit: result.blocked ? 2 : 0, result };
  } finally { q.close(); }
}
