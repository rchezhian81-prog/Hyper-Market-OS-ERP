// Types for scripts/lib/store-computer-status.mjs (the store computer's own red light, audit row 6).
import type { Deps, Layout } from './store-computer.mjs';

export interface Alert { readonly code: string; readonly en: string; readonly ta: string }
export interface Check { readonly name: string; readonly ok: boolean; readonly detail: string; readonly alert?: Alert; readonly alerts?: Alert[] }
export interface StatusFile {
  readonly kind: 'sre-store-computer-status'; readonly version: 1; readonly checkedAt: string; readonly staleAfterMinutes: number;
  readonly overall: 'ok' | 'red'; readonly alerts: Alert[]; readonly checks: { name: string; ok: boolean; detail: string }[];
}
export declare const ALERT_RULES: Readonly<{ backupMaxAgeMinutes: number; unsentStuckMinutes: number; diskMaxUsedFraction: number; statusStaleMinutes: number; checkEveryMinutes: number }>;
export declare const STATUS_KIND: 'sre-store-computer-status';
export declare const SCHEDULE_FILE: string;
export declare function ageWords(totalMinutes: number): { en: string; ta: string };
export declare function readSchedule(deps: Deps, L: Layout): { to: string; everyMinutes: number; setAt: string } | undefined;
export declare function backupCheck(deps: Deps, L: Layout, nowMs: number): Check;
export declare function tillCheck(deps: Deps, L: Layout, nowMs: number): Promise<Check>;
export declare function diskCheck(deps: Deps, L: Layout): Check;
export declare function containersCheck(deps: Deps): Check;
export declare function collectStatus(deps: Deps): Promise<StatusFile>;
export declare function writeStatusFile(deps: Deps, L: Layout, status: StatusFile): string | undefined;
export declare function status(deps: Deps, opts?: { quiet?: boolean }): Promise<number>;
