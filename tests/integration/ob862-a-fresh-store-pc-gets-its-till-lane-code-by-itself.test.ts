import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest';
import { mkdtemp, rm, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { financialYearLabel } from '../../packages/numbering/src/document-numbers';
import { ReceiptNumbers, type FormatAContext } from '../../edge/store-edge/src/receipt-numbers';
import { signInAtLane, receiptNumberAt } from '../support/till-operator';
import { backingsFor, headOffice, linkBoxTo, startBox, storePack, type Box, type HeadOffice } from '../support/till-bill-world';

/**
 * **OB-862 A (owner, 19 Nov 2026, in writing; the CA confirms) — head office gives the store computer's till its lane code BY
 * ITSELF, the first time the store computer reports that till, on the in-memory store AND real PostgreSQL.**
 *
 *   a freshly installed store PC (nobody registered its till on Tills & devices) reports to head office → head office gives
 *   its till `L01` (audited) → the store pack pulled in the same pass carries it → the first sale is `1L01/<YY-YY>/00001`
 *   with no person's step. A second till reported later gets `L02`; the first keeps `L01` (never renumbered); a code is
 *   never given twice. A store computer restored from a backup still numbers under a temporary `1T…` range (OB-853).
 */

const { backings, open, close } = backingsFor(process.env['DATABASE_URL']);
beforeAll(open);
afterAll(close);

const STORE = 'S1';
const boxes: Box[] = [];
const dirs: string[] = [];
afterEach(async () => {
  for (const b of boxes.splice(0)) { await b.stop(); await b.remove(); }
  for (const d of dirs.splice(0)) await rm(d, { recursive: true, force: true });
});

async function setUp(ho: HeadOffice): Promise<void> {
  await ho.ok('POST', '/v1/org/nodes/SRE', 'u-owner', { kind: 'company', name: 'SRE Hyper Market Private Limited' });
  await ho.ok('POST', `/v1/org/nodes/${STORE}`, 'u-owner', { kind: 'branch', name: 'SRE Hyper Market', parentId: 'SRE', companyId: 'SRE' });
  await ho.ok('POST', `/v1/stores/${STORE}/settings`, 'u-owner', { tradingDayCutoff: '00:00', staleAfterSeconds: 900, countApprovalThresholdMinor: 0, handoverToleranceMinor: 0, cashVarianceToleranceMinor: 0, privacySlaDays: 15 });
}

const healthReport = (lanes: readonly string[]) => ({
  storeId: STORE, observedAt: new Date().toISOString(),
  disk: { freeBytes: 10_000_000, totalBytes: 20_000_000, salesLogUsedBytes: 1_000, salesLogCapacityBytes: 10_000_000, reserveBytes: 1_000 },
  queue: { unsent: 0, deadLettered: 0 }, tills: [], lanes,
});

const laneCodesOf = async (ho: HeadOffice): Promise<Record<string, string>> => {
  const served = await ho.call('GET', `/v1/store-packs/${STORE}`, 'u-box', undefined, undefined, STORE);
  expect(served.status, JSON.stringify(served.body)).toBe(200);
  return ((served.body as { sections: { receiptNumbering: { formatA: { laneCodes: Record<string, string> } } } }).sections.receiptNumbering.formatA.laneCodes);
};

describe.each(backings)('OB-862 A — a fresh store PC gets its till lane code by itself — on $name', (backing) => {
  it('the store PC reports its till → L01, audited → the first sale is 1L01/YY-YY/00001 with no manual step', async () => {
    const yy = financialYearLabel(new Date().toISOString());
    const ho = await headOffice(backing, [{ userId: 'u-box', role: 'store_computer', stores: [STORE] }, { userId: 'u-lanecash', role: 'cashier' }]);
    await setUp(ho);
    expect(await laneCodesOf(ho)).toEqual({}); // nobody registered the till

    const link = linkBoxTo(ho, 'u-box', STORE);
    try {
      const box = await startBox({
        tenantId: ho.tenantId, people: [{ userId: 'u-lanecash', displayName: 'Lane Cashier' }], pack: storePack(STORE), cloud: { boxUser: 'u-box', storeId: STORE },
        env: { EDGE_LANE_ID: 'lane-1', EDGE_STORE_PACK_SOURCE: 'head-office', EDGE_STORE_ID: STORE },
      });
      boxes.push(box);
      // One pass as the box makes it: its health report (naming its own till), then the store pack.
      expect(await box.edge.reportBoxHealth!()).toBe(true);
      expect(await laneCodesOf(ho)).toEqual({ 'lane-1': 'L01' });
      expect(['updated', 'renewed']).toContain((await box.edge.refreshStorePack!()).status);
      const token = await signInAtLane(box.edge.lane!.port, 'u-lanecash');
      expect(await receiptNumberAt(box.edge.lane!.port, token)).toBe(`1L01/${yy}/00001`);
      expect(await receiptNumberAt(box.edge.lane!.port, token)).toBe(`1L01/${yy}/00002`);
    } finally { link.restore(); }

    // The assignment is on the audit trail: who reported it, which till, the code.
    const trail = (await ho.ok('GET', '/v1/audit/trail', 'u-owner', undefined, { action: 'till.lane_code.assign' })) as unknown as { matches: { actorId: string; objectId: string; after: { laneCode: string } }[] };
    expect(trail.matches.map((m) => [m.actorId, m.objectId, m.after.laneCode])).toEqual([['u-box', `${STORE}/lane-1`, 'L01']]);
  }, 120_000);

  it('a second till gets L02; the first keeps L01; reported again nothing changes; a code is never given twice', async () => {
    const ho = await headOffice(backing, [{ userId: 'u-box', role: 'store_computer', stores: [STORE] }]);
    await setUp(ho);
    const report = async (lanes: string[]) => {
      const r = await ho.call('POST', '/v1/store-computers/health-reports', 'u-box', healthReport(lanes), undefined, STORE);
      expect(r.status, JSON.stringify(r.body)).toBe(200);
      return (r.body as { laneCodesGiven?: Record<string, string> }).laneCodesGiven;
    };
    expect(await report(['lane-1'])).toEqual({ 'lane-1': 'L01' });
    expect(await report(['lane-1'])).toBeUndefined(); // already has one: nothing written
    expect(await report(['lane-1', 'lane-2'])).toEqual({ 'lane-2': 'L02' });
    expect(await laneCodesOf(ho)).toEqual({ 'lane-1': 'L01', 'lane-2': 'L02' });
    // A till registered by a person afterwards takes the NEXT code — never one already given.
    await ho.ok('POST', '/v1/platform/devices/lane-3/register', 'u-owner', { branchId: STORE, kind: 'pos_lane', label: 'Till 3' });
    // Registering lane-1 again on Tills & devices never renumbers it.
    await ho.ok('POST', '/v1/platform/devices/lane-1/register', 'u-owner', { branchId: STORE, kind: 'pos_lane', label: 'Till 1' });
    expect(await laneCodesOf(ho)).toEqual({ 'lane-1': 'L01', 'lane-2': 'L02', 'lane-3': 'L03' });
    // A later reported till still never reuses a code.
    expect(await report(['lane-4'])).toEqual({ 'lane-4': 'L04' });
    // Two reports at the same moment for two new tills: two different codes.
    const [a, b] = await Promise.all([report(['lane-5']), report(['lane-6'])]);
    expect(new Set([...Object.values(a ?? {}), ...Object.values(b ?? {})])).toEqual(new Set(['L05', 'L06']));
    const codes = Object.values(await laneCodesOf(ho));
    expect(new Set(codes).size).toBe(codes.length);
    // A lane id head office cannot read is refused by name, nothing kept.
    const bad = await ho.call('POST', '/v1/store-computers/health-reports', 'u-box', healthReport(['lane 1; drop']), undefined, STORE);
    expect(bad.status).toBe(400);
    expect(JSON.stringify(bad.body)).toMatch(/lanes must be a list/);
  }, 120_000);

  it('a store computer restored from a backup still numbers under a temporary 1T… range (OB-853), even with its L01 given', async () => {
    const ho = await headOffice(backing, [{ userId: 'u-box', role: 'store_computer', stores: [STORE] }]);
    await setUp(ho);
    const r = await ho.call('POST', '/v1/store-computers/health-reports', 'u-box', healthReport(['lane-1']), undefined, STORE);
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    const fa: FormatAContext = { storeNumber: 1, laneCodes: await laneCodesOf(ho), banked: {} };
    expect(fa.laneCodes).toEqual({ 'lane-1': 'L01' });
    const now = (): string => '2026-11-19T05:00:00.000Z';
    const dir = await mkdtemp(join(tmpdir(), 'sre-ob862-')); dirs.push(dir);
    const witnessDir = await mkdtemp(join(tmpdir(), 'sre-ob862-w-')); dirs.push(witnessDir);
    const reg = () => ReceiptNumbers.open({ dataDir: dir, witnessDir, capacityBytes: 4_194_304, published: () => null, now, numbering: () => ({ storeId: STORE, storesInBusiness: 1, formatA: fa }) });
    const first = await reg();
    expect(await first.issue({ laneId: 'lane-1', requestKey: 'a', issuedTo: 'u' })).toMatchObject({ receiptNumber: '1L01/26-27/00001' });
    await first.close();
    const backup = await readFile(join(dir, 'receipt-numbers.log'));
    const second = await reg();
    expect(await second.issue({ laneId: 'lane-1', requestKey: 'b', issuedTo: 'u' })).toMatchObject({ receiptNumber: '1L01/26-27/00002' });
    await second.close();
    await writeFile(join(dir, 'receipt-numbers.log'), backup); // the data folder restored from the backup
    const restored = await reg();
    expect(await restored.issue({ laneId: 'lane-1', requestKey: 'c', issuedTo: 'u' })).toMatchObject({ receiptNumber: '1T01/26-27/00001', fallbackBecause: 'restored_from_backup' });
    await restored.close();
  }, 120_000);
});
