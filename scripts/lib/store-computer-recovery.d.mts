// Types for scripts/lib/store-computer-recovery.mjs (the store computer's backup, restore-check and G9 drill), so the
// tests that drive it type-check.
import type { CheckStatus, Deps, Layout, Settings } from './store-computer.mjs';

export declare const SCRATCH_PREFIX: 'sre_restore_check_';
export declare const PLATFORM_PGOPTIONS: string;
export declare const DRILL_READY_WAIT_MS: number;
export declare const RELEASE_INPUTS: readonly string[];
export declare const STEP_TARGETS: Readonly<{ backup: number; restore: number; rollback: number; rollForward: number }>;

export interface Totals {
  readonly rowCounts: Record<string, number>;
  readonly valueTotals: Record<string, number>;
  readonly maxEventSeq: number | null;
  readonly migrations: string[];
  readonly snapshot?: string;
  readonly dumpExit?: number;
  readonly done: boolean;
  readonly other: string[];
}
export interface Ready { readonly L: Layout; readonly settings: Settings; readonly user: string; readonly database: string; readonly env: Record<string, string | undefined> }
export interface DrillStep { readonly key: 'backup' | 'restore' | 'rollback' | 'rollForward'; readonly title: string; readonly ok: boolean; readonly ms: number; readonly targetMs?: number; readonly withinTarget: boolean; readonly detail?: string }

export declare function scratchName(at: Date, taken: readonly string[]): string;
export declare function assertScratch(name: string, settings: Settings | undefined): string;
export declare function totalsScript(): string[];
export declare function backupScript(names: { user: string; database: string }): string;
export declare function parseTotals(text: string): Totals;
export declare function reconcile(expected: Partial<Totals>, got: Partial<Totals>): string[];
export declare function dbExec(program: string, args: readonly string[]): string[];
export declare function hashFile(fs: Deps['fs'], file: string): string;
export declare function takeStoreBackup(deps: Deps, ctx: Ready, dir: string): { ok: boolean; problem?: string; dumpPath?: string; manifestPath?: string; manifest?: Record<string, unknown> };
export declare function backup(deps: Deps, opts: { to?: string }): Promise<number>;
export declare function backupFiles(platform: string, from: string): { manifestPath: string; dumpPath: string } | undefined;
export declare function manifestProblem(m: unknown): string | undefined;
export declare function runRestoreCheck(deps: Deps, ctx: Ready, files: { manifestPath: string; dumpPath: string }): Record<string, unknown> & { outcome: string; differences: string[]; recordPath: string; dropped?: boolean };
export declare function restoreCheck(deps: Deps, opts: { from?: string }): Promise<number>;
export declare function migrationsOf(fs: Deps['fs'], platform: string, folder: string): Record<string, string> | undefined;
export declare function migrationProblems(previous: Record<string, string> | undefined, current: Record<string, string> | undefined): string[];
export declare function releaseId(fs: Deps['fs'], platform: string, folder: string): string;
export declare function drillPlan(deps: Deps, ctx: Ready, opts: { to: string; previous: string }): { problems: string[]; plan: Record<string, unknown> };
export declare function drillVerdict(steps: readonly DrillStep[]): { passed: boolean; line: string };
export declare function drill(deps: Deps, opts: { by?: string; to?: string; previous?: string; run?: boolean; out?: string }): Promise<number>;
export type { CheckStatus };
