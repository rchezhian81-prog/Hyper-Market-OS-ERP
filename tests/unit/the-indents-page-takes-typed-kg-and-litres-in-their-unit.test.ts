import { describe, it, expect } from 'vitest';
import {
  createIndentsSession, type IndentsData, type IndentsPorts, type IndentsConfig, type IndentRowView, type IndentResolvePort,
} from '../../apps/web-erp/src/indents-session';
import { openDeviceOutbox, guardedStore } from '../../packages/sync/src/device-outbox';
import { typedQuantityMinor } from '../../packages/contracts/src/quantity';

// Round B (PR #852) follow-up, OB-31 rule 1: the Floor indents page took a typed amount as the unit's smallest step, so a
// floor hand asking for "10" kg of loose rice asked for 10 GRAMS, and counting "2.5" kg in off the trolley was refused (or
// "3" counted 3 g). Every amount on the page is now typed in the item's OWN unit and turned into grams / millilitres by the
// ONE shared reading (`typedQuantityMinor`) — never a second conversion. Items stay whole; a unit the system does not know
// (a pack level) keeps its whole-number count. Synthetic data only.

const NOW = '2026-10-31T10:05:00.000Z';
const row = (over: Partial<IndentRowView>): IndentRowView => ({
  indentId: 'ind-1', state: 'issuing', requestedBy: 'u-floor', requestedAt: '2026-10-31T08:00:00.000Z', approvedBy: 'u-mgr',
  fromLocationId: 'S1-BACK', toLocationId: 'S1', reason: null, flags: [], attention: [], needsAttention: true, lines: [], issues: [], ...over,
});
const DATA: IndentsData = {
  indents: [
    row({
      indentId: 'ind-kg',
      lines: [{ productId: 'RICE-LOOSE', uom: 'kg', requestedMinor: 3000, allocatedMinor: 3000, issuedMinor: 2500, receivedMinor: 0, inTransitMinor: 2500, shortfallMinor: 0, outstandingMinor: 500 }],
      issues: [{ issueId: 'is-1', issuedBy: 'u-back', issuedAt: '2026-10-31T09:00:00.000Z', state: 'in_transit', lines: [{ productId: 'RICE-LOOSE', batchId: null, quantityMinor: 2500 }] }],
    }),
    row({
      indentId: 'ind-short', state: 'received',
      lines: [{ productId: 'OIL-LOOSE', uom: 'L', requestedMinor: 5000, allocatedMinor: 5000, issuedMinor: 5000, receivedMinor: 3500, inTransitMinor: 0, shortfallMinor: 1500, outstandingMinor: 0 }],
      issues: [{ issueId: 'is-1', issuedBy: 'u-back', issuedAt: '2026-10-31T09:00:00.000Z', state: 'received', receivedBy: 'u-floor2', resolvedBy: null,
        lines: [{ productId: 'OIL-LOOSE', batchId: null, quantityMinor: 5000 }], shortfall: [{ productId: 'OIL-LOOSE', batchId: null, quantityMinor: 1500, valueMinor: 18_000 }] }],
    }),
  ],
};
const memory = () => { const m = new Map<string, string>(); return { getItem: (k: string) => m.get(k) ?? null, setItem: (k: string, v: string) => { m.set(k, v); } }; };
const outboxOn = () => openDeviceOutbox(guardedStore('sre.indents.outbox.S1', memory(), () => {}), () => {});
const sent: unknown[] = [];
const resolvePort: IndentResolvePort = { post: async (i) => { sent.push(i); return { result: 'resolved' }; } };
const ports: IndentsPorts = {
  snapshot: () => DATA, mayRead: () => true, mayRequest: () => true, mayApprove: () => true, mayReceive: () => true, approvePort: () => null,
  mayResolve: () => true, resolvePort: () => resolvePort,
};
const config: IndentsConfig = {
  userId: 'u-mgr', storeId: 'S1', backStoreId: 'S1-BACK', now: () => NOW,
  products: [{ productId: 'RICE-LOOSE', name: 'Ponni rice (loose)', uom: 'kg' }, { productId: 'OIL-LOOSE', name: 'Groundnut oil (loose)', uom: 'L' }, { productId: 'SOAP', name: 'Soap', uom: 'ea' }],
};

