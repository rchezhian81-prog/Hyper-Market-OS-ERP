// One shop, one month, six witnesses — the SAME known-good evidence the OB-06 gate test uses
// (`tests/integration/every-figure-has-a-witness.test.ts`), shared so the routes are proved against
// figures that are known to tie together: gross takings = taxable + tax; the signed accounts carry the
// counted stock and the confirmed creditors. Synthetic, demo-marked names throughout.

import type { StockLine } from '../../packages/migration/src/count-verification';
import { balanceOf, type LedgerItem } from '../../packages/migration/src/supplier-reconciliation';
import { expectedCredit, type RouteTerms, type DailyTakings, type BankCredit } from '../../packages/migration/src/banking-verification';
import { taxOf, type TaxSlabLine, type FiledReturn } from '../../packages/migration/src/tax-verification';
import type { TrialBalanceLine, SignedAccounts } from '../../packages/migration/src/books-verification';
import type { LoyaltyBalance } from '../../packages/migration/src/loyalty-verification';

export const STOCK: readonly StockLine[] = [
  { lineId: 'L001', productId: 'P001', description: 'Ghee 1L (demo)', extractedQty: 200, extractedValueMinor: 1_280_000 },
  { lineId: 'L002', productId: 'P002', description: 'Sunflower oil 5L (demo)', extractedQty: 300, extractedValueMinor: 900_000 },
  { lineId: 'L003', productId: 'P003', description: 'Ponni rice 25kg (demo)', extractedQty: 150, extractedValueMinor: 600_000 },
  { lineId: 'L004', productId: 'P004', description: 'Toor dal 5kg (demo)', extractedQty: 100, extractedValueMinor: 300_000 },
  ...Array.from({ length: 60 }, (_, i) => ({
    lineId: `T${String(i + 1).padStart(3, '0')}`, productId: `P${String(i + 100).padStart(3, '0')}`,
    description: `Tail line ${i + 1} (demo)`, extractedQty: 20 + i, extractedValueMinor: 32_000,
  })),
];
export const STOCK_VALUE = STOCK.reduce((t, l) => t + l.extractedValueMinor, 0);

export const SUPPLIER_ITEMS: Readonly<Record<string, readonly LedgerItem[]>> = {
  'SUP-A': [{ documentNumber: 'A-9001', kind: 'invoice', amountMinor: 1_500_000, documentDate: '2026-03-12' }],
  'SUP-V': [{ documentNumber: 'V-4410', kind: 'invoice', amountMinor: 1_000_000, documentDate: '2026-03-18' }],
  'SUP-K': [{ documentNumber: 'K-7782', kind: 'invoice', amountMinor: 500_000, documentDate: '2026-03-25' }],
};
export const CREDITORS = Object.values(SUPPLIER_ITEMS).reduce((t, items) => t + balanceOf(items), 0);

const slab = (rateBps: number, taxableValueMinor: number): TaxSlabLine => {
  const half = Math.round((taxableValueMinor * rateBps) / 20_000);
  return { rateBps, taxableValueMinor, cgstMinor: half, sgstMinor: half, igstMinor: 0, cessMinor: 0 };
};
export const SLABS: readonly TaxSlabLine[] = [slab(0, 4_000_000), slab(500, 2_000_000), slab(1_200, 800_000), slab(1_800, 500_000)];
export const TAXABLE = SLABS.reduce((t, l) => t + l.taxableValueMinor, 0);
export const TAX_DUE = SLABS.reduce((t, l) => t + taxOf(l), 0);
export const GSTR1: FiledReturn = { period: '2026-03', kind: 'gstr1', gstin: '33AABCS1429B1ZQ', filedOn: '2026-04-11', acknowledgementRef: 'AA330326012345X', lines: SLABS };
export const GSTR3B: FiledReturn = { ...GSTR1, kind: 'gstr3b', acknowledgementRef: 'AB330326099999Y', filedOn: '2026-04-20' };

