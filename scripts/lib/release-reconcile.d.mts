// Types for scripts/lib/release-reconcile.mjs (QG-10 · WF-20 post-deploy reconcile), so the tests that drive it type-check.

export interface LedgerFacts {
  readonly count: number;
  readonly maxSeq: number;
  readonly digest: string;
  readonly byFamily: Readonly<Record<string, number>>;
}

export interface Snapshot {
  readonly version: 1;
  readonly at: string;
  readonly ledger: LedgerFacts;
  readonly outbox: { readonly pending: number; readonly deadLetter: number; readonly oldestPendingSeconds: number | null };
  readonly upTo?: { readonly seq: number; readonly count: number; readonly digest: string; readonly byFamily: Readonly<Record<string, number>> };
}

export declare function snapshotProblem(s: unknown): string | undefined;
export declare function parseSnapshot(text: string): Snapshot | undefined;
export declare function compareSnapshots(
  before: unknown, after: unknown, policy?: { readonly maxBacklogGrowth?: number; readonly maxDeadLetterGrowth?: number },
): { readonly ok: boolean; readonly differences: readonly string[] };

export interface Qg10Record {
  readonly gate: 'QG-10';
  readonly passCondition: string;
  readonly release: string;
  readonly previous: string;
  readonly at: string;
  readonly by: string;
  readonly run: string;
  readonly box: string;
  readonly outcome: string;
  readonly checks: Readonly<Record<'health' | 'smoke' | 'reconciliation' | 'monitoring' | 'rollback', string>>;
  readonly verified: boolean;
  readonly notVerified: readonly string[];
  readonly differences: readonly string[];
  readonly decision: string;
}

export declare function qg10Record(input: {
  readonly sha: string; readonly previous: string; readonly at: string; readonly by: string; readonly run: string; readonly box: string;
  readonly outcome: string; readonly checks: Readonly<Record<string, string>>; readonly differences?: readonly string[];
}): Qg10Record;
