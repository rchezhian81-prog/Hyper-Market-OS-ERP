import { describe, it, expect } from 'vitest';
import { InMemoryEventStore } from '../../packages/persistence/src/event-store';
import { b2bCreditAdapter, b2bReceivableCustomers } from '../../services/api/src/adapters';
import { migrationControlsAdapter } from '../../services/api/src/migration-controls-adapters';

/**
 * **OB-408 (owner, option A, 27 Oct 2026) — a credit customer whose movements were keyed by hand is a credit customer.**
 * The month-end receivables check and the parallel run's head-office books day (MG: the legacy system's day against head
 * office's) both found customers only from the B2B posting facts, so a customer whose only movements were keyed onto their
 * receivables ledger by hand was left out of both. A hand-keyed movement now names its customer in the same write, once.
 */
describe('OB-408 — a hand-keyed credit customer is found wherever the receivables are compared', () => {
  it('is on the customer list (once, however many movements), and on head office\'s books day with its balance', async () => {
    const store = new InMemoryEventStore();
    const now = () => '2026-10-20T06:00:00.000Z';
    const credit = b2bCreditAdapter({ store, now });
    const T = 't-ob408';
    expect(await b2bReceivableCustomers(store, T)).toEqual([]);
    await credit.recordReceivable(T, 'CUST9', { movementId: 'h-1', customerId: 'CUST9', kind: 'invoice', deltaMinor: 30_000, at: now(), ref: 'OLD-1' });
    await credit.recordReceivable(T, 'CUST9', { movementId: 'h-2', customerId: 'CUST9', kind: 'payment', deltaMinor: -10_000, at: now(), ref: 'RCPT-1' });
    // A re-sent movement collapses — the balance moves once, the customer is listed once.
    await credit.recordReceivable(T, 'CUST9', { movementId: 'h-2', customerId: 'CUST9', kind: 'payment', deltaMinor: -10_000, at: now(), ref: 'RCPT-1' });
    expect(await b2bReceivableCustomers(store, T)).toEqual(['CUST9']);

    const day = await migrationControlsAdapter({ store, now }).headOfficeBooks(T, '2026-10-20');
    expect(day.customerBalances).toEqual([{ customerId: 'CUST9', owedMinor: 20_000 }]);
  });
});
