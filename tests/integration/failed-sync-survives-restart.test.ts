import { describe, it, expect, afterEach, beforeEach } from 'vitest';
import { mkdtemp, rm, writeFile, appendFile, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startEdge, type EdgeProcess } from '../../edge/store-edge/src/main';
import { serialiseDeadLetter } from '../../edge/store-edge/src/dead-letter-log';
import { makeEvent } from '../../packages/contracts/src/event';

/**
 * **Restart recovery for sales AND refunds — RR-F05 and RR-F06.**
 *
 * The counterexample this suite exists for: a sale or refund the cloud refuses is dead-lettered, the
 * durable cursor is advanced over it, and — because the dead-letter lived only in memory — the next
 * restart lost it entirely (below the cursor, and gone with the process). That is the exact silent
 * discard of a failed financial record hard rule #6 forbids.
 *
 * Everything below drives the REAL `startEdge` (its durable log, cursor, dead-letter store, node,
 * agent and recovery) against a fake cloud whose answers and reachability we control. No database is
 * needed — the cloud here is a header-reading dedupe map, which is all these guarantees turn on. The
 * data is synthetic; nothing touches production (hard rule #7).
 */

const TENANT = 't-rr';
const KEY = ['restart', 'recovery', 'signing', 'key'].join('-').padEnd(48, '0');
const TOKEN = 'x'.repeat(40);

// ── The fake cloud ───────────────────────────────────────────────────────────
let online = true;
let banked: Map<string, unknown>;        // idempotency-key -> payload, deduped (banked once)
let deliveredKeys: string[];             // every POST's key, in order (to count re-sends)
let rejectKeys: Set<string>;             // keys the cloud permanently refuses (-> 400 -> dead-letter)
let failWith5xx: Set<string>;            // keys the cloud fails transiently (-> 500 -> retry)

const cloudFetch = (async (_url: string, init: RequestInit): Promise<Response> => {
  if (!online) throw new Error('ENETUNREACH');
  const headers = init.headers as Record<string, string>;
  const key = headers['idempotency-key'] ?? '';  // the transport always mints one; default keeps tsc happy
  deliveredKeys.push(key);
  if (rejectKeys.has(key)) return new Response(JSON.stringify({ error: 'permanently bad' }), { status: 400 });
  if (failWith5xx.has(key)) return new Response(JSON.stringify({ error: 'bad minute' }), { status: 500 });
  banked.set(key, JSON.parse(String(init.body)));
  return new Response(JSON.stringify({ ok: true }), { status: 200 });
}) as unknown as typeof globalThis.fetch;

let realFetch: typeof globalThis.fetch;
const dirs: string[] = [];

beforeEach(() => {
  online = true;
  banked = new Map();
  deliveredKeys = [];
  rejectKeys = new Set();
  failWith5xx = new Set();
  realFetch = globalThis.fetch;
  globalThis.fetch = cloudFetch;
});
afterEach(async () => {
  globalThis.fetch = realFetch;
  for (const d of dirs.splice(0)) await rm(d, { recursive: true, force: true });
});

const tempDir = async (): Promise<string> => {
  const dir = await mkdtemp(join(tmpdir(), 'sre-rr-'));
  dirs.push(dir);
  return dir;
};

const env = (dir: string) => ({
  EDGE_DATA_DIR: dir, EDGE_TENANT_ID: TENANT, PACK_SIGNING_KEY: KEY,
  EDGE_CAPACITY_BYTES: '10485760',
  CLOUD_API_URL: 'https://cloud.example.test', CLOUD_API_TOKEN: TOKEN,
});

const start = async (dir: string, say: (l: string) => void = () => {}): Promise<EdgeProcess> =>
  (await startEdge(env(dir), say))!;

