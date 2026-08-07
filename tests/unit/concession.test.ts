import { describe, it, expect } from 'vitest';
import * as concession from '../../packages/concession/src/index';
import {
  valueOwnStock,
  checkStockAccess,
  computePeriodCharge,
  settleConcession,
  mayConcessionTrade,
  depositPosition,
  type ConcessionContract,
  type OwnedLot,
  type ConcessionSale,
  type DepositMovement,
} from '../../packages/concession/src/concession';

// M27-FR-01..04 acceptance: "revenue-share computes exactly; a deposit reconciles as a
// liability; concession stock is EXCLUDED from the store's valuation and only the
// concessionaire accesses it; a concession sale attributes and reconciles at settlement;
// a lapsed agreement blocks new sales."

const contract = (over: Partial<ConcessionContract>): ConcessionContract => ({
  contractId: 'k-1',
  tenantId: 't-sre',
  branchId: 'b-main',
  concessionaireId: 'cc-jeweller',
  name: 'Sri Lakshmi Jewellers',
  startsOn: '2026-01-01',
  endsOn: '2026-12-31',
  basis: 'higher_of_both',
  fixedRentMinor: 5_000_000,
  revenueShareBps: 800,
  depositMinor: 20_000_000,
  utilitiesMinor: 400_000,
  insuranceUntil: '2027-03-31',
  licenceUntil: '2027-06-30',
  approvedBy: 'u-owner',
  active: true,
  ...over,
});

const lot = (over: Partial<OwnedLot>): OwnedLot => ({
  lotId: 'lot-1', productId: 'p-rice', branchId: 'b-main',
  qty: 100, unitCostMinor: 4_000, ownership: 'own', ...over,
});

describe('concession stock is EXCLUDED from the store\'s valuation (M27-FR-02)', () => {
  const LOTS = [
    lot({}),
    lot({ lotId: 'lot-2', qty: 50, unitCostMinor: 6_000 }),
    lot({ lotId: 'lot-gold', productId: 'p-gold', qty: 1, unitCostMinor: 400_000_000, ownership: 'concession', ownerId: 'cc-jeweller' }),
    lot({ lotId: 'lot-consign', productId: 'p-phone', qty: 20, unitCostMinor: 1_500_000, ownership: 'consignment', ownerId: 'sup-phones' }),
  ];

  it('values only what the store owns, and NAMES what it left out', () => {
    const result = valueOwnStock({ branchId: 'b-main', lots: LOTS });
    // 100 × 4,000 + 50 × 6,000 = 700,000. The gold is NOT in it.
    expect(result.ownedValueMinor).toBe(700_000);
    expect(result.excludedValueMinor).toBe(400_000_000 + 30_000_000);
    expect(result.excluded.map((e) => e.ownerId).sort()).toEqual(['cc-jeweller', 'sup-phones']);
    expect(result.detail).toContain('the insurance schedule and the tax position');
  });

  it('does not quietly drop the exclusion — an unexplained gap is its own trouble', () => {
    const result = valueOwnStock({ branchId: 'b-main', lots: LOTS });
    const gold = result.excluded.find((e) => e.ownerId === 'cc-jeweller');
    expect(gold?.ownership).toBe('concession');
    expect(gold?.valueMinor).toBe(400_000_000);
  });

  it('values a branch with only its own stock cleanly', () => {
    const result = valueOwnStock({ branchId: 'b-main', lots: [lot({})] });
    expect(result.excludedValueMinor).toBe(0);
    expect(result.detail).toContain('all owned by the store');
  });

  it('ignores another branch entirely', () => {
    expect(valueOwnStock({ branchId: 'b-other', lots: LOTS }).ownedValueMinor).toBe(0);
  });
});

describe('access to somebody else\'s stock is restricted (M27-FR-02, P-04)', () => {
  const GOLD = lot({ lotId: 'lot-gold', ownership: 'concession', ownerId: 'cc-jeweller' });

  it('lets the concessionaire handle their own stock', () => {
    const decision = checkStockAccess({
      lot: GOLD, actorId: 'u-lakshmi', actorKind: 'concessionaire',
      concessionaireId: 'cc-jeweller', action: 'adjust',
    });
    expect(decision.allowed).toBe(true);
  });

  it('REFUSES one concessionaire reaching another\'s stock, and records it', () => {
    const decision = checkStockAccess({
      lot: GOLD, actorId: 'u-phones', actorKind: 'concessionaire',
      concessionaireId: 'sup-phones', action: 'view',
    });
    expect(decision.outcome).toBe('not_your_stock');
    expect(decision.securityEvent).toBe(true);
  });

  it('refuses a concessionaire touching the STORE\'S stock', () => {
    const decision = checkStockAccess({
      lot: lot({}), actorId: 'u-lakshmi', actorKind: 'concessionaire',
      concessionaireId: 'cc-jeweller', action: 'sell',
    });
    expect(decision.outcome).toBe('not_your_stock');
  });

  it('REFUSES store staff writing off stock the store does not own', () => {
    const decision = checkStockAccess({
      lot: GOLD, actorId: 'u-manager', actorKind: 'store_staff', action: 'write_off',
    });
    expect(decision.allowed).toBe(false);
    expect(decision.outcome).toBe('not_permitted');
    expect(decision.detail).toContain('a bill we cannot argue with');
  });

  it('lets store staff SEE it, so the shelf makes sense', () => {
    expect(checkStockAccess({ lot: GOLD, actorId: 'u-manager', actorKind: 'store_staff', action: 'view' }).allowed).toBe(true);
  });

  it('lets store staff sell it only where the contract says so', () => {
    expect(checkStockAccess({ lot: GOLD, actorId: 'u-till', actorKind: 'store_staff', action: 'sell' }).allowed).toBe(false);
    const onBehalf = checkStockAccess({
      lot: GOLD, actorId: 'u-till', actorKind: 'store_staff', action: 'sell', storeSellsOnBehalf: true,
    });
    expect(onBehalf.allowed).toBe(true);
    expect(onBehalf.detail).toContain('the money is theirs, less our share');
  });

  it('lets store staff do anything with the store\'s own stock', () => {
    expect(checkStockAccess({ lot: lot({}), actorId: 'u-manager', actorKind: 'store_staff', action: 'write_off' }).allowed).toBe(true);
  });
});

