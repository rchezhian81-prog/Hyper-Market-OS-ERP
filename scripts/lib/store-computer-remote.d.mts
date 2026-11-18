// Types for scripts/lib/store-computer-remote.mjs (the owner's remote link — OB-840 · ADR-0035).
import type { Deps } from './store-computer.mjs';
import type { ServicePaths } from './store-computer-services.mjs';

export declare const REMOTE_DOOR_PORT: string;
export declare const REMOTE_ACCESS_KIND: string;
export declare const REMOTE_LINK_STATUS_KIND: string;
export declare const PINS_PATH: string;
export declare const ASK_PATH: string;
export declare const PINS_KIND: string;
export declare const LINK_DISPLAY: string;
export declare const LINK_DESCRIPTION: string;
export declare const BACKOFF_MS: Readonly<{ first: number; max: number; heldFor: number }>;
export declare const HEARTBEAT_MS: number;

export interface RemoteLinkPaths {
  readonly dir: string; readonly keyDir: string; readonly key: string; readonly pub: string; readonly knownHosts: string;
  readonly settings: string; readonly stateDir: string; readonly status: string; readonly access: string; readonly logDir: string;
}
export interface LinkSettings {
  readonly kind: 'sre-remote-link-v1'; readonly host: string; readonly sshPort: number; readonly user: string; readonly listenPort: number;
  readonly doorPort: number; readonly key: string; readonly knownHosts: string; readonly status: string; readonly ssh: string;
}
export declare function cleanHost(typed: unknown): string | undefined;
export declare function remoteLinkPaths(platform: string, dataRoot: string, tillDir: string): RemoteLinkPaths;
export declare function opensshOf(env: Record<string, string | undefined> | undefined, platform: string): { ssh: string; keygen: string };
export declare function sshArgs(cfg: { sshPort: number; user: string; listenPort: number; doorPort: number; host: string }, paths: { key: string; knownHosts: string }): string[];
export declare function sshProblem(line: string): string | undefined;
export declare function forwardTaken(line: string): boolean;
export declare function nextBackoff(previousMs: number, heldMs: number): number;
export declare function statusText(state: string, since: string, nowIso: string, extra?: Record<string, unknown>): string;
export declare function linkWords(text: string | undefined, nowMs: number): string;
export declare function remoteLinkXml(P: ServicePaths, paths: RemoteLinkPaths): string;
export declare function remoteLinkGrants(P: ServicePaths, paths: RemoteLinkPaths): string[][];
export declare function tillEnvWithRemote(text: string, paths: RemoteLinkPaths): string;
export declare function remoteAccessSetup(deps: Deps, opts: { host?: string; code?: string }): Promise<number>;
export declare function remoteAccessOn(deps: Deps): Promise<number>;
export declare function remoteAccessOff(deps: Deps): Promise<number>;
export declare function remoteAccessStatus(deps: Deps): Promise<number>;
export declare function readLinkSettings(text: string): LinkSettings | undefined;
export declare function runRemoteLink(deps: {
  fs: { writeFileSync(file: string, text: string, enc: string): void };
  now(): Date; sleep(ms: number): Promise<void>; stopped(): boolean;
  every(ms: number, fn: () => void): { cancel(): void };
  say(line: string): void;
  runSsh(program: string, args: readonly string[], onLine: (line: string) => void): Promise<number>;
}, cfg: LinkSettings): Promise<void>;
export declare function keyFingerprint(publicKeyLine: string): string;
