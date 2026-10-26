// API-11 Platform — the DECLARED request and reply body schemas of the money routes (M32-FR-01 · §30.1 "OpenAPI/AsyncAPI or
// equivalent machine-readable contract" · P-06 — the finance lane's remaining limit, OB-288).
//
// The OpenAPI document (api-contracts.ts) is generated from the running route table; until now every body was an open JSON
// object marked `x-body-schema: "not declared"`. The routes that move money now declare theirs here: sales intake, refunds
// (returns), supplier payments and advances, purchase orders, and journals (manual and the day book). Each schema states
// what the handler READS and REQUIRES — the same fields its own refusal names — and what it REPLIES on success.
//
// Two rules keep them honest:
//   • a request schema never requires more than the handler refuses without, and an object stays OPEN to properties it does
//     not list (a handler ignores what it does not read; a newer client may send more) — except a card on a tender, which is
//     closed to its three token facts (hard rule #3: no raw card data, its security code or its expiry is ever a field of any contract);
//   • tests/integration/money-route-schemas-match-the-handlers.test.ts drives every declared route through the real API and
//     checks the bodies it sent and the replies it got against these schemas, so a schema cannot drift from its handler.
// Every other route's bodies are DERIVED from its handler's own code (api-body-derive.ts); the guardrail holds the fields
// these nine schemas require to exactly the ones the derivation finds the handler refuses without, so they cannot drift.

type Json = string | number | boolean | null | readonly Json[] | { readonly [k: string]: Json };

/** A route's declared bodies: the request (absent for a body the route does not read) and the success reply. */
export interface DeclaredBodies {
  /** The schema component name stem, e.g. `SaleIntake` → `SaleIntakeRequest` / `SaleIntakeReply`. */
  readonly name: string;
  readonly request?: Json;
  /** The success status and its body. */
  readonly reply: {
    readonly status: '200' | '201' | '202'; readonly schema: Json; readonly description: string;
    /** A second success status the route answers with the same body (a replay, an already-recorded record). */
    readonly alsoStatus?: '200' | '201';
  };
}

const str: Json = { type: 'string', minLength: 1 };
const optStr: Json = { type: 'string' };
const int: Json = { type: 'integer' };
const posInt: Json = { type: 'integer', minimum: 1 };
const nonNegInt: Json = { type: 'integer', minimum: 0 };
const day: Json = { type: 'string', pattern: '^\\d{4}-\\d{2}-\\d{2}$', description: 'YYYY-MM-DD' };
const month: Json = { type: 'string', pattern: '^\\d{4}-(0[1-9]|1[0-2])$', description: 'YYYY-MM' };
const bool: Json = { type: 'boolean' };
const open = (properties: Record<string, Json>, required: readonly string[] = [], description?: string): Json => ({
  type: 'object', required: [...required], additionalProperties: true, properties,
  ...(description === undefined ? {} : { description }),
});
const arrayOf = (items: Json, extra: Record<string, Json> = {}): Json => ({ type: 'array', items, ...extra });
const nullable = (schema: Json): Json => ({ anyOf: [schema, { type: 'null' }] });
const PAYMENT_METHODS = ['bank_transfer', 'cheque', 'upi', 'cash'] as const;

const journalLine: Json = open({
  accountCode: str, debitMinor: nonNegInt, creditMinor: nonNegInt,
  centre: { type: 'string', minLength: 1, description: 'A branch or department of the organisation (M23-FR-01); a centre it does not have is refused 422 unknown_centre.' },
}, ['accountCode', 'debitMinor', 'creditMinor']);

const journalSummary: Json = open({
  entryId: str, kind: str, sourceKind: { type: 'string', enum: ['sale', 'return', 'loyalty'] }, sources: nonNegInt, period: month, documentDate: day,
  belongsTo: month, components: { type: 'object', additionalProperties: int }, lines: arrayOf(journalLine), postedBy: str, narrative: str,
  netByDepartment: { type: 'object', additionalProperties: int, description: 'OB-340: each department\'s exact net on a sale or sale-return voucher.' },
}, ['entryId', 'kind', 'period', 'documentDate', 'lines']);

