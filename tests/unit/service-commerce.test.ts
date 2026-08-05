import { describe, it, expect } from 'vitest';
import { threeWayMatch, verifyBankChange, purchaseRoutes, type MatchLine, type BankChangeRequest, type PurchaseDeps } from '../../services/purchase/src/index';
import { postJournal, closePeriod, financeRoutes, type JournalEntry, type ControlTotalCheck, type PeriodState, type FinanceDeps } from '../../services/finance/src/index';
import { figure, dashboard, reportingRoutes, type ReportingDeps } from '../../services/reporting/src/index';
import { buildRouter, isWrite } from '../../services/kernel/src/index';

// API-03 Purchase · API-09 Finance · API-10 Reporting.

const NOW = '2026-08-07T12:00:00Z';

describe('API-03 — three documents must agree before money moves', () => {
  const line = (over: Partial<MatchLine> = {}): MatchLine => ({
    productId: 'P1', orderedQty: 100, receivedQty: 100, invoicedQty: 100,
    orderedUnitMinor: 5_000, invoicedUnitMinor: 5_000, ...over,
  });

  it('matches when the order, the delivery and the invoice agree', () => {
    const r = threeWayMatch({ lines: [line()] });
    expect(r.blocked).toBe(false);
    expect(r.payableMinor).toBe(500_000);
    expect(r.withheldMinor).toBe(0);
  });

  it('pays the LOWEST of the three and withholds the rest', () => {
    // Paying the invoice and investigating afterwards is how an overcharge becomes permanent: the
    // supplier has the money and the conversation is now about a refund.
    const r = threeWayMatch({ lines: [line({ receivedQty: 90, invoicedQty: 100 })] });
    expect(r.blocked).toBe(true);
    expect(r.payableMinor).toBe(450_000);
    expect(r.withheldMinor).toBe(50_000);
    expect(r.ownerAction).toContain('turns an overcharge into a refund conversation');
  });

  it('takes the lower price when the invoice is dearer than the order', () => {
    const r = threeWayMatch({ lines: [line({ invoicedUnitMinor: 5_500 })] });
    expect(r.payableMinor).toBe(500_000);
    expect(r.lines[0]?.priceDifferenceMinor).toBe(500);
  });

  it('lets an immaterial difference through rather than blocking a payment run over ₹0.50', () => {
    // Outside the percentage tolerance but trivial in money: one unit at ₹1.50 against ₹1.00 is
    // 50% out and fifty paise. Blocking a supplier payment run over that costs more than it saves.
    const r = threeWayMatch({
      lines: [line({ orderedQty: 1, receivedQty: 1, invoicedQty: 1, orderedUnitMinor: 100, invoicedUnitMinor: 150 })],
      immaterialMinor: 100,
    });
    expect(r.lines[0]?.status).toBe('within_tolerance');
    expect(r.blocked).toBe(false);
  });

  it('still blocks the same percentage when the money is real', () => {
    const r = threeWayMatch({
      lines: [line({ orderedQty: 1, receivedQty: 1, invoicedQty: 1, orderedUnitMinor: 100_000, invoicedUnitMinor: 150_000 })],
      immaterialMinor: 100,
    });
    expect(r.lines[0]?.status).toBe('blocked');
    expect(r.withheldMinor).toBe(50_000);
  });

  it('takes its tolerances from configuration (OC-13)', () => {
    const dearer = [line({ invoicedUnitMinor: 5_050 })];
    expect(threeWayMatch({ lines: dearer, priceToleranceBps: 200 }).lines[0]?.status).toBe('matched');
    expect(threeWayMatch({ lines: dearer, priceToleranceBps: 50 }).lines[0]?.status).toBe('blocked');
  });
});

