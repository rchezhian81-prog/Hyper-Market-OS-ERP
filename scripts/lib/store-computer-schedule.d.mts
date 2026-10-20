// Types for scripts/lib/store-computer-schedule.mjs (the hourly backup and the start at sign-in, as Windows tasks).
import type { Deps, Layout } from './store-computer.mjs';

export declare const TASKS: Readonly<{ backup: string; status: string; start: string }>;
export declare const LAUNCHER: string;
export declare const CURRENT_RELEASE: string;
export declare const LAUNCHER_SOURCE: string;
export declare const EVERY_LIMITS: Readonly<{ min: number; max: number }>;
export declare const DOCKER_WAIT_MS: number;
export declare const TILL_WAIT_MS: number;
export declare function localStamp(d: Date): string;
export declare function taskXml(input: { description: string; userId: string; trigger: { kind: 'logon'; delay: string } | { kind: 'repeat'; everyMinutes: number; start: string }; command: string; args: string; workingDir: string; timeLimit: string }): string;
export declare function windowsUser(env: Record<string, string | undefined>): string | undefined;
export declare function taskAction(deps: Deps, L: Layout, command: string): { command: string; args: string; workingDir: string; problem?: undefined } | { problem: string };
export declare function windowsTasks(deps: Deps, runDir: string): NonNullable<Deps['tasks']>;
export declare function tasksFor(deps: Deps, L: Layout): Deps['tasks'];
export declare function currentRelease(deps: Deps, L: Layout): { folder: string; setAt: string; previous?: string } | undefined;
export declare function writeLauncher(deps: Deps, L: Layout, release?: string, previous?: string): void;
export { driveTally, daysOfRoom } from './store-computer-status.mjs';
export declare function scheduleBackup(deps: Deps, opts: { to?: string; every?: string | number }): Promise<number>;
export declare function unscheduleBackup(deps: Deps): Promise<number>;
export declare function backupStatus(deps: Deps): Promise<number>;
export declare function scheduledBackup(deps: Deps): Promise<number>;
export declare function takeLock(deps: Deps, file: string): boolean;
export declare function autostart(deps: Deps, opts?: { off?: boolean }): Promise<number>;
export declare function startTill(deps: Deps, L: Layout): Promise<{ ok: boolean; detail: string }>;
export declare function startAtSignIn(deps: Deps): Promise<number>;
export declare function runningTill(deps: Deps, L: Layout): { pid: number; startedAt: string; release: string } | undefined;
