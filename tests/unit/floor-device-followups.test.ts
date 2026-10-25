import { describe, it, expect } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ReceiptNumbers } from '../../edge/store-edge/src/receipt-numbers';
import { isStoreComputerDefaultReceipt } from '../../packages/contracts/src/receipt-number';
import {
  floorDeviceSettingRoutes, effectiveFloorSettings, floorDevicePackPolicies, readFloorSettingValue, latestFloorSettings, OWNER_DECIDED_FLOOR_SETTINGS, type FloorDeviceSetting,
} from '../../services/pos/src/floor-device-settings';
import { kioskStaleAfterOf, selfCheckoutWatchOf } from '../../edge/store-edge/src/self-checkout-screens';
import { createPriceKiosk } from '../../apps/price-kiosk/src/price-kiosk';
import { handheldOfLane, foldTillPrefixes, issuedSeriesFor } from '../../services/platform/src/receipt-prefixes';
import { billOfRecord, priorCopiesIn, saleIn, BILL_COPY_EVENT } from '../../edge/store-edge/src/bill-copies';
import { committedBillOf, billCopyPrint, type BillCopyAnswer } from '../../apps/pos/src/bill-copy';
import { THRESHOLD_KINDS, thresholdBoard } from '../../services/reporting/src/owner-exceptions';
import { createOwnerAlertsSession, bpsOfPercent, ALERT_KINDS } from '../../apps/web-erp/src/owner-alerts-session';
import type { CatalogueSnapshot } from '../../packages/catalogue/src/catalogue';

// The owner's decisions of 25 Oct 2026 on the store-floor devices (OB-372 to OB-379), each pinned where it lives.

describe('OB-375 · OB-378 — the owner\'s kiosk minutes and self-checkout watch numbers', () => {
  it('start at his written decision — 1 440 minutes; 3 % of baskets over ₹2,000, 4 loose-produce lines, 3 removals — and nothing else', () => {
    expect(OWNER_DECIDED_FLOOR_SETTINGS.kiosk_stale_after).toMatchObject({ value: 1_440, decision: 'OB-375', decidedOn: '2026-10-25' });
    expect(OWNER_DECIDED_FLOOR_SETTINGS.self_checkout_watch).toMatchObject({ value: { auditRateBps: 300, auditAboveMinor: 200_000, looseProducePatternCount: 4, voidPatternCount: 3 }, decision: 'OB-378' });
    const eff = effectiveFloorSettings([]);
    expect(eff.map((e) => [e.setting, e.source, e.version, e.setBy])).toEqual([['kiosk_stale_after', 'owner_decision', 0, null], ['self_checkout_watch', 'owner_decision', 0, null]]);
    expect(floorDevicePackPolicies([])).toEqual({ kioskStaleAfterMinutes: 1_440, selfCheckoutWatch: { auditRateBps: 300, auditAboveMinor: 200_000, looseProducePatternCount: 4, voidPatternCount: 3 } });
  });

  it('the store computer reads the pack\'s policies exactly as head office writes them', () => {
    const policies = floorDevicePackPolicies([]);
    expect(kioskStaleAfterOf(policies)).toBe(1_440);
    expect(selfCheckoutWatchOf(policies)).toEqual({ auditRateBps: 300, auditAboveMinor: 200_000, looseProducePatternCount: 4, voidPatternCount: 3 });
  });

  it('the owner\'s latest entry applies; the earlier ones stay on the record', () => {
    const e = (version: number, value: number): FloorDeviceSetting => ({ setting: 'kiosk_stale_after', value, version, setBy: 'u-owner', setAt: `2026-10-2${version}T10:00:00.000Z` });
    const entries = [e(1, 720), e(2, 1_440 * 2)];
    expect(latestFloorSettings(entries).get('kiosk_stale_after')?.value).toBe(2_880);
    const kiosk = effectiveFloorSettings(entries)[0]!;
    expect(kiosk).toMatchObject({ source: 'owner_entry', value: 2_880, version: 2, setBy: 'u-owner' });
    expect(kiosk.history.map((h) => h.value)).toEqual([720, 2_880]);
    expect(floorDevicePackPolicies(entries).kioskStaleAfterMinutes).toBe(2_880);
  });

  it('refuses a value that is not one, in words', () => {
    for (const bad of [0, -5, 10_081, 1.5, '1440', null]) expect(readFloorSettingValue('kiosk_stale_after', bad).ok).toBe(false);
    expect(readFloorSettingValue('kiosk_stale_after', 1_440)).toEqual({ ok: true, value: 1_440 });
    const watch = { auditRateBps: 300, auditAboveMinor: 200_000, looseProducePatternCount: 4, voidPatternCount: 3 };
    expect(readFloorSettingValue('self_checkout_watch', watch)).toEqual({ ok: true, value: watch });
    for (const bad of [{ ...watch, auditRateBps: 10_001 }, { ...watch, auditAboveMinor: -1 }, { ...watch, looseProducePatternCount: 0 }, { ...watch, voidPatternCount: 101 }, { auditRateBps: 300 }, 5]) {
      expect(readFloorSettingValue('self_checkout_watch', bad).ok).toBe(false);
    }
  });
});

