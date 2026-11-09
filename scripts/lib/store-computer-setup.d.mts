// Types for scripts/lib/store-computer-setup.mjs (the store computer's first run — CR-01 step 2).
import type { Deps } from './store-computer.mjs';

export declare const RELEASE_MARKER: 'release.json';
export declare const SETUP_LOG: 'setup.log';
export declare function bundledRuntime(deps: Deps): { pgBin?: string; serviceHost?: string };
export declare function releaseInfo(deps: Deps): { version?: string; commit?: string; builtAt?: string } | undefined;
export declare function firstRun(deps: Deps, opts?: { dataDrive?: string; lane?: string; pgBin?: string; serviceHost?: string }): Promise<number>;
export declare function systemDriveLetter(deps: Pick<Deps, 'env'>): string;
export declare function newDataDriveRefusal(deps: Pick<Deps, 'env'>, dataDrive: string | undefined): string | undefined;
export declare function driveChoices(deps: Deps): { letter: string; ok: boolean; why?: string; note?: string }[];
