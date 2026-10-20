// Types for scripts/lib/store-computer-crypto.mjs (the store computer's backup encryption, OB-249).
import type { KeyObject } from 'node:crypto';
import type { Deps } from './store-computer.mjs';

export declare const KEY_FILE_KIND: 'sre-backup-key';
export declare const SCHEME: string;
export declare const CHUNK_BYTES: number;
export declare const SCRYPT: Readonly<{ N: number; r: number; p: number }>;
export declare const MIN_PASSPHRASE: number;

export interface BackupKeyFile {
  readonly kind: 'sre-backup-key'; readonly version: 1; readonly keyId: string; readonly createdAt: string; readonly scheme: string;
  readonly publicKey: string;
  readonly sealedPrivateKey: { readonly kdf: 'scrypt'; readonly N: number; readonly r: number; readonly p: number; readonly salt: string; readonly iv: string; readonly tag: string; readonly ct: string };
  readonly note: string;
}
export interface Sealed { readonly scheme: string; readonly epk: string; readonly salt: string; readonly iv: string; readonly tag: string; readonly ct: string }

export declare function passphraseProblem(first: string | undefined, second?: string): string | undefined;
export declare function keyIdOf(publicKey: KeyObject): string;
export declare function makeBackupKey(passphrase: string, opts?: { now?: Date; random?: (n: number) => Buffer; scrypt?: { N: number; r: number; p: number } }): BackupKeyFile;
export declare function keyFileProblem(k: unknown): string | undefined;
export declare function publicKeyOf(keyFile: BackupKeyFile): KeyObject;
export declare function unlockBackupKey(keyFile: unknown, passphrase: string): { ok: true; privateKey: KeyObject } | { ok: false; problem: string; wrongPassphrase?: boolean };
export declare function encryptFile(fs: Deps['fs'], plainPath: string, outPath: string, publicKey: KeyObject, opts: { purpose: string; keyId: string; random?: (n: number) => Buffer; chunkBytes?: number }): { plainBytes: number; plainSha256: string; bytes: number; sha256: string };
export declare function readEncryptedHeader(fs: Deps['fs'], file: string): { ok: true; header: Record<string, unknown>; raw: Buffer; bodyAt: number } | { ok: false; problem: string };
export declare function decryptFile(fs: Deps['fs'], encPath: string, outPath: string, privateKey: KeyObject, opts?: { expectPurpose?: string }): { ok: true; plainBytes: number; plainSha256: string; purpose: string } | { ok: false; problem: string };
export declare function sealJson(value: unknown, publicKey: KeyObject, opts?: { random?: (n: number) => Buffer }): Sealed;
export declare function openJson(sealed: Sealed, privateKey: KeyObject): { ok: true; value: unknown } | { ok: false; problem: string };