describe('OB-375 — the price kiosk with the owner\'s 24 hours: quotes at 23 h 59, refuses at 24 h 01, always says the age', () => {
  const builtAt = '2026-10-24T10:00:00.000Z';
  const snapshot: CatalogueSnapshot = {
    tenantId: 't', version: 3, builtAt,
    products: [{ productId: 'P-RICE', sku: 'RICE', name: 'Ponni rice 1kg', baseUom: 'ea', unitPriceMinor: 7_000, taxBps: 0, status: 'active' }],
    barcodes: [{ code: '890001', productId: 'P-RICE', kind: 'standard' }],
  };
  const at = (minutes: number): string => new Date(Date.parse(builtAt) + minutes * 60_000).toISOString();
  const kioskAt = (minutes: number) => createPriceKiosk({ catalogue: snapshot, staleAfterMinutes: kioskStaleAfterOf(floorDevicePackPolicies([])), now: () => at(minutes) });

  it('23 h 59 m: quotes the price, with the list\'s age', () => {
    const a = kioskAt(23 * 60 + 59).lookup('890001');
    expect(a).toMatchObject({ outcome: 'quoted', priceMinor: 7_000, minutesSincePack: 1_439 });
    expect(a.age.en).toBe('Prices from a list updated 23 hour(s) ago.');
  });

  it('24 h 01 m: quotes nothing, says "ask a colleague" in English and Tamil, and still says the age', () => {
    const a = kioskAt(24 * 60 + 1).lookup('890001');
    expect(a).toMatchObject({ outcome: 'stale', minutesSincePack: 1_441 });
    expect(a.priceMinor).toBeUndefined();
    expect(a.words.en).toBe('This kiosk\'s price list is too old to quote from. Please ask a colleague for the price.');
    expect(a.words.ta).toMatch(/ஊழியரிடம் கேளுங்கள்/);
    expect(a.age.en).toBe('Prices from a list updated 24 hour(s) ago.');
    expect(kioskAt(24 * 60 + 1).staleAfter).toBe(1_440);
  });
});

describe('OB-376 — a handheld queue till\'s lane takes a bill-number prefix like a till', () => {
  it('reads device:<id> as a handheld\'s lane, and nothing else', () => {
    expect(handheldOfLane('device:hh-q1')).toBe('hh-q1');
    expect(handheldOfLane('lane-1')).toBeUndefined();
    expect(handheldOfLane('device:')).toBeUndefined();
    expect(handheldOfLane('device:a b')).toBeUndefined();
  });
  it('the store pack carries the handheld lane\'s series beside the tills\', so its store computer numbers from it', () => {
    const issues = [
      { storeId: 'S1', tillId: 'lane-1', prefix: 'S1L1-', version: 1, setBy: 'u-owner', setAt: '2026-10-25T10:00:00.000Z' },
      { storeId: 'S1', tillId: 'device:hh-q1', prefix: 'S1Q1-', version: 1, setBy: 'u-owner', setAt: '2026-10-25T10:01:00.000Z' },
    ];
    expect(foldTillPrefixes(issues).map((t) => [t.tillId, t.prefix, t.firstNumber])).toEqual([['device:hh-q1', 'S1Q1-', 'S1Q1-000001'], ['lane-1', 'S1L1-', 'S1L1-000001']]);
    expect(issuedSeriesFor(issues, 'S1').map((s) => [s.laneId, s.prefix])).toEqual([['device:hh-q1', 'S1Q1-'], ['lane-1', 'S1L1-']]);
  });
});

