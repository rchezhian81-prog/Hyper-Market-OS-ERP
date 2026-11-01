import { describe, it, expect, afterEach, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import type { ApiHarness } from '../support/api-harness';
import { TEST_PACK_KEY } from '../support/api-harness';
import { useRestartableBackings } from '../support/p3-backings';
import { STREAM } from '../../services/api/src/adapters';
import { acceptPack, type SignedPack } from '../../services/catalogue/src/pack';
import { hmacSigner } from '../../services/catalogue/src/index';
import { shopDateIn } from '../../packages/calendar/src/shop-clock';
import { CatalogueCache, UnknownBarcodeError } from '../../packages/catalogue/src/index';
import { PosSession, taxRateFromPercent, createPosView } from '../../apps/pos/src/index';
import { Ledger, InMemoryLedgerStore } from '../../packages/ledger/src/index';
import { SyncOutbox } from '../../packages/sync/src/index';

/**
 * **OB-570 "A" · M03-FR-02 — head office sets the scale-label (variable-weight barcode) rules, and they ride the SIGNED
 * pack to the tills**, through the real routes, on the in-memory store and (with DATABASE_URL) real PostgreSQL, with a cold
 * restart of head office reading the same register:
 *
 *   • the Product user (`catalogue.pack.publish`) sets "labels starting 2: item code digits 2–7, weight in grams 8–12";
 *     the change is sealed on the audit trail; a cashier may not set one;
 *   • an ambiguous pattern is refused by name (a prefix equal to, starting, or started by one in force), and so is every
 *     malformed one (a non-digit prefix, a field over the check digit or inside the prefix, overlapping fields, an unknown
 *     kind); a re-send is no new version;
 *   • the published pack carries the rule under its signature: a pack with the rule stripped fails the till's check, and a
 *     changed rule changes the signature;
 *   • ACCEPTANCE: "a variable-weight barcode rings up the correct weight and price offline" — the till's own session, built
 *     from that published pack, rings 0.850 kg of loose dal at ₹120.00/kg as ₹102.00 with every network call refused;
 *   • a withdrawn rule leaves the next pack, and the label is then refused as unknown (never guessed).
 * Synthetic data only.
 */

const backings = useRestartableBackings();
const TODAY = shopDateIn(new Date().toISOString());
const AT = new Date().toISOString();
const RULE = { itemStart: 1, itemLength: 6, valueStart: 7, valueLength: 5, valueKind: 'weight' };
const codeOf = (r: { body: unknown }): string | undefined => (r.body as { error?: { code?: string } }).error?.code;

/** The 13th digit of an EAN-13: the GS1 mod-10 check over the first twelve. */
const ean13 = (twelve: string): string => {
  const sum = [...twelve].reduce((n, d, i) => n + Number(d) * (i % 2 === 0 ? 1 : 3), 0);
  return `${twelve}${(10 - (sum % 10)) % 10}`;
};

async function shop(h: ApiHarness) {
  const T = randomUUID();
  await h.seedOwner(T, 'u-owner');
  await h.provisionRole(T, 'u-meena', 'cashier');
  const call = (method: 'GET' | 'POST', path: string, body?: unknown, userId = 'u-owner', on: ApiHarness = h) => {
    const [bare, qs] = path.split('?');
    return on.request({ method, path: bare!, userId, tenantId: T, ...(method === 'GET' ? { query: Object.fromEntries(new URLSearchParams(qs ?? '')) } : { idempotencyKey: `k-${randomUUID()}`, body: body ?? {} }) });
  };
  expect((await call('POST', '/v1/catalogue/tax-classes/0713/rates/2017-07-01', { rateBps: 0 })).status).toBeLessThan(300);
  // Loose toor dal, sold by the kg; its scale PLU (the item code a scale prints) is its SKU, 100201.
  const pub = await call('POST', '/v1/catalogue/products/p-dal-loose/publish', { product: { sku: '100201', name: 'Toor dal (loose)', baseUom: 'kg', primaryCategoryId: 'grocery', taxClass: '0713', lifecycle: 'active', handling: 'ambient' }, categories: [{ categoryId: 'grocery', name: 'Grocery', parentId: null }] });
  expect(pub.status, JSON.stringify(pub.body)).toBe(201);
  expect((await call('POST', '/v1/prices/list/p-dal-loose/entries/e1', { scope: 'store', scopeRef: 'S1', priceMinor: 12_000, mrpMinor: 12_000, costMinor: 9_000, marginFloorBps: 0, currency: 'INR', effectiveFrom: TODAY })).status).toBe(201);
  const publish = async (): Promise<SignedPack> => {
    const r = await call('POST', '/v1/catalogue/pack', { storeId: 'S1', asOf: AT });
    expect(r.status, JSON.stringify(r.body)).toBe(201);
    return (await h.store.latestOfType(T, STREAM.catalogue, 'CataloguePublished'))!.event.payload as SignedPack;
  };
  return { T, call, publish };
}

/** The till, as the lane runs it: its own session over the pack it holds, a scale with a current stamp, no network. */
function tillOn(pack: SignedPack) {
  const session = new PosSession(
    { laneId: 'lane-1', cashierId: 'u-meena', tradingDay: TODAY, currency: 'INR', defaultTaxRate: taxRateFromPercent(0),
      laneScales: { known: true, scales: [{ assetId: 'SCALE-1', reverificationDueOn: '2099-12-31' }] } },
    new Ledger(new InMemoryLedgerStore()), new SyncOutbox(),
    () => Promise.resolve({ committed: true as const, durable: true as const, detail: 'test double', laneMessage: 'Sale complete.' }),
  );
  session.setNow(AT);
  return createPosView(session, 'INR', new CatalogueCache(pack.snapshot));
}

afterEach(() => { vi.unstubAllGlobals(); });

describe.each(backings)('OB-570 "A": head office\'s scale-label rules ride the signed pack — on $name', ({ harness }) => {
  it('set by the Product user and audited; ambiguous and malformed rules refused by name; a cashier may not set one', async () => {
    const h = harness();
    const { T, call } = await shop(h);
    const set = await call('POST', '/v1/catalogue/scale-label-rules/2', { ...RULE, reason: 'the deli scale prints weight labels' });
    expect(set.status, JSON.stringify(set.body)).toBe(201);
    expect((set.body as { rule: { version: number; by: string } }).rule).toMatchObject({ version: 1, by: 'u-owner', state: 'active' });
    // A re-send of the same rule is no new version.
    const again = await call('POST', '/v1/catalogue/scale-label-rules/2', RULE);
    expect(again.status).toBe(200);
    expect((again.body as { unchanged?: boolean }).unchanged).toBe(true);

    // Ambiguous: a label starting "21" would match both rules.
    const ambiguous = await call('POST', '/v1/catalogue/scale-label-rules/21', { ...RULE, itemStart: 2, itemLength: 5 });
    expect(ambiguous.status).toBe(422);
    expect(codeOf(ambiguous)).toBe('prefix_overlaps_another_rule');
    // Malformed, each by name; nothing saved.
    for (const [prefix, body, code] of [
      ['2x', RULE, 'prefix_not_digits'],
      ['3', { ...RULE, valueLength: 6 }, 'field_overruns_the_check_digit'],
      ['3', { ...RULE, itemStart: 0 }, 'field_inside_the_prefix'],
      ['3', { ...RULE, valueStart: 5 }, 'fields_overlap'],
      ['3', { ...RULE, valueKind: 'volume' }, 'value_kind_unknown'],
      ['3', { ...RULE, valueKind: 'expiry' }, 'expiry_needs_six_digits'],
    ] as const) {
      const r = await call('POST', `/v1/catalogue/scale-label-rules/${prefix}`, body);
      expect([r.status, codeOf(r)], `${prefix} ${JSON.stringify(body)}`).toEqual([422, code]);
    }
    expect((await call('POST', '/v1/catalogue/scale-label-rules/3', { prefix: '3' })).status).toBe(400);
    // A cashier is not the Product user.
    expect((await call('POST', '/v1/catalogue/scale-label-rules/3', RULE, 'u-meena')).status).toBe(403);
    expect((await call('POST', '/v1/catalogue/scale-label-rules/2/withdrawal', {}, 'u-meena')).status).toBe(403);

    // A cold restart reads the same register: one rule in force, set by the owner.
    const read = await call('GET', '/v1/catalogue/scale-label-rules', undefined, 'u-owner', harness(h));
    expect(read.status).toBe(200);
    const rules = (read.body as { rules: { prefix: string; version: number; rule: Record<string, unknown> }[] }).rules;
    expect(rules.map((r) => [r.prefix, r.version, r.rule['valueKind']])).toEqual([['2', 1, 'weight']]);
    // Sealed on the audit trail: who, which prefix, the rule, and why.
    const trail = (await call('GET', '/v1/audit/trail?action=catalogue.scale_label_rule.set')).body as { matches: { actorId: string; objectId: string; after: Record<string, string> | null; reason?: string }[] };
    expect(trail.matches.map((m) => [m.actorId, m.objectId, m.after, m.reason])).toEqual([
      ['u-owner', '2', { prefix: '2', item: '1+6', value: '7+5', valueKind: 'weight' }, 'the deli scale prints weight labels'],
    ]);
    void T;
  }, 120_000);

  it('ACCEPTANCE: the pack carries the rule under its signature, and the till rings 0.850 kg at ₹120.00/kg as ₹102.00 offline', async () => {
    const h = harness();
    const { call, publish } = await shop(h);
    const before = await publish();
    expect(before.snapshot.embeddedRules).toBeUndefined();
    // Without the rule, a weight label is unknown at the till — refused, never guessed.
    const label = ean13('2' + '100201' + '00850');
    expect(() => tillOn(before).scanBarcode(label)).toThrow(UnknownBarcodeError);

    expect((await call('POST', '/v1/catalogue/scale-label-rules/2', RULE)).status).toBe(201);
    const pack = await publish();
    expect(pack.snapshot.embeddedRules).toEqual([{ prefix: '2', ...RULE }]);
    const signer = hmacSigner(TEST_PACK_KEY);
    expect(acceptPack({ incoming: pack, signer, tenantId: pack.snapshot.tenantId }).accepted).toBe(true);
    // The rule is under the signature: a pack with it stripped, or bent to read the weight elsewhere, fails the till's check.
    const stripped: SignedPack = { ...pack, snapshot: { ...pack.snapshot, embeddedRules: [] } };
    expect(acceptPack({ incoming: stripped, signer, tenantId: pack.snapshot.tenantId }).accepted).toBe(false);
    const bent: SignedPack = { ...pack, snapshot: { ...pack.snapshot, embeddedRules: [{ prefix: '2', ...RULE, valueKind: 'price' as const }] } };
    expect(acceptPack({ incoming: bent, signer, tenantId: pack.snapshot.tenantId }).accepted).toBe(false);

    // The till, with every network call refused: the label rings the right weight and price.
    vi.stubGlobal('fetch', () => { throw new Error('no network at the till in this test'); });
    const view = tillOn(pack);
    const out = view.scanBarcode(label);
    expect(out.qty).toBe(850);
    expect(view.basket()[0]?.qtyText).toBe('0.850 kg');
    expect(view.payableMinor()).toBe(102_00);
    vi.unstubAllGlobals();

    // A changed rule (a new version for the prefix) changes what is signed.
    expect((await call('POST', '/v1/catalogue/scale-label-rules/2', { ...RULE, valueKind: 'price' })).status).toBe(201);
    const changed = await publish();
    expect(changed.snapshot.embeddedRules).toEqual([{ prefix: '2', ...RULE, valueKind: 'price' }]);
    expect(changed.signature).not.toBe(pack.signature);
  }, 120_000);

  it('a withdrawn rule is a new event, leaves the next pack, and the label is then refused as unknown', async () => {
    const h = harness();
    const { call, publish } = await shop(h);
    expect((await call('POST', '/v1/catalogue/scale-label-rules/2', RULE)).status).toBe(201);
    expect((await publish()).snapshot.embeddedRules).toHaveLength(1);
    // OB-574: stopping a rule without a reason is refused by name, and the rule stays in force.
    for (const body of [{}, { reason: '   ' }]) {
      const unsaid = await call('POST', '/v1/catalogue/scale-label-rules/2/withdrawal', body);
      expect(unsaid.status, JSON.stringify(unsaid.body)).toBe(400);
      expect(codeOf(unsaid)).toBe('withdrawal_reason_required');
    }
    expect(((await call('GET', '/v1/catalogue/scale-label-rules')).body as { count: number }).count).toBe(1);
    const gone = await call('POST', '/v1/catalogue/scale-label-rules/2/withdrawal', { reason: 'the deli scale was replaced' });
    expect(gone.status, JSON.stringify(gone.body)).toBe(201);
    expect((gone.body as { rule: { version: number; state: string } }).rule).toMatchObject({ version: 2, state: 'withdrawn' });
    // Withdrawing what is not in force is said, never a fake success.
    expect((await call('POST', '/v1/catalogue/scale-label-rules/2/withdrawal', { reason: 'again' })).status).toBe(404);
    expect(((await call('GET', '/v1/catalogue/scale-label-rules')).body as { count: number }).count).toBe(0);
    const pack = await publish();
    expect(pack.snapshot.embeddedRules).toBeUndefined();
    expect(() => tillOn(pack).scanBarcode(ean13('2' + '100201' + '00850'))).toThrow(UnknownBarcodeError);
    // The record keeps both events (append-only) — and with the prefix free, "21" may now be set.
    expect((await call('POST', '/v1/catalogue/scale-label-rules/21', { ...RULE, itemStart: 2, itemLength: 5 })).status).toBe(201);
    const trail = (await call('GET', '/v1/audit/trail?action=catalogue.scale_label_rule.withdraw')).body as { matches: { objectId: string; before: Record<string, string> | null; after: unknown; reason?: string }[] };
    expect(trail.matches.map((m) => [m.objectId, m.before?.['valueKind'], m.after, m.reason])).toEqual([['2', 'weight', null, 'the deli scale was replaced']]);
  }, 120_000);
});
