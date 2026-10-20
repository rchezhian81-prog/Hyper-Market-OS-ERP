import { describe, it, expect, afterEach } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startEdge, type EdgeProcess } from '../../edge/store-edge/src/main';
import { laneDurableReturn } from '../../apps/pos/src/browser-entry';
import { PAID_ON_OLD_ERP_WORDS } from '../../packages/tender/src/paid-on-old-erp';
import { prepareTillBox, holdSignedInAt, receiptNumberAt, operatorHeader, approvalFromLane } from '../support/till-operator';
import { openOldErpBills } from '../../edge/store-edge/src/old-erp-bills';
import { startLaneServer } from '../../edge/store-edge/src/lane-server';
import { createEdgeNode } from '../../edge/store-edge/src/index';
import { openFileLog, readLog } from '../../edge/store-edge/src/file-log';
import { SyncOutbox } from '../../packages/sync/src/outbox';
import { hmacSigner } from '../../services/catalogue/src/index';

/**
 * **OB-256 · OB-258 (owner, 20 Oct 2026) — the store computer keeps the mirror pilot's tender, "Paid on old system", itself:
 * the same rules the till runs, again before ITS disk.** A real store box (lane socket, disk, receipt-number register,
 * card-attempt register, approvals), synthetic data.
 *
 *   • the switch: the store pack (`policies.mirrorPilot`) or the store computer's own setting (`EDGE_MIRROR_PILOT=1`); the
 *     served till is told it is on and by whom; off unless one says so; a setting that is not 0/1 stops the box;
 *   • guest sales only must be on too: a mirror box with it off REFUSES TO START, plainly; a later pack that turns the
 *     mirror on without it is refused on every sale and refund;
 *   • OFF: the tender is refused before the disk, for a sale and a refund (the 403-style refusal: nothing written);
 *   • ON: a sale paid "Paid on old system" for the whole bill is saved with NO card/UPI attempt; cash, card, a part payment,
 *     a provider reference are refused; a refund goes back to it, within the bill (what it was paid that way less what
 *     came back), against a bill this box holds; cash back and an exchange are refused; a no-receipt refund with the
 *     manager's approval is taken; nobody signed in → refused; nothing refused reaches the disk.
 */

const KEY = ['mirror', 'tender', 'box', 'signing', 'key'].join('-').padEnd(48, '0');
const POLICIES = { storeId: 'store-1', branchId: 'store-1', branchName: 'Main', tradingDayCutoff: '02:00', staleAfterSeconds: 300, countApprovalThresholdMinor: 100_000, handoverToleranceMinor: 10_000, cashVarianceToleranceMinor: 10_000, privacySlaDays: 15, warehouseId: 'wh-1' };
const AT = '2026-10-20T10:00:00.000Z';
const PEOPLE = [{ userId: 'u-meena', displayName: 'Meena' }, { userId: 'u-mgr', displayName: 'Manager', manager: true }];

const dirs: string[] = [];
const stops: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const s of stops.splice(0).reverse()) await s();
  for (const d of dirs.splice(0)) await rm(d, { recursive: true, force: true });
});

const startBox = async (opts: { readonly mirror?: '0' | '1' | 'yes'; readonly guestOnly?: '0' | '1'; readonly packMirror?: boolean; readonly packGuestOnly?: boolean }) => {
  const dir = await mkdtemp(join(tmpdir(), 'sre-mirror-box-')); dirs.push(dir);
  const pack = {
    policies: { ...POLICIES, ...(opts.packMirror === undefined ? {} : { mirrorPilot: opts.packMirror }), ...(opts.packGuestOnly === undefined ? {} : { guestSalesOnly: opts.packGuestOnly }) },
    servicePolicy: { returnWindowDays: 30, approvalThresholdMinor: 1_000_000, noReceiptCapMinor: 50_000, agentAuthorityMinor: 0, compensationCapMinor: 0 },
    lossPreventionRules: [],
    managerPolicy: { userId: 'u-mgr', approvalLimitMinor: 500_000 },
  };
  const said: string[] = [];
  const edge = await startEdge({
    EDGE_DATA_DIR: dir, EDGE_TENANT_ID: 't-sre', PACK_SIGNING_KEY: KEY, EDGE_CAPACITY_BYTES: '10485760',
    EDGE_LANE_PORT: '0', EDGE_SCREEN_PORT: '0', EDGE_APPS_DIR: 'apps',
    ...(opts.mirror === undefined ? {} : { EDGE_MIRROR_PILOT: opts.mirror }),
    ...(opts.guestOnly === undefined ? {} : { EDGE_GUEST_SALES_ONLY: opts.guestOnly }),
    ...await prepareTillBox({ dir, key: KEY, people: PEOPLE, pack }),
  }, (line) => said.push(line));
  if (edge !== undefined) stops.push(() => edge.stop());
  return { dir, edge, said };
};

