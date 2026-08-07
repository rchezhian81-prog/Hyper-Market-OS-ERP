import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { Pool } from 'pg';
import { pgClient } from '../../packages/persistence/src/pg-client';
import { runMigrations } from '../../packages/persistence/src/migrations';
import { SqlNumberSeriesStore } from '../../packages/persistence/src/number-series-store';
import { apiHarness, type ApiHarness } from '../support/api-harness';

// Gap-free document number allocation, wired through the real API and proven gap-free under real
// concurrency against PostgreSQL (M01-FR-02). The engine (packages/numbering) was built and tested;
// this makes it a durable, authorized, per-tenant capability of the running system.

const A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const B = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';

interface Allocated { docType: string; seq: number; formatted: string }
const alloc = (h: ApiHarness, o: { docType: string; userId?: string; tenantId?: string; key: string }) =>
  h.request({ method: 'POST', path: `/v1/identity/number-series/${o.docType}`, userId: o.userId ?? 'u-owner', tenantId: o.tenantId ?? A, idempotencyKey: o.key });

describe('gap-free document number allocation through the API (M01-FR-02)', () => {
  it('allocates a gap-free, formatted series per type — authorized, idempotent and per-tenant', async () => {
    const h = apiHarness();
    await h.seedOwner(A, 'u-owner');
    await h.provisionRole(A, 'u-cash', 'cashier');

    const r1 = await alloc(h, { docType: 'receipt', key: 'k1' });
    expect(r1.status).toBe(201);
    expect(r1.body).toMatchObject({ docType: 'receipt', seq: 1, formatted: 'RCP000001' });
    expect(((await alloc(h, { docType: 'receipt', key: 'k2' })).body as Allocated).seq).toBe(2);

    // A different document type is an independent series.
    expect((await alloc(h, { docType: 'invoice', key: 'k3' })).body).toMatchObject({ seq: 1, formatted: 'INV000001' });

    // Idempotent: a retry under the SAME key returns the same number (never burns or duplicates one).
    expect(((await alloc(h, { docType: 'receipt', key: 'k1' })).body as Allocated).seq).toBe(1);

    // Unknown document type → 404; a cashier lacks documents.number.allocate → 403.
    expect((await alloc(h, { docType: 'nope', key: 'k4' })).status).toBe(404);
    expect((await alloc(h, { docType: 'receipt', userId: 'u-cash', key: 'k5' })).status).toBe(403);

    // Per-tenant: tenant B's series starts fresh.
    await h.seedOwner(B, 'u-b');
    expect((await alloc(h, { docType: 'receipt', userId: 'u-b', tenantId: B, key: 'k6' })).body).toMatchObject({ seq: 1 });
  });
});

const DATABASE_URL = process.env['DATABASE_URL'];
const DBT = `d${Date.now().toString(16).slice(-7)}-dddd-4ddd-8ddd-${'d'.repeat(12)}`;

describe.skipIf(!DATABASE_URL)('the number series is gap-free under CONCURRENCY (real PostgreSQL)', () => {
  let pool: Pool;

  beforeAll(async () => {
    pool = new Pool({ connectionString: DATABASE_URL, max: 8 });
    const dir = 'db/migrations';
    await runMigrations(pgClient(pool), readdirSync(dir).filter((f) => f.endsWith('.sql')).sort()
      .map((name) => ({ name, sql: readFileSync(join(dir, name), 'utf8') })));
  });
  afterAll(async () => { await pool.end(); });

  it('100 concurrent allocations yield exactly 1..100 — no gaps, no duplicates', async () => {
    const store = new SqlNumberSeriesStore(pgClient(pool));
    // Race 100 allocations across a real connection pool — the ON CONFLICT DO UPDATE row lock is
    // what makes this safe. A gap or a duplicate would prove it is not.
    const seqs = await Promise.all(Array.from({ length: 100 }, () => store.allocate(DBT, 'receipt')));
    expect([...seqs].sort((a, b) => a - b)).toEqual(Array.from({ length: 100 }, (_, i) => i + 1));
    expect(new Set(seqs).size).toBe(100);
    expect(await store.peek(DBT, 'receipt')).toBe(101);

    // A different document type is an independent run, still starting at 1.
    expect(await store.allocate(DBT, 'invoice')).toBe(1);
  });
});
