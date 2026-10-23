import { describe, it, expect } from 'vitest';
import { tillLineRefusals, TILL_RULE_FLAG_KEYS, hasTillRuleFlags } from '../../packages/restricted-sales/src/till-gate';
import { validateProduct, publishProduct, isBisControlled, type ProductRecord, type Category } from '../../packages/product/src/product';
import { regulatedFlagsFor } from '../../services/catalogue/src/catalogue-preview';
import { canonicalise } from '../../services/catalogue/src/pack';
import { PosSession, TillRuleRefusedError } from '../../apps/pos/src/session';
import { money } from '../../packages/contracts/src/money';
import { rate } from '../../packages/contracts/src/rate';
import { Ledger, InMemoryLedgerStore } from '../../packages/ledger/src/index';
import { SyncOutbox } from '../../packages/sync/src/index';
import type { CatalogueSnapshot } from '../../packages/catalogue/src/catalogue';

/**
 * **B12 (roadmap v2.1 · OB-325, owner 23 Oct 2026: "build, switched ON") — packaged drinking water and other BIS Quality
 * Control Order goods are sold only with a BIS licence number AND its expiry on record, and only while the licence is
 * current. The till refuses the sale offline when either is missing or the licence has run out.** The product master
 * refuses to publish such a product without both; the pack carries them, signed; the till's gate and its commit refuse.
 */

const WATER = 'p-water';
const flags = (extra: Record<string, unknown> = {}) => ({ bisControlled: true, bisLicenceNo: 'CM/L-7654321098', bisLicenceValidUntil: '2026-12-31', ...extra });
const line = (regulatedFlags: Record<string, unknown> | undefined) => ({
  productId: WATER, description: 'Packaged drinking water 1L', quantityMinor: 1, uom: 'ea', unitPriceMinor: 2_000,
  ...(regulatedFlags === undefined ? {} : { regulatedFlags }),
});

describe('B12 — the till gate', () => {
  it('sells a BIS product while its licence is current, through its last valid day', () => {
    expect(tillLineRefusals(line(flags()), { today: '2026-10-23' })).toEqual([]);
    expect(tillLineRefusals(line(flags()), { today: '2026-12-31' })).toEqual([]);
  });
  it('refuses the day after the licence ran out, in words that name the licence and the day', () => {
    const r = tillLineRefusals(line(flags()), { today: '2027-01-01' });
    expect(r.map((x) => x.reason)).toEqual(['bis_licence_expired']);
    expect(r[0]?.laneMessage).toMatch(/CM\/L-7654321098 ran out on 2026-12-31\. It cannot be sold/);
  });
  it('refuses with no licence number, with no expiry, with a malformed expiry, and when the lane does not know today', () => {
    expect(tillLineRefusals(line(flags({ bisLicenceNo: undefined })), { today: '2026-10-23' })[0]?.laneMessage).toMatch(/BIS licence number is not on record/);
    expect(tillLineRefusals(line(flags({ bisLicenceValidUntil: undefined })), { today: '2026-10-23' })[0]?.reason).toBe('bis_licence_missing');
    expect(tillLineRefusals(line(flags({ bisLicenceValidUntil: '2026-02-30' })), { today: '2026-01-01' })[0]?.reason).toBe('bis_licence_missing');
    expect(tillLineRefusals(line(flags({ bisLicenceNo: '   ' })), { today: '2026-10-23' })[0]?.reason).toBe('bis_licence_missing');
    expect(tillLineRefusals(line(flags()), {})[0]?.reason).toBe('bis_licence_not_judged');
  });
  it('leaves every other product alone (switched ON, but only for BIS-controlled goods)', () => {
    expect(tillLineRefusals(line(undefined), { today: '2027-01-01' })).toEqual([]);
    expect(tillLineRefusals(line({ bisLicenceValidUntil: '2020-01-01' }), { today: '2027-01-01' })).toEqual([]);
  });
  it('the flags ride under the pack signature', () => {
    expect(TILL_RULE_FLAG_KEYS).toEqual(expect.arrayContaining(['bisControlled', 'bisLicenceNo', 'bisLicenceValidUntil']));
    expect(hasTillRuleFlags(flags())).toBe(true);
    const snap = (until: string): CatalogueSnapshot => ({
      tenantId: 't', version: 1, builtAt: '2026-10-23T00:00:00Z', barcodes: [],
      products: [{ productId: WATER, sku: 'W', name: 'Water', baseUom: 'ea', unitPriceMinor: 2_000, taxBps: 1_800, status: 'active', regulatedFlags: flags({ bisLicenceValidUntil: until }) }],
    });
    // Moving the expiry after signing changes the signed text, so the signature no longer verifies.
    expect(canonicalise(snap('2026-12-31'))).not.toBe(canonicalise(snap('2030-12-31')));
  });
});

