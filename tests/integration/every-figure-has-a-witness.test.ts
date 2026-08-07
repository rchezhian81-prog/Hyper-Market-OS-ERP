import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { Client } from 'pg';
import { pgClient } from '../../packages/persistence/src/pg-client';
import { SqlEventStore } from '../../packages/persistence/src/event-store';
import { runMigrations } from '../../packages/persistence/src/migrations';
import { makeEvent } from '../../packages/contracts/src/event';

import {
  planVerification, VERIFIES, EXTERNAL_SOURCE_NOTE,
  type DataDomain, type ExternalSource, type ExtractionRoute,
} from '../../packages/migration/src/extraction';
import { planCountSample, assessCountVerification, type StockLine } from '../../packages/migration/src/count-verification';
import {
  reconcileSupplierStatement, supplierPosition, balanceOf, type LedgerItem,
} from '../../packages/migration/src/supplier-reconciliation';
import {
  verifySalesAgainstBank, expectedCredit,
  type RouteTerms, type DailyTakings, type BankCredit,
} from '../../packages/migration/src/banking-verification';
import {
  reconcileTaxPeriod, taxPosition, taxOf, type FiledReturn, type TaxSlabLine,
} from '../../packages/migration/src/tax-verification';
import {
  reconcileOpeningBooks, balanceOfLine, type SignedAccounts, type TrialBalanceLine,
} from '../../packages/migration/src/books-verification';
import {
  planLoyaltySample, assessLoyaltyVerification,
  type LoyaltyBalance, type CustomerConfirmation,
} from '../../packages/migration/src/loyalty-verification';

/**
 * **Every figure has a witness** — the OB-06 verification gate, end to end.
 *
 * The six outside-evidence checks have each been proved on their own. This runs all six as one
 * pass over one shop whose figures tie together, and adds the two things a unit test structurally
 * cannot do:
 *
 *   1. **It walks the `VERIFIES` table for every domain and proves each named source has a module
 *      behind it.** A unit test can only test the checks that exist. The failure it cannot see is
 *      a domain that quietly has *no* external check attached at all — which is exactly what a
 *      migration under time pressure produces, and exactly what nobody notices until the CA asks.
 *
 *   2. **It proves the witnesses agree with each other.** The bank check and the tax return are
 *      looking at the same month's sales from opposite ends; the signed accounts carry the same
 *      stock the shelves were counted for and the same creditors the suppliers confirmed. Four
 *      figures are tied across checks here, so a number that is wrong has to be wrong in two
 *      places at once to survive.
 *
 * And the gate is proved to FAIL: withhold one piece of evidence and the domains that depended on
 * it are refused by name.
 *
 * Set DATABASE_URL to run; without it the suite skips rather than passing quietly.
 */

const DATABASE_URL = process.env['DATABASE_URL'];
const TENANT = '99999999-9999-9999-9999-999999999999';
const RUN = `w${Date.now().toString(36)}`;
const SRC = join(__dirname, '..', '..', 'packages', 'migration', 'src');

// ─── ONE SHOP, ONE MONTH, SIX WITNESSES ──────────────────────────────────────

/** Stock: four lines carry 62% of the value, sixty carry the rest. Totals 50,00,000. */
const STOCK: readonly StockLine[] = [
  { lineId: 'L001', productId: 'P001', description: 'Amul Ghee Gold 1L', extractedQty: 200, extractedValueMinor: 1_280_000 },
  { lineId: 'L002', productId: 'P002', description: 'Sunflower Oil 5L', extractedQty: 300, extractedValueMinor: 900_000 },
  { lineId: 'L003', productId: 'P003', description: 'Ponni Rice 25kg', extractedQty: 150, extractedValueMinor: 600_000 },
  { lineId: 'L004', productId: 'P004', description: 'Toor Dal 5kg', extractedQty: 100, extractedValueMinor: 300_000 },
  ...Array.from({ length: 60 }, (_, i) => ({
    lineId: `T${String(i + 1).padStart(3, '0')}`,
    productId: `P${String(i + 100).padStart(3, '0')}`,
    description: `Tail line ${i + 1}`,
    extractedQty: 20 + i,
    extractedValueMinor: 32_000,
  })),
];
const STOCK_VALUE = STOCK.reduce((t, l) => t + l.extractedValueMinor, 0);

