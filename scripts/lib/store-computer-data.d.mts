// Types for scripts/lib/store-computer-data.mjs (the shop's data outside the release folder; the update, audit row 9).
import type { Deps } from './store-computer.mjs';

export declare function rewriteTillEnv(text: string, at: { edgeData: string; witness: string; statusFile: string }): string;
export declare function migrateDataFolder(deps: Deps): Promise<number>;
export declare function releaseProblems(deps: Deps, folder: string): string[];
export declare function update(deps: Deps, opts: { from?: string; to?: string }): Promise<number>;
