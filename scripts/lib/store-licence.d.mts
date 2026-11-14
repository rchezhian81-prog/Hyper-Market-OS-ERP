// Types for scripts/lib/store-licence.mjs (the shop's licence on its store PC — CR-01 step 5, OI-10).
import type { LicenceRead, LicenceStanding, LicenceTerms } from './licence.mjs';

export interface LicenceIo {
  fs: typeof import('node:fs');
  path: { join: (...p: string[]) => string };
}
export interface ShopIdentity { tenantId?: string; gstin?: string }

export declare const LICENCE_DIR: 'licence';
export declare const LICENCE_FILE: 'licence.json';
export declare const LICENCE_LOG: 'licence-history.log';
export declare const FIRST_SEEN_FILE: 'licensing-first-seen.json';
export declare const LICENCE_MAX_BYTES: number;

export type LoadOutcome =
  | { ok: true; licence: LicenceTerms; en: string; ta: string }
  | { ok: false; refusedBecause: string; en: string; ta: string; detail?: string };

export declare function sellerKeys(io: LicenceIo, releaseDir: string | undefined): string[];
export declare function firstSeen(io: LicenceIo, edgeDataDir: string, o: { keyBuiltIn: boolean; now: () => Date }): string | undefined;
export declare function appendHistory(io: LicenceIo, edgeDataDir: string, entry: Record<string, unknown>): void;
export declare function readHistory(io: LicenceIo, edgeDataDir: string): Record<string, unknown>[];
export declare function licenceInForce(io: LicenceIo, edgeDataDir: string, o: { keys: readonly string[]; shop: ShopIdentity }): { licence: LicenceTerms | null; keyId?: string; problem?: LicenceRead };
export declare function licenceNow(io: LicenceIo, edgeDataDir: string, o: { keys: readonly string[]; shop: ShopIdentity; now: () => Date }): { standing: LicenceStanding; keyBuiltIn: boolean; problem?: LicenceRead; firstSeenOn?: string };
export declare function loadLicence(io: LicenceIo, edgeDataDir: string, o: { text: unknown; keys: readonly string[]; shop: ShopIdentity; by: string; via: 'setup_screens' | 'licence_screen' | 'store_computer_tool'; now: () => Date }): LoadOutcome;
export declare function requestFor(shop: { tenantId: string; shopName?: string; gstin?: string; release?: string }, now: () => Date): Record<string, unknown>;
export { readLicence } from './licence.mjs';
