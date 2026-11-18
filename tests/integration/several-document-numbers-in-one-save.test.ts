import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import { pgPoolClient } from '../../packages/persistence/src/pg-client';
import { SqlEventStore, InMemoryEventStore, ConcurrencyConflictError, type EventStore } from '../../packages/persistence/src/event-store';
import { runMigrations } from '../../packages/persistence/src/migrations';
import { makeEvent } from '../../packages/contracts/src/event';
import { appendWithDocumentNumbers, type NumberedDocument } from '../../services/platform/src/document-numbers-batch';
import { issuedDocumentNumbers, rangeGuardKey } from '../../services/platform/src/document-number-issue';

/**
 * **OB-850 — several documents saved together each get their OWN number, in the SAME save** (a count's held write-offs, the
 * damaged items a floor receipt writes off). On real PostgreSQL and on the in-memory store: three write-offs in one save take
 * three consecutive numbers and move the range's count by three; many such saves at the same moment, mixing ranges, give
 * every number once with no gap; a failed save takes none; a re-sent save gets the same numbers back.
 * Set DATABASE_URL to run the PostgreSQL half.
 */

const DATABASE_URL = process.env['DATABASE_URL'];
const AT = '2026-11-18T05:00:00.000Z';
const wof = (ref: string): NumberedDocument => ({ range: { kind: 'write_off', storeNumber: 1 }, documentRef: ref });
const trf = (ref: string): NumberedDocument => ({ range: { kind: 'transfer_out', storeNumber: 1 }, documentRef: ref });
const ev = (tenantId: string, id: string, number: string) => makeEvent({ id: `doc-${id}`, type: 'TestDocumentSaved', occurredAt: AT, idempotencyKey: `doc-${tenantId}-${id}`, source: 'tests', payload: { id, documentNumber: number } });

function suite(name: string, make: () => Promise<{ store: EventStore; tenantId: string; done: () => Promise<void> }>): void {
  describe(`several numbers in one save on ${name}`, () => {
    let store: EventStore; let tenantId: string; let done: () => Promise<void>;
    beforeAll(async () => { ({ store, tenantId, done } = await make()); });
    afterAll(async () => { await done(); });
    const save = (docs: readonly NumberedDocument[], options?: Parameters<typeof appendWithDocumentNumbers>[2]['options']) => appendWithDocumentNumbers(store, tenantId, {
      docs, at: AT, ...(options === undefined ? {} : { options }),
      entries: (numbers) => docs.map((d, i) => ({ stream: 'test-docs', event: ev(tenantId, d.documentRef, numbers[i] ?? '') })),
    });

    it('three write-offs in one save: WOF1/26-27/00001…00003, and the range\'s count moves by three', async () => {
      expect(await save([wof('a'), wof('b'), wof('c')])).toEqual(['WOF1/26-27/00001', 'WOF1/26-27/00002', 'WOF1/26-27/00003']);
      expect(await store.guardVersion(tenantId, rangeGuardKey('WOF1', '26-27'))).toBe(3);
      // A re-sent save: the same numbers, nothing new taken.
      expect(await save([wof('a'), wof('b'), wof('c')])).toEqual(['WOF1/26-27/00001', 'WOF1/26-27/00002', 'WOF1/26-27/00003']);
      expect(await store.guardVersion(tenantId, rangeGuardKey('WOF1', '26-27'))).toBe(3);
    });

    it('twenty saves at the same moment, mixing two ranges: every number once, no gap, each on its own document', async () => {
      const saves = Array.from({ length: 20 }, (_, i) => save(i % 2 === 0 ? [wof(`w${i}a`), wof(`w${i}b`), trf(`t${i}`)] : [trf(`t${i}a`), wof(`w${i}`)]));
      const got = (await Promise.all(saves)).flat() as string[];
      const w = got.filter((n) => n.startsWith('WOF1/')).sort();
      const t = got.filter((n) => n.startsWith('TRF1/')).sort();
      expect(w).toEqual(Array.from({ length: 30 }, (_, i) => `WOF1/26-27/${String(i + 4).padStart(5, '0')}`));
      expect(t).toEqual(Array.from({ length: 20 }, (_, i) => `TRF1/26-27/${String(i + 1).padStart(5, '0')}`));
      const docs = await store.readStream(tenantId, 'test-docs');
      const issued = await issuedDocumentNumbers(store, tenantId);
      for (const d of docs) {
        const p = d.event.payload as { id: string; documentNumber: string };
        expect(issued.find((i) => i.documentRef === p.id)?.number).toBe(p.documentNumber);
      }
    }, 60_000);

    it('a failed save takes none; the next save takes the very next numbers', async () => {
      await store.appendBatch(tenantId, [{ stream: 'x', event: makeEvent({ id: `x-${randomUUID()}`, type: 'X', occurredAt: AT, idempotencyKey: `x-${randomUUID()}`, source: 'tests', payload: {} }) }], { guard: { key: 'held:x', expectedVersion: 0 } });
      await expect(save([wof('refused-1'), wof('refused-2')], { guard: { key: 'held:x', expectedVersion: 0 } })).rejects.toBeInstanceOf(ConcurrencyConflictError);
      expect(await save([wof('next')])).toEqual(['WOF1/26-27/00034']);
      expect((await issuedDocumentNumbers(store, tenantId)).some((i) => i.documentRef.startsWith('refused'))).toBe(false);
    });
  });
}

suite('the in-memory store', async () => ({ store: new InMemoryEventStore(), tenantId: randomUUID(), done: async () => {} }));
if (DATABASE_URL !== undefined) {
  suite('real PostgreSQL', async () => {
    const pool = new Pool({ connectionString: DATABASE_URL, max: 8, options: '-c app.tenant_id=*' });
    const dir = 'db/migrations';
    await runMigrations(pgPoolClient(pool), readdirSync(dir).filter((f) => f.endsWith('.sql')).sort().map((n) => ({ name: n, sql: readFileSync(join(dir, n), 'utf8') })));
    const store = new SqlEventStore(pgPoolClient(pool));
    const tenantId = randomUUID();
    await store.registerTenant(tenantId, 'tests');
    return { store, tenantId, done: async () => { await pool.end(); } };
  });
} else {
  describe.skip('several numbers in one save on real PostgreSQL (set DATABASE_URL)', () => { it('skipped', () => {}); });
}
