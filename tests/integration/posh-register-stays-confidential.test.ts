import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { execFileSync } from 'node:child_process';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { randomBytes, randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import { apiHarness, type ApiHarness } from '../support/api-harness';
import { SqlIdempotencyStore } from '../../services/kernel/src/index';
import { pgPoolClient } from '../../packages/persistence/src/pg-client';
import { InMemoryEventStore, SqlEventStore } from '../../packages/persistence/src/event-store';
import { runMigrations } from '../../packages/persistence/src/migrations';
import { InMemorySubjectKeyStore, SqlSubjectKeyStore, isSealed } from '../../packages/persistence/src/personal-data';
import { PLATFORM_ADMIN_ROLE_ID } from '../../services/api/src/roles';

/**
 * **R2 addendum C20 — the Internal Committee register stays the committee's (verifier lanes34 NEW-4, NEW-5; OB-157).**
 *   • NEW-4: the owner and the accountant (who hold `audit.retention.read`) do not see the committee's activity in the
 *     general audit trail — search leaves it out, reconstruct is refused by name, the evidence pack leaves it out — while
 *     verify still checks the whole chain, and the committee's own access log still shows it;
 *   • NEW-5: the complaint's summary, who complained, who it is about and a step's note are sealed under the complaint's
 *     own key: the raw event store holds only ciphertext, the idempotent replies hold none of it (the POSTs answer with
 *     ids and status), and a whole-tenant export keeps it sealed — on PostgreSQL, a search of every table and of a
 *     plain-text dump of the database for the text finds nothing.
 * Synthetic data only.
 */

const SUMMARY = 'SYNTHETIC-POSH-SUMMARY-7d1e';
const COMPLAINANT = 'SYNTHETIC-COMPLAINANT-REF-41c9';
const RESPONDENT = 'SYNTHETIC-RESPONDENT-REF-0b3a';
const NOTE = 'SYNTHETIC-COMMITTEE-NOTE-9f20';
const SECRETS = [SUMMARY, COMPLAINANT, RESPONDENT, NOTE];
const codeOf = (r: { body: unknown }): string | undefined => (r.body as { error?: { code?: string } }).error?.code;

async function committeeAtWork(h: ApiHarness, t: string): Promise<{ id: string; call: (method: 'GET' | 'POST', path: string, userId: string, body?: unknown, query?: Record<string, string>) => ReturnType<ApiHarness['request']> }> {
  const call = (method: 'GET' | 'POST', path: string, userId: string, body?: unknown, query?: Record<string, string>) =>
    h.request({ method, path, userId, tenantId: t, ...(body === undefined ? {} : { body }), ...(method === 'POST' ? { idempotencyKey: randomUUID() } : {}), ...(query === undefined ? {} : { query }) });
  await h.seedOwner(t, 'u-owner');
  await h.provisionRole(t, 'u-ic', 'internal_committee');
  await h.provisionRole(t, 'u-acct', 'accountant');
  await h.provisionRole(t, 'u-it', PLATFORM_ADMIN_ROLE_ID);
  const r = await call('POST', '/v1/hr/posh/complaints', 'u-ic', { receivedOn: '2026-03-01', complainantRef: COMPLAINANT, respondentRef: RESPONDENT, summary: SUMMARY });
  expect(r.status).toBe(201);
  const id = (r.body as { complaintId: string }).complaintId;
  for (const secret of SECRETS) expect(JSON.stringify(r.body)).not.toContain(secret);
  const step = await call('POST', `/v1/hr/posh/complaints/${id}/steps`, 'u-ic', { kind: 'disposed', on: '2026-03-05', outcome: 'upheld', note: NOTE });
  expect(step.status).toBe(201);
  for (const secret of SECRETS) expect(JSON.stringify(step.body)).not.toContain(secret);
  expect((await call('GET', '/v1/hr/posh/complaints', 'u-ic')).status).toBe(200);
  // The committee still reads its own register in full.
  const read = await call('GET', `/v1/hr/posh/complaints/${id}`, 'u-ic');
  expect((read.body as { complaint: Record<string, unknown> }).complaint).toMatchObject({ summary: SUMMARY, complainantRef: COMPLAINANT, respondentRef: RESPONDENT, steps: [expect.objectContaining({ note: NOTE })] });
  return { id, call };
}

describe('NEW-4: the committee\'s activity is not in the general audit trail', () => {
  it('the owner and the accountant see none of it — search, reconstruct, evidence pack — and verify still checks every record', async () => {
    const h = apiHarness();
    const t = randomUUID();
    const { id, call } = await committeeAtWork(h, t);
    for (const who of ['u-owner', 'u-acct']) {
      const asked = await call('GET', '/v1/audit/trail', who, undefined, { objectType: 'posh_register' });
      expect(asked.status, who).toBe(200);
      expect((asked.body as { total: number }).total, who).toBe(0);
      const byId = await call('GET', '/v1/audit/trail', who, undefined, { objectId: id });
      expect((byId.body as { total: number }).total, who).toBe(0);
      const everything = JSON.stringify((await call('GET', '/v1/audit/trail', who)).body);
      expect(everything).not.toContain('posh_register');
      expect(everything).not.toContain(id);
      const rebuilt = await call('GET', '/v1/audit/trail/reconstruct', who, undefined, { objectType: 'posh_register', objectId: id });
      expect(rebuilt.status, who).toBe(403);
      expect(codeOf(rebuilt)).toBe('committee_records_are_not_in_the_general_trail');
      expect((await call('GET', '/v1/hr/posh/access-log', who)).status, who).toBe(403);
    }
    const pack = await call('POST', '/v1/audit/evidence-pack-produced', 'u-owner', { from: '2000-01-01T00:00:00Z', until: '2100-01-01T00:00:00Z' });
    expect(pack.status).toBe(200);
    expect(JSON.stringify(pack.body)).not.toContain('posh_register');
    expect(pack.body).toMatchObject({ sourceIntact: true });
    const verify = await call('GET', '/v1/audit/trail/verify', 'u-owner');
    expect(verify.status).toBe(200);
    expect(verify.body).toMatchObject({ intact: true });
    // The committee's own access log still has every act.
    const log = (await call('GET', '/v1/hr/posh/access-log', 'u-ic')).body as { entries: { action: string; objectId: string }[] };
    expect(log.entries.map((e) => `${e.action}:${e.objectId}`)).toEqual(expect.arrayContaining([`posh.complaint.receive:${id}`, `posh.complaint.disposed:${id}`]));
  });
});

describe('NEW-5: the complaint text is sealed per complaint (in-memory store)', () => {
  it('the raw store holds ciphertext; the committee reads it opened; a whole-tenant export keeps it sealed', async () => {
    const raw = new InMemoryEventStore();
    const h = apiHarness({ store: raw, personalDataKeys: new InMemorySubjectKeyStore() });
    const t = randomUUID();
    const { id, call } = await committeeAtWork(h, t);
    const rows = await raw.exportTenant(t);
    const posh = rows.filter((r) => r.event.type === 'PoshComplaintReceived' || r.event.type === 'PoshComplaintStepRecorded');
    expect(posh).toHaveLength(2);
    const received = posh.find((r) => r.event.type === 'PoshComplaintReceived')!.event.payload as Record<string, unknown>;
    for (const f of ['summary', 'complainantRef', 'respondentRef']) expect(isSealed(received[f]), f).toBe(true);
    expect(received['complaintId']).toBe(id);
    expect(JSON.stringify(rows)).not.toContain(SUMMARY);
    for (const secret of SECRETS) expect(JSON.stringify(rows)).not.toContain(secret);
    // IT's whole-tenant export: the register's text stays sealed.
    const exported = await call('GET', '/v1/platform/export', 'u-it');
    expect(exported.status).toBe(200);
    const text = JSON.stringify(exported.body);
    expect(text).toContain('PoshComplaintReceived');
    for (const secret of SECRETS) expect(text).not.toContain(secret);
  });
});

const DATABASE_URL = process.env['DATABASE_URL'];
let pool: Pool | undefined;
beforeAll(async () => {
  if (DATABASE_URL === undefined) return;
  pool = new Pool({ connectionString: DATABASE_URL, max: 6, options: '-c app.tenant_id=*' });
  const dir = 'db/migrations';
  await runMigrations(pgPoolClient(pool), readdirSync(dir).filter((f) => f.endsWith('.sql')).sort().map((name) => ({ name, sql: readFileSync(join(dir, name), 'utf8') })));
});
afterAll(async () => { await pool?.end(); });

describe.skipIf(DATABASE_URL === undefined)('NEW-5 on real PostgreSQL: nothing of the complaint is in plain text anywhere in the database', () => {
  it('a search of every table — event_ledger, idempotency_keys and all — and of a plain-text dump finds none of the text', async () => {
    const sql = pgPoolClient(pool!);
    const h = apiHarness({ store: new SqlEventStore(sql), idempotency: new SqlIdempotencyStore(sql), personalDataKeys: new SqlSubjectKeyStore(sql, randomBytes(32)) });
    const t = randomUUID();
    const { id } = await committeeAtWork(h, t);
    // The rows really are there (sealed), and the replies really were banked.
    expect((await pool!.query("SELECT count(*)::int AS c FROM event_ledger WHERE tenant_id = $1 AND type IN ('PoshComplaintReceived', 'PoshComplaintStepRecorded')", [t])).rows[0].c).toBe(2);
    const banked = (await pool!.query('SELECT count(*)::int AS c FROM idempotency_keys WHERE tenant_id = $1', [t])).rows[0].c as number;
    expect(banked).toBeGreaterThanOrEqual(2);
    const tables = (await pool!.query<{ table_name: string }>("SELECT table_name FROM information_schema.tables WHERE table_schema = 'public' AND table_type = 'BASE TABLE'")).rows.map((r) => r.table_name);
    expect(tables).toEqual(expect.arrayContaining(['event_ledger', 'idempotency_keys']));
    for (const table of tables) {
      for (const secret of SECRETS) {
        const found = (await pool!.query(`SELECT count(*)::int AS c FROM "${table}" t WHERE t::text LIKE $1`, [`%${secret}%`])).rows[0].c as number;
        expect(found, `${secret} in ${table}`).toBe(0);
      }
    }
    // A backup is a dump of these tables: a plain-text dump of the whole database holds none of it either.
    const dump = execFileSync('pg_dump', ['--data-only', '--no-owner', DATABASE_URL!], { env: { ...process.env, PGOPTIONS: '-c app.tenant_id=*' }, maxBuffer: 1024 * 1024 * 1024 }).toString('utf8');
    expect(dump).toContain(id);
    for (const secret of SECRETS) expect(dump.includes(secret), `${secret} in the dump`).toBe(false);
  }, 180_000);
});
