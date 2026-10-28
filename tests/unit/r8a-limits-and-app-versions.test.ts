import { describe, it, expect } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { authorityFrom, DECIDED_AUTHORITY_LIMITS } from '../../packages/approvals/src/authority-rules';
import { judgeTillOverride, readTillControls, ownerOnlyWords, type TillControls } from '../../packages/price-guard/src/till-override';
import { TillApprovals } from '../../edge/store-edge/src/till-approvals';
import { acceptSale, type IncomingSale, type IntakeContext } from '../../services/pos/src/index';
import type { CatalogueProduct } from '../../packages/catalogue/src/catalogue';
import { judgeClientVersion, openNewWorkGate, bindNewWorkGate, NewWorkRefusedError, type GateStorage } from '../../packages/platform-admin/src/client-version';
import { PickSession } from '../../apps/picker-app/src/pick-session';
import { RouteSession, type StopInput } from '../../apps/delivery-app/src/index';
import { WarehouseSession, FEEDBACK_CODES, APP_VERSION_TOO_OLD } from '../../apps/warehouse-app/src/warehouse-session';
import { DsdDoorSession, DSD_FEEDBACK_CODES } from '../../apps/warehouse-app/src/dsd-door';
import { bootOwner } from '../../apps/owner-app/src/browser-entry';
import { OWNER_DECIDE_REFUSALS } from '../../apps/owner-app/src/owner-session';
import { APPROVE_REASONS } from '../../packages/approvals/src/reasons';
import { bootShop, forgetfulBasket, type ShopData } from '../../apps/customer-app/src/browser-entry';
import type { ShopTransport, ShopAnswer } from '../../apps/customer-app/src/shop-transport';
import { createScanAndGo } from '../../apps/customer-app/src/scan-and-go';
import { bootPos } from '../../apps/pos/src/browser-entry';
import { payloadFor, VERSION_GATED_SCREENS } from '../../edge/store-edge/src/screen-data';
import { emptyPack, type StorePack } from '../../edge/store-edge/src/store-pack';
import { SyncOutbox } from '../../packages/sync/src/outbox';
import { money } from '../../packages/contracts/src/money';

// R8-A · OB-519 (a store manager may approve a till price cut of up to ₹100 a line), OB-520 (a product with no known floor:
// only the owner may approve a cut — on the till, the store computer offline, and head office's re-check) and OB-521 (the
// OB-501 version rule on the handhelds and the phone apps: the work in hand is finished, new work is refused, in English
// and Tamil; the handhelds learn the policy from the store computer).

const AT = '2026-10-28T10:00:00.000Z';
const POLICY = { currentVersion: '2.1.0', previousVersion: '2.0.0', minimumSupportedVersion: '2.0.0', killedVersions: ['2.0.3'] };
const OLD = '1.9.9';

describe('OB-519 — a store manager may take up to ₹100 off a line at the till; more needs the owner', () => {
  const CONTROLS: TillControls = { floors: { 'p-ghee': 50_000 }, floorsNotKnown: [], overrideLimits: { 'u-mgr': { state: 'limit', limitMinor: 10_000 } }, limitsVersion: 0, ownerApprovers: ['u-owner'] };
  it('the decided ladder gives the store manager ₹100 for a price cut; ₹100.00 passes, ₹100.01 is refused; the floor still applies', () => {
    expect(DECIDED_AUTHORITY_LIMITS.byRole['store_manager']?.price_override).toBe(10_000);
    expect(authorityFrom({ limits: DECIDED_AUTHORITY_LIMITS, rulesVersion: 0, userId: 'u-mgr', roleIds: ['store_manager'], subjectType: 'price_override' })).toMatchObject({ state: 'limit', limitMinor: 10_000 });
    // Other roles keep "not set"; the owner stays unlimited.
    expect(authorityFrom({ limits: DECIDED_AUTHORITY_LIMITS, rulesVersion: 0, userId: 'u-c', roleIds: ['cashier'], subjectType: 'price_override' })).toMatchObject({ state: 'not_set' });
    expect(authorityFrom({ limits: DECIDED_AUTHORITY_LIMITS, rulesVersion: 0, userId: 'u-o', roleIds: ['owner'], subjectType: 'price_override' })).toMatchObject({ state: 'unlimited' });
    const j = (to: number, cut: number) => judgeTillOverride({ controls: CONTROLS, productId: 'p-ghee', toUnitMinor: to, reductionMinor: cut, approverId: 'u-mgr' });
    expect(j(54_000, 10_000)).toMatchObject({ ok: true });
    expect(j(53_999, 10_001)).toMatchObject({ ok: false, refusedBecause: 'above_limit' });
    expect(j(49_999, 1)).toMatchObject({ ok: false, refusedBecause: 'below_floor' });
  });
});