/** The page global the box served to its till. */
async function servedGlobal<T>(edge: EdgeProcess, name: string): Promise<T | undefined> {
  const html = await (await fetch(`http://127.0.0.1:${edge.screens!.port}/pos/`)).text();
  const match = new RegExp(`<script>window\\.${name} = ([\\s\\S]*?);</script>`).exec(html);
  return match === null ? undefined : JSON.parse(match[1]!) as T;
}
const post = async (port: number, path: string, token: string | undefined, body: unknown) => (await fetch(`http://127.0.0.1:${port}${path}`, {
  method: 'POST', headers: { 'content-type': 'application/json', ...(token === undefined ? {} : operatorHeader(token)) }, body: JSON.stringify(body),
})).json() as Promise<Record<string, unknown>>;
const tender = (kind: string, minor: number, extra: Record<string, unknown> = {}) => ({ kind, amount: { minor, currency: 'INR' }, status: 'settled', ...extra });
// OB-264: a mirror sale carries the old ERP's bill number — one of its own for each sale here.
let oldBills = 0;
const sale = (id: string, number: string, tenders: unknown[] = [tender('paid_on_old_erp', 21_000)]) => ({
  id, number, laneId: 'lane-1', cashierId: 'u-meena', tradingDay: '2026-10-20', committedAt: AT,
  lines: [{ productId: 'P1', quantityMinor: 2, uom: 'ea', unitPriceMinor: 10_500, lineTotalMinor: 21_000, taxRateBps: 500 }],
  tenders, total: 21_000, netMinor: 20_000, taxMinor: 1_000, currency: 'INR',
  ...(tenders.some((t) => (t as { kind?: string }).kind === 'paid_on_old_erp') ? { oldErpBillNumber: `OLD/${(oldBills += 1)}` } : {}),
});
const refund = (n: string, originalSaleId: string | null, refundTender: string, refundMinor = 10_500, extra: Record<string, unknown> = {}) => JSON.stringify({
  returnId: `RT-${n}`, number: n, originalSaleId, noReceipt: originalSaleId === null, laneId: 'lane-1', processedBy: 'u-meena', reasonCode: 'damaged',
  refundMinor, currency: 'INR', refundTender, processedAt: AT,
  lines: [{ productId: 'P1', uom: 'ea', quantityMinor: 1, disposition: 'resell' }], ...extra,
});

describe('OB-256 — the switch, and guest sales only with it', () => {
  it('off unless something turns it on; the store pack or the box\'s own setting turn it on, and the till is told who', async () => {
    expect((await servedGlobal<{ mirrorPilot: unknown }>((await startBox({})).edge!, 'posLane'))?.mirrorPilot).toEqual({ on: false, by: null });
    expect((await servedGlobal<{ mirrorPilot: unknown }>((await startBox({ packMirror: true, packGuestOnly: true })).edge!, 'posLane'))?.mirrorPilot).toEqual({ on: true, by: 'store_pack' });
    const { edge, said } = await startBox({ mirror: '1', guestOnly: '1' });
    expect((await servedGlobal<{ mirrorPilot: unknown; guestSalesOnly: unknown }>(edge!, 'posLane'))).toMatchObject({ mirrorPilot: { on: true, by: 'store_computer_setting' }, guestSalesOnly: { on: true } });
    expect(said.join('\n')).toMatch(/mirror pilot \(OB-256, EDGE_MIRROR_PILOT=1\)/);
  });

  it('a mirror box with guest sales only OFF refuses to start, plainly — by its setting or by the pack', async () => {
    const exit = process.exitCode;
    const writes: string[] = [];
    const real = process.stderr.write.bind(process.stderr);
    process.stderr.write = ((chunk: string | Uint8Array) => { writes.push(String(chunk)); return true; }) as typeof process.stderr.write;
    try {
      expect((await startBox({ mirror: '1' })).edge).toBeUndefined();
      expect(process.exitCode).toBe(78);
      expect((await startBox({ mirror: '1', guestOnly: '0' })).edge).toBeUndefined();
      expect((await startBox({ packMirror: true })).edge).toBeUndefined();
      // A setting that is not 0 or 1 is never a silent guess either.
      expect((await startBox({ mirror: 'yes', guestOnly: '1' })).edge).toBeUndefined();
    } finally {
      process.stderr.write = real;
      process.exitCode = exit;
    }
    expect(writes.join('')).toMatch(/set for the mirror pilot \(EDGE_MIRROR_PILOT=1\) but "guest sales only" is off\. The mirror pilot needs both/);
    expect(writes.join('')).toMatch(/the store pack says so/);
    expect(writes.join('')).toMatch(/EDGE_MIRROR_PILOT is "yes"/);
    // Guest-only by the pack and the mirror by the setting is both on: it starts.
    expect((await startBox({ mirror: '1', packGuestOnly: true })).edge).toBeDefined();
  });
});