describe('B12 — the product master', () => {
  const categories: Category[] = [
    { categoryId: 'water', name: 'Packaged drinking water', parentId: null, regulated: ['bis_controlled'] },
    { categoryId: 'grocery', name: 'Grocery', parentId: null },
  ];
  const product = (safety: ProductRecord['safety'], categoryId = 'water'): ProductRecord => ({
    productId: WATER, tenantId: 't', sku: 'W1', name: 'Water 1L', primaryCategoryId: categoryId, baseUom: 'ea', taxClass: '2201', lifecycle: 'draft',
    ...(safety === undefined ? {} : { safety }),
  });
  it('a product in a BIS-controlled category does not publish without the licence number and expiry', () => {
    const issues = validateProduct(product(undefined), categories).issues.map((i) => i.field);
    expect(issues).toEqual(expect.arrayContaining(['safety.bisLicenceNo', 'safety.bisLicenceValidUntil']));
    expect(validateProduct(product({ bisLicenceNo: 'CM/L-1', bisLicenceValidUntil: '31-12-2026' }), categories).publishable).toBe(false);
  });
  it('with both it publishes and carries the BIS flag itself, which the pack then sends to the till', () => {
    const published = publishProduct(product({ bisLicenceNo: 'CM/L-7654321098', bisLicenceValidUntil: '2026-12-31' }), categories);
    expect(published.safety?.bisControlled).toBe(true);
    expect(isBisControlled(published, undefined)).toBe(true);
    expect(regulatedFlagsFor(published)).toEqual(flags());
  });
  it('a product outside such a category is unaffected', () => {
    const published = publishProduct(product(undefined, 'grocery'), categories);
    expect(published.safety?.bisControlled).toBeUndefined();
    expect(regulatedFlagsFor(published)).toBeUndefined();
  });
});

describe('B12 — the till session refuses at the scan and again at the commit (offline)', () => {
  const session = (now: { at: string }) => new PosSession(
    { laneId: 'lane-1', cashierId: 'c1', currency: 'INR', defaultTaxRate: rate(1_800), clock: () => now.at, regulatedFlagsOf: () => flags() },
    new Ledger(new InMemoryLedgerStore()), new SyncOutbox(), async () => ({ committed: true }) as never,
  );
  const scanWater = (s: PosSession) => s.scan({ productId: WATER, description: 'Packaged drinking water 1L', unitPrice: money(2_000, 'INR'), quantityMinor: 1, uom: 'ea', regulatedFlags: flags() });
  it('refuses the scan once the licence has run out', () => {
    expect(() => scanWater(session({ at: '2027-01-01T06:00:00.000Z' }))).toThrow(TillRuleRefusedError);
  });
  it('a line rung while the licence was current is refused at payment once it has run out (midnight passed), before the disk', async () => {
    const now = { at: '2026-12-31T18:00:00.000Z' };
    const s = session(now);
    scanWater(s);
    now.at = '2027-01-01T00:30:00.000Z';
    await expect(s.commit('S-1', 'N-1', now.at, [{ kind: 'cash', amount: money(2_000, 'INR'), status: 'settled' }]))
      .rejects.toMatchObject({ name: 'TillRuleRefusedError', laneMessage: expect.stringMatching(/^Do not take payment\. .*BIS \(ISI mark\) licence/) });
    expect(s.currentState()).not.toBe('committed');
  });
});
