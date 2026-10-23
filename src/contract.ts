export type Coverage = {
  state: 'complete' | 'partial' | 'unavailable' | 'not_requested';
  pages: number; records: number; ids: string[]; nextPage: number | null;
  termination: string; errors: string[];
};
export type Candidate = {
  repository: string; pr: number; H: string; B: string; targetRef: string;
  mergeBase: string | null; observedAt: string;
};
export type Artifact = {
  path: string; sha256: string; bytes: number; kind: string; round: number;
  retrievedAt: string; endpoint?: string; page?: number; provenance: string;
  headers?: Record<string, string>; status?: number;
};
export type Source = {
  id: string; bodyHash: string; body: string; url: string | null;
  account: string | null; createdAt: string | null; updatedAt: string | null;
  replyTo: string | number | null; artifact: string;
};
export type ContextNote = {
  sourceId: string; sourceBodyHash: string; locator: string;
  kind: 'owner_adoption_report' | 'team_agreement' | 'delegated_action' | 'proposal' | 'fact' | 'unknown';
  scope: string; note: string; version?: string | null;
  role?: { account: string; claimedRole: string; taskOwner: string; executor: string };
  relation?: { type: 'development' | 'merge' | 'enablement' | 'parent'; object: string; version: string; blocks: string; canContinue: string };
  action?: { step: string; exitCondition: string };
};
export type Round = {
  number: number; startedAt: string; finishedAt?: string;
  coverage: Record<string, Coverage>; sources: Source[];
  notes: (ContextNote & { binding: 'verified' | 'stale' | 'unverified' })[];
  gaps: string[]; limitations: string[]; current: boolean;
  targetObservation?: { ref: string; reportedBase: string; reportedBaseAtEnd?: string; initial?: { sha: string; artifact: string; observedAt: string }; final?: { sha: string; artifact: string; observedAt: string } };
};
export type Manifest = {
  schemaVersion: 1; repository: string; pr: number; issues: number[];
  candidate: Candidate | null; artifacts: Artifact[]; rounds: Round[];
  context: ContextNote[]; gitFiles: string[]; gitCommits: string[];
  gitComplete: boolean; createdAt: string;
};
export type Response = { status: number; body: string; headers: Record<string, string>; provenance: string };
export interface Transport { get(endpoint: string): Promise<Response> }
export type GitResult = { mergeBase: string; patch: Buffer; files: string[]; commits: string[] };
export type GitReader = (candidate: Candidate, cache: string) => Promise<GitResult>;
export const repoPattern = /^[A-Za-z0-9][A-Za-z0-9_.-]*\/[A-Za-z0-9][A-Za-z0-9_.-]*$/;
export const shaPattern = /^[0-9a-f]{40}$/;
export const validBranchRef = (s: unknown): s is string => typeof s === 'string' && s.length > 0 && s.length <= 1024 && s !== '@' && !/[\x00-\x20\x7f~^:?*\[\\]/.test(s) && !s.includes('..') && !s.includes('@{') && !s.endsWith('.') && s.split('/').every(p => p.length > 0 && !p.startsWith('.') && !p.endsWith('.lock'));
export const now = () => new Date().toISOString();
export const emptyCoverage = (): Coverage => ({ state: 'unavailable', pages: 0, records: 0, ids: [], nextPage: 1, termination: 'not_started', errors: [] });
