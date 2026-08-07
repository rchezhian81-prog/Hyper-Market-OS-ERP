import { describe, it, expect } from 'vitest';
import * as reversalModule from '../../packages/reversal/src/reversal';
import {
  requestReversal,
  resolveFromSettlement,
  refundExceptions,
  refundDayTotals,
  tellTheCustomer,
  CardDataError,
  type OriginalTender,
  type Reversal,
  type ReversalProvider,
  type ProviderOutcome,
} from '../../packages/reversal/src/reversal';

// M13-FR-04 acceptance: "a card refund reconciles to the original charge; a FAILED
// REVERSAL IS AN EXCEPTION, NOT A SILENT SUCCESS; refund totals reconcile at day close."

const ORIGINAL: OriginalTender = {
  tenderId: 'T-1',
  saleId: 'S-1',
  kind: 'card',
  providerRef: 'tok_9f2a41c7',
  amountMinor: 120_000, // ₹1,200.00
  currency: 'INR',
  capturedAt: '2026-08-01T12:00:00Z',
};

/** A provider whose answer is whatever the test needs it to be — including no answer. */
function providerReturning(outcome: ProviderOutcome): ReversalProvider & { calls: number; lastKey?: string } {
  const p = {
    calls: 0,
    lastKey: undefined as string | undefined,
    requestReversal(input: { readonly idempotencyKey: string }): ProviderOutcome {
      p.calls += 1;
      p.lastKey = input.idempotencyKey;
      return outcome;
    },
  };
  return p;
}

function request(
  provider: ReversalProvider,
  overrides: Partial<Parameters<typeof requestReversal>[0]> = {},
) {
  return requestReversal(
    {
      reversalId: 'R-1',
      refundId: 'RF-1',
      original: ORIGINAL,
      amountMinor: 120_000,
      requestedBy: 'u-cashier',
      at: '2026-08-04T10:00:00Z',
      ...overrides,
    },
    provider,
  );
}

describe('never invent a reversal success (M13-FR-04 / §4.3)', () => {
  it('records a confirmed reversal as succeeded, with the provider reference', () => {
    const provider = providerReturning({ result: 'succeeded', providerReversalRef: 'rev_774411' });
    const result = request(provider);

    expect(result.accepted).toBe(true);
    expect(result.reversal?.status).toBe('succeeded');
    expect(result.reversal?.providerReversalRef).toBe('rev_774411');
    expect(result.reversal?.resolvedBy).toBe('provider_response');
    // Confirmed by the provider, but NOT yet seen on a statement (§6.2).
    expect(result.reversal?.reconciled).toBe(false);
  });

  it('RECORDS AN UNKNOWN OUTCOME AS UNCERTAIN — the line this module exists for', () => {
    const provider = providerReturning({ result: 'unknown', reason: 'gateway timeout after 30s' });
    const result = request(provider);

    expect(result.reversal?.status).toBe('uncertain');
    expect(result.detail).toContain('never assumed');
    // And the customer is told the truth, including that we will not double-refund.
    expect(result.tellTheCustomer).toContain('not refund you twice');
  });

  it('records a refusal as failed, never as a quiet nothing', () => {
    const provider = providerReturning({ result: 'failed', reason: 'original transaction already settled' });
    const result = request(provider);

    expect(result.accepted).toBe(false);
    expect(result.reversal?.status).toBe('failed');
    expect(result.reversal?.failureReason).toBe('original transaction already settled');
    expect(result.tellTheCustomer).toContain('refund you another way today');
  });

  it('offers NO way to mark a reversal successful by hand', () => {
    // The absence IS the control. A `markSucceeded` would be used to clear a queue on
    // a busy evening, and this test fails the moment one is exported — so removing the
    // control means visibly deleting the assertion that says why it exists.
    const api = Object.keys(reversalModule);
    expect(api).not.toContain('markSucceeded');
    expect(api).not.toContain('forceSucceed');
    expect(api).not.toContain('overrideStatus');
    expect(api.filter((name) => /succe|force|override/i.test(name))).toEqual([]);
    // The only route out of uncertain is evidence.
    expect(api).toContain('resolveFromSettlement');
  });
});

