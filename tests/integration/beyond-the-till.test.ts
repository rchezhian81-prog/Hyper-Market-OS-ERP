import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { Client } from 'pg';
import { pgClient } from '../../packages/persistence/src/pg-client';
import { SqlEventStore } from '../../packages/persistence/src/event-store';
import { runMigrations } from '../../packages/persistence/src/migrations';
import { makeEvent } from '../../packages/contracts/src/event';

import {
  scopeToPartner, checkPartnerCompliance, acceptSubmission, buildStatement,
  auditPartnerAction, findProbing,
  type PartnerSession, type PartnerDocument, type StatementLine, type PartnerAuditEntry,
} from '../../packages/supplier-portal/src/portal';

import {
  issueQuotation, convertQuotation, issueChallan, issueTaxInvoice, checkChain,
  type B2BLine,
} from '../../packages/b2b/src/documents';
import { ageReceivables, allocatePayment, decideDunning, reconcileAr, type Receivable } from '../../packages/b2b/src/collections';

import { rosterGaps, canPerformTask, computeIncentive, sopStatus, type Employee } from '../../packages/workforce/src/workforce';

import { assessAssets, type Asset } from '../../packages/facilities/src/assets';
import { assessEquipment, assessPower } from '../../packages/facilities/src/monitoring';
import { findOverdue, closeIncident, buildComplianceEvidence, type MaintenanceSchedule, type ScheduledTask, type SafetyIncident } from '../../packages/facilities/src/schedules';

import { valueOwnStock, checkStockAccess, computePeriodCharge, settleConcession, mayConcessionTrade, depositPosition, type ConcessionContract, type OwnedLot } from '../../packages/concession/src/concession';

import { reviewScrap, type ScrapSale } from '../../packages/waste/src/scrap';
import { chargeForBags, projectPackaging, type PackagingItem } from '../../packages/waste/src/packaging';
import { buildSustainabilityReport, compareWaste, type WasteRecord } from '../../packages/waste/src/sustainability';

/**
 * STAGE 16 — enterprise modules.
 *
 * Gate (roadmap §21): **everything the shop does that is not a walk-in sale still tells the
 * truth.** One trading day at SRE, followed through the six things a hypermarket does
 * besides selling to a customer at a till:
 *
 *   a school orders on account · a supplier logs in from outside · a jeweller's counter
 *   trades on our floor with their own stock · the cold room protects ₹80,000 of it ·
 *   the roster has to cover the morning · and something leaves as waste.
 *
 * Executed against a REAL PostgreSQL, with the events banked in an append-only ledger the
 * database itself refuses to delete from.
 *
 * Set DATABASE_URL to run; without it the suite skips rather than passing quietly.
 */

const DATABASE_URL = process.env['DATABASE_URL'];
const TENANT = '77777777-7777-7777-7777-777777777777';
const RUN = `s${Date.now().toString(36)}`;

const QUO = { prefix: 'QUO', padTo: 5 };
const SO = { prefix: 'SO', padTo: 5 };
const DC = { prefix: 'DC', padTo: 5 };
const INV = { prefix: 'INV', padTo: 5 };

/** The school's order: 40 sacks of rice and 10 tins of oil, on 30-day terms. */
const SCHOOL_LINES: readonly B2BLine[] = [
  { lineId: 'l-rice', productId: 'p-rice', description: 'Sona Masoori 25kg', qty: 40, unitPriceMinor: 145_000, taxRateBps: 500 },
  { lineId: 'l-oil', productId: 'p-oil', description: 'Sunflower oil 15L', qty: 10, unitPriceMinor: 210_000, taxRateBps: 500 },
];

