import { describe, it, expect } from 'vitest';
import * as platform from '../../packages/platform/src/index';
import {
  assertMandateChargeable,
  nextCharge,
  computeTaxInvoice,
  startDunning,
  onChargeResult,
  RBI_NO_AFA_CEILING_MINOR,
  type Mandate,
  type BillingSchedule,
  type DunningPolicy,
} from '../../packages/platform/src/billing';

/**
 * WP5 / ADR-0014 — recurring subscription billing engine.
 *
 * The money path for selling the product: a mandate authorises the debit, a schedule says when it
 * falls (and when the payer must be warned), a GST invoice records it, and dunning handles a failure
 * WITHOUT ever stopping the shop trading. Pure, deterministic, no provider, no card data.
 */

const mandate = (over: Partial<Mandate> = {}): Mandate => ({
  mandateId: 'm-1',
  tenantId: 't-sre',
  rail: 'upi_autopay',
  providerRef: { customerRef: 'cust_x', subscriptionRef: 'sub_x', mandateRef: 'umn_x' },
  status: 'active',
  maxAmountMinor: 2_000_000,
  createdWithAfa: true,
  createdAt: '2026-09-01T00:00:00Z',
  ...over,
});

describe('a mandate authorises an automatic debit, or says exactly why not (RBI e-mandate 2026)', () => {
  it('lets the normal monthly debit run automatically', () => {
    const gate = assertMandateChargeable({ mandate: mandate(), amountMinor: 900_000 });
    expect(gate.ok).toBe(true);
  });

  it('refuses a debit on a mandate that is not active', () => {
    const gate = assertMandateChargeable({ mandate: mandate({ status: 'paused' }), amountMinor: 900_000 });
    expect(gate.ok).toBe(false);
    if (!gate.ok) expect(gate.reason).toBe('mandate_not_active');
  });

  it('refuses a debit above the ceiling the payer authorised — never a quiet attempt', () => {
    const gate = assertMandateChargeable({ mandate: mandate({ maxAmountMinor: 1_000_000 }), amountMinor: 1_200_000 });
    expect(gate.ok).toBe(false);
    if (!gate.ok) expect(gate.reason).toBe('exceeds_mandate_cap');
  });

  it('will not auto-debit above the RBI no-OTP ceiling — that debit needs a step-up', () => {
    const gate = assertMandateChargeable({
      mandate: mandate({ maxAmountMinor: 5_000_000 }),
      amountMinor: RBI_NO_AFA_CEILING_MINOR + 1,
    });
    expect(gate.ok).toBe(false);
    if (!gate.ok) expect(gate.reason).toBe('needs_per_charge_afa');
  });

  it('debits exactly at the ceiling without a step-up', () => {
    const gate = assertMandateChargeable({
      mandate: mandate({ maxAmountMinor: 5_000_000 }),
      amountMinor: RBI_NO_AFA_CEILING_MINOR,
    });
    expect(gate.ok).toBe(true);
  });
});

describe('the schedule debits monthly and warns the payer first (pre-debit notice)', () => {
  const schedule = (over: Partial<BillingSchedule> = {}): BillingSchedule => ({
    tenantId: 't-sre',
    planId: 'standard',
    cadence: 'monthly',
    amountMinor: 900_000,
    anchorDay: 5,
    startsOn: '2026-09-05',
    preDebitNoticeHours: 24,
    ...over,
  });

  it('finds the next anchor day on or after today', () => {
    const c = nextCharge({ schedule: schedule(), asAt: '2026-09-20' });
    expect(c.chargeOn).toBe('2026-10-05');
  });

  it('charges this month when the anchor day has not yet passed', () => {
    const c = nextCharge({ schedule: schedule(), asAt: '2026-09-02' });
    expect(c.chargeOn).toBe('2026-09-05');
  });

  it('never debits before the schedule starts', () => {
    const c = nextCharge({ schedule: schedule({ startsOn: '2026-11-05' }), asAt: '2026-09-01' });
    expect(c.chargeOn).toBe('2026-11-05');
  });

  it('sets the notify-by deadline the required hours before the debit', () => {
    const c = nextCharge({ schedule: schedule({ preDebitNoticeHours: 24 }), asAt: '2026-09-02' });
    // 24h before 2026-09-05T00:00:00Z
    expect(c.notifyBy).toBe('2026-09-04T00:00:00.000Z');
  });

  it('refuses an anchor day a short month could not have', () => {
    expect(() => nextCharge({ schedule: schedule({ anchorDay: 31 }), asAt: '2026-09-01' })).toThrow(/1.28/);
  });
});

