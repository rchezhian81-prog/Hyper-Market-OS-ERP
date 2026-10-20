// Types for scripts/lib/store-computer-files.mjs (the till's data, copied consistently while it sells).
import type { Deps } from './store-computer.mjs';

export interface BundleEntry {
  readonly name: string; readonly kind: 'log' | 'file'; readonly size: number; readonly sha256: string;
  readonly records?: number; readonly unframedLines?: number; readonly inFlightBytes?: number; readonly keptIncompleteTailBytes?: number;
}
export declare const IN_FLIGHT_WAIT_MS: number;
export declare function looksLikeLog(fs: Deps['fs'], file: string, size: number): boolean;
export declare function walkFrames(fs: Deps['fs'], fd: number, from: number, limit: number): { cut: number; records: number; unframed: number; incompleteAt: number | undefined };
export declare function writeBundle(fs: Deps['fs'], platform: string, sources: readonly ({ prefix: string; dir: string } | { prefix: string; file: string })[], bundlePath: string, opts?: { waitMs?: number; sleep?: (ms: number) => void }): BundleEntry[];
export declare function checkBundle(fs: Deps['fs'], bundlePath: string): { ok: boolean; files: BundleEntry[]; problems: string[] };
export declare function tillSummary(toc: readonly BundleEntry[]): { files: number; logs: number; saleRecords: number; deadLetterRecords: number; pinCredentials: boolean; inFlightBytes: number; keptIncompleteTails: string[] };
