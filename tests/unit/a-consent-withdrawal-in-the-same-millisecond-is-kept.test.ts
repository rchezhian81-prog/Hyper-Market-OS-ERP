import { describe, it, expect } from 'vitest';
import { InMemoryEventStore } from '../../packages/persistence/src/event-store';
import { customerAdapter } from '../../services/api/src/adapters';
import { mayWeSend, type ConsentRecord } from '../../services/customer/src/index';

// Found by the round-3 gate: a grant and a withdrawal recorded in the SAME millisecond shared one event identity, so
// the store kept the grant and dropped the withdrawal as a replay — the customer read as "may send" after saying stop.
// Each direction is its own fact; the later one wins.
describe('a consent withdrawal in the same millisecond as the grant is kept (PRV-02 · PA-08)', () => {
  const AT = '2026-10-10T09:00:00.000Z';
  const rec = (given: boolean): ConsentRecord => ({
    customerId: 'C-2', purpose: 'marketing', channel: 'whatsapp', given, recordedAt: AT,
    evidence: given ? 'ticked the box at the desk' : 'asked us to stop on the phone',
  });

  it('both facts are stored, and the customer may not be sent', async () => {
    const deps = customerAdapter({ store: new InMemoryEventStore(), now: () => AT });
    await deps.appendConsent('t-1', rec(true));
    await deps.appendConsent('t-1', rec(false));
    const records = await deps.consentRecords('t-1', 'C-2');
    expect(records.map((r) => r.given)).toEqual([true, false]);
    expect(mayWeSend({ customerId: 'C-2', purpose: 'marketing', channel: 'whatsapp', records, now: AT }).verdict).toBe('must_not_send');
  });

  it('the same fact sent twice is still one record', async () => {
    const deps = customerAdapter({ store: new InMemoryEventStore(), now: () => AT });
    await deps.appendConsent('t-1', rec(true));
    await deps.appendConsent('t-1', rec(true));
    expect(await deps.consentRecords('t-1', 'C-2')).toHaveLength(1);
  });
});