describe('OB-520 — no known floor: only the owner may approve a cut', () => {
  const CONTROLS: TillControls = {
    floors: { 'p-ghee': 50_000 }, floorsNotKnown: ['p-new'],
    overrideLimits: { 'u-mgr': { state: 'limit', limitMinor: 10_000 }, 'u-owner': { state: 'unlimited', limitMinor: null }, 'u-boss': { state: 'unlimited', limitMinor: null } },
    limitsVersion: 0, ownerApprovers: ['u-owner'],
  };

  it('the pure rule: a manager is refused (English and Tamil) even within the limit; an unlimited non-owner too; the owner passes; a raise is not a cut', () => {
    const j = (approverId: string, cut: number) => judgeTillOverride({ controls: CONTROLS, productId: 'p-new', toUnitMinor: 1_000, reductionMinor: cut, approverId, approverName: 'Ravi' });
    const mgr = j('u-mgr', 500);
    expect(mgr).toMatchObject({ ok: false, refusedBecause: 'floor_not_known_owner_only', floorMinor: null });
    expect(mgr.ok ? '' : mgr.words.en).toMatch(/no known lowest price.*only the owner can approve a price cut of ₹5\.00/);
    expect(mgr.ok ? '' : mgr.words.ta).toContain('உரிமையாளர் மட்டுமே');
    expect(j('u-boss', 500)).toMatchObject({ ok: false, refusedBecause: 'floor_not_known_owner_only' });
    expect(j('u-owner', 99_999)).toMatchObject({ ok: true, floorMinor: null });
    expect(j('u-mgr', 0)).toMatchObject({ ok: true });
    // A product the pack names nowhere is treated as having no known floor (never "anything goes").
    expect(judgeTillOverride({ controls: CONTROLS, productId: 'p-unlisted', toUnitMinor: 1, reductionMinor: 1, approverId: 'u-mgr' })).toMatchObject({ ok: false, refusedBecause: 'floor_not_known_owner_only' });
    // A pack that names no owner: nobody may cut such a product (default deny).
    expect(judgeTillOverride({ controls: { ...CONTROLS, ownerApprovers: [] }, productId: 'p-new', toUnitMinor: 1, reductionMinor: 1, approverId: 'u-owner' })).toMatchObject({ ok: false });
    expect(readTillControls({ floors: {}, overrideLimits: {}, ownerApprovers: ['u-owner', 7, ''] })?.ownerApprovers).toEqual(['u-owner']);
    expect(ownerOnlyWords().en).not.toContain(' of ');
  });

  it('the store computer refuses a manager\'s approval after the PIN, in both languages, and grants the owner\'s', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'sre-r8a-'));
    try {
      const people: Record<string, string> = { 'u-mgr': '111111', 'u-owner': '333333' };
      const approvals = await TillApprovals.open({
        dataDir: dir, capacityBytes: 1_000_000, approvalThresholdMinor: () => 0, tillControls: () => CONTROLS, now: () => AT,
        operators: {
          check: () => ({ ok: true, userId: 'u-cash', via: 'pin' }) as never,
          verifyPerson: async ({ staffId, pin }) => (people[staffId] === pin ? { ok: true, userId: staffId, displayName: staffId } : { ok: false, refusedBecause: 'wrong_pin' as never, laneMessage: 'Wrong PIN.' }),
        },
      });
      const ask = (managerId: string) => approvals.grant({ token: 't', laneId: 'lane-1', managerId, pin: people[managerId]!, kind: 'price_override', billRef: 'B-1', valueMinor: 500, reason: 'damaged_pack', productId: 'p-new', toUnitMinor: 1_000, lineId: 'L1', fromUnitMinor: 1_500, quantityMinor: 1, uom: 'each' });
      const mgr = await ask('u-mgr');
      expect(mgr).toMatchObject({ approved: false, refusedBecause: 'floor_not_known_owner_only' });
      expect((mgr as { laneMessageTa?: string }).laneMessageTa).toContain('உரிமையாளர்');
      expect(await ask('u-owner')).toMatchObject({ approved: true, approvedBy: 'u-owner' });
    } finally { await rm(dir, { recursive: true, force: true }); }
  });

  it('the till tells the cashier only the owner can approve, before anyone is asked (the box decides)', () => {
    const till = bootPos({ laneId: 'lane-1', taxPercent: 0, priceFloors: { 'p-ghee': 50_000 } });
    till.scan({ productId: 'p-new', description: 'New soap', unitPriceMinor: 2_000, qty: 1 });
    till.scan({ productId: 'p-ghee', description: 'Ghee', unitPriceMinor: 64_000, qty: 1 });
    const [soap, ghee] = till.basket();
    expect(till.priceChangeValue(soap!.lineId, 1_500)).toMatchObject({ ok: true, ownerOnly: true });
    expect(till.priceChangeValue(ghee!.lineId, 55_000)).not.toHaveProperty('ownerOnly');
  });

  it('head office raises a cut on a floorless product approved by anyone but the owner — the sale stands', () => {
    const CATALOGUE = new Map<string, CatalogueProduct>([['p-new', { productId: 'p-new', sku: 'NEW', name: 'New soap', baseUom: 'each', unitPriceMinor: 2_000, taxBps: 0, mrpMinor: 2_000, status: 'active' }]]);
    const sale = (approvedBy: string): IncomingSale => ({
      saleId: 'S-1', receiptNumber: 'R-1', laneId: 'lane-1', cashierId: 'u-cash', tradingDay: '2026-10-28', committedAt: AT,
      totalMinor: 1_500, currency: 'INR', packVersion: 3, tenders: [{ kind: 'cash', amountMinor: 1_500 }],
      lines: [{ productId: 'p-new', quantityMinor: 1, uom: 'each', unitPriceMinor: 1_500, lineTotalMinor: 1_500, priceOverride: { fromUnitPriceMinor: 2_000, approvedBy, activityId: 'O-1' } }],
    });
    const ctx: IntakeContext = {
      catalogue: CATALOGUE, currentPackVersion: 3, saleHoldingThisReceipt: undefined, alreadyBanked: false, now: AT,
      tillOverrideRules: { floors: new Map(), limits: new Map([['u-mgr', { state: 'limit', limitMinor: 10_000 }], ['u-owner', { state: 'unlimited', limitMinor: null }]]), floorsNotKnown: new Set(['p-new']), owners: new Set(['u-owner']) },
    };
    const cuts = (r: ReturnType<typeof acceptSale>) => r.exceptions.filter((e) => e.kind.startsWith('price_cut')).map((e) => [e.kind, e.severity, e.differenceMinor]);
    const byMgr = acceptSale(sale('u-mgr'), ctx);
    expect(byMgr.banked).toBe(true);
    expect(cuts(byMgr)).toEqual([['price_cut_without_floor_not_by_owner', 'material', 500]]);
    expect(cuts(acceptSale(sale('u-owner'), ctx))).toEqual([]);
  });
});

