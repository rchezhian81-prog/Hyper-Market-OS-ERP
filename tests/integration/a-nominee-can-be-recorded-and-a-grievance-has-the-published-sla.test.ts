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
import { shopDateIn } from '../../packages/calendar/src/shop-clock';

/**
 * **R3 · C5 — the customer's nominee and the published answer-by time (OB-146 "B": 15 days), on the real API, in memory
 * AND on real PostgreSQL, with a cold restart.** Signed sentence: "a customer can record, change and withdraw a nominee
 * (append-only). On a verified death or incapacity, the nominee can exercise the rights. A grievance is a request kind with
 * the published SLA. The SLA is shown to the customer in the notice and on /v1/me/privacy. An overdue grievance surfaces
 * like other overdue requests."
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
const CUSTOMER = 'cust-synthetic-1';
const plusDays = (date: string, n: number): string => new Date(Date.parse(`${date}T00:00:00.000Z`) + n * 86_400_000).toISOString().slice(0, 10);

describe.each(backings)('a nominee can be recorded and a grievance has the published SLA — on $name (C5)', ({ harness, restart }) => {
  it('record → change → withdraw → record (append-only); nominee acts only after a verified death; grievance due in 15 days and overdue after', async () => {
    let h = harness();
    const T = randomUUID();
    await h.seedOwner(T, 'u-owner');
    await h.provisionRole(T, 'u-dpo', 'store_manager'); // holds privacy.request.manage
    await h.provisionRole(T, 'u-till', 'cashier');
    await h.provisionRole(T, CUSTOMER, 'customer');
    await h.provisionRole(T, 'cust-synthetic-2', 'customer');
    const call = (method: 'GET' | 'POST', path: string, userId: string, body?: unknown, query?: Record<string, string>): Promise<Res> =>
      h.request({ method, path, userId, tenantId: T, ...(method === 'POST' ? { idempotencyKey: `k-${randomUUID()}` } : {}), ...(body === undefined ? {} : { body }), ...(query === undefined ? {} : { query }) });
    const me = async (who = CUSTOMER) => (await call('GET', '/v1/me/privacy', who)).body as { responseSlaDays: number; slaStatement: string; nominee: { nomineeRef: string; relationship: string } | null; requests: { requestId: string; kind: string; dueBy: string; raisedAt: string }[] };

    // ── THE PUBLISHED TIME, shown on /v1/me/privacy ──
    const mine = await me();
    expect(mine).toMatchObject({ responseSlaDays: 15, slaStatement: 'We answer every privacy request and every complaint about your data within 15 days of receiving it.', nominee: null });

    // ── NOMINEE: record, change, withdraw, record again — each a new record ──
    expect(codeOf(await call('POST', '/v1/me/privacy/nominee', CUSTOMER, { nomineeRef: 'x', relationship: 'spouse' }))).toBe('not_readable_as_a_nominee');
    expect(codeOf(await call('POST', '/v1/me/privacy/nominee', CUSTOMER, { nomineeRef: CUSTOMER, relationship: 'self' }))).toBe('nominee_is_yourself');
    expect(codeOf(await call('POST', '/v1/me/privacy/nominee/withdrawal', CUSTOMER, {}))).toBe('no_nominee_to_withdraw');
    expect((await call('POST', '/v1/me/privacy/nominee', 'u-till', { nomineeRef: 'NF-0001', relationship: 'spouse' })).status).toBe(403);
    expect((await call('POST', '/v1/me/privacy/nominee', CUSTOMER, { nomineeRef: 'cust-synthetic-2', relationship: 'spouse' })).body).toMatchObject({ action: 'recorded', nominee: { nomineeRef: 'cust-synthetic-2', relationship: 'spouse' } });
    expect((await call('POST', '/v1/me/privacy/nominee', CUSTOMER, { nomineeRef: 'NF-0042', relationship: 'son' })).body).toMatchObject({ action: 'changed', nominee: { nomineeRef: 'NF-0042' } });
    expect((await call('POST', '/v1/me/privacy/nominee/withdrawal', CUSTOMER, {})).body).toMatchObject({ action: 'withdrawn', nominee: null });
    expect((await me()).nominee).toBeNull();
    expect((await call('POST', '/v1/me/privacy/nominee', CUSTOMER, { nomineeRef: 'NF-0042', relationship: 'son' })).body).toMatchObject({ action: 'recorded' });
    // Another customer sees only their own (none).
    expect((await me('cust-synthetic-2')).nominee).toBeNull();

    // ── THE NOMINEE ACTS ONLY AFTER A VERIFIED DEATH OR INCAPACITY, and only the nominee named ──
    const asNominee = (requestId: string, nomineeRef: string) => call('POST', `/v1/privacy/data-requests/${requestId}`, 'u-dpo', { customerRef: CUSTOMER, kind: 'access', onBehalfOf: { nomineeRef } });
    expect(codeOf(await asNominee('NR-1', 'NF-0042'))).toBe('nominee_not_verified');
    expect(codeOf(await asNominee('NR-1', 'cust-synthetic-2'))).toBe('nominee_not_the_nominee');
    expect((await call('POST', `/v1/privacy/nominees/${CUSTOMER}/activation`, 'u-till', { activationId: 'ACT-1', nomineeRef: 'NF-0042', basis: 'death', evidenceRef: 'DC-SYN-1' })).status).toBe(403);
    expect(codeOf(await call('POST', `/v1/privacy/nominees/${CUSTOMER}/activation`, 'u-dpo', { activationId: 'ACT-1', nomineeRef: 'cust-synthetic-2', basis: 'death', evidenceRef: 'DC-SYN-1' }))).toBe('nominee_not_the_nominee');
    expect(codeOf(await call('POST', `/v1/privacy/nominees/${CUSTOMER}/activation`, 'u-dpo', { activationId: 'ACT-1', nomineeRef: 'NF-0042', basis: 'gone', evidenceRef: 'DC-SYN-1' }))).toBe('not_readable_as_a_nominee_activation');
    const act = await call('POST', `/v1/privacy/nominees/${CUSTOMER}/activation`, 'u-dpo', { activationId: 'ACT-1', nomineeRef: 'NF-0042', basis: 'death', evidenceRef: 'death certificate DC-SYN-1 seen' });
    expect(act.status, JSON.stringify(act.body)).toBe(201);
    expect(act.body).toMatchObject({ activation: { verifiedBy: 'u-dpo', basis: 'death', nomineeRef: 'NF-0042' } });

    // ── A COLD RESTART ──
    h = restart(h);
    const nr = await asNominee('NR-1', 'NF-0042');
    expect(nr.status, JSON.stringify(nr.body)).toBe(201);
    expect(nr.body).toMatchObject({ kind: 'access', actingAs: { role: 'nominee', nomineeRef: 'NF-0042', activationRef: 'ACT-1' } });
    const record = (await call('GET', `/v1/privacy/nominees/${CUSTOMER}`, 'u-dpo')).body as { current: { nomineeRef: string }; history: { action: string }[]; activations: unknown[] };
    expect(record.current.nomineeRef).toBe('NF-0042');
    expect(record.history.map((r) => r.action)).toEqual(['recorded', 'changed', 'withdrawn', 'recorded']);
    expect(record.activations).toHaveLength(1);

    // ── A GRIEVANCE is a request kind with the published time ──
    const g = await call('POST', '/v1/me/privacy/requests/GRV-0001', 'cust-synthetic-2', { kind: 'grievance' });
    expect(g.status, JSON.stringify(g.body)).toBe(201);
    const grievance = g.body as { kind: string; raisedAt: string; dueBy: string; tellTheCustomer: string };
    expect(grievance.kind).toBe('grievance');
    expect(grievance.dueBy).toBe(plusDays(shopDateIn(grievance.raisedAt), 15)); // the SLA runs from the shop's date of the request
    expect(grievance.tellTheCustomer).toMatch(/We have your complaint \(reference GRV-0001\)\. We must answer it by/);
    // The officer's own grievance record takes the same time; a longer one breaks the published promise and is refused.
    expect((await call('POST', '/v1/privacy/data-requests/GRV-0002', 'u-dpo', { customerRef: CUSTOMER, kind: 'grievance' })).status).toBe(201);
    expect(codeOf(await call('POST', '/v1/privacy/data-requests/GRV-0003', 'u-dpo', { customerRef: CUSTOMER, kind: 'grievance', slaDays: 30 }))).toBe('sla_longer_than_published');
    // An access request takes the published 15 days too.
    expect((await call('POST', '/v1/me/privacy/requests/ACC-0001', CUSTOMER, { kind: 'access' })).status).toBe(201);
    expect((await me('cust-synthetic-2')).requests.map((r) => [r.requestId, r.kind])).toEqual([['GRV-0001', 'grievance']]);
    // Every request is due 15 days after the day it was raised (each read against its own raising day — no midnight trap).
    const all = ((await call('GET', '/v1/privacy/data-requests', 'u-dpo', undefined, { state: 'all' })).body as { queue: { requestId: string; kind: string; raisedAt: string; dueBy: string }[] }).queue;
    expect(all.map((r) => r.requestId).sort()).toEqual(['ACC-0001', 'GRV-0001', 'GRV-0002', 'NR-1']);
    for (const r of all) expect(r.dueBy, r.requestId).toBe(plusDays(shopDateIn(r.raisedAt), 15));

    // ── OVERDUE: on the due date nothing is late; the day after, the grievance surfaces like every other request ──
    const overdue = async (asOf: string) => ((await call('GET', '/v1/privacy/data-requests/overdue', 'u-owner', undefined, { asOf })).body as { overdue: { requestId: string; kind: string; daysOverdue: number }[] }).overdue;
    expect((await overdue(grievance.dueBy)).map((o) => o.requestId)).not.toContain('GRV-0001');
    expect((await overdue(plusDays(grievance.dueBy, 1))).find((o) => o.requestId === 'GRV-0001')).toMatchObject({ kind: 'grievance', daysOverdue: 1 });
    for (const r of all) expect((await overdue(plusDays(r.dueBy, 1))).map((o) => o.requestId), r.requestId).toContain(r.requestId);

    // ── THE NOTICE states the published time — a notice without it, or with another, is not complete ──
    const notice = { items: [{ dataCategory: 'contact', purpose: 'order updates' }], withdrawMethod: 'one tap in the app', grievanceContact: 'dpo@sre.example', boardComplaintLink: 'https://dpb.gov.in/complaint' };
    expect((await call('POST', '/v1/privacy/consent-notice/check', 'u-owner', { ...notice, responseSlaDays: 15 })).body).toMatchObject({ compliant: true });
    expect(((await call('POST', '/v1/privacy/consent-notice/check', 'u-owner', notice)).body as { defects: { defect: string }[] }).defects.map((d) => d.defect)).toEqual(['no_response_sla']);
    expect(((await call('POST', '/v1/privacy/consent-notice/check', 'u-owner', { ...notice, responseSlaDays: 30 })).body as { defects: { defect: string }[] }).defects.map((d) => d.defect)).toEqual(['response_sla_not_the_published_one']);
  }, 120_000);
});
