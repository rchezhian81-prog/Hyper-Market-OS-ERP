import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import { apiHarness, type ApiHarness } from '../support/api-harness';
import { DEFAULT_RETAIL_POSTING_MAP } from '../../packages/finance/src/index';
import { SqlIdempotencyStore } from '../../services/kernel/src/index';
import { pgPoolClient } from '../../packages/persistence/src/pg-client';
import { SqlEventStore } from '../../packages/persistence/src/event-store';
import { runMigrations } from '../../packages/persistence/src/migrations';

/**
 * **WF-08 · D05-FR-05 · M09-FR-04 — a stock count from plan to the books (round 8).** On the real API, in memory and — with
 * DATABASE_URL — on real PostgreSQL:
 *
 *   plan (what is counted, what is FROZEN while counting, the RECOUNT threshold — the planner's choices; a till kind can never
 *   be frozen) → open (a frozen kind on the plain movements route is refused by name) → BLIND count (the counter never sees an
 *   expected figure; every variance is held for the plan) → RECOUNT (a variance worth the threshold or more; a count whose
 *   expected moved after it because a sale dated before it arrived late; a product a frozen kind touched by another path —
 *   a visible exception) → CAUSE (from the fixed list, by a manager) → ONE approval by someone who counted none of what
 *   they approve (§28) → each final variance ONE compensating movement, superseded counts closed, the freeze lifted →
 *   the accountant's posting run books the losses and the gain against inventory through the mapping, once.
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
const backings: { name: string; harness: () => ApiHarness }[] = [{ name: 'the in-memory event store', harness: () => apiHarness() }];
if (DATABASE_URL !== undefined) backings.push({ name: 'real PostgreSQL', harness: () => { const sql = pgPoolClient(pool!); return apiHarness({ store: new SqlEventStore(sql), idempotency: new SqlIdempotencyStore(sql) }); } });

type Res = { status: number; body: unknown };
const codeOf = (r: Res): string | undefined => (r.body as { error?: { code?: string } }).error?.code;
interface Line { productId: string; state: string; finalCountId: string | null; recountBecause: string[]; varianceMinor: number; valueMinor: number; counts: { countId: string; expectedMinor: number }[] }

async function shop(harness: () => ApiHarness) {
  const h = harness();
  const T = randomUUID();
  await h.seedOwner(T, 'u-owner');
  for (const u of ['u-plan', 'u-c1', 'u-c2', 'u-appr']) await h.provisionRole(T, u, 'store_manager');
  await h.provisionRole(T, 'u-till', 'cashier');
  await h.provisionRole(T, 'u-acct', 'accountant');
  const call = (method: 'GET' | 'POST' | 'PUT', path: string, userId: string, body?: unknown, key?: string, query?: Record<string, string>): Promise<Res> =>
    h.request({ method, path, userId, tenantId: T, ...(body === undefined ? {} : { body }), ...(query === undefined ? {} : { query }), ...(method === 'GET' ? {} : { idempotencyKey: key ?? `${path}-${userId}-${JSON.stringify(body)}` }) });
  const ok = async (p: Promise<Res>, what: string): Promise<Res> => { const r = await p; expect(r.status, `${what}: ${JSON.stringify(r.body)}`).toBeLessThan(300); return r; };
  await ok(call('POST', '/v1/org/nodes/C1', 'u-owner', { kind: 'company', name: 'SRE Retail' }), 'company');
  await ok(call('POST', '/v1/org/nodes/S1', 'u-owner', { kind: 'branch', name: 'Store 1', parentId: 'C1', companyId: 'C1' }), 'store');
  // P1 100 @ ₹1.00 · P2 50 @ ₹10.00 · P3 20 @ ₹5.00 — head office's cost is the value of every variance.
  for (const [p, q, c] of [['P1', 100, 100], ['P2', 50, 1_000], ['P3', 20, 500]] as const) {
    await ok(call('POST', '/v1/inventory/movements', 'u-owner', { movementId: `seed-${p}`, productId: p, locationId: 'S1', kind: 'received', quantityMinor: q, uom: 'EA', occurredAt: '2026-08-01T00:00:00.000Z', enteredBy: 'u-owner', unitCostMinor: c }, `seed-${p}`), `seed ${p}`);
  }
  const onHand = async (p: string): Promise<number> =>
    ((await call('GET', '/v1/inventory/availability', 'u-owner', undefined, undefined, { productId: p })).body as { rows: { locationId: string; onHandMinor: number }[] }).rows.filter((r) => r.locationId === 'S1').reduce((s, r) => s + r.onHandMinor, 0);
  const view = async () => (await call('GET', '/v1/inventory/count-plans/cp1', 'u-plan')).body as { plan: { state: string }; lines: Line[]; freezeBreaches: { movementId: string; kind: string }[]; totals: Record<string, number> };
  const line = async (p: string): Promise<Line> => (await view()).lines.find((l) => l.productId === p) as Line;
  const count = (countId: string, productId: string, countedMinor: number, by: string, recountOf?: string) =>
    call('POST', `/v1/inventory/count-plans/cp1/counts/${countId}`, by, { productId, locationId: 'S1', uom: 'EA', countedMinor, ...(recountOf === undefined ? {} : { recountOf }) }, `cnt-${countId}`);
  return { h, T, call, ok, onHand, view, line, count };
}

const PLAN = { locationId: 'S1', productIds: ['P1', 'P2', 'P3'], frozenKinds: ['received', 'transferred_in', 'transferred_out', 'adjusted', 'wasted'], recountThresholdMinor: 2_000, note: 'aisle 4 quarterly count' };

describe.each(backings)('a stock count is planned, frozen, counted blind, recounted, caused, approved once and booked — on $name (WF-08 · D05-FR-05)', ({ harness }) => {
  it('runs the whole WF-08 path, refusing every short-cut by name, and the books follow the ledger once', async () => {
    const { call, ok, onHand, view, line, count } = await shop(harness);

    // ── PLAN: the planner's choices; a till kind is never frozen; a cashier cannot plan ─────────────────────────────
    expect(codeOf(await call('POST', '/v1/inventory/count-plans/cpX', 'u-plan', { ...PLAN, frozenKinds: ['received', 'sold'] }))).toBe('till_sales_are_never_frozen');
    expect(codeOf(await call('POST', '/v1/inventory/count-plans/cpX', 'u-plan', { ...PLAN, recountThresholdMinor: undefined }))).toBe('not_readable_as_a_count_plan');
    expect(codeOf(await call('POST', '/v1/inventory/count-plans/cpX', 'u-plan', { ...PLAN, frozenKinds: ['teleported'] }))).toBe('not_a_freezable_kind');
    expect((await call('POST', '/v1/inventory/count-plans/cpX', 'u-till', PLAN)).status).toBe(403);
    const made = await ok(call('POST', '/v1/inventory/count-plans/cp1', 'u-plan', PLAN, 'plan-cp1'), 'plan');
    expect(made.status).toBe(201);
    expect((made.body as { plan: Record<string, unknown> }).plan).toMatchObject({ state: 'planned', plannedBy: 'u-plan', frozenKinds: PLAN.frozenKinds, recountThresholdMinor: 2_000 });
    expect((await call('POST', '/v1/inventory/count-plans/cp1', 'u-plan', PLAN, 'plan-cp1')).status).toBe(201); // a replay is the same answer
    expect(codeOf(await call('POST', '/v1/inventory/count-plans/cp1', 'u-plan', PLAN, 'plan-cp1-again'))).toBe('count_plan_exists');
    // Not open yet: nothing can be counted under it.
    expect(codeOf(await count('early', 'P1', 100, 'u-c1'))).toBe('count_plan_not_open');

    // ── OPEN: the freeze starts — a frozen kind on the plain route is refused by name; the till's kinds still go through ──
    await ok(call('POST', '/v1/inventory/count-plans/cp1/open', 'u-plan', {}, 'open-cp1'), 'open');
    const frozen = await call('POST', '/v1/inventory/movements', 'u-owner', { movementId: 'rx-during', productId: 'P1', locationId: 'S1', kind: 'received', quantityMinor: 5, uom: 'EA', occurredAt: '2026-10-01T00:00:00.000Z', enteredBy: 'u-owner', unitCostMinor: 100 }, 'rx-during');
    expect(frozen.status).toBe(409);
    expect(codeOf(frozen)).toBe('frozen_by_a_stock_count');
    expect(await onHand('P1')).toBe(100);
    expect(codeOf(await call('POST', '/v1/inventory/count-plans/cp2', 'u-plan', { ...PLAN, productIds: ['P1'] }, 'plan-cp2').then(() => call('POST', '/v1/inventory/count-plans/cp2/open', 'u-plan', {}, 'open-cp2')))).toBe('another_count_is_open_here');

    // ── BLIND COUNT: the counter's answer and sheet carry no expected figure; nothing applies on the line ────────────
    const c1 = await ok(count('k-p1', 'P1', 97, 'u-c1'), 'count P1');
    expect(c1.body).toEqual({ planId: 'cp1', countId: 'k-p1', recorded: true, alreadyRecorded: false });
    expect(codeOf(await call('POST', '/v1/inventory/count-plans/cp1/counts/k-bad', 'u-c1', { productId: 'P1', locationId: 'S1', uom: 'EA', countedMinor: 1, expectedMinor: 100 }))).toBe('count_carries_caller_claims');
    expect(codeOf(await count('k-p9', 'P9', 3, 'u-c1'))).toBe('not_in_this_plan');
    await ok(count('k-p2', 'P2', 45, 'u-c1'), 'count P2');
    expect(codeOf(await count('k-p2-again', 'P2', 46, 'u-c2'))).toBe('already_counted_in_this_plan');
    await ok(count('k-p3', 'P3', 22, 'u-c2'), 'count P3');
    expect(await count('k-p3', 'P3', 22, 'u-c2')).toMatchObject({ status: 201 }); // the same key again: one record
    const sheet = (await call('GET', '/v1/inventory/count-plans/cp1/sheet', 'u-c1')).body as Record<string, unknown>;
    expect(JSON.stringify(sheet)).not.toMatch(/expected|variance|value/i);
    expect(sheet['lines']).toEqual([{ productId: 'P1', toDo: 'done', recountOf: null }, { productId: 'P2', toDo: 'recount', recountOf: 'k-p2' }, { productId: 'P3', toDo: 'done', recountOf: null }]);
    expect((await call('GET', '/v1/inventory/count-plans/cp1', 'u-c1')).status).toBe(200); // a manager-counter may read the plan…
    expect((await call('GET', '/v1/inventory/count-plans/cp1', 'u-till')).status).toBe(403); // …a cashier may not
    // Nothing moved on the ledger on any line: every variance waits for the plan.
    expect([await onHand('P1'), await onHand('P2'), await onHand('P3')]).toEqual([100, 50, 20]);
    let v = await view();
    expect(v.lines.map((l) => [l.productId, l.state, l.recountBecause, l.varianceMinor, l.valueMinor])).toEqual([
      ['P1', 'cause_required', [], -3, 300],
      ['P2', 'recount_required', ['over_recount_threshold'], -5, 5_000],
      ['P3', 'cause_required', [], 2, 1_000],
    ]);

    // ── RECOUNT over the threshold: only of the standing count; the recount stands (it is not recounted again) ───────
    expect(codeOf(await count('k-p2-r', 'P2', 46, 'u-c2', 'k-nope'))).toBe('not_the_standing_count');
    await ok(count('k-p2-r', 'P2', 46, 'u-c2', 'k-p2'), 'recount P2');
    expect(await line('P2')).toMatchObject({ state: 'cause_required', finalCountId: 'k-p2-r', varianceMinor: -4, valueMinor: 4_000, recountBecause: [] });

    // ── A SALE dated before P1's count reaches head office after it: P1's expected moved — it must be counted again ──
    await ok(call('POST', '/v1/inventory/movements', 'u-owner', { movementId: 'late-sale', productId: 'P1', locationId: 'S1', kind: 'sold', quantityMinor: 2, uom: 'EA', occurredAt: '2026-08-02T10:00:00.000Z', enteredBy: 'u-till' }, 'late-sale'), 'late sale');
    expect(await line('P1')).toMatchObject({ state: 'recount_required', recountBecause: ['expected_changed'] });
    // ── A frozen kind landing by ANOTHER path (a small write-off) is a visible exception, and P3 must be counted again ──
    await ok(call('POST', '/v1/inventory/write-off/wo-p3', 'u-owner', { productId: 'P3', locationId: 'S1', qty: 1, uom: 'EA', lossType: 'damage', reasonCode: 'crushed' }, 'wo-p3'), 'write-off during the freeze');
    v = await view();
    expect(v.freezeBreaches.map((b) => [b.movementId, b.kind])).toEqual([['writeoff-wo-p3', 'wasted']]);
    expect(v.lines.find((l) => l.productId === 'P3')).toMatchObject({ state: 'recount_required', recountBecause: ['moved_during_freeze'] });

    // ── APPROVAL is refused while anything waits ──────────────────────────────────────────────────────────────────
    const early = await call('POST', '/v1/inventory/count-plans/cp1/approve', 'u-appr', { reason: 'aisle 4 done' }, 'appr-early');
    expect(early.status).toBe(409);
    expect(codeOf(early)).toBe('count_not_ready_to_approve');

    // Recounts: P1 now 95 on the shelf of 98 expected (−3); P3 21 of 19 expected (+2).
    await ok(count('k-p1-r', 'P1', 95, 'u-c2', 'k-p1'), 'recount P1');
    await ok(count('k-p3-r', 'P3', 21, 'u-c1', 'k-p3'), 'recount P3');
    v = await view();
    expect(v.lines.map((l) => [l.productId, l.state, l.varianceMinor, l.valueMinor])).toEqual([['P1', 'cause_required', -3, 300], ['P2', 'cause_required', -4, 4_000], ['P3', 'cause_required', 2, 1_000]]);
    expect(v.lines.find((l) => l.productId === 'P1')?.counts.find((c) => c.countId === 'k-p1-r')?.expectedMinor).toBe(98);

    // ── CAUSE: from the fixed list, by a manager; a cashier cannot ──────────────────────────────────────────────────
    expect(codeOf(await call('POST', '/v1/inventory/count-plans/cp1/counts/k-p1-r/cause', 'u-plan', { causeCode: 'aliens', note: 'x' }))).toBe('not_readable_as_a_variance_cause');
    expect((await call('POST', '/v1/inventory/count-plans/cp1/counts/k-p1-r/cause', 'u-till', { causeCode: 'miscount', note: 'x' })).status).toBe(403);
    await ok(call('POST', '/v1/inventory/count-plans/cp1/counts/k-p1-r/cause', 'u-plan', { causeCode: 'theft_suspected', note: 'three packs gone from the end cap' }), 'cause P1');
    await ok(call('POST', '/v1/inventory/count-plans/cp1/counts/k-p2-r/cause', 'u-plan', { causeCode: 'damaged', note: 'four bottles broken behind the shelf, not written off' }), 'cause P2');
    // Approval still waits on P3's cause.
    expect(codeOf(await call('POST', '/v1/inventory/count-plans/cp1/approve', 'u-appr', { reason: 'done' }, 'appr-2'))).toBe('count_not_ready_to_approve');
    await ok(call('POST', '/v1/inventory/count-plans/cp1/counts/k-p3-r/cause', 'u-plan', { causeCode: 'found', note: 'two cartons in the wrong bay' }), 'cause P3');

    // ── APPROVAL: never by someone who counted a variance they approve; then ONE act posts every final variance once ──
    const self = await call('POST', '/v1/inventory/count-plans/cp1/approve', 'u-c2', { reason: 'done' }, 'appr-self');
    expect(self.status).toBe(422);
    expect(codeOf(self)).toBe('self_approval');
    const approved = await ok(call('POST', '/v1/inventory/count-plans/cp1/approve', 'u-appr', { reason: 'aisle 4 count accepted' }, 'appr-ok'), 'approve');
    expect(approved.body).toMatchObject({ plan: { state: 'approved', approvedBy: 'u-appr' }, lossMinor: 4_300, gainMinor: 1_000, alreadyApproved: false });
    expect((approved.body as { posted: { countId: string; movementId: string; causeCode: string }[] }).posted.map((p) => [p.countId, p.movementId, p.causeCode]))
      .toEqual([['k-p1-r', 'count:k-p1-r', 'theft_suspected'], ['k-p2-r', 'count:k-p2-r', 'damaged'], ['k-p3-r', 'count:k-p3-r', 'found']]);
    // The ledger now says what the shelf said: P1 98−3, P2 50−4, P3 19+2.
    expect([await onHand('P1'), await onHand('P2'), await onHand('P3')]).toEqual([95, 46, 21]);
    // A replay is the same answer; a second approval posts nothing again.
    expect((await call('POST', '/v1/inventory/count-plans/cp1/approve', 'u-appr', { reason: 'aisle 4 count accepted' }, 'appr-ok')).body).toMatchObject({ alreadyApproved: false });
    expect((await call('POST', '/v1/inventory/count-plans/cp1/approve', 'u-owner', { reason: 'again' }, 'appr-again')).body).toMatchObject({ alreadyApproved: true });
    expect([await onHand('P1'), await onHand('P2'), await onHand('P3')]).toEqual([95, 46, 21]);
    // Superseded first counts are closed as superseded — recorded, never posted; and nothing is left waiting.
    const p2 = (await call('GET', '/v1/inventory/counts', 'u-owner', undefined, undefined, { productId: 'P2', locationId: 'S1' })).body as { pending: number; counts: { countId: string; decision?: string; decisionReason?: string; movementId?: string | null }[] };
    expect(p2.pending).toBe(0);
    expect(p2.counts.find((c) => c.countId === 'k-p2')).toMatchObject({ decision: 'rejected', movementId: null });
    expect(p2.counts.find((c) => c.countId === 'k-p2')?.decisionReason).toMatch(/superseded by recount k-p2-r/);
    // The freeze lifted with the approval.
    await ok(call('POST', '/v1/inventory/movements', 'u-owner', { movementId: 'rx-after', productId: 'P1', locationId: 'S1', kind: 'received', quantityMinor: 5, uom: 'EA', occurredAt: '2026-10-02T00:00:00.000Z', enteredBy: 'u-owner', unitCostMinor: 100 }, 'rx-after'), 'receipt after the count');

    // ── THE BOOKS: the accountant's posting run turns each posted count into one journal through the mapping, once ──
    await ok(call('PUT', '/v1/finance/posting-map', 'u-acct', DEFAULT_RETAIL_POSTING_MAP, 'map'), 'mapping');
    const before = (await call('GET', '/v1/finance/stock-losses', 'u-acct')).body as Record<string, unknown>;
    expect(before).toMatchObject({ unposted: ['count:k-p1-r', 'count:k-p2-r', 'count:k-p3-r'], lostValueMinor: 4_300, gainedValueMinor: 1_000, postedValueMinor: 0 });
    const run = await call('POST', '/v1/finance/stock-losses/post', 'u-acct', {}, 'post-1');
    expect(run.status).toBe(201);
    const posted = (run.body as { posted: { entryId: string; lines: { accountCode: string; debitMinor: number; creditMinor: number }[]; narrative: string }[]; exceptions: unknown[] });
    expect(posted.exceptions).toEqual([]);
    expect(posted.posted.map((j) => [j.entryId, j.lines])).toEqual([
      ['stock-count:k-p1-r', [{ accountCode: 'inventory_loss', debitMinor: 300, creditMinor: 0 }, { accountCode: 'inventory', debitMinor: 0, creditMinor: 300 }]],
      ['stock-count:k-p2-r', [{ accountCode: 'inventory_loss', debitMinor: 4_000, creditMinor: 0 }, { accountCode: 'inventory', debitMinor: 0, creditMinor: 4_000 }]],
      ['stock-count:k-p3-r', [{ accountCode: 'inventory', debitMinor: 1_000, creditMinor: 0 }, { accountCode: 'inventory_gain', debitMinor: 0, creditMinor: 1_000 }]],
    ]);
    expect(posted.posted[1]?.narrative).toMatch(/plan cp1.*cause damaged.*approved by u-appr/);
    expect((await call('POST', '/v1/finance/stock-losses/post', 'u-acct', {}, 'post-2'))).toMatchObject({ status: 200, body: { posted: [] } });
    expect((await call('GET', '/v1/finance/stock-losses', 'u-acct')).body).toMatchObject({ unposted: [], postedValueMinor: 4_300, postedGainMinor: 1_000 });
    // The journals are the finance ledger's own (what the period close reads): balanced, in the count's month.
    const period = (await call('GET', '/v1/finance/stock-losses', 'u-acct')).body as { journals: { entryId: string; period: string; lines: { debitMinor: number; creditMinor: number }[] }[] };
    for (const j of period.journals) expect(j.lines.reduce((s, l) => s + l.debitMinor - l.creditMinor, 0)).toBe(0);
  });

  it('a count with no rule for it in the mapping stays visibly unposted; a cancelled plan posts nothing and lifts the freeze', async () => {
    const { call, ok, onHand, count } = await shop(harness);
    await ok(call('POST', '/v1/inventory/count-plans/cp1', 'u-plan', { ...PLAN, productIds: ['P1'] }, 'plan'), 'plan');
    await ok(call('POST', '/v1/inventory/count-plans/cp1/open', 'u-plan', {}, 'open'), 'open');
    await ok(count('k1', 'P1', 99, 'u-c1'), 'count');
    await ok(call('POST', '/v1/inventory/count-plans/cp1/cancel', 'u-plan', { reason: 'fire drill — count abandoned' }, 'cancel'), 'cancel');
    expect(codeOf(await call('POST', '/v1/inventory/count-plans/cp1/approve', 'u-appr', { reason: 'x' }, 'appr'))).toBe('count_plan_not_open');
    expect(await onHand('P1')).toBe(100);
    await ok(call('POST', '/v1/inventory/movements', 'u-owner', { movementId: 'rx', productId: 'P1', locationId: 'S1', kind: 'received', quantityMinor: 1, uom: 'EA', occurredAt: '2026-10-02T00:00:00.000Z', enteredBy: 'u-owner', unitCostMinor: 100 }, 'rx'), 'freeze lifted');

    // A second plan, approved, with the count rules taken out of the mapping: nothing posts and the variance is said.
    await ok(call('POST', '/v1/inventory/count-plans/cp3', 'u-plan', { ...PLAN, productIds: ['P1'] }, 'plan3'), 'plan 3');
    await ok(call('POST', '/v1/inventory/count-plans/cp3/open', 'u-plan', {}, 'open3'), 'open 3');
    await ok(call('POST', '/v1/inventory/count-plans/cp3/counts/k3', 'u-c1', { productId: 'P1', locationId: 'S1', uom: 'EA', countedMinor: 100 }, 'k3'), 'count 3');
    await ok(call('POST', '/v1/inventory/count-plans/cp3/counts/k3/cause', 'u-plan', { causeCode: 'miscount', note: 'last count missed a carton' }, 'cause3'), 'cause 3');
    await ok(call('POST', '/v1/inventory/count-plans/cp3/approve', 'u-appr', { reason: 'ok' }, 'appr3'), 'approve 3');
    expect(await onHand('P1')).toBe(100);
    await ok(call('PUT', '/v1/finance/posting-map', 'u-acct', { rules: DEFAULT_RETAIL_POSTING_MAP.rules.filter((r) => !r.kind.endsWith(':count')) }, 'map'), 'mapping without count rules');
    const run = await call('POST', '/v1/finance/stock-losses/post', 'u-acct', {}, 'post');
    expect(run.body).toMatchObject({ posted: [], exceptions: [{ sourceId: 'count:k3', kind: 'stock_loss:count', reason: 'unmapped_kind' }] });
    expect((await call('GET', '/v1/finance/stock-losses', 'u-acct')).body).toMatchObject({ unposted: ['count:k3'] });
  });
});
