import { describe, it, expect } from 'vitest';
import { InMemoryEventStore } from '../../packages/persistence/src/event-store';
import { makeEvent } from '../../packages/contracts/src/event';
import { STREAM, CATEGORIES_STREAM, financeAdapter, qualityHoldAdapter, recallAdapter } from '../../services/api/src/adapters';
import { catalogueMasterSections, expirySections, financeSections, gstReconciliationQueueSection } from '../../services/api/src/round-a-pack-sections';
import { storeCopyOf } from '../../edge/store-edge/src/screen-server';
import { emptyPack } from '../../edge/store-edge/src/store-pack';
import { catalogueGaps, openCataloguePriceRelay } from '../../apps/web-erp/src/browser-entry';
import { createExpirySession } from '../../apps/web-erp/src/expiry-session';
import { Ledger, InMemoryLedgerStore } from '../../packages/ledger/src/ledger';
import type { ProductRecord } from '../../packages/product/src/product';

/**
 * Round A (screen gap audit, 31 Oct 2026) — the new store-pack sections, each read from head office's own register
 * (services/api/src/round-a-pack-sections.ts), and the page-side pieces that show them honestly.
 */

const T = 'tenant-round-a';
const NOW = '2026-10-31T06:00:00.000Z';
const now = (): string => NOW;
const moved = (store: InMemoryEventStore, id: string, m: Record<string, unknown>) =>
  store.append(T, STREAM.inventory, makeEvent({ id, type: 'InventoryMoved', occurredAt: NOW, idempotencyKey: `mv-${T}-${id}`, source: 'test', payload: { movementId: id, occurredAt: NOW, enteredBy: 'u', kind: 'received', ...m } }));

