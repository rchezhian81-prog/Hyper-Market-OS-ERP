// Types for scripts/lib/store-pc-update.mjs (the signed update record of a store PC release — CR-01 step 3a).

export interface UpdateFields { version: string; commit: string; sha256: string }
export interface UpdateRecord extends UpdateFields { kind: 'sre-store-pc-update-v1'; asset: 'SRE-Setup.exe'; signature: string | null }

export declare const UPDATE_KIND: 'sre-store-pc-update-v1';
export declare const UPDATE_ASSET: 'SRE-Setup.exe';
export declare const UPDATE_RECORD: 'update.json';
export declare function releaseVersion(runNumber: string | number): string;
export declare function releaseTag(version: string): string;
export declare function isReleaseVersion(v: unknown): boolean;
export declare function compareVersions(a: string, b: string): -1 | 0 | 1;
export declare function sha256Of(bytes: Uint8Array | string): string;
export declare function updateManifest(fields: UpdateFields): string;
export declare function signUpdate(fields: UpdateFields, privateKeyPem: string): string;
export declare function verifyUpdate(fields: UpdateFields, publicKeyPem: string, signature: unknown): boolean;
export declare function updateRecord(input: UpdateFields & { signature: string | null }): UpdateRecord;
export declare function checkUpdate(input: {
  record: unknown;
  setupBytes: Uint8Array;
  publicKeyPem: string | undefined;
  runningVersion: string | undefined;
}): { ok: true; version: string } | { ok: false; reason: string };
