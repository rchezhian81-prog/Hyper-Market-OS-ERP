// Types for scripts/lib/store-computer-db.mjs (how the tool reaches this copy's database — CR-01 step 2c, ADR-0032).
import type { Deps, Layout, SpawnResult } from './store-computer.mjs';

export declare const SERVICES_MARKER: 'database.json';
export declare const ALL_TENANTS_PGOPTIONS: string;
export declare function servicesMarkerPath(platform: string, dataRoot: string): string;
export declare function readServicesMarker(deps: Deps, L: Partial<Layout> | undefined): { pgBin: string; port: string } | undefined;
export declare function writeServicesMarker(deps: Deps, dataRoot: string, marker: { pgBin: string; port: string }): void;
export declare function databaseProblem(deps: Deps, L: Partial<Layout> | undefined): { what: string; fix: string } | undefined;
export interface DbCtx { readonly L: Layout; readonly settings: Record<string, string>; readonly env: Record<string, string | undefined>; readonly native?: { pgBin: string; port: string } }
export declare function dbCommand(deps: Deps, ctx: DbCtx, program: string, args: readonly string[]): { cmd: string; args: string[]; opts: { cwd?: string; env: Record<string, string | undefined> } };
export declare function dbSpawn(deps: Deps, ctx: DbCtx, program: string, args: readonly string[], extra?: Record<string, unknown>): SpawnResult;
export declare function nativeBackupScript(input: { user: string; database: string; pgDump: string; totalsFile: string; port: string | number }): string;
export declare function otherLines(text: string): string[];