const poLine: Json = open({
  productId: str, orderedQty: posInt, uom: str,
  unitCost: { type: 'object', required: ['minor', 'currency'], additionalProperties: true, properties: { minor: nonNegInt, currency: str, per: posInt } },
}, ['productId', 'orderedQty']);

const purchaseOrder: Json = open({
  poId: str, number: str, supplierId: str, deliverToLocationId: str, requisitionedBy: str, at: str,
  lines: arrayOf(open({ productId: str, orderedQty: posInt })), totalMinor: nonNegInt, currency: str,
  status: { type: 'string', enum: ['proposed', 'issued'] }, approvedBy: nullable(str), issuedAt: nullable(str),
}, ['poId', 'supplierId', 'lines', 'totalMinor', 'currency', 'status']);

const supplierAdvanceTag: Json = open({
  change: { type: 'string', enum: ['paid', 'applied'] }, advanceId: str, supplierId: str, amountMinor: posInt, on: day,
  poId: str, method: { type: 'string', enum: [...PAYMENT_METHODS] }, reference: str, approvedBy: str, applicationId: str, invoiceId: str, reverses: str,
}, ['change', 'advanceId', 'supplierId', 'amountMinor', 'on']);

/** Keyed `METHOD path` exactly as the route table serves it. */
export const DECLARED_BODIES: Readonly<Record<string, DeclaredBodies>> = {
  // ── Sales intake (M12 · API-05): what a till banks. A sale that arrived is banked; findings never un-happen it.
  'POST /v1/sales': {
    name: 'SaleIntake',
    request: open({
      saleId: str, receiptNumber: str, laneId: str, locationId: str, cashierId: str, tradingDay: day,
      committedAt: { type: 'string', minLength: 1, description: 'ISO-8601 time the lane committed the sale (locally first — hard rule #1).' },
      totalMinor: int, currency: str, packVersion: { type: 'number' }, roundOffMinor: int, customerRef: str, oldErpBillNumber: str,
      lines: arrayOf(open({
        productId: str, quantityMinor: int, uom: str, unitPriceMinor: int,
        lineTotalMinor: { type: 'integer', description: 'What the lane charged for the line, AFTER its own discount.' },
        batchId: str, batchExpiry: day, hsnCode: str, taxRateBps: nonNegInt, cessMinor: nonNegInt, huid: str,
      }, ['productId', 'quantityMinor', 'uom', 'unitPriceMinor', 'lineTotalMinor'])),
      tenders: arrayOf(open({
        kind: { type: 'string', minLength: 1, description: 'A tender kind (components/schemas/TenderKind lists the known ones).' },
        amountMinor: int, ref: str, machineRef: str, points: nonNegInt,
        card: {
          type: 'object', additionalProperties: false, required: ['tokenRef', 'last4', 'network'],
          description: 'The ONLY card facts a sale carries (hard rule #3): a provider token reference, the last four digits and the network — never the full card, its security code or its expiry.',
          properties: { tokenRef: str, last4: { type: 'string', pattern: '^\\d{4}$' }, network: str },
        },
      }, ['kind', 'amountMinor'])),
    }, ['saleId', 'totalMinor', 'committedAt', 'lines', 'tenders', 'packVersion'], 'A sale as the lane committed it. Refused 400 not_readable_as_a_sale only when it cannot be read as one.'),
    reply: {
      status: '202', description: 'Banked. Findings about the sale are listed, never a refusal.',
      schema: open({
        banked: { const: true }, saleId: str, alreadyBanked: bool, detail: optStr,
        exceptions: arrayOf(open({ code: str, severity: { type: 'string', enum: ['critical', 'material', 'informational'] } })),
      }, ['banked', 'saleId', 'alreadyBanked', 'exceptions']),
    },
  },
  // ── Refunds (M13 · API-05): a return against a banked bill, with the approval a second person gave.
  'POST /v1/sales/:saleId/returns': {
    name: 'SaleReturn',
    request: open({
      returnId: str, number: str, reasonCode: optStr, refundMinor: int, refundTender: optStr, processedAt: optStr,
      approvalId: { type: 'string', description: 'The approval a second person gave in their own session (ADR-0022) — never a typed name.' },
      customerRef: str, outOfWindowApprovedBy: str,
      lines: arrayOf(open({
        productId: str, uom: str, quantityMinor: posInt, disposition: { type: 'string', enum: ['resell', 'quarantine', 'damaged', 'scrap'] }, condition: str, batchId: nullable(str),
      }, ['productId', 'quantityMinor'])),
    }, ['returnId', 'reasonCode', 'lines', 'refundMinor', 'refundTender'], 'Who processed it is the signed-in caller and the approval threshold is the shop\'s policy — neither is read from the body.'),
    reply: {
      status: '201', description: 'Recorded: the refund, what went back to stock, what may still come back.',
      schema: open({
        returnId: str, refundStatus: { type: 'string', enum: ['settled', 'pending'] }, restockedLines: { type: 'integer', minimum: 0, description: 'How many returned lines went back to sellable stock.' },
        remaining: arrayOf(open({ productId: str, uom: str, soldMinor: int, alreadyReturnedMinor: int, returnableMinor: int }, ['productId', 'returnableMinor'])),
        refundSource: { type: 'string', enum: ['to_source', 'exception_approved', 'not_known', 'not_checked'] },
        storeCredit: open({ instrumentId: str, balanceMinor: int }, ['instrumentId', 'balanceMinor']),
      }, ['returnId', 'refundStatus', 'restockedLines', 'remaining', 'refundSource']),
    },
  },
  // ── Payments (M06 · M23 · API-03 / API-09): a supplier payment, and an advance before the bill.
  'POST /v1/purchase/suppliers/:supplierId/payments/:paymentId': {
    name: 'SupplierPayment',
    request: open({
      amountMinor: posInt, paidOn: day, method: { type: 'string', enum: [...PAYMENT_METHODS] }, reference: str,
      approvalId: { type: 'string', description: 'The supplier_payment approval a second person gave (§28). A new payment without one is refused 422 payment_needs_approval.' },
    }, ['amountMinor', 'paidOn', 'method', 'reference', 'approvalId'], 'OB-341: refused 422 payment_exceeds_balance above what is owed LESS what advances already settled.'),
    reply: {
      status: '201', alsoStatus: '200', description: 'Recorded (201), or the same payment already recorded (200, alreadyRecorded).',
      schema: open({
        payment: open({ paymentId: str, supplierId: str, amountMinor: posInt, currency: { const: 'INR' }, paidOn: day, method: { type: 'string', enum: [...PAYMENT_METHODS] }, reference: str, approvedBy: str }, ['paymentId', 'supplierId', 'amountMinor', 'paidOn', 'method']),
        alreadyRecorded: bool, owedMinor: int,
        advancesAppliedMinor: { type: 'integer', minimum: 0, description: 'OB-341: what the supplier\'s advances had already settled.' },
        balanceToPayMinor: { type: 'integer', description: 'OB-341: owed less advances, after this payment.' },
        netPaidMinor: int,
      }, ['payment', 'alreadyRecorded', 'owedMinor']),
    },
  },
  'POST /v1/finance/supplier-advances/:advanceId': {
    name: 'SupplierAdvance',
    request: open({
      supplierId: str, amountMinor: posInt, paidOn: day, method: { type: 'string', enum: [...PAYMENT_METHODS] }, reference: str, poId: str,
      approvalId: { type: 'string', description: 'The supplier_payment approval a second person gave (§28). A new advance without one is refused 422.' },
    }, ['supplierId', 'amountMinor', 'paidOn', 'method', 'reference', 'approvalId']),
    reply: {
      status: '201', alsoStatus: '200', description: 'Paid and posted (201), or already recorded (200).',
      schema: open({ advance: supplierAdvanceTag, entryId: str, period: month, alreadyRecorded: bool }, ['advance', 'entryId', 'alreadyRecorded']),
    },
  },
  'POST /v1/finance/supplier-advances/:advanceId/applications/:applicationId': {
    name: 'SupplierAdvanceApplication',
    request: open({ amountMinor: posInt, invoiceId: str, appliedOn: day, reverses: str }, ['amountMinor', 'appliedOn'], 'Against a bill: { amountMinor, invoiceId, appliedOn }; to undo one: { reverses, amountMinor, appliedOn }.'),
    reply: {
      status: '201', alsoStatus: '200', description: 'Set against the bill (201), or already recorded (200).',
      schema: open({ application: supplierAdvanceTag, entryId: str, leftMinor: int, alreadyRecorded: bool }, ['application', 'entryId', 'alreadyRecorded']),
    },
  },
  // ── Purchase orders (M06 · API-03): raised by one person, issued by a second.
  'POST /v1/purchase/orders/:poId': {
    name: 'PurchaseOrderProposal',
    request: open({ supplierId: str, deliverToLocationId: str, lines: arrayOf(poLine, { minItems: 1 }), blanketAgreementId: str, requisitionId: str, buyingScope: str }, ['lines'],
      'A new order needs supplierId, deliverToLocationId and lines with a unit cost; a call-off release of a blanket agreement names blanketAgreementId and carries no price.'),
    reply: {
      status: '201', alsoStatus: '200', description: 'Proposed (201), or the same order already proposed (200).',
      schema: open({ order: purchaseOrder, openCommitment: nullable({ type: 'object' }), alreadyProposed: bool }, ['order']),
    },
  },
  'POST /v1/purchase/orders/:poId/approval': {
    name: 'PurchaseOrderIssue',
    request: open({ reason: str, approvalId: str }, ['reason']),
    reply: {
      status: '200', description: 'Issued by a second person, or already issued (alreadyIssued).',
      schema: open({ order: purchaseOrder, openCommitment: nullable({ type: 'object' }), alreadyIssued: bool }, ['order']),
    },
  },
  // ── Journals (M23 · API-09): a manual journal, and a trading day's day book.
  'POST /v1/finance/journals': {
    name: 'Journal',
    request: open({
      entryId: str, period: month, documentDate: day, narrative: str, postedBy: str, lines: arrayOf(journalLine, { minItems: 2 }),
    }, ['entryId', 'period', 'documentDate', 'narrative', 'lines'], 'Debits must equal credits; a closed month takes nothing (422 with the reason).'),
    reply: { status: '201', description: 'Posted.', schema: open({ entryId: str, postedTo: month }, ['entryId', 'postedTo']) },
  },
  'POST /v1/finance/day-book/:tradingDay/post': {
    name: 'DayBookPosting',
    reply: {
      status: '201', alsoStatus: '200', description: 'Vouchers posted (201), or nothing new to post (200). Every source is in a journal or a named exception.',
      schema: open({
        tradingDay: day, postedTo: month, postedLate: open({ belongsTo: month }), journals: arrayOf(journalSummary),
        exceptions: arrayOf(open({ exceptionId: str, reason: str, sourceIds: arrayOf(str) }, ['exceptionId', 'reason', 'sourceIds'])),
        skipped: nonNegInt, zeroValue: arrayOf(str), counted: open({ sales: nonNegInt, returns: nonNegInt }),
      }, ['tradingDay', 'postedTo', 'journals', 'exceptions', 'skipped']),
    },
  },
};

/** The money routes that MUST declare their bodies (the guardrail holds this list). */
export const MONEY_ROUTES: readonly string[] = Object.keys(DECLARED_BODIES);