describe('OB-373 — a copy of a bill by its number', () => {
  const saved = {
    id: 'S-Q1-000007', number: 'S1Q1-000007', laneId: 'device:hh-q1', cashierId: 'u-ravi', tradingDay: '2026-10-25', committedAt: '2026-10-25T05:30:00.000Z',
    lines: [{ productId: 'p-dal', quantityMinor: 1, uom: 'ea', unitPriceMinor: 12_000, lineTotalMinor: 12_000, taxRateBps: 500, hsnCode: '071310' }],
    tenders: [{ kind: 'card', amount: { minor: 12_000, currency: 'INR' }, ref: 'PAY-1', machineRef: '123456', last4: '4242' }],
    total: 12_000, netMinor: 11_429, taxMinor: 571, currency: 'INR', memberRef: 'm-secret', customerMobile: '9876543210',
    operatorVerified: { userId: 'u-ravi', seal: 'x' },
  };
  it('the box answers the bill as saved — never the customer, a member code, or a card\'s digits', () => {
    const bill = billOfRecord(saved);
    expect(bill).toMatchObject({ id: 'S-Q1-000007', number: 'S1Q1-000007', laneId: 'device:hh-q1', total: 12_000 });
    expect(bill['tenders']).toEqual([{ kind: 'card', amountMinor: 12_000, machineRef: '123456' }]);
    expect(JSON.stringify(bill)).not.toMatch(/memberRef|customerMobile|9876543210|4242|operatorVerified/);
  });
  it('finds a bill by its number or its id (the first record wins), and counts the copies already printed', () => {
    const recs = [JSON.stringify(saved), JSON.stringify({ ...saved, total: 1 }), 'not json'];
    expect(saleIn(recs, 'S1Q1-000007')?.['total']).toBe(12_000);
    expect(saleIn(recs, 'S-Q1-000007')?.['total']).toBe(12_000);
    expect(saleIn(recs, 'NOPE')).toBeUndefined();
    const ev = (copyId: string, copyNumber: number) => JSON.stringify({ type: BILL_COPY_EVENT, payload: { copyId, saleId: saved.id, copyNumber } });
    expect(priorCopiesIn([ev('C-1', 1), JSON.stringify({ type: 'TillActivityRecorded', payload: {} }), ev('C-2', 2), '{']).map((c) => c.copyNumber)).toEqual([1, 2]);
  });
  const answer: BillCopyAnswer = { copyNumber: 2, billNumber: saved.number, saleId: saved.id, billLaneId: saved.laneId, bill: billOfRecord(saved) as Record<string, unknown>, names: { 'p-dal': { name: 'Toor dal 1kg' } } };
  it('prints as the till\'s receipt marked REPRINT, with the copy number and why — the prices as saved', () => {
    const p = billCopyPrint(answer, { realTrading: false, reason: 'Paid on a handheld queue till', by: 'u-asha', at: '2026-10-25T06:00:00.000Z' });
    if (!p.ok) throw new Error(p.why);
    expect(p).toMatchObject({ number: 'S1Q1-000007', copyNumber: 2, billLaneId: 'device:hh-q1' });
    expect(p.lines.join('\n')).toMatch(/\*\*\* REPRINT \*\*\*[\s\S]*Paid on a handheld queue till — Copy 2[\s\S]*S1Q1-000007[\s\S]*Toor dal 1kg[\s\S]*120\.00/);
  });
  it('in real trading prints the tax invoice marked DUPLICATE — English and Tamil — or says what is missing', () => {
    const identity = { legalName: 'Synthetic SRE TN', gstin: '33AAACS1111A2ZG', placeOfBusiness: ['1 Main Road', 'Madurai'] };
    const en = billCopyPrint(answer, { realTrading: true, identity, reason: 'x', by: 'u-asha', at: '2026-10-25T06:00:00.000Z' });
    if (!en.ok) throw new Error(en.why);
    expect(en.lines.join('\n')).toMatch(/DUPLICATE — reprint[\s\S]*S1Q1-000007[\s\S]*Copy 2/);
    expect(en.rows?.length).toBeGreaterThan(5);
    const ta = billCopyPrint(answer, { realTrading: true, identity, language: 'ta', reason: 'x', by: 'u-asha', at: '2026-10-25T06:00:00.000Z' });
    if (!ta.ok) throw new Error(ta.why);
    expect(ta.lines.join('\n')).toMatch(/நகல் \(DUPLICATE\) — மறு அச்சு[\s\S]*நகல் எண் 2/);
    expect(billCopyPrint(answer, { realTrading: true, identity: null, reason: 'x', by: 'u', at: '2026-10-25T06:00:00.000Z' })).toMatchObject({ ok: false, why: expect.stringMatching(/^This copy cannot be printed as a tax invoice: .*The sale stands/) });
    expect(committedBillOf({ ...answer, bill: { ...answer.bill, lines: [] } }).ok).toBe(false);
  });
});

