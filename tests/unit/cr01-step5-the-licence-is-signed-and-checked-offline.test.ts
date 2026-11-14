import { describe, it, expect } from 'vitest';
import { generateKeyPairSync } from 'node:crypto';
import {
  LICENCE_POLICY, MODULE_IDS, canonicalJson, checkLicenceFor, forShop, gstinOk, keyIdOf, licenceStanding, makeSellerKey,
  newLicenceId, openSellerKey, readLicence, replaces, shopDateOf, signLicence, termsProblems, type LicenceTerms,
} from '../../scripts/lib/licence.mjs';

/**
 * **CR-01 step 5 · OI-10 · M33-FR-04 · OB-710: a licence is signed by the seller's own key and checked OFFLINE.**
 *
 *   The seller's private key signs; a release checks with the PUBLIC key only — no network (P-01). A FORGED licence (another
 *   key), an EDITED one (one changed term) and a COPIED one (another shop's tenant id) are each refused BY NAME. On the
 *   shop's own day: warnings before the end, then a grace period, then reduced mode — but the till always sells and the
 *   shop can always view and export (P-06). The owner's own licence has no end. Synthetic data only.
 */

const seller = generateKeyPairSync('ed25519');
const SELLER_PRIV = seller.privateKey.export({ type: 'pkcs8', format: 'pem' }) as string;
const SELLER_PUB = seller.publicKey.export({ type: 'spki', format: 'pem' }) as string;
const forger = generateKeyPairSync('ed25519');
const FORGER_PRIV = forger.privateKey.export({ type: 'pkcs8', format: 'pem' }) as string;

const TENANT = '0b6f1c2e-6a57-4f0a-9d3b-2f4a1e7c9d10';
const OTHER_TENANT = '7d1e9a44-2c3b-4e5f-8a90-b1c2d3e4f5a6';
// A synthetic GSTIN with a right check character (Tamil Nadu, 33).
const GSTIN = `33ABCDE1234F1Z${'0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ'[0]}`;
const RIGHT_GSTIN = ((): string => { for (const c of '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ') { const g = `33ABCDE1234F1Z${c}`; if (gstinOk(g)) return g; } throw new Error('no check char'); })();

const terms = (over: Partial<LicenceTerms> = {}): LicenceTerms => ({
  licenceId: 'LIC-20261114-0A1B2C3D', kind: 'shop', tenantId: TENANT, shopName: 'Test Shop Two', gstin: RIGHT_GSTIN,
  tills: 4, stores: 1, modules: ['all'], issuedOn: '2026-11-14', expiresOn: '2027-11-13', ...over,
});