describe('API-03 — a supplier bank change is verified out of band', () => {
  const change = (over: Partial<BankChangeRequest> = {}): BankChangeRequest => ({
    supplierId: 'SUP-1', newAccount: '00112233', requestedVia: 'email',
    calledBackOn: '+91-44-2222-3333', numberWeAlreadyHeld: '+91-44-2222-3333',
    approvedBy: 'u-manager', requestedBy: 'u-clerk', requestedAt: '2026-08-01T09:00:00Z', ...over,
  });

  it('accepts a change confirmed on a number we already held', () => {
    expect(verifyBankChange(change()).ok).toBe(true);
  });

  it('REFUSES an undated request, before anything else is considered', () => {
    // "When did this come in?" is the first question at an investigation into a payment that went
    // to the wrong place. It also keeps the record straight when a supplier moves to a new account
    // and later moves back: undated, the return looks identical to the original change and
    // collapses into it, leaving the ledger asserting the money still goes to the middle account.
    const r = verifyBankChange(change({ requestedAt: undefined as unknown as string }));
    expect(r.refusedBecause).toBe('no_request_date');
    expect(r.detail).toContain('which is the whole sequence an investigation reads');
    // Not the later refusal it would also have earned had the date been present.
    expect(verifyBankChange(change({ requestedAt: 'last Tuesday' })).refusedBecause).toBe('no_request_date');
  });

  it('REFUSES a change nobody rang about', () => {
    const r = verifyBankChange(change({ calledBackOn: undefined }));
    expect(r.refusedBecause).toBe('not_called_back');
    expect(r.detail).toContain('the money leaves on the next payment run');
  });

  it('REFUSES a call back to the number the request itself supplied', () => {
    // It reaches whoever sent the letter. It feels like verification and confirms nothing.
    const r = verifyBankChange(change({ calledBackOn: '+91-99-0000-0000' }));
    expect(r.refusedBecause).toBe('called_back_on_the_number_they_supplied');
    expect(r.detail).toContain('reaches whoever sent the letter');
  });

  it('REFUSES a change one person requested and approved', () => {
    expect(verifyBankChange(change({ approvedBy: 'u-clerk' })).refusedBecause).toBe('approved_by_the_requester');
    expect(verifyBankChange(change({ approvedBy: undefined })).refusedBecause).toBe('not_approved');
  });
});

describe('API-09 — a closed period is closed', () => {
  const entry = (over: Partial<JournalEntry> = {}): JournalEntry => ({
    entryId: 'J-1', period: '2026-08', documentDate: '2026-07-28',
    narrative: 'supplier invoice received late',
    lines: [{ accountCode: '5000', debitMinor: 10_000, creditMinor: 0 },
      { accountCode: '2000', debitMinor: 0, creditMinor: 10_000 }],
    postedBy: 'u-accounts', ...over,
  });
  const states = new Map<string, PeriodState>([['2026-07', 'closed'], ['2026-08', 'open']]);

  it('posts to an open period', () => {
    const r = postJournal({ entry: entry(), periodStates: states, nextOpenPeriod: '2026-08' });
    expect(r.ok).toBe(true);
    expect(r.postedTo).toBe('2026-08');
  });

  it('REFUSES a post into a closed period and says where it should go', () => {
    // A period that can be reopened quietly is a period whose signed numbers can change after the
    // CA signed them and the return was filed, with nothing downstream able to tell.
    const r = postJournal({ entry: entry({ period: '2026-07' }), periodStates: states, nextOpenPeriod: '2026-08' });
    expect(r.refusedBecause).toBe('period_is_closed');
    expect(r.detail).toContain('a return has already been filed against');
    expect(r.ownerAction).toContain('carrying its real document date of 2026-07-28');
  });

  it('REFUSES an entry that does not balance', () => {
    const r = postJournal({
      entry: entry({ lines: [{ accountCode: '5000', debitMinor: 10_000, creditMinor: 0 }] }),
      periodStates: states, nextOpenPeriod: '2026-08',
    });
    expect(r.refusedBecause).toBe('entry_does_not_balance');
  });

  it('REFUSES an entry with no narrative — the one field read years later', () => {
    const r = postJournal({ entry: entry({ narrative: 'adj' }), periodStates: states, nextOpenPeriod: '2026-08' });
    expect(r.refusedBecause).toBe('no_narrative');
  });
});

