import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import { apiHarness, type ApiHarness } from '../support/api-harness';
import { sealedReturn } from '../support/store-seal';
import { SqlIdempotencyStore } from '../../services/kernel/src/index';
import { pgPoolClient } from '../../packages/persistence/src/pg-client';
import { SqlEventStore } from '../../packages/persistence/src/event-store';
import { runMigrations } from '../../packages/persistence/src/migrations';

/**
 * **D-21 (R4, OB-217) — one loss-prevention view joins the till exceptions, the waste and shrink and the count differences;
 * it proposes a case and a person decides; CCTV is a reference only**, on the real API, in memory and on REAL PostgreSQL,
 * with a cold restart:
 *
 *   • ghee: a void and a price override at the till, a refund that took one back, a damaged-goods write-off and a count
 *     that came up short — all in one view, for the product AND for the cashier who rang the exceptions;
 *   • the view PROPOSES a case and opens nothing (the open list stays empty); a person opens it, naming the investigator;
 *   • a CCTV clip is recorded as camera + time from–to + who collected it; a body carrying video is refused by name, and the
 *     generic evidence door refuses the cctv kind; the reference is sealed onto the chain and survives a restart;
 *   • the case cannot close without an outcome; "unfounded" closes it; a cashier may not read the view or add CCTV (403).
 */

const DATABASE_URL = process.env['DATABASE_URL'];
let pool: Pool | undefined;
beforeAll(async () => {
  if (DATABASE_URL === undefined) return;
  pool = new Pool({ connectionString: DATABASE_URL, max: 6, options: '-c app.tenant_id=*' });
  const dir = 'db/migrations';
  await runMigrations(pgPoolClient(pool), readdirSync(dir).filter((f) => f.endsWith('.sql')).sort().map((name) => ({ name, sql: readFileSync(join(dir, name), 'utf8') })));
});
afterAll(async () => { await pool?.end(); });

const backings: { name: string; harness: () => ApiHarness; restart: (h: ApiHarness) => ApiHarness }[] = [
  { name: 'the in-memory event store', harness: () => apiHarness(), restart: (h) => apiHarness({ store: h.store }) },
];
if (DATABASE_URL !== undefined) {
  const sqlHarness = () => { const sql = pgPoolClient(pool!); return apiHarness({ store: new SqlEventStore(sql), idempotency: new SqlIdempotencyStore(sql) }); };
  backings.push({ name: 'real PostgreSQL', harness: sqlHarness, restart: sqlHarness });
}

type Res = { status: number; body: unknown };
const codeOf = (r: Res): string | undefined => (r.body as { error?: { code?: string } }).error?.code;
/** The shop's day (IST) for an instant. */
const shopDay = (ms: number) => new Date(ms + 330 * 60_000).toISOString().slice(0, 10);
interface View {
  tillExceptions: { ref: string; kind: string }[]; shrink: { ref: string }[]; countDifferences: { ref: string; varianceMinor: number }[];
  productsJoined: string[]; opened: boolean;
  proposal: { propose: boolean; raisedFromRef: string; subjectRef: string; summary: string; valueMinor: number; because: string };
}