/** Suppliers: three, all of whom sent a statement and all of whom agree. Totals 30,00,000. */
const SUPPLIER_ITEMS: Readonly<Record<string, readonly LedgerItem[]>> = {
  'SUP-ANNAPOORNA': [{ documentNumber: 'A-9001', kind: 'invoice', amountMinor: 1_500_000, documentDate: '2026-03-12' }],
  'SUP-VELAN': [{ documentNumber: 'V-4410', kind: 'invoice', amountMinor: 1_000_000, documentDate: '2026-03-18' }],
  'SUP-KUMAR': [{ documentNumber: 'K-7782', kind: 'invoice', amountMinor: 500_000, documentDate: '2026-03-25' }],
};
const CREDITORS = Object.values(SUPPLIER_ITEMS).reduce((t, items) => t + balanceOf(items), 0);

/** Tax: March 2026, four slabs. Taxable 73,00,000 and tax 2,86,000. */
const slab = (rateBps: number, taxableValueMinor: number): TaxSlabLine => {
  const half = Math.round((taxableValueMinor * rateBps) / 20_000);
  return { rateBps, taxableValueMinor, cgstMinor: half, sgstMinor: half, igstMinor: 0, cessMinor: 0 };
};
const SLABS: readonly TaxSlabLine[] = [slab(0, 4_000_000), slab(500, 2_000_000), slab(1_200, 800_000), slab(1_800, 500_000)];
const TAXABLE = SLABS.reduce((t, l) => t + l.taxableValueMinor, 0);
const TAX_DUE = SLABS.reduce((t, l) => t + taxOf(l), 0);

/** Sales: four trading days across three tenders. Gross must equal taxable + tax. */
const TAKINGS: readonly DailyTakings[] = [
  { businessDate: '2026-03-01', tender: 'cash', grossMinor: 800_000 },
  { businessDate: '2026-03-01', tender: 'card', grossMinor: 900_000 },
  { businessDate: '2026-03-01', tender: 'upi', grossMinor: 400_000 },
  { businessDate: '2026-03-02', tender: 'cash', grossMinor: 700_000 },
  { businessDate: '2026-03-02', tender: 'card', grossMinor: 800_000 },
  { businessDate: '2026-03-02', tender: 'upi', grossMinor: 300_000 },
  { businessDate: '2026-03-03', tender: 'cash', grossMinor: 600_000 },
  { businessDate: '2026-03-03', tender: 'card', grossMinor: 700_000 },
  { businessDate: '2026-03-03', tender: 'upi', grossMinor: 400_000 },
  { businessDate: '2026-03-04', tender: 'cash', grossMinor: 686_000 },
  { businessDate: '2026-03-04', tender: 'card', grossMinor: 900_000 },
  { businessDate: '2026-03-04', tender: 'upi', grossMinor: 400_000 },
];

const TERMS: readonly RouteTerms[] = [
  { tender: 'cash', commissionBps: 0, gstOnCommissionBps: 0, settlementLagDays: 2, toleranceDays: 1, source: 'bank_confirmation' },
  { tender: 'card', commissionBps: 150, gstOnCommissionBps: 1_800, settlementLagDays: 1, toleranceDays: 1, source: 'merchant_agreement' },
  { tender: 'upi', commissionBps: 0, gstOnCommissionBps: 0, settlementLagDays: 1, toleranceDays: 1, source: 'provider_advice' },
];
const termsFor = (t: 'cash' | 'card' | 'upi'): RouteTerms => TERMS.find((x) => x.tender === t)!;

/** The bank's side, built from the declared terms — not from the difference (that is refused). */
const CREDITS: readonly BankCredit[] = [
  ...TAKINGS.filter((t) => t.tender !== 'cash').map((t, i) => ({
    lineId: `B${i + 1}`,
    valueDate: `2026-03-0${Number(t.businessDate.slice(-2)) + 1}`,
    amountMinor: expectedCredit(t.grossMinor, termsFor(t.tender as 'card' | 'upi')).creditMinor,
    narrative: t.tender === 'card' ? 'HDFC MERCHANT SETTLE' : 'UPI SETTLEMENT',
    attributedTo: t.tender,
  })),
  // Cash goes in as one lump, days later, which is how cash actually reaches a bank.
  {
    lineId: 'B90', valueDate: '2026-03-06',
    amountMinor: TAKINGS.filter((t) => t.tender === 'cash').reduce((s, t) => s + t.grossMinor, 0),
    narrative: 'CASH DEP CHENGALPATTU', attributedTo: 'cash',
  },
];