describe('API-09 — closing takes two independent totals and a second person', () => {
  const check = (over: Partial<ControlTotalCheck> = {}): ControlTotalCheck => ({
    name: 'Sales', leftMinor: 500_000, rightMinor: 500_000,
    leftDerivation: 'sum of the sales ledger', rightDerivation: 'sum of the bank credits',
    ...over,
  });

  it('closes when the totals agree and somebody who did not post signs it', () => {
    const r = closePeriod({
      period: '2026-08', checks: [check()], closedBy: 'u-owner',
      postedBy: ['u-accounts'], signedBy: 'u-owner',
    });
    expect(r.ok).toBe(true);
  });

  it('REFUSES two totals computed the same way', () => {
    // They agree perfectly and prove nothing — they would agree just as perfectly about a wrong
    // number. The same control MG-06 applies to a migration.
    const r = closePeriod({
      period: '2026-08',
      checks: [check({ rightDerivation: 'Sum of the Sales Ledger' })],
      closedBy: 'u-owner', postedBy: [], signedBy: 'u-owner',
    });
    expect(r.refusedBecause).toBe('both_sides_from_the_same_place');
    expect(r.detail).toContain('would agree just as perfectly about a wrong number');
  });

  it('REFUSES a close where the totals disagree, naming both derivations', () => {
    const r = closePeriod({
      period: '2026-08', checks: [check({ rightMinor: 495_000 })],
      closedBy: 'u-owner', postedBy: [], signedBy: 'u-owner',
    });
    expect(r.refusedBecause).toBe('control_total_does_not_agree');
    expect(r.detail).toContain('sum of the bank credits');
  });

  it('REFUSES a close signed by somebody who posted into the period', () => {
    const r = closePeriod({
      period: '2026-08', checks: [check()], closedBy: 'u-accounts',
      postedBy: ['u-accounts'], signedBy: 'u-accounts',
    });
    expect(r.refusedBecause).toBe('closed_by_whoever_posted');
  });

  it('REFUSES an unsigned close however well it reconciles (QG-07)', () => {
    expect(closePeriod({ period: '2026-08', checks: [check()], closedBy: 'u-owner', postedBy: [] }).refusedBecause)
      .toBe('not_signed');
  });
});

describe('API-03 — nothing to compare is not a match', () => {
  const line = (over: Partial<MatchLine> = {}): MatchLine => ({
    productId: 'P1', orderedQty: 100, receivedQty: 100, invoicedQty: 100,
    orderedUnitMinor: 5_000, invoicedUnitMinor: 5_000, ...over,
  });

  // Found by wiring a real event store behind this service. `matchLines` folds a stream nothing
  // writes to yet, so it returns []. Every step of `threeWayMatch` — map, reduce, some — is
  // perfectly happy with an empty list, so an invoice we hold no documents for came back
  // `blocked: false`, "invoiced 0, matched", and told the owner the three documents agree.
  //
  // Nothing failed when the guard was added, which is the point: no test exercised the empty case,
  // which is exactly why it was wrong.
  it('REFUSES to call an invoice with no lines a match', () => {
    const r = threeWayMatch({ lines: [] });
    expect(r.blocked).toBe(true);
    expect(r.payableMinor).toBe(0);
  });

  it('says nothing was compared, NOT that everything agreed', () => {
    const r = threeWayMatch({ lines: [] });
    // The distinction the owner acts on: checked-and-clean versus not-checked. Only one of them
    // is a reason to pay.
    expect(r.ownerAction).toContain('not because a difference was found');
    expect(r.ownerAction).not.toContain('agree');
    expect(r.detail).toContain('nothing has been compared');
  });

  it('tripwire — a single agreeing line still matches, so the guard is not just refusing everything', () => {
    expect(threeWayMatch({ lines: [line()] }).blocked).toBe(false);
  });
});

describe('API-03 — what is on order is not known, and not zero', () => {
  const deps = (open: PurchaseDeps['openCommitments']): PurchaseDeps => ({
    matchLines: () => [], recordMatch: () => {}, applyBankChange: () => {},
    openCommitments: open, now: () => NOW,
  });
  const call = async (d: PurchaseDeps) => {
    const route = purchaseRoutes(d).find((r) => r.path === '/v1/purchase/commitments')!;
    return route.handler({
      tenantId: 't1', userId: 'u1', traceId: 'x', params: {}, query: {}, headers: {}, body: undefined,
    } as never);
  };

  it('answers not-known when purchase orders are not recorded', async () => {
    const res = await call(deps(() => undefined));
    const body = res.body as { known: boolean; count?: number; detail?: string };
    expect(body.known).toBe(false);
    // Crucially it does not carry a zero the owner could read as a figure.
    expect(body.count).toBeUndefined();
    expect(body.detail).toContain('would read as');
  });

  it('answers with the figure, marked known, when there is one', async () => {
    const res = await call(deps(() => ({ count: 4, valueMinor: 250_000 })));
    expect(res.body).toMatchObject({ known: true, count: 4, valueMinor: 250_000 });
  });
});

