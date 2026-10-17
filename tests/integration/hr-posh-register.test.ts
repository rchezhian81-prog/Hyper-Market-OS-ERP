import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import { apiHarness, type ApiHarness } from '../support/api-harness';
import { SqlIdempotencyStore } from '../../services/kernel/src/index';
import { pgPoolClient } from '../../packages/persistence/src/pg-client';
import { SqlEventStore } from '../../packages/persistence/src/event-store';
import { runMigrations } from '../../packages/persistence/src/migrations';
import { auditTrailAdapter } from '../../services/api/src/adapters';
import { PLATFORM_ADMIN_ROLE_ID } from '../../services/api/src/roles';

/**
 * **R2 addendum C20 — the Internal Committee complaints register and annual report, on the live API.**
 *   • CONFIDENTIAL: only the `internal_committee` role reads or writes a complaint — the owner, a store manager, a cashier,
 *     an accountant and the platform administrator are each refused (403) on every complaint route;
 *   • every read (the list, one complaint, a missing one, the access log, the report) and every write is sealed into the
 *     tamper-evident audit trail, naming only the act and the record id — never a name or the summary;
 *   • append-only: a retry lands on the same record, a step after disposal is refused, nothing can be edited;
 *   • the complaint and step ids are made by the register (opaque) — a body naming one is refused (verifier NEW-4);
 *   • the POST replies carry ids and status only — never the content (NEW-5);
 *   • the annual report is counts only; the owner reads it, sees the 31 January exception (due, then overdue) and records
 *     it filed, after which the exception is gone.
 * In-memory and, with DATABASE_URL, real PostgreSQL. Synthetic data only.
 */

type Body = Record<string, unknown>;
const codeOf = (r: { body: unknown }): string | undefined => (r.body as { error?: { code?: string } }).error?.code;
const SECRET_SUMMARY = 'synthetic confidential summary';

async function cast(h: ApiHarness, t: string) {
  const call = (method: 'GET' | 'POST', path: string, userId: string, body?: unknown, key?: string, query?: Readonly<Record<string, string>>) =>
    h.request({ method, path, userId, tenantId: t, ...(body === undefined ? {} : { body }), ...(key === undefined ? {} : { idempotencyKey: key }), ...(query === undefined ? {} : { query }) });
  await h.seedOwner(t, 'u-owner');
  await h.provisionRole(t, 'u-ic', 'internal_committee');
  await h.provisionRole(t, 'u-ic2', 'internal_committee');
  await h.provisionRole(t, 'u-mgr', 'store_manager');
  await h.provisionRole(t, 'u-cash', 'cashier');
  await h.provisionRole(t, 'u-acct', 'accountant');
  await h.provisionRole(t, 'u-it', PLATFORM_ADMIN_ROLE_ID);
  /** Receive a complaint labelled `label` (the label is the test's own; the register makes the id). */
  const receive = (label: string, receivedOn: string, userId = 'u-ic', key = `rc-${label}`) =>
    call('POST', '/v1/hr/posh/complaints', userId, { receivedOn, complainantRef: `EMP-C-${label}`, respondentRef: `EMP-R-${label}`, summary: SECRET_SUMMARY }, key);
  const idOf = (r: { body: unknown }): string => (r.body as { complaintId: string }).complaintId;
  const stepOf = (id: string, stepKey: string, body: Body, userId = 'u-ic') => call('POST', `/v1/hr/posh/complaints/${id}/steps`, userId, body, `st-${id}-${stepKey}`);
  return { call, receive, idOf, stepOf };
}

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

