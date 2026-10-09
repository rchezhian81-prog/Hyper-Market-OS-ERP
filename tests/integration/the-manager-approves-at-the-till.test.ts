import { describe, it, expect, afterEach } from 'vitest';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startEdge, type EdgeProcess } from '../../edge/store-edge/src/main';
import { readLog } from '../../edge/store-edge/src/file-log';
import { bootPos } from '../../apps/pos/src/browser-entry';
import { prepareTillBox, signInTill, managerApprovesOn, approvalFromLane, operatorHeader, pinOf } from '../support/till-operator';

/**
 * **A refund that needs a manager is approved by the manager, at the till, with their own PIN — once (ADR-0021 · audit
 * PF-02 · §28 · M13-FR-01/03).**
 *
 * A real store computer, its real lane socket and disk, and the real `bootPos` till, with no cloud at all: a typed
 * manager name is refused before the disk; the manager's own PIN through the till gets an approval the refund then
 * carries; the box stamps the approver it verified and spends the approval, so it cannot pay a second refund; nobody
 * approves their own; a person without the authority cannot; and a restart forgets none of it.
 */

const KEY = ['manager', 'approves', 'at', 'till', 'key'].join('-').padEnd(48, '0');
const dirs: string[] = [];
const stops: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const s of stops.splice(0)) await s();
  for (const d of dirs.splice(0)) await rm(d, { recursive: true, force: true });
});

const PEOPLE = [
  { userId: 'u-meena', displayName: 'Meena' },
  { userId: 'u-ravi', displayName: 'Ravi' },
  { userId: 'u-mgr', displayName: 'Manager', manager: true },
];

const startBox = async (dir?: string): Promise<EdgeProcess> => {
  const d = dir ?? await mkdtemp(join(tmpdir(), 'sre-manager-approves-'));
  if (dir === undefined) dirs.push(d);
  const ready = dir !== undefined ? { EDGE_LANE_ID: 'lane-1', EDGE_PACK_FILE: join(d, 'store-pack.json') } : await prepareTillBox({
    dir: d, key: KEY, people: PEOPLE,
    // Every refund needs a manager here (threshold 0), as the shop's default is.
    pack: { servicePolicy: { returnWindowDays: 30, approvalThresholdMinor: 0, noReceiptCapMinor: 100_000, agentAuthorityMinor: 0, compensationCapMinor: 0 }, receiptSeries: [{ laneId: 'lane-1', prefix: 'R-S-', padTo: 1, rangeStart: 1, rangeEnd: 999 }] },
  });
  const edge = (await startEdge({
    EDGE_DATA_DIR: d, EDGE_TENANT_ID: 't-sre', PACK_SIGNING_KEY: KEY, EDGE_CAPACITY_BYTES: '10485760', EDGE_LANE_PORT: '0', ...ready,
  }, () => {}))!;
  stops.push(() => edge.stop());
  return edge;
};

/** A till on this box with Meena signed in and one sale of two ₹480 packs on it (bill R-S-1). */
const tillWithABill = async (edge: EdgeProcess) => {
  const till = bootPos({ laneId: 'lane-1', taxPercent: 0, lanePort: edge.lane!.port });
  await signInTill(till, 'u-meena');
  till.scan({ productId: 'P1', description: 'Toor dal 1kg', unitPriceMinor: 48_000, qty: 2 });
  // The box gives the bill its number (audit PF-04); this box's range starts at R-S-1.
  await till.tenderCash('S-1', await till.nextReceipt(), new Date().toISOString());
  till.newSale();
  return till;
};
const refundDraft = (returnId: string, refundMinor: number, approval?: { by: string; reason: string; approvalId?: string }, number = returnId) => ({
  returnId, number, reasonCode: 'damaged', refundMinor, refundTender: 'cash' as const,
  lines: [{ productId: 'P1', uom: 'ea', quantityMinor: 1, disposition: 'damaged' as const }],
  ...(approval === undefined ? {} : { approval }),
});
const returns = async (edge: EdgeProcess) => (await readLog(edge.returnsLog.path)).flatMap((r) => (r.ok ? [JSON.parse(r.record) as Record<string, unknown>] : []));

