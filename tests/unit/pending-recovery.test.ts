import { describe, it, expect } from 'vitest';
import * as recoveryModule from '../../packages/tender/src/pending-recovery';
import {
  recoverPendingTender,
  pendingExposure,
  dayCloseCheck,
  type UncertainTender,
  type ProviderAuthorisation,
} from '../../packages/tender/src/pending-recovery';

// D04-FR-02 / M12-FR-03: "if uncertain, mark pending and reconcile — NEVER ASSUME
// APPROVAL". The card machine did not answer; this is what happens next.

const TENDER: UncertainTender = {
  tenderId: 'T-1',
  saleId: 'S-1',
  laneId: 'lane-3',
  kind: 'card',
  providerRef: 'tok_5511ab',
  amountMinor: 84_000, // ₹840.00
  currency: 'INR',
  capturedAt: '2026-08-04T19:42:00Z',
};

const capture = (over: Partial<ProviderAuthorisation> = {}): ProviderAuthorisation => ({
  ref: 'tok_5511ab',
  amountMinor: 84_000,
  status: 'captured',
  at: '2026-08-04T19:42:03Z',
  ...over,
});

describe('recovering a payment nobody got an answer about', () => {
  it('confirms a payment that the provider did take', () => {
    const result = recoverPendingTender({
      tender: TENDER,
      authorisations: [capture()],
      statementComplete: true,
      at: '2026-08-05T09:00:00Z',
    });
    expect(result.outcome).toBe('confirmed_paid');
    expect(result.owedMinor).toBe(0);
    expect(result.owedBy).toBe('nobody');
  });

  it('confirms a payment that never happened, and values what the shop is owed', () => {
    const result = recoverPendingTender({
      tender: TENDER,
      authorisations: [capture({ status: 'declined' })],
      statementComplete: true,
      at: '2026-08-05T09:00:00Z',
    });
    expect(result.outcome).toBe('confirmed_not_paid');
    expect(result.owedMinor).toBe(84_000);
    expect(result.owedBy).toBe('shop');
    expect(result.detail).toContain('the goods left the shop unpaid');
  });

  it('AN INCOMPLETE RECORD IS NOT A DECLINE — do not chase a customer who already paid', () => {
    const result = recoverPendingTender({
      tender: TENDER,
      authorisations: [],
      statementComplete: false,
      at: '2026-08-04T20:00:00Z',
    });
    expect(result.outcome).toBe('still_unknown');
    expect(result.resolved).toBe(false);
    expect(result.detail).toContain('do not chase the customer on this');
  });

  it('a COMPLETE record with no authorisation settles it the other way', () => {
    const result = recoverPendingTender({
      tender: TENDER,
      authorisations: [capture({ ref: 'tok_someone_else' })],
      statementComplete: true,
      at: '2026-08-06T09:00:00Z',
    });
    expect(result.outcome).toBe('confirmed_not_paid');
    expect(result.detail).toContain('never paid for');
  });

  it('says plainly when there is nobody to contact', () => {
    const anonymous = recoverPendingTender({
      tender: TENDER,
      authorisations: [],
      statementComplete: true,
      at: '2026-08-06T09:00:00Z',
    });
    expect(anonymous.contactable).toBe(false);
    expect(anonymous.detail).toContain('nobody to contact');

    const known = recoverPendingTender({
      tender: { ...TENDER, customerRef: 'c-loyalty-42' },
      authorisations: [],
      statementComplete: true,
      at: '2026-08-06T09:00:00Z',
    });
    expect(known.contactable).toBe(true);
    expect(known.detail).not.toContain('nobody to contact');
  });
});