const saleKey = (id: string) => `edge-${TENANT}-${id}`;
const returnKey = (id: string) => `edge-return-${TENANT}-${id}`;
const saleRecord = (id: string) => JSON.stringify({ id, total: 12_000, laneId: 'lane-1', lines: [{ productId: 'P1', qty: 1, unitPriceMinor: 12_000 }] });
const returnRecord = (id: string) => JSON.stringify({
  id, returnId: id, originalSaleId: 'S-orig', number: `RET-${id}`, processedBy: 'u-meena',
  reasonCode: 'damaged', refundMinor: 5_000, refundTender: 'cash', processedAt: '2026-09-11T10:00:00Z',
  lines: [{ productId: 'P1', uom: 'ea', quantityMinor: 1, disposition: 'damaged' }],
});

// ── Writing durable files directly, to seed a prior box's state ───────────────
const frame = (record: string) => `${Buffer.byteLength(record, 'utf8')} ${record}\n`;
const seedLog = async (dir: string, fileName: string, records: readonly string[]) =>
  writeFile(join(dir, fileName), records.map(frame).join(''));
const seedCursor = async (dir: string, fileName: string, raw: string) =>
  writeFile(join(dir, fileName), raw);
const readCursorFile = async (dir: string, fileName: string) =>
  (await readFile(join(dir, fileName), 'utf8')).trim();
const seedDeadLetter = async (dir: string, fileName: string, key: string, payload: unknown, reason: string, attempts: number) =>
  appendFile(join(dir, fileName), frame(serialiseDeadLetter({
    key, kind: 'dead_lettered', reason, attempts, at: '2026-09-11T09:00:00Z',
    event: makeEvent({ id: key, type: 'SaleCommitted', occurredAt: '2026-09-11T09:00:00Z', idempotencyKey: key, source: 'edge/lane', payload }),
  })));
const countDelivered = (key: string) => deliveredKeys.filter((k) => k === key).length;

// ── RR-F06: a failed-sync record survives a restart ──────────────────────────

describe('RR-F06 — a dead-lettered record survives a restart, visible and with its history', () => {
  it('the original counterexample: a dead-lettered SALE is still there after a restart', async () => {
    const dir = await tempDir();
    rejectKeys.add(saleKey('S-1'));

    const edge = await start(dir);
    await edge.node.commit('S-1', saleRecord('S-1'));
    await edge.syncOnce!();                          // drains -> 400 -> dead-letter -> persisted -> cursor moves
    expect(edge.agent!.health().deadLetterCount).toBe(1);
    await edge.stop();

    // The whole point: after a restart the failure is recovered, not lost.
    const back = await start(dir);
    expect(back.agent!.health().deadLetterCount).toBe(1);   // recovered
    expect(back.agent!.health().unsentCount).toBe(0);       // NOT blindly re-queued as pending
    const dead = back.outbox.deadLetters();
    expect(dead).toHaveLength(1);
    expect(dead[0]?.key).toBe(saleKey('S-1'));
    expect(dead[0]?.reason).toContain('400');               // the reason is preserved
    await back.stop();
  });

  it('a dead-lettered REFUND survives a restart too (the refund pipeline, RR-F05/06 for both)', async () => {
    const dir = await tempDir();
    rejectKeys.add(returnKey('RET-1'));

    const edge = await start(dir);
    const outcome = await edge.node.commitReturn('RET-1', returnRecord('RET-1'));
    expect(outcome.committed).toBe(true);
    await edge.syncOnce!();
    expect(edge.returnsAgent!.health().deadLetterCount).toBe(1);
    await edge.stop();

    const back = await start(dir);
    expect(back.returnsAgent!.health().deadLetterCount).toBe(1);
    expect(back.returnsOutbox.deadLetters()[0]?.key).toBe(returnKey('RET-1'));
    await back.stop();
  });

  it('preserves the attempt count of a record that exhausted its retry budget', async () => {
    const dir = await tempDir();
    failWith5xx.add(saleKey('S-2'));                 // transient, so it burns the attempt budget

    const edge = await start(dir);
    await edge.node.commit('S-2', saleRecord('S-2'));
    for (let i = 0; i < 5; i += 1) await edge.syncOnce!(); // default budget is 5 attempts
    expect(edge.agent!.health().deadLetterCount).toBe(1);
    await edge.stop();

    const back = await start(dir);
    const dead = back.outbox.deadLetters();
    expect(dead).toHaveLength(1);
    expect(dead[0]?.attempts).toBe(5);               // the history is not reset on restart
    expect(dead[0]?.reason).toContain('retry limit');
    await back.stop();
  });

  it('does NOT re-send a restored dead-letter, even once the cloud recovers (no duplicate effect)', async () => {
    const dir = await tempDir();
    rejectKeys.add(saleKey('S-3'));

    const edge = await start(dir);
    await edge.node.commit('S-3', saleRecord('S-3'));
    await edge.syncOnce!();
    await edge.stop();

    // The cloud is healthy now — but a permanently-refused item is a person's problem, not something
    // to quietly retry and perhaps bank. It stays dead-lettered until a human acts.
    rejectKeys.clear();
    const back = await start(dir);
    await back.syncOnce!();
    expect(banked.has(saleKey('S-3'))).toBe(false);  // never banked
    expect(back.agent!.health().deadLetterCount).toBe(1);
    await back.stop();
  });
});

