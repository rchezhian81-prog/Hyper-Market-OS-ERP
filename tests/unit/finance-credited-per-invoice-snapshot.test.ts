import { describe, it, expect } from 'vitest';
import { InMemoryEventStore } from '../../packages/persistence/src/event-store';
import { financeNotesAdapter } from '../../services/api/src/adapters';
import type { CreditNote } from '../../packages/finance/src/index';

// CORE-03 inc1 (consumer): the finance cumulative-credit read — the s.34 cap that must hold across
// every note ever issued against an invoice — folds through the general snapshot facility rather
// than re-summing the whole credit-note history on each issuance. This proves that RUNNING wiring:
// it sums per invoice correctly, ignores debit notes, and never goes stale (a note appended after a
// read is picked up on the next read, because the snapshot resumes from its watermark and folds the
// tail). The bounded-read property itself is pinned in tests/unit/persistence-snapshot.test.ts.

const TENANT = '11111111-1111-4111-8111-111111111111';
const NOW = '2026-08-10T10:00:00Z';

const note = (over: Partial<CreditNote> & { againstInvoiceId: string; taxableMinor: number }): CreditNote => ({
  noteId: `N-${over.againstInvoiceId}-${over.taxableMinor}-${over.kind ?? 'credit_note'}`,
  number: 'CN/1', kind: 'credit_note', againstInvoiceNumber: 'INV/1', customerId: 'C-1',
  issuedOn: NOW, reason: 'goods_returned', taxes: [], grossMinor: over.taxableMinor,
  taxAdjustable: true, declareInPeriod: '2026-08', detail: 'x',
  ...over,
});

describe('financeNotesAdapter.alreadyCredited folds per invoice through the snapshot facility', () => {
  it('sums credit notes per invoice and ignores debit notes', async () => {
    const store = new InMemoryEventStore();
    const adapter = financeNotesAdapter({ store, now: () => NOW });

    await adapter.appendCreditNote(TENANT, note({ againstInvoiceId: 'INV-1', taxableMinor: 30_00 }));
    await adapter.appendCreditNote(TENANT, note({ againstInvoiceId: 'INV-1', taxableMinor: 20_00 }));
    await adapter.appendCreditNote(TENANT, note({ againstInvoiceId: 'INV-2', taxableMinor: 10_00 }));
    // A debit note against INV-1 must NOT reduce the credit headroom.
    await adapter.appendCreditNote(TENANT, note({ againstInvoiceId: 'INV-1', taxableMinor: 5_00, kind: 'debit_note' }));

    expect(await adapter.alreadyCredited(TENANT, 'INV-1')).toBe(50_00);
    expect(await adapter.alreadyCredited(TENANT, 'INV-2')).toBe(10_00);
    expect(await adapter.alreadyCredited(TENANT, 'INV-unknown')).toBe(0);
  });

  it('never goes stale — a note appended after a read is counted on the next read', async () => {
    const store = new InMemoryEventStore();
    const adapter = financeNotesAdapter({ store, now: () => NOW });

    await adapter.appendCreditNote(TENANT, note({ againstInvoiceId: 'INV-1', taxableMinor: 40_00 }));
    expect(await adapter.alreadyCredited(TENANT, 'INV-1')).toBe(40_00);

    // The read may have cached a snapshot; a later note must still be folded from the tail.
    await adapter.appendCreditNote(TENANT, note({ againstInvoiceId: 'INV-1', taxableMinor: 15_00 }));
    expect(await adapter.alreadyCredited(TENANT, 'INV-1')).toBe(55_00);
  });

  it('keeps tenants separate', async () => {
    const store = new InMemoryEventStore();
    const adapter = financeNotesAdapter({ store, now: () => NOW });
    const OTHER = '22222222-2222-4222-8222-222222222222';

    await adapter.appendCreditNote(TENANT, note({ againstInvoiceId: 'INV-1', taxableMinor: 30_00 }));
    expect(await adapter.alreadyCredited(OTHER, 'INV-1')).toBe(0);
  });
});