describe('OB-521 — each app names itself; the gate keeps the last policy on the device', () => {
  it('words per app, in English and Tamil, naming the work it may not start and the work it finishes', () => {
    const expectWords: Record<string, [RegExp, string]> = {
      queue_till: [/queue till.*1\.9\.9.*too old.*Finish the basket on screen; a new basket cannot be started/, 'புதிய கூடை தொடங்க முடியாது'],
      warehouse: [/warehouse handheld.*Finish the work you have already started; new work cannot be started/, 'புதிய வேலை தொடங்க முடியாது'],
      picker: [/picking handheld.*a new wave cannot be started/, 'புதிய தொகுப்பைத் தொடங்க முடியாது'],
      driver: [/delivery phone.*a new route cannot be started/, 'புதிய பயணத்தைத் தொடங்க முடியாது'],
      owner_app: [/owner app.*Decisions you already made are kept; a new decision cannot be made here/, 'புதிய முடிவு எடுக்க முடியாது'],
      customer_app: [/shopping app.*Orders you already sent are kept.*a new order cannot be started/, 'புதிய ஆர்டரைத் தொடங்க முடியாது'],
    };
    for (const [client, [en, ta]] of Object.entries(expectWords)) {
      const j = judgeClientVersion(OLD, POLICY, client as never);
      expect(j, client).toMatchObject({ verdict: 'upgrade_required', mayStartWork: false, mayStartBill: false });
      expect(j.words!.en, client).toMatch(en);
      expect(j.words!.ta, client).toContain(ta);
    }
    expect(judgeClientVersion('2.0.3', POLICY, 'picker').words!.en).toContain('withdrawn by head office');
    // The till's own words are unchanged.
    expect(judgeClientVersion(OLD, POLICY).words!.en).toContain('Finish the bill on screen');
    expect(judgeClientVersion('2.0.1', POLICY, 'driver')).toMatchObject({ mayStartWork: true });
  });

  it('starts from what was served, else the device\'s copy; an applied policy is kept; unreadable storage leaves it in memory', () => {
    const mem = new Map<string, string>();
    const storage: GateStorage = { getItem: (k) => mem.get(k) ?? null, setItem: (k, v) => { mem.set(k, v); } };
    const first = openNewWorkGate({ client: 'picker', appVersion: OLD, storage, key: 'k', served: POLICY });
    expect(first.refusal()?.en).toContain('picking handheld');
    // A reload with no signal (nothing served): the device's copy holds the rule.
    expect(openNewWorkGate({ client: 'picker', appVersion: OLD, storage, key: 'k' }).refusal()).toBeDefined();
    // The source says it has none (`null`): lifted, and kept so.
    first.apply(null);
    expect(first.refusal()).toBeUndefined();
    expect(openNewWorkGate({ client: 'picker', appVersion: OLD, storage, key: 'k' }).refusal()).toBeUndefined();
    const broken: GateStorage = { getItem: () => { throw new Error('blocked'); }, setItem: () => { throw new Error('blocked'); } };
    const g = openNewWorkGate({ client: 'picker', appVersion: OLD, storage: broken, key: 'k', served: POLICY });
    expect(g.refusal()).toBeDefined();
    expect(openNewWorkGate({ client: 'picker', appVersion: OLD, storage: broken, key: 'k' }).refusal()).toBeUndefined();
  });
});

