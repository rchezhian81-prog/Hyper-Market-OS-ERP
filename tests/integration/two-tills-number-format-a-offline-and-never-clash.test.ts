import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest';
import { bootPos } from '../../apps/pos/src/browser-entry';
import { readLog } from '../../edge/store-edge/src/file-log';
import { financialYearLabel } from '../../packages/numbering/src/document-numbers';
import { signInAtLane, receiptNumberAt, signInTill } from '../support/till-operator';
import { backingsFor, headOffice, startBox, storePack, type Box } from '../support/till-bill-world';

/**
 * **OB-847 · OB-845 A · OB-846 A — from head office's register to two tills selling OFFLINE at the same moment, on the
 * in-memory store AND real PostgreSQL.**
 *
 *   head office registers two tills and a handheld at store 1 → its store pack carries format A: store 1, the tills' lane
 *   codes given automatically in the order they were registered (L01, L02; the handheld Q01) — nobody types a number or a
 *   code → the store computer, with NO head office reachable, numbers both tills at once: 1L01/<YY-YY>/00001… and
 *   1L02/<YY-YY>/00001…, never one number twice; a real till sale is saved under its number; a return takes 1R01; a cold
 *   restart carries every count on.
 */

const { backings, open, close } = backingsFor(process.env['DATABASE_URL']);
beforeAll(open);
afterAll(close);

const STORE = 'S1';
const boxes: Box[] = [];
afterEach(async () => { for (const b of boxes.splice(0)) { await b.stop(); await b.remove(); } });

describe.each(backings)('OB-847 — two tills number in format A offline and never clash — on $name', (backing) => {
  it('codes given automatically; numbers 1L01/…, 1L02/…, 1R01/… at the same moment; a cold restart carries on', async () => {
    const yy = financialYearLabel(new Date().toISOString());
    const ho = await headOffice(backing, [{ userId: 'u-box', role: 'store_computer', stores: [STORE] }, { userId: 'u-lanecash', role: 'cashier' }, { userId: 'u-lanecash2', role: 'cashier' }]);
    await ho.ok('POST', '/v1/org/nodes/SRE', 'u-owner', { kind: 'company', name: 'SRE Hyper Market Private Limited' });
    await ho.ok('POST', `/v1/org/nodes/${STORE}`, 'u-owner', { kind: 'branch', name: 'SRE Hyper Market', parentId: 'SRE', companyId: 'SRE' });
    await ho.ok('POST', `/v1/stores/${STORE}/settings`, 'u-owner', { tradingDayCutoff: '00:00', staleAfterSeconds: 900, countApprovalThresholdMinor: 0, handoverToleranceMinor: 0, cashVarianceToleranceMinor: 0, privacySlaDays: 15 });
    await ho.ok('POST', '/v1/platform/devices/lane-1/register', 'u-owner', { branchId: STORE, kind: 'pos_lane', label: 'Till 1' });
    await ho.ok('POST', '/v1/platform/devices/hh-1/register', 'u-owner', { branchId: STORE, kind: 'handheld', label: 'Queue handheld' });
    await ho.ok('POST', '/v1/platform/devices/lane-2/register', 'u-owner', { branchId: STORE, kind: 'pos_lane', label: 'Till 2' });

    const served = await ho.call('GET', `/v1/store-packs/${STORE}`, 'u-box', undefined, undefined, STORE);
    expect(served.status, JSON.stringify(served.body)).toBe(200);
    const sections = (served.body as { sections: Record<string, unknown> }).sections;
    expect(sections['receiptNumbering']).toMatchObject({ formatA: { storeNumber: 1, laneCodes: { 'lane-1': 'L01', 'lane-2': 'L02', 'device:hh-1': 'Q01' }, banked: {} } });

    // Two store computers' worth of tills on one box (the store PC), head office unreachable from here on.
    const people = [{ userId: 'u-lanecash', displayName: 'Lane Cashier' }, { userId: 'u-lanecash2', displayName: 'Lane Cashier 2' }];
    const box1 = await startBox({ tenantId: ho.tenantId, people, pack: { ...storePack(STORE), receiptNumbering: sections['receiptNumbering'] } });
    const box2 = await startBox({ tenantId: ho.tenantId, people, pack: { ...storePack(STORE), receiptNumbering: sections['receiptNumbering'] }, env: { EDGE_LANE_ID: 'lane-2' } });
    boxes.push(box1, box2);
    const t1 = await signInAtLane(box1.edge.lane!.port, 'u-lanecash');
    const t2 = await signInAtLane(box2.edge.lane!.port, 'u-lanecash2');
    const at1 = Array.from({ length: 12 }, () => receiptNumberAt(box1.edge.lane!.port, t1));
    const at2 = Array.from({ length: 12 }, () => receiptNumberAt(box2.edge.lane!.port, t2));
    const numbers = await Promise.all([...at1, ...at2]);
    expect(new Set(numbers).size).toBe(24);
    expect(numbers.filter((n) => n.startsWith('1L01/')).sort()).toEqual(Array.from({ length: 12 }, (_, i) => `1L01/${yy}/${String(i + 1).padStart(5, '0')}`));
    expect(numbers.filter((n) => n.startsWith('1L02/')).sort()).toEqual(Array.from({ length: 12 }, (_, i) => `1L02/${yy}/${String(i + 1).padStart(5, '0')}`));
    for (const n of numbers) expect(n.length).toBe(16);

    // A real till sale on lane 1, saved under its number; then a return number from the return range.
    const till = bootPos({ laneId: 'lane-1', lanePort: box1.edge.lane!.port, catalogue: { tenantId: ho.tenantId, version: 1, builtAt: new Date().toISOString(), products: [{ productId: 'P1', sku: 'DAL', name: 'Toor dal', baseUom: 'ea', unitPriceMinor: 10_500, taxBps: 500, status: 'active' }], barcodes: [{ code: '8901234567890', productId: 'P1', kind: 'standard' }] } });
    await signInTill(till, 'u-lanecash');
    till.scanBarcode('8901234567890');
    const n = await till.nextReceipt();
    expect(n).toBe(`1L01/${yy}/00013`);
    await till.tenderCash(`S-${n}`, n, new Date().toISOString());
    expect((await readLog(box1.edge.log.path)).flatMap((r) => (r.ok ? [(JSON.parse(r.record) as { id: string }).id] : []))).toEqual([`S-1L01/${yy}/00013`]);
    expect(await till.nextReceipt('return')).toBe(`1R01/${yy}/00001`);

    // A cold restart: each count carries on, never from 1.
    await box1.restartCold();
    expect(await receiptNumberAt(box1.edge.lane!.port, await signInAtLane(box1.edge.lane!.port, 'u-lanecash'))).toBe(`1L01/${yy}/00014`);
  }, 120_000);
});