describe.each(backings)('an LP case joins till exceptions, shrink and counts — on $name (D-21)', ({ harness, restart }) => {
  it('one view, a proposal a person acts on, CCTV as a reference only, closed as unfounded', async () => {
    let h = harness();
    const T = randomUUID();
    await h.seedOwner(T, 'u-owner');
    await h.provisionRole(T, 'u-mgr', 'store_manager');
    await h.provisionRole(T, 'u-cash', 'cashier');
    await h.provisionRole(T, 'u-box', 'store_computer', ['S1']);
    const req = (method: 'GET' | 'POST', path: string, body?: unknown, userId = 'u-owner', query?: Record<string, string>): Promise<Res> =>
      h.request({ method, path, userId, tenantId: T, ...(method === 'POST' ? { idempotencyKey: `k-${randomUUID()}` } : {}), ...(body === undefined ? {} : { body }), ...(query === undefined ? {} : { query }) });
    const ok = async (p: Promise<Res>, what: string): Promise<Res> => { const r = await p; expect(r.status, `${what}: ${JSON.stringify(r.body)}`).toBeLessThan(300); return r; };
    const now = Date.now();
    const today = shopDay(now);
    const at = new Date(now).toISOString();
    const from = shopDay(now - 3 * 86_400_000);
    const to = shopDay(now + 86_400_000);

    // Stock at a cost, so a write-off and a count are valued.
    for (const [p, cost] of [['p-ghee', 5_000], ['p-rice', 4_000]] as const) {
      await ok(req('POST', '/v1/inventory/movements', { movementId: `rx-${p}`, productId: p, locationId: 'S1', kind: 'received', quantityMinor: 10, uom: 'ea', occurredAt: new Date(now - 10 * 86_400_000).toISOString(), enteredBy: 'u-owner', unitCostMinor: cost }), `receive ${p}`);
    }
    // At the till (relayed by the store box): a void and a price override on ghee, and a no-sale, by u-ravi.
    const base = { laneId: 'lane-1', cashierId: 'u-ravi', at, tradingDay: today };
    await ok(req('POST', '/v1/loss-prevention/activity/V-1/synced', { ...base, activityId: 'V-1', kind: 'void', billRef: 'B-1', lineId: 'L1', productId: 'p-ghee', description: 'Ghee 1L', valueMinor: 64_000, reason: 'customer_changed_mind' }, 'u-box'), 'void');
    await ok(req('POST', '/v1/loss-prevention/activity/O-1/synced', { ...base, activityId: 'O-1', kind: 'price_override', billRef: 'B-2', lineId: 'L1', productId: 'p-ghee', description: 'Ghee 1L', fromUnitMinor: 64_000, toUnitMinor: 50_000, quantityMinor: 1, valueMinor: 14_000, reason: 'damaged_pack', approvedBy: 'u-mgr', approvalId: 'apr-O-1' }, 'u-box'), 'override');
    await ok(req('POST', '/v1/loss-prevention/activity/N-1/synced', { ...base, activityId: 'N-1', kind: 'no_sale', reason: 'change_for_customer', valueMinor: 0, approvedBy: 'u-mgr', approvalId: 'apr-N-1' }, 'u-box'), 'no-sale');
    // A refund of one ghee, processed at the lane by u-ravi.
    await ok(req('POST', '/v1/sales', { saleId: 'S-1', receiptNumber: 'R-1', laneId: 'lane-1', cashierId: 'u-ravi', tradingDay: today, committedAt: at, totalMinor: 64_000, currency: 'INR', packVersion: 1, lines: [{ productId: 'p-ghee', quantityMinor: 1, uom: 'ea', unitPriceMinor: 64_000, lineTotalMinor: 64_000 }], tenders: [{ kind: 'cash', amountMinor: 64_000 }] }), 'sale');
    await ok(h.request({ method: 'POST', path: '/v1/sales/S-1/returns/synced', userId: 'u-owner', tenantId: T, idempotencyKey: 'ret-1', body: sealedReturn(T, { returnId: 'RT-1', number: 'RT-1', processedBy: 'u-ravi', reasonCode: 'customer_changed_mind', refundMinor: 64_000, refundTender: 'cash', lines: [{ productId: 'p-ghee', uom: 'ea', quantityMinor: 1, disposition: 'resell' }], processedAt: at, approvedBy: 'u-mgr' }) }), 'refund');
    // Waste: one ghee damaged (small, on the raiser's own); rice spoiled. A count of ghee comes up short.
    await ok(req('POST', '/v1/inventory/write-off/W-1', { productId: 'p-ghee', locationId: 'S1', qty: 1, uom: 'ea', lossType: 'damage', reasonCode: 'damage' }, 'u-mgr'), 'write-off ghee');
    await ok(req('POST', '/v1/inventory/write-off/W-2', { productId: 'p-rice', locationId: 'S1', qty: 1, uom: 'ea', lossType: 'damage', reasonCode: 'damage' }, 'u-mgr'), 'write-off rice');
    await ok(req('POST', '/v1/inventory/counts/C-1', { productId: 'p-ghee', locationId: 'S1', uom: 'ea', countedMinor: 8, reasonCode: 'cycle_count' }, 'u-mgr'), 'count');

    const view = async (q: Record<string, string>, userId = 'u-mgr'): Promise<View> => (await ok(req('GET', '/v1/loss-prevention/correlation', undefined, userId, { ...q, from, to }), 'view')).body as View;
    const ghee = await view({ productId: 'p-ghee' });
    expect(ghee.tillExceptions.map((t) => t.kind).sort()).toEqual(['price_override', 'refund', 'void']);
    expect(ghee.shrink.map((s) => s.ref)).toEqual(['write-off:W-1']);
    // Expected 9 (10 received − 1 sold + 1 returned − 1 written off); 8 counted.
    expect(ghee.countDifferences).toEqual([expect.objectContaining({ ref: 'count:C-1', varianceMinor: -1 })]);
    expect(ghee.proposal).toMatchObject({ propose: true, subjectRef: 'product:p-ghee', raisedFromRef: `lp-correlation:product:p-ghee:${from}:${to}` });
    expect(ghee.opened).toBe(false);
    const ravi = await view({ cashierId: 'u-ravi' });
    expect(ravi.tillExceptions.map((t) => t.kind).sort()).toEqual(['no_sale', 'price_override', 'refund', 'void']);
    expect(ravi.productsJoined).toEqual(['p-ghee']);
    expect(ravi.shrink.map((s) => s.ref)).toEqual(['write-off:W-1']); // the rice write-off is not joined to him
    expect((await view({ productId: 'p-rice' })).proposal.propose).toBe(false);
    // Nothing was opened by the view.
    expect(((await ok(req('GET', '/v1/loss-prevention/cases', undefined, 'u-mgr'), 'cases')).body as { openCount: number }).openCount).toBe(0);

    // A PERSON opens a case from the proposal, naming the investigator.
    await ok(req('POST', '/v1/loss-prevention/cases/case-ghee', { raisedFromRef: ghee.proposal.raisedFromRef, subjectRef: ghee.proposal.subjectRef, summary: ghee.proposal.summary, valueMinor: ghee.proposal.valueMinor, assignedTo: 'u-mgr' }), 'open');

    // CCTV: a reference only.
    const clip = { cameraId: 'CAM-3', from: new Date(now - 3_600_000).toISOString(), to: new Date(now - 3_000_000).toISOString(), collectedBy: 'u-mgr' };
    const video = await req('POST', '/v1/loss-prevention/cases/case-ghee/cctv/ev-video', { ...clip, contentBase64: 'AAAA' }, 'u-mgr');
    expect(video.status).toBe(422);
    expect(codeOf(video)).toBe('video_not_stored');
    expect(codeOf(await req('POST', '/v1/loss-prevention/cases/case-ghee/cctv/ev-back', { ...clip, from: clip.to, to: clip.from }, 'u-mgr'))).toBe('cctv_period_backwards');
    expect(codeOf(await req('POST', '/v1/loss-prevention/cases/case-ghee/evidence/ev-free', { kind: 'cctv_reference', ref: 'https://cctv/clip.mp4', description: 'clip', collectedBy: 'u-mgr', collectedFrom: 'dvr' }, 'u-mgr'))).toBe('cctv_reference_has_its_own_form');
    expect((await req('POST', '/v1/loss-prevention/cases/case-ghee/cctv/ev-cash', clip, 'u-cash')).status).toBe(403);
    const added = await ok(req('POST', '/v1/loss-prevention/cases/case-ghee/cctv/ev-cctv', clip, 'u-mgr'), 'cctv');
    expect(added.body).toMatchObject({ kind: 'cctv_reference', ref: `cctv:camera=CAM-3;from=${clip.from};to=${clip.to}`, videoStored: false });

    // ── A COLD RESTART: the case and its sealed evidence are rebuilt from the store ─────────────────────────────────
    h = restart(h);
    const got = (await ok(req('GET', '/v1/loss-prevention/cases/case-ghee', undefined, 'u-mgr'), 'case')).body as { evidence: { kind: string; ref: string; collectedBy: string; description: string }[]; chain: { intact: boolean }; raisedFromRef: string };
    expect(got.raisedFromRef).toBe(ghee.proposal.raisedFromRef);
    expect(got.evidence).toEqual([expect.objectContaining({ kind: 'cctv_reference', collectedBy: 'u-mgr', description: expect.stringMatching(/No video is stored or analysed/) })]);
    expect(got.chain.intact).toBe(true);

    // Close: not without an outcome; "unfounded" is a valid one.
    expect(codeOf(await req('POST', '/v1/loss-prevention/cases/case-ghee/close', { note: 'checked the clip' }, 'u-mgr'))).toBe('not_readable_as_a_close');
    expect(((await ok(req('POST', '/v1/loss-prevention/cases/case-ghee/close', { outcome: 'unfounded', note: 'the clip shows a genuine damaged pack' }, 'u-mgr'), 'close')).body as { outcome: string }).outcome).toBe('unfounded');

    // Permissions and error paths.
    expect((await req('GET', '/v1/loss-prevention/correlation', undefined, 'u-cash', { productId: 'p-ghee', from, to })).status).toBe(403);
    expect(codeOf(await req('GET', '/v1/loss-prevention/correlation', undefined, 'u-mgr', { productId: 'p-ghee', cashierId: 'u-ravi', from, to }))).toBe('not_readable_as_a_correlation');
    expect(codeOf(await req('GET', '/v1/loss-prevention/correlation', undefined, 'u-mgr', { productId: 'p-ghee', from: to, to: from }))).toBe('not_readable_as_a_correlation');
  }, 120_000);
});
