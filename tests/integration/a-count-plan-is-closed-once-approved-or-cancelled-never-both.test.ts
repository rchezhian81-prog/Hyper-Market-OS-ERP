import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import { apiHarness, type ApiHarness } from '../support/api-harness';
import { STREAM, streamName } from '../../services/api/src/adapters';
import { SqlIdempotencyStore } from '../../services/kernel/src/index';
import { pgPoolClient } from '../../packages/persistence/src/pg-client';
import { SqlEventStore } from '../../packages/persistence/src/event-store';
import { runMigrations } from '../../packages/persistence/src/migrations';

/**
 * **WF-08 · OB-59 · OB-66 — a stock-count plan is closed ONCE: approved or cancelled, never both (hard rule #10).**
 *
 * On the real head-office API (in memory and, with DATABASE_URL, on real PostgreSQL):
 *   • RACE approve vs cancel: a second person approves a counted plan while the planner cancels it at the same moment —
 *     repeated over several plans so both outcomes occur. Exactly one lands; the other is refused by name (409). The plan's
 *     terminal record is ONE event; an approved plan posted its variance once, a cancelled one posted nothing.
 *   • RACE approve vs approve: both answer 200 (one `alreadyApproved`), the variance posts once.
 *   • OB-66 FIRST CANCEL: a damaged arrival held on an open count is applied by the FIRST cancel (not only by a re-send) — the
 *     write-off is on the register once, with outcome `cancelled`; a re-sent cancel applies nothing.
 */

const DATABASE_URL = process.env['DATABASE_URL'];
let pool: Pool | undefined;
beforeAll(async () => {
  if (DATABASE_URL === undefined) return;
  pool = new Pool({ connectionString: DATABASE_URL, max: 8, options: '-c app.tenant_id=*' });
  const dir = 'db/migrations';
  await runMigrations(pgPoolClient(pool), readdirSync(dir).filter((f) => f.endsWith('.sql')).sort().map((name) => ({ name, sql: readFileSync(join(dir, name), 'utf8') })));
});
afterAll(async () => { await pool?.end(); });
const backings: { name: string; harness: () => ApiHarness }[] = [{ name: 'the in-memory event store', harness: () => apiHarness() }];
if (DATABASE_URL !== undefined) backings.push({ name: 'real PostgreSQL', harness: () => { const sql = pgPoolClient(pool!); return apiHarness({ store: new SqlEventStore(sql), idempotency: new SqlIdempotencyStore(sql) }); } });

type Res = { status: number; body: unknown };
const codeOf = (r: Res): string | undefined => (r.body as { error?: { code?: string } }).error?.code;
const TODAY = new Date().toISOString().slice(0, 10);

async function shop(harness: () => ApiHarness) {
  const h = harness();
  const T = randomUUID();
  await h.seedOwner(T, 'u-owner');
  for (const u of ['u-plan', 'u-c1', 'u-appr', 'u-appr2', 'u-back', 'u-floor']) await h.provisionRole(T, u, 'store_manager');
  const call = (method: 'GET' | 'POST', path: string, userId: string, body?: unknown, query?: Record<string, string>): Promise<Res> =>
    h.request({ method, path, userId, tenantId: T, ...(body === undefined ? {} : { body }), ...(query === undefined ? {} : { query }), ...(method === 'GET' ? {} : { idempotencyKey: `k-${randomUUID()}` }) });
  const ok = async (p: Promise<Res>, what: string): Promise<Res> => { const r = await p; expect(r.status, `${what}: ${JSON.stringify(r.body)}`).toBeLessThan(300); return r; };
  await ok(call('POST', '/v1/org/nodes/C1', 'u-owner', { kind: 'company', name: 'SRE Retail' }), 'company');
  await ok(call('POST', '/v1/org/nodes/S1', 'u-owner', { kind: 'branch', name: 'Store 1', parentId: 'C1', companyId: 'C1' }), 'store');
  await ok(call('POST', '/v1/org/nodes/S1-BACK', 'u-owner', { kind: 'warehouse', name: 'Store 1 back store', parentId: 'S1', companyId: 'C1' }), 'back store');
  const onHand = async (productId: string, loc = 'S1'): Promise<number> =>
    ((await call('GET', '/v1/inventory/availability', 'u-owner', undefined, { productId })).body as { rows: { locationId: string; onHandMinor: number }[] }).rows.filter((r) => r.locationId === loc).reduce((s, r) => s + r.onHandMinor, 0);
  const movementIds = async (): Promise<string[]> => (await h.store.readStream(T, STREAM.inventory, { type: 'InventoryMoved' })).map((e) => (e.event.payload as { movementId: string }).movementId);
  const terminalSteps = async (planId: string): Promise<string[]> => (await h.store.readStream(T, streamName(STREAM.inventory, 'count-plans'), { type: 'CountPlanRecorded' }))
    .map((e) => e.event.payload as { step: string; plan: { planId: string } }).filter((p) => p.plan.planId === planId && (p.step === 'approved' || p.step === 'cancelled')).map((p) => p.step);
  /** A plan on one product, opened, counted 2 short by u-c1, its cause set — ready for approval. */
  const countedPlan = async (planId: string, productId: string) => {
    await ok(call('POST', '/v1/inventory/movements', 'u-owner', { movementId: `rcv-${productId}`, productId, locationId: 'S1', kind: 'received', quantityMinor: 20, uom: 'EA', occurredAt: `${TODAY}T01:00:00.000Z`, enteredBy: 'u-owner', unitCostMinor: 1_000 }), 'stock');
    await ok(call('POST', `/v1/inventory/count-plans/${planId}`, 'u-plan', { locationId: 'S1', productIds: [productId], recountThresholdMinor: 1_000_000, note: 'aisle' }), 'plan');
    await ok(call('POST', `/v1/inventory/count-plans/${planId}/open`, 'u-plan', {}), 'open');
    await ok(call('POST', `/v1/inventory/count-plans/${planId}/counts/k-${planId}`, 'u-c1', { productId, locationId: 'S1', uom: 'EA', countedMinor: 18 }), 'count');
    await ok(call('POST', `/v1/inventory/count-plans/${planId}/counts/k-${planId}/cause`, 'u-plan', { causeCode: 'theft_suspected', note: 'two tins missing' }), 'cause');
  };
  const planState = async (planId: string) => ((await call('GET', `/v1/inventory/count-plans/${planId}`, 'u-plan')).body as { plan: { state: string } }).plan.state;
  return { h, T, call, ok, onHand, movementIds, terminalSteps, countedPlan, planState };
}