describe('a double refund is real money out of the door', () => {
  it('is idempotent on the refund id — a retry returns the existing reversal', () => {
    const provider = providerReturning({ result: 'succeeded', providerReversalRef: 'rev_1' });
    const first = request(provider);
    const second = request(provider, { reversalId: 'R-2', existing: [first.reversal!] });

    expect(second.accepted).toBe(false);
    expect(second.outcome).toBe('already_requested');
    expect(second.reversal?.reversalId).toBe('R-1');
    expect(second.detail).toContain('would refund twice');
    // And the provider was never asked a second time.
    expect(provider.calls).toBe(1);
  });

  it('passes the provider its own idempotency key, so a retried NETWORK call is one reversal', () => {
    const provider = providerReturning({ result: 'succeeded', providerReversalRef: 'rev_1' });
    request(provider);
    expect(provider.lastKey).toBe('rev:RF-1');
  });

  it('never reverses more than was charged, across every reversal on the tender', () => {
    const provider = providerReturning({ result: 'succeeded', providerReversalRef: 'rev_1' });
    const part = request(provider, { refundId: 'RF-a', amountMinor: 80_000 });

    const tooMuch = request(provider, {
      reversalId: 'R-2',
      refundId: 'RF-b',
      amountMinor: 50_000,
      existing: [part.reversal!],
    });
    expect(tooMuch.accepted).toBe(false);
    expect(tooMuch.outcome).toBe('exceeds_original');
    expect(tooMuch.detail).toContain('more than was ever taken');

    // Exactly the remainder is fine.
    const rest = request(provider, {
      reversalId: 'R-3',
      refundId: 'RF-c',
      amountMinor: 40_000,
      existing: [part.reversal!],
    });
    expect(rest.accepted).toBe(true);
  });

  it('counts an UNCERTAIN reversal against the cap — the money may still be moving', () => {
    const unsure = providerReturning({ result: 'unknown', reason: 'timeout' });
    const first = request(unsure, { refundId: 'RF-a', amountMinor: 120_000 });
    expect(first.reversal?.status).toBe('uncertain');

    const again = request(providerReturning({ result: 'succeeded', providerReversalRef: 'x' }), {
      reversalId: 'R-2',
      refundId: 'RF-b',
      amountMinor: 120_000,
      existing: [first.reversal!],
    });
    expect(again.outcome).toBe('exceeds_original');
  });

  it('does NOT count a failed reversal against the cap — that money never moved', () => {
    const refused = request(providerReturning({ result: 'failed', reason: 'declined' }), { refundId: 'RF-a' });
    const retry = request(providerReturning({ result: 'succeeded', providerReversalRef: 'ok' }), {
      reversalId: 'R-2',
      refundId: 'RF-b',
      amountMinor: 120_000,
      existing: [refused.reversal!],
    });
    expect(retry.accepted).toBe(true);
  });

  it('refuses a reversal of nothing', () => {
    expect(request(providerReturning({ result: 'succeeded', providerReversalRef: 'x' }), { amountMinor: 0 }).outcome).toBe(
      'invalid_amount',
    );
  });
});

describe('no card data anywhere near a reversal (hard rule #3)', () => {
  it('refuses a PAN-shaped provider reference', () => {
    const provider = providerReturning({ result: 'succeeded', providerReversalRef: 'x' });
    expect(() =>
      request(provider, { original: { ...ORIGINAL, providerRef: '4111111111111111' } }),
    ).toThrow(CardDataError);
    expect(() =>
      request(provider, { original: { ...ORIGINAL, providerRef: '4111 1111 1111 1111' } }),
    ).toThrow(CardDataError);
  });

  it('accepts a real provider token', () => {
    expect(() => request(providerReturning({ result: 'succeeded', providerReversalRef: 'x' }))).not.toThrow();
  });
});

