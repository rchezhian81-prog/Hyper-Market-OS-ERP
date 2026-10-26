import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import { apiHarness, type ApiHarness } from '../support/api-harness';
import { MemoryIdempotencyStore, SqlIdempotencyStore } from '../../services/kernel/src/index';
import { pgPoolClient } from '../../packages/persistence/src/pg-client';
import { SqlEventStore } from '../../packages/persistence/src/event-store';
import { runMigrations } from '../../packages/persistence/src/migrations';
import { STREAM, streamName } from '../../services/api/src/adapters';

/**
 * **WF-09 "timeout" — a recall's start and its closure whose replies are lost are each ONE effect (§26 · §31.1 · hard
 * rule #10).** The recall screen sends the start and the closure with an idempotency key; when the answer never arrives
 * the screen sends the same request again with the same key. Head office answers with the FIRST result (marked as a
 * replay) — one `RecallInitiated`, one `RecallClosed`, the owner's alert cleared once — and a closure sent again under a
 * NEW key is refused by name (`no_open_recall_to_close`), the record unchanged. Through the real API, in memory and (with
 * DATABASE_URL) on real PostgreSQL, across a cold restart.
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

// A restart keeps the durable records: the event store AND the idempotency record (as PostgreSQL does), never memory.
const memoryKeys = new MemoryIdempotencyStore();
const backings: { name: string; harness: () => ApiHarness; restart: (h: ApiHarness) => ApiHarness }[] = [
  { name: 'the in-memory event store', harness: () => apiHarness({ idempotency: memoryKeys }), restart: (h) => apiHarness({ store: h.store, idempotency: memoryKeys }) },
];
if (DATABASE_URL !== undefined) {
  const pg = (): ApiHarness => { const sql = pgPoolClient(pool!); return apiHarness({ store: new SqlEventStore(sql), idempotency: new SqlIdempotencyStore(sql) }); };
  backings.push({ name: 'real PostgreSQL', harness: pg, restart: pg });
}

type Res = { status: number; body: unknown; headers?: Record<string, string> };
const codeOf = (r: Res): string | undefined => (r.body as { error?: { code?: string } }).error?.code;

describe.each(backings)('a recall start and closure re-sent after a lost reply are one effect each — on $name (WF-09 timeout)', ({ harness, restart }) => {
  it('the same key again is the first answer, once; a closure under a new key is refused by name; a restart reads the same', async () => {
    let h = harness();
    const T = randomUUID();
    await h.seedOwner(T, 'u-owner');
    await h.provisionRole(T, 'u-mgr', 'store_manager');
    const post = (path: string, body: unknown, key: string): Promise<Res> => h.request({ method: 'POST', path, userId: 'u-mgr', tenantId: T, idempotencyKey: key, body });
    const events = async (type: string) => (await h.store.readStream(T, streamName(STREAM.inventory, 'recalls'), { type })).length;
    const alert = async () => ((await h.request({ method: 'GET', path: '/v1/platform/alerts', userId: 'u-owner', tenantId: T })).body as { alerts: { alert: { alertId: string }; state: string }[] })
      .alerts.filter((a) => a.alert.alertId === 'recall:B-LOST').map((a) => a.state);

    // The start, whose reply is lost, sent again with the SAME key: the first answer, once.
    const start = await post('/v1/quality/recalls/B-LOST', { reason: 'supplier notice SN-44' }, 'start-1');
    expect(start.status, JSON.stringify(start.body)).toBe(201);
    const startAgain = await post('/v1/quality/recalls/B-LOST', { reason: 'supplier notice SN-44' }, 'start-1');
    expect(startAgain.status).toBe(201);
    expect(await events('RecallInitiated')).toBe(1);
    expect(await alert()).toEqual(['open']);

    // The closure, whose reply is lost, sent again with the SAME key: the first answer, once.
    const evidence = { evidenceRef: 'SN-44 withdrawn by supplier; 3 packs back; DESTRUCTION-CERT-9' };
    const closed = await post('/v1/quality/recalls/B-LOST/closure', evidence, 'close-1');
    expect(closed.status, JSON.stringify(closed.body)).toBe(200);
    h = restart(h); // ── COLD RESTART between the lost reply and the re-send ──
    const closedAgain = await post('/v1/quality/recalls/B-LOST/closure', evidence, 'close-1');
    expect(closedAgain.status).toBe(200);
    expect((closedAgain.body as { recall: { status: string; evidenceRef: string } }).recall).toMatchObject({ status: 'closed', evidenceRef: evidence.evidenceRef });
    expect(await events('RecallClosed')).toBe(1);
    expect(await alert()).toEqual(['cleared']);

    // A closure sent again under a NEW key (a second person pressing Close) is refused by name — the record is unchanged.
    const second = await post('/v1/quality/recalls/B-LOST/closure', { evidenceRef: 'a different story' }, 'close-2');
    expect([second.status, codeOf(second)]).toEqual([409, 'no_open_recall_to_close']);
    expect(await events('RecallClosed')).toBe(1);
    const read = await h.request({ method: 'GET', path: '/v1/quality/recalls/B-LOST', userId: 'u-mgr', tenantId: T });
    expect((read.body as { recall: { evidenceRef: string } }).recall.evidenceRef).toBe(evidence.evidenceRef);
  }, 60_000);
});