describe('signed by the seller, checked with the public key only', () => {
  it('a licence the seller signed is read back, with its terms, for its own shop', () => {
    const file = signLicence(terms(), SELLER_PRIV);
    const read = checkLicenceFor(file, [SELLER_PUB], { tenantId: TENANT, gstin: RIGHT_GSTIN });
    expect(read).toEqual({ ok: true, licence: terms(), keyId: keyIdOf(SELLER_PUB) });
  });

  it('the file holds no private key and no secret: only terms, a key id and a signature', () => {
    const file = JSON.parse(signLicence(terms(), SELLER_PRIV)) as Record<string, unknown>;
    expect(Object.keys(file).sort()).toEqual(['keyId', 'kind', 'signature', 'terms']);
    expect(JSON.stringify(file)).not.toMatch(/PRIVATE KEY/);
  });

  it('a FORGED licence (signed by another key) is refused by name', () => {
    const forged = signLicence(terms(), FORGER_PRIV);
    const read = readLicence(forged, [SELLER_PUB]);
    expect(read.ok).toBe(false);
    if (!read.ok) { expect(read.refusedBecause).toBe('unknown_seller_key'); expect(read.ta).not.toBe(''); }
    // A forger who also copies the seller's key id is caught by the signature itself.
    const f = JSON.parse(forged) as Record<string, unknown>; f['keyId'] = keyIdOf(SELLER_PUB);
    const r2 = readLicence(JSON.stringify(f), [SELLER_PUB]);
    expect(r2.ok === false && r2.refusedBecause).toBe('not_signed_by_the_seller');
  });

  it.each([
    ['the end date pushed out a year', (t: Record<string, unknown>) => { t['expiresOn'] = '2028-11-13'; }],
    ['more tills', (t: Record<string, unknown>) => { t['tills'] = 40; }],
    ['another tenant id written in', (t: Record<string, unknown>) => { t['tenantId'] = OTHER_TENANT; }],
    ['turned into an owner licence', (t: Record<string, unknown>) => { t['kind'] = 'owner'; t['expiresOn'] = null; }],
    ['one letter of the shop name', (t: Record<string, unknown>) => { t['shopName'] = 'Test Shop Twa'; }],
  ])('an EDITED licence (%s) is refused by name', (_what, edit) => {
    const f = JSON.parse(signLicence(terms(), SELLER_PRIV)) as { terms: Record<string, unknown> };
    edit(f.terms);
    const read = readLicence(JSON.stringify(f), [SELLER_PUB]);
    expect(read.ok === false && read.refusedBecause).toBe('not_signed_by_the_seller');
  });

  it('a field added beside the signed terms is refused as an edit', () => {
    const f = JSON.parse(signLicence(terms(), SELLER_PRIV)) as Record<string, unknown>; f['unlimited'] = true;
    expect(readLicence(JSON.stringify(f), [SELLER_PUB])).toMatchObject({ ok: false, refusedBecause: 'not_signed_by_the_seller' });
  });

  it('a COPIED licence (another shop\'s tenant id, or GSTIN) is refused by name, naming both shops', () => {
    const file = signLicence(terms(), SELLER_PRIV);
    const copied = checkLicenceFor(file, [SELLER_PUB], { tenantId: OTHER_TENANT });
    expect(copied.ok).toBe(false);
    if (!copied.ok) { expect(copied.refusedBecause).toBe('another_shop'); expect(copied.detail).toContain(TENANT); expect(copied.detail).toContain(OTHER_TENANT); }
    const otherGstin = checkLicenceFor(file, [SELLER_PUB], { tenantId: TENANT, gstin: '33ZZZZZ9999Z9Z9' });
    expect(otherGstin.ok === false && otherGstin.refusedBecause).toBe('another_shop');
  });

  it('not a licence, damaged, or no seller key in the program: refused by name, never "all well"', () => {
    expect(readLicence('hello', [SELLER_PUB])).toMatchObject({ refusedBecause: 'not_a_licence' });
    expect(readLicence('{"kind":"sre-retail-os-licence-v1"}', [SELLER_PUB])).toMatchObject({ refusedBecause: 'not_a_licence' });
    expect(readLicence(signLicence(terms(), SELLER_PRIV), [])).toMatchObject({ refusedBecause: 'no_seller_key' });
    expect(forShop({ ok: false, refusedBecause: 'not_a_licence', en: 'x', ta: 'y' }, { tenantId: TENANT }).ok).toBe(false);
  });

  it('the seller tool never signs terms that are not a licence\'s', () => {
    expect(() => signLicence(terms({ gstin: GSTIN === RIGHT_GSTIN ? '33ABCDE1234F1ZX' : GSTIN }), SELLER_PRIV)).toThrow(/GSTIN/);
    expect(() => signLicence(terms({ expiresOn: null }), SELLER_PRIV)).toThrow(/only the owner/);
    expect(() => signLicence(terms({ modules: ['M37'] }), SELLER_PRIV)).toThrow(/module/);
    expect(() => signLicence(terms({ tills: 0 }), SELLER_PRIV)).toThrow(/tills/);
    expect(() => signLicence(terms({ expiresOn: '2026-11-01' }), SELLER_PRIV)).toThrow(/after the issue date/);
    expect(termsProblems(terms({ modules: ['M01', 'M02'] }))).toEqual([]);
    expect(MODULE_IDS).toHaveLength(36);
  });

  it('the signed bytes do not depend on the order the terms were written in', () => {
    expect(canonicalJson({ b: 1, a: [{ d: 2, c: 3 }] })).toBe('{"a":[{"c":3,"d":2}],"b":1}');
    const t = terms(); const reordered = Object.fromEntries(Object.entries(t).reverse()) as unknown as LicenceTerms;
    expect(readLicence(signLicence(reordered, SELLER_PRIV), [SELLER_PUB]).ok).toBe(true);
  });

  it('a licence number is LIC-<date>-<8 hex>', () => {
    expect(newLicenceId('2026-11-14', () => Buffer.from([1, 2, 171, 205]))).toBe('LIC-20261114-0102ABCD');
  });
});