describe('OB-521 — the handhelds finish the work in hand and start no new work', () => {
  const line = (lineId: string, orderRef = 'ORD-1') => ({ lineId, orderRef, productId: `p-${lineId}`, description: lineId, bin: `B-${lineId}`, requiredQty: 1, uom: 'ea' as const, unitPrice: money(1_000, 'INR') });
  const barred = () => judgeClientVersion(OLD, POLICY, 'picker').words!;

  it('picker: a wave not yet started is refused at its first outcome; a wave already started is finished; lifting the bar opens it', () => {
    const outbox = new SyncOutbox();
    const fresh = new PickSession('W-1', [line('a'), line('b')], outbox, { now: () => AT });
    const gate = bindNewWorkGate(openNewWorkGate({ client: 'picker', appVersion: OLD, key: 'k', served: POLICY }), [fresh]);
    fresh.scanBin('B-a');
    let e: unknown;
    try { fresh.pick('a', 'p-a', 1); } catch (x) { e = x; }
    expect(e).toBeInstanceOf(NewWorkRefusedError);
    expect((e as NewWorkRefusedError).laneMessageTa).toContain('தொகுப்பை');
    expect(() => fresh.markUnavailable('a', 'out_of_stock')).toThrow(NewWorkRefusedError);
    expect(outbox.all()).toEqual([]);
    gate.apply(null);
    fresh.pick('a', 'p-a', 1);
    gate.apply(POLICY); // the bar returns mid-wave: the wave is finished
    fresh.scanBin('B-b');
    fresh.pick('b', 'p-b', 1);
    expect(fresh.progress().complete).toBe(true);
    // A wave started on this handheld before a reload (its outcomes are in the device queue) is in hand too.
    const reopened = new PickSession('W-1', [line('a'), line('b')], outbox, { now: () => AT });
    reopened.barNewWork(barred());
    expect(reopened.started()).toBe(true);
  });

  it('driver: the first step of a route is refused; a route under way is finished, cash and hand-over included', () => {
    const STOPS: StopInput[] = [{ stopId: 's1', orderRef: 'ORD-1', area: 'Anna Nagar', codMinor: 0, costMinor: 40_00, orderValueMinor: 250_00 }, { stopId: 's2', orderRef: 'ORD-2', area: 'Gandhipuram', codMinor: 0, costMinor: 30_00, orderValueMinor: 1_000_00 }];
    const outbox = new SyncOutbox();
    const route = new RouteSession('R-1', 'u-drv', STOPS, outbox, { now: () => AT, collections: [{ returnId: 'RET-1', orderRef: 'ORD-9', area: 'Peelamedu', lines: [{ productId: 'p1', quantityMinor: 1 }] } as never] });
    route.barNewWork(judgeClientVersion(OLD, POLICY, 'driver').words!);
    expect(() => route.depart('s1')).toThrow(NewWorkRefusedError);
    expect(() => route.notCollected('RET-1', 'customer_not_available' as never)).toThrow(NewWorkRefusedError);
    expect(outbox.all()).toEqual([]);
    route.barNewWork(null);
    route.depart('s1');
    route.barNewWork(judgeClientVersion(OLD, POLICY, 'driver').words!);
    route.depart('s2'); // the route is under way: finished
    expect(route.started()).toBe(true);
    expect(() => route.handOver({ countedMinor: 0, at: AT, toleranceMinor: 100 })).not.toThrow();
  });

  it('warehouse: each START is refused with a bilingual signal and queues nothing; the rest of a delivery already begun is finished', () => {
    const PACKS = [{ productId: 'p-det', baseUom: 'ea', levels: [{ level: 'unit', containsMinor: 1, barcode: '890DET' }] }];
    const outbox = new SyncOutbox();
    const s = new WarehouseSession({
      assignmentId: 'A-1', workerId: 'u-back', storeId: 'S1', bins: [], grnId: 'g-1',
      barcodes: [{ barcode: '890DET', productId: 'p-det', level: 'unit' }], packs: PACKS as never,
      transfers: { asAt: AT, ageMinutes: 1, storeId: 'S1', toSend: [{ transferId: 't-out', state: 'approved', fromLocationId: 'S1', toLocationId: 'S2', requestedBy: 'u-owner', lines: [{ productId: 'p-det', batchId: null, quantityMinor: 1, uom: 'EA' }] }], toCountIn: [] },
    }, outbox, { now: () => AT });
    // Received one before the rule changed — that delivery is in hand.
    expect(s.receive({ commandId: 'c-1', grnId: 'g-1', barcode: '890DET', scannedQuantity: 1, source: 'po' }).result.accepted).toBe(true);
    s.barNewWork(judgeClientVersion(OLD, POLICY, 'warehouse').words!);
    const queued = outbox.all().length;
    const fresh = s.receive({ commandId: 'c-2', grnId: 'g-2', barcode: '890DET', scannedQuantity: 1, source: 'po' });
    expect(fresh.result).toMatchObject({ accepted: false, outcome: 'app_version_too_old' });
    expect(fresh.signal).toMatchObject({ feedback: 'reject', code: APP_VERSION_TOO_OLD });
    expect(fresh.signal.detailTa).toContain('புதிய வேலை');
    expect(s.sendTransfer({ transferId: 't-out', at: AT }).signal.code).toBe(APP_VERSION_TOO_OLD);
    expect(s.countBin({ countId: 'k-1', scannedBinId: 'B1', scannedItem: '890DET', countedMinor: 1, at: AT } as never).signal.code).toBe(APP_VERSION_TOO_OLD);
    expect(s.countForPlan({ countId: 'k-2', planId: 'P-1', scannedBinId: 'B1', scannedItem: '890DET', countedMinor: 1, at: AT } as never).signal.code).toBe(APP_VERSION_TOO_OLD);
    expect(s.requestAdjustment({ requestId: 'r-1', scannedItem: '890DET', deltaMinor: -1, reasonCode: 'damaged', at: AT } as never).signal.code).toBe(APP_VERSION_TOO_OLD);
    expect(s.issueToFloor({ commandId: 'i-1', indentId: 'IND-1', productId: 'p-det', scannedBinId: 'B1', at: AT } as never).signal.code).toBe(APP_VERSION_TOO_OLD);
    expect(s.pick({ commandId: 'pk-1', lineId: 'L-1', scannedBinId: 'B1', at: AT } as never).signal.code).toBe(APP_VERSION_TOO_OLD);
    expect(outbox.all()).toHaveLength(queued);
    // The delivery already begun here: more of it is received, and it is completed.
    expect(s.receive({ commandId: 'c-3', grnId: 'g-1', barcode: '890DET', scannedQuantity: 1, source: 'po' }).result.accepted).toBe(true);
    expect(s.completeReceiving({ grnId: 'g-1', at: AT } as never).signal.code).not.toBe(APP_VERSION_TOO_OLD);
    expect(FEEDBACK_CODES).toContain(APP_VERSION_TOO_OLD);
  });

  it('warehouse door: a new direct-delivery check-in is refused; one already open is finished', () => {
    const dsd = new DsdDoorSession({ workerId: 'u-back', storeId: 'S1', barcodes: [{ barcode: '890DET', productId: 'p-det', level: 'unit' }] as never, openDeliveries: [{ poId: 'PO-1', number: 'PO-1', supplierId: 'sup-1', ordered: [{ productId: 'p-det', quantityMinor: 2, unitCost: { minor: 100 } }] }] }, new SyncOutbox(), () => AT);
    expect(dsd.start({ checkInId: 'D-1', poId: 'PO-1', driverName: 'Kumar' }).code).toBe('dsd_started');
    dsd.barNewWork(judgeClientVersion(OLD, POLICY, 'warehouse').words!);
    expect(dsd.scan('sc-1', '890DET').code).toBe('dsd_scanned');
    expect(DSD_FEEDBACK_CODES).toContain('app_version_too_old');
    const fresh = new DsdDoorSession({ workerId: 'u-back', storeId: 'S1', openDeliveries: [{ poId: 'PO-1', number: 'PO-1', supplierId: 'sup-1', ordered: [] }] }, new SyncOutbox(), () => AT);
    fresh.barNewWork(judgeClientVersion(OLD, POLICY, 'warehouse').words!);
    const refused = fresh.start({ checkInId: 'D-2', poId: 'PO-1', driverName: 'Kumar' });
    expect(refused).toMatchObject({ feedback: 'reject', code: 'app_version_too_old' });
    expect(refused.detailTa).toContain('கிடங்கு');
  });

  it('queue till: the basket on screen is finished; a new basket is refused in the queue till\'s own words', () => {
    const t = bootPos({ laneId: 'device:q1', taxPercent: 0, appVersion: OLD, clientKind: 'queue_till' });
    t.scan({ productId: 'p', description: 'Rice', unitPriceMinor: 1_000, qty: 1 });
    expect(t.applyVersionPolicy(POLICY)).toMatchObject({ mayStartWork: false });
    t.scan({ productId: 'p2', description: 'Dal', unitPriceMinor: 1_000, qty: 1 }); // in hand
    expect(t.basket()).toHaveLength(2);
    t.newSale();
    let e: { laneMessage?: string; laneMessageTa?: string } | undefined;
    try { t.scan({ productId: 'p', description: 'Rice', unitPriceMinor: 1_000, qty: 1 }); } catch (x) { e = x as typeof e; }
    expect(e?.laneMessage).toMatch(/queue till.*a new basket cannot be started/);
    expect(e?.laneMessageTa).toContain('கூடை');
  });

  it('the store computer serves the policy with each handheld\'s and phone app\'s work (null when its pack has none)', () => {
    expect([...VERSION_GATED_SCREENS].sort()).toEqual(['customer', 'driver', 'owner', 'picker', 'warehouse']);
    const known = <T>(value: T) => ({ known: true as const, value });
    const pack = (versionPolicy: StorePack['versionPolicy']): StorePack => ({
      ...emptyPack(), versionPolicy,
      policies: known({ storeId: 'S1', branchName: 'SRE', staleAfterSeconds: 300, privacySlaDays: 15 }) as never,
    });
    const input = (p: StorePack) => ({ pack: p, sales: [], tradingDay: '2026-10-28', now: AT }) as never;
    const withPolicy = payloadFor('owner', input(pack(known(POLICY))));
    expect(withPolicy).toMatchObject({ appVersionPolicy: POLICY, branches: [expect.anything()] });
    expect(payloadFor('owner', input(pack({ known: false, why: 'never told' } as never)))).toMatchObject({ appVersionPolicy: null });
    // A screen with nothing to give still gives nothing (never a payload made only of the policy).
    expect(payloadFor('picker', input(pack(known(POLICY))))).toBeNull();
  });
});