describe('OB-256 — mirror pilot OFF: the tender is refused before the disk', () => {
  it('a sale or a refund paid "Paid on old system" is refused in words; nothing is written', async () => {
    const { edge } = await startBox({ guestOnly: '1' });
    const port = edge!.lane!.port;
    const token = await holdSignedInAt(port, 'u-meena');
    const n = await receiptNumberAt(port, token);
    expect(await post(port, '/lane/sales', token, sale(`S-${n}`, n))).toMatchObject({ committed: false, refusedBecause: 'paid_on_old_erp_not_on', laneMessage: PAID_ON_OLD_ERP_WORDS.notOn });
    const r = await receiptNumberAt(port, token);
    expect(await laneDurableReturn(port)(`RT-${r}`, refund(r, 'S-1', 'paid_on_old_erp'))).toMatchObject({ committed: false, refusedBecause: 'paid_on_old_erp_not_on' });
    expect(await readLog(edge!.log.path)).toHaveLength(0);
    expect(await readLog(edge!.returnsLog.path)).toHaveLength(0);
    // And a cash sale is exactly as before.
    const c = await receiptNumberAt(port, token);
    expect(await post(port, '/lane/sales', token, sale(`S-${c}`, c, [tender('cash', 21_000)]))).toMatchObject({ committed: true });
  });
});

