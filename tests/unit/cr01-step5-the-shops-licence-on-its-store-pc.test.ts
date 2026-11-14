import { describe, it, expect } from 'vitest';
import * as fs from 'node:fs';
import { mkdtempSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { generateKeyPairSync } from 'node:crypto';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { gstinOk, signLicence, type LicenceTerms } from '../../scripts/lib/licence.mjs';
import { FIRST_SEEN_FILE, LICENCE_DIR, LICENCE_FILE, LICENCE_LOG, firstSeen, licenceNow, loadLicence, readHistory, requestFor, sellerKeys } from '../../scripts/lib/store-licence.mjs';

/**
 * **CR-01 step 5 · OI-10: the shop's licence on its store PC — loaded, kept, and re-checked on every read.**
 *
 *   A licence is loaded only when it checks (the seller's signature, its terms, THIS shop); every load and every refusal is
 *   written FIRST to an append-only history (hard rule 6), and a renewal never loses the licence it replaces. A licence.json
 *   changed on disk is not trusted because it is in the folder (P-08). The setup period starts on the day this PC first runs
 *   with licensing on, written once. Synthetic data only.
 */

const seller = generateKeyPairSync('ed25519');
const PRIV = seller.privateKey.export({ type: 'pkcs8', format: 'pem' }) as string;
const PUB = seller.publicKey.export({ type: 'spki', format: 'pem' }) as string;
const TENANT = '0b6f1c2e-6a57-4f0a-9d3b-2f4a1e7c9d10';
const GSTIN = ((): string => { for (const c of '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ') { const g = `33ABCDE1234F1Z${c}`; if (gstinOk(g)) return g; } throw new Error('x'); })();
const terms = (over: Partial<LicenceTerms> = {}): LicenceTerms => ({ licenceId: 'LIC-20261114-00000001', kind: 'shop', tenantId: TENANT, shopName: 'Test Shop Two', gstin: GSTIN, tills: 2, stores: 1, modules: ['all'], issuedOn: '2026-11-14', expiresOn: '2027-11-13', ...over });
const io = { fs, path };
const NOW = () => new Date('2026-11-14T06:00:00Z');
const setup = () => { const dir = mkdtempSync(path.join(tmpdir(), 'sre-licence-')); return { dir, shop: { tenantId: TENANT, gstin: GSTIN }, keys: [PUB] }; };

describe('loading a licence', () => {
  it('a signed licence for this shop is LOADED, put in force, and its whole file kept in the history', () => {
    const { dir, shop, keys } = setup();
    const file = signLicence(terms(), PRIV);
    const r = loadLicence(io, dir, { text: file, keys, shop, by: 'owner-01', via: 'licence_screen', now: NOW });
    expect(r).toMatchObject({ ok: true });
    expect(r.ok && r.en).toMatch(/^LICENCE LOADED — LIC-20261114-00000001/);
    expect(readFileSync(path.join(dir, LICENCE_DIR, LICENCE_FILE), 'utf8')).toBe(file);
    const h = readHistory(io, dir);
    expect(h).toHaveLength(1);
    expect(h[0]).toMatchObject({ kind: 'licence_load', outcome: 'loaded', by: 'owner-01', via: 'licence_screen', licenceId: 'LIC-20261114-00000001', file });
    expect(licenceNow(io, dir, { keys, shop, now: NOW }).standing).toMatchObject({ state: 'valid', licence: terms() });
  });

  it.each([
    ['forged', () => signLicence(terms(), generateKeyPairSync('ed25519').privateKey), 'unknown_seller_key'],
    ['edited', () => signLicence(terms(), PRIV).replace('"tills": 2', '"tills": 20'), 'not_signed_by_the_seller'],
    ['copied from another shop', () => signLicence(terms({ tenantId: '7d1e9a44-2c3b-4e5f-8a90-b1c2d3e4f5a6' }), PRIV), 'another_shop'],
    ['not a licence at all', () => 'a photo of a licence', 'not_a_licence'],
  ])('a %s licence is REFUSED by name, the refusal written down, nothing put in force', (_w, make, why) => {
    const { dir, shop, keys } = setup();
    const r = loadLicence(io, dir, { text: make(), keys, shop, by: 'owner-01', via: 'licence_screen', now: NOW });
    expect(r).toMatchObject({ ok: false, refusedBecause: why });
    expect(existsSync(path.join(dir, LICENCE_DIR, LICENCE_FILE))).toBe(false);
    expect(readHistory(io, dir)).toEqual([expect.objectContaining({ outcome: `refused:${why}`, by: 'owner-01' })]);
  });

  it('a RENEWAL replaces the licence in force; both stay in the history; an older one is refused', () => {
    const { dir, shop, keys } = setup();
    loadLicence(io, dir, { text: signLicence(terms(), PRIV), keys, shop, by: 'owner-01', via: 'licence_screen', now: NOW });
    const renewal = signLicence(terms({ licenceId: 'LIC-20271101-00000002', issuedOn: '2027-11-01', expiresOn: '2028-11-13' }), PRIV);
    expect(loadLicence(io, dir, { text: renewal, keys, shop, by: 'owner-01', via: 'licence_screen', now: NOW }).ok).toBe(true);
    const older = signLicence(terms({ licenceId: 'LIC-20251101-00000003', issuedOn: '2025-11-01', expiresOn: '2026-12-01' }), PRIV);
    expect(loadLicence(io, dir, { text: older, keys, shop, by: 'owner-01', via: 'licence_screen', now: NOW })).toMatchObject({ ok: false, refusedBecause: 'older_than_in_force' });
    expect(readHistory(io, dir).map((h) => h['outcome'])).toEqual(['loaded', 'loaded', 'refused:older_than_in_force']);
    expect(readFileSync(path.join(dir, LICENCE_DIR, LICENCE_FILE), 'utf8')).toBe(renewal);
  });

  it('a load that cannot be written down is NOT made (the history comes first)', () => {
    const { dir, shop, keys } = setup();
    writeFileSync(path.join(dir, LICENCE_DIR), 'a file where the folder should be');
    expect(loadLicence(io, dir, { text: signLicence(terms(), PRIV), keys, shop, by: 'owner-01', via: 'licence_screen', now: NOW })).toMatchObject({ ok: false, refusedBecause: 'not_recorded' });
  });

  it('a release with no seller key cannot load a licence, and says why', () => {
    const { dir, shop } = setup();
    expect(loadLicence(io, dir, { text: signLicence(terms(), PRIV), keys: [], shop, by: 'owner-01', via: 'licence_screen', now: NOW })).toMatchObject({ ok: false, refusedBecause: 'no_seller_key' });
  });
});

describe('reading it back: re-checked every time', () => {
  it('a licence.json changed ON DISK is not trusted — it is shown as a problem, and the shop counts as unlicensed', () => {
    const { dir, shop, keys } = setup();
    loadLicence(io, dir, { text: signLicence(terms(), PRIV), keys, shop, by: 'owner-01', via: 'licence_screen', now: NOW });
    const f = path.join(dir, LICENCE_DIR, LICENCE_FILE);
    writeFileSync(f, readFileSync(f, 'utf8').replace('"2027-11-13"', '"2037-11-13"'));
    const n = licenceNow(io, dir, { keys, shop, now: NOW });
    expect(n.standing.state).toBe('no_licence');
    expect(n.problem).toMatchObject({ ok: false, refusedBecause: 'not_signed_by_the_seller' });
  });

  it('the setup period starts the first day this PC runs with licensing on — written once, never moved', () => {
    const { dir, shop, keys } = setup();
    expect(firstSeen(io, dir, { keyBuiltIn: false, now: NOW })).toBeUndefined();
    expect(existsSync(path.join(dir, LICENCE_DIR, FIRST_SEEN_FILE))).toBe(false);
    expect(licenceNow(io, dir, { keys, shop, now: NOW })).toMatchObject({ firstSeenOn: '2026-11-14', standing: { state: 'no_licence', reducedFrom: '2026-12-14' } });
    const later = () => new Date('2026-12-20T06:00:00Z');
    expect(licenceNow(io, dir, { keys, shop, now: later })).toMatchObject({ firstSeenOn: '2026-11-14', standing: { state: 'reduced', tillSells: true, viewAndExport: true } });
  });

  it('without a seller key in the release nothing is limited and no setup period starts', () => {
    const { dir, shop } = setup();
    expect(licenceNow(io, dir, { keys: [], shop, now: NOW })).toMatchObject({ keyBuiltIn: false, standing: { state: 'not_in_force', officeChanges: true } });
  });

  it('the seller key is read from the release folder beside release.json; none there → none', () => {
    const rel = mkdtempSync(path.join(tmpdir(), 'sre-release-'));
    expect(sellerKeys(io, rel)).toEqual([]);
    writeFileSync(path.join(rel, 'licence-signing.pub'), PUB);
    expect(sellerKeys(io, rel)).toEqual([PUB]);
    expect(sellerKeys(io, undefined)).toEqual([]);
  });

  it('the licence request names the shop only: tenant id, name, GSTIN — never a secret', () => {
    const r = requestFor({ tenantId: TENANT, shopName: 'Test Shop Two', gstin: GSTIN, release: '1.0.3' }, NOW);
    expect(r).toEqual({ kind: 'sre-retail-os-licence-request-v1', tenantId: TENANT, shopName: 'Test Shop Two', gstin: GSTIN, release: '1.0.3', madeAt: '2026-11-14T06:00:00.000Z' });
  });

  it('the history file is one line per event, never rewritten', () => {
    const { dir, shop, keys } = setup();
    loadLicence(io, dir, { text: 'x', keys, shop, by: 'a', via: 'store_computer_tool', now: NOW });
    const first = readFileSync(path.join(dir, LICENCE_DIR, LICENCE_LOG), 'utf8');
    loadLicence(io, dir, { text: signLicence(terms(), PRIV), keys, shop, by: 'a', via: 'store_computer_tool', now: NOW });
    expect(readFileSync(path.join(dir, LICENCE_DIR, LICENCE_LOG), 'utf8').startsWith(first)).toBe(true);
  });
});