const sale = (over: Partial<ConcessionSale>): ConcessionSale => ({
  saleId: 's-1', contractId: 'k-1', concessionaireId: 'cc-jeweller', branchId: 'b-main',
  at: '2026-07-05T11:00:00Z', grossMinor: 30_000_000, taxMinor: 900_000,
  tenderedTo: 'store_till', ...over,
});

const SALES = [
  sale({}),
  sale({ saleId: 's-2', at: '2026-07-18T15:00:00Z', grossMinor: 45_000_000 }),
  sale({ saleId: 's-3', at: '2026-07-20T16:00:00Z', grossMinor: -5_000_000, refundOf: 's-1' }),
  // Outside the window.
  sale({ saleId: 's-4', at: '2026-08-02T10:00:00Z', grossMinor: 90_000_000 }),
];

describe('rent and revenue share compute exactly (M27-FR-01, §29.1)', () => {
  const period = { from: '2026-07-01', to: '2026-07-31' };

  it('takes the HIGHER of rent and revenue share, never the sum', () => {
    const charge = computePeriodCharge({ contract: contract({}), sales: SALES, ...period });
    // 30,000,000 + 45,000,000 − 5,000,000 = 70,000,000 × 8% = 5,600,000 > 5,000,000 rent
    expect(charge.grossSalesMinor).toBe(70_000_000);
    expect(charge.revenueShareMinor).toBe(5_600_000);
    expect(charge.chargeMinor).toBe(5_600_000);
    expect(charge.chargeMinor).not.toBe(charge.fixedRentMinor + charge.revenueShareMinor);
    expect(charge.detail).toContain('the HIGHER of the two applies, not the sum');
  });

  it('a refund reduces the base — the concessionaire would find it otherwise', () => {
    const withoutRefund = computePeriodCharge({
      contract: contract({}), sales: SALES.filter((s) => s.refundOf === undefined), ...period,
    });
    expect(withoutRefund.grossSalesMinor).toBe(75_000_000);
    expect(withoutRefund.revenueShareMinor).toBe(6_000_000);
  });

  it('falls back to rent when the share is smaller', () => {
    const charge = computePeriodCharge({
      contract: contract({ revenueShareBps: 100 }), sales: SALES, ...period,
    });
    expect(charge.chargeMinor).toBe(5_000_000);
  });

  it('charges rent alone on a fixed-rent contract', () => {
    const charge = computePeriodCharge({ contract: contract({ basis: 'fixed_rent' }), sales: SALES, ...period });
    expect(charge.chargeMinor).toBe(5_000_000);
    expect(charge.totalDueMinor).toBe(5_400_000);
  });

  it('lets metered utilities override the flat figure', () => {
    const charge = computePeriodCharge({
      contract: contract({}), sales: SALES, meteredUtilitiesMinor: 712_300, ...period,
    });
    expect(charge.utilitiesMinor).toBe(712_300);
  });
});