// ── RR-F05: the checkpoint tracks real positions; recovery is correct ────────

describe('RR-F05 — restart recovery and the checkpoint', () => {
  it('an unsynced sale (outage) is re-sent after a restart and banked exactly once', async () => {
    const dir = await tempDir();
    online = false;                                  // the line is down

    const edge = await start(dir);
    await edge.node.commit('S-4', saleRecord('S-4'));
    await edge.syncOnce!();                          // cannot send; stays pending
    expect(edge.agent!.health().unsentCount).toBe(1);
    await edge.stop();
    expect(banked.has(saleKey('S-4'))).toBe(false);

    // The line comes back and the box restarts. The sale re-queues from the log and lands.
    online = true;
    const said: string[] = [];
    const back = await start(dir, (l) => said.push(l));
    expect(said.join('\n')).toContain('1 sale(s) from before are still to send');
    await back.syncOnce!();
    expect(banked.has(saleKey('S-4'))).toBe(true);
    await back.stop();

    // A third start re-sends nothing — the cursor moved past it.
    const third = await start(dir, (l) => said.push(l));
    expect(third.agent!.health().unsentCount).toBe(0);
    await third.syncOnce!();
    expect(countDelivered(saleKey('S-4'))).toBe(1);  // banked exactly once across the whole story
    await third.stop();
  });

  it('a duplicate record in the log does not strand the cursor or re-send forever', async () => {
    const dir = await tempDir();
    // A prior box wrote the same sale twice (a retry that double-appended). One number cannot be a
    // count of records the outbox has deduped, which is what stranded the old cursor.
    await seedLog(dir, 'sales.log', [saleRecord('S-5'), saleRecord('S-5')]);

    const edge = await start(dir);
    await edge.syncOnce!();
    expect(banked.has(saleKey('S-5'))).toBe(true);
    await edge.stop();

    // The cursor covered BOTH positions, so a restart re-sends nothing.
    expect(await readCursorFile(dir, 'sync-cursor')).toBe('2');
    const said: string[] = [];
    const back = await start(dir, (l) => said.push(l));
    expect(said.join('\n')).not.toContain('still to send');
    expect(back.agent!.health().unsentCount).toBe(0);
    await back.syncOnce!();
    expect(countDelivered(saleKey('S-5'))).toBe(1);  // delivered once, not once-per-restart
    await back.stop();
  });

  it('recovers a dead-letter that a previously-incorrect checkpoint had stepped past', async () => {
    const dir = await tempDir();
    // A prior (buggy) box dead-lettered S-6 and advanced the cursor OVER it, but never persisted it
    // durably. Simulate the world just after the fix ships: the record is on the disk, the durable
    // dead-letter store now knows about it, and the cursor is (incorrectly) past it.
    await seedLog(dir, 'sales.log', [saleRecord('S-6')]);
    await seedDeadLetter(dir, 'dead-letters', saleKey('S-6'), { saleId: 'S-6', totalMinor: 12_000 }, 'the cloud answered 400 for SaleCommitted', 1);
    await seedCursor(dir, 'sync-cursor', '1\n');     // points past S-6 — the incorrect checkpoint

    const back = await start(dir);
    // Recovered from the durable store despite sitting below the cursor: visible and actionable again.
    expect(back.agent!.health().deadLetterCount).toBe(1);
    expect(back.outbox.deadLetters()[0]?.key).toBe(saleKey('S-6'));
    await back.stop();
  });

  it('recovers records hidden by a checkpoint that claims more than the log holds', async () => {
    const dir = await tempDir();
    // A corrupt cursor claiming 99 done when only one record exists. Trusting it would hide S-7
    // forever; instead the box re-scans from the start (the cloud dedupes anything already banked).
    await seedLog(dir, 'sales.log', [saleRecord('S-7')]);
    await seedCursor(dir, 'sync-cursor', '99\n');

    const said: string[] = [];
    const back = await start(dir, (l) => said.push(l));
    expect(said.join('\n')).toContain('re-checking all of them');
    await back.syncOnce!();
    expect(banked.has(saleKey('S-7'))).toBe(true);   // the hidden record is recovered and banked
    await back.stop();
  });

  it('survives an interrupted checkpoint write (a garbage cursor file) without losing a sale', async () => {
    const dir = await tempDir();
    await seedLog(dir, 'sales.log', [saleRecord('S-8')]);
    await seedCursor(dir, 'sync-cursor', 'not-a-number');  // a torn write, read conservatively as 0

    const back = await start(dir);
    await back.syncOnce!();
    expect(banked.has(saleKey('S-8'))).toBe(true);   // re-queued and banked; nothing skipped
    await back.stop();
  });

  it('surfaces a malformed record as a failure and keeps the pipeline flowing', async () => {
    const dir = await tempDir();
    // A well-framed record the parser cannot read, between two good sales. It must not be silently
    // skipped (that would slide the checkpoint onto the wrong position); it is dead-lettered, and the
    // good sale AFTER it still syncs.
    await seedLog(dir, 'sales.log', [saleRecord('S-9'), 'not json at all', saleRecord('S-10')]);

    const back = await start(dir);
    await back.syncOnce!();
    expect(banked.has(saleKey('S-9'))).toBe(true);
    expect(banked.has(saleKey('S-10'))).toBe(true);  // the pipeline flowed past the bad record
    expect(back.agent!.health().deadLetterCount).toBe(1); // the malformed one is a person's problem
    await back.stop();

    // And it stays surfaced across a restart, never silently dropped.
    const again = await start(dir);
    expect(again.agent!.health().deadLetterCount).toBe(1);
    await again.stop();
  });

  it('leaves the ordinary sale path exactly as it was — synced once, remembered, never re-sent', async () => {
    const dir = await tempDir();
    const edge = await start(dir);
    await edge.node.commit('S-11', saleRecord('S-11'));
    await edge.syncOnce!();
    expect(banked.has(saleKey('S-11'))).toBe(true);
    await edge.stop();

    const said: string[] = [];
    const back = await start(dir, (l) => said.push(l));
    expect(said.join('\n')).not.toContain('still to send');
    expect(back.agent!.health().unsentCount).toBe(0);
    expect(back.agent!.health().deadLetterCount).toBe(0);
    await back.stop();
    expect(countDelivered(saleKey('S-11'))).toBe(1);
  });
});