describe('OB-521 — the phone apps', () => {
  it('owner app: no new decision on a withdrawn or too-old build (bilingual words come from the gate); queued decisions stay', () => {
    const data = { ownerId: 'u-owner', staleAfterSeconds: 300, branches: [{ branchId: 'b1', name: 'SRE', lastSyncedAt: new Date().toISOString(), sales: [], exceptions: [], approvals: [{ id: 'a1', subjectType: 'price_change', subjectRef: 'Dal', requestedBy: 'u-buyer', valueMinor: 45_000 }, { id: 'a2', subjectType: 'price_change', subjectRef: 'Oil', requestedBy: 'u-buyer', valueMinor: 5_000 }] }] };
    let saved: unknown[] = [];
    const store = { read: () => [], write: (d: readonly unknown[]) => { saved = [...d]; } };
    const gate = openNewWorkGate({ client: 'owner_app', appVersion: OLD, key: 'k' });
    const session = bootOwner(data as never, store as never, undefined, gate)!;
    expect(session.decide({ requestId: 'a1', decision: 'approved', reasonCode: APPROVE_REASONS[0]! })).toMatchObject({ ok: true });
    gate.apply(POLICY);
    expect(session.decide({ requestId: 'a2', decision: 'approved', reasonCode: APPROVE_REASONS[0]! })).toEqual({ ok: false, refusal: 'app_version_too_old' });
    expect(saved).toHaveLength(1);
    expect(session.queued()).toHaveLength(1);
    expect(gate.refusal()?.ta).toContain('புதிய முடிவு');
    expect(OWNER_DECIDE_REFUSALS).toContain('app_version_too_old');
  });

  const PRODUCTS = [{ productId: 'p1', name: 'Toor dal 1kg', categoryId: 'grocery', unitPriceMinor: 145_00, uom: 'ea', barcodes: ['8901234567890'], status: 'active', availableMinor: 10, availabilityAgeMinutes: 2 }];
  const data: ShopData = {
    tenantId: 't1', customerRef: 'c1', products: PRODUCTS as never, packVersion: 7, locationId: 'L1',
    slots: [{ slotId: 'today-evening', startsAt: '2026-10-28T17:00:00.000Z', endsAt: '2026-10-28T19:00:00.000Z', capacity: 5, booked: 0, kind: 'delivery' }],
    storeLocation: { lat: 11.0, lon: 77.0 }, deliveryLocation: { lat: 11.001, lon: 77.001 }, deliveryFeeMinor: 40_00,
  };

  it('customer app: head office is asked for the policy before a NEW order; a too-old build sends nothing; a prepared order is still resent', async () => {
    let policy: unknown = null;
    let reach = true;
    const sent: string[] = [];
    const asked: string[] = [];
    const transport: ShopTransport = {
      placeOrder: async (r) => { sent.push(r.orderId); return reach ? { reached: true, status: 201, body: { orderId: r.orderId, alreadyPlaced: false, payment: { state: 'authorised' }, tellTheCustomer: 'Placed.' } } : { reached: false, why: 'network_error', detail: 'down' }; },
      mine: async (r): Promise<ShopAnswer> => { asked.push(`${r.method} ${r.path}`); return reach ? { reached: true, status: 200, body: { policy, asAt: AT } } : { reached: false, why: 'network_error', detail: 'down' }; },
    };
    const gate = openNewWorkGate({ client: 'customer_app', appVersion: OLD, key: 'k' });
    let n = 0;
    const shop = bootShop(data, forgetfulBasket(), () => 'DSR-1', transport, () => `ORD-${(n += 1)}`, gate)!;
    const ready = () => { shop.setLine('p1', 2); shop.review(); shop.chooseSlot('today-evening', AT); };
    shop.signedIn('tok-1');
    ready();
    // No signal: the order is prepared, not sent (the policy said nothing then).
    reach = false;
    expect(await shop.place({ providerRef: 'tok_a', result: 'authorised' })).toMatchObject({ ok: true, shopHasIt: false });
    // Head office now withdraws this build. The PREPARED order is in hand: it is resent (it may already be at the shop).
    policy = POLICY;
    reach = true;
    expect(await shop.retry()).toMatchObject({ ok: true, shopHasIt: true, orderId: 'ORD-1' });
    // A NEW order: head office is asked first, and the too-old build sends nothing — in English and Tamil.
    ready();
    const refused = await shop.place({ providerRef: 'tok_b', result: 'authorised' });
    expect(refused).toMatchObject({ ok: false, refusedBecause: 'app_version_too_old' });
    expect(refused.ok ? '' : refused.tellTheCustomer).toMatch(/shopping app.*too old.*a new order cannot be started/);
    expect(refused.ok ? '' : refused.tellTheCustomerTa).toContain('புதிய ஆர்டரை');
    expect(sent).toEqual(['ORD-1', 'ORD-1']);
    expect(asked).toContain('GET app-version-policy');
    // Head office lifts it: the next new order goes.
    policy = null;
    expect(await shop.place({ providerRef: 'tok_c', result: 'authorised' })).toMatchObject({ ok: true, shopHasIt: true });
  });

  it('customer app scan-and-go: the first scan of a new basket is refused; a basket already started is finished', () => {
    let words: { en: string; ta: string } | undefined = undefined;
    const sg = createScanAndGo({ products: () => [{ productId: 'p1', name: 'Dal', unitPriceMinor: 100, uom: 'ea', barcodes: ['111'] }], newBasketId: () => 'sg-1', newWorkRefusal: () => words });
    expect(sg.add('111')).toMatchObject({ ok: true });
    words = judgeClientVersion(OLD, POLICY, 'customer_app').words;
    expect(sg.add('111')).toMatchObject({ ok: true });
    sg.newTrip();
    expect(sg.add('111')).toEqual({ ok: false, why: 'app_version_too_old' });
  });
});
