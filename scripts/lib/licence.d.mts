// Types for scripts/lib/licence.mjs (licensing for sale to other shops — CR-01 step 5, OI-10).
import type { KeyObject } from 'node:crypto';

export declare const LICENCE_KIND: 'sre-retail-os-licence-v1';
export declare const LICENCE_REQUEST_KIND: 'sre-retail-os-licence-request-v1';
export declare const PUBLIC_KEY_FILE: 'licence-signing.pub';
export declare const PUBLIC_KEY_IN_REPO: string;
export declare const LICENCE_KINDS: readonly ['owner', 'shop'];
export declare const MODULE_IDS: readonly string[];
export declare const MIN_PASSPHRASE: number;

export interface LicencePolicy {
  readonly decision: string;
  readonly warnDays: number;
  readonly graceDays: number;
  readonly setupDays: number;
  readonly reduced: { readonly tillSells: boolean; readonly viewAndExport: boolean; readonly officeChanges: boolean; readonly updates: boolean };
}
export declare const LICENCE_POLICY: LicencePolicy;

export interface LicenceTerms {
  licenceId: string;
  kind: 'owner' | 'shop';
  tenantId: string;
  shopName: string;
  gstin: string;
  tills: number;
  stores: number;
  modules: string[];
  issuedOn: string;
  expiresOn: string | null;
}

export type LicenceRefusal = 'not_a_licence' | 'not_signed_by_the_seller' | 'unknown_seller_key' | 'terms_not_valid' | 'another_shop' | 'no_seller_key';
export type LicenceRead =
  | { ok: true; licence: LicenceTerms; keyId: string }
  | { ok: false; refusedBecause: LicenceRefusal; en: string; ta: string; detail?: string };

export type LicenceState = 'not_in_force' | 'owner' | 'valid' | 'expiring' | 'grace' | 'no_licence' | 'reduced';
export interface LicenceStanding {
  state: LicenceState;
  licence: LicenceTerms | null;
  today: string;
  tillSells: true;
  viewAndExport: true;
  officeChanges: boolean;
  updates: boolean;
  warn: boolean;
  daysLeft?: number;
  reducedFrom?: string;
  en: string;
  ta: string;
}

export declare const REFUSAL_WORDS: Readonly<Record<LicenceRefusal, { en: string; ta: string }>>;
export declare function gstinCheckChar(first14: string): string | undefined;
export declare function gstinOk(g: unknown): boolean;
export declare function shopDateOf(moment: Date | string | number): string;
export declare function canonicalJson(value: unknown): string;
export declare function keyIdOf(publicKeyPem: string): string;
export declare function termsProblems(t: unknown): string[];
export declare function newLicenceId(issuedOn: string, random?: (n: number) => Buffer): string;
export declare function signLicence(terms: LicenceTerms, privateKey: string | KeyObject): string;
export declare function readLicence(text: string, publicKeys: readonly string[]): LicenceRead;
export declare function forShop(read: LicenceRead, shop: { tenantId?: string; gstin?: string }): LicenceRead;
export declare function checkLicenceFor(text: string, publicKeys: readonly string[], shop: { tenantId?: string; gstin?: string }): LicenceRead;
export declare function licenceStanding(input: { licence: LicenceTerms | null | undefined; today: string; keyBuiltIn: boolean; firstSeenOn?: string; policy?: LicencePolicy }): LicenceStanding;
export declare function licenceRequest(input: { tenantId: string; shopName?: string; gstin?: string; release?: string; at: string }): Record<string, unknown>;
export declare function replaces(current: LicenceTerms | null | undefined, newer: LicenceTerms): boolean;
export declare function makeSellerKey(passphrase: string): { privatePem: string; publicPem: string; keyId: string };
export declare function openSellerKey(privatePem: string, passphrase: string): KeyObject;
