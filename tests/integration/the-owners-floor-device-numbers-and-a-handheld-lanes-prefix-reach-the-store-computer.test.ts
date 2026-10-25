import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest';
import { backingsFor, headOffice, linkBoxTo, startBox, storePack, type Box } from '../support/till-bill-world';

/**
 * **The owner's decisions of 25 Oct 2026 on the store-floor devices, from head office to the store computer** — on the
 * in-memory store AND real PostgreSQL (DATABASE_URL), head office and the box each restarted cold.
 *
 *   • OB-375 · OB-378: head office holds the price kiosk's "stop quoting after" minutes and the self-checkout watch numbers.
 *     Until the owner enters one, each is his written decision (1 440 minutes; 3 % of baskets over ₹2,000, 4 loose-produce
 *     lines, 3 removals), said as such. Only the OWNER enters a value (a store manager reads, is refused the write: 403);
 *     each entry is a new version, the earlier kept, audited. The store pack carries both; the store computer serves them
 *     to the kiosk and the self-checkout lane, offline, and keeps them across its own cold restart.
 *   • OB-376: head office issues a handheld queue till's lane (`device:<id>`) its own bill-number prefix through the till
 *     prefix route — only for a handheld registered at that store — and the store pack carries it as that lane's series.
 *     A registered handheld with no prefix is listed (never flagged: a picker's handheld never rings a bill).
 */

const { backings, open, close } = backingsFor(process.env['DATABASE_URL']);
beforeAll(open);
afterAll(close);
const boxes: Box[] = [];
afterEach(async () => { for (const b of boxes.splice(0)) { await b.stop(); await b.remove(); } });

type Res = { status: number; body: unknown };
const codeOf = (r: Res): string | undefined => (r.body as { error?: { code?: string } }).error?.code;
const SETTINGS = { tradingDayCutoff: '00:00', staleAfterSeconds: 900, countApprovalThresholdMinor: 100_000, handoverToleranceMinor: 5_000, cashVarianceToleranceMinor: 5_000, privacySlaDays: 15, warehouseId: 'B1' };
const DECIDED_WATCH = { auditRateBps: 300, auditAboveMinor: 200_000, looseProducePatternCount: 4, voidPatternCount: 3 };
const globalOf = (html: string, name: string): unknown => {
  const m = new RegExp(`<script>window\\.${name} = ([\\s\\S]*?);</script>`).exec(html);
  return m === null ? undefined : JSON.parse(m[1]!) as unknown;
};