describe('the seller key: encrypted with a passphrase the program never keeps', () => {
  it('is made encrypted, opens only with its passphrase, and signs licences the public half checks', () => {
    const k = makeSellerKey('a long passphrase 2026');
    expect(k.privatePem).toMatch(/BEGIN ENCRYPTED PRIVATE KEY/);
    expect(k.privatePem).not.toContain('a long passphrase');
    expect(() => openSellerKey(k.privatePem, 'wrong passphrase!!')).toThrow(/passphrase is not right/);
    const file = signLicence(terms(), openSellerKey(k.privatePem, 'a long passphrase 2026'));
    expect(readLicence(file, [k.publicPem])).toMatchObject({ ok: true, keyId: k.keyId });
  });

  it('a short passphrase is refused', () => {
    expect(() => makeSellerKey('short')).toThrow(/at least 12/);
  });
});

describe('standing on the shop\'s own day: warnings, grace, then reduced mode — the till always sells', () => {
  const lic = terms({ expiresOn: '2027-01-31' });
  const at = (today: string, l: LicenceTerms | null = lic, firstSeenOn?: string) => licenceStanding({ licence: l, today, keyBuiltIn: true, ...(firstSeenOn === undefined ? {} : { firstSeenOn }) });

  it('the policy values are the proposal waiting for the owner (OB-750)', () => {
    expect(LICENCE_POLICY).toMatchObject({ decision: 'OB-750', warnDays: 30, graceDays: 30, setupDays: 30, reduced: { tillSells: true, viewAndExport: true, officeChanges: true, updates: false } });
  });

  it('valid well before the end; EXPIRING inside the warning days, every word in Tamil too', () => {
    expect(at('2026-12-01')).toMatchObject({ state: 'valid', warn: false, officeChanges: true });
    const s = at(`2027-01-${String(31 - LICENCE_POLICY.warnDays + 1).padStart(2, '0')}`);
    expect(s).toMatchObject({ state: 'expiring', warn: true, officeChanges: true, daysLeft: LICENCE_POLICY.warnDays - 1 });
    expect(s.ta).toMatch(/[஀-௿]/);
  });

  it('the end day itself is still licensed; the next day starts the grace period, nothing limited', () => {
    expect(at('2027-01-31')).toMatchObject({ state: 'expiring', daysLeft: 0, officeChanges: true });
    expect(at('2027-02-01')).toMatchObject({ state: 'grace', officeChanges: true, updates: true, tillSells: true, viewAndExport: true });
  });

  it('REDUCED from the start of the shop day after the grace — the till sells, viewing and export stay open', () => {
    const graceEnds = new Date(Date.parse('2027-02-01T00:00:00Z') + (LICENCE_POLICY.graceDays - 1) * 86_400_000).toISOString().slice(0, 10);
    expect(at(graceEnds)).toMatchObject({ state: 'grace', daysLeft: 1 });
    const r = at(new Date(Date.parse(`${graceEnds}T00:00:00Z`) + 86_400_000).toISOString().slice(0, 10));
    expect(r).toMatchObject({ state: 'reduced', tillSells: true, viewAndExport: true, officeChanges: LICENCE_POLICY.reduced.officeChanges, updates: false, warn: true });
    expect(r.en).toMatch(/till still sells/);
  });

  it('no licence yet: the setup period from the day this PC first ran with licensing, then reduced', () => {
    expect(at('2026-11-20', null, '2026-11-20')).toMatchObject({ state: 'no_licence', daysLeft: LICENCE_POLICY.setupDays, officeChanges: true });
    expect(at('2026-12-20', null, '2026-11-20')).toMatchObject({ state: 'reduced', updates: false, tillSells: true });
  });

  it('the owner\'s own licence never ends; a release with no seller key limits nothing', () => {
    expect(at('2099-01-01', terms({ kind: 'owner', expiresOn: null }))).toMatchObject({ state: 'owner', warn: false, officeChanges: true });
    expect(licenceStanding({ licence: null, today: '2099-01-01', keyBuiltIn: false })).toMatchObject({ state: 'not_in_force', officeChanges: true, warn: false });
  });

  it('the day is the SHOP\'s day: 20:00 UTC on 19 Nov is already 20 Nov in the shop', () => {
    expect(shopDateOf('2026-11-19T20:00:00Z')).toBe('2026-11-20');
    expect(shopDateOf('2026-11-19T18:00:00Z')).toBe('2026-11-19');
  });

  it('an older licence never replaces a newer one; a renewal does', () => {
    expect(replaces(lic, terms({ expiresOn: '2028-01-31', issuedOn: '2027-01-10' }))).toBe(true);
    expect(replaces(lic, terms({ expiresOn: '2026-12-31', issuedOn: '2026-01-01' }))).toBe(false);
    expect(replaces(null, lic)).toBe(true);
  });
});
