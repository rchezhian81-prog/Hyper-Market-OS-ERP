import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import { apiHarness, type ApiHarness } from '../support/api-harness';
import { SqlIdempotencyStore } from '../../services/kernel/src/index';
import { STREAM } from '../../services/api/src/adapters';
import { makeEvent } from '../../packages/contracts/src/index';
import { pgPoolClient } from '../../packages/persistence/src/pg-client';
import { SqlEventStore } from '../../packages/persistence/src/event-store';
import { runMigrations } from '../../packages/persistence/src/migrations';

/**
 * **C12 · OB-170 "A" (owner, 16 Oct 2026) — a payment adapter registered before OB-162 that declares no data region is
 * not usable until an India region is declared.** On the real API, in memory and (with DATABASE_URL) on real PostgreSQL.
 * The old registration is written straight into the ledger exactly as the API wrote it before OB-162 (fixed event id,
 * the old idempotency key, no `dataRegion`) — the API itself can no longer register one.
 *   • the health read shows it `blocked`, `usable: false`, `notUsableBecause: payment_data_region_not_declared`;
 *   • using it (recording its traffic) is refused 422 by that name, and nothing is recorded;
 *   • registering it again with an India region is a new fact (the old one is kept) — then it is usable.
 * Synthetic vendors only.
 */

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

interface HealthRow { adapterId: string; state: string; usable: boolean; notUsableBecause?: string; minutesSinceLastSuccess: number | 'never'; detail: string }

describe.each(backings)('OB-170 — a payment adapter with no data region is blocked — on $name', ({ harness }) => {
  it('is shown blocked, refused by name when used, and usable once an India region is declared', async () => {
    const h = harness();
    const T = randomUUID();
    await h.seedOwner(T, 'u-owner');
    const call = (method: 'GET' | 'POST', path: string, body?: unknown) =>
      h.request({ method, path, userId: 'u-owner', tenantId: T, ...(body === undefined ? {} : { body }), ...(method === 'GET' ? {} : { idempotencyKey: `${path}-${randomUUID()}` }) });
    expect((await call('POST', '/v1/integration/matrix/pay-m1', { category: 'payment', vendor: 'ExamplePay', model: 'gateway', versions: ['1'], certifiedOn: '2026-01-01', rbiAuthorised: true })).status).toBe(201);

    // The registration as the API wrote it before OB-162: no dataRegion.
    const old = { adapterId: 'pay-old', tenantId: T, category: 'payment', vendor: 'ExamplePay', environment: 'sandbox', credentialRef: 'vault://pay-old', enabled: true, retains: ['provider_token', 'last4'] };
    await h.store.append(T, STREAM.integration, makeEvent({
      id: 'intg-adapter-pay-old', type: 'IntegrationAdapterRegistered', occurredAt: '2026-09-01T09:00:00.000Z',
      idempotencyKey: `intg-adapter-${T}-pay-old-sandbox-vault://pay-old-true`, source: 'api/platform', payload: old,
    }));
    // A non-payment adapter registered the same old way is unaffected.
    await h.store.append(T, STREAM.integration, makeEvent({
      id: 'intg-adapter-books-old', type: 'IntegrationAdapterRegistered', occurredAt: '2026-09-01T09:00:00.000Z',
      idempotencyKey: `intg-adapter-${T}-books-old-sandbox-vault://books-old-true`, source: 'api/platform',
      payload: { adapterId: 'books-old', tenantId: T, category: 'accounting', vendor: 'ExampleBooks', environment: 'sandbox', credentialRef: 'vault://books-old', enabled: true },
    }));

    const rows = async (): Promise<HealthRow[]> => {
      const r = await call('GET', '/v1/integration/health');
      expect(r.status).toBe(200);
      return (r.body as { adapters: HealthRow[] }).adapters;
    };
    const blocked = (await rows()).find((a) => a.adapterId === 'pay-old')!;
    expect(blocked).toMatchObject({ state: 'blocked', usable: false, notUsableBecause: 'payment_data_region_not_declared', minutesSinceLastSuccess: 'never' });
    expect(blocked.detail).toContain('cannot be used until an India region is declared');
    expect((await rows()).find((a) => a.adapterId === 'books-old')).toMatchObject({ state: 'silent', usable: true });
    expect((await rows())[0]!.adapterId).toBe('pay-old');

    // Using it is refused by name; nothing is recorded.
    const used = await call('POST', '/v1/integration/adapters/pay-old/heartbeats/hb-1', { ok: true, at: new Date().toISOString() });
    expect(used.status).toBe(422);
    expect((used.body as { error: { code: string; wasItSaved: string } }).error).toMatchObject({ code: 'payment_data_region_not_declared', wasItSaved: 'not_saved' });
    expect((await h.store.readStream(T, STREAM.integration, { type: 'IntegrationHeartbeat' })).map((e) => (e.event.payload as { adapterId: string }).adapterId)).toEqual([]);
    expect((await rows()).find((a) => a.adapterId === 'pay-old')).toMatchObject({ state: 'blocked', minutesSinceLastSuccess: 'never' });
    // The non-payment adapter is used as before.
    expect((await call('POST', '/v1/integration/adapters/books-old/heartbeats/hb-2', { ok: true, at: new Date().toISOString() })).status).toBe(201);

    // Declaring an India region: registering it again is a NEW fact; the old registration stays in the ledger.
    const declared = await call('POST', '/v1/integration/adapters/pay-old', { category: 'payment', vendor: 'ExamplePay', credentialRef: 'vault://pay-old', environment: 'sandbox', enabled: true, retains: ['provider_token', 'last4'], dataRegion: 'IN-TN' });
    expect(declared.status, JSON.stringify(declared.body)).toBe(201);
    const regs = await h.store.readStream(T, STREAM.integration, { type: 'IntegrationAdapterRegistered' });
    const mine = regs.filter((e) => (e.event.payload as { adapterId: string }).adapterId === 'pay-old');
    expect(mine.map((e) => (e.event.payload as { dataRegion?: string }).dataRegion ?? 'none')).toEqual(['none', 'IN-TN']);
    expect(mine[0]!.event.id).toBe('intg-adapter-pay-old');
    // The same registration again writes nothing.
    expect((await call('POST', '/v1/integration/adapters/pay-old', { category: 'payment', vendor: 'ExamplePay', credentialRef: 'vault://pay-old', environment: 'sandbox', enabled: true, retains: ['provider_token', 'last4'], dataRegion: 'IN-TN' })).status).toBe(201);
    expect((await h.store.readStream(T, STREAM.integration, { type: 'IntegrationAdapterRegistered' })).length).toBe(regs.length);

    const now = (await rows()).find((a) => a.adapterId === 'pay-old')!;
    expect(now).toMatchObject({ state: 'silent', usable: true });
    expect(now.notUsableBecause).toBeUndefined();
    expect((await call('POST', '/v1/integration/adapters/pay-old/heartbeats/hb-3', { ok: true, at: new Date().toISOString() })).status).toBe(201);
    expect((await rows()).find((a) => a.adapterId === 'pay-old')).toMatchObject({ state: 'healthy', usable: true });
  });
});
