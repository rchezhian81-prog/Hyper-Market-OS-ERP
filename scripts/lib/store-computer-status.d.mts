// Types for scripts/lib/store-computer-status.mjs (the store computer's own red light, audit row 6).
import type { Deps, Layout } from './store-computer.mjs';

export interface Alert { readonly code: string; readonly en: string; readonly ta: string }
/** `ok: null` — the check cannot say yet ("not known", OB-268): neither OK nor red. */
export interface Check { readonly name: string; readonly ok: boolean | null; readonly detail: string; readonly alert?: Alert; readonly alerts?: Alert[] }
export interface StatusFile {
  readonly kind: 'sre-store-computer-status'; readonly version: 1; readonly checkedAt: string; readonly staleAfterMinutes: number;
  readonly overall: 'ok' | 'red'; readonly alerts: Alert[]; readonly checks: { name: string; ok: boolean | null; detail: string }[];
}
export declare const ALERT_RULES: Readonly<{ backupMaxAgeMinutes: number; unsentStuckMinutes: number; diskMaxUsedFraction: number; statusStaleMinutes: number; checkEveryMinutes: number; backupDriveMinDays: number }>;
export declare const STATUS_KIND: 'sre-store-computer-status';
export declare const SCHEDULE_FILE: string;
export declare function ageWords(totalMinutes: number): { en: string; ta: string };
export declare function readSchedule(deps: Deps, L: Layout): { to: string; everyMinutes: number; setAt: string } | undefined;
export interface DriveTally { readable: boolean; backups?: number; bytes?: number; free?: number; total?: number }
export declare function driveTally(deps: Deps, dir: string): DriveTally;
export declare function daysOfRoom(tally: DriveTally, everyMinutes: number): number | undefined;
export type BackupRoom =
  | { readonly known: true; readonly tally: DriveTally; readonly perDay: number; readonly days: number }
  | { readonly known: false; readonly tally?: DriveTally; readonly why: { readonly en: string; readonly ta: string } };
export declare function backupRoom(deps: Deps, L: Layout, schedule?: { to: string; everyMinutes: number }): BackupRoom;
export declare function backupDriveCheck(deps: Deps, L: Layout): Check;
export declare function mirrorCheck(deps: Deps, L: Layout): Check;
export declare function backupCheck(deps: Deps, L: Layout, nowMs: number): Check;
export declare function tillCheck(deps: Deps, L: Layout, nowMs: number): Promise<Check>;
export declare function diskCheck(deps: Deps, L: Layout): Check;
export declare function containersCheck(deps: Deps): Check;
export declare function collectStatus(deps: Deps): Promise<StatusFile>;
export declare function writeStatusFile(deps: Deps, L: Layout, status: StatusFile): string | undefined;
export declare function status(deps: Deps, opts?: { quiet?: boolean }): Promise<number>;
