import { describe, it, expect, afterEach } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startEdge, type EdgeProcess } from '../../edge/store-edge/src/main';
import { bootPos } from '../../apps/pos/src/browser-entry';
import { bootOwner, forgetfulQueueStore } from '../../apps/owner-app/src/browser-entry';
import { prepareTillBox, signInTill, managerApprovesOn } from '../support/till-operator';

/**
 * **The owner's "Today" takings are net of today's refunds (Round B · M29-FR-01 · P-02 · P-08).** Before this, a ₹35 refund
 * given at the till left the owner's app showing the takings from before it — the store computer read only its sales log.
 * Now the box reads its returns log too, counts each refund by the day book's own rule (the money out, by the tender it went
 * back by), and the owner's takings, tender mix and sentence are the day's after refunds — what the till close counts.
 *
 * A real store computer (no cloud), its real lane socket and disk, the real `bootPos` till and the real owner app boot.
 */

const KEY = ['owner', 'takings', 'net', 'refunds', 'key'].join('-').padEnd(48, '0');
const dirs: string[] = [];
const stops: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const s of stops.splice(0)) await s();
  for (const d of dirs.splice(0)) await rm(d, { recursive: true, force: true });
});
const PEOPLE = [{ userId: 'u-meena', displayName: 'Meena' }, { userId: 'u-mgr', displayName: 'Manager', manager: true }];

async function ownerBrief(edge: EdgeProcess) {
  // The box re-reads its logs on each request (the first read starts it), so the second read is the day as it stands.
  await (await fetch(`http://127.0.0.1:${edge.screens!.port}/owner/`)).text();
  await new Promise((r) => setTimeout(r, 200)); // let that re-read (sales, then returns) land
  const res = await fetch(`http://127.0.0.1:${edge.screens!.port}/owner/`);
  const html = await res.text();
  if (!html.includes('window.ownerData')) throw new Error(`owner screen: ${res.status} ${html.slice(0, 400)}`);
  const data = JSON.parse(/<script>window\.ownerData = ([\s\S]*?);<\/script>/.exec(html)![1]!) as Parameters<typeof bootOwner>[0];
  return { data: data as unknown as { branches: { refunds?: unknown }[] }, brief: bootOwner(data, forgetfulQueueStore())!.brief() };
}

describe("the owner's takings count today's refunds", () => {
  it('a ₹35 cash refund at the till comes off the owner\'s takings, the cash in the tender mix, and the sentence', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'sre-owner-net-'));
    dirs.push(dir);
    const ready = await prepareTillBox({
      dir, key: KEY, people: PEOPLE,
      pack: { policies: { storeId: 'S1', branchId: 'S1', branchName: 'SRE Hyper Market', warehouseId: 'S1-BACK', tradingDayCutoff: '00:00', staleAfterSeconds: 900, countApprovalThresholdMinor: 0 }, servicePolicy: { returnWindowDays: 30, approvalThresholdMinor: 0, noReceiptCapMinor: 100_000, agentAuthorityMinor: 0, compensationCapMinor: 0 }, receiptSeries: [{ laneId: 'lane-1', prefix: 'MS-', padTo: 6, rangeStart: 1, rangeEnd: 999, bankedThrough: 0 }] },
    });
    const edge = (await startEdge({
      EDGE_DATA_DIR: dir, EDGE_TENANT_ID: 't-sre', PACK_SIGNING_KEY: KEY, EDGE_CAPACITY_BYTES: '10485760',
      EDGE_LANE_PORT: '0', EDGE_SCREEN_PORT: '0', EDGE_APPS_DIR: 'apps', ...ready,
    }, () => {}))!;
    stops.push(() => edge.stop());

    // One bill: two ₹48 packs, cash — ₹96 taken.
    const till = bootPos({ laneId: 'lane-1', taxPercent: 0, lanePort: edge.lane!.port });
    await signInTill(till, 'u-meena');
    till.scan({ productId: 'P1', description: 'Toor dal 1kg', unitPriceMinor: 4_800, qty: 2 });
    await till.tenderCash('S-1', await till.nextReceipt(), new Date().toISOString());
    till.newSale();

    const before = await ownerBrief(edge);
    expect(before.brief.takings).toMatchObject({ bills: 1, takenMinor: 9_600, refunds: 0, refundedMinor: 0 });
    expect(before.brief.takings.tenderMix['cash']).toBe(9_600);

    // A ₹35 cash refund against it, approved by the manager at the till.
    const bill = (await till.lookupRefund('MS-000001'))!;
    const approval = await managerApprovesOn(till, 'u-mgr', { kind: 'refund', billRef: 'S-1', valueMinor: 3_500 });
    expect(await bill.submit({
      returnId: 'RT-1', number: await till.nextReceipt(), reasonCode: 'damaged', refundMinor: 3_500, refundTender: 'cash',
      lines: [{ productId: 'P1', uom: 'ea', quantityMinor: 1, disposition: 'damaged' }], approval,
    })).toMatchObject({ kind: 'settled' });

    const after = await ownerBrief(edge);
    // The box tells the owner app today's refunds, counted by the day book's rule …
    expect(after.data.branches[0]!.refunds).toEqual({ count: 1, refundedMinor: 3_500, tenderMix: { cash: 3_500 } });
    // … and the takings are the day's after them: ₹96 − ₹35 = ₹61, in cash; the bill count is still one bill.
    expect(after.brief.takings).toMatchObject({ bills: 1, takenMinor: 6_100, refunds: 1, refundedMinor: 3_500 });
    expect(after.brief.takings.tenderMix['cash']).toBe(6_100);
    expect(after.brief.headline).toContain('Refunds today: ₹35.00 — ₹61.00 taken after refunds.');
  });
});
