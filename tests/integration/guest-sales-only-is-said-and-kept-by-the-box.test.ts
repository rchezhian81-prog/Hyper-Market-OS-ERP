import { describe, it, expect, afterEach } from 'vitest';
import { mkdtemp, readdir, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startEdge, type EdgeProcess } from '../../edge/store-edge/src/main';
import { readLog } from '../../edge/store-edge/src/file-log';
import { bootPos, laneDurable, laneDurableReturn } from '../../apps/pos/src/browser-entry';
import { prepareTillBox, holdSignedInAt, receiptNumberAt, operatorHeader } from '../support/till-operator';

/**
 * **OB-252 (owner, 20 Oct 2026, "Guest sales only"): during the mirror pilot the new till takes no customer mobile number
 * and no loyalty — and says so. Turned on by the store pack (`policies.guestSalesOnly`) or by the store computer's own
 * setting (`EDGE_GUEST_SALES_ONLY=1`); off unless one of them says so.**
 *
 * Through a REAL store box: the served till page is told it is on and by whom; the till boots from that and refuses a
 * customer number in words; the box itself keeps the rule too — a number sent anyway is dropped before the disk and the
 * answer says why, a sale spending points or store credit and a store-credit refund are refused before the disk, and the
 * balance route refuses. Nothing about a customer reaches the box's disk. Synthetic data.
 */

const KEY = ['guest', 'sales', 'only', 'signing', 'key'].join('-').padEnd(48, '0');
const POLICIES = { storeId: 'store-1', branchId: 'store-1', branchName: 'Main', tradingDayCutoff: '02:00', staleAfterSeconds: 300, countApprovalThresholdMinor: 100_000, handoverToleranceMinor: 10_000, cashVarianceToleranceMinor: 10_000, privacySlaDays: 15, warehouseId: 'wh-1' };
const AT = '2026-10-20T10:00:00.000Z';

const dirs: string[] = [];
const stops: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const s of stops.splice(0).reverse()) await s();
  for (const d of dirs.splice(0)) await rm(d, { recursive: true, force: true });
});

const startBox = async (opts: { readonly setting?: '0' | '1'; readonly packSays?: boolean }) => {
  const dir = await mkdtemp(join(tmpdir(), 'sre-guest-only-')); dirs.push(dir);
  const pack = {
    policies: { ...POLICIES, ...(opts.packSays === undefined ? {} : { guestSalesOnly: opts.packSays }) },
    servicePolicy: { returnWindowDays: 30, approvalThresholdMinor: 1_000_000, noReceiptCapMinor: 0, agentAuthorityMinor: 0, compensationCapMinor: 0 },
    lossPreventionRules: [],
  };
  const said: string[] = [];
  const edge = (await startEdge({
    EDGE_DATA_DIR: dir, EDGE_TENANT_ID: 't-sre', PACK_SIGNING_KEY: KEY, EDGE_CAPACITY_BYTES: '10485760',
    EDGE_LANE_PORT: '0', EDGE_LANE_ID: 'lane-1', EDGE_SCREEN_PORT: '0', EDGE_APPS_DIR: 'apps',
    ...(opts.setting === undefined ? {} : { EDGE_GUEST_SALES_ONLY: opts.setting }),
    ...await prepareTillBox({ dir, key: KEY, people: [{ userId: 'u-meena', displayName: 'Meena' }], pack }),
  }, (line) => said.push(line)))!;
  stops.push(() => edge.stop());
  return { dir, edge, said };
};

/** The page global the box served to its till. */
async function servedGlobal<T>(edge: EdgeProcess, name: string): Promise<T | undefined> {
  const html = await (await fetch(`http://127.0.0.1:${edge.screens!.port}/pos/`)).text();
  const match = new RegExp(`<script>window\\.${name} = ([\\s\\S]*?);</script>`).exec(html);
  return match === null ? undefined : JSON.parse(match[1]!) as T;
}
async function everythingOnDisk(dir: string): Promise<string> {
  const out: string[] = [];
  for (const name of await readdir(dir)) {
    const path = join(dir, name);
    if ((await stat(path)).isDirectory()) out.push(await everythingOnDisk(path));
    else out.push(await readFile(path, 'utf8'));
  }
  return out.join('\n');
}
const post = async (port: number, path: string, token: string, body: unknown) => (await fetch(`http://127.0.0.1:${port}${path}`, {
  method: 'POST', headers: { 'content-type': 'application/json', ...operatorHeader(token) }, body: JSON.stringify(body),
})).json() as Promise<Record<string, unknown>>;
const sale = (id: string, number: string, extra: Record<string, unknown> = {}) => ({
  id, number, laneId: 'lane-1', cashierId: 'u-meena', tradingDay: '2026-10-20', committedAt: AT,
  lines: [{ productId: 'P1', quantityMinor: 1, uom: 'ea', unitPriceMinor: 48_000, lineTotalMinor: 48_000, taxRateBps: 0 }],
  tenders: [{ kind: 'cash', amount: { minor: 48_000, currency: 'INR' }, status: 'settled' }],
  total: 48_000, netMinor: 48_000, taxMinor: 0, currency: 'INR', ...extra,
});

