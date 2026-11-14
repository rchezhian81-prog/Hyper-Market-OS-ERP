// Types for scripts/lib/store-pc-drill.mjs (the timed rollback drill on Windows services — CR-01 step 3e).
import type { Deps } from './store-computer.mjs';

export declare const DRILL_TASK: string;
export declare const DRILLS_DIR: 'drills';
export declare const DRILL_LOG: 'drill-outcomes.log';
export declare const DRILL_PROGRESS: 'drill-progress.json';
export declare const DRILL_PROGRESS_KIND: 'sre-store-pc-drill-progress-v1';
export declare const DRILL_PLAN_KIND: 'sre-store-pc-drill-plan-v1';
export declare const DRILL_RECORD_KIND: 'store-computer-rollback-drill';
export declare const SETUP_WAIT_MS: number;

export declare function newestEarlierKept(deps: Deps, P: { keptRoot: string; nodeOf(root: string): string; toolOf(root: string): string }, running: string): { folder: string; version: string } | undefined;
export declare function nativeDrillPlan(deps: Deps, ctx: Record<string, unknown>, opts: { to?: string; previous?: string }): {
  problems: string[];
  plan: { app: string; running: string | undefined; previous: { folder: string; version: string } | undefined; to: string | undefined; kept: string | undefined; migrations: { previous: number; current: number } | undefined };
};
export declare function nativeDrill(deps: Deps, opts: { by?: string; to?: string; previous?: string; run?: boolean; legs?: string }): Promise<number>;