describe('only evidence resolves an uncertain reversal', () => {
  const uncertain: Reversal = {
    reversalId: 'R-1',
    refundId: 'RF-1',
    originalTenderId: 'T-1',
    providerRef: 'tok_9f2a41c7',
    amountMinor: 120_000,
    currency: 'INR',
    status: 'uncertain',
    requestedBy: 'u-cashier',
    requestedAt: '2026-08-04T10:00:00Z',
    failureReason: 'gateway timeout',
    reconciled: false,
  };

  it('a matching credit on the statement confirms it', () => {
    const result = resolveFromSettlement({
      reversal: uncertain,
      credits: [{ settlementId: 'ST-99', ref: 'tok_9f2a41c7', amountMinor: 120_000, settledAt: '2026-08-05T02:00:00Z' }],
      statementComplete: true,
      at: '2026-08-05T09:00:00Z',
    });
    expect(result.changed).toBe(true);
    expect(result.reversal.status).toBe('succeeded');
    expect(result.reversal.reconciled).toBe(true);
    expect(result.reversal.resolvedBy).toBe('provider_settlement');
    expect(result.detail).toContain('the money genuinely went back');
  });

  it('an INCOMPLETE statement leaves it uncertain — no credit yet is not no credit', () => {
    const result = resolveFromSettlement({
      reversal: uncertain,
      credits: [],
      statementComplete: false,
      at: '2026-08-04T14:00:00Z',
    });
    expect(result.changed).toBe(false);
    expect(result.reversal.status).toBe('uncertain');
    expect(result.detail).toContain('not the same as no credit');
  });

  it('a COMPLETE statement with no credit settles it the other way — it did not happen', () => {
    const result = resolveFromSettlement({
      reversal: uncertain,
      credits: [{ settlementId: 'ST-1', ref: 'tok_other', amountMinor: 5_000, settledAt: '2026-08-05T02:00:00Z' }],
      statementComplete: true,
      at: '2026-08-05T09:00:00Z',
    });
    expect(result.changed).toBe(true);
    expect(result.reversal.status).toBe('failed');
    expect(result.detail).toContain('must be refunded another way');
  });

  it('will not match a credit for the wrong amount', () => {
    const result = resolveFromSettlement({
      reversal: uncertain,
      credits: [{ settlementId: 'ST-1', ref: 'tok_9f2a41c7', amountMinor: 60_000, settledAt: '2026-08-05T02:00:00Z' }],
      statementComplete: true,
      at: '2026-08-05T09:00:00Z',
    });
    expect(result.reversal.status).toBe('failed');
  });
});

describe('the cash office list: valued, owned, worst first', () => {
  const at = '2026-08-08T10:00:00Z';
  const make = (over: Partial<Reversal>): Reversal => ({
    reversalId: 'R',
    refundId: 'RF',
    originalTenderId: 'T-1',
    providerRef: 'tok_1',
    amountMinor: 10_000,
    currency: 'INR',
    status: 'succeeded',
    requestedBy: 'u-cashier',
    requestedAt: '2026-08-04T10:00:00Z',
    reconciled: true,
    ...over,
  });

  it('ranks failed above uncertain above merely unreconciled', () => {
    const list = refundExceptions({
      reversals: [
        make({ reversalId: 'R-un', refundId: 'RF-un', status: 'succeeded', reconciled: false, amountMinor: 30_000 }),
        make({ reversalId: 'R-unc', refundId: 'RF-unc', status: 'uncertain', reconciled: false, amountMinor: 20_000 }),
        make({ reversalId: 'R-f', refundId: 'RF-f', status: 'failed', failureReason: 'declined', amountMinor: 10_000 }),
        make({ reversalId: 'R-ok', refundId: 'RF-ok' }), // clean; not an exception
      ],
      originals: [ORIGINAL],
      at,
      owner: 'u-cash-office',
    });

    expect(list.map((e) => e.kind)).toEqual([
      'reversal_failed',
      'reversal_uncertain',
      'reversal_unreconciled',
    ]);
    // Every one is valued and owned.
    expect(list.every((e) => e.valueMinor > 0 && e.owner === 'u-cash-office')).toBe(true);
    expect(list[0]?.detail).toContain('the customer is owed this money');
    expect(list[1]?.detail).toContain('do NOT refund again');
  });

  it('does not flag a confirmed reversal that is still inside the reconciliation window', () => {
    const list = refundExceptions({
      reversals: [make({ status: 'succeeded', reconciled: false, requestedAt: '2026-08-08T08:00:00Z' })],
      originals: [ORIGINAL],
      at,
      owner: 'u-cash-office',
      reconcileWithinHours: 72,
    });
    expect(list).toEqual([]);
  });

  it('catches paying out more than was ever taken', () => {
    const list = refundExceptions({
      reversals: [
        make({ reversalId: 'R-a', refundId: 'RF-a', amountMinor: 100_000 }),
        make({ reversalId: 'R-b', refundId: 'RF-b', amountMinor: 100_000 }),
      ],
      originals: [ORIGINAL], // charged ₹1,200.00
      at,
      owner: 'u-cash-office',
    });
    const over = list.find((e) => e.kind === 'over_refunded');
    expect(over?.valueMinor).toBe(80_000); // ₹2,000.00 out against ₹1,200.00 in
    expect(over?.detail).toContain('paid out more than it took');
  });
});

