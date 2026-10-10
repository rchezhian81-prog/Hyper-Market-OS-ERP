import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { apiHarness, TEST_IDP, TEST_PACK_KEY, type ApiHarness } from '../support/api-harness';
import { sealedReturn, sealedSale } from '../support/store-seal';
import type { HttpRequest } from '../../services/kernel/src/index';
import { startEdge, type EdgeProcess } from '../../edge/store-edge/src/main';
import { readLog } from '../../edge/store-edge/src/file-log';
import { bootPos } from '../../apps/pos/src/browser-entry';
import { cashAdapter, posAdapter, shiftAdapter, STREAM } from '../../services/api/src/adapters';
import { prepareTillBox, signInTill, managerApprovesOn, signInAtLane, operatorHeader } from '../support/till-operator';

/**
 * **Head office can tell a record the store computer verified from one it did not (ADR-0023 · Wave 2b-v-d · audit PF-02 ·
 * M12-FR-04 · M13-FR-03 · M14-FR-01 · hard rule #10).**
 *
 * A real store computer — its lane socket, its disk, its outbox, its sync agent — and the real head office (router, token
 * auth, RBAC, append-only store), sharing the pack signing key as a real store and its head office do. The cashier signs
 * in with their till PIN; the manager approves a refund with theirs. Every sale, refund, cash movement and till close the
 * box verified reaches head office SEALED, and head office flags none of them. A sale or refund that did not pass through
 * a till — sent by anyone holding the sync permission — is banked and flagged; a seal copied onto another record, or a
 * record naming someone other than the person the box verified, is flagged as not matching. Never refused: the money
 * already moved at the till.
 */

const A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const KEY = TEST_PACK_KEY; // the box and head office share it
const AT = new Date(Date.now() - 3_600_000).toISOString();

let h: ApiHarness;
let dir: string;
let edge: EdgeProcess;
const savedFetch = globalThis.fetch;

beforeAll(async () => {
  h = apiHarness();
  await h.seedOwner(A, 'u-owner');
  await h.provisionRole(A, 'u-meena', 'cashier');        // rings sales, holds the till
  await h.provisionRole(A, 'u-ravi', 'cashier');
  await h.provisionRole(A, 'u-mgr', 'store_manager');    // approves refunds
  await h.provisionRole(A, 'u-box', 'store_computer');          // the store computer's sync identity
  globalThis.fetch = (async (url: string, init: RequestInit): Promise<Response> => {
    if (String(url).startsWith('http://127.0.0.1:')) return savedFetch(url, init); // the till's own loopback calls
    const hdr = (init.headers ?? {}) as Record<string, string>;
    const res = await h.raw({
      method: (init.method ?? 'GET') as HttpRequest['method'], path: new URL(url).pathname,
      token: hdr['authorization']?.replace(/^Bearer /, ''), idempotencyKey: hdr['idempotency-key'],
      body: init.body === undefined ? undefined : JSON.parse(String(init.body)) as unknown,
    });
    return new Response(JSON.stringify(res.body), { status: res.status });
  }) as unknown as typeof globalThis.fetch;

  dir = await mkdtemp(join(tmpdir(), 'sre-store-seal-'));
  await prepareTillBox({
    dir, key: KEY,
    people: [{ userId: 'u-meena', displayName: 'Meena' }, { userId: 'u-ravi', displayName: 'Ravi' }, { userId: 'u-mgr', displayName: 'Manager', manager: true }],
    pack: {
      servicePolicy: { returnWindowDays: 30, approvalThresholdMinor: 0, noReceiptCapMinor: 100_000, agentAuthorityMinor: 0, compensationCapMinor: 0 },
      policies: { storeId: 'store-1', branchId: 'store-1', branchName: 'Main', tradingDayCutoff: '02:00', staleAfterSeconds: 300, countApprovalThresholdMinor: 100_000, handoverToleranceMinor: 10_000, cashVarianceToleranceMinor: 10_000, privacySlaDays: 30, warehouseId: 'wh-1' },
      lossPreventionRules: [],
      // This till's receipt numbers, as head office would publish them (audit PF-04): its first bill is R-SEAL-1.
      receiptSeries: [{ laneId: 'lane-1', prefix: 'R-SEAL-', padTo: 1, rangeStart: 1, rangeEnd: 999 }],
    },
  });
  edge = (await startEdge({
    EDGE_DATA_DIR: dir, EDGE_TENANT_ID: A, PACK_SIGNING_KEY: KEY, EDGE_CAPACITY_BYTES: '10485760', EDGE_LANE_PORT: '0', EDGE_LANE_ID: 'lane-1',
    EDGE_PACK_FILE: join(dir, 'store-pack.json'),
    CLOUD_API_URL: 'https://cloud.example.test', CLOUD_API_TOKEN: TEST_IDP.issue({ sub: 'u-box', tenantId: A }),
  }, () => {}))!;
});
afterAll(async () => {
  await edge.stop();
  globalThis.fetch = savedFetch;
  await rm(dir, { recursive: true, force: true });
});

