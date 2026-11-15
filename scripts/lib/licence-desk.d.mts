// Types for scripts/lib/licence-desk.mjs (the owner's licence desk — CR-01 step 5, OI-10).
export interface DeskDeps {
  fs: typeof import('node:fs');
  path: typeof import('node:path');
  env: Record<string, string | undefined>;
  platform: string;
  say: (line: string) => void;
  ask: (question: string, hidden?: boolean) => Promise<string>;
  now: () => Date;
}
export declare const KEY_FILE: 'sre-licence-seller-key.pem';
export declare const PUBLIC_FILE: 'licence-signing.pub';
export declare const ISSUED_LOG: 'issued-licences.log';
export declare function insideRepository(d: Pick<DeskDeps, 'fs' | 'path'>, dir: string): string | undefined;
export declare function onAShopPc(d: Pick<DeskDeps, 'fs' | 'path' | 'env' | 'platform'>): boolean;
export declare function paperBackupText(k: { privatePem: string; keyId: string; madeOn: string }): string;
export declare function keyFromPaper(typed: string): { ok: true; privatePem: string } | { ok: false; problem: string };
export declare function makeKeyCommand(d: DeskDeps, o: { folder?: string }): Promise<number>;
export declare function issueCommand(d: DeskDeps, o: { key?: string; request?: string; owner?: boolean; tenant?: string; shop?: string; gstin?: string; tills?: string; stores?: string; modules?: string; expires?: string; out?: string }): Promise<number>;
export declare function showCommand(d: DeskDeps, o: { file: string; publicKey?: string }): Promise<number>;
export declare function restoreKeyCommand(d: DeskDeps, o: { from: string; folder: string }): Promise<number>;
