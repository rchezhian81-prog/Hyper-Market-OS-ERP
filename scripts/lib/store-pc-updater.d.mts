// Types for scripts/lib/store-pc-updater.mjs (the store PC's updater — CR-01 step 3d).
import type { Deps } from './store-computer.mjs';

export declare const UPDATER_TASK: string;
export declare const INSTALL_TASK: string;
export declare const UPDATER_EVERY_MINUTES: number;
export declare const REQUEST_MAX_AGE_MS: number;
export declare const REQUEST_FILE: 'update-request.json';
export declare const REQUEST_KIND: 'sre-store-pc-update-request-v1';
export declare const UPDATES_DIR: 'updates';
export declare const OUTCOME_LOG: 'update-outcomes.log';
export declare const PROGRESS_FILE: 'update-progress.json';
export declare const PROGRESS_KIND: 'sre-store-pc-update-progress-v1';
export declare const UPDATER_MARK: 'updater.json';
export declare const KEPT_FOLDER: string;
export declare const SYSTEM_SID: 'S-1-5-18';
export declare const SPARE_BYTES: number;
export declare const SETUP_WAIT_MS: number;
export declare const TILL_ANSWER_WAIT_MS: number;
export declare const OPEN_SHIFTS_PATH: '/update/open-shifts';

type Layout = { dataRoot: string; statusDir: string; runDir: string };
export declare function updaterPaths(deps: Deps, L: Layout): {
  app: string; keptRoot: string; keptOf(version: string): string; updatesDir: string; outcomeLog: string;
  progressFile: string; markFile: string; lock: string; nodeOf(root: string): string; toolOf(root: string): string;
};
export declare function systemTaskXml(t: { description: string; everyMinutes?: number; start?: string; command: string; args: string; workingDir: string; timeLimit: string }): string;
export declare function registerUpdater(deps: Deps, L: Layout & Record<string, unknown>): boolean;
export declare function checkRequest(r: unknown, runningVersion: string | null | undefined, now: Date): { request: Record<string, string> } | { refuse: string };
export declare function applyUpdate(deps: Deps, opts?: { install?: string }): Promise<number>;
// Shared with the Windows-services rollback drill (CR-01 step 3e, store-pc-drill.mjs).
export declare function mirror(deps: Deps, from: string, to: string): { ok: true } | { ok: false; said: string };
export declare function stopServices(deps: Deps): Promise<void>;
export declare function openShifts(deps: Deps, L: Layout & Record<string, unknown>): Promise<{ open: string[] } | { unknown: true }>;
export declare function theChecks(deps: Deps, L: Layout & Record<string, unknown>, P: ReturnType<typeof updaterPaths>, version: string): Promise<string | undefined>;
