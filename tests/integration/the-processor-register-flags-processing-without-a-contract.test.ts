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

/**
 * **C6 (v2.1 addendum · M16/M32 · DPDP s.8(2)) — every vendor processing personal data has a register entry with a
 * contract reference; processing without one is flagged.** On the real API, in memory and (with DATABASE_URL) on real
 * PostgreSQL:
 *   • with nothing processing personal data, the check passes;
 *   • the platform registers an SMS (messaging) adapter and a delivery (logistics) adapter, and a scanner (hardware): the
 *     check FLAGS the two vendors that carry personal data and have no entry — not the scanner;
 *   • an entry with no contract reference is refused and not kept; the owner records the SMS vendor's contract — its
 *     flag clears; the courier stays flagged; a cashier may neither record nor read the register;
 *   • a renewal is a new entry: the earlier one stays on record; another shop sees none of it.
 */

const OWNER = 'u-owner'; const CASHIER = 'u-cash';
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
const backings: { name: string; harness: () => ApiHarness }[] = [{ name: 'the in-memory event store', harness: () => apiHarness() }];
if (DATABASE_URL !== undefined) backings.push({ name: 'real PostgreSQL', harness: () => { const sql = pgPoolClient(pool!); return apiHarness({ store: new SqlEventStore(sql), idempotency: new SqlIdempotencyStore(sql) }); } });

interface Check { compliant: boolean; findings: { flag: string; vendorName: string; seenIn: string }[] }
interface Body { register: { vendorId: string; contractRef: string; recordedBy: string }[]; check: Check }

describe.each(backings)('C6 — the processor register flags processing without a contract — on $name', ({ harness }) => {
  it('flags each vendor carrying personal data with no registered contract, and clears it when one is recorded', async () => {
    const h = harness();
    const T = randomUUID();
    await h.seedOwner(T, OWNER);
    await h.provisionRole(T, CASHIER, 'cashier');
    const call = (method: 'GET' | 'POST', path: string, user: string, body?: unknown) =>
      h.request({ method, path, userId: user, tenantId: T, ...(body === undefined ? {} : { body }), ...(method === 'GET' ? {} : { idempotencyKey: `${path}-${randomUUID()}` }), query: method === 'GET' ? { date: '2026-10-16' } : {} });
    const register = async (): Promise<Body> => {
      const r = await call('GET', '/v1/privacy/processor-contracts', OWNER);
      expect(r.status, JSON.stringify(r.body)).toBe(200);
      return r.body as Body;
    };

    expect((await register()).check.compliant).toBe(true);

    const adapter = (id: string, category: string, vendor: string) => call('POST', `/v1/integration/adapters/${id}`, OWNER, {
      category, vendor, credentialRef: `vault://${id}`, environment: 'sandbox', enabled: true,
    });
    for (const [id, cat, vendor] of [['sms-1', 'messaging', 'Example SMS Gateway'], ['courier-1', 'logistics', 'Example Courier'], ['scanner-1', 'hardware', 'Example Scanners']] as const) {
      const r = await adapter(id, cat, vendor);
      expect(r.status, JSON.stringify(r.body)).toBe(201);
    }

    let b = await register();
    expect(b.check.compliant).toBe(false);
    expect(b.check.findings.map((f) => [f.flag, f.vendorName, f.seenIn])).toEqual([
      ['processing_without_a_register_entry', 'Example Courier', 'integration-adapter:courier-1'],
      ['processing_without_a_register_entry', 'Example SMS Gateway', 'integration-adapter:sms-1'],
    ]);

    const entry = { vendorId: 'sms-gw', vendorName: 'Example SMS Gateway', dataCategories: ['notification_intents'], purpose: 'bill and offer messages', contractRef: 'DPA-2026-014', contractFrom: '2026-04-01', contractUntil: '2027-03-31' };
    const noRef = await call('POST', '/v1/privacy/processor-contracts', OWNER, { ...entry, contractRef: '' });
    expect(noRef.status).toBe(422);
    expect(codeOf(noRef)).toBe('contract_reference_missing');
    expect((await call('POST', '/v1/privacy/processor-contracts', CASHIER, entry)).status).toBe(403);
    expect((await call('GET', '/v1/privacy/processor-contracts', CASHIER)).status).toBe(403);
    const ok = await call('POST', '/v1/privacy/processor-contracts', OWNER, entry);
    expect(ok.status, JSON.stringify(ok.body)).toBe(201);
    expect(ok.body).toMatchObject({ vendorId: 'sms-gw', contractRef: 'DPA-2026-014', recordedBy: OWNER });

    b = await register();
    expect(b.register).toEqual([expect.objectContaining({ vendorId: 'sms-gw', contractRef: 'DPA-2026-014', recordedBy: OWNER })]);
    expect(b.check.findings.map((f) => f.vendorName)).toEqual(['Example Courier']);

    // A renewal is a new entry; the latest applies and the first stays on record.
    expect((await call('POST', '/v1/privacy/processor-contracts', OWNER, { ...entry, contractRef: 'DPA-2027-002', contractFrom: '2027-04-01', contractUntil: '2028-03-31' })).status).toBe(201);
    b = await register();
    expect(b.register.map((e) => e.contractRef)).toEqual(['DPA-2027-002']);
    // On 16 Oct 2026 the renewal has not started: the latest entry is not yet in force — said, not passed.
    expect(b.check.findings.map((f) => [f.flag, f.vendorName])).toEqual([
      ['processing_without_a_register_entry', 'Example Courier'],
      ['contract_not_in_force', 'Example SMS Gateway'],
    ]);

    const OTHER = randomUUID();
    await h.seedOwner(OTHER, 'u-owner-b');
    const other = await h.request({ method: 'GET', path: '/v1/privacy/processor-contracts', userId: 'u-owner-b', tenantId: OTHER, query: { date: '2026-10-16' } });
    expect((other.body as Body).register).toEqual([]);
    expect((other.body as Body).check.compliant).toBe(true);
  });
});
