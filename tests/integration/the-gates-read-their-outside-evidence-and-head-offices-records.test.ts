import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import { apiHarness, type ApiHarness } from '../support/api-harness';
import { SqlIdempotencyStore } from '../../services/kernel/src/index';
import { pgPoolClient } from '../../packages/persistence/src/pg-client';
import { SqlEventStore, type EventStore } from '../../packages/persistence/src/event-store';
import { runMigrations } from '../../packages/persistence/src/migrations';

/**
 * W3 · QG-04 · QG-05 · QG-06 · QG-07 · QG-10 (roadmap §22, §32, §35.1; QG-12 "silence is not approval") — the gate checks
 * that can block GO, on the real API: in memory and (with DATABASE_URL) on real PostgreSQL, with a cold restart.
 *
 *   • A FRESH shop: every one of the five gates has a blocker by name — missing outside evidence is NOT a pass:
 *       QG-04 no 72-hour simulation, no chaos test, no store computer's sync report;  QG-05 no p95 on certified hardware;
 *       QG-06 no independent penetration test (for R4 onward — R2 is not customer-facing, §35.1);
 *       QG-07 no control total for any of the five domains;  QG-10 no release has left a QG-10 note.
 *     GO on each is refused by name and nothing is recorded.
 *   • The outside evidence register: recorded in the signed-in owner's name; a p95 is worked out from the measured figure
 *     (340 ms is a FAIL, a typed "passed" is refused); a manager cannot record; an id is one record (409 on new content).
 *   • Recording a pass clears exactly that blocker; a store computer's dead letter blocks QG-04 until it reports none;
 *     an unsigned stock total blocks QG-07, a signed one clears the stock domain only.
 *   • After a restart everything reads back.
 */

const OWNER = 'u-owner'; const MGR = 'u-mgr'; const SIGNER = 'u-owner2'; const BOX = 'u-box-s1';
const codeOf = (r: { body: unknown }): string | undefined => (r.body as { error?: { code?: string } }).error?.code;

const DATABASE_URL = process.env['DATABASE_URL'];
let pool: Pool | undefined;
beforeAll(async () => {
  if (DATABASE_URL === undefined) return;
  pool = new Pool({ connectionString: DATABASE_URL, max: 6, options: '-c app.tenant_id=*' });
  const dir = 'db/migrations';
  await runMigrations(pgPoolClient(pool), readdirSync(dir).filter((f) => f.endsWith('.sql')).sort().map((name) => ({ name, sql: readFileSync(join(dir, name), 'utf8') })));
});
afterAll(async () => { await pool?.end(); });

interface Backing { readonly name: string; readonly make: () => { harness: () => ApiHarness } }
const backings: Backing[] = [{
  name: 'the in-memory event store',
  make: () => { let kept: EventStore | undefined; return { harness: () => { const h = apiHarness(kept === undefined ? {} : { store: kept }); kept = h.store; return h; } }; },
}];
if (DATABASE_URL !== undefined) {
  backings.push({ name: 'real PostgreSQL', make: () => ({ harness: () => { const sql = pgPoolClient(pool!); return apiHarness({ store: new SqlEventStore(sql), idempotency: new SqlIdempotencyStore(sql) }); } }) });
}

type Blocker = { kind: string; ref: string; reason: string };
type Reg = { gates: { gate: string; state: string; blockers: Blocker[] }[] };