describe('OB-379 — the sixth owner alert, failed sign-ins, stays "not set" until the owner enters it', () => {
  it('is one of the six, measured as a count, and not set with no entry — never a default', () => {
    expect(THRESHOLD_KINDS).toEqual(['large_discount', 'voided_bill', 'price_override', 'after_hours_login', 'cash_short', 'failed_sign_in']);
    expect(ALERT_KINDS).toContain('failed_sign_in');
    const row = thresholdBoard([], [{ kind: 'failed_sign_in', known: true }] as never).find((r) => r.kind === 'failed_sign_in')!;
    expect(row).toMatchObject({ state: 'not_set', value: null, canFire: false });
  });
});

describe('the owner\'s page reads and sets the floor-device numbers — his alone', () => {
  it('only the owner\'s permission opens the forms; what is typed is checked before anything is sent', async () => {
    const sent: { url: string; body: unknown }[] = [];
    const fetch = (async (url: string, init?: RequestInit) => { sent.push({ url, body: init?.body === undefined ? undefined : JSON.parse(String(init.body)) }); return new Response('{}', { status: 201 }); }) as unknown as typeof globalThis.fetch;
    const owner = createOwnerAlertsSession({ viewer: { userId: 'u-owner', permissions: ['owner.alert.read', 'floor.settings.read', 'floor.settings.manage'] }, fetch, newKey: () => 'k' });
    expect(owner.may).toMatchObject({ floorRead: true, floorManage: true });
    const manager = createOwnerAlertsSession({ viewer: { userId: 'u-mgr', permissions: ['floor.settings.read'] } });
    expect(manager.may).toMatchObject({ floorRead: true, floorManage: false });
    expect(await owner.setKioskHours('0')).toMatchObject({ result: 'invalid', why: 'needKioskHours' });
    expect(await owner.setKioskHours('1.5')).toMatchObject({ result: 'invalid' });
    expect(await owner.setWatch({ pct: '101', aboveRupees: '2000', loose: '4', voids: '3' })).toMatchObject({ result: 'invalid', why: 'needWatch' });
    expect(sent).toEqual([]);
    await owner.setKioskHours('24');
    await owner.setWatch({ pct: '3', aboveRupees: '2,000', loose: '4', voids: '3' });
    expect(sent.map((s) => [s.url.replace(/^.*\/v1/, '/v1'), s.body])).toEqual([
      ['/v1/devices/floor-settings/kiosk_stale_after', { value: 1_440 }],
      ['/v1/devices/floor-settings/self_checkout_watch', { value: { auditRateBps: 300, auditAboveMinor: 200_000, looseProducePatternCount: 4, voidPatternCount: 3 } }],
    ]);
    expect([bpsOfPercent('3'), bpsOfPercent('2.5'), bpsOfPercent('100'), bpsOfPercent('100.01'), bpsOfPercent('x')]).toEqual([300, 250, 10_000, undefined, undefined]);
  });
});

