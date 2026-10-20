import test from 'node:test';
import assert from 'node:assert/strict';
import { dynamicToolStart } from '../../src/repair-native.js';

function pair(id: string) {
  const request = { id: 0, method: 'item/tool/call', params: { threadId: 'fixed-thread', turnId: 'fixed-turn', callId: id, namespace: null, tool: 'tongxu_read_file', arguments: { path: 'src/file.ts' } } };
  const started = { method: 'item/started', params: { threadId: 'fixed-thread', turnId: 'fixed-turn', item: { type: 'dynamicToolCall', id, namespace: null, tool: 'tongxu_read_file', arguments: { path: 'src/file.ts' }, status: 'inProgress' } } };
  return { request, started };
}
test('the documented dynamic tool start binds both direct and helper-routed requests without treating opaque call IDs as authority', () => {
  for (const id of ['call_direct_model', 'exec-helper-observation', 'opaque-supported-id']) {
    const { request, started } = pair(id); assert.deepEqual(dynamicToolStart([started, request], request), started);
  }
});
test('a missing, ambiguous or mismatched native start cannot authorize a tool even when a helper may exist', () => {
  const { request, started } = pair('fixed-call');
  for (const events of [[], [request], [started, structuredClone(started)]]) assert.throws(() => dynamicToolStart(events, request), /native_dynamic_tool_start_missing_or_mismatched/);
  for (const [field, value] of [['type', 'commandExecution'], ['status', 'completed'], ['id', 'other-call'], ['namespace', 'other'], ['tool', 'tongxu_replace_file'], ['arguments', { path: 'outside.ts' }]] as const) {
    const wrong: any = structuredClone(started); wrong.params.item[field] = value;
    assert.throws(() => dynamicToolStart([wrong], request), /native_dynamic_tool_start_missing_or_mismatched/);
  }
  for (const key of ['threadId', 'turnId']) {
    const wrong: any = structuredClone(started); wrong.params[key] = 'other';
    assert.throws(() => dynamicToolStart([wrong], request), /native_dynamic_tool_start_missing_or_mismatched/);
  }
});
