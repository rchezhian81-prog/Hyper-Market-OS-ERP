// Types for scripts/sync-ui-foundation.mjs, so a test can import the one sync script instead of re-deriving its lists.
export const FOUNDATION_SOURCE: string;
export const FOUNDATION_FILE: string;
export const UPDATE_SOURCE: string;
export const UPDATE_FILE: string;
export const BACK_OFFICE: string;
export const NOT_A_SCREEN: Set<string>;
export const WORKER_FILE: string;
export const SHARED_FILES: readonly { readonly source: string; readonly file: string; readonly takes: (app: string) => boolean }[];
export function screenAppDirs(root?: string): string[];
export function copiesOf(app: string): string[];
export function syncFoundation(options?: { root?: string; write?: boolean }): string[];
export function shellOf(workerSource: string): string[];
export function shellStampFor(app: string, root?: string): string;
export function expectedCacheName(app: string, root?: string): string;
export function stampServiceWorkers(options?: { root?: string; write?: boolean }): string[];
