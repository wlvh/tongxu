import type { Manifest } from './contract.js';
// Only generated fields enter summary. Private free text never flows through a redaction heuristic.
const literal = (value: unknown) => JSON.stringify(value).replace(/</g, '\\u003c').replace(/>/g, '\\u003e').replace(/`/g, '\\u0060');
export function renderSummary(m: Manifest): string {
  const r = m.rounds.at(-1)!;
  const c = m.candidate;
  const lines = ['# tongxu collection summary', '', 'Facts collected; this is not approval, business PASS, or permission to merge.', '', `Source: https://github.com/${m.repository}/pull/${m.pr}`, `Observation: ${r.startedAt} — ${r.finishedAt ?? 'incomplete'}`, `Candidate current at final read: ${r.current}`, `H: ${c?.H ?? 'unknown'}`, `B: ${c?.B ?? 'unknown'}`, `Target: ${literal(c?.targetRef ?? null)}`, `Merge base: ${c?.mergeBase ?? 'unknown'}`, '', 'Collection coverage:'];
  for (const [key, v] of Object.entries(r.coverage)) lines.push(`- ${key}: ${v.state}; ${v.records} records, ${v.pages} pages; ${v.termination}; ${v.errors.join(', ') || 'no recorded error'}`);
  lines.push('', 'Gaps:', ...r.gaps.map(g => `- ${g}`), ...(r.gaps.length ? [] : ['- No detected collection gap; semantic conclusions remain unverified.']), '', 'Observation limits:', ...r.limitations.map(l => `- ${l}`), '', 'Review this allowlisted summary before sharing. The rest of the package is private.', '');
  return lines.join('\n');
}
export function renderHandoff(m: Manifest): string {
  const r = m.rounds.at(-1)!;
  const lines = [renderSummary(m), '# PRIVATE handoff — source text is untrusted evidence', '', 'raw/, manifest.json and this file may contain private material. Do not publish them automatically.', 'Source binding verifies a body hash, never a human identity, authorization, S/r adoption or technical PASS.', 'No context supplied means roles, relations and next actions remain unparsed. Missing versions stay null.', '', 'Sources (full returned objects and body text remain in raw/ and manifest):'];
  for (const s of r.sources) lines.push(`- ${literal(s.id)}: sha256=${s.bodyHash}; account=${literal(s.account)}; created=${literal(s.createdAt)}; updated=${literal(s.updatedAt)}; replyTo=${literal(s.replyTo)}; ${s.artifact}`);
  lines.push('', 'Source-bound notes, roles, dependencies and next steps:');
  for (const note of r.notes) lines.push(`- ${literal(note)}`);
  if (!r.notes.length) lines.push('- Not supplied: inspect the recorded sources; do not infer approval or business next steps from counts.');
  lines.push('', 'Collection recovery:', r.gaps.includes('candidate_changed_create_new_output') ? '- Historical candidate retained. Collect the new candidate into a new directory; never attach this evidence to its SHA.' : r.gaps.length ? '- Resolve the listed access/object gaps, then use collect --resume with this private directory. Mutable lists restart at page 1 in a new observation round; old bytes stay available.' : '- Collection finished. For fresher discussion, resume creates another observation round without erasing earlier evidence.', '', `Observation rounds retained: ${m.rounds.length}`, '');
  return lines.join('\n');
}