describe('the money a concession sale takes is NOT the shop\'s revenue (M27-FR-03)', () => {
  const charge = computePeriodCharge({
    contract: contract({}), sales: SALES, from: '2026-07-01', to: '2026-07-31',
  });

  it('holds it as a liability and pays out the balance', () => {
    const statement = settleConcession({
      contract: contract({}), charge, sales: SALES, bankedForThemMinor: 70_000_000,
    });
    expect(statement.collectedForThemMinor).toBe(70_000_000);
    // 70,000,000 − (5,600,000 + 400,000) = 64,000,000
    expect(statement.payableToThemMinor).toBe(64_000_000);
    expect(statement.reconciles).toBe(true);
  });

  it('calls a banking difference a VALUED exception, not a rounding note', () => {
    const statement = settleConcession({
      contract: contract({}), charge, sales: SALES, bankedForThemMinor: 69_500_000,
    });
    expect(statement.reconciles).toBe(false);
    expect(statement.differenceMinor).toBe(500_000);
    expect(statement.detail).toContain('not a rounding note');
  });

  it('does NOT net the deposit against what they owe us', () => {
    const quiet = computePeriodCharge({
      contract: contract({}), sales: [], from: '2026-07-01', to: '2026-07-31',
    });
    const statement = settleConcession({
      contract: contract({}), charge: quiet, sales: [], bankedForThemMinor: 0,
    });
    expect(statement.payableToThemMinor).toBeLessThan(0);
    expect(statement.depositHeldMinor).toBe(20_000_000);
    expect(statement.detail).toContain('is NOT netted against it');
  });

  it('counts only what the STORE\'S tills took — their own till is their own money', () => {
    const ownTill = SALES.map((s) => ({ ...s, tenderedTo: 'concessionaire_till' as const }));
    const statement = settleConcession({
      contract: contract({}), charge, sales: ownTill, bankedForThemMinor: 0,
    });
    expect(statement.collectedForThemMinor).toBe(0);
  });
});

describe('a lapsed agreement or insurance blocks new sales (M27-FR-04)', () => {
  it('lets a compliant counter trade', () => {
    const decision = mayConcessionTrade({ contract: contract({}), today: '2026-08-04' });
    expect(decision.mayTrade).toBe(true);
    expect(decision.blockedBy).toEqual([]);
  });

  it('BLOCKS on lapsed insurance and names whose exposure it is', () => {
    const decision = mayConcessionTrade({
      contract: contract({ insuranceUntil: '2026-06-30' }), today: '2026-08-04',
    });
    expect(decision.mayTrade).toBe(false);
    expect(decision.blockedBy).toContain('insurance_lapsed');
    expect(decision.detail).toContain('your exposure, not theirs');
  });

  it('reports EVERY blocker at once, not one at a time', () => {
    const decision = mayConcessionTrade({
      contract: contract({ endsOn: '2026-06-30', insuranceUntil: '2026-05-01', licenceUntil: '2026-04-01', approvedBy: undefined }),
      today: '2026-08-04',
    });
    expect([...decision.blockedBy].sort()).toEqual([
      'contract_expired', 'insurance_lapsed', 'licence_lapsed', 'not_approved',
    ]);
  });

  it('blocks a contract nobody approved', () => {
    expect(mayConcessionTrade({ contract: contract({ approvedBy: undefined }), today: '2026-08-04' }).blockedBy)
      .toContain('not_approved');
  });

  it('blocks before the start date', () => {
    expect(mayConcessionTrade({ contract: contract({}), today: '2025-12-01' }).blockedBy)
      .toContain('contract_not_started');
  });

  it('warns ahead of an expiry while still letting them trade', () => {
    const decision = mayConcessionTrade({
      contract: contract({ insuranceUntil: '2026-08-20' }), today: '2026-08-04',
    });
    expect(decision.mayTrade).toBe(true);
    expect(decision.warnings[0]).toContain('insurance runs out in 16 day(s)');
  });
});

describe('a deposit is a LIABILITY, never rent received (M27-FR-01)', () => {
  const movement = (over: Partial<DepositMovement>): DepositMovement => ({
    movementId: 'dm-1', concessionaireId: 'cc-jeweller', kind: 'received',
    amountMinor: 20_000_000, at: '2026-01-01T00:00:00Z', ...over,
  });

  it('projects the outstanding liability from movements, never a stored balance', () => {
    const position = depositPosition({
      concessionaireId: 'cc-jeweller',
      movements: [movement({}), movement({ movementId: 'dm-2', kind: 'refunded', amountMinor: 5_000_000 })],
    });
    expect(position.outstandingLiabilityMinor).toBe(15_000_000);
    expect(position.detail).toContain('not rent received');
  });

  it('does NOT let an unapproved forfeit reduce the liability', () => {
    const position = depositPosition({
      concessionaireId: 'cc-jeweller',
      movements: [movement({}), movement({ movementId: 'dm-3', kind: 'forfeited', amountMinor: 8_000_000 })],
    });
    expect(position.forfeitedMinor).toBe(0);
    expect(position.outstandingLiabilityMinor).toBe(20_000_000);
    expect(position.detail).toContain("nobody's name on them");
  });

  it('honours an approved forfeit', () => {
    const position = depositPosition({
      concessionaireId: 'cc-jeweller',
      movements: [movement({}), movement({ movementId: 'dm-4', kind: 'forfeited', amountMinor: 8_000_000, approvedBy: 'u-owner' })],
    });
    expect(position.outstandingLiabilityMinor).toBe(12_000_000);
  });

  it('exposes NO function that could set a deposit balance directly', () => {
    // Absence as a control: the liability is projected, and there is no setter to reach for.
    const named = Object.keys(concession);
    expect(named).not.toContain('setDepositBalance');
    expect(named).not.toContain('recogniseDepositAsIncome');
  });
});