describe('the manager approves at the till, with their own PIN, for this one refund', () => {
  it('a typed manager name is refused before the disk; the manager\'s PIN gets an approval; the refund carries it, stamped', async () => {
    const edge = await startBox();
    const till = await tillWithABill(edge);
    const bill = (await till.lookupRefund('R-S-1'))!;

    const typed = await bill.submit(refundDraft('RT-1', 10_000, { by: 'u-mgr', reason: 'damaged' }, await till.nextReceipt()));
    expect(typed).toMatchObject({ laneMessage: expect.stringMatching(/needs a manager's approval on this till/) });
    expect(await returns(edge)).toHaveLength(0);

    const approval = await managerApprovesOn(till, 'u-mgr', { kind: 'refund', billRef: 'S-1', valueMinor: 10_000 });
    expect(approval).toMatchObject({ by: 'u-mgr', approvalId: expect.stringMatching(/^apr-/) });
    expect(await bill.submit(refundDraft('RT-1', 10_000, approval, await till.nextReceipt()))).toMatchObject({ kind: 'settled' });
    const [record] = await returns(edge);
    expect(record).toMatchObject({
      returnId: 'RT-1', processedBy: 'u-meena', approvedBy: 'u-mgr', approvalId: approval.approvalId,
      approvalVerified: { approvalId: approval.approvalId, approvedBy: 'u-mgr' }, operatorVerified: { userId: 'u-meena', via: 'pin' },
    });
  });

  it('one approval pays one refund: used again on another refund it is refused; nothing more leaves the drawer', async () => {
    const edge = await startBox();
    const till = await tillWithABill(edge);
    const bill = (await till.lookupRefund('R-S-1'))!;
    const approval = await managerApprovesOn(till, 'u-mgr', { kind: 'refund', billRef: 'S-1', valueMinor: 10_000 });
    expect(await bill.submit(refundDraft('RT-1', 10_000, approval, await till.nextReceipt()))).toMatchObject({ kind: 'settled' });
    const again = await bill.submit(refundDraft('RT-2', 10_000, approval, await till.nextReceipt()));
    expect(again).toMatchObject({ laneMessage: expect.stringMatching(/already used for another refund/) });
    expect((await returns(edge)).map((r) => r['returnId'])).toEqual(['RT-1']);
  });

  it('nobody approves their own, a person without the authority cannot, and a wrong PIN is the same answer as at sign-in', async () => {
    const edge = await startBox();
    const till = await tillWithABill(edge);
    const ask = (managerId: string, pin: string) => till.approveAtTill({ managerId, pin, kind: 'refund', billRef: 'S-1', valueMinor: 10_000, reason: 'damaged' });
    expect(await ask('u-meena', pinOf('u-meena'))).toMatchObject({ approved: false, refusedBecause: 'self_approval' });
    expect(await ask('u-ravi', pinOf('u-ravi'))).toMatchObject({ approved: false, refusedBecause: 'no_approval_authority' });
    expect(await ask('u-mgr', pinOf('u-ravi'))).toMatchObject({ approved: false, refusedBecause: 'wrong_staff_id_or_pin' });
  });

  it('an approval for one bill or amount does not fit another refund; a forged approval id is unknown', async () => {
    const edge = await startBox();
    const till = await tillWithABill(edge);
    const bill = (await till.lookupRefund('R-S-1'))!;
    const forFive = await managerApprovesOn(till, 'u-mgr', { kind: 'refund', billRef: 'S-1', valueMinor: 5_000 });
    expect(await bill.submit(refundDraft('RT-1', 10_000, forFive, await till.nextReceipt()))).toMatchObject({ laneMessage: expect.stringMatching(/approved a different refund/) });
    // Straight at the socket, with the cashier's own session: an id this box never issued.
    const token = till.operatorToken()!;
    const forged = await fetch(`http://127.0.0.1:${edge.lane!.port}/lane/returns`, {
      method: 'POST', headers: { 'content-type': 'application/json', ...operatorHeader(token) },
      body: JSON.stringify({ id: 'RT-9', returnId: 'RT-9', originalSaleId: 'S-1', processedBy: 'u-meena', approvedBy: 'u-mgr', approvalId: 'apr-000000000000000000000000', refundMinor: 10_000, refundTender: 'cash', lines: [] }),
    });
    expect(await forged.json()).toMatchObject({ committed: false, refusedBecause: 'approval_unknown' });
    expect(await returns(edge)).toHaveLength(0);
  });

  it('a restart keeps every approval and every use: a spent one stays spent', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'sre-manager-approves-restart-'));
    dirs.push(dir);
    await prepareTillBox({
      dir, key: KEY, people: PEOPLE,
      pack: { servicePolicy: { returnWindowDays: 30, approvalThresholdMinor: 0, noReceiptCapMinor: 100_000, agentAuthorityMinor: 0, compensationCapMinor: 0 }, receiptSeries: [{ laneId: 'lane-1', prefix: 'R-S-', padTo: 1, rangeStart: 1, rangeEnd: 999 }] },
    });
    const first = await startBox(dir);
    const till = await tillWithABill(first);
    const approvalId = await approvalFromLane(first.lane!.port, till.operatorToken()!, 'u-mgr', { kind: 'refund', billRef: 'S-1', valueMinor: 10_000 });
    expect(await (await till.lookupRefund('R-S-1'))!.submit(refundDraft('RT-1', 10_000, { by: 'u-mgr', reason: 'damaged', approvalId }, await till.nextReceipt()))).toMatchObject({ kind: 'settled' });
    await first.stop();
    stops.splice(0);
    const second = await startBox(dir);
    const again = bootPos({ laneId: 'lane-1', taxPercent: 0, lanePort: second.lane!.port });
    await signInTill(again, 'u-meena');
    expect(await (await again.lookupRefund('R-S-1'))!.submit(refundDraft('RT-2', 10_000, { by: 'u-mgr', reason: 'damaged', approvalId }, await again.nextReceipt())))
      .toMatchObject({ laneMessage: expect.stringMatching(/already used for another refund/) });
    const log = await readFile(join(dir, 'till-approvals.log'), 'utf8');
    expect(log).not.toContain(pinOf('u-mgr'));
  });
});