export const TAKINGS: readonly DailyTakings[] = [
  { businessDate: '2026-03-01', tender: 'cash', grossMinor: 800_000 }, { businessDate: '2026-03-01', tender: 'card', grossMinor: 900_000 }, { businessDate: '2026-03-01', tender: 'upi', grossMinor: 400_000 },
  { businessDate: '2026-03-02', tender: 'cash', grossMinor: 700_000 }, { businessDate: '2026-03-02', tender: 'card', grossMinor: 800_000 }, { businessDate: '2026-03-02', tender: 'upi', grossMinor: 300_000 },
  { businessDate: '2026-03-03', tender: 'cash', grossMinor: 600_000 }, { businessDate: '2026-03-03', tender: 'card', grossMinor: 700_000 }, { businessDate: '2026-03-03', tender: 'upi', grossMinor: 400_000 },
  { businessDate: '2026-03-04', tender: 'cash', grossMinor: 686_000 }, { businessDate: '2026-03-04', tender: 'card', grossMinor: 900_000 }, { businessDate: '2026-03-04', tender: 'upi', grossMinor: 400_000 },
];
export const GROSS = TAKINGS.reduce((t, x) => t + x.grossMinor, 0);
export const TERMS: readonly RouteTerms[] = [
  { tender: 'cash', commissionBps: 0, gstOnCommissionBps: 0, settlementLagDays: 2, toleranceDays: 1, source: 'bank_confirmation' },
  { tender: 'card', commissionBps: 150, gstOnCommissionBps: 1_800, settlementLagDays: 1, toleranceDays: 1, source: 'merchant_agreement' },
  { tender: 'upi', commissionBps: 0, gstOnCommissionBps: 0, settlementLagDays: 1, toleranceDays: 1, source: 'provider_advice' },
];
const termsFor = (t: 'cash' | 'card' | 'upi'): RouteTerms => TERMS.find((x) => x.tender === t)!;
export const CREDITS: readonly BankCredit[] = [
  ...TAKINGS.filter((t) => t.tender !== 'cash').map((t, i) => ({
    lineId: `B${i + 1}`, valueDate: `2026-03-0${Number(t.businessDate.slice(-2)) + 1}`,
    amountMinor: expectedCredit(t.grossMinor, termsFor(t.tender as 'card' | 'upi')).creditMinor,
    narrative: t.tender === 'card' ? 'MERCHANT SETTLE (demo)' : 'UPI SETTLEMENT (demo)', attributedTo: t.tender,
  })),
  { lineId: 'B90', valueDate: '2026-03-06', amountMinor: TAKINGS.filter((t) => t.tender === 'cash').reduce((s, t) => s + t.grossMinor, 0), narrative: 'CASH DEP (demo)', attributedTo: 'cash' },
];
export const BANK_BODY = { periodStart: '2026-03-01', periodEnd: '2026-03-04', statementPeriod: { from: '2026-03-01', to: '2026-03-31' }, takings: TAKINGS, credits: CREDITS, terms: TERMS };

const dr = (accountCode: string, accountName: string, nature: TrialBalanceLine['nature'], debitMinor: number): TrialBalanceLine => ({ accountCode, accountName, nature, debitMinor, creditMinor: 0 });
const cr = (accountCode: string, accountName: string, nature: TrialBalanceLine['nature'], creditMinor: number): TrialBalanceLine => ({ accountCode, accountName, nature, debitMinor: 0, creditMinor });
export const TB: readonly TrialBalanceLine[] = [
  dr('1000', 'Stock on hand', 'asset', STOCK_VALUE), dr('1100', 'Trade debtors', 'asset', 800_000), dr('1200', 'Bank current account', 'asset', 1_200_000),
  dr('1300', 'Cash in hand', 'asset', 150_000), dr('1400', 'Prepayments', 'asset', 100_000), dr('1500', 'Fixtures net of depreciation', 'asset', 2_000_000),
  { ...dr('3100', 'Drawings', 'equity', 300_000), contra: true },
  cr('2000', 'Trade creditors', 'liability', CREDITORS), cr('2100', 'GST payable', 'liability', TAX_DUE), cr('2200', 'Provision for audit fee', 'liability', 100_000),
  cr('3000', "Proprietor's capital", 'equity', STOCK_VALUE + 800_000 + 1_200_000 + 150_000 + 100_000 + 2_000_000 + 300_000 - CREDITORS - TAX_DUE - 100_000),
];
export const CA_ONLY = ['1400', '1500', '2200', '3100'];
export const ACCOUNTS: SignedAccounts = { entity: 'Demo Hyper Market', periodEnd: '2026-03-31', preparedBy: 'Demo & Co', signedOn: '2026-07-18', membershipNumber: 'ICAI-000000', lines: TB };

export const LOYALTY: readonly LoyaltyBalance[] = [
  { customerId: 'C001', customerName: 'Customer A (demo)', pointsBalance: 12_000, tier: 'gold' },
  { customerId: 'C002', customerName: 'Customer B (demo)', pointsBalance: 9_400, tier: 'gold' },
  { customerId: 'C003', customerName: 'Customer C (demo)', pointsBalance: 5_100, tier: 'silver' },
  ...Array.from({ length: 20 }, (_, i) => ({ customerId: `C${String(i + 100).padStart(3, '0')}`, customerName: `Customer ${i + 1} (demo)`, pointsBalance: 300 + i * 40 })),
];