describe('OB-375 · OB-378 — the owner\'s entry is append-only and audited (who, before, after)', () => {
  it('each change is a new version with an audit entry; the same value again records nothing', async () => {
    const kept: FloorDeviceSetting[] = [];
    const audits: { action: string; objectId: string; before: unknown; after: unknown; reason?: string }[] = [];
    const routes = floorDeviceSettingRoutes({
      now: () => '2026-10-25T10:00:00.000Z', settings: async () => kept.slice(), record: async (_t, s) => { kept.push(s); },
      recordAudit: async (_t, e) => { audits.push(e as never); },
    });
    const post = routes.find((r) => r.method === 'POST')!;
    const ctx = (value: unknown, reason?: string) => ({ tenantId: 't', userId: 'u-owner', params: { setting: 'kiosk_stale_after' }, query: {}, body: { value, ...(reason === undefined ? {} : { reason }) }, idempotencyKey: `k-${String(value)}` }) as never;
    expect((await post.handler(ctx(720, 'festival week'))).status).toBe(201);
    expect((await post.handler(ctx(720))).body).toMatchObject({ unchanged: true });
    expect((await post.handler(ctx(1_440))).status).toBe(201);
    expect(kept.map((k) => [k.version, k.value])).toEqual([[1, 720], [2, 1_440]]);
    expect(audits.map((a) => [a.action, a.objectId, a.before, a.after])).toEqual([
      ['floor.setting.set', 'kiosk_stale_after', { value: '1440', source: 'owner_decision', version: '0' }, { value: '720', source: 'owner_entry', version: '1' }],
      ['floor.setting.set', 'kiosk_stale_after', { value: '720', source: 'owner_entry', version: '1' }, { value: '1440', source: 'owner_entry', version: '2' }],
    ]);
    expect(audits[0]!.reason).toBe('festival week');
    expect(post.permission).toBe('floor.settings.manage');
  });
});

describe('who may do what (OB-373 · OB-375 · OB-378)', () => {
  it('only the owner enters the floor-device numbers; only the store computer (and the owner, to approve its grant) relays a bill copy', async () => {
    const { ROLE_CATALOGUE } = await import('../../services/api/src/roles');
    const holders = (p: string) => ROLE_CATALOGUE.filter((r) => r.permissions.includes(p)).map((r) => r.id).sort();
    expect(holders('floor.settings.manage')).toEqual(['owner']);
    expect(holders('floor.settings.read')).toEqual(['owner', 'store_manager']);
    expect(holders('pos.billcopy.sync')).toEqual(['owner', 'store_computer']);
  });
});

describe('OB-376 — the store computer numbers a handheld queue till\'s bills under the prefix head office issued its lane', () => {
  it('without one: its own store-coded prefix, flagged; with one: the issued prefix, never flagged — across a restart', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'sre-ob376-'));
    try {
      const state: { published: { laneId: string; prefix: string; padTo: number; rangeStart: number; rangeEnd: number; bankedThrough: number }[] | null } = { published: null };
      const open = () => ReceiptNumbers.open({ dataDir: dir, capacityBytes: 1_048_576, published: () => state.published, numbering: () => ({ storeId: 'S1', storesInBusiness: 1 }) });
      const issue = async (reg: ReceiptNumbers, key: string) => { const r = await reg.issue({ laneId: 'device:hh-q1', requestKey: key, issuedTo: 'u-ravi' }); if (!r.issued) throw new Error(r.laneMessage); return r; };
      let reg = await open();
      const before = await issue(reg, 'a');
      expect(before).toMatchObject({ source: 'store_default' });
      expect(isStoreComputerDefaultReceipt(before.receiptNumber)).toBe(true); // head office flags each such bill
      state.published = [{ laneId: 'device:hh-q1', prefix: 'S1Q1-', padTo: 6, rangeStart: 1, rangeEnd: 999_999, bankedThrough: 0 }];
      const after = await issue(reg, 'b');
      expect(after).toMatchObject({ receiptNumber: 'S1Q1-000001', source: 'published' });
      expect(isStoreComputerDefaultReceipt(after.receiptNumber)).toBe(false);
      await reg.close();
      reg = await open();
      expect(await issue(reg, 'c')).toMatchObject({ receiptNumber: 'S1Q1-000002' });
      await reg.close();
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