describe('money owed BY the shop is reported as loudly as money owed TO it', () => {
  it('catches a double capture from a retried lane', () => {
    const result = recoverPendingTender({
      tender: TENDER,
      authorisations: [capture(), capture({ at: '2026-08-04T19:42:31Z' })],
      statementComplete: true,
      at: '2026-08-05T09:00:00Z',
    });
    expect(result.outcome).toBe('paid_more_than_once');
    expect(result.owedBy).toBe('customer');
    expect(result.owedMinor).toBe(84_000);
    expect(result.tellTheCustomer).toContain('refunded the extra amount today');
  });

  it('catches an over-capture for the wrong amount', () => {
    const result = recoverPendingTender({
      tender: TENDER,
      authorisations: [capture({ amountMinor: 94_000 })],
      statementComplete: true,
      at: '2026-08-05T09:00:00Z',
    });
    expect(result.outcome).toBe('paid_more_than_once');
    expect(result.owedBy).toBe('customer');
    expect(result.owedMinor).toBe(10_000);
  });

  it('catches an under-capture as money the shop is still owed', () => {
    const result = recoverPendingTender({
      tender: TENDER,
      authorisations: [capture({ amountMinor: 80_000 })],
      statementComplete: true,
      at: '2026-08-05T09:00:00Z',
    });
    expect(result.outcome).toBe('confirmed_not_paid');
    expect(result.owedBy).toBe('shop');
    expect(result.owedMinor).toBe(4_000);
  });
});

describe('there is no way to resolve an uncertain tender by hand', () => {
  it('exports nothing that marks a payment settled without evidence', () => {
    const api = Object.keys(recoveryModule);
    expect(api.filter((n) => /markPaid|forcePaid|assume|override|clearPending/i.test(n))).toEqual([]);
    expect(api).toContain('recoverPendingTender');
  });
});

describe('the day-close exposure keeps four numbers apart', () => {
  const results = [
    recoverPendingTender({ tender: { ...TENDER, tenderId: 'T-a', customerRef: 'c-1' }, authorisations: [], statementComplete: true, at: 'x' }),
    recoverPendingTender({ tender: { ...TENDER, tenderId: 'T-b', amountMinor: 30_000 }, authorisations: [], statementComplete: true, at: 'x' }),
    recoverPendingTender({ tender: { ...TENDER, tenderId: 'T-c' }, authorisations: [capture(), capture()], statementComplete: true, at: 'x' }),
    recoverPendingTender({ tender: { ...TENDER, tenderId: 'T-d', amountMinor: 12_000 }, authorisations: [], statementComplete: false, at: 'x' }),
    recoverPendingTender({ tender: { ...TENDER, tenderId: 'T-e' }, authorisations: [capture()], statementComplete: true, at: 'x' }),
  ];

  it('separates recoverable, unrecoverable, owed-to-customers and unknown', () => {
    const exposure = pendingExposure(results);
    expect(exposure.recoverableMinor).toBe(84_000); // identified customer
    expect(exposure.unrecoverableMinor).toBe(30_000); // anonymous walk-in
    expect(exposure.owedToCustomersMinor).toBe(84_000); // double capture
    expect(exposure.unknownMinor).toBe(12_000);
    expect(exposure.detail).toContain('treat this as a loss, not a debt');
  });

  it('BLOCKS the close while the shop is holding a customer\'s money', () => {
    const check = dayCloseCheck(pendingExposure(results));
    expect(check.canClose).toBe(false);
    expect(check.detail).toContain('refund it before closing');
  });

  it('does NOT block the close on a payment that is merely unknown', () => {
    const unknownOnly = pendingExposure([
      recoverPendingTender({ tender: TENDER, authorisations: [], statementComplete: false, at: 'x' }),
    ]);
    const check = dayCloseCheck(unknownOnly);
    expect(check.canClose).toBe(true);
    expect(check.detail).toContain('stated rather than absorbed');
  });

  it('closes clean when there is nothing outstanding', () => {
    const clean = pendingExposure([
      recoverPendingTender({ tender: TENDER, authorisations: [capture()], statementComplete: true, at: 'x' }),
    ]);
    expect(clean.detail).toBe('no pending payments outstanding');
    expect(dayCloseCheck(clean).canClose).toBe(true);
  });
});
