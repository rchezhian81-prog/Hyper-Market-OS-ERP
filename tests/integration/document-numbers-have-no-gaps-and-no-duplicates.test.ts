import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import { pgPoolClient } from '../../packages/persistence/src/pg-client';
import { SqlEventStore, InMemoryEventStore, ConcurrencyConflictError, type EventStore } from '../../packages/persistence/src/event-store';
import { runMigrations } from '../../packages/persistence/src/migrations';
import { makeEvent } from '../../packages/contracts/src/event';
import {
  appendWithDocumentNumber, issuedDocumentNumbers, rangeStandings, rangeGuardKey, DocumentNumbersUsedUp,
} from '../../services/platform/src/document-number-issue';

/**
 * **OB-847 (document numbers, format A) — a number is taken ONLY in the same commit that saves the document.**
 *
 * On real PostgreSQL (and on the in-memory store, which is the behavioural contract): many saves at the same moment give
 * 1…N with no gap and no duplicate; a save that fails uses up no number; a re-sent save gets its own number back; a
 * cancelled document keeps its number; the 99,999th is the last (refused by name after it); the year is the shop's date.
 * Set DATABASE_URL to run the PostgreSQL half; without it that half skips, never passes quietly.
 */

const DATABASE_URL = process.env['DATABASE_URL'];
const AT = '2026-11-18T05:00:00.000Z';

const docEvent = (tenantId: string, id: string, number: string, type = 'TestDocumentSaved') => makeEvent({
  id: `doc-${id}-${type}`, type, occurredAt: AT, idempotencyKey: `doc-${tenantId}-${id}-${type}`, source: 'tests', payload: { id, documentNumber: number },
});