const openExceptions = async () => posAdapter({ store: h.store, now: () => AT }).openExceptions(A);
const governance = async () =>
  ((await h.request({ method: 'GET', path: '/v1/pos/return-governance-exceptions', userId: 'u-owner', tenantId: A })).body as { count: number; exceptions: { returnId: string; governanceFlags: string[] }[] });
const banked = async (saleId: string) =>
  (await h.store.readStream(A, STREAM.sales, { type: 'SaleCommitted' })).map((e) => e.event.payload as Record<string, unknown>).find((p) => p['saleId'] === saleId);
const bank = (body: Record<string, unknown>) =>
  h.request({ method: 'POST', path: '/v1/sales', userId: 'u-box', tenantId: A, idempotencyKey: `bank-${String(body['saleId'])}`, body });
const syncRefund = (saleId: string, body: Record<string, unknown>) =>
  h.request({ method: 'POST', path: `/v1/sales/${saleId}/returns/synced`, userId: 'u-box', tenantId: A, idempotencyKey: `sync-${String(body['returnId'])}`, body });
const kindsFor = (saleId: string, all: readonly { saleId: string; kind: string; severity: string }[]) =>
  all.filter((e) => e.saleId === saleId).map((e) => `${e.kind}:${e.severity}`);

describe('the store computer seals who it verified; head office checks the seal', () => {
  it('a float, a sale, a manager-approved refund and the till close reach head office sealed — and nothing is flagged', async () => {
    const till = bootPos({ laneId: 'lane-1', taxPercent: 0, lanePort: edge.lane!.port });
    await signInTill(till, 'u-meena');
    expect(await till.till.moveCash({ kind: 'float_issue', amountMinor: 200_000, at: AT, movementId: 'cm-seal-float' })).toMatchObject({ committed: true });
    till.scan({ productId: 'P1', description: 'Toor dal 1kg', unitPriceMinor: 48_000, qty: 2 });
    const receipt = await till.nextReceipt();
    expect(receipt).toBe('R-SEAL-1');
    await till.tenderCash('S-SEAL-1', receipt, AT);
    till.newSale();
    const bill = (await till.lookupRefund('R-SEAL-1'))!;
    const approval = await managerApprovesOn(till, 'u-mgr', { kind: 'refund', billRef: 'S-SEAL-1', valueMinor: 48_000 });
    expect(await bill.submit({
      returnId: 'RT-SEAL-1', number: await till.nextReceipt(), reasonCode: 'damaged', refundMinor: 48_000, refundTender: 'cash',
      lines: [{ productId: 'P1', uom: 'ea', quantityMinor: 1, disposition: 'damaged' }], approval,
    })).toMatchObject({ kind: 'settled' });
    // ₹2,000 float + ₹960 sale − ₹480 refund = ₹2,480 in the drawer.
    expect(await till.till.close({ shiftId: 'sh-seal-1', closedAt: new Date().toISOString(), countedMinor: 248_000 })).toMatchObject({ closed: true, varianceMinor: 0 });

    const pass = await edge.syncOnce!();
    expect(pass.dead).toBe(0);

    // What travelled carries the box's seal on the person it verified — and on the manager's approval.
    expect(await banked('S-SEAL-1')).toMatchObject({ cashierId: 'u-meena', operatorVerified: { userId: 'u-meena', via: 'pin', laneId: 'lane-1', seal: expect.stringMatching(/^[0-9a-f]{64}$/) } });
    // Head office checked every seal, and flags nothing: not the sale, not the refund, not the cash, not the close.
    expect(kindsFor('S-SEAL-1', await openExceptions()).filter((k) => k.startsWith('cashier_'))).toEqual([]);
    expect((await governance()).exceptions.filter((e) => e.returnId === 'RT-SEAL-1')).toEqual([]);
    const moved = await cashAdapter({ store: h.store, now: () => AT }).tillMovements(A, 'lane-1');
    expect(moved.find((m) => m.movementId === 'cm-seal-float')).toMatchObject({ performedBy: 'u-meena', relayed: true });
    expect(moved.find((m) => m.movementId === 'cm-seal-float')?.flags ?? []).toEqual([]);
    const closed = await shiftAdapter({ store: h.store, now: () => AT }).closedShift(A, 'sh-seal-1');
    expect(closed).toMatchObject({ cashierId: 'u-meena' });
    expect((closed?.flags ?? []).filter((f) => f.startsWith('cashier_'))).toEqual([]);
  });

  it('a sale that never passed through a till is banked AND flagged — head office cannot confirm who rang it', async () => {
    const res = await bank({
      saleId: 'S-NOTILL', receiptNumber: 'R-NOTILL', laneId: 'lane-1', cashierId: 'u-meena', tradingDay: AT.slice(0, 10), committedAt: AT,
      totalMinor: 48_000, currency: 'INR', packVersion: 1,
      lines: [{ productId: 'P1', quantityMinor: 1, uom: 'each', unitPriceMinor: 48_000, lineTotalMinor: 48_000 }],
      tenders: [{ kind: 'cash', amountMinor: 48_000 }],
    });
    expect(res.status).toBe(202); // never refused — a sale that happened is still a sale
    expect(kindsFor('S-NOTILL', await openExceptions())).toContain('cashier_not_verified_at_store:material');
  });

  it('a seal copied onto another sale, or a sale naming someone other than the person the box verified, does not match — critical', async () => {
    const real = (await banked('S-SEAL-1'))!;
    // The box's seal lifted onto a different sale: same cashier, different record.
    await bank({ ...real, saleId: 'S-COPIED', receiptNumber: 'R-COPIED' });
    expect(kindsFor('S-COPIED', await openExceptions())).toContain('cashier_seal_does_not_match:critical');
    // The same sale, re-sent naming another cashier under the box's seal for Meena.
    await bank({ ...real, saleId: 'S-RENAMED', receiptNumber: 'R-RENAMED', cashierId: 'u-ravi' });
    expect(kindsFor('S-RENAMED', await openExceptions())).toContain('cashier_seal_does_not_match:critical');
    // A sale the harness seals as a current box would — under the shared key — is not flagged.
    await bank(sealedSale(A, { ...real, saleId: 'S-RESEALED', receiptNumber: 'R-RESEALED', operatorVerified: undefined }));
    expect(kindsFor('S-RESEALED', await openExceptions()).filter((k) => k.startsWith('cashier_'))).toEqual([]);
  });

  it('a relayed refund naming a manager the box never verified approving it is flagged; so is a processor without the seal', async () => {
    const refund = {
      returnId: 'RT-NOTILL', number: 'RT-NOTILL', processedBy: 'u-meena', approvedBy: 'u-mgr', reasonCode: 'damaged',
      refundMinor: 48_000, refundTender: 'cash', processedAt: AT, lines: [{ productId: 'P1', uom: 'each', quantityMinor: 1, disposition: 'damaged' }],
    };
    // The processor sealed by the box, but the manager's approval carries no seal: the approval is the flag.
    const sealed = sealedReturn(A, refund);
    const { approvalVerified: _unsealed, ...withoutApproval } = sealed;
    void _unsealed;
    expect((await syncRefund('S-SEAL-1', withoutApproval)).body).toMatchObject({ reconciled: true, flags: ['approval_not_verified_at_store'] });
    // Nothing sealed at all: both flags.
    expect((await syncRefund('S-SEAL-1', { ...refund, returnId: 'RT-BARE', number: 'RT-BARE' })).body)
      .toMatchObject({ reconciled: true, flags: expect.arrayContaining(['cashier_not_verified_at_store', 'approval_not_verified_at_store']) });
    // A real box's approval seal lifted onto another refund: does not match.
    const realRefund = (await readLog(edge.returnsLog.path)).flatMap((r) => (r.ok ? [JSON.parse(r.record) as Record<string, unknown>] : []))
      .find((r) => r['returnId'] === 'RT-SEAL-1')!;
    const lifted = sealedReturn(A, { ...refund, returnId: 'RT-LIFTED', number: 'RT-LIFTED' });
    expect((await syncRefund('S-SEAL-1', { ...lifted, approvalVerified: realRefund['approvalVerified'] })).body)
      .toMatchObject({ reconciled: true, flags: expect.arrayContaining(['approval_seal_does_not_match']) });
  });

  it('who recorded a cash movement is the person signed in at the till — whatever the till\'s body says', async () => {
    const token = await signInAtLane(edge.lane!.port, 'u-meena');
    const res = await fetch(`http://127.0.0.1:${edge.lane!.port}/lane/cash-movements`, {
      method: 'POST', headers: { 'content-type': 'application/json', ...operatorHeader(token) },
      // The till was closed above, so this opens a fresh float — and the body claims Ravi recorded it.
      body: JSON.stringify({ movementId: 'cm-seal-loan', movementKind: 'float_issue', amountMinor: 10_000, at: new Date().toISOString(), custodianId: 'u-meena', performedBy: 'u-ravi' }),
    });
    expect(await res.json()).toMatchObject({ committed: true });
    const onDisk = (await readLog(edge.tillCashLog.path)).flatMap((r) => (r.ok ? [JSON.parse(r.record) as Record<string, unknown>] : []))
      .find((r) => r['movementId'] === 'cm-seal-loan');
    expect(onDisk).toMatchObject({ performedBy: 'u-meena', operatorVerified: { userId: 'u-meena', laneId: 'lane-1' } });
  });
});