describe('Round A store-pack sections', () => {
  it('categories come from the register (latest version), sorted; the product master is sent whole, every field head office holds', async () => {
    const store = new InMemoryEventStore();
    const stream = CATEGORIES_STREAM;
    for (const [v, name] of [[1, 'Dairy (old)'], [2, 'Dairy']] as const) {
      await store.append(T, stream, makeEvent({ id: `c-dairy-${v}`, type: 'CategoryDefined', occurredAt: NOW, idempotencyKey: `c-dairy-${v}`, source: 'test', payload: { categoryId: 'dairy', name, parentId: null, version: v, definedBy: 'u', approvedBy: 'u', definedAt: NOW, source: 'test', regulated: ['food'] } }));
    }
    await store.append(T, stream, makeEvent({ id: 'c-bev', type: 'CategoryDefined', occurredAt: NOW, idempotencyKey: 'c-bev', source: 'test', payload: { categoryId: 'beverages', name: 'Beverages', parentId: null, version: 1, definedBy: 'u', approvedBy: 'u', definedAt: NOW, source: 'test' } }));
    const master = [
      { productId: 'p2', tenantId: T, sku: 'B', name: 'Bee', primaryCategoryId: 'dairy', baseUom: 'ea', taxClass: '0401', lifecycle: 'active', handling: 'chilled', appContent: { nameTa: 'பீ' } },
      { productId: 'p1', tenantId: T, sku: 'A', name: 'Ay', primaryCategoryId: null, baseUom: 'kg', taxClass: null, lifecycle: 'draft' },
    ] as unknown as ProductRecord[];
    const out = await catalogueMasterSections({ store, now }, T, master);
    expect(out.categories).toEqual([
      { categoryId: 'beverages', name: 'Beverages', parentId: null },
      { categoryId: 'dairy', name: 'Dairy', parentId: null, regulated: ['food'] }, // who defined it stays at head office
    ]);
    expect(out.productMaster.map((p) => p.productId)).toEqual(['p1', 'p2']);
    // Whole: a field the page does not draw (handling, app content) still rides, so a republish from the page keeps it.
    expect(out.productMaster[1]).toMatchObject({ handling: 'chilled', appContent: { nameTa: 'பீ' } });
  });

  it('batches: this store only, one row per product and batch, smallest steps with the unit; held, recalled and undated said', async () => {
    const store = new InMemoryEventStore();
    await moved(store, 'a', { productId: 'rice', locationId: 'S1', quantityMinor: 1_250, uom: 'kg', batchId: 'R1', expiry: '2026-11-10' });
    await moved(store, 'b', { productId: 'rice', locationId: 'S1-BACK', quantityMinor: 750, uom: 'kg', batchId: 'R1', expiry: '2026-11-10' });
    await moved(store, 'c', { productId: 'milk', locationId: 'S1', quantityMinor: 6, uom: 'ea', batchId: 'M1', expiry: '2026-11-01' });
    await moved(store, 'd', { productId: 'milk', locationId: 'S2', quantityMinor: 9, uom: 'ea', batchId: 'M9', expiry: '2026-11-01' }); // another store
    await moved(store, 'e', { productId: 'milk', locationId: 'S1', quantityMinor: 2, uom: 'ea', batchId: 'M-NODATE' });
    await moved(store, 'f', { productId: 'curd', locationId: 'S1', quantityMinor: 4, uom: 'ea', batchId: 'Q1', expiry: '2026-11-03' });
    await moved(store, 'g', { productId: 'milk', locationId: 'S1', quantityMinor: 3, uom: 'ea', batchId: 'SOLD', expiry: '2026-11-02' });
    await moved(store, 'h', { productId: 'milk', locationId: 'S1', quantityMinor: 3, uom: 'ea', batchId: 'SOLD', kind: 'sold' });
    // A shared batch id across two products, recalled; a quality hold on curd's batch.
    await moved(store, 'i', { productId: 'ghee', locationId: 'S2', quantityMinor: 1, uom: 'ea', batchId: 'M1', expiry: '2026-12-01' });
    await recallAdapter({ store, now }).recordInitiated(T, { batchId: 'M1', reason: 'notice', initiatedBy: 'u-owner', initiatedAt: NOW, status: 'open', closedBy: null, closedAt: null, evidenceRef: null }, 'k1');
    await recallAdapter({ store, now }).recordInitiated(T, { batchId: 'GONE', reason: 'old notice', initiatedBy: 'u-owner', initiatedAt: '2026-10-01T00:00:00.000Z', status: 'open', closedBy: null, closedAt: null, evidenceRef: null }, 'k2');
    await recallAdapter({ store, now }).recordClosed(T, { batchId: 'GONE', reason: 'old notice', initiatedBy: 'u-owner', initiatedAt: '2026-10-01T00:00:00.000Z', status: 'closed', closedBy: 'u-mgr', closedAt: '2026-10-05T00:00:00.000Z', evidenceRef: 'destroyed, note 14' }, 'k3');
    await qualityHoldAdapter({ store, now }).recordHeld(T, { batchId: 'Q1', productId: 'curd', reason: 'sample pending', heldBy: 'u-mgr', heldAt: NOW, status: 'held' } as never, 'h1');

    const here = new Set(['S1', 'S1-BACK']);
    const out = await expirySections({ store, now }, T, (l) => here.has(l), (p) => ({ rice: 'KG', milk: 'each', curd: 'ea' } as Record<string, string>)[p]);
    expect(out.batches).toEqual([
      { batchId: 'M1', productId: 'milk', qty: 6, uom: 'ea', expiry: '2026-11-01', state: 'on_hand', recallBlocked: true },
      { batchId: 'Q1', productId: 'curd', qty: 4, uom: 'ea', expiry: '2026-11-03', state: 'quality_hold' },
      { batchId: 'R1', productId: 'rice', qty: 2_000, uom: 'kg', expiry: '2026-11-10', state: 'on_hand' }, // 2.000 kg in grams
    ]); // sold-out SOLD and another store's M9 are not listed
    expect(out.batchesWithoutExpiry).toBe(1);
    expect(out.recalls).toEqual([
      // the shared batch is a recall of BOTH products (the till block's own safe reading), newest first
      { recallId: 'recall-M1-ghee', batchId: 'M1', productId: 'ghee', reason: 'notice', startedBy: 'u-owner', startedAt: NOW },
      { recallId: 'recall-M1-milk', batchId: 'M1', productId: 'milk', reason: 'notice', startedBy: 'u-owner', startedAt: NOW },
      // a batch head office cannot name to a product keeps an empty product — never a guess; closed with its evidence
      { recallId: 'recall-GONE', batchId: 'GONE', productId: '', reason: 'old notice', startedBy: 'u-owner', startedAt: '2026-10-01T00:00:00.000Z', closure: { closedBy: 'u-mgr', closedAt: '2026-10-05T00:00:00.000Z', evidence: 'destroyed, note 14' } },
    ]);
  });

  it('finance: an open month is open; a closed one names who SIGNED it and when; a reopened one is open again; Tally files of the month only', async () => {
    const store = new InMemoryEventStore();
    expect((await financeSections({ store, now }, T, '2026-10')).periodState).toEqual({ period: '2026-10', closed: false });
    const fin = financeAdapter({ store, now });
    await fin.markClosed(T, '2026-10', 'u-ca');
    expect((await financeSections({ store, now }, T, '2026-10')).periodState).toEqual({ period: '2026-10', closed: true, signedBy: 'u-ca', closedAt: NOW });
    await fin.markReopened(T, '2026-10', { requestedBy: 'u-acct', approvedBy: 'u-owner', reason: 'late bill' } as never);
    expect((await financeSections({ store, now }, T, '2026-10')).periodState).toEqual({ period: '2026-10', closed: false });
    const fact = (id: string, period: string, state: string) => makeEvent({ id, type: 'TallyOutboxFact', occurredAt: NOW, idempotencyKey: id, source: 'test', payload: { change: 'queued', by: 's', at: NOW, posting: { postingId: id, idempotencyKey: id, period, journalRef: id, debitMinor: 10, creditMinor: 10, state, attempts: 0, queuedAt: NOW, day: `${period}-01`, sequence: 1, journalIds: [] } } });
    const { TALLY_OUTBOX_STREAM } = await import('../../services/api/src/finance-bridge-adapters');
    await store.append(T, TALLY_OUTBOX_STREAM, fact('t-sep', '2026-09', 'posted'));
    await store.append(T, TALLY_OUTBOX_STREAM, fact('t-oct', '2026-10', 'dead_lettered'));
    expect((await financeSections({ store, now }, T, '2026-10')).tallyPostings.map((p) => (p as { postingId: string }).postingId)).toEqual(['t-oct']);
  });

  it('GST queue: nothing in the lifecycle is an EMPTY queue (head office answered), sorted by document then id', async () => {
    expect(await gstReconciliationQueueSection({ store: new InMemoryEventStore(), now }, T)).toEqual([]);
  });

  it('the pack stays reasonable: a product master record and a batch row are each well under a kilobyte', () => {
    // A 14,000 sq ft hypermarket's range (~15,000 lines) → the master section is a few megabytes, the size of the products
    // section the pack already carries; the price history (the largest thing kept) is read through the relay instead.
    const rec = { productId: 'p-0000012345', tenantId: '6f1c2c1e-0000-4000-8000-000000000000', sku: 'SKU-0000012345', name: 'Aashirvaad whole wheat atta 5 kg', brand: 'Aashirvaad', primaryCategoryId: 'grocery-atta', baseUom: 'ea', taxClass: '1101', lifecycle: 'active', mrpHistory: [{ value: { minor: 29_500, currency: 'INR' }, effectiveFrom: '2026-01-01' }], attributes: { packSize: '5 kg' }, safety: { countryOfOrigin: 'India', netQuantity: '5 kg' } };
    expect(JSON.stringify(rec).length).toBeLessThan(600);
    const batch = { batchId: 'B-2026-10-31-0001', productId: 'p-0000012345', qty: 2_500, uom: 'kg', expiry: '2026-11-10', state: 'on_hand' };
    expect(JSON.stringify(batch).length).toBeLessThan(150);
  });
});

