// Types for scripts/lib/store-computer.mjs (the owner's guided store-computer setup), so the tests that drive it type-check.

export declare const PROJECT: 'sre-real';
export declare const DEMO_PROJECT: 'sre-pilot';
export declare const DEMO_TENANT: 'pilot-demo';
export declare const SETTINGS_NAME: '.env.real';
export declare const OTHER_SETTINGS_NAMES: readonly string[];
export declare const SECRET_KEYS: readonly string[];
export declare const OWN_KEYS: readonly string[];
export declare const SEEDING_KEYS: readonly string[];
export declare const THRESHOLDS: Readonly<{ ramBytes: number; diskBytes: number; minNodeMajor: number; minWindowsBuild: number; timeZones: readonly string[] }>;
export declare const READY_WAIT_MS: number;
export declare const COMPOSE_BASE: readonly string[];
export declare const CHECK_TITLES: readonly string[];
export declare const USAGE: readonly string[];

export type Settings = Record<string, string>;

export interface SpawnResult {
  readonly status: number | null;
  readonly stdout?: string;
  readonly stderr?: string;
  readonly error?: Error & { code?: string };
}

export interface FsLike {
  existsSync(p: string): boolean;
  readFileSync(p: string, enc: 'utf8'): string;
  readFileSync(p: string): Buffer;
  writeFileSync(p: string, data: string, opts?: unknown): void;
  mkdirSync(p: string, opts?: unknown): unknown;
  mkdtempSync(prefix: string): string;
  rmSync(p: string, opts?: unknown): void;
  openSync(p: string, flags: string, mode?: number): number;
  closeSync(fd: number): void;
  readSync(fd: number, buf: Buffer, offset: number, length: number, position: number | null): number;
  fsyncSync(fd: number): void;
  chmodSync(p: string, mode: number): void;
  statSync(p: string): { size: number; isDirectory(): boolean };
  readdirSync(p: string): string[];
}

export interface Deps {
  readonly repoRoot: string;
  readonly platform: string;
  readonly env: Record<string, string | undefined>;
  readonly fs: FsLike;
  readonly spawn: (cmd: string, args: readonly string[], opts: { cwd?: string; env?: Record<string, string | undefined>; stdio?: unknown; input?: string }) => SpawnResult;
  readonly fetch: (url: string) => Promise<{ ok: boolean; json(): Promise<unknown> }>;
  readonly portInUse: (port: number) => Promise<boolean>;
  readonly sleep: (ms: number) => Promise<void>;
  readonly now: () => Date;
  readonly random: (n: number) => Buffer;
  readonly uuid: () => string;
  readonly os: { totalmem(): number; release(): string; version(): string };
  readonly freeDiskBytes: (dir: string) => number;
  readonly timeZone: () => string;
  readonly nodeVersion: string;
  readonly nodePath: string;
  readonly tmpdir: () => string;
  readonly say: (line: string) => void;
}

export interface Layout {
  readonly composeDir: string;
  readonly settings: string;
  readonly example: string;
  readonly others: readonly { readonly name: string; readonly path: string }[];
  readonly records: string;
  readonly tillEnv: string;
  readonly sliceScript: string;
  readonly buildScript: string;
}

export type CheckStatus = 'PASS' | 'FAIL' | 'NEEDS-YOU';
export interface CheckResult { readonly n: number; readonly title: string; readonly status: CheckStatus; readonly detail: string }
export interface CheckOptions { readonly by?: string; readonly out?: string; readonly backupRecord?: string; readonly offlineConfirmed?: boolean; readonly demoFingerprints?: string }
export interface DoctorRow { readonly name: string; readonly status: 'OK' | 'FIX'; readonly detail: string; readonly fix?: string }

export declare function pathFor(platform: string): typeof import('node:path').posix;
export declare function layout(repoRoot: string, platform: string): Layout;
export declare function parseEnvText(text: string): Settings;
export declare function demoTenants(settings: Settings | undefined): string[];
export declare function refusals(settings: Settings | undefined, processEnv?: Record<string, string | undefined>): string[];
export declare function composeEnv(processEnv: Record<string, string | undefined>, settings: Settings | undefined): Record<string, string | undefined>;
export declare function planSettings(example: Settings, deps: { random: (n: number) => Buffer; uuid: () => string }): { planned: Settings; secretNames: string[] };
export declare function renderSettings(exampleText: string, planned: Settings, nowIso: string): string;
export declare function clashes(planned: Settings, keys: readonly string[], others: readonly { name: string; values: Settings }[]): { key: string; file: string }[];
export declare function dockerProblem(deps: Deps): { what: string; fix: string } | undefined;
export declare function waitReady(deps: Deps, port: string | number, waitMs?: number): Promise<boolean>;
export declare function overall(results: readonly CheckResult[]): { passed: boolean; line: string };
export declare function checkTable(results: readonly CheckResult[]): string[];
export declare function runChecks(deps: Deps, settings: Settings, opts: CheckOptions & { by: string }): Promise<CheckResult[]>;
export declare const FINGERPRINT_LABEL: string;
export declare const FINGERPRINT_KEYS: readonly string[];
export declare const FINGERPRINT_MIN_LENGTH: number;
export declare const FINGERPRINT_HEX: number;
export interface FingerprintSet { readonly fingerprints: Record<string, string>; readonly notFingerprinted: Record<string, 'not set' | 'too short'> }
export declare function fingerprintOf(value: string): string;
export declare function fingerprintsOf(settings: Settings | undefined): FingerprintSet;
export declare function readFingerprintFile(text: string): { ok: true; file: FingerprintSet & { settingsFile: string } } | { ok: false; reason: string };
export declare function fingerprintMatches(own: Record<string, string>, theirs: Record<string, string>): { own: string; demo: string }[];
export declare function fingerprints(deps: Deps, opts: { settings?: string; out?: string }): Promise<number>;
export declare function demoFingerprintVerdict(settings: Settings, text: string): { status: CheckStatus; detail: string };
export declare function ownDriveProblem(dir: string, where: { platform: string; repoRoot: string; systemDrive?: string }): string | undefined;
export declare function backupRecordVerdict(deps: Deps, file: string): { status: CheckStatus; detail: string };
export declare function loadSettings(deps: Deps): { L: Layout; settings: Settings | undefined };
export declare function guarded(deps: Deps, settings: Settings): boolean;
export declare function lines(s: unknown): string[];
export declare function rel(deps: Deps, abs: string): string;
export declare function stampOf(at: Date): string;
export declare function backupVerdict(rec: unknown, where: { platform: string; repoRoot: string; systemDrive?: string }): { status: CheckStatus; detail: string };
export declare function doctorRows(deps: Deps): DoctorRow[];
export declare function parseCommandLine(argv: readonly string[]): {
  command?: string; by?: string; out?: string; backupRecord?: string; offlineConfirmed: boolean; demoFingerprints?: string;
  settings?: string; to?: string; from?: string; previous?: string; run: boolean; problems: string[];
};
export declare function prepare(deps: Deps): Promise<number>;
export declare function up(deps: Deps): Promise<number>;
export declare function check(deps: Deps, opts: CheckOptions): Promise<number>;
export declare function doctor(deps: Deps): Promise<number>;
export declare function main(argv: readonly string[], deps: Deps): Promise<number>;
export declare function portInUse(port: number): Promise<boolean>;
export declare function defaultDeps(): Deps;
