// Types for scripts/lib/rollback-drill.mjs (the timed G9 rollback drill), so the tests that drive it type-check.

export declare const DRILL_TARGETS: Readonly<{ rollbackMs: number; rollForwardMs: number; recoveryMs: number }>;

export interface DrillInput {
  readonly previous: string | undefined;
  readonly current: string | undefined;
  readonly targetKind: string | undefined;
  readonly project: string | undefined;
}

export interface DrillSteps {
  recovery(): Promise<{ readonly outcome: string; readonly backupId?: string; readonly timingsMs?: Record<string, number>; readonly detail?: string }>;
  deploy(sha: string): Promise<{ readonly ok: boolean; readonly code?: number | null; readonly detail?: string }>;
  ready(): Promise<boolean>;
}

export interface DrillRecord {
  readonly drillId: string;
  readonly startedAt: string;
  readonly finishedAt?: string;
  readonly outcome: 'passed' | 'failed' | 'over_target' | 'refused';
  readonly detail: string;
  readonly steps: readonly { readonly name: string; readonly ok: boolean; readonly ms: number; readonly detail?: string }[];
  readonly timingsMs: { readonly recovery?: number; readonly rollback?: number; readonly rollForward?: number; readonly total?: number; readonly recoveryParts?: Record<string, number> };
  readonly withinTargets?: boolean;
}

export declare function drillProblems(input: DrillInput): string[];

export declare function runRollbackDrill(input: DrillInput & {
  readonly steps: DrillSteps;
  readonly now?: () => number;
  readonly log?: (line: string) => void;
  readonly workDir?: string;
  readonly drillId?: string;
}): Promise<DrillRecord>;