describe('OB-252 — the store computer tells its till "guest sales only", and says who turned it on', () => {
  it('off unless something turns it on', async () => {
    const { edge } = await startBox({});
    expect((await servedGlobal<{ guestSalesOnly: unknown }>(edge, 'posLane'))?.guestSalesOnly).toEqual({ on: false, by: null });
  });

  it('turned on by the store pack', async () => {
    const { edge } = await startBox({ packSays: true });
    expect((await servedGlobal<{ guestSalesOnly: unknown }>(edge, 'posLane'))?.guestSalesOnly).toEqual({ on: true, by: 'store_pack' });
  });

  it('turned on by the store computer\'s own setting, which it says at start', async () => {
    const { edge, said } = await startBox({ setting: '1' });
    expect((await servedGlobal<{ guestSalesOnly: unknown }>(edge, 'posLane'))?.guestSalesOnly).toEqual({ on: true, by: 'store_computer_setting' });
    expect(said.join('\n')).toMatch(/guest sales only \(OB-252/);
  });

  it('a setting that is not 0 or 1 stops the box at start — never a silent guess', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'sre-guest-only-bad-')); dirs.push(dir);
    const exit = process.exitCode;
    const edge = await startEdge({ EDGE_DATA_DIR: dir, EDGE_TENANT_ID: 't-sre', PACK_SIGNING_KEY: KEY, EDGE_GUEST_SALES_ONLY: 'yes' }, () => {});
    expect(edge).toBeUndefined();
    process.exitCode = exit;
  });
});

describe('OB-252 — a guest-only box keeps no customer, even when one is sent', () => {
  it('the till refuses a number in words; a number sent anyway is dropped before the disk and the answer says so', async () => {
    const { dir, edge } = await startBox({ setting: '1' });
    const port = edge.lane!.port;
    const token = await holdSignedInAt(port, 'u-meena');
    const lane = await servedGlobal<{ guestSalesOnly: { on: boolean } }>(edge, 'posLane');
    const till = bootPos({ laneId: 'lane-1', taxPercent: 0, lanePort: port, durable: laneDurable(port), guestSalesOnly: lane!.guestSalesOnly.on });
    till.signIn('u-meena');
    expect(till.guestSalesOnly()).toBe(true);
    expect(till.setLoyaltyMobile('9840012345')).toMatchObject({ ok: false, laneMessage: expect.stringMatching(/Guest sales only/) });

    // A sale sent with a number anyway (an older till, a hand-made post): saved as a guest sale, the number dropped unread.
    const number = await receiptNumberAt(port, token);
    const answer = await post(port, '/lane/sales', token, sale(`S-${number}`, number, { customerMobile: '9840012345' }));
    expect(answer).toMatchObject({ committed: true, loyalty: 'guest_sales_only' });
    const [record] = await readLog(edge.log.path);
    const saved = JSON.parse(record!.ok ? record!.record : '{}') as Record<string, unknown>;
    expect(saved['customerRef']).toBeUndefined();
    expect(saved['customerMobile']).toBeUndefined();
    expect(await everythingOnDisk(dir)).not.toContain('9840012345');
  });

  it('points or store credit on a sale, a store-credit refund, and the balance route are refused before the disk', async () => {
    const { edge } = await startBox({ packSays: true });
    const port = edge.lane!.port;
    const token = await holdSignedInAt(port, 'u-meena');
    const n1 = await receiptNumberAt(port, token);
    const points = await post(port, '/lane/sales', token, sale(`S-${n1}`, n1, { tenders: [{ kind: 'loyalty_points', amount: { minor: 48_000, currency: 'INR' }, status: 'settled' }] }));
    expect(points).toMatchObject({ committed: false, refusedBecause: 'guest_sales_only' });

    const n2 = await receiptNumberAt(port, token);
    const credit = await laneDurableReturn(port)(`RT-${n2}`, JSON.stringify({
      returnId: `RT-${n2}`, number: n2, originalSaleId: 'S-0', processedBy: 'u-meena', reasonCode: 'damaged', refundMinor: 5_000,
      currency: 'INR', refundTender: 'store_credit', customerRef: '9840012345', processedAt: AT,
      lines: [{ productId: 'P1', uom: 'ea', quantityMinor: 1, disposition: 'resell' }],
    }));
    expect(credit).toMatchObject({ committed: false, refusedBecause: 'guest_sales_only' });

    expect(await post(port, '/lane/loyalty/wallet', token, { mobile: '9840012345', tradingDay: '2026-10-20' })).toMatchObject({ refusedBecause: 'guest_sales_only' });
    expect(await readLog(edge.log.path)).toHaveLength(0);
    expect(await readLog(edge.returnsLog.path)).toHaveLength(0);
  });

  it('with guest-only off, the same number is still turned into a member code — nothing else changed', async () => {
    const { edge } = await startBox({});
    const port = edge.lane!.port;
    const token = await holdSignedInAt(port, 'u-meena');
    const number = await receiptNumberAt(port, token);
    expect(await post(port, '/lane/sales', token, sale(`S-${number}`, number, { customerMobile: '9840012345' }))).toMatchObject({ committed: true, loyalty: 'member_named' });
  });
});
