// Types for scripts/lib/store-pc-drill.mjs (the rollback drill on the store PC's Windows services — CR-01 step 3e).
import type { Deps } from './store-computer.mjs';

export declare const DRILL_TASK: string;
export declare const DRILL_DIR_PREFIX: 'drill-';
export declare const DRILL_STATE: 'drill.json';
export declare const DRILL_KIND: 'store-computer-rollback-drill';

export declare function installedVersion(deps: Deps, folder: string): string | undefined;
export declare function newestKeptBefore(deps: Deps, current: string): string | undefined;
export declare function nativeDrillPlan(deps: Deps, ctx: unknown, opts: { to: string; previous?: string }): { problems: string[]; plan: Record<string, unknown> };
export declare function nativeDrill(deps: Deps, ctx: unknown, opts: { by?: string; to?: string; previous?: string; run?: boolean; continue?: string }): Promise<number>;
export declare function drillResult(deps: Deps, L: { records: string; dataRoot: string; statusDir: string; runDir: string }): number;