describe('OB-256 · OB-258 — mirror pilot ON: "Paid on old system" alone, refunds back to it, within the bill', () => {
  it('a sale paid that way for the whole bill is saved with no card attempt; every other way is refused before the disk', async () => {
    const { dir, edge } = await startBox({ mirror: '1', guestOnly: '1' });
    const port = edge!.lane!.port;
    const token = await holdSignedInAt(port, 'u-meena');
    for (const tenders of [
      [tender('cash', 21_000)],
      [tender('card', 21_000, { ref: 'att-1' })],
      [tender('paid_on_old_erp', 11_000), tender('cash', 10_000)],
      [tender('paid_on_old_erp', 20_000)],
      [tender('paid_on_old_erp', 21_000, { ref: 'OLD-77' })],
    ]) {
      const n = await receiptNumberAt(port, token);
      expect(await post(port, '/lane/sales', token, sale(`S-${n}`, n, tenders)), JSON.stringify(tenders)).toMatchObject({ committed: false, refusedBecause: 'mirror_sale_needs_paid_on_old_erp', laneMessage: PAID_ON_OLD_ERP_WORDS.saleNeedsIt });
    }
    expect(await readLog(edge!.log.path)).toHaveLength(0);
    // Nobody signed in at the till: refused before the disk, as any sale.
    const n0 = await receiptNumberAt(port, token);
    expect(await post(port, '/lane/sales', undefined, sale(`S-${n0}`, n0))).toMatchObject({ committed: false });
    expect(await readLog(edge!.log.path)).toHaveLength(0);

    const n = await receiptNumberAt(port, token);
    expect(await post(port, '/lane/sales', token, sale(`S-${n}`, n))).toMatchObject({ committed: true });
    const [saved] = await readLog(edge!.log.path);
    expect(JSON.parse(saved!.ok ? saved!.record : '{}')).toMatchObject({ tenders: [{ kind: 'paid_on_old_erp', amount: { minor: 21_000 } }], taxMinor: 1_000 });
    // No card or UPI attempt was asked or recorded for it.
    expect((await readLog(join(dir, 'payment-attempts.log')).catch(() => []))).toHaveLength(0);
  });

  it('a refund goes back to it within the bill; cash back, an exchange, too much, a bill not here are refused; no-receipt with approval is taken', async () => {
    const { edge } = await startBox({ mirror: '1', guestOnly: '1' });
    const port = edge!.lane!.port;
    const token = await holdSignedInAt(port, 'u-meena');
    const n = await receiptNumberAt(port, token);
    expect(await post(port, '/lane/sales', token, sale(`S-${n}`, n))).toMatchObject({ committed: true });
    const write = laneDurableReturn(port);

    const r1 = await receiptNumberAt(port, token);
    expect(await write(`RT-${r1}`, refund(r1, `S-${n}`, 'cash'))).toMatchObject({ committed: false, refusedBecause: 'mirror_refund_needs_paid_on_old_erp', laneMessage: PAID_ON_OLD_ERP_WORDS.refundNeedsIt });
    expect(await write(`RT-${r1}`, refund(r1, `S-${n}`, 'exchange', 10_500, { exchange: { replacementSaleId: 'S-X', replacementTotalMinor: 10_500, appliedMinor: 10_500, balance: 'even', balanceMinor: 0 } }))).toMatchObject({ committed: false, refusedBecause: 'mirror_no_exchange' });
    expect(await write(`RT-${r1}`, refund(r1, `S-${n}`, 'paid_on_old_erp', 21_001))).toMatchObject({ committed: false, refusedBecause: 'paid_on_old_erp_over_the_bill' });
    expect(await write(`RT-${r1}`, refund(r1, 'S-NOT-HERE', 'paid_on_old_erp'))).toMatchObject({ committed: false, refusedBecause: 'paid_on_old_erp_bill_not_here' });
    expect(await readLog(edge!.returnsLog.path)).toHaveLength(0);

    expect(await write(`RT-${r1}`, refund(r1, `S-${n}`, 'paid_on_old_erp', 15_000))).toMatchObject({ committed: true });
    // What is left on the bill is ₹60 — a second refund of ₹70 is over it; ₹60 is taken.
    const r2 = await receiptNumberAt(port, token);
    expect(await write(`RT-${r2}`, refund(r2, `S-${n}`, 'paid_on_old_erp', 7_000))).toMatchObject({ committed: false, refusedBecause: 'paid_on_old_erp_over_the_bill' });
    expect(await write(`RT-${r2}`, refund(r2, `S-${n}`, 'paid_on_old_erp', 6_000))).toMatchObject({ committed: true });
    // The first refund sent again (a lost reply) is the same refund, never counted against itself.
    expect(await write(`RT-${r1}`, refund(r1, `S-${n}`, 'paid_on_old_erp', 15_000))).toMatchObject({ committed: true });
    expect(await readLog(edge!.returnsLog.path)).toHaveLength(2);

    // A return without a receipt, within the no-receipt cap, with the manager's own approval: taken "Paid on old system".
    const r3 = await receiptNumberAt(port, token);
    const approvalId = await approvalFromLane(port, token, 'u-mgr', { kind: 'no_receipt_return', valueMinor: 5_000 });
    expect(await write(`RT-${r3}`, refund(r3, null, 'paid_on_old_erp', 5_000, { approvedBy: 'u-mgr', approvalId }))).toMatchObject({ committed: true });
    // …and without one, refused as today (the second-person rule is unchanged).
    const r4 = await receiptNumberAt(port, token);
    expect(await write(`RT-${r4}`, refund(r4, null, 'paid_on_old_erp', 5_000))).toMatchObject({ committed: false });
    expect(await readLog(edge!.returnsLog.path)).toHaveLength(3);
  });

  it('a store pack that later turns the mirror on without guest sales only: every sale and refund is refused, plainly', async () => {
    // The box reads both switches live; here the lane socket alone, its switches as a later pack would leave them.
    const dir = await mkdtemp(join(tmpdir(), 'sre-mirror-live-')); dirs.push(dir);
    const log = await openFileLog({ dataDir: dir, capacityBytes: 10_485_760 });
    const returnsLog = await openFileLog({ dataDir: dir, capacityBytes: 10_485_760, fileName: 'returns.log' });
    const node = createEdgeNode({ tenantId: 't-sre', log, signer: hmacSigner(KEY), outbox: new SyncOutbox(), returnsLog, returnsOutbox: new SyncOutbox() });
    let guestOnly = true;
    const server = await startLaneServer({ node, port: 0, mirrorPilot: () => true, guestSalesOnly: () => guestOnly, oldErpBills: openOldErpBills([], []) });
    stops.push(() => server.stop());
    const send = (path: string, body: unknown) => post(server.port, path, undefined, body);
    expect(await send('/lane/sales', sale('S-1', 'R-1'))).toMatchObject({ committed: true });
    guestOnly = false;
    expect(await send('/lane/sales', sale('S-2', 'R-2'))).toMatchObject({ committed: false, refusedBecause: 'mirror_needs_guest_sales_only', laneMessage: PAID_ON_OLD_ERP_WORDS.needsGuestOnly });
    expect(await send('/lane/returns', JSON.parse(refund('RT-1', 'S-1', 'paid_on_old_erp')))).toMatchObject({ committed: false, refusedBecause: 'mirror_needs_guest_sales_only' });
    expect(await readLog(log.path)).toHaveLength(1);
    expect(await readLog(returnsLog.path)).toHaveLength(0);
  });
});