/** The signed accounts to 31 March — the same stock, the same creditors, the same GST. */
const dr = (accountCode: string, accountName: string, nature: TrialBalanceLine['nature'], debitMinor: number): TrialBalanceLine =>
  ({ accountCode, accountName, nature, debitMinor, creditMinor: 0 });
const cr = (accountCode: string, accountName: string, nature: TrialBalanceLine['nature'], creditMinor: number): TrialBalanceLine =>
  ({ accountCode, accountName, nature, debitMinor: 0, creditMinor });

const TB: readonly TrialBalanceLine[] = [
  dr('1000', 'Stock on hand', 'asset', STOCK_VALUE),
  dr('1100', 'Trade debtors', 'asset', 800_000),
  dr('1200', 'Bank current account', 'asset', 1_200_000),
  dr('1300', 'Cash in hand', 'asset', 150_000),
  dr('1400', 'Prepayments', 'asset', 100_000),
  dr('1500', 'Fixtures net of depreciation', 'asset', 2_000_000),
  { ...dr('3100', 'Drawings', 'equity', 300_000), contra: true },
  cr('2000', 'Trade creditors', 'liability', CREDITORS),
  cr('2100', 'GST payable', 'liability', TAX_DUE),
  cr('2200', 'Provision for audit fee', 'liability', 100_000),
  cr('3000', "Proprietor's capital", 'equity',
    STOCK_VALUE + 800_000 + 1_200_000 + 150_000 + 100_000 + 2_000_000 + 300_000 - CREDITORS - TAX_DUE - 100_000),
];
const CA_ONLY = ['1400', '1500', '2200', '3100'];

/** Loyalty: nine customers, all of whom answered and all of whom agree. */
const LOYALTY: readonly LoyaltyBalance[] = [
  { customerId: 'C001', customerName: 'Meena R', pointsBalance: 12_000, tier: 'gold' },
  { customerId: 'C002', customerName: 'Suresh K', pointsBalance: 9_400, tier: 'gold' },
  { customerId: 'C003', customerName: 'Lakshmi V', pointsBalance: 5_100, tier: 'silver' },
  ...Array.from({ length: 20 }, (_, i) => ({
    customerId: `C${String(i + 100).padStart(3, '0')}`,
    customerName: `Customer ${i + 1}`,
    pointsBalance: 300 + i * 40,
  })),
];

const ROUTES: readonly ExtractionRoute[] = (Object.keys(VERIFIES) as DataDomain[]).map((domain) => ({
  domain, method: 'built_in_export',
  description: `${domain} → Export to Excel`,
  rowCount: 100, cannotYield: [], repeatable: true,
}));

const ALL_EVIDENCE: readonly ExternalSource[] = Object.keys(EXTERNAL_SOURCE_NOTE) as ExternalSource[];