describe.each(backings)('C20 — the confidential Internal Committee register — on $name', ({ harness }) => {
  it('refuses (403) every complaint route to everyone outside the Internal Committee', async () => {
    const h = harness();
    const t = randomUUID();
    const s = await cast(h, t);
    const r1 = await s.receive('P1', '2026-03-01');
    expect(r1.status).toBe(201);
    const P1 = s.idOf(r1);
    for (const outsider of ['u-owner', 'u-mgr', 'u-cash', 'u-acct', 'u-it']) {
      expect((await s.receive(`X-${outsider}`, '2026-03-01', outsider, `rc-x-${outsider}`)).status, `${outsider} receive`).toBe(403);
      expect((await s.stepOf(P1, `s-${outsider}`, { kind: 'inquiry_started', on: '2026-03-02' }, outsider)).status, `${outsider} step`).toBe(403);
      expect((await s.call('GET', '/v1/hr/posh/complaints', outsider)).status, `${outsider} list`).toBe(403);
      expect((await s.call('GET', `/v1/hr/posh/complaints/${P1}`, outsider)).status, `${outsider} read`).toBe(403);
      expect((await s.call('GET', '/v1/hr/posh/access-log', outsider)).status, `${outsider} access log`).toBe(403);
      expect((await s.call('POST', '/v1/hr/posh/annual-reports/2026', outsider, {}, `gen-${outsider}`)).status, `${outsider} generate`).toBe(403);
    }
    // Only the owner may record a filing; the committee may not.
    expect((await s.call('POST', '/v1/hr/posh/annual-reports/2026/filing', 'u-ic', { filedOn: '2027-01-20', reference: 'ack' }, 'file-ic')).status).toBe(403);
    // A manager, cashier or IT cannot even see the report status.
    for (const outsider of ['u-mgr', 'u-cash', 'u-it']) expect((await s.call('GET', '/v1/hr/posh/annual-report-status', outsider)).status).toBe(403);
    // No refused attempt left a record behind.
    const list = (await s.call('GET', '/v1/hr/posh/complaints', 'u-ic')).body as { count: number };
    expect(list.count).toBe(1);
  });

  it('seals every read and write into the audit trail — ids only — and keeps the register append-only', async () => {
    const h = harness();
    const t = randomUUID();
    const s = await cast(h, t);
    const first = await s.receive('P1', '2026-03-01');
    expect(first.status).toBe(201);
    // The register makes the id — opaque, no name in it — and the reply carries the id and status only (NEW-4, NEW-5).
    expect(first.body).toEqual({ complaintId: expect.stringMatching(/^PC-[0-9A-F]{20}$/), status: 'received' });
    const P1 = s.idOf(first);
    // A retry of the same request lands on the same complaint; nothing is received twice.
    const retry = await s.receive('P1', '2026-03-01');
    expect(s.idOf(retry)).toBe(P1);
    // A caller cannot choose the id.
    expect(codeOf(await s.call('POST', '/v1/hr/posh/complaints', 'u-ic', { complaintId: 'Priya-v-Ravi', receivedOn: '2026-03-01', complainantRef: 'a', respondentRef: 'b', summary: 'c' }, 'rc-named'))).toBe('complaint_id_is_made_by_the_register');

    const started = await s.stepOf(P1, 's1', { kind: 'inquiry_started', on: '2026-03-05' });
    expect(started.status).toBe(201);
    expect(started.body).toEqual({ complaintId: P1, stepId: expect.stringMatching(/^PS-[0-9A-F]{20}$/), status: 'under_inquiry' });
    expect(codeOf(await s.stepOf(P1, 's0', { kind: 'disposed', on: '2026-02-01', outcome: 'upheld' }))).toBe('before_receipt');
    expect(codeOf(await s.stepOf(P1, 's2', { kind: 'disposed', on: '2026-05-01' }))).toBe('outcome_needed');
    expect((await s.stepOf(P1, 's3', { kind: 'disposed', on: '2026-05-01', outcome: 'upheld', note: 'synthetic committee note' })).status).toBe(201);
    expect(codeOf(await s.stepOf(P1, 's4', { kind: 'inquiry_started', on: '2026-05-02' }))).toBe('already_disposed');

    const one = await s.call('GET', `/v1/hr/posh/complaints/${P1}`, 'u-ic2');
    expect(one.status).toBe(200);
    expect((one.body as { complaint: Body }).complaint).toMatchObject({ status: 'disposed', outcome: 'upheld', summary: SECRET_SUMMARY, receivedOn: '2026-03-01' });
    expect((await s.call('GET', '/v1/hr/posh/complaints/NOPE', 'u-ic2')).status).toBe(404);
    const all = await s.call('GET', '/v1/hr/posh/complaints', 'u-ic');
    expect(all.body).toMatchObject({ count: 1, open: 0 });

    const trail = (await auditTrailAdapter({ store: h.store }).records(t)).filter((r) => r.objectType === 'posh_register');
    const acts = trail.map((r) => `${r.actorId}:${r.action}:${r.objectId}`);
    expect(acts).toEqual(expect.arrayContaining([
      `u-ic:posh.complaint.receive:${P1}`, `u-ic:posh.complaint.inquiry_started:${P1}`, `u-ic:posh.complaint.disposed:${P1}`,
      `u-ic2:posh.complaint.read:${P1}`, 'u-ic2:posh.complaint.read:NOPE', 'u-ic:posh.register.read:register',
    ]));
    expect(trail.filter((r) => r.action === 'posh.complaint.receive')).toHaveLength(1);
    // The audit trail never carries the confidential content.
    const text = JSON.stringify(trail);
    for (const secret of [SECRET_SUMMARY, 'EMP-C-P1', 'EMP-R-P1', 'synthetic committee note']) expect(text).not.toContain(secret);

    // The access log is itself a read of the register, and is sealed too.
    const log = await s.call('GET', '/v1/hr/posh/access-log', 'u-ic');
    expect(log.status).toBe(200);
    expect((log.body as { entries: { action: string }[] }).entries.map((e) => e.action)).toContain('posh.access_log.read');

    // Survives a restart.
    const restarted = apiHarness({ store: h.store });
    expect(((await restarted.request({ method: 'GET', path: '/v1/hr/posh/complaints', userId: 'u-ic', tenantId: t })).body as { count: number }).count).toBe(1);
  });

  it('generates the counts-only annual report, surfaces the 31 January exception to the owner, and clears it once filed', async () => {
    const h = harness();
    const t = randomUUID();
    const s = await cast(h, t);
    const A = s.idOf(await s.receive('A', '2026-02-01'));
    await s.receive('B', '2026-11-20');
    await s.stepOf(A, 'd', { kind: 'disposed', on: '2026-04-01', outcome: 'conciliation' });

    // Before generation: due, not generated.
    const due = await s.call('GET', '/v1/hr/posh/annual-report-status', 'u-owner', undefined, undefined, { asOf: '2027-01-10' });
    expect(due.status).toBe(200);
    expect((due.body as { exceptions: Body[] }).exceptions).toEqual([expect.objectContaining({ year: 2026, state: 'due', generated: false, dueBy: '2027-01-31' })]);
    expect(codeOf(await s.call('POST', '/v1/hr/posh/annual-reports/2026/filing', 'u-owner', { filedOn: '2027-01-20', reference: 'ack' }, 'f0'))).toBe('no_report_to_file');

    const gen = await s.call('POST', '/v1/hr/posh/annual-reports/2026', 'u-ic', {}, 'gen');
    expect(gen.status).toBe(201);
    const report = (await s.call('GET', '/v1/hr/posh/annual-reports/2026', 'u-owner')).body as { report: Body };
    expect(report.report).toMatchObject({ year: 2026, receivedInYear: 2, disposedInYear: 1, pendingAtEnd: 1, pendingAtStart: 0, dueBy: '2027-01-31' });
    for (const secret of [SECRET_SUMMARY, 'EMP-C-A', 'EMP-R-B']) expect(JSON.stringify(report)).not.toContain(secret);

    const overdue = (await s.call('GET', '/v1/hr/posh/annual-report-status', 'u-owner', undefined, undefined, { asOf: '2027-02-05' })).body as { exceptions: Body[] };
    expect(overdue.exceptions).toEqual([expect.objectContaining({ year: 2026, state: 'overdue', generated: true, daysToDue: -5 })]);

    const filed = await s.call('POST', '/v1/hr/posh/annual-reports/2026/filing', 'u-owner', { filedOn: '2027-01-28', reference: 'DO-ACK-SYNTH-1' }, 'f1');
    expect(filed.status).toBe(201);
    expect(filed.body).toMatchObject({ onTime: true });
    expect(codeOf(await s.call('POST', '/v1/hr/posh/annual-reports/2026/filing', 'u-owner', { filedOn: '2027-01-29', reference: 'again' }, 'f2'))).toBe('report_already_filed');
    expect(codeOf(await s.call('POST', '/v1/hr/posh/annual-reports/2026', 'u-ic', {}, 'gen2'))).toBe('report_already_filed');
    const after = (await s.call('GET', '/v1/hr/posh/annual-report-status', 'u-owner', undefined, undefined, { asOf: '2027-02-05' })).body as { exceptions: Body[]; filed: Body[] };
    expect(after.exceptions).toEqual([]);
    expect(after.filed).toEqual([{ year: 2026, filedOn: '2027-01-28', onTime: true }]);

    const trail = (await auditTrailAdapter({ store: h.store }).records(t)).filter((r) => r.objectType === 'posh_register').map((r) => `${r.actorId}:${r.action}:${r.objectId}`);
    expect(trail).toEqual(expect.arrayContaining(['u-ic:posh.report.generate:2026', 'u-owner:posh.report.read:2026', 'u-owner:posh.report.file:2026']));
  });
});