describe('the day close states all three numbers rather than guessing', () => {
  it('keeps the unknown figure separate from confirmed and failed', () => {
    const totals = refundDayTotals([
      { reversalId: 'a', refundId: 'a', originalTenderId: 'T', providerRef: 'x', amountMinor: 50_000, currency: 'INR', status: 'succeeded', requestedBy: 'u', requestedAt: '2026-08-04T10:00:00Z', reconciled: true },
      { reversalId: 'b', refundId: 'b', originalTenderId: 'T', providerRef: 'y', amountMinor: 20_000, currency: 'INR', status: 'uncertain', requestedBy: 'u', requestedAt: '2026-08-04T11:00:00Z', reconciled: false },
      { reversalId: 'c', refundId: 'c', originalTenderId: 'T', providerRef: 'z', amountMinor: 5_000, currency: 'INR', status: 'failed', requestedBy: 'u', requestedAt: '2026-08-04T12:00:00Z', reconciled: false },
    ]);

    expect(totals.confirmedMinor).toBe(50_000);
    expect(totals.uncertainMinor).toBe(20_000);
    expect(totals.failedMinor).toBe(5_000);
    expect(totals.reversedMinor).toBe(75_000);
    expect(totals.balances).toBe(true);
    expect(totals.detail).toContain('the unknown figure is stated');
  });

  it('says so plainly when the day is clean', () => {
    const totals = refundDayTotals([
      { reversalId: 'a', refundId: 'a', originalTenderId: 'T', providerRef: 'x', amountMinor: 50_000, currency: 'INR', status: 'succeeded', requestedBy: 'u', requestedAt: '2026-08-04T10:00:00Z', reconciled: true },
    ]);
    expect(totals.detail).toBe('50000 refunded and confirmed');
  });
});

describe('what the counter actually says', () => {
  it('never claims a refund that has not happened', () => {
    const base: Reversal = {
      reversalId: 'R', refundId: 'RF', originalTenderId: 'T-1', providerRef: 'tok_1',
      amountMinor: 10_000, currency: 'INR', status: 'succeeded',
      requestedBy: 'u', requestedAt: '2026-08-04T10:00:00Z', reconciled: false,
    };
    expect(tellTheCustomer(base)).toContain('has been sent back to your card');
    expect(tellTheCustomer({ ...base, status: 'pending' })).toContain('waiting for confirmation');
    expect(tellTheCustomer({ ...base, status: 'uncertain' })).toContain('have not had a clear answer');
    expect(tellTheCustomer({ ...base, status: 'failed', failureReason: 'declined' })).toContain('did not accept the refund');
    // The uncertain wording must never imply success.
    expect(tellTheCustomer({ ...base, status: 'uncertain' })).not.toContain('has been sent back');
  });
});