describe.each(backings)('the gates read their outside evidence and head office\'s own records — on $name', ({ make }) => {
  it('missing evidence blocks QG-04/05/06/07/10 by name; a recorded pass clears exactly its blocker; a timing is worked out, never typed; a restart reads it back', async () => {
    const world = make();
    let h = world.harness();
    const T = randomUUID();
    await h.seedOwner(T, OWNER);
    await h.provisionRole(T, MGR, 'store_manager');
    await h.provisionRole(T, SIGNER, 'owner');
    await h.provisionRole(T, BOX, 'store_computer', ['S1']);
    for (const [id, body] of [['C-1', { kind: 'company', name: 'Synthetic company' }], ['S1', { kind: 'branch', name: 'Store S1', parentId: 'C-1', companyId: 'C-1' }]] as const) {
      const r = await h.request({ method: 'POST', path: `/v1/org/nodes/${id}`, userId: OWNER, tenantId: T, idempotencyKey: `org-${id}`, body });
      expect(r.status, JSON.stringify(r.body)).toBeLessThan(300);
    }
    const call = (method: 'GET' | 'POST', path: string, user: string, body?: unknown, query?: Record<string, string>, extra: { branchId?: string } = {}) =>
      h.request({ method, path, userId: user, tenantId: T, ...extra, ...(body === undefined ? {} : { body }), ...(method === 'GET' ? {} : { idempotencyKey: `${path}-${randomUUID()}` }), ...(query === undefined ? {} : { query }) });
    const ok = async (p: ReturnType<typeof call>, what: string) => { const r = await p; expect(r.status, `${what}: ${JSON.stringify(r.body)}`).toBeLessThan(300); return r; };
    const blockersOf = async (gate: string, release = 'R5'): Promise<Blocker[]> =>
      ((await ok(call('GET', '/v1/compliance/gate-register', MGR, undefined, { release }), 'register')).body as Reg).gates.find((g) => g.gate === gate)!.blockers;
    const refs = async (gate: string, release = 'R5') => (await blockersOf(gate, release)).map((b) => b.ref).sort();
    const go = (gate: string) => call('POST', `/v1/compliance/gate-decisions/${gate}/R5`, OWNER, { decision: 'GO', evidence: [{ label: 'the test report', ref: 'docs/evidence/x.md' }], rationale: 'it passed' });
    const evidence = (id: string, body: Record<string, unknown>, user = OWNER) => call('POST', `/v1/compliance/gate-evidence/${id}`, user, body);
    const base = { where: 'certified store PC and lanes 1-4 (synthetic rehearsal)', reportRef: 'docs/evidence/rehearsal-report.md', testedOn: '2026-11-01', statement: 'watched it myself' };

    // ── 0 · A fresh shop: each gate has its blocker by name — nothing on record is never a pass.
    expect(await refs('QG-04')).toEqual(['evidence:offline_72h_simulation', 'evidence:power_process_chaos', 'sync:no-store-report']);
    expect(await refs('QG-05')).toEqual(['evidence:scan_to_line_p95', 'evidence:total_tender_p95']);
    expect(await refs('QG-06')).toEqual(['evidence:independent_pentest']);
    expect(await refs('QG-06', 'R2'), 'the pen test counts from R4, the first customer-facing release (§35.1)').toEqual([]);
    expect(await refs('QG-07')).toEqual(['control-totals:financial', 'control-totals:loyalty', 'control-totals:migration', 'control-totals:stock', 'control-totals:tax']);
    expect(await refs('QG-10')).toEqual(['qg10:no-release-note']);
    expect((await blockersOf('QG-05'))[0]!.reason).toMatch(/nothing on file — not passed until it is done and recorded/);
    for (const gate of ['QG-04', 'QG-05', 'QG-06', 'QG-07', 'QG-10']) {
      const r = await go(gate);
      expect(r.status, gate).toBe(422);
      expect(codeOf(r), gate).toBe('go_refused_while_blocked');
    }
    expect(((await ok(call('GET', '/v1/compliance/gate-decisions/QG-05/R5', OWNER), 'history')).body as { count: number }).count).toBe(0);
    // can-pass agrees (it has no release, so it shows every blocker).
    expect((await ok(call('GET', '/v1/compliance/gates/QG-06/can-pass', OWNER), 'can-pass')).body).toMatchObject({ canPass: false });

    // ── 1 · The outside evidence register: the owner records; a timing's result is worked out; refusals by name.
    expect((await evidence('st-1', { kind: 'scan_to_line_p95', measuredMs: 280, ...base }, MGR)).status).toBe(403);
    expect(codeOf(await evidence('st-1', { kind: 'scan_to_line_p95', result: 'passed', measuredMs: 280, ...base }))).toBe('gate_evidence_not_readable');
    expect(codeOf(await evidence('st-1', { kind: 'offline_72h_simulation', ...base }))).toBe('gate_evidence_not_readable'); // no result
    expect(codeOf(await evidence('st-1', { kind: 'nonsense', result: 'passed', ...base }))).toBe('gate_evidence_not_readable');
    const slow = await ok(evidence('st-1', { kind: 'scan_to_line_p95', measuredMs: 340, ...base }), 'slow');
    expect(slow.status).toBe(201);
    expect(slow.body).toMatchObject({ evidence: { result: 'failed', measuredMs: 340, recordedBy: OWNER, gate: 'QG-05' } });
    expect((await blockersOf('QG-05')).find((b) => b.ref === 'evidence:scan_to_line_p95:st-1')!.reason).toMatch(/FAILED — p95 340 ms against the 300 ms target/);
    // An id is one record: the same again is a re-send, new content under it is refused.
    expect((await ok(evidence('st-1', { kind: 'scan_to_line_p95', measuredMs: 340, ...base }), 'resend')).body).toMatchObject({ alreadyRecorded: true });
    expect(codeOf(await evidence('st-1', { kind: 'scan_to_line_p95', measuredMs: 250, ...base }))).toBe('gate_evidence_id_used');
    // A newer, faster measurement passes; the total/tender one too — QG-05 is clear and GO is allowed.
    await ok(evidence('st-2', { kind: 'scan_to_line_p95', measuredMs: 280, ...base, testedOn: '2026-11-02' }), 'fast');
    await ok(evidence('tt-1', { kind: 'total_tender_p95', measuredMs: 450, ...base }), 'tender');
    expect(await refs('QG-05')).toEqual([]);
    expect((await go('QG-05')).status).toBe(201);

    // ── 2 · QG-06: an independent pen test on file clears it for R5.
    await ok(evidence('pt-1', { kind: 'independent_pentest', result: 'passed', ...base, where: 'Synthetic Security Ltd (independent)', reportRef: 'pentest/2026-11.pdf' }), 'pentest');
    expect(await refs('QG-06')).toEqual([]);

    // ── 3 · QG-04: both outside tests pass, then the store computer's own report decides.
    await ok(evidence('of-1', { kind: 'offline_72h_simulation', result: 'passed', ...base }), 'offline');
    await ok(evidence('ch-1', { kind: 'power_process_chaos', result: 'passed', ...base }), 'chaos');
    expect(await refs('QG-04')).toEqual(['sync:no-store-report']);
    const report = (deadLettered: number, at: string) => call('POST', '/v1/stores/S1/sync-watermarks', BOX, { observedAt: at, domains: [{ domain: 'sales', completeThrough: at, unsent: 0, deadLettered }] }, undefined, { branchId: 'S1' });
    await ok(report(2, new Date(Date.now() - 60_000).toISOString()), 'dead-lettered report');
    expect(await refs('QG-04')).toEqual(['sync:S1:sales:dead-letter']);
    expect((await blockersOf('QG-04'))[0]!.reason).toMatch(/store S1 holds 2 sales item\(s\) in its dead letter/);
    await ok(report(0, new Date().toISOString()), 'clean report');
    expect(await refs('QG-04')).toEqual([]);

    // ── 4 · QG-07: an unsigned stock total names itself; signed, the stock domain clears and the other four remain.
    await ok(call('POST', '/v1/migration/extraction-runs/run-gates', OWNER, { operatorId: OWNER }), 'extraction');
    await ok(call('POST', '/v1/migration/loads/load-gates', OWNER, { sliceDigest: 'digest-gates', counts: { 'products.csv': { rows: 9, staged: 9, quarantined: 0 } }, exceptions: [] }), 'load');
    await ok(call('POST', '/v1/migration/control-totals', OWNER, { totals: [{ totalId: 'CT-STOCK', kind: 'stock', name: 'Stock units', unit: 'quantity', legacyValue: 9, loadedValue: 9, legacyDerivation: 'SUM(qty) FROM synthetic legacy stock', loadedDerivation: 'count of opening movements' }] }), 'total');
    expect(await refs('QG-07')).toContain('control-totals:stock:unsigned');
    expect((await blockersOf('QG-07')).find((b) => b.ref === 'control-totals:stock:unsigned')!.reason).toMatch(/1 of 1 stock control total\(s\) not signed: Stock units \(CT-STOCK\)/);
    await ok(call('POST', '/v1/migration/control-totals/CT-STOCK/signature', SIGNER, { statement: 'counted a sample myself' }), 'sign');
    expect(await refs('QG-07')).toEqual(['control-totals:financial', 'control-totals:loyalty', 'control-totals:migration', 'control-totals:tax']);

    // ── 5 · The evidence reads back, per kind; and after a cold restart everything stands as it was.
    const listed = (await ok(call('GET', '/v1/compliance/gate-evidence', MGR), 'list')).body as { records: { evidenceId: string }[]; kinds: { kind: string; standing: string }[] };
    expect(listed.records).toHaveLength(6);
    expect(Object.fromEntries(listed.kinds.map((k) => [k.kind, k.standing]))).toEqual({
      offline_72h_simulation: 'passed', power_process_chaos: 'passed', scan_to_line_p95: 'passed', total_tender_p95: 'passed', independent_pentest: 'passed',
    });
    h = world.harness();
    expect(await refs('QG-04')).toEqual([]);
    expect(await refs('QG-05')).toEqual([]);
    expect(await refs('QG-06')).toEqual([]);
    expect(await refs('QG-10')).toEqual(['qg10:no-release-note']);
  }, 120_000);
});
