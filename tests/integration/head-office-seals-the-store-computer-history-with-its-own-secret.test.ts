import { describe, it, expect, afterAll } from 'vitest';
import { randomUUID, randomBytes, createHmac } from 'node:crypto';
import { Pool } from 'pg';
import { startApi } from '../../services/api/src/main';
import { boxHistorySealKey, boxHistoryUnreadable, boxHistoryFromStore } from '../../services/platform/src/box-health';
import { TEST_PACK_KEY } from '../support/api-harness';
import { pgPoolClient } from '../../packages/persistence/src/pg-client';
import { SqlEventStore } from '../../packages/persistence/src/event-store';
import { makeEvent } from '../../packages/contracts/src/event';
import { STREAM, streamName } from '../../services/api/src/adapters';
import { startRealCloud, type RealCloud } from '../support/real-store';

/**
 * **Round 32 · owner decision OB-116 "A" (14 Oct 2026, in writing, "New head-office secret"; verifier r31 NEW-2) — head office
 * seals the store computers' saved history with its OWN secret, BOX_HISTORY_SEAL_KEY, which no store computer holds.**
 *
 *   • the API refuses to start without it, with the placeholder, with one too short, or with one EQUAL to PACK_SIGNING_KEY
 *     (every store computer holds that), the personal-data key or the sign-in key — by name, never echoing a value;
 *   • on PostgreSQL, the served API (startApi, as the container runs it) saves the history sealed under a key made from
 *     BOX_HISTORY_SEAL_KEY: the saved row checks under it, and under NO key a store computer could make from its
 *     PACK_SIGNING_KEY (round 30's derivation, or this round's label applied to the pack key).
 */

const DATABASE_URL = process.env['DATABASE_URL'];
const fakeDb = ['postgres', '://', 'u', ':', 'p', '@', '127.0.0.1:1/never'].join('');
const base = (): Record<string, string> => ({
  DATABASE_URL: fakeDb, PACK_SIGNING_KEY: 'k'.repeat(48), BOX_HISTORY_SEAL_KEY: randomBytes(32).toString('hex'), IDP_SIGNING_KEY: 'i'.repeat(48),
  IDP_ISSUER: 'https://issuer.test', IDP_AUDIENCE: 'sre', PORT: '0', NODE_ENV: 'test',
});
async function refusal(env: Record<string, string | undefined>): Promise<string> {
  const said: string[] = [];
  const running = await startApi(env, (t) => { said.push(t); }, (t) => { said.push(t); });
  if (running !== undefined) { await running.stop(); throw new Error('the API started'); }
  return said.join('');
}

describe('round 32 · OB-116: the API will not start without head office\'s own seal secret', () => {
  it('missing, the placeholder, too short — refused by name at start, every problem at once, the value never echoed', async () => {
    const { BOX_HISTORY_SEAL_KEY: _x, ...noSeal } = base(); void _x;
    expect(await refusal(noSeal)).toMatch(/BOX_HISTORY_SEAL_KEY is not set\. Nothing starts without it/);
    expect(await refusal({ ...base(), BOX_HISTORY_SEAL_KEY: 'REPLACE_WITH_A_GENERATED_VALUE' })).toMatch(/BOX_HISTORY_SEAL_KEY still holds the value from \.env\.example/);
    const short = await refusal({ ...base(), BOX_HISTORY_SEAL_KEY: 'shortsecret123' });
    expect(short).toMatch(/BOX_HISTORY_SEAL_KEY is 14 characters and needs at least 32/);
    expect(short).not.toContain('shortsecret123');
  });

  it('equal to PACK_SIGNING_KEY (held by every store computer), the personal-data key or the sign-in key — refused by name, never echoed', async () => {
    const env = base();
    for (const other of ['PACK_SIGNING_KEY', 'PII_KEY_ENCRYPTION_KEY', 'IDP_SIGNING_KEY']) {
      const same = { ...env, [other]: env['BOX_HISTORY_SEAL_KEY']! };
      const said = await refusal(same);
      expect(said, other).toMatch(new RegExp(`this service will not start: BOX_HISTORY_SEAL_KEY is the same as ${other}\\. It must be head office's own secret`));
      expect(said).not.toContain(env['BOX_HISTORY_SEAL_KEY']);
    }
  });
});

