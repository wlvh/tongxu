export type Sample = { id: string; status: 'ok' | 'fail'; content: unknown; identity: unknown; source: string; sideEffects: unknown };
export type SampleSet = { complete: boolean; samples: Sample[]; gaps: string[] };
export type Comparison = { id: string; result: 'SAME_OK' | 'CHANGED_OK' | 'FAIL_TO_OK' | 'OK_TO_FAIL' | 'SAME_FAIL' | 'CHANGED_FAIL' | 'NOT_COMPARED' };
export function canonical(value: unknown): string {
  if (Array.isArray(value)) return '[' + value.map(canonical).join(',') + ']';
  if (value && typeof value === 'object') return '{' + Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([k, v]) => JSON.stringify(k) + ':' + canonical(v)).join(',') + '}';
  return JSON.stringify(value) ?? 'null';
}
export function samples(value: unknown, expected: string[], executionValid: boolean): SampleSet {
  const gaps: string[] = [];
  const found: Sample[] = [];
  if (!expected.length || new Set(expected).size !== expected.length) gaps.push('invalid_expected_samples');
  if (!executionValid) gaps.push('execution_or_input_invalid');
  if (!value || typeof value !== 'object' || !Array.isArray((value as any).samples)) return { complete: false, samples: [], gaps: [...gaps, 'missing_samples'] };
  const seen = new Set<string>();
  for (const row of (value as any).samples) {
    if (!row || typeof row.id !== 'string' || !row.id || !['ok', 'fail'].includes(row.status) || typeof row.source !== 'string' || !row.source || !('content' in row) || !('identity' in row) || row.identity === null || !('sideEffects' in row)) { gaps.push('invalid_sample_or_source'); continue; }
    if (seen.has(row.id)) { gaps.push('duplicate_sample'); continue; }
    seen.add(row.id); found.push({ id: row.id, status: row.status, content: row.content, identity: row.identity, source: row.source, sideEffects: row.sideEffects });
  }
  if (expected.some(id => !seen.has(id)) || [...seen].some(id => !expected.includes(id))) gaps.push('sample_coverage_mismatch');
  return { complete: gaps.length === 0, samples: found, gaps: [...new Set(gaps)] };
}
export function compare(before: SampleSet | undefined, after: SampleSet | undefined, expected: string[]): Comparison[] {
  return expected.map(id => {
    const a = before?.samples.find(s => s.id === id), b = after?.samples.find(s => s.id === id);
    if (!before?.complete || !after?.complete || !a || !b) return { id, result: 'NOT_COMPARED' };
    if (a.status !== b.status) return { id, result: a.status === 'fail' ? 'FAIL_TO_OK' : 'OK_TO_FAIL' };
    return { id, result: `${canonical(a) === canonical(b) ? 'SAME' : 'CHANGED'}_${a.status === 'ok' ? 'OK' : 'FAIL'}` as Comparison['result'] };
  });
}
