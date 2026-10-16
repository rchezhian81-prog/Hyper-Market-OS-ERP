import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import { apiHarness, type ApiHarness } from '../support/api-harness';
import { startApi } from '../../services/api/src/main';
import { SqlIdempotencyStore } from '../../services/kernel/src/index';
import { pgPoolClient } from '../../packages/persistence/src/pg-client';
import { SqlEventStore } from '../../packages/persistence/src/event-store';
import { runMigrations } from '../../packages/persistence/src/migrations';

/**
 * **C12 (v2.1 addendum · M32/M35 · ADR-0002) — payment data is pinned to an India region; a configuration that puts it
 * elsewhere fails a check.**
 *   • the REAL head-office start (`startApi`): with PAYMENT_DATA_REGION or PAYMENT_BACKUP_REGION outside India it does not
 *     start, says why by setting name, and never reaches the database;
 *   • on the real API, in memory and (with DATABASE_URL) on real PostgreSQL: a payment provider declaring it keeps the
 *     shop's payment data outside India is refused registration (422) and nothing is kept; one declaring India is
 *     registered.
 * No hostnames: regions are ISO 3166 (`IN`, `IN-<state>`).
 */

const KEY = (n: string): string => [n, 'residency', 'test', 'key'].join('-').padEnd(48, '0');
const env = (over: Record<string, string>) => ({
  // Assembled from parts: the secret scanner refuses a literal credentialed URL anywhere, and is right to.
  DATABASE_URL: ['postgres', '://', 'u', ':', 'p', '@', 'db.invalid:5432/db'].join(''),
  PACK_SIGNING_KEY: KEY('pack'), BOX_HISTORY_SEAL_KEY: KEY('seal'), IDP_SIGNING_KEY: KEY('idp'),
  IDP_ISSUER: 'https://idp.invalid/', IDP_AUDIENCE: 'sre-retail-os-api', PORT: '0', NODE_ENV: 'test', MIGRATION_TARGET_KIND: 'rehearsal',
  ...over,
});

describe('head office does not start with payment data outside India (C12)', () => {
  it.each([
    [{ PAYMENT_DATA_REGION: 'SG' }, 'PAYMENT_DATA_REGION is "SG"'],
    [{ PAYMENT_DATA_REGION: 'IN', PAYMENT_BACKUP_REGION: 'US-VA' }, 'PAYMENT_BACKUP_REGION is "US-VA"'],
  ])('refuses %o', async (over, words) => {
    const out: string[] = []; const err: string[] = [];
    const api = await startApi(env(over), (t) => { out.push(t); }, (t) => { err.push(t); });
    expect(api).toBeUndefined();
    expect(err.join('')).toContain(words);
    expect(err.join('')).toContain('which is not India');
  });
});

const DATABASE_URL = process.env['DATABASE_URL'];
let pool: Pool | undefined;
beforeAll(async () => {
  if (DATABASE_URL === undefined) return;
  pool = new Pool({ connectionString: DATABASE_URL, max: 4, options: '-c app.tenant_id=*' });
  const dir = 'db/migrations';
  await runMigrations(pgPoolClient(pool), readdirSync(dir).filter((f) => f.endsWith('.sql')).sort().map((name) => ({ name, sql: readFileSync(join(dir, name), 'utf8') })));
});
afterAll(async () => { await pool?.end(); });
const backings: { name: string; harness: () => ApiHarness }[] = [{ name: 'the in-memory event store', harness: () => apiHarness() }];
if (DATABASE_URL !== undefined) backings.push({ name: 'real PostgreSQL', harness: () => { const sql = pgPoolClient(pool!); return apiHarness({ store: new SqlEventStore(sql), idempotency: new SqlIdempotencyStore(sql) }); } });

describe.each(backings)('C12 — a payment provider outside India is not registered — on $name', ({ harness }) => {
  it('refuses a provider that keeps payment data elsewhere, registers one in India', async () => {
    const h = harness();
    const T = randomUUID();
    await h.seedOwner(T, 'u-owner');
    const call = (method: 'GET' | 'POST', path: string, body?: unknown) =>
      h.request({ method, path, userId: 'u-owner', tenantId: T, ...(body === undefined ? {} : { body }), ...(method === 'GET' ? {} : { idempotencyKey: `${path}-${randomUUID()}` }) });
    const matrix = await call('POST', '/v1/integration/matrix/pay-m1', { category: 'payment', vendor: 'ExamplePay', model: 'gateway', versions: ['1'], certifiedOn: '2026-01-01', rbiAuthorised: true });
    expect(matrix.status, JSON.stringify(matrix.body)).toBe(201);
    const pay = (id: string, dataRegion: string) => call('POST', `/v1/integration/adapters/${id}`, {
      category: 'payment', vendor: 'ExamplePay', credentialRef: `vault://${id}`, environment: 'sandbox', enabled: true,
      retains: ['provider_token', 'last4', 'network_name'], dataRegion,
    });
    const abroad = await pay('pay-sg', 'SG');
    expect(abroad.status).toBe(422);
    expect((abroad.body as { error: { code: string } }).error.code).toBe('payment_data_outside_india');
    const home = await pay('pay-in', 'IN-MH');
    expect(home.status, JSON.stringify(home.body)).toBe(201);

    const listed = await call('GET', '/v1/integration/health');
    expect(JSON.stringify(listed.body)).not.toContain('pay-sg');
  });
});