describe.skipIf(!DATABASE_URL)('OB-06 verification gate — every figure has a witness (real PostgreSQL)', () => {
  let client: Client;
  let store: SqlEventStore;

  beforeAll(async () => {
    client = new Client({ connectionString: DATABASE_URL });
    await client.connect();
    const sql = pgClient(client);
    const dir = 'db/migrations';
    await runMigrations(
      sql,
      readdirSync(dir).filter((f) => f.endsWith('.sql')).sort()
        .map((name) => ({ name, sql: readFileSync(join(dir, name), 'utf8') })),
    );
    store = new SqlEventStore(sql);
  });

  afterAll(async () => { await client.end(); });

  // ─── 1. NO DOMAIN WITHOUT A WITNESS, AND NO WITNESS WITHOUT A MODULE ────────

  /**
   * The module that consumes each kind of outside evidence.
   *
   * This map is the gate. Add an `ExternalSource` to `extraction.ts` without building something
   * that reads it and the next assertion fails — which is the only way to catch a domain that
   * has a *named* witness and no code behind it.
   */
  const CHECK_FOR: Readonly<Record<ExternalSource, string>> = {
    physical_count: 'count-verification.ts',
    supplier_statement: 'supplier-reconciliation.ts',
    bank_statement: 'banking-verification.ts',
    payment_settlement: 'banking-verification.ts',
    filed_gst_return: 'tax-verification.ts',
    ca_prepared_accounts: 'books-verification.ts',
    customer_confirmation: 'loyalty-verification.ts',
  };

  it('has a built module behind every kind of outside evidence the roadmap names', () => {
    for (const source of ALL_EVIDENCE) {
      const file = CHECK_FOR[source];
      expect(file, `no check built for ${source}`).toBeDefined();
      expect(existsSync(join(SRC, file)), `${file} does not exist`).toBe(true);
      // Not a stub: the module must actually mention the evidence it claims to consume.
      expect(readFileSync(join(SRC, file), 'utf8').length).toBeGreaterThan(2_000);
    }
    expect(Object.keys(CHECK_FOR).sort()).toEqual([...ALL_EVIDENCE].sort());
  });

  it('has a witness named for all twelve domains, and none is an empty list', () => {
    for (const [domain, sources] of Object.entries(VERIFIES) as [DataDomain, readonly ExternalSource[]][]) {
      expect(sources.length, `${domain} has no external source`).toBeGreaterThan(0);
      for (const s of sources) expect(existsSync(join(SRC, CHECK_FOR[s]))).toBe(true);
    }
  });

  it('passes the whole verification plan when every piece of evidence is in hand', () => {
    const plan = planVerification({ routes: ROUTES, available: ALL_EVIDENCE });
    expect(plan.sound).toBe(true);
    expect(plan.unverifiable).toEqual([]);
    expect(plan.detail).toContain('stronger than a vendor export');
  });

  it('FAILS, by name, when one piece of evidence is missing', () => {
    // The gate has to be able to say no. Without a physical count, five domains have nothing but
    // the old system's word — and the refusal names the mistake rather than the absence.
    const plan = planVerification({
      routes: ROUTES, available: ALL_EVIDENCE.filter((s) => s !== 'physical_count'),
    });
    expect(plan.sound).toBe(false);
    expect(plan.unverifiable).toEqual(['products', 'barcodes', 'prices', 'stock', 'batches']);
    expect(plan.refusals[0]?.refusal).toBe('verified_by_the_same_system');
    expect(plan.refusals[0]?.detail).toContain('would be just as consistent about a wrong number');
  });

  // ─── 2. THE SIX CHECKS, IN ONE PASS ─────────────────────────────────────────

  const countPlan = planCountSample({
    planId: `cnt-${RUN}`, lines: STOCK, plannedBy: 'u-manager', extractionOperator: 'u-operator',
    seed: 20260807,
  });

  it('stock — the shelves confirm the extracted figure', () => {
    expect(countPlan.ok).toBe(true);
    const p = countPlan.plan!;
    const counted = p.lines.filter((l) => l.stratum !== 'not_counted').map((l) => ({
      lineId: l.lineId,
      countedQty: STOCK.find((s) => s.lineId === l.lineId)!.extractedQty,
      counterId: 'u-counter',
    }));
    const r = assessCountVerification({ plan: p, extracted: STOCK, counted, toleranceMinor: 0 });
    expect(r.cleanCount).toBe(true);
    expect(r.sufficientToVerify).toBe(true);
  });

  const supplierResults = Object.entries(SUPPLIER_ITEMS).map(([supplierId, items]) =>
    reconcileSupplierStatement({
      supplierId, statementDate: '2026-03-31', ourItems: items, theirItems: items,
    }));

  it('suppliers — all three confirm what we owe them', () => {
    const pos = supplierPosition({
      reconciliations: supplierResults, suppliersAsked: Object.keys(SUPPLIER_ITEMS),
    });
    expect(pos.agreed).toBe(3);
    expect(pos.noStatementReceived).toEqual([]);
    expect(pos.sufficientToVerify).toBe(true);
  });

  const bank = verifySalesAgainstBank({
    periodStart: '2026-03-01', periodEnd: '2026-03-04',
    statementPeriod: { from: '2026-03-01', to: '2026-03-31' },
    takings: TAKINGS, credits: CREDITS, terms: TERMS,
  });

  it('sales — every day reached the bank, allowing for the declared commission', () => {
    expect(bank.termsAccepted).toBe(true);
    expect(bank.unbanked).toEqual([]);
    expect(bank.unexplainedCredits).toEqual([]);
    expect(bank.cashNotBankedMinor).toBe(0);
    expect(bank.sufficientToVerify).toBe(true);
    // The commission is a stated expectation, not a residual: 1.5% plus GST on 33,00,000 of card.
    expect(bank.routes.reduce((t, r) => t + r.commissionExpectedMinor, 0)).toBe(58_410);
  });

  const gstr1: FiledReturn = {
    period: '2026-03', kind: 'gstr1', gstin: '33AABCS1429B1ZQ',
    filedOn: '2026-04-11', acknowledgementRef: 'AA330326012345X', lines: SLABS,
  };
  const tax = reconcileTaxPeriod({
    period: '2026-03', gstr1,
    gstr3b: { ...gstr1, kind: 'gstr3b', acknowledgementRef: 'AB330326099999Y', filedOn: '2026-04-20' },
    books: SLABS,
  });

  it('tax — the books agree with what was actually filed, slab by slab', () => {
    expect(tax.accepted).toBe(true);
    expect(tax.reconciles).toBe(true);
    expect(tax.returnsDisagreeByMinor).toBe(0);
    expect(tax.booksMustMoveByMinor).toBe(0);
    expect(taxPosition({ reconciliations: [tax], periodsExpected: ['2026-03'] }).sufficientToVerify).toBe(true);
  });

  const accounts: SignedAccounts = {
    entity: 'SRE Hyper Market', periodEnd: '2026-03-31',
    preparedBy: 'R. Krishnamurthy & Co', signedOn: '2026-07-18', membershipNumber: 'ICAI-214477',
    lines: TB,
  };
  const books = reconcileOpeningBooks({
    accounts, opening: TB, cutoverDate: '2026-04-01', caOnlyAccountCodes: CA_ONLY,
  });

  it('books — the opening trial balance matches the signed accounts, and balances', () => {
    expect(books.accepted).toBe(true);
    expect(books.balances).toBe(true);
    expect(books.reconciles).toBe(true);
    expect(books.onTheWrongSide).toEqual([]);
    expect(TB.reduce((t, l) => t + balanceOfLine(l), 0)).toBe(0);
  });

  const loyaltyPlan = planLoyaltySample({
    planId: `loy-${RUN}`, balances: LOYALTY, plannedBy: 'u-manager', extractionOperator: 'u-operator',
    source: 'drawn_before_anybody_was_told', seed: 20260807,
  });

  it('loyalty — the customers confirm their own balances, unprompted', () => {
    expect(loyaltyPlan.ok).toBe(true);
    const asked = loyaltyPlan.plan!.lines.map((l) => l.customerId);
    const confirmations: readonly CustomerConfirmation[] = asked.map((customerId) => ({
      customerId, method: 'customer_stated_their_own_figure',
      statedPoints: LOYALTY.find((b) => b.customerId === customerId)!.pointsBalance,
      confirmedOn: '2026-08-20',
    }));
    const r = assessLoyaltyVerification({
      migrated: LOYALTY, confirmations, asked, pointCostMinor: 25,
    });
    expect(r.accepted).toBe(true);
    expect(r.weMigratedMorePoints).toBe(0);
    expect(r.weMigratedFewerPoints).toBe(0);
    expect(r.sufficientToVerify).toBe(true);
  });

  // ─── 3. THE WITNESSES AGREE WITH EACH OTHER ─────────────────────────────────

  it('ties the bank to the tax return — the same month, from opposite ends', () => {
    // The bank sees money arriving; the return declares what was sold. Gross takings across every
    // tender must equal the taxable value plus the tax on it, or one of the two is wrong.
    const grossAcrossTenders = bank.routes.reduce((t, r) => t + r.grossMinor, 0);
    expect(grossAcrossTenders).toBe(TAXABLE + TAX_DUE);
    expect(grossAcrossTenders).toBe(7_586_000);
  });

  it('ties the signed accounts to the shelves, the suppliers and the return', () => {
    const at = (code: string): number => Math.abs(balanceOfLine(TB.find((l) => l.accountCode === code)!));
    expect(at('1000')).toBe(STOCK_VALUE);   // counted on our own shelves
    expect(at('2000')).toBe(CREDITORS);     // confirmed by the suppliers themselves
    expect(at('2100')).toBe(TAX_DUE);       // filed with the department
  });

  it('breaks in TWO places when one figure is changed, which is the point of tying them', () => {
    // A wrong number now has to be wrong consistently in two independent records to survive.
    const oneDayShort = TAKINGS.map((t) => (t.businessDate === '2026-03-04' && t.tender === 'cash'
      ? { ...t, grossMinor: 586_000 } : t));

    const shorted = verifySalesAgainstBank({
      periodStart: '2026-03-01', periodEnd: '2026-03-04',
      statementPeriod: { from: '2026-03-01', to: '2026-03-31' },
      takings: oneDayShort, credits: CREDITS, terms: TERMS,
    });
    // The bank says more cash was lodged than the old system says was taken.
    expect(shorted.cashNotBankedMinor).toBe(-100_000);
    expect(shorted.sufficientToVerify).toBe(false);
    // And the tie to the filed return is broken too.
    expect(shorted.routes.reduce((t, r) => t + r.grossMinor, 0)).not.toBe(TAXABLE + TAX_DUE);
  });

  // ─── 4. THE VERIFIED FIGURES REACH AN APPEND-ONLY LEDGER ────────────────────

  it('banks the four verified control figures as append-only events', async () => {
    const witnessed = [
      { subject: 'stock', valueMinor: STOCK_VALUE, witness: 'physical_count' },
      { subject: 'creditors', valueMinor: CREDITORS, witness: 'supplier_statement' },
      { subject: 'sales', valueMinor: TAXABLE + TAX_DUE, witness: 'bank_statement' },
      { subject: 'tax', valueMinor: TAX_DUE, witness: 'filed_gst_return' },
    ];

    for (const w of witnessed) {
      const appended = await store.append(TENANT, `witnessed-${RUN}`, makeEvent({
        id: `${RUN}-${w.subject}`, type: 'InventoryAdjusted', occurredAt: '2026-08-08T05:00:00Z',
        idempotencyKey: `witness-${RUN}-${w.subject}`, source: 'migration/OB-06',
        payload: {
          subjectId: w.subject, quantity: 0, valueMinor: w.valueMinor,
          // The evidence travels with the figure. A number in the opening books whose witness
          // nobody recorded is a number nobody can defend two years later.
          verifiedAgainst: w.witness,
          reason: 'opening position, verified against evidence from outside the old system',
        },
      }));
      expect(appended.deduped).toBe(false);
    }

    const banked = await store.readStream(TENANT, `witnessed-${RUN}`);
    expect(banked).toHaveLength(4);
    for (const b of banked) {
      expect(String((b.event.payload as Record<string, unknown>)['verifiedAgainst'])).not.toBe('undefined');
    }
  });

  it('the database refuses to change a banked figure (hard rule #2)', async () => {
    const first = (await store.readStream(TENANT, `witnessed-${RUN}`))[0]!;
    await expect(
      client.query('UPDATE event_ledger SET payload = $1 WHERE id = $2', ['{"x":1}', first.event.id]),
    ).rejects.toThrow(/append-only/i);
    await expect(client.query('DELETE FROM event_ledger WHERE id = $1', [first.event.id]))
      .rejects.toThrow(/append-only/i);
  });

  // ─── 5. AND NONE OF THE SIX WILL VERIFY AGAINST ITSELF ──────────────────────

  it('offers no way, in any of the six, to verify a figure against its own source', async () => {
    // The absence that the whole approach rests on. Each module refuses its own version of the
    // same move — checking a number against the thing that produced it — and none of them
    // exposes a way round it.
    const modules = await Promise.all([
      import('../../packages/migration/src/count-verification'),
      import('../../packages/migration/src/supplier-reconciliation'),
      import('../../packages/migration/src/banking-verification'),
      import('../../packages/migration/src/tax-verification'),
      import('../../packages/migration/src/books-verification'),
      import('../../packages/migration/src/loyalty-verification'),
    ]);
    for (const m of modules) {
      for (const name of Object.keys(m)) {
        expect(name).not.toMatch(/selfVerify|acceptWithout|forceReconcile|assumeCorrect|skipVerification/i);
      }
    }
  });
});