describe('a GST tax invoice splits the tax correctly and to the paisa', () => {
  const seller = { gstin: '33ABCDE1234F1Z5', name: 'SRE Retail OS' }; // 33 = Tamil Nadu
  const buyerTN = { gstin: '33ZYXWV9876G1Z2', name: 'A TN shop' };
  const buyerKA = { gstin: '29ZYXWV9876G1Z2', name: 'A Karnataka shop' }; // 29 = Karnataka

  it('same-state supply is CGST + SGST', () => {
    const inv = computeTaxInvoice({
      invoiceNumber: 'INV-000001', issuedOn: '2026-10-05',
      seller, buyer: buyerTN, taxableValueMinor: 900_000, gstRateBps: 1800, sacCode: '997331',
    });
    expect(inv.supply).toBe('intra_state');
    expect(inv.taxLines.map((l) => l.label)).toEqual(['CGST', 'SGST']);
    expect(inv.totalTaxMinor).toBe(162_000); // 18% of 9,00,000 paise
    // The two halves sum to the exact total — no paisa lost between the lines.
    expect(inv.taxLines[0]!.amountMinor + inv.taxLines[1]!.amountMinor).toBe(inv.totalTaxMinor);
    expect(inv.totalMinor).toBe(1_062_000);
  });

  it('across-state supply is a single IGST at the full rate', () => {
    const inv = computeTaxInvoice({
      invoiceNumber: 'INV-000002', issuedOn: '2026-10-05',
      seller, buyer: buyerKA, taxableValueMinor: 900_000, gstRateBps: 1800, sacCode: '997331',
    });
    expect(inv.supply).toBe('inter_state');
    expect(inv.taxLines.map((l) => l.label)).toEqual(['IGST']);
    expect(inv.taxLines[0]!.amountMinor).toBe(162_000);
  });

  it('splits an odd amount without losing or gaining a paisa', () => {
    const inv = computeTaxInvoice({
      invoiceNumber: 'INV-000003', issuedOn: '2026-10-05',
      seller, buyer: buyerTN, taxableValueMinor: 100_001, gstRateBps: 1800, sacCode: '997331',
    });
    // 18% of 1,00,001 = 18000.18 → rounds to 18000; CGST 9000, SGST 9000.
    expect(inv.taxLines[0]!.amountMinor + inv.taxLines[1]!.amountMinor).toBe(inv.totalTaxMinor);
  });

  it('refuses an invalid GSTIN — a tax invoice must be filable', () => {
    expect(() =>
      computeTaxInvoice({
        invoiceNumber: 'INV-x', issuedOn: '2026-10-05',
        seller: { gstin: 'not-a-gstin', name: 'x' }, buyer: buyerTN,
        taxableValueMinor: 900_000, gstRateBps: 1800, sacCode: '997331',
      }),
    ).toThrow(/GSTIN/);
  });
});

describe('dunning handles a failed debit and NEVER stops the shop trading (P-01, hard rule #1)', () => {
  const policy: DunningPolicy = { maxRetries: 3, suspendableGrants: ['loyalty', 'delivery'] };

  it('starts current and paid up', () => {
    const s = startDunning('t-sre');
    expect(s.state).toBe('current');
    expect(s.mayContinueTrading).toBe(true);
  });

  it('retries automatically for the first failures, switching nothing off', () => {
    let s = startDunning('t-sre');
    s = onChargeResult({ previous: s, outcome: 'failed', policy });
    expect(s.state).toBe('retrying');
    expect(s.failedAttempts).toBe(1);
    expect(s.suspendedGrants).toEqual([]);
    expect(s.mayContinueTrading).toBe(true);
  });

  it('escalates to a person after retries are exhausted, features still ON (grace)', () => {
    let s = startDunning('t-sre');
    for (let i = 0; i < 4; i += 1) s = onChargeResult({ previous: s, outcome: 'failed', policy });
    expect(s.state).toBe('past_due');
    expect(s.suspendedGrants).toEqual([]);
    expect(s.mayContinueTrading).toBe(true);
  });

  it('suspends only OPTIONAL features once genuinely delinquent — the POS keeps working', () => {
    let s = startDunning('t-sre');
    for (let i = 0; i < 5; i += 1) s = onChargeResult({ previous: s, outcome: 'failed', policy });
    expect(s.state).toBe('suspended');
    expect(s.suspendedGrants).toEqual(['loyalty', 'delivery']);
    // The invariant that matters: never, at any rung, does trading stop.
    expect(s.mayContinueTrading).toBe(true);
  });

  it('restores everything the moment a debit succeeds', () => {
    let s = startDunning('t-sre');
    for (let i = 0; i < 5; i += 1) s = onChargeResult({ previous: s, outcome: 'failed', policy });
    expect(s.suspendedGrants.length).toBeGreaterThan(0);
    s = onChargeResult({ previous: s, outcome: 'succeeded', policy });
    expect(s.state).toBe('current');
    expect(s.failedAttempts).toBe(0);
    expect(s.suspendedGrants).toEqual([]);
  });

  it('exposes NO function that could suspend trading', () => {
    const named = Object.keys(platform);
    expect(named).not.toContain('suspendTrading');
    expect(named).not.toContain('enforceLimit');
    expect(named).not.toContain('lockTenant');
  });
});