describe.skipIf(!DATABASE_URL)('Stage 16 — beyond the till (real PostgreSQL)', () => {
  let client: Client;
  let store: SqlEventStore;

  beforeAll(async () => {
    client = new Client({ connectionString: DATABASE_URL });
    await client.connect();
    const sql = pgClient(client);
    const dir = 'db/migrations';
    await runMigrations(
      sql,
      readdirSync(dir)
        .filter((f) => f.endsWith('.sql'))
        .sort()
        .map((name) => ({ name, sql: readFileSync(join(dir, name), 'utf8') })),
    );
    store = new SqlEventStore(sql);
  });

  afterAll(async () => {
    await client.end();
  });

  // ─── 1. THE SCHOOL ORDERS ON ACCOUNT ────────────────────────────────────────

  it('quotes the school, converts at the QUOTED price, and refuses to re-price late', () => {
    const quote = issueQuotation({
      documentId: `q-${RUN}`, customerId: 'c-school', tenantId: TENANT,
      lines: SCHOOL_LINES, format: QUO, seq: 1, at: '2026-08-04T09:00:00Z',
    });
    expect(quote.issued).toBe(true);
    expect(quote.document?.grossMinor).toBe(8_295_000);

    // Ten days later, inside the window, at the number the bursar took to their committee.
    const converted = convertQuotation({
      documentId: `so-${RUN}`, quotation: quote.document!, customerId: 'c-school',
      format: SO, seq: 1, validUntil: quote.validUntil!, at: '2026-08-10T09:00:00Z',
      creditAllowed: true,
    });
    expect(converted.document?.grossMinor).toBe(8_295_000);

    // Three weeks later it refuses, rather than re-pricing quietly at the invoice.
    const late = convertQuotation({
      documentId: `so-${RUN}-late`, quotation: quote.document!, customerId: 'c-school',
      format: SO, seq: 2, validUntil: quote.validUntil!, at: '2026-08-30T09:00:00Z',
      creditAllowed: true,
    });
    expect(late.outcome).toBe('expired');

    // And credit control is not optional.
    const unchecked = convertQuotation({
      documentId: `so-${RUN}-nc`, quotation: quote.document!, customerId: 'c-school',
      format: SO, seq: 3, validUntil: quote.validUntil!, at: '2026-08-10T09:00:00Z',
    });
    expect(unchecked.outcome).toBe('credit_blocked');
  });

  it('BILLS WHAT THE VAN CARRIED, not what the school ordered', () => {
    const quote = issueQuotation({
      documentId: `q-${RUN}`, customerId: 'c-school', tenantId: TENANT,
      lines: SCHOOL_LINES, format: QUO, seq: 1, at: '2026-08-04T09:00:00Z',
    });
    const order = convertQuotation({
      documentId: `so-${RUN}`, quotation: quote.document!, customerId: 'c-school',
      format: SO, seq: 1, validUntil: quote.validUntil!, at: '2026-08-10T09:00:00Z',
      creditAllowed: true,
    }).document!;

    // Only 25 of the 40 sacks fit on the van.
    const challan = issueChallan({
      documentId: `dc-${RUN}-1`, order, dispatched: { 'l-rice': 25 },
      format: DC, seq: 1, at: '2026-08-12T06:00:00Z',
    }).document!;

    const invoice = issueTaxInvoice({
      documentId: `inv-${RUN}-1`, order, challans: [challan],
      format: INV, seq: 1, at: '2026-08-12T18:00:00Z',
    });
    expect(invoice.issued).toBe(true);
    expect(invoice.document?.taxClaimable).toBe(true);
    // 25 × 145,000 + 5% = 3,806,250. NOT the order's 8,295,000.
    expect(invoice.document?.grossMinor).toBe(3_806_250);
    expect(invoice.document?.grossMinor).not.toBe(order.grossMinor);

    // The rest goes two days later and the balance is billed once, not twice.
    const second = issueChallan({
      documentId: `dc-${RUN}-2`, order, dispatched: { 'l-rice': 15, 'l-oil': 10 },
      alreadyDispatched: { 'l-rice': 25 }, format: DC, seq: 2, at: '2026-08-14T06:00:00Z',
    }).document!;
    const balance = issueTaxInvoice({
      documentId: `inv-${RUN}-2`, order, challans: [challan, second],
      alreadyInvoiced: { 'l-rice': 25 }, format: INV, seq: 2, at: '2026-08-14T18:00:00Z',
    }).document!;

    // The two invoices together are the order, exactly.
    expect(invoice.document!.grossMinor + balance.grossMinor).toBe(order.grossMinor);

    const chain = checkChain({ order, challans: [challan, second], invoices: [invoice.document!, balance] });
    expect(chain.complete).toBe(true);
    expect(chain.uninvoicedMinor).toBe(0);

    // And a driver taking one extra sack out is refused, not reconciled later.
    const over = issueChallan({
      documentId: `dc-${RUN}-3`, order, dispatched: { 'l-rice': 1 },
      alreadyDispatched: { 'l-rice': 40 }, format: DC, seq: 3, at: '2026-08-15T06:00:00Z',
    });
    expect(over.outcome).toBe('over_delivery');
  });

  it('ages the school from the DUE DATE and will not chase a queried invoice', () => {
    const invoices: readonly Receivable[] = [
      { invoiceId: `i-${RUN}-1`, number: 'INV00001', customerId: 'c-school', tenantId: TENANT,
        issuedOn: '2026-06-25', dueOn: '2026-07-25', grossMinor: 3_806_250, settledMinor: 0 },
      { invoiceId: `i-${RUN}-2`, number: 'INV00002', customerId: 'c-school', tenantId: TENANT,
        issuedOn: '2026-07-14', dueOn: '2026-08-14', grossMinor: 4_488_750, settledMinor: 0 },
      { invoiceId: `i-${RUN}-3`, number: 'INV00003', customerId: 'c-school', tenantId: TENANT,
        issuedOn: '2026-03-01', dueOn: '2026-03-31', grossMinor: 400_000, settledMinor: 0,
        disputed: true, disputeReason: 'two sacks short in March' },
    ];

    const ageing = ageReceivables({ customerId: 'c-school', invoices, asAt: '2026-08-04' });
    // 40 days since issue, 10 days past due. Ageing from the issue date would have called
    // this account delinquent and made the whole report unreadable.
    expect(ageing.items.find((i) => i.invoiceId === `i-${RUN}-1`)?.daysOverdue).toBe(10);
    expect(ageing.items.find((i) => i.invoiceId === `i-${RUN}-2`)?.bucket).toBe('not_due');
    expect(ageing.totalOutstandingMinor).toBe(8_695_000);

    // The March invoice is 126 days old and must NOT drive a dunning letter.
    expect(ageing.disputedMinor).toBe(400_000);
    expect(ageing.chaseableMinor).toBe(3_806_250);

    const step = decideDunning({ ageing });
    expect(step.step).toBe('reminder');
    expect(step.needsHuman).toBe(false);

    // Had the query not been recorded, the same account would be facing a stop-supply
    // decision — and that one always needs a person.
    const undisputed = ageReceivables({
      customerId: 'c-school',
      invoices: invoices.map((i) => ({ ...i, disputed: false })),
      asAt: '2026-08-04',
    });
    const harsh = decideDunning({ ageing: undisputed });
    expect(harsh.step).toBe('stop_supply');
    expect(harsh.needsHuman).toBe(true);
  });

  it('allocates the school\'s payment to named invoices and agrees with finance', () => {
    const invoices: readonly Receivable[] = [
      { invoiceId: `i-${RUN}-1`, number: 'INV00001', customerId: 'c-school',
        issuedOn: '2026-06-25', dueOn: '2026-07-25', grossMinor: 3_806_250, settledMinor: 0 },
      { invoiceId: `i-${RUN}-2`, number: 'INV00002', customerId: 'c-school',
        issuedOn: '2026-07-14', dueOn: '2026-08-14', grossMinor: 4_488_750, settledMinor: 0 },
    ];

    const receipt = allocatePayment({
      receiptId: `r-${RUN}`, customerId: 'c-school', receivedMinor: 4_000_000, invoices,
    });
    // Oldest due first, and it lands SOMEWHERE — never netted against a balance.
    expect(receipt.allocations.map((a) => a.appliedMinor)).toEqual([3_806_250, 193_750]);
    expect(receipt.unappliedMinor).toBe(0);

    const settled = invoices.map((i) => ({
      ...i,
      settledMinor: receipt.allocations.find((a) => a.invoiceId === i.invoiceId)?.appliedMinor ?? 0,
    }));
    const after = ageReceivables({ customerId: 'c-school', invoices: settled, asAt: '2026-08-04' });
    expect(after.totalOutstandingMinor).toBe(4_295_000);

    expect(reconcileAr({ customerId: 'c-school', ageing: after, financeOutstandingMinor: 4_295_000 }).agrees).toBe(true);
    const drift = reconcileAr({ customerId: 'c-school', ageing: after, financeOutstandingMinor: 4_400_000 });
    expect(drift.detail).toContain('they will pay the smaller one');
  });

  // ─── 2. A SUPPLIER LOGS IN FROM OUTSIDE ─────────────────────────────────────

  it('shows a supplier ONLY their own rows and records the attempt to see a rival\'s', () => {
    const session: PartnerSession = {
      sessionId: `ps-${RUN}`, partnerId: 'sup-anand', tenantId: TENANT, userId: 'u-anand',
      grants: ['view_orders', 'submit_asn', 'submit_invoice', 'submit_catalogue', 'view_statement'],
    };
    const orders = [
      { orderId: `PO-${RUN}-1`, partnerId: 'sup-anand', tenantId: TENANT, valueMinor: 100_000 },
      { orderId: `PO-${RUN}-2`, partnerId: 'sup-anand', tenantId: TENANT, valueMinor: 250_000 },
      { orderId: `PO-${RUN}-K`, partnerId: 'sup-kumar', tenantId: TENANT, valueMinor: 900_000 },
    ];

    const mine = scopeToPartner({ session, rows: orders, grant: 'view_orders' });
    expect(mine.rows.map((r) => r.orderId)).toEqual([`PO-${RUN}-1`, `PO-${RUN}-2`]);
    expect(mine.detail).toContain('not by the client');

    const probe = scopeToPartner({
      session, rows: orders, grant: 'view_orders', requestedPartnerId: 'sup-kumar',
    });
    expect(probe.rows).toEqual([]);
    // Not an empty list. A refusal, and a security event.
    expect(probe.securityEvent).toBe(true);

    const trail: PartnerAuditEntry[] = [1, 2, 3].map((n) =>
      auditPartnerAction({
        session, action: 'view_orders', outcome: 'not_your_data',
        detail: `attempt ${n}`, at: `2026-08-04T1${n}:00:00Z`,
      }),
    );
    const probing = findProbing(trail);
    expect(probing).toHaveLength(1);
    expect(probing[0]?.detail).toContain('somebody trying doors');
  });

  it('BLOCKS an expired-licence supplier at the ACTION, not on a nightly sweep', () => {
    const session: PartnerSession = {
      sessionId: `ps-${RUN}`, partnerId: 'sup-anand', tenantId: TENANT, userId: 'u-anand',
      grants: ['submit_asn', 'submit_invoice', 'submit_catalogue'],
    };
    const documents: readonly PartnerDocument[] = [
      { documentId: `d-${RUN}-1`, partnerId: 'sup-anand', kind: 'fssai_licence',
        reference: 'FSSAI-118', validFrom: '2024-07-01', validUntil: '2026-07-01',
        verifiedBy: 'u-buyer', verifiedAt: '2024-07-02' },
      { documentId: `d-${RUN}-2`, partnerId: 'sup-anand', kind: 'gst_registration',
        reference: 'GST-33ABC', validFrom: '2024-01-01', validUntil: '2028-01-01',
        verifiedBy: 'u-buyer', verifiedAt: '2024-01-02' },
    ];

    const compliance = checkPartnerCompliance({
      partnerId: 'sup-anand', documents, required: ['fssai_licence', 'gst_registration'],
      today: '2026-08-04',
    });
    expect(compliance.compliant).toBe(false);
    expect(compliance.blocking).toEqual(['fssai_licence']);

    // The delivery note is refused at the door, which is the point.
    const asn = acceptSubmission({
      submissionId: `sub-${RUN}-asn`, session, kind: 'asn', compliance, at: '2026-08-04T07:00:00Z',
    });
    expect(asn.accepted).toBe(false);
    expect(asn.outcome).toBe('not_compliant');

    // Renewed and verified the same morning, it goes through — and a catalogue still
    // lands for review, because the portal is a door, not an authority.
    const renewed = checkPartnerCompliance({
      partnerId: 'sup-anand',
      documents: [...documents, {
        documentId: `d-${RUN}-3`, partnerId: 'sup-anand', kind: 'fssai_licence',
        reference: 'FSSAI-119', validFrom: '2026-07-01', validUntil: '2028-07-01',
        verifiedBy: 'u-buyer', verifiedAt: '2026-08-04',
      }],
      required: ['fssai_licence', 'gst_registration'], today: '2026-08-04',
    });
    expect(renewed.compliant).toBe(true);

    const accepted = acceptSubmission({
      submissionId: `sub-${RUN}-asn2`, session, kind: 'asn', compliance: renewed, at: '2026-08-04T08:00:00Z',
    });
    expect(accepted.accepted).toBe(true);
    expect(accepted.requiresReview).toBe(false);

    const catalogue = acceptSubmission({
      submissionId: `sub-${RUN}-cat`, session, kind: 'catalogue', compliance: renewed, at: '2026-08-04T08:05:00Z',
    });
    expect(catalogue.requiresReview).toBe(true);
  });

  it('gives the supplier a statement that adds up and keeps their dispute separate', () => {
    const session: PartnerSession = {
      sessionId: `ps-${RUN}`, partnerId: 'sup-anand', tenantId: TENANT, userId: 'u-anand',
      grants: ['view_statement'],
    };
    const lines: readonly StatementLine[] = [
      { partnerId: 'sup-anand', tenantId: TENANT, documentRef: 'SINV-1', kind: 'invoice', date: '2026-07-02', amountMinor: 500_000, status: 'open' },
      { partnerId: 'sup-anand', tenantId: TENANT, documentRef: 'SCN-1', kind: 'credit_note', date: '2026-07-14', amountMinor: -45_000, status: 'open' },
      { partnerId: 'sup-anand', tenantId: TENANT, documentRef: 'SPAY-1', kind: 'payment', date: '2026-07-28', amountMinor: -300_000, status: 'settled' },
      { partnerId: 'sup-anand', tenantId: TENANT, documentRef: 'SINV-9', kind: 'invoice', date: '2026-07-30', amountMinor: 88_000, status: 'disputed' },
      { partnerId: 'sup-kumar', tenantId: TENANT, documentRef: 'KINV-1', kind: 'invoice', date: '2026-07-30', amountMinor: 999_000, status: 'open' },
    ];

    const statement = buildStatement({ session, lines, openingMinor: 0 });
    expect(statement.lines.map((l) => l.documentRef)).not.toContain('KINV-1');
    expect(statement.closingMinor).toBe(155_000);
    expect(statement.disputedMinor).toBe(88_000);
    expect(statement.reconciles).toBe(true);
    expect(statement.detail).toContain('neither owed nor written off');

    // Without the grant it is a permission answer, not a balance of zero.
    const blind = buildStatement({ session: { ...session, grants: [] }, lines, openingMinor: 0 });
    expect(blind.accessible).toBe(false);
    expect(blind.detail).toContain('NOT a balance of zero');
  });

  // ─── 3. THE JEWELLER'S COUNTER ──────────────────────────────────────────────

  const CONTRACT: ConcessionContract = {
    contractId: `k-${RUN}`, tenantId: TENANT, branchId: 'b-main',
    concessionaireId: 'cc-jeweller', name: 'Sri Lakshmi Jewellers',
    startsOn: '2026-01-01', endsOn: '2026-12-31', basis: 'higher_of_both',
    fixedRentMinor: 5_000_000, revenueShareBps: 800, depositMinor: 20_000_000,
    utilitiesMinor: 400_000, insuranceUntil: '2027-03-31', licenceUntil: '2027-06-30',
    approvedBy: 'u-owner', active: true,
  };

  it('KEEPS THE JEWELLER\'S GOLD OUT OF OUR BALANCE SHEET', () => {
    const lots: readonly OwnedLot[] = [
      { lotId: `lot-${RUN}-rice`, productId: 'p-rice', branchId: 'b-main', qty: 200, unitCostMinor: 120_000, ownership: 'own' },
      { lotId: `lot-${RUN}-oil`, productId: 'p-oil', branchId: 'b-main', qty: 60, unitCostMinor: 180_000, ownership: 'own' },
      { lotId: `lot-${RUN}-gold`, productId: 'p-gold', branchId: 'b-main', qty: 1, unitCostMinor: 400_000_000, ownership: 'concession', ownerId: 'cc-jeweller' },
    ];

    const valuation = valueOwnStock({ branchId: 'b-main', lots });
    // 24,000,000 + 10,800,000 = 34,800,000. The ₹40,00,000 of gold is NOT in it.
    expect(valuation.ownedValueMinor).toBe(34_800_000);
    expect(valuation.excludedValueMinor).toBe(400_000_000);
    expect(valuation.excluded[0]?.ownerId).toBe('cc-jeweller');
    expect(valuation.detail).toContain('the insurance schedule and the tax position');

    // And our own manager cannot write it off.
    const gold = lots[2]!;
    expect(checkStockAccess({ lot: gold, actorId: 'u-manager', actorKind: 'store_staff', action: 'write_off' }).allowed).toBe(false);
    expect(checkStockAccess({ lot: gold, actorId: 'u-till', actorKind: 'store_staff', action: 'sell', storeSellsOnBehalf: true }).allowed).toBe(true);
    // A different concessionaire probing for it is a security event.
    expect(checkStockAccess({
      lot: gold, actorId: 'u-phones', actorKind: 'concessionaire', concessionaireId: 'cc-phones', action: 'view',
    }).securityEvent).toBe(true);
  });

  it('settles the counter without ever calling their takings our revenue', () => {
    const sales = [
      { saleId: `cs-${RUN}-1`, contractId: CONTRACT.contractId, concessionaireId: 'cc-jeweller', branchId: 'b-main', at: '2026-07-05T11:00:00Z', grossMinor: 30_000_000, taxMinor: 900_000, tenderedTo: 'store_till' as const },
      { saleId: `cs-${RUN}-2`, contractId: CONTRACT.contractId, concessionaireId: 'cc-jeweller', branchId: 'b-main', at: '2026-07-18T15:00:00Z', grossMinor: 45_000_000, taxMinor: 1_350_000, tenderedTo: 'store_till' as const },
      { saleId: `cs-${RUN}-3`, contractId: CONTRACT.contractId, concessionaireId: 'cc-jeweller', branchId: 'b-main', at: '2026-07-20T16:00:00Z', grossMinor: -5_000_000, taxMinor: -150_000, tenderedTo: 'store_till' as const, refundOf: `cs-${RUN}-1` },
    ];

    const charge = computePeriodCharge({ contract: CONTRACT, sales, from: '2026-07-01', to: '2026-07-31' });
    // 70,000,000 × 8% = 5,600,000, which beats the 5,000,000 rent. The HIGHER, not the sum.
    expect(charge.grossSalesMinor).toBe(70_000_000);
    expect(charge.chargeMinor).toBe(5_600_000);
    expect(charge.chargeMinor).not.toBe(charge.fixedRentMinor + charge.revenueShareMinor);

    const settlement = settleConcession({ contract: CONTRACT, charge, sales, bankedForThemMinor: 70_000_000 });
    expect(settlement.collectedForThemMinor).toBe(70_000_000);
    expect(settlement.payableToThemMinor).toBe(64_000_000);
    expect(settlement.reconciles).toBe(true);

    // A till short of what the counter rang is a valued exception, not a rounding note.
    const short = settleConcession({ contract: CONTRACT, charge, sales, bankedForThemMinor: 69_820_000 });
    expect(short.differenceMinor).toBe(180_000);
    expect(short.detail).toContain('not a rounding note');

    // The deposit is theirs, projected from movements, and a forfeit needs a name.
    const deposit = depositPosition({
      concessionaireId: 'cc-jeweller',
      movements: [
        { movementId: `dm-${RUN}-1`, concessionaireId: 'cc-jeweller', kind: 'received', amountMinor: 20_000_000, at: '2026-01-01T00:00:00Z' },
        { movementId: `dm-${RUN}-2`, concessionaireId: 'cc-jeweller', kind: 'forfeited', amountMinor: 3_000_000, at: '2026-07-31T00:00:00Z' },
      ],
    });
    expect(deposit.outstandingLiabilityMinor).toBe(20_000_000);
    expect(deposit.detail).toContain("nobody's name on them");
  });

  it('SHUTS THE COUNTER when their insurance lapses, and says every reason at once', () => {
    expect(mayConcessionTrade({ contract: CONTRACT, today: '2026-08-04' }).mayTrade).toBe(true);

    const lapsed = mayConcessionTrade({
      contract: { ...CONTRACT, insuranceUntil: '2026-06-30', licenceUntil: '2026-05-01' },
      today: '2026-08-04',
    });
    expect(lapsed.mayTrade).toBe(false);
    expect([...lapsed.blockedBy].sort()).toEqual(['insurance_lapsed', 'licence_lapsed']);
    expect(lapsed.detail).toContain('your exposure, not theirs');
  });

  // ─── 4. THE COLD ROOM AND THE POWER ─────────────────────────────────────────

  const COLD_ROOM: Asset = {
    assetId: `a-${RUN}-cold`, tenantId: TENANT, branchId: 'b-main', name: 'Cold room 1',
    kind: 'cold_room', criticality: 'critical', installedOn: '2024-01-10',
    amcUntil: '2026-06-01', serviceEveryDays: 90, protectsValueMinor: 8_000_000, active: true,
  };

  it('names the ₹80,000 the lapsed cold-room contract leaves unprotected', () => {
    const health = assessAssets({
      branchId: 'b-main',
      assets: [COLD_ROOM, {
        ...COLD_ROOM, assetId: `a-${RUN}-trolley`, name: 'Shelf trolley', kind: 'handling',
        criticality: 'routine', amcUntil: undefined, serviceEveryDays: undefined,
        protectsValueMinor: undefined,
      }],
      services: [{ serviceId: `sv-${RUN}`, assetId: `a-${RUN}-cold`, performedOn: '2026-07-01', performedBy: 'v-coolcare', kind: 'preventive' }],
      asAt: '2026-08-04',
    });
    // The cold room is not in the same list as the trolley. That separation IS the control.
    expect(health.critical.map((a) => a.assetId)).toEqual([`a-${RUN}-cold`]);
    expect(health.other.map((a) => a.assetId)).toEqual([`a-${RUN}-trolley`]);
    expect(health.critical[0]?.detail).toContain('8000000 of stock depends on it');
  });

  it('HOLDS EVERYTHING IN THE ROOM when it drifts, including what nobody probed', () => {
    const contents = [
      { batchId: `b-${RUN}-chicken`, productId: 'p-chicken', valueMinor: 120_000 },
      { batchId: `b-${RUN}-paneer`, productId: 'p-paneer', valueMinor: 64_000 },
    ];
    const range = { assetId: `a-${RUN}-cold`, minTenthsC: -10, maxTenthsC: 50, graceMinutes: 30, expectEveryMinutes: 120 };
    const reading = (at: string, tenthsC: number) => ({
      readingId: `r-${RUN}-${at}`, assetId: `a-${RUN}-cold`, tenthsC, at,
      source: 'sensor' as const, recordedBy: 'probe-1',
    });

    const breach = assessEquipment({
      assetId: `a-${RUN}-cold`, range, contents, asAt: '2026-08-04T10:00:00Z',
      readings: [reading('2026-08-04T06:00:00Z', 40), reading('2026-08-04T07:00:00Z', 95), reading('2026-08-04T09:00:00Z', 98)],
    });
    expect(breach.state).toBe('breach');
    expect(breach.minutesOutOfRange).toBe(180);
    expect(breach.holdStock).toBe(true);
    expect(breach.exposedValueMinor).toBe(184_000);

    // A probe that fell out of the room three weeks ago reads as "no alerts" forever.
    const silent = assessEquipment({
      assetId: `a-${RUN}-cold`, range, contents, asAt: '2026-08-04T10:00:00Z',
      readings: [reading('2026-08-01T09:00:00Z', 40)],
    });
    expect(silent.state).toBe('stale');
    expect(silent.holdStock).toBe(true);

    // And a door open for twenty minutes is not a hold.
    const brief = assessEquipment({
      assetId: `a-${RUN}-cold`, range, contents, asAt: '2026-08-04T10:05:00Z',
      readings: [reading('2026-08-04T09:45:00Z', 95), reading('2026-08-04T10:00:00Z', 40)],
    });
    expect(brief.state).toBe('drifting');
    expect(brief.holdStock).toBe(false);
  });

  it('counts the outage from the MAINS failure, not from the generator attempt', () => {
    const power = assessPower({
      branchId: 'b-main',
      events: [
        { eventId: `pe-${RUN}-1`, branchId: 'b-main', kind: 'mains_failed', at: '2026-08-04T09:00:00Z' },
        { eventId: `pe-${RUN}-2`, branchId: 'b-main', kind: 'dg_failed_to_start', at: '2026-08-04T09:06:00Z' },
      ],
      criticalAssets: [{ assetId: COLD_ROOM.assetId, name: 'Cold room 1', onBackup: false }],
      asAt: '2026-08-04T09:47:00Z',
    });
    expect(power.severity).toBe('unprotected');
    expect(power.unprotectedMinutes).toBe(47);
    expect(power.assetsAtRisk).toEqual(['Cold room 1']);
  });

  it('escalates the missed fire check above forty mop-the-aisle alerts', () => {
    const fire: MaintenanceSchedule = {
      scheduleId: `sch-${RUN}-fire`, tenantId: TENANT, branchId: 'b-main',
      title: 'Fire extinguisher check', category: 'fire_safety', frequency: 'monthly',
      assignedRole: 'facilities', evidenceRequired: true, verificationRequired: true,
      escalatesTo: 'u-owner', active: true,
    };
    const cleaning: MaintenanceSchedule = {
      ...fire, scheduleId: `sch-${RUN}-mop`, title: 'Mop aisle 4', category: 'cleaning',
      evidenceRequired: false, verificationRequired: false, escalatesTo: 'u-manager',
    };
    const tasks: readonly ScheduledTask[] = [
      { taskId: `t-${RUN}-fire`, scheduleId: fire.scheduleId, dueOn: '2026-07-20' },
      ...Array.from({ length: 40 }, (_, n): ScheduledTask => ({
        taskId: `t-${RUN}-mop-${n}`, scheduleId: cleaning.scheduleId, dueOn: '2026-07-25',
      })),
    ];

    const overdue = findOverdue({ schedules: [fire, cleaning], tasks, asAt: '2026-08-04' });
    expect(overdue).toHaveLength(41);
    // The fire check is first, and it is the only compliance-linked one.
    expect(overdue[0]?.taskId).toBe(`t-${RUN}-fire`);
    expect(overdue[0]?.level).toBe('compliance_risk');
    expect(overdue[0]?.escalateTo).toBe('u-owner');
    expect(overdue.filter((o) => o.complianceLinked)).toHaveLength(1);

    // A tick with no photograph does not clear it either.
    const ticked = findOverdue({
      schedules: [fire],
      tasks: [{ taskId: `t-${RUN}-fire`, scheduleId: fire.scheduleId, dueOn: '2026-07-20', completedOn: '2026-07-20', completedBy: 'u-raj' }],
      asAt: '2026-08-04',
    });
    expect(ticked[0]?.level).toBe('compliance_risk');
    expect(ticked[0]?.detail).toContain('no evidence');
  });

  it('will not close a reportable injury into silence, and says so in the pack', () => {
    const injury: SafetyIncident = {
      incidentId: `inc-${RUN}`, tenantId: TENANT, branchId: 'b-main', kind: 'injury',
      severity: 'reportable', occurredAt: '2026-08-02T14:00:00Z', reportedAt: '2026-08-02T14:20:00Z',
      reportedBy: 'u-raj', description: 'Slip on a wet floor at the deli', evidenceRefs: ['photo-1'],
    };

    expect(closeIncident({
      incident: injury, closedBy: 'u-manager', actionTaken: '', at: '2026-08-04T09:00:00Z',
    }).outcome).toBe('no_action_recorded');

    expect(closeIncident({
      incident: injury, closedBy: 'u-raj',
      actionTaken: 'Wet-floor signage at every prep point', at: '2026-08-04T09:00:00Z',
    }).outcome).toBe('self_closed');

    const noNotice = closeIncident({
      incident: injury, closedBy: 'u-manager',
      actionTaken: 'Wet-floor signage at every prep point', at: '2026-08-04T09:00:00Z',
    });
    expect(noNotice.outcome).toBe('not_reported_to_authority');

    const proper = closeIncident({
      incident: injury, closedBy: 'u-manager',
      actionTaken: 'Wet-floor signage at every prep point',
      authorityNotifiedOn: '2026-08-03', at: '2026-08-04T09:00:00Z',
    });
    expect(proper.closed).toBe(true);

    const fire: MaintenanceSchedule = {
      scheduleId: `sch-${RUN}-fire`, tenantId: TENANT, branchId: 'b-main',
      title: 'Fire extinguisher check', category: 'fire_safety', frequency: 'monthly',
      assignedRole: 'facilities', evidenceRequired: true, verificationRequired: true,
      escalatesTo: 'u-owner', active: true,
    };
    const pack = buildComplianceEvidence({
      branchId: 'b-main', schedules: [fire],
      tasks: [{ taskId: `t-${RUN}-fire`, scheduleId: fire.scheduleId, dueOn: '2026-08-01', completedOn: '2026-08-01', completedBy: 'u-raj', evidenceRefs: [] }],
      incidents: [injury], from: '2026-08-01', to: '2026-08-31',
    });
    expect(pack.presentable).toBe(false);
    expect(pack.gaps).toHaveLength(2);
    expect(pack.detail).toContain('worse than handing over nothing');
  });

  // ─── 5. THE MORNING SHIFT ───────────────────────────────────────────────────

  it('says SUNDAY 06:00 HAS NOBODY WHO CAN OPEN THE SHOP, not "88% covered"', () => {
    const meena: Employee = { employeeId: `e-${RUN}-1`, name: 'Meena', branchId: 'b-main', roles: ['cashier'], active: true, hourlyRateMinor: 9_000 };
    const suresh: Employee = { employeeId: `e-${RUN}-2`, name: 'Suresh', branchId: 'b-main', roles: ['opener', 'cashier'], active: false, hourlyRateMinor: 11_000 };

    const gaps = rosterGaps({
      shifts: [{
        shiftId: `sh-${RUN}-sun`, branchId: 'b-main',
        startsAt: '2026-08-09T06:00:00+05:30', endsAt: '2026-08-09T14:00:00+05:30',
        requiredRoles: [{ role: 'opener', count: 1 }, { role: 'cashier', count: 3 }],
      }],
      // Suresh left last month and is still in the grid. That is the gap nobody sees.
      assignments: [
        { shiftId: `sh-${RUN}-sun`, employeeId: suresh.employeeId, role: 'opener' },
        { shiftId: `sh-${RUN}-sun`, employeeId: meena.employeeId, role: 'cashier' },
      ],
      employees: [meena, suresh],
    });

    expect(gaps).toHaveLength(2);
    expect(gaps.find((g) => g.role === 'opener')?.detail).toBe('2026-08-09 06:00 has NOBODY rostered as opener');
    expect(gaps.find((g) => g.role === 'cashier')?.short).toBe(2);
  });

  it('blocks the DELI COUNTER, not the person, on a lapsed food certificate', () => {
    const raj: Employee = { employeeId: `e-${RUN}-3`, name: 'Raj', branchId: 'b-main', roles: ['deli', 'shelf'], active: true, hourlyRateMinor: 10_000 };
    const lapsed = [{
      certificationId: `c-${RUN}`, employeeId: raj.employeeId, kind: 'food_handling',
      issuedOn: '2024-06-01', validUntil: '2026-06-01', verifiedBy: 'u-manager',
    }];

    const deli = canPerformTask({
      employee: raj, task: 'deli counter', requiresCertification: 'food_handling',
      certifications: lapsed, today: '2026-08-04',
    });
    expect(deli.allowed).toBe(false);
    expect(deli.detail).toContain('this task is blocked, not this person');

    // He works the whole shift stacking shelves. A control people route around is not a
    // control, and blocking the person is exactly how they route around it.
    const shelves = canPerformTask({
      employee: raj, task: 'stack shelves', certifications: lapsed, today: '2026-08-04',
    });
    expect(shelves.allowed).toBe(true);

    // And an old SOP signature is not a current one.
    const sops = sopStatus({
      employee: raj,
      sops: [{ sopId: `sop-${RUN}-deli`, title: 'Deli hygiene', version: 5, forRoles: ['deli'] }],
      acknowledgements: [{ sopId: `sop-${RUN}-deli`, version: 3, employeeId: raj.employeeId, acknowledgedAt: '2025-02-01T00:00:00Z' }],
    });
    expect(sops[0]?.upToDate).toBe(false);
    expect(sops[0]?.detail).toContain('looks like compliance and is not');
  });

  it('pays NOTHING on a target missed by 4%', () => {
    const missed = computeIncentive({
      employeeId: `e-${RUN}-1`, metric: 'basket size', targetMinor: 1_000_000,
      achievedMinor: 960_000, payoutMinor: 25_000,
    });
    expect(missed.payoutMinor).toBe(0);
    expect(missed.achievementBps).toBe(9_600);
    expect(missed.detail).toContain('"Nearly" is a conversation');

    const met = computeIncentive({
      employeeId: `e-${RUN}-1`, metric: 'basket size', targetMinor: 1_000_000,
      achievedMinor: 1_300_000, payoutMinor: 25_000, acceleratorBps: 500,
    });
    expect(met.payoutMinor).toBe(40_000);
  });

  // ─── 6. WHAT LEAVES AS WASTE ────────────────────────────────────────────────

  it('makes the scrap money EXIST, and asks about the rate rather than the person', () => {
    const scrap = (over: Partial<ScrapSale>): ScrapSale => ({
      scrapId: `sc-${RUN}-1`, tenantId: TENANT, branchId: 'b-main', category: 'cardboard',
      disposal: 'sold', at: '2026-07-05T10:00:00Z', grams: 500_000, proceedsMinor: 400_000,
      buyerName: 'Anand Traders', evidenceRefs: ['weighbridge-1'], handledBy: 'u-raj',
      postedToFinance: true, ...over,
    });

    const review = reviewScrap({
      branchId: 'b-main', from: '2026-07-01', to: '2026-07-31',
      sales: [
        scrap({ scrapId: `sc-${RUN}-a` }),
        scrap({ scrapId: `sc-${RUN}-b`, proceedsMinor: 410_000 }),
        scrap({ scrapId: `sc-${RUN}-c`, proceedsMinor: 395_000 }),
        scrap({ scrapId: `sc-${RUN}-low`, proceedsMinor: 150_000, evidenceRefs: [], postedToFinance: false }),
      ],
    });

    expect(review.unpostedMinor).toBe(150_000);
    const flags = review.findings.filter((f) => f.scrapId === `sc-${RUN}-low`).map((f) => f.flag).sort();
    expect(flags).toEqual(['no_evidence', 'not_posted_to_finance', 'rate_below_average']);
    expect(review.findings.find((f) => f.flag === 'rate_below_average')?.detail)
      .toContain('Ask about the RATE, not about the person');
  });

  it('bills a carry bag as a visible line and counts the crates that never came back', () => {
    const bag: PackagingItem = {
      packagingId: `pk-${RUN}-bag`, tenantId: TENANT, name: 'Carry bag (large)',
      kind: 'carry_bag', chargeMinor: 1_000, taxRateBps: 1_800, returnable: false,
    };
    const charged = chargeForBags({
      item: bag, policy: { enabled: true, chargeOnlyIfIssued: true }, bagsIssued: 2,
    });
    expect(charged.line?.grossMinor).toBe(2_360);

    // Off for a tenant who does not charge: NO line, not a line worth nothing.
    const off = chargeForBags({
      item: bag, policy: { enabled: false, chargeOnlyIfIssued: true }, bagsIssued: 2,
    });
    expect(off.line).toBeUndefined();

    const crate: PackagingItem = {
      packagingId: `pk-${RUN}-crate`, tenantId: TENANT, name: 'Delivery crate',
      kind: 'reusable_crate', returnable: true, depositMinor: 10_000,
    };
    const position = projectPackaging({
      item: crate, branchId: 'b-main',
      movements: [
        { movementId: `pm-${RUN}-1`, packagingId: crate.packagingId, branchId: 'b-main', kind: 'received', qty: 400, at: '2026-01-01T00:00:00Z' },
        { movementId: `pm-${RUN}-2`, packagingId: crate.packagingId, branchId: 'b-main', kind: 'issued_to_delivery', qty: 300, at: '2026-07-01T00:00:00Z' },
        { movementId: `pm-${RUN}-3`, packagingId: crate.packagingId, branchId: 'b-main', kind: 'returned', qty: 182, at: '2026-07-31T00:00:00Z' },
      ],
    });
    // 118 crates unaccounted for. A shop that treats them as consumed buys 400 again.
    expect(position.inCirculation).toBe(118);
    expect(position.lossRateBps).toBe(3_933);
  });

  it('REFUSES to call a fall in recorded waste an improvement', () => {
    const record = (over: Partial<WasteRecord>): WasteRecord => ({
      wasteId: `w-${RUN}-1`, branchId: 'b-main', departmentId: 'd-fresh', productId: 'p-tomato',
      source: 'expiry', at: '2026-07-05T18:00:00Z', grams: 40_000, valueMinor: 180_000,
      disposal: 'composted', ...over,
    });
    const coverage = {
      expected: [
        { branchId: 'b-main', departmentId: 'd-fresh' },
        { branchId: 'b-main', departmentId: 'd-grocery' },
        { branchId: 'b-main', departmentId: 'd-dairy' },
        { branchId: 'b-main', departmentId: 'd-cafe' },
        { branchId: 'b-main', departmentId: 'd-nonfood' },
      ],
    };
    const names = {
      'd-fresh': 'Fresh produce', 'd-grocery': 'Grocery', 'd-dairy': 'Dairy',
      'd-cafe': 'Cafe', 'd-nonfood': 'Non-food',
    };

    const june = buildSustainabilityReport({
      branchId: 'b-main', coverage, departmentNames: names, from: '2026-06-01', to: '2026-06-30',
      waste: [
        record({ wasteId: `w-${RUN}-j1`, at: '2026-06-05T18:00:00Z', valueMinor: 200_000 }),
        record({ wasteId: `w-${RUN}-j2`, at: '2026-06-06T18:00:00Z', departmentId: 'd-grocery', valueMinor: 120_000, disposal: 'landfill', grams: 20_000 }),
        record({ wasteId: `w-${RUN}-j3`, at: '2026-06-07T18:00:00Z', departmentId: 'd-dairy', valueMinor: 80_000, disposal: 'donated', grams: 8_000 }),
        record({ wasteId: `w-${RUN}-j4`, at: '2026-06-08T18:00:00Z', departmentId: 'd-cafe', valueMinor: 60_000, grams: 12_000 }),
        record({ wasteId: `w-${RUN}-j5`, at: '2026-06-09T18:00:00Z', departmentId: 'd-nonfood', source: 'shrinkage', valueMinor: 40_000, disposal: 'landfill', grams: 2_000 }),
      ],
    });
    expect(june.confidence).toBe('reliable');
    expect(june.totalWasteValueMinor).toBe(500_000);

    // July: the careful cafe and non-food managers are on leave. Waste "falls" 18%.
    const july = buildSustainabilityReport({
      branchId: 'b-main', coverage, departmentNames: names, from: '2026-07-01', to: '2026-07-31',
      waste: [
        record({ wasteId: `w-${RUN}-1`, valueMinor: 210_000 }),
        record({ wasteId: `w-${RUN}-2`, departmentId: 'd-grocery', valueMinor: 120_000, disposal: 'landfill', grams: 20_000 }),
        record({ wasteId: `w-${RUN}-3`, departmentId: 'd-dairy', valueMinor: 80_000, disposal: 'donated', grams: 8_000 }),
      ],
    });
    expect(july.totalWasteValueMinor).toBe(410_000);
    expect(july.confidence).toBe('not_comparable');
    expect(july.notReporting).toEqual(['Cafe', 'Non-food']);

    const trend = compareWaste({
      from: { label: 'June', valueMinor: june.totalWasteValueMinor, coverageBps: june.coverageBps },
      to: { label: 'July', valueMinor: july.totalWasteValueMinor, coverageBps: july.coverageBps },
    });
    // The number fell 18%. The honest answer is that we cannot tell.
    expect(trend.direction).toBe('unknown');
    expect(trend.changeBps).toBe('not_meaningful');
    expect(trend.detail).toContain('less recording, not less waste');
  });

  // ─── 7. IT IS ALL BANKED, AND IT CANNOT BE UNPICKED ─────────────────────────

  it('banks the day in an append-only ledger the database itself defends', async () => {
    const events = [
      { id: `inv-${RUN}`, type: 'B2BInvoiceIssued', payload: { customerId: 'c-school', grossMinor: 3_806_250, derivedFrom: 'challan' } },
      { id: `sub-${RUN}`, type: 'PartnerSubmissionRefused', payload: { partnerId: 'sup-anand', reason: 'not_compliant' } },
      { id: `cc-${RUN}`, type: 'ConcessionSettled', payload: { concessionaireId: 'cc-jeweller', payableToThemMinor: 64_000_000 } },
      { id: `cold-${RUN}`, type: 'ColdRoomBreached', payload: { assetId: `a-${RUN}-cold`, exposedValueMinor: 184_000 } },
      { id: `fire-${RUN}`, type: 'SafetyTaskEscalated', payload: { title: 'Fire extinguisher check', escalatedTo: 'u-owner' } },
      { id: `waste-${RUN}`, type: 'WasteReported', payload: { valueMinor: 410_000, coverageBps: 6_000, comparable: false } },
    ];

    for (const [n, e] of events.entries()) {
      await store.append(
        TENANT,
        `stage16/${RUN}`,
        makeEvent({
          id: e.id,
          type: e.type,
          occurredAt: `2026-08-04T1${n}:00:00Z`,
          idempotencyKey: `${RUN}:${e.id}`,
          source: 'web-erp',
          payload: e.payload,
        }),
      );
    }

    const banked = await store.readStream(TENANT, `stage16/${RUN}`);
    expect(banked).toHaveLength(6);
    expect(banked.map((r) => r.event.type)).toContain('ColdRoomBreached');

    // Re-appending the same key is idempotent, not a second invoice.
    await store.append(
      TENANT,
      `stage16/${RUN}`,
      makeEvent({
        id: `inv-${RUN}`, type: 'B2BInvoiceIssued', occurredAt: '2026-08-04T10:00:00Z',
        idempotencyKey: `${RUN}:inv-${RUN}`, source: 'web-erp',
        payload: { customerId: 'c-school', grossMinor: 3_806_250, derivedFrom: 'challan' },
      }),
    );
    expect(await store.readStream(TENANT, `stage16/${RUN}`)).toHaveLength(6);

    const refusalFor = async (sql: string): Promise<string> => {
      try {
        await client.query(sql, [TENANT]);
        return 'THE DATABASE ALLOWED IT';
      } catch (error) {
        return (error as Error).message;
      }
    };
    expect(await refusalFor('DELETE FROM event_ledger WHERE tenant_id = $1')).toMatch(/append-only/i);
    expect(await refusalFor("UPDATE event_ledger SET type = 'x' WHERE tenant_id = $1")).toMatch(/append-only/i);
    expect(await store.readStream(TENANT, `stage16/${RUN}`)).toHaveLength(6);
  });
});
