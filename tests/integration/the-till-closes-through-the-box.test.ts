import { describe, it, expect, afterEach } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startEdge, type EdgeProcess } from '../../edge/store-edge/src/main';
import { readLog } from '../../edge/store-edge/src/file-log';
import { bootPos, laneDurable, laneDurableReturn, laneLookup, laneCashMovement, laneShiftClose, laneTillCash } from '../../apps/pos/src/browser-entry';
import { readTillCashRecord } from '../../edge/store-edge/src/till-cash';
import { prepareTillBox, holdSignedInAt } from '../support/till-operator';

/**
 * **The till's float, pickups and close live on the store BOX — durable, restart-safe, one effect per act (SP-4c · audit
 * finding F10 · M14-FR-01 · M14-FR-02 · §31 · hard rules #1 #2).**
 *
 * Before SP-4c a float or a pickup went into the browser's memory and an outbox nothing drained, and the Close button's
 * input could not close the till at all. This drives the whole seam with nothing stubbed: a real edge process with its
 * lane socket, the real `bootPos` till posting over loopback, and a real file on a real disk. The box judges every
 * movement against the lane's own chain, works the shift's figures out from ITS OWN sale, return and cash logs, and
 * answers the cashier's blind count with the difference — never a figure before the count. A reply lost on the wire is
 * resolved by re-asking under the same id, and a restart finds every record where it was left.
 */

const KEY = ['till', 'closes', 'through', 'box', 'signing', 'key'].join('-').padEnd(48, '0');
const dirs: string[] = [];
const stops: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const stop of stops.splice(0)) await stop();
  for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true });
});

/** A store pack naming the shop's cut-off and cash tolerance (₹100), as head office publishes one. */
const PACK = ({
  version: 1,
  policies: { storeId: 'store-1', branchId: 'store-1', branchName: 'Main', tradingDayCutoff: '02:00', staleAfterSeconds: 300, countApprovalThresholdMinor: 100_000, handoverToleranceMinor: 10_000, cashVarianceToleranceMinor: 10_000, privacySlaDays: 30, warehouseId: 'wh-1' },
  lossPreventionRules: [],
});

const startBox = async (opts: { readonly dir?: string; readonly lane?: string; readonly withPack?: boolean } = {}): Promise<EdgeProcess> => {
  const dir = opts.dir ?? await mkdtemp(join(tmpdir(), 'sre-till-cash-'));
  if (opts.dir === undefined) dirs.push(dir);
  // The pack names the two cashiers with till authority and their PINs are issued on this box (ADR-0020); `withPack:
  // false` is a pack that names the people but no policies — so no cash tolerance.
  const tillReady = await prepareTillBox({
    dir, key: KEY, pack: opts.withPack === false ? {} : PACK, laneId: opts.lane ?? null,
    people: [{ userId: 'u-meena', displayName: 'Meena' }, { userId: 'u-ravi', displayName: 'Ravi' }],
  });
  const edge = (await startEdge({
    EDGE_DATA_DIR: dir, EDGE_TENANT_ID: 't-sre', PACK_SIGNING_KEY: KEY, EDGE_CAPACITY_BYTES: '10485760',
    EDGE_LANE_PORT: '0', ...tillReady,
  }, () => {}))!;
  stops.push(() => edge.stop());
  return edge;
};

/** The till exactly as the served page boots it, on this box's lane socket, with a cashier signed in AT THE BOX (ADR-0020). */
const tillOn = async (edge: EdgeProcess, cashierId = 'u-meena') => {
  const port = edge.lane!.port;
  // Tax-free items, so the rupee arithmetic below reads plainly (a hand-scanned item otherwise carries the default 18%).
  const view = bootPos({
    laneId: 'lane-1', taxPercent: 0, durable: laneDurable(port), durableReturn: laneDurableReturn(port), laneLookup: laneLookup(port),
    cashMovement: laneCashMovement(port), shiftClose: laneShiftClose(port), tillCash: laneTillCash(port),
  });
  await holdSignedInAt(port, cashierId);
  view.signIn(cashierId);
  return view;
};