describe('the Floor indents page takes typed kg and litres in their own unit (OB-31 · Round B follow-up)', () => {
  it('RAISE: "10" kg of loose rice asks for 10,000 g (it asked for 10 g); "2.5" kg is 2500 g; "1.25" L is 1250 ml', () => {
    const outbox = outboxOn();
    const s = createIndentsSession(config, ports, outbox);
    expect(s.raise({ lines: [{ productId: 'RICE-LOOSE', quantity: '10', uom: '' }, { productId: 'OIL-LOOSE', quantity: '1.25', uom: '' }, { productId: 'SOAP', quantity: '12', uom: '' }], reason: '' }).ok).toBe(true);
    expect((outbox.pending()[0]?.event.payload as { lines: unknown[] }).lines).toEqual([
      { productId: 'RICE-LOOSE', quantityMinor: 10_000, uom: 'KG' }, { productId: 'OIL-LOOSE', quantityMinor: 1250, uom: 'L' }, { productId: 'SOAP', quantityMinor: 12, uom: 'EA' },
    ]);
    expect(s.savedWork()[0]?.detail).toBe('RICE-LOOSE × 10.000 kg · OIL-LOOSE × 1.250 L · SOAP × 12');
    const two = outboxOn();
    expect(createIndentsSession(config, ports, two).raise({ lines: [{ productId: 'RICE-LOOSE', quantity: '2.5', uom: 'kg' }], reason: '' }).ok).toBe(true);
    expect((two.pending()[0]?.event.payload as { lines: { quantityMinor: number }[] }).lines[0]?.quantityMinor).toBe(2500);
  });

  it('RAISE refuses, with nothing queued, half an item, a fourth decimal of a kg, nought and a word', () => {
    for (const [productId, quantity] of [['SOAP', '1.5'], ['RICE-LOOSE', '2.5001'], ['RICE-LOOSE', '0'], ['RICE-LOOSE', 'ten']] as const) {
      const outbox = outboxOn();
      expect(createIndentsSession(config, ports, outbox).raise({ lines: [{ productId, quantity, uom: '' }], reason: '' }), quantity).toEqual({ ok: false, refusal: 'bad_line' });
      expect(outbox.all()).toEqual([]);
    }
  });

  it('a line drafted by another screen in smallest steps (the shelf-refill draft) is sent exactly as it came, never scaled again', () => {
    const outbox = outboxOn();
    createIndentsSession(config, ports, outbox).raise({ lines: [{ productId: 'RICE-LOOSE', quantityMinor: '2500', uom: '' }], reason: 'shelf refill' });
    expect((outbox.pending()[0]?.event.payload as { lines: { quantityMinor: number }[] }).lines[0]?.quantityMinor).toBe(2500);
  });

  it('COUNT IN: the issued 2500 g reads "2.500 kg" and is offered as "2.500"; "2.5" counted is 2500 g, "0" is none', () => {
    const s = createIndentsSession(config, ports, outboxOn());
    const unit = s.unitOf('ind-kg', 'RICE-LOOSE');
    expect(unit).toBe('kg');
    expect(s.quantityText(2500, unit)).toBe('2.500 kg');
    expect(s.typedText(2500, unit)).toBe('2.500');
    expect(s.typedText(12, 'EA')).toBe('12');
    const outbox = outboxOn();
    expect(createIndentsSession(config, ports, outbox).receive({ indentId: 'ind-kg', issueId: 'is-1', counted: [{ productId: 'RICE-LOOSE', batchId: null, quantity: '2.4' }] }).ok).toBe(true);
    expect((outbox.pending()[0]?.event.payload as { counted: unknown[] }).counted).toEqual([{ productId: 'RICE-LOOSE', batchId: null, quantityMinor: 2400 }]);
    const none = outboxOn();
    expect(createIndentsSession(config, ports, none).receive({ indentId: 'ind-kg', issueId: 'is-1', counted: [{ productId: 'RICE-LOOSE', batchId: null, quantity: '0' }] }).ok).toBe(true);
    expect((none.pending()[0]?.event.payload as { counted: { quantityMinor: number }[] }).counted[0]?.quantityMinor).toBe(0);
    expect(createIndentsSession(config, ports, outboxOn()).receive({ indentId: 'ind-kg', issueId: 'is-1', counted: [{ productId: 'RICE-LOOSE', batchId: null, quantity: '2.4567' }] })).toEqual({ ok: false, refusal: 'bad_count' });
  });

  it('RESOLVE: "0.5" L found again is 500 ml; more than the 1.5 L that went missing is refused', async () => {
    sent.length = 0;
    const s = createIndentsSession(config, ports, outboxOn());
    const base = { indentId: 'ind-short', issueId: 'is-1', reasonCode: 'miscount', note: 'found behind the oil tins' };
    expect(await s.resolve({ ...base, found: [{ productId: 'OIL-LOOSE', batchId: null, found: '1.6' }] })).toEqual({ outcome: 'bad_found' });
    expect(await s.resolve({ ...base, found: [{ productId: 'OIL-LOOSE', batchId: null, found: '0.5' }] })).toEqual({ outcome: 'resolved' });
    expect(sent).toEqual([{ ...base, lines: [{ productId: 'OIL-LOOSE', batchId: null, foundMinor: 500 }] }]);
  });

  it('the shared reading takes a typed nought only when asked (a count), never for an order', () => {
    expect(typedQuantityMinor('0', 'kg')).toBeUndefined();
    expect(typedQuantityMinor('0.000', 'kg', { allowZero: true })).toBe(0);
    expect(typedQuantityMinor('-0', 'kg', { allowZero: true })).toBeUndefined();
    expect(typedQuantityMinor('2.5', 'kg', { allowZero: true })).toBe(2500);
  });
});