describe('API-09 — a month nothing checked does not close', () => {
  // The loop over `checks` is vacuously satisfied by an empty list, so a period with no control
  // total at all closed on a signature and reported "0 control total(s) agreed" — a sentence that
  // reads like success. Zero agreements is silence, not agreement.
  const check = (over: Partial<ControlTotalCheck> = {}): ControlTotalCheck => ({
    name: 'Sales', leftMinor: 500_000, rightMinor: 500_000,
    leftDerivation: 'sum of the sales ledger', rightDerivation: 'sum of the bank credits',
    ...over,
  });

  it('REFUSES a close with no control total at all', () => {
    const r = closePeriod({
      period: '2026-08', checks: [], closedBy: 'u-owner',
      postedBy: ['u-accounts'], signedBy: 'u-owner',
    });
    expect(r.ok).toBe(false);
    expect(r.refusedBecause).toBe('nothing_was_checked');
    expect(r.detail).toContain('nothing has checked');
  });

  it('refuses it BEFORE the signature is even considered', () => {
    // Otherwise the first thing a person hears is "sign it", and signing is what they can do.
    const r = closePeriod({ period: '2026-08', checks: [], closedBy: 'u-owner', postedBy: [] });
    expect(r.refusedBecause).toBe('nothing_was_checked');
    expect(r.refusedBecause).not.toBe('not_signed');
  });

  it('tripwire — one genuine pair still closes, so the guard is not refusing every close', () => {
    expect(closePeriod({
      period: '2026-08', checks: [check()], closedBy: 'u-owner',
      postedBy: ['u-accounts'], signedBy: 'u-owner',
    }).ok).toBe(true);
  });
});

describe('API-10 — no figure leaves without the time it is true as of', () => {
  it('marks a current figure live', () => {
    const f = figure({ name: 'Sales today', valueMinor: 100_000, unit: 'minor_currency', asAt: NOW, now: NOW });
    expect(f.staleness).toBe('live');
    expect(f.asAt).toBe(NOW);
  });

  it('separates lagging from stale, because they mean different things to the reader', () => {
    const lagging = figure({
      name: 'Sales', valueMinor: 1, unit: 'minor_currency',
      asAt: '2026-08-07T11:45:00Z', now: NOW,
    });
    expect(lagging.staleness).toBe('lagging');
    expect(lagging.detail).toContain('catching up');

    const stale = figure({
      name: 'Sales', valueMinor: 1, unit: 'minor_currency',
      asAt: '2026-08-07T06:00:00Z', now: NOW,
    });
    expect(stale.staleness).toBe('stale');
    expect(stale.detail).toContain('Do not make a decision on this figure');
  });

  it('returns NOT AVAILABLE rather than zero when it cannot be computed', () => {
    // A zero is a number people act on.
    const f = figure({
      name: 'Margin', unit: 'minor_currency', asAt: NOW, now: NOW,
      notAvailableBecause: 'cost prices have not synchronised',
    });
    expect(f.valueMinor).toBeUndefined();
    expect(f.notAvailableBecause).toBe('cost prices have not synchronised');
    expect(f.detail).toContain('not available');
  });

  it('makes a dashboard as fresh as its STALEST figure', () => {
    const d = dashboard([
      figure({ name: 'A', valueMinor: 1, unit: 'count', asAt: NOW, now: NOW }),
      figure({ name: 'B', valueMinor: 2, unit: 'count', asAt: '2026-08-07T06:00:00Z', now: NOW }),
    ], NOW);
    expect(d.worstStaleness).toBe('stale');
    expect(d.detail).toContain('only as fresh as its stalest number');
  });

  it('is read-only by construction — every route is a GET', () => {
    // A reporting service that can write is a second path into the domains it reports on, with
    // none of their controls, and it is always added "just for this one job".
    const deps: ReportingDeps = { figures: () => [], now: () => NOW };
    for (const r of buildRouter(reportingRoutes(deps)).router!.list()) {
      expect(isWrite(r.method), `${r.method} ${r.path}`).toBe(false);
    }
  });
});

describe('all three register cleanly on the kernel', () => {
  it('passes every registration rule', () => {
    const purchase: PurchaseDeps = {
      matchLines: () => [], recordMatch: () => {}, applyBankChange: () => {},
      openCommitments: () => ({ count: 0, valueMinor: 0 }), now: () => NOW,
    };
    const finance: FinanceDeps = {
      periodStates: () => new Map(), nextOpenPeriod: () => '2026-08', appendJournal: () => {},
      controlTotals: () => [], postersIn: () => [], markClosed: () => {}, now: () => NOW,
    };
    const reporting: ReportingDeps = { figures: () => [], now: () => NOW };

    const built = buildRouter([
      ...purchaseRoutes(purchase), ...financeRoutes(finance), ...reportingRoutes(reporting),
    ]);
    expect(built.refusals.map((r) => r.detail)).toEqual([]);
  });
});