const cashLog = async (edge: EdgeProcess) => (await readLog(edge.tillCashLog.path)).flatMap((r) => (r.ok ? [readTillCashRecord(JSON.parse(r.record))!] : []));
/** Ring one item and take exact cash for it — the till's cash tender records the payable, the change is worked out on the screen. */
const ring = async (view: ReturnType<typeof bootPos>, saleId: string, at: string, priceMinor: number) => {
  view.scan({ productId: 'P1', description: 'Toor dal 1kg', unitPriceMinor: priceMinor, qty: 1 });
  const receipt = await view.tenderCash(saleId, `R-${saleId}`, at);
  view.newSale();
  return receipt;
};

describe('a shift on the served till: float → sales → pickup → blind count, all on the box (F10)', () => {
  it('records the float durably, refuses what the chain refuses, and closes on the box\'s own figures', async () => {
    const edge = await startBox({ lane: 'lane-1' });
    const till = await tillOn(edge);

    // Nothing out yet: the box says so, and a pickup with no float is refused in words — nothing written.
    expect(await till.till.tillCash()).toMatchObject({ tillId: 'lane-1', laneId: 'lane-1', custodian: null, shiftOpen: false });
    const early = await till.till.moveCash({ kind: 'pickup', amountMinor: 10_000, at: '2026-09-30T08:59:00.000Z' });
    expect(early).toMatchObject({ committed: false, refusedBecause: 'till_not_held_by_this_custodian' });
    expect(await cashLog(edge)).toHaveLength(0);

    // The float: durable on the box's own log BEFORE the till hears "recorded", queued for head office, no balance told.
    const opened = await till.till.moveCash({ kind: 'float_issue', amountMinor: 200_000, at: '2026-09-30T09:00:00.000Z', movementId: 'cm-float-1' });
    expect(opened).toMatchObject({ committed: true, kind: 'float_issue', custodian: 'u-meena', tradingDay: expect.stringMatching(/^\d{4}-\d{2}-\d{2}$/) });
    expect(Object.keys(opened)).not.toContain('balanceMinor');
    const afterFloat = await cashLog(edge);
    expect(afterFloat).toHaveLength(1);
    expect(afterFloat[0]).toMatchObject({ kind: 'movement', movementId: 'cm-float-1', tillId: 'lane-1', laneId: 'lane-1', movementKind: 'float_issue', deltaMinor: 200_000, custodianId: 'u-meena', performedBy: 'u-meena' });
    expect(edge.tillCashOutbox.unsentCount()).toBe(1);
    expect(edge.outbox.unsentCount()).toBe(0); // the sale queue is untouched
    expect(await till.till.tillCash()).toMatchObject({ custodian: 'u-meena', shiftOpen: true, openedAt: '2026-09-30T09:00:00.000Z' });

    // Trade: two ₹480 bills paid in cash → ₹960 cash into the drawer, on the box's SALE log (never told to the till).
    await ring(till, 'S-1', '2026-09-30T10:00:00.000Z', 48_000);
    await ring(till, 'S-2', '2026-09-30T11:00:00.000Z', 48_000);
    expect((await readLog(edge.log.path)).length).toBe(2);

    // A pickup of the takings plus part of the float: fine, because the box knows the drawer took ₹960 in trade.
    expect(await till.till.moveCash({ kind: 'pickup', amountMinor: 250_000, at: '2026-09-30T12:00:00.000Z', movementId: 'cm-pick-1' })).toMatchObject({ committed: true, kind: 'pickup' });
    // But more than the drawer can hold (₹2,000 + ₹960 − ₹2,500 = ₹460 left) is an overdraw, refused in words.
    const over = await till.till.moveCash({ kind: 'pickup', amountMinor: 50_000, at: '2026-09-30T12:01:00.000Z', movementId: 'cm-pick-2' });
    expect(over).toMatchObject({ committed: false, refusedBecause: 'insufficient_till_cash' });
    expect((over as { laneMessage: string }).laneMessage).toMatch(/does not hold that much/);
    // A second float while one is out is refused too — one custodian at a time.
    expect(await till.till.moveCash({ kind: 'float_issue', amountMinor: 1_000, at: '2026-09-30T12:02:00.000Z' })).toMatchObject({ committed: false, refusedBecause: 'till_already_assigned' });

    // The close: the cashier counts ₹460 — the box works out float 2,000 + sales 960 − pickups 2,500 = 460. Balanced.
    const closed = await till.till.close({ shiftId: 'sh-1', closedAt: '2026-09-30T20:00:00.000Z', countedMinor: 46_000, denominations: [{ denominationMinor: 10_000, count: 4 }, { denominationMinor: 2_000, count: 3 }] });
    expect(closed).toMatchObject({ closed: true, shiftId: 'sh-1', varianceMinor: 0, exceptionRaised: false, countedMinor: 46_000, reasonCode: null });
    const records = await cashLog(edge);
    expect(records.map((r) => r.kind)).toEqual(['movement', 'movement', 'close']);
    expect(records[2]).toMatchObject({
      kind: 'close', shiftId: 'sh-1', tillId: 'lane-1', cashierId: 'u-meena', openedAt: '2026-09-30T09:00:00.000Z', closedAt: '2026-09-30T20:00:00.000Z',
      openingFloatMinor: 200_000, cashSalesMinor: 96_000, pickupsMinor: 250_000, cashRefundsMinor: 0, countedMinor: 46_000, expectedMinor: 46_000, varianceMinor: 0,
      toleranceMinor: 10_000, toleranceKnown: true, denominations: [{ denominationMinor: 10_000, count: 4 }, { denominationMinor: 2_000, count: 3 }],
    });
    // Three records, three events queued for head office — and the till is free for the next float.
    expect(edge.tillCashOutbox.unsentCount()).toBe(3);
    expect(await till.till.tillCash()).toMatchObject({ custodian: null, shiftOpen: false });
    expect(await till.till.moveCash({ kind: 'float_issue', amountMinor: 100_000, at: '2026-10-01T09:00:00.000Z', movementId: 'cm-float-2' })).toMatchObject({ committed: true, custodian: 'u-meena' });
  });

  it('a material short is refused until a reason is given — the refusal says how far out, the close records the reason; the cash refunded counts', async () => {
    // The refund below is stamped by the till's OWN clock (the moment it is given back), so this shift's window has to
    // bracket real time: it opened an hour ago and closes an hour from now. Fixed dates here turned the case red the
    // day the calendar moved past them — the refund fell outside the shift and silently stopped counting.
    const T = Date.now();
    const minutesFromNow = (m: number) => new Date(T + m * 60_000).toISOString();
    const edge = await startBox({ lane: 'lane-1' });
    const till = await tillOn(edge);
    await till.till.moveCash({ kind: 'float_issue', amountMinor: 200_000, at: minutesFromNow(-60) });
    await ring(till, 'S-1', minutesFromNow(-30), 48_000);
    // A ₹100 cash refund on that bill goes through the box's return route — and out of the drawer.
    const bill = await till.lookupRefund('R-S-1');
    expect(bill).not.toBeNull();
    const refund = await bill!.submit({
      returnId: 'RET-1', number: 'RET-0001', reasonCode: 'damaged', refundMinor: 10_000, refundTender: 'cash',
      lines: [{ productId: 'P1', uom: 'ea', quantityMinor: 1, disposition: 'damaged' }], approval: { by: 'u-manager', reason: 'damaged' },
    });
    expect(refund.kind).toBe('settled');

    // Expected = 2,000 + 480 − 0 − 100 = ₹2,380. Counting ₹2,100 is ₹280 short: material (tolerance ₹100).
    const refused = await till.till.close({ shiftId: 'sh-2', closedAt: minutesFromNow(60), countedMinor: 210_000 });
    expect(refused).toMatchObject({ closed: false, refusedBecause: 'material_variance_needs_a_reason', varianceMinor: -28_000 });
    expect((await cashLog(edge)).filter((r) => r.kind === 'close')).toHaveLength(0); // nothing recorded on a refusal
    const closed = await till.till.close({ shiftId: 'sh-2', closedAt: minutesFromNow(60), countedMinor: 210_000, reasonCode: 'wrong_change' });
    expect(closed).toMatchObject({ closed: true, varianceMinor: -28_000, exceptionRaised: true, reasonCode: 'wrong_change' });
    expect((await cashLog(edge)).at(-1)).toMatchObject({ kind: 'close', cashSalesMinor: 48_000, cashRefundsMinor: 10_000, expectedMinor: 238_000, varianceMinor: -28_000, reasonCode: 'wrong_change' });
  });

  it('only the cashier who took the float closes; a till with no float has no shift to close', async () => {
    const edge = await startBox({ lane: 'lane-1' });
    const meena = await tillOn(edge, 'u-meena');
    expect(await meena.till.close({ shiftId: 'sh-0', closedAt: '2026-09-30T20:00:00.000Z', countedMinor: 0 })).toMatchObject({ closed: false, refusedBecause: 'no_open_shift' });
    await meena.till.moveCash({ kind: 'float_issue', amountMinor: 200_000, at: '2026-09-30T09:00:00.000Z' });
    const ravi = await tillOn(edge, 'u-ravi');
    expect(await ravi.till.close({ shiftId: 'sh-3', closedAt: '2026-09-30T20:00:00.000Z', countedMinor: 200_000 })).toMatchObject({ closed: false, refusedBecause: 'not_the_custodian' });
    expect(await ravi.till.moveCash({ kind: 'pickup', amountMinor: 1_000, at: '2026-09-30T12:00:00.000Z' })).toMatchObject({ committed: false, refusedBecause: 'till_not_held_by_this_custodian' });
    // Ravi signed in at this till after her; Meena signs back in to close her own shift.
    await holdSignedInAt(edge.lane!.port, 'u-meena');
    expect(await meena.till.close({ shiftId: 'sh-3', closedAt: '2026-09-30T20:00:00.000Z', countedMinor: 200_000 })).toMatchObject({ closed: true, varianceMinor: 0 });
  });

  it('the same movement id and the same shift id re-sent are ONE effect — a reply lost on the wire is resolved, never doubled (§31.1)', async () => {
    const edge = await startBox({ lane: 'lane-1' });
    const till = await tillOn(edge);
    const first = await till.till.moveCash({ kind: 'float_issue', amountMinor: 200_000, at: '2026-09-30T09:00:00.000Z', movementId: 'cm-same' });
    const again = await till.till.moveCash({ kind: 'float_issue', amountMinor: 200_000, at: '2026-09-30T09:00:00.000Z', movementId: 'cm-same' });
    expect(first).toMatchObject({ committed: true });
    expect(again).toMatchObject({ committed: true, alreadyRecorded: true, movementId: 'cm-same', custodian: 'u-meena' });
    const once = await till.till.close({ shiftId: 'sh-same', closedAt: '2026-09-30T20:00:00.000Z', countedMinor: 200_000 });
    const twice = await till.till.close({ shiftId: 'sh-same', closedAt: '2026-09-30T20:00:00.000Z', countedMinor: 200_000 });
    expect(once).toMatchObject({ closed: true, varianceMinor: 0 });
    expect(twice).toMatchObject({ closed: true, alreadyClosed: true, varianceMinor: 0 });
    expect((await cashLog(edge)).map((r) => r.kind)).toEqual(['movement', 'close']);
    expect(edge.tillCashOutbox.unsentCount()).toBe(2);
  });

  it('a restart finds the shift where it was left — the float still out, the same pickup refused as a duplicate, the close still possible; a box with no lane refuses', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'sre-till-cash-restart-'));
    dirs.push(dir);
    const first = await startBox({ dir, lane: 'lane-1' });
    const till1 = await tillOn(first);
    await till1.till.moveCash({ kind: 'float_issue', amountMinor: 200_000, at: '2026-09-30T09:00:00.000Z', movementId: 'cm-f' });
    await till1.till.moveCash({ kind: 'pickup', amountMinor: 50_000, at: '2026-09-30T12:00:00.000Z', movementId: 'cm-p' });
    await first.stop();
    stops.splice(stops.indexOf(() => first.stop()), 0);

    const said: string[] = [];
    const second = (await startEdge({ EDGE_DATA_DIR: dir, EDGE_TENANT_ID: 't-sre', PACK_SIGNING_KEY: KEY, EDGE_CAPACITY_BYTES: '10485760', EDGE_LANE_PORT: '0', EDGE_LANE_ID: 'lane-1', EDGE_PACK_FILE: join(dir, 'store-pack.json') }, (l) => said.push(l)))!;
    stops.push(() => second.stop());
    // No cloud was configured, so the two records are still to send — re-queued from the disk, said out loud.
    expect(said.join('\n')).toContain('2 till cash record(s) from before are still to send');
    expect(second.tillCashOutbox.unsentCount()).toBe(2);
    const till2 = await tillOn(second);
    expect(await till2.till.tillCash()).toMatchObject({ custodian: 'u-meena', shiftOpen: true, openedAt: '2026-09-30T09:00:00.000Z' });
    expect(await till2.till.moveCash({ kind: 'pickup', amountMinor: 50_000, at: '2026-09-30T12:00:00.000Z', movementId: 'cm-p' })).toMatchObject({ committed: true, alreadyRecorded: true });
    expect(await till2.till.close({ shiftId: 'sh-r', closedAt: '2026-09-30T20:00:00.000Z', countedMinor: 150_000 })).toMatchObject({ closed: true, varianceMinor: 0 });
    expect((await cashLog(second)).map((r) => r.kind)).toEqual(['movement', 'movement', 'close']);

    // A box that was never told which lane it is keeps no till cash — it says so, and writes nothing.
    const laneless = await startBox({});
    const view = bootPos({ laneId: 'lane-1', cashierId: 'u-meena', cashMovement: laneCashMovement(laneless.lane!.port), shiftClose: laneShiftClose(laneless.lane!.port), tillCash: laneTillCash(laneless.lane!.port) });
    expect(await view.till.moveCash({ kind: 'float_issue', amountMinor: 1, at: '2026-09-30T09:00:00.000Z' })).toMatchObject({ committed: false, refusedBecause: 'no_lane' });
    expect(await view.till.tillCash()).toMatchObject({ tillId: null, laneId: null, shiftOpen: false });
    expect(await cashLog(laneless)).toHaveLength(0);
  });

  it('a pack that names no cash tolerance: the box applies its default AND says so on the record', async () => {
    const edge = await startBox({ lane: 'lane-1', withPack: false });
    const till = await tillOn(edge);
    await till.till.moveCash({ kind: 'float_issue', amountMinor: 200_000, at: '2026-09-30T09:00:00.000Z' });
    expect(await till.till.close({ shiftId: 'sh-d', closedAt: '2026-09-30T20:00:00.000Z', countedMinor: 200_000 })).toMatchObject({ closed: true });
    expect((await cashLog(edge)).at(-1)).toMatchObject({ kind: 'close', toleranceMinor: 10_000, toleranceKnown: false });
  });

  it('with the box down the till says the cash is NOT recorded yet — never a silent local record', async () => {
    const edge = await startBox({ lane: 'lane-1' });
    const port = edge.lane!.port;
    await edge.stop();
    stops.splice(0);
    const view = bootPos({ laneId: 'lane-1', cashierId: 'u-meena', cashMovement: laneCashMovement(port), shiftClose: laneShiftClose(port), tillCash: laneTillCash(port) });
    const outcome = await view.till.moveCash({ kind: 'float_issue', amountMinor: 200_000, at: '2026-09-30T09:00:00.000Z' });
    expect(outcome).toMatchObject({ committed: false, refusedBecause: 'lane_unreachable' });
    expect((outcome as { laneMessage: string }).laneMessage).toMatch(/NOT recorded yet/);
    expect(await view.till.close({ shiftId: 'sh-x', closedAt: '2026-09-30T20:00:00.000Z', countedMinor: 0 })).toMatchObject({ closed: false, refusedBecause: 'lane_unreachable' });
    expect(await view.till.tillCash()).toBeNull();
  }, 20_000);
});