describe.each(backings)('a count plan is closed once — approved or cancelled, never both — on $name', ({ harness }) => {
  it('approve and cancel at the same moment: exactly one lands, the other is refused by name; the stock follows the one that landed', async () => {
    const { call, onHand, movementIds, terminalSteps, countedPlan, planState } = await shop(harness);
    const outcomes = new Set<string>();
    for (let i = 1; i <= 6; i += 1) {
      const planId = `cp${i}`;
      const productId = `P${i}`;
      await countedPlan(planId, productId);
      // One of the two is sent a little later each time (cancel first by 20 ms … approval first by 20 ms) so they meet at
      // every stage — before the approval claims the plan, while it posts, after — and both outcomes really occur.
      const lead = [-20, -8, -2, 0, 4, 20][i - 1]!; // < 0: the cancel goes first; > 0: the approval goes first
      const later = <T>(ms: number, f: () => Promise<T>): Promise<T> => new Promise<void>((r) => { setTimeout(r, Math.max(0, ms)); }).then(f);
      const [approve, cancel] = await Promise.all([
        later(-lead, () => call('POST', `/v1/inventory/count-plans/${planId}/approve`, 'u-appr', { reason: 'aisle done' })),
        later(lead, () => call('POST', `/v1/inventory/count-plans/${planId}/cancel`, 'u-plan', { reason: 'wrong aisle' })),
      ]);
      const statuses = [approve.status, cancel.status].sort();
      expect(statuses, JSON.stringify([approve.body, cancel.body])).toEqual([200, 409]);
      const state = await planState(planId);
      outcomes.add(state);
      // ONE terminal record — never approved AND cancelled.
      expect(await terminalSteps(planId)).toEqual([state]);
      const posted = (await movementIds()).filter((id) => id === `count:k-${planId}`);
      if (state === 'approved') {
        expect(approve.status).toBe(200);
        expect(['count_plan_already_approved']).toContain(codeOf(cancel));
        expect(posted).toHaveLength(1);
        expect(await onHand(productId)).toBe(18);
      } else {
        expect(state).toBe('cancelled');
        expect(cancel.status).toBe(200);
        expect(['count_plan_already_cancelled', 'count_plan_not_open']).toContain(codeOf(approve));
        expect(posted).toEqual([]);
        expect(await onHand(productId)).toBe(20);
      }
    }
    // Over six races the plans did not all fall the same way only by accident of order — but either way never both.
    expect([...outcomes].sort()).toEqual(["approved", "cancelled"]);
  }, 120_000);

  it('two approvals at the same moment: one decides, the other is told it stands; the variance posts once', async () => {
    const { call, onHand, movementIds, terminalSteps, countedPlan } = await shop(harness);
    await countedPlan('cpa', 'PA');
    const [a, b] = await Promise.all([
      call('POST', '/v1/inventory/count-plans/cpa/approve', 'u-appr', { reason: 'aisle done' }),
      call('POST', '/v1/inventory/count-plans/cpa/approve', 'u-appr2', { reason: 'aisle done too' }),
    ]);
    expect([a.status, b.status], JSON.stringify([a.body, b.body])).toEqual([200, 200]);
    expect([a, b].filter((r) => (r.body as { alreadyApproved: boolean }).alreadyApproved)).toHaveLength(1);
    expect(await terminalSteps('cpa')).toEqual(['approved']);
    expect((await movementIds()).filter((id) => id === 'count:k-cpa')).toHaveLength(1);
    expect(await onHand('PA')).toBe(18);
    // Cancelling after the approval is refused by name; nothing changes.
    const late = await call('POST', '/v1/inventory/count-plans/cpa/cancel', 'u-plan', { reason: 'too late' });
    expect([late.status, codeOf(late)]).toEqual([409, 'count_plan_already_approved']);
    expect(await terminalSteps('cpa')).toEqual(['approved']);
  }, 60_000);

  it('OB-66: the FIRST cancel applies the held damaged write-off (once); a re-sent cancel applies nothing', async () => {
    const { call, ok, onHand, movementIds, terminalSteps } = await shop(harness);
    const HELD = 'ind-1:is-1-damaged-1';
    for (const [id, loc, qty] of [['s-floor', 'S1', 20], ['s-back', 'S1-BACK', 10]] as const) {
      await ok(call('POST', '/v1/inventory/movements', 'u-owner', { movementId: id, productId: 'P2', locationId: loc, kind: 'received', quantityMinor: qty, uom: 'EA', occurredAt: `${TODAY}T01:00:00.000Z`, enteredBy: 'u-owner', unitCostMinor: 1_000 }), id);
    }
    await ok(call('POST', '/v1/floor/indents/ind-1', 'u-plan', { fromLocationId: 'S1-BACK', toLocationId: 'S1', lines: [{ productId: 'P2', quantityMinor: 6, uom: 'EA' }], reason: 'shelf 4 empty' }), 'indent');
    await ok(call('POST', '/v1/floor/indents/ind-1/approval', 'u-appr', {}), 'indent approval');
    await ok(call('POST', '/v1/floor/indents/ind-1/issues/is-1', 'u-back', { lines: [{ productId: 'P2', batchId: null, quantityMinor: 6 }] }), 'issue');
    await ok(call('POST', '/v1/inventory/count-plans/cph', 'u-plan', { locationId: 'S1', productIds: ['P2'], recountThresholdMinor: 1_000_000, note: 'aisle 4' }), 'plan');
    await ok(call('POST', '/v1/inventory/count-plans/cph/open', 'u-plan', {}), 'open');
    const rcv = await ok(call('POST', '/v1/floor/indents/ind-1/issues/is-1/receipt', 'u-floor', { counted: [{ productId: 'P2', batchId: null, quantityMinor: 5, damagedMinor: 1 }] }), 'receipt');
    expect((rcv.body as { heldWriteOffs: { heldId: string; planId: string }[] }).heldWriteOffs.map((x) => [x.heldId, x.planId])).toEqual([[HELD, 'cph']]);
    expect(((await call('GET', '/v1/inventory/write-offs', 'u-owner')).body as { writeOffs: unknown[] }).writeOffs).toEqual([]);
    expect(await onHand('P2')).toBe(25);

    // The FIRST cancel applies it: the damaged unit in and written off, on the register once, outcome `cancelled`.
    const first = await ok(call('POST', '/v1/inventory/count-plans/cph/cancel', 'u-plan', { reason: 'count abandoned' }), 'cancel');
    expect(first.body).toMatchObject({ alreadyCancelled: false });
    expect((first.body as { heldWriteOffsApplied: { writeOffId: string; outcome: string }[] }).heldWriteOffsApplied.map((a) => [a.writeOffId, a.outcome])).toEqual([[`held-${HELD}`, 'cancelled']]);
    const wos = ((await call('GET', '/v1/inventory/write-offs', 'u-owner')).body as { writeOffs: { id: string; qtyRemoved: number; valueMinor: number }[] }).writeOffs;
    expect(wos.map((w) => [w.id, w.qtyRemoved, w.valueMinor])).toEqual([[`held-${HELD}`, 1, 1_000]]);
    expect(await onHand('P2')).toBe(25); // in and out: the shelf holds the 25 good units
    // A re-sent cancel applies nothing twice.
    const again = await ok(call('POST', '/v1/inventory/count-plans/cph/cancel', 'u-plan', { reason: 'count abandoned' }), 'cancel again');
    expect(again.body).toMatchObject({ alreadyCancelled: true, heldWriteOffsApplied: [] });
    const ids = await movementIds();
    expect(ids.filter((id) => id === `${HELD}-held-in`)).toHaveLength(1);
    expect(ids.filter((id) => id === `writeoff-held-${HELD}`)).toHaveLength(1);
    expect(await terminalSteps('cph')).toEqual(['cancelled']);
  }, 60_000);
});