describe('Round A page-side pieces', () => {
  it('the store copy says when head office last sent it, in the shop clock, and how old it is; nothing sent → null', () => {
    const pack = { ...emptyPack(), receivedAt: '2026-10-31T03:30:00.000Z' };
    expect(storeCopyOf({ pack, now: '2026-10-31T05:45:00.000Z' })).toEqual({ receivedAt: '2026-10-31T03:30:00.000Z', shownAt: '2026-10-31 09:00', ageMinutes: 135 });
    expect(storeCopyOf({ pack: emptyPack(), now: NOW })).toBeNull();
  });

  it('with the price relay, the prices already set are not a gap of the whole page; without it, they are', () => {
    expect(catalogueGaps({ products: [] } as never)).toContain('the_prices_already_set');
    expect(catalogueGaps({ products: [] } as never, true)).not.toContain('the_prices_already_set');
  });

  it('the price relay reads one item once; none set, refused and lost link are each said — never "no price set" for an item not read', async () => {
    const calls: string[] = [];
    const answers: Record<string, () => Response> = {
      milk: () => new Response(JSON.stringify({ productId: 'milk', entries: [{ id: 'e1', productId: 'milk', scope: 'store', scopeRef: 'S1', price: { minor: 2_800, currency: 'INR' }, effectiveFrom: '2026-10-31', status: 'active', version: 1 }, { id: 'x', productId: 'other' }] }), { status: 200 }),
      rice: () => new Response(JSON.stringify({ error: { code: 'not_found', whatHappened: 'no price list' } }), { status: 404 }),
      curd: () => new Response(JSON.stringify({ error: { code: 'forbidden', whatHappened: 'This account does not hold "catalogue.pack.read".' } }), { status: 403 }),
    };
    const fake = (async (url: string) => {
      calls.push(url);
      const id = decodeURIComponent(/\/v1\/prices\/list\/([^/]+)\/history/.exec(url)![1]!);
      const answer = answers[id];
      if (answer === undefined) throw new TypeError('Failed to fetch');
      return answer();
    }) as unknown as typeof fetch;
    const relay = openCataloguePriceRelay(fake);
    expect(relay.state('milk')).toBe('not_loaded');
    const [a, b] = await Promise.all([relay.load('milk'), relay.load('milk')]);
    expect([a, b]).toEqual(['loaded', 'loaded']);
    expect(await relay.load('milk')).toBe('loaded');
    expect(calls.filter((u) => u.includes('/milk/'))).toHaveLength(1); // read once
    expect(relay.entries().map((e) => e.id)).toEqual(['e1']); // only the item's own entries
    expect(await relay.load('rice')).toBe('none');
    expect(await relay.load('curd')).toBe('refused');
    expect(relay.why('curd')).toBe('This account does not hold "catalogue.pack.read".');
    expect(await relay.load('ghee')).toBe('lost_link');
    expect(relay.why('ghee')).toMatch(/Head office cannot be reached/);
    expect(calls[0]).toBe('/v1/prices/list/milk/history');
  });

  it('a recall head office sent with no product is shown by its batch code; a closure without counts reads as closed', () => {
    const session = createExpirySession(
      { tenantId: T, storeId: 'S1', userId: 'u-mgr', now: NOW, nearExpiryDays: 3 },
      {
        batches: () => [], ledger: () => new Ledger(new InMemoryLedgerStore()), productNames: () => ({ milk: 'Toned milk' }),
        recalls: () => [
          { recallId: 'recall-GONE', batchId: 'GONE', productId: '', reason: 'r', startedBy: 'u', startedAt: NOW, closure: { closedBy: 'u-mgr', closedAt: NOW, evidence: 'destroyed' } },
          { recallId: 'recall-M1', batchId: 'M1', productId: 'milk', reason: 'r', startedBy: 'u', startedAt: NOW },
        ],
        recallCloud: { initiate: async () => ({ recorded: true }), close: async () => ({ recorded: true }) },
      },
    );
    const views = session.recalls();
    expect(views.map((v) => [v.name, v.open])).toEqual([['Toned milk', true], ['GONE', false]]);
  });
});