function suite(name: string, make: () => Promise<{ store: EventStore; tenantId: string; done: () => Promise<void> }>): void {
  describe(`document numbers on ${name}`, () => {
    let store: EventStore;
    let tenantId: string;
    let done: () => Promise<void>;
    beforeAll(async () => { ({ store, tenantId, done } = await make()); });
    afterAll(async () => { await done(); });

    const save = (id: string, opts: { at?: string; kind?: 'purchase_order' | 'goods_receipt' } = {}) => appendWithDocumentNumber(store, tenantId, {
      range: opts.kind === 'goods_receipt' ? { kind: 'goods_receipt', storeNumber: 1 } : { kind: 'purchase_order' }, documentRef: id, at: opts.at ?? AT,
      entries: (n) => [{ stream: 'test-docs', event: docEvent(tenantId, id, n) }],
    });

    it('30 saves at the same moment: PO/26-27/00001 … 00030 — no gap, no duplicate, each on its own document', async () => {
      const got = await Promise.all(Array.from({ length: 30 }, (_, i) => save(`po-${i}`)));
      const numbers = got.map((g) => g!.number);
      expect(new Set(numbers).size).toBe(30);
      expect([...numbers].sort()).toEqual(Array.from({ length: 30 }, (_, i) => `PO/26-27/${String(i + 1).padStart(5, '0')}`));
      // Each document carries the number its own issue record says.
      const docs = await store.readStream(tenantId, 'test-docs');
      const issued = await issuedDocumentNumbers(store, tenantId);
      for (const d of docs) {
        const p = d.event.payload as { id: string; documentNumber: string };
        expect(issued.find((i) => i.documentRef === p.id)?.number).toBe(p.documentNumber);
      }
      expect(await store.guardVersion(tenantId, rangeGuardKey('PO', '26-27'))).toBe(30);
    });

    it('a save that fails uses up no number: the next save takes the very next one', async () => {
      // The caller's own guard is stale (a budget moved): the whole save is refused, the range's count with it.
      await store.appendBatch(tenantId, [{ stream: 'budget', event: makeEvent({ id: `b-${randomUUID()}`, type: 'BudgetMoved', occurredAt: AT, idempotencyKey: `b-${randomUUID()}`, source: 'tests', payload: {} }) }], { guard: { key: 'budget:x', expectedVersion: 0 } });
      await expect(appendWithDocumentNumber(store, tenantId, {
        range: { kind: 'purchase_order' }, documentRef: 'po-refused', at: AT, options: { guard: { key: 'budget:x', expectedVersion: 0 } },
        entries: (n) => [{ stream: 'test-docs', event: docEvent(tenantId, 'po-refused', n) }],
      })).rejects.toBeInstanceOf(ConcurrencyConflictError);
      // A save whose own building fails takes nothing either.
      await expect(appendWithDocumentNumber(store, tenantId, {
        range: { kind: 'purchase_order' }, documentRef: 'po-broken', at: AT,
        entries: (n) => { if (n !== '') throw new Error('the document could not be built'); return [{ stream: 'test-docs', event: docEvent(tenantId, 'po-broken', n) }]; },
      })).rejects.toThrow('could not be built');
      expect((await save('po-next'))!.number).toBe('PO/26-27/00031');
      expect((await issuedDocumentNumbers(store, tenantId)).some((i) => i.documentRef === 'po-refused' || i.documentRef === 'po-broken')).toBe(false);
    });

    it('a re-sent save gets its own number back — never a second one', async () => {
      const again = await save('po-next');
      expect(again).toMatchObject({ number: 'PO/26-27/00031', fresh: false });
      expect(await store.guardVersion(tenantId, rangeGuardKey('PO', '26-27'))).toBe(31);
    });

    it('a cancelled document keeps its number; the next document does not take it', async () => {
      const kept = (await save('po-to-cancel'))!.number;
      await store.append(tenantId, 'test-docs', docEvent(tenantId, 'po-to-cancel', kept, 'TestDocumentCancelled'));
      expect((await issuedDocumentNumbers(store, tenantId)).find((i) => i.documentRef === 'po-to-cancel')?.number).toBe(kept);
      expect((await save('po-after-cancel'))!.number).toBe('PO/26-27/00033');
    });

    it('a document saved before format A is never renumbered (OB-845 A)', async () => {
      await store.append(tenantId, 'test-docs', docEvent(tenantId, 'po-old', 'PO-OLD-7'));
      expect(await appendWithDocumentNumber(store, tenantId, {
        range: { kind: 'purchase_order' }, documentRef: 'po-old', at: AT, entries: (n) => [{ stream: 'test-docs', event: docEvent(tenantId, 'po-old', n) }],
      })).toBeNull();
      expect((await issuedDocumentNumbers(store, tenantId)).some((i) => i.documentRef === 'po-old')).toBe(false);
    });

    it('each store-ranged kind is its own range; the year is the shop\'s date, restarting on 1 April (IST)', async () => {
      expect((await save('grn-1', { kind: 'goods_receipt' }))!.number).toBe('GRN1/26-27/00001');
      expect((await save('grn-late-march', { kind: 'goods_receipt', at: '2027-03-31T18:29:59.000Z' }))!.number).toBe('GRN1/26-27/00002');
      expect((await save('grn-april', { kind: 'goods_receipt', at: '2027-03-31T18:30:00.000Z' }))!.number).toBe('GRN1/27-28/00001');
    });

    it('OB-844 A: a warning from 90,000; the 99,999th is the last, then refused by name with nothing saved', async () => {
      // The range's guard version IS its count. To reach the boundary without 90,000 documents, the test moves the guard
      // with guarded appends of its own — exactly the bump each save makes — on the in-memory store (fast); the database
      // half proves the same arithmetic on the concurrency test above.
      const key = rangeGuardKey('PO', '29-30');
      const stand = async (to: number): Promise<void> => {
        for (let v = await store.guardVersion(tenantId, key); v < to; v += 1) {
          await store.appendBatch(tenantId, [{ stream: 'filler', event: makeEvent({ id: `f-${randomUUID()}`, type: 'Filler', occurredAt: AT, idempotencyKey: `f-${randomUUID()}`, source: 'tests', payload: {} }) }], { guard: { key, expectedVersion: v } });
        }
      };
      if (name === 'the in-memory store') {
        await stand(89_999);
        const at = '2029-06-01T05:00:00.000Z';
        const w = await save('po-90000', { at });
        expect(w).toMatchObject({ number: 'PO/29-30/90000', warn: true, remaining: 9_999 });
        expect(rangeStandings(await issuedDocumentNumbers(store, tenantId)).find((r) => r.prefix === 'PO' && r.yearLabel === '29-30'))
          .toMatchObject({ warn: true, lastNumber: 'PO/29-30/90000', says: expect.stringMatching(/9,999 are left/) });
        await stand(99_998);
        expect((await save('po-99999', { at }))!.number).toBe('PO/29-30/99999');
        await expect(save('po-100000', { at })).rejects.toBeInstanceOf(DocumentNumbersUsedUp);
        expect((await store.readStream(tenantId, 'test-docs')).some((e) => (e.event.payload as { id: string }).id === 'po-100000')).toBe(false);
      }
    }, 120_000);
  });
}

suite('the in-memory store', async () => ({ store: new InMemoryEventStore(), tenantId: randomUUID(), done: async () => {} }));

if (DATABASE_URL !== undefined) {
  suite('real PostgreSQL', async () => {
    const pool = new Pool({ connectionString: DATABASE_URL, max: 8, options: '-c app.tenant_id=*' });
    const dir = 'db/migrations';
    await runMigrations(pgPoolClient(pool), readdirSync(dir).filter((f) => f.endsWith('.sql')).sort()
      .map((n) => ({ name: n, sql: readFileSync(join(dir, n), 'utf8') })));
    const store = new SqlEventStore(pgPoolClient(pool));
    const tenantId = randomUUID();
    await store.registerTenant(tenantId, 'tests');
    return { store, tenantId, done: async () => { await pool.end(); } };
  });
} else {
  describe.skip('document numbers on real PostgreSQL (set DATABASE_URL)', () => { it('skipped', () => {}); });
}
