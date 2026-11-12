// Types for scripts/lib/store-computer-services.mjs (the store computer as Windows services — ADR-0032, CR-01 step 1).
import type { Deps, Settings } from './store-computer.mjs';

export declare const SERVICES: Readonly<{ database: 'SRE-Database'; api: 'SRE-API'; till: 'SRE-Till' }>;
export declare const SERVICE_ORDER: readonly string[];
export declare const DISPLAY: Readonly<Record<string, string>>;
export declare const DESCRIPTION: Readonly<Record<string, string>>;
export declare const SERVICES_DIR: string;
export declare const SERVICE_LAUNCHER: string;
export declare const DATABASE_DIR: string;
export declare const LOGS_DIR: string;
export declare const DB_CONF: string;
export declare const DB_CONF_INCLUDE: string;
export declare const START_WAIT_MS: number;
export declare const API_READY_WAIT_MS: number;
export declare const PG_PROGRAMS: readonly string[];
export declare const API_KEYS: readonly string[];
export declare const OWN_SERVICE_SIDS: Readonly<Record<string, string>>;
export declare function serviceSid(name: string): string;
export declare function accountOf(name: string): string;

export interface ServicePaths {
  readonly platform: string; readonly repoRoot: string; readonly dataRoot: string; readonly settings: string; readonly tillDir: string;
  readonly tillEnv: string; readonly statusDir: string; readonly scratchDir: string; readonly databaseDir: string; readonly dbConf: string;
  readonly logsDir: string; logDirOf(name: string): string; readonly servicesDir: string; hostExeOf(name: string): string;
  hostXmlOf(name: string): string; readonly launcher: string; readonly apiBundle: string; readonly edgeBundle: string;
  readonly buildScript: string; readonly pgBin?: string; pgProgram(exe: string): string; readonly serviceHost?: string; readonly nodePath: string;
}
export declare function servicePaths(input: { platform: string; repoRoot: string; dataRoot: string; pgBin?: string; serviceHost?: string; nodePath: string }): ServicePaths;
export declare function hostXml(P: ServicePaths, name: string): string;
export declare function dbConfText(port: string | number): string;
export declare function databaseSettings(settings: Settings): { db: string; admin: string; app: string; password: string; port: string; problems: string[] };
export declare function databaseSetupSql(input: { db: string; app: string; password: string }): string;
export declare function grantsFor(P: ServicePaths, exists: (p: string) => boolean): { target: string; name: string; args: string[] }[];
export declare function hostDatabaseUrl(url: string, port: string | undefined): string;
export declare function serviceEnv(kind: 'api' | 'till', settings: Settings, base: Record<string, string | undefined>, repoRoot: string, platform?: string): Record<string, string | undefined>;
export declare function serviceState(deps: Deps, name: string): 'missing' | 'running' | 'stopped' | 'starting' | 'stopping' | 'other';
export declare function serviceConfig(deps: Deps, name: string): { auto: boolean; account?: string; dependsOn: string };
export declare function preflight(deps: Deps, P: ServicePaths, settings: Settings): string[];
export declare function installServices(deps: Deps, opts: { pgBin?: string; serviceHost?: string; afterDatabase?: (native: { pgBin: string; port: string }) => Promise<number> }): Promise<number>;
export declare function servicesStatus(deps: Deps): Promise<number>;
export declare function removeServices(deps: Deps): Promise<number>;