describe.skipIf(DATABASE_URL === undefined)('round 32 · OB-116: the served API seals the saved history with BOX_HISTORY_SEAL_KEY (PostgreSQL)', () => {
  const clouds: RealCloud[] = [];
  afterAll(async () => { for (const c of clouds) await c.stop(); });

  it('the saved row checks under head office\'s key — and under no key a store computer can make from PACK_SIGNING_KEY', async () => {
    const tenantId = randomUUID();
    const seal = randomBytes(32).toString('hex');
    const cloud = await startRealCloud({ databaseUrl: DATABASE_URL!, tenantId, owner: 'u-owner-r32s', packSigningKey: TEST_PACK_KEY, boxHistorySealKey: seal });
    clouds.push(cloud);
    const platform = new Pool({ connectionString: DATABASE_URL, max: 2, options: '-c app.tenant_id=*' });
    try {
      await cloud.grant('u-box-r32', 'store_computer', undefined, ['S1']);
      for (let i = 0; i < 3; i += 1) {
        const r = await cloud.request({ method: 'POST', path: '/v1/store-computers/health-reports', userId: 'u-box-r32', idempotencyKey: `rep-${randomUUID()}`, body: {
          observedAt: new Date().toISOString(), disk: { freeBytes: 5e9, totalBytes: 1e10, salesLogUsedBytes: 1000 + i, salesLogCapacityBytes: 1e7, reserveBytes: 1e6 },
          queue: { unsent: 0, deadLettered: 0 }, tills: [],
        } });
        expect(r.status, JSON.stringify(r.body)).toBe(200);
      }
      // A saved result holds only reports older than FOLD_SETTLE_MINUTES: an hour of earlier reports from the same store
      // computer, laid down in the ledger as the API itself keeps them (synthetic data).
      const hourAgo = Date.now() - 60 * 60_000;
      await new SqlEventStore(pgPoolClient(platform)).appendBatch(tenantId, Array.from({ length: 60 }, (_, i) => {
        const at = new Date(hourAgo + i * 30_000).toISOString();
        return {
          stream: streamName(STREAM.org, 'store-computer-health'),
          event: makeEvent({ id: `bh-r32-${i}`, type: 'StoreComputerHealthReported', occurredAt: at, idempotencyKey: `bh-r32-${tenantId}-${i}`, source: 'test/r32', payload: {
            storeId: 'S1', observedAt: at, receivedAt: at, reportedBy: 'u-box-r32', clockAheadCorrected: false, tills: [],
            disk: { freeBytes: 5e9, totalBytes: 1e10, salesLogUsedBytes: 500 + i, salesLogCapacityBytes: 1e7, reserveBytes: 1e6 }, queue: { unsent: 0, deadLettered: 0 },
          } }),
        };
      }));
      // The health read saves the history (on a busy database the fence may hold the save back for a moment — read again).
      const deadline = Date.now() + 60_000;
      let row: unknown;
      for (;;) {
        const h = await cloud.request({ method: 'GET', path: '/v1/platform/operational-health/observed', userId: 'u-owner-r32s' });
        expect(h.status).toBe(200);
        row = (await platform.query("SELECT data FROM projection_snapshot WHERE tenant_id = $1 AND projection = 'box-health-history@1'", [tenantId])).rows[0]?.data?.result?.state;
        if (row !== undefined) break;
        if (Date.now() > deadline) throw new Error('the served API saved no store-computer history within 60 s');
        await new Promise((resolve) => { setTimeout(resolve, 250); });
      }
      expect(row).toMatchObject({ format: 'box-history-text@3' });
      const saved = boxHistoryFromStore(row);
      expect(boxHistoryUnreadable(saved, boxHistorySealKey(seal))).toBeUndefined();
      const fromPack = [createHmac('sha256', TEST_PACK_KEY).update('sre/box-history-seal@1', 'utf8').digest(), boxHistorySealKey(TEST_PACK_KEY)];
      for (const k of fromPack) expect(boxHistoryUnreadable(saved, k)).toBe('its seal does not match its content (damaged, altered, or sealed with another key)');
    } finally { await platform.end(); }
  }, 300_000);
});
