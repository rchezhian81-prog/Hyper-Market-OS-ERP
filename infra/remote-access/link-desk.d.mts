// Types for infra/remote-access/link-desk.mjs (the relay's pairing desk — OB-840 · ADR-0035).
export declare const MAX_PENDING: number;
export declare const PENDING_MS: number;
export interface PendingLink { readonly code: string; readonly publicKey: string; readonly at: string; readonly from: string }
export declare function pendingIn(dir: string, nowMs: number, fs?: unknown): PendingLink[];
export declare function ask(body: string, from: string | undefined, nowMs: number, existing: readonly PendingLink[], write: (code: string, record: PendingLink) => void): { status: number; body: Record<string, unknown> };
