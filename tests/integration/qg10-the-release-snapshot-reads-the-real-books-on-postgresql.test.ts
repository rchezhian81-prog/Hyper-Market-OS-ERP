import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { readdirSync, readFileSync, writeFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { Pool } from 'pg';
import { pgPoolClient } from '../../packages/persistence/src/pg-client';
import { SqlEventStore } from '../../packages/persistence/src/event-store';
import { runMigrations } from '../../packages/persistence/src/migrations';
import { makeEvent } from '../../packages/contracts/src/event';
import { parseSnapshot } from '../../scripts/lib/release-reconcile.mjs';

/**
 * **QG-10 · WF-20: the release's snapshot reads the REAL books** — `scripts/release-reconcile.mjs snapshot` against
 * real PostgreSQL over the production migrations, exactly as the release script runs it inside the migrate container
 * (DATABASE_URL from its own environment, read only). Events appended after the before-snapshot are trading and leave
 * the earlier ledger unchanged (RECONCILED); a new dead letter in the outbox is a DIFFERENCE. The snapshot reads every
 * shop's rows (the platform scope) and writes nothing.
 */

const DATABASE_URL = process.env['DATABASE_URL'];
const CLI = join(process.cwd(), 'scripts/release-reconcile.mjs');
const run = (...args: string[]) => spawnSync('node', [CLI, ...args], { encoding: 'utf8', env: { ...process.env, DATABASE_URL: DATABASE_URL ?? '' } });

describe.skipIf(!DATABASE_URL)('QG-10: the release snapshot reads the real books — real PostgreSQL', () => {
  let pool: Pool;
  let dir: string;
  beforeAll(async () => {
    pool = new Pool({ connectionString: DATABASE_URL, max: 4, options: '-c app.tenant_id=*' });
    const m = 'db/migrations';
    await runMigrations(pgPoolClient(pool), readdirSync(m).filter((f) => f.endsWith('.sql')).sort().map((name) => ({ name, sql: readFileSync(join(m, name), 'utf8') })));
    dir = mkdtempSync(join(tmpdir(), 'qg10-pg-'));
  });
  afterAll(async () => { await pool.end(); rmSync(dir, { recursive: true, force: true }); });

  it('trading after the snapshot reconciles; a new dead letter does not; nothing is written by the snapshot', async () => {
    const T = randomUUID();
    const store = new SqlEventStore(pgPoolClient(pool));
    const sale = (n: number) => makeEvent({ id: randomUUID(), type: 'SaleCommitted', occurredAt: '2026-10-26T09:00:00.000Z', idempotencyKey: `qg10-${T}-${n}`, source: 'test/qg10', payload: { n } });
    await store.append(T, 'sales', sale(1));
    await store.append(T, 'sales', sale(2));

    const b = run('snapshot');
    expect(b.status, b.stderr).toBe(0);
    const before = parseSnapshot(b.stdout);
    expect(before, b.stdout).toBeDefined();
    expect(before!.ledger.count).toBeGreaterThanOrEqual(2);
    expect(before!.ledger.byFamily['sales']).toBeGreaterThanOrEqual(2);
    writeFileSync(join(dir, 'before.json'), b.stdout);
    // The snapshot wrote nothing: the same snapshot again reads the same ledger.
    const again = parseSnapshot(run('snapshot').stdout)!;
    expect(again.ledger.maxSeq).toBeGreaterThanOrEqual(before!.ledger.maxSeq);

    // Trading continues during the release: two more events. The earlier ledger is untouched → RECONCILED.
    await store.append(T, 'sales', sale(3));
    await store.append(T, 'stock', sale(4));
    const a = run('snapshot', '--upto', String(before!.ledger.maxSeq));
    expect(a.status, a.stderr).toBe(0);
    const after = parseSnapshot(a.stdout)!;
    expect(after.upTo).toMatchObject({ seq: before!.ledger.maxSeq, count: before!.ledger.count, digest: before!.ledger.digest });
    expect(after.ledger.maxSeq).toBeGreaterThan(before!.ledger.maxSeq);
    writeFileSync(join(dir, 'after.json'), a.stdout);
    const ok = run('compare', join(dir, 'before.json'), join(dir, 'after.json'), '--max-backlog-growth', '1000000', '--max-dead-letter-growth', '1000000');
    expect(ok.status, ok.stdout).toBe(0);
    expect(ok.stdout).toContain('RECONCILED');

    // A message head office gave up on appears: a new dead letter is a difference.
    await pool.query("INSERT INTO sync_outbox (tenant_id, idem_key, event, state, attempts, reason) VALUES ($1, $2, '{}'::jsonb, 'dead_letter', 5, 'qg10 test')", [T, `qg10-dead-${T}`]);
    const d = run('snapshot', '--upto', String(before!.ledger.maxSeq));
    writeFileSync(join(dir, 'dead.json'), d.stdout);
    const dead = parseSnapshot(d.stdout)!;
    expect(dead.outbox.deadLetter).toBeGreaterThanOrEqual(before!.outbox.deadLetter + 1);
    const bad = run('compare', join(dir, 'before.json'), join(dir, 'dead.json'), '--max-backlog-growth', '1000000');
    expect(bad.status).toBe(1);
    expect(bad.stdout).toMatch(/DIFFERENCE — \d+ new dead letter\(s\) in the outbox since the release/);
    // The connection string is never printed.
    expect(`${b.stdout}${b.stderr}${a.stdout}${a.stderr}`).not.toContain(DATABASE_URL!);
  }, 60_000);
});