describe.each(backings)('the owner\'s floor-device numbers and a handheld lane\'s prefix — on $name', (backing) => {
  it('decided values first; the owner alone changes them; the pack carries them to the box; a handheld lane gets its prefix', async () => {
    const ho = await headOffice(backing, [{ userId: 'u-box', role: 'store_computer', stores: ['B1'] }, { userId: 'u-mgr', role: 'store_manager', stores: ['B1'] }]);
    await ho.ok('POST', '/v1/org/nodes/SRE', 'u-owner', { kind: 'company', name: 'SRE Hyper Market Private Limited' });
    await ho.ok('POST', '/v1/org/nodes/B1', 'u-owner', { kind: 'branch', name: 'Store B1', parentId: 'SRE', companyId: 'SRE' });
    await ho.ok('POST', '/v1/stores/B1/settings', 'u-owner', SETTINGS);

    // ── OB-375 · OB-378: the owner's written decisions apply until he enters another ─────────────────────────────
    type Setting = { setting: string; value: unknown; source: string; decision: string; version: number; setBy: string | null; history: unknown[] };
    const read = async (who = 'u-owner') => {
      const r = await ho.call('GET', '/v1/devices/floor-settings', who, undefined, undefined, who === 'u-owner' ? undefined : 'B1');
      expect(r.status, JSON.stringify(r.body)).toBe(200);
      return (r.body as { settings: Setting[] }).settings;
    };
    expect((await read()).map((s) => [s.setting, s.value, s.source, s.decision])).toEqual([
      ['kiosk_stale_after', 1_440, 'owner_decision', 'OB-375'], ['self_checkout_watch', DECIDED_WATCH, 'owner_decision', 'OB-378'],
    ]);
    // The manager reads them; only the owner writes (403), and a value that is not one is refused by name.
    expect((await read('u-mgr'))[0]!.value).toBe(1_440);
    expect((await ho.call('POST', '/v1/devices/floor-settings/kiosk_stale_after', 'u-mgr', { value: 720 }, undefined, 'B1')).status).toBe(403);
    expect((await ho.call('GET', '/v1/devices/floor-settings', 'u-box', undefined, undefined, 'B1')).status).toBe(403);
    expect(codeOf(await ho.call('POST', '/v1/devices/floor-settings/kiosk_stale_after', 'u-owner', { value: 0 }))).toBe('not_readable_as_a_floor_setting');
    expect(codeOf(await ho.call('POST', '/v1/devices/floor-settings/nothing', 'u-owner', { value: 5 }))).toBe('no_such_floor_setting');

    // The pack carries the decided values; the store computer serves them to its kiosk and its self-checkout lane.
    const link = linkBoxTo(ho, 'u-box', 'B1');
    try {
      const box = await startBox({ tenantId: ho.tenantId, people: [{ userId: 'u-attend', displayName: 'Attendant' }], pack: storePack('B1'), cloud: { boxUser: 'u-box', storeId: 'B1' }, env: { EDGE_SCREEN_PORT: '0', EDGE_APPS_DIR: 'apps', EDGE_STORE_PACK_SOURCE: 'head-office', EDGE_STORE_ID: 'B1' } });
      boxes.push(box);
      expect(await box.edge.refreshStorePack!()).toMatchObject({ status: 'updated' });
      const screens = async (path: string) => (await fetch(`http://127.0.0.1:${box.edge.screens!.port}${path}`)).text();
      expect(globalOf(await screens('/price-kiosk/'), 'priceKiosk')).toEqual({ staleAfterMinutes: 1_440 });
      expect(globalOf(await screens('/self-checkout/'), 'selfCheckoutWatch')).toEqual(DECIDED_WATCH);

      // The owner enters 12 hours: a new version, the decision still on the record; the same value again records nothing.
      expect((await ho.call('POST', '/v1/devices/floor-settings/kiosk_stale_after', 'u-owner', { value: 720, reason: 'prices change twice a day in the festival week' })).status).toBe(201);
      expect((await ho.call('POST', '/v1/devices/floor-settings/kiosk_stale_after', 'u-owner', { value: 720 })).body).toMatchObject({ unchanged: true });
      ho.restartCold(); // ── head office COLD ──
      const kiosk = (await read())[0]!;
      expect(kiosk).toMatchObject({ value: 720, source: 'owner_entry', version: 1, setBy: 'u-owner' });
      expect(kiosk.history).toHaveLength(1);
      // The box takes the new number on its next pull, and keeps it across its own cold restart (offline).
      expect((await box.edge.refreshStorePack!()).status).toBe('updated');
      link.online = false;
      await box.restartCold();
      expect(globalOf(await screens('/price-kiosk/'), 'priceKiosk')).toEqual({ staleAfterMinutes: 720 });
      link.online = true;

      // ── OB-376: a handheld queue till's lane gets its own prefix, like a till ──────────────────────────────────────
      await ho.ok('POST', '/v1/platform/devices/hh-q1/register', 'u-owner', { branchId: 'B1', kind: 'handheld', label: 'Queue till 1' });
      await ho.ok('POST', '/v1/platform/devices/hh-p1/register', 'u-owner', { branchId: 'B1', kind: 'handheld', label: 'Picker 1' });
      expect(codeOf(await ho.call('POST', '/v1/stores/B1/tills/device:hh-zz/receipt-prefix', 'u-owner', { prefix: 'B1Q9-' }))).toBe('not_a_handheld_of_this_store');
      expect(codeOf(await ho.call('POST', '/v1/stores/B1/tills/device:/receipt-prefix', 'u-owner', { prefix: 'B1Q9-' }))).toBe('not_readable_as_a_till');
      expect((await ho.call('POST', '/v1/stores/B1/tills/device:hh-q1/receipt-prefix', 'u-owner', { prefix: 'B1Q1-' })).status).toBe(201);
      // Never shared with a till: the same prefix to lane-1 is refused by name.
      expect(codeOf(await ho.call('POST', '/v1/stores/B1/tills/lane-1/receipt-prefix', 'u-owner', { prefix: 'B1Q1-' }))).toBe('receipt_prefix_taken');
      ho.restartCold(); // ── head office COLD ──
      const prefixes = await ho.ok('GET', '/v1/receipt-prefixes', 'u-owner') as { tills: { tillId: string; prefix: string }[]; needsPrefix: { tillId: string; flagged: boolean; why: string }[] };
      expect(prefixes.tills.map((t) => [t.tillId, t.prefix])).toEqual([['device:hh-q1', 'B1Q1-']]);
      expect(prefixes.needsPrefix.filter((n) => n.tillId.startsWith('device:')).map((n) => [n.tillId, n.flagged])).toEqual([['device:hh-p1', false]]);
      // The store pack carries the handheld lane's series, as it does a till's.
      const pack = await ho.ok('GET', '/v1/store-packs/B1', 'u-owner') as { sections: { receiptSeries?: { laneId: string; prefix: string }[]; policies: Record<string, unknown> } };
      expect(pack.sections.receiptSeries?.map((s) => [s.laneId, s.prefix])).toEqual([['device:hh-q1', 'B1Q1-']]);
      expect(pack.sections.policies).toMatchObject({ kioskStaleAfterMinutes: 720, selfCheckoutWatch: DECIDED_WATCH });
    } finally {
      link.restore();
    }
  }, 120_000);
});
