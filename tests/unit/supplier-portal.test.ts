import { describe, it, expect } from 'vitest';
import * as portal from '../../packages/supplier-portal/src/index';
import {
  scopeToPartner,
  checkPartnerCompliance,
  acceptSubmission,
  buildStatement,
  auditPartnerAction,
  findProbing,
  type PartnerSession,
  type PartnerDocument,
  type StatementLine,
  type PortalGrant,
} from '../../packages/supplier-portal/src/portal';

// M24-FR-01..04 acceptance: "A PARTNER SEES ONLY THEIR OWN DATA; expired compliance
// documents block trading; submissions are reviewed before they take effect."

const ALL_GRANTS: readonly PortalGrant[] = [
  'view_orders', 'acknowledge_orders', 'submit_asn', 'submit_invoice',
  'submit_catalogue', 'respond_rfq', 'raise_claim', 'view_statement',
];

const session = (over: Partial<PartnerSession> = {}): PartnerSession => ({
  sessionId: 's-1',
  partnerId: 'sup-anand',
  tenantId: 't-sre',
  userId: 'u-anand-1',
  grants: ALL_GRANTS,
  ...over,
});

const ORDERS = [
  { orderId: 'PO-1', partnerId: 'sup-anand', tenantId: 't-sre', valueMinor: 100_000 },
  { orderId: 'PO-2', partnerId: 'sup-anand', tenantId: 't-sre', valueMinor: 250_000 },
  // The competitor bidding for the same shelf. This row must never leave the server.
  { orderId: 'PO-3', partnerId: 'sup-kumar', tenantId: 't-sre', valueMinor: 900_000 },
];

describe('a partner sees ONLY their own data, scoped from the session (M24-FR-01)', () => {
  it('filters to the session partner and says the filtering happened server-side', () => {
    const result = scopeToPartner({ session: session(), rows: ORDERS, grant: 'view_orders' });
    expect(result.allowed).toBe(true);
    expect(result.rows.map((r) => r.orderId)).toEqual(['PO-1', 'PO-2']);
    expect(result.detail).toContain('not by the client');
  });

  it('REFUSES a request naming another partner AND marks it a security event', () => {
    const result = scopeToPartner({
      session: session(),
      rows: ORDERS,
      grant: 'view_orders',
      requestedPartnerId: 'sup-kumar',
    });
    expect(result.allowed).toBe(false);
    expect(result.outcome).toBe('not_your_data');
    expect(result.rows).toEqual([]);
    // The point: not an empty list. A supplier probing for a competitor is not a UI bug.
    expect(result.securityEvent).toBe(true);
    expect(result.detail).toContain('refused and recorded');
  });

  it('asking for your OWN id explicitly is not an event', () => {
    const result = scopeToPartner({
      session: session(), rows: ORDERS, grant: 'view_orders', requestedPartnerId: 'sup-anand',
    });
    expect(result.allowed).toBe(true);
    expect(result.securityEvent).toBe(false);
  });

  it('refuses a grant the login does not hold, without leaking whether rows exist', () => {
    const result = scopeToPartner({
      session: session({ grants: ['view_statement'] }), rows: ORDERS, grant: 'view_orders',
    });
    expect(result.outcome).toBe('no_grant');
    expect(result.rows).toEqual([]);
    expect(result.securityEvent).toBe(false);
  });

  it('will not cross a TENANT boundary even for the same partner id', () => {
    // The same supplier trades with two of our tenants. One login must not show both.
    const rows = [
      { orderId: 'PO-A', partnerId: 'sup-anand', tenantId: 't-sre', valueMinor: 1 },
      { orderId: 'PO-B', partnerId: 'sup-anand', tenantId: 't-other', valueMinor: 2 },
    ];
    const result = scopeToPartner({ session: session(), rows, grant: 'view_orders' });
    expect(result.rows.map((r) => r.orderId)).toEqual(['PO-A']);
  });

  it('NO function in this module accepts a partner id from a payload', () => {
    // Absence as a control: there is no `dataForPartner(partnerId)` to call by mistake.
    const named = Object.keys(portal);
    expect(named).not.toContain('dataForPartner');
    expect(named).not.toContain('setPartnerId');
    expect(named).not.toContain('impersonatePartner');
  });
});

const doc = (over: Partial<PartnerDocument>): PartnerDocument => ({
  documentId: 'd-1',
  partnerId: 'sup-anand',
  kind: 'fssai_licence',
  reference: 'FSSAI-123',
  validFrom: '2025-01-01',
  validUntil: '2027-01-01',
  verifiedBy: 'u-buyer',
  verifiedAt: '2025-01-02',
  ...over,
});

describe('compliance is checked AT THE ACTION, not on a nightly sweep (M24-FR-03)', () => {
  const required = ['fssai_licence', 'gst_registration'] as const;

  it('passes a partner whose documents are verified and in date', () => {
    const check = checkPartnerCompliance({
      partnerId: 'sup-anand',
      documents: [doc({}), doc({ documentId: 'd-2', kind: 'gst_registration', reference: 'GST-9' })],
      required,
      today: '2026-08-04',
    });
    expect(check.compliant).toBe(true);
    expect(check.blocking).toEqual([]);
  });

  it('BLOCKS on an expired licence and says what the shop inherits', () => {
    const check = checkPartnerCompliance({
      partnerId: 'sup-anand',
      documents: [
        doc({ validUntil: '2026-07-01' }),
        doc({ documentId: 'd-2', kind: 'gst_registration' }),
      ],
      required,
      today: '2026-08-04',
    });
    expect(check.compliant).toBe(false);
    expect(check.blocking).toEqual(['fssai_licence']);
    const status = check.documents.find((d) => d.kind === 'fssai_licence');
    expect(status?.state).toBe('expired');
    expect(status?.daysRemaining).toBe(-34);
    expect(status?.detail).toContain('inherits their non-compliance');
  });

  it('treats an UNVERIFIED document as missing — it is a photograph somebody uploaded', () => {
    const check = checkPartnerCompliance({
      partnerId: 'sup-anand',
      documents: [
        doc({ verifiedBy: undefined, verifiedAt: undefined }),
        doc({ documentId: 'd-2', kind: 'gst_registration' }),
      ],
      required,
      today: '2026-08-04',
    });
    expect(check.compliant).toBe(false);
    expect(check.documents.find((d) => d.kind === 'fssai_licence')?.state).toBe('unverified');
  });

  it('warns before it blocks, so somebody can chase it', () => {
    const check = checkPartnerCompliance({
      partnerId: 'sup-anand',
      documents: [doc({ validUntil: '2026-08-20' }), doc({ documentId: 'd-2', kind: 'gst_registration' })],
      required,
      today: '2026-08-04',
    });
    expect(check.compliant).toBe(true);
    const status = check.documents.find((d) => d.kind === 'fssai_licence');
    expect(status?.state).toBe('expiring');
    expect(status?.detail).toContain('before it stops a delivery');
  });

  it('never reads another partner\'s documents as cover', () => {
    const check = checkPartnerCompliance({
      partnerId: 'sup-anand',
      documents: [doc({ partnerId: 'sup-kumar' })],
      required: ['fssai_licence'],
      today: '2026-08-04',
    });
    expect(check.documents[0]?.state).toBe('missing');
  });

  it('the last day is still valid — an inclusive date is not an off-by-one', () => {
    const check = checkPartnerCompliance({
      partnerId: 'sup-anand',
      documents: [doc({ validUntil: '2026-08-04' })],
      required: ['fssai_licence'],
      today: '2026-08-04',
      warnWithinDays: 0,
    });
    expect(check.compliant).toBe(true);
    expect(check.documents[0]?.daysRemaining).toBe(0);
  });
});

const COMPLIANT = checkPartnerCompliance({
  partnerId: 'sup-anand', documents: [doc({})], required: ['fssai_licence'], today: '2026-08-04',
});
const NOT_COMPLIANT = checkPartnerCompliance({
  partnerId: 'sup-anand', documents: [doc({ validUntil: '2026-01-01' })],
  required: ['fssai_licence'], today: '2026-08-04',
});

describe('the portal is a door, not an authority (M24-FR-02)', () => {
  const submit = (over: Parameters<typeof acceptSubmission>[0]) => acceptSubmission(over);

  it('a catalogue lands for REVIEW — nothing a supplier submits takes effect on its own', () => {
    const result = submit({
      submissionId: 'sub-1', session: session(), kind: 'catalogue',
      compliance: COMPLIANT, at: '2026-08-04T09:00:00Z',
    });
    expect(result.accepted).toBe(true);
    expect(result.requiresReview).toBe(true);
    expect(result.detail).toContain('nothing a supplier submits takes effect on its own');
  });

  it('an RFQ response and a claim are proposals too', () => {
    for (const kind of ['rfq_response', 'claim'] as const) {
      const result = submit({
        submissionId: `sub-${kind}`, session: session(), kind,
        compliance: COMPLIANT, at: '2026-08-04T09:00:00Z',
      });
      expect(result.requiresReview).toBe(true);
    }
  });

  it('an expired licence BLOCKS an ASN and an invoice', () => {
    for (const kind of ['asn', 'invoice', 'catalogue'] as const) {
      const result = submit({
        submissionId: `sub-${kind}`, session: session(), kind,
        compliance: NOT_COMPLIANT, at: '2026-08-04T09:00:00Z',
      });
      expect(result.accepted).toBe(false);
      expect(result.outcome).toBe('not_compliant');
      expect(result.detail).toContain('cannot deliver or bill');
    }
  });

  it('REFUSES to acknowledge another supplier\'s purchase order', () => {
    const result = submit({
      submissionId: 'sub-9', session: session(), kind: 'po_acknowledgement',
      compliance: COMPLIANT, orderPartnerId: 'sup-kumar', at: '2026-08-04T09:00:00Z',
    });
    expect(result.outcome).toBe('not_your_order');
    expect(result.detail).toContain('refused and recorded');
  });

  it('is idempotent — a retried submission is a duplicate, not a second invoice', () => {
    const result = submit({
      submissionId: 'sub-1', session: session(), kind: 'invoice', compliance: COMPLIANT,
      alreadySubmittedIds: ['sub-1'], at: '2026-08-04T09:00:00Z',
    });
    expect(result.outcome).toBe('duplicate');
    expect(result.accepted).toBe(false);
  });

  it('refuses a submission kind the login has no grant for', () => {
    const result = submit({
      submissionId: 'sub-2', session: session({ grants: ['view_orders'] }), kind: 'invoice',
      compliance: COMPLIANT, at: '2026-08-04T09:00:00Z',
    });
    expect(result.outcome).toBe('no_grant');
  });
});

describe('a statement adds up, and a dispute is not a payment (M24-FR-04)', () => {
  const LINES: readonly StatementLine[] = [
    { partnerId: 'sup-anand', tenantId: 't-sre', documentRef: 'INV-1', kind: 'invoice', date: '2026-07-02', amountMinor: 500_000, status: 'open' },
    { partnerId: 'sup-anand', tenantId: 't-sre', documentRef: 'INV-2', kind: 'invoice', date: '2026-07-11', amountMinor: 320_000, status: 'open' },
    { partnerId: 'sup-anand', tenantId: 't-sre', documentRef: 'CN-1', kind: 'credit_note', date: '2026-07-14', amountMinor: -45_000, status: 'open' },
    { partnerId: 'sup-anand', tenantId: 't-sre', documentRef: 'PAY-1', kind: 'payment', date: '2026-07-28', amountMinor: -500_000, status: 'settled' },
    { partnerId: 'sup-anand', tenantId: 't-sre', documentRef: 'INV-3', kind: 'invoice', date: '2026-07-30', amountMinor: 88_000, status: 'disputed' },
    // Another supplier's invoice sitting in the same table.
    { partnerId: 'sup-kumar', tenantId: 't-sre', documentRef: 'INV-K', kind: 'invoice', date: '2026-07-30', amountMinor: 999_000, status: 'open' },
  ];

  it('is built from the partner\'s own lines and reconciles exactly', () => {
    const statement = buildStatement({ session: session(), lines: LINES, openingMinor: 100_000 });
    // Five of their own lines including the disputed one, which is shown but not owed.
    // The competitor's INV-K is not among them.
    expect(statement.lines).toHaveLength(5);
    expect(statement.lines.map((l) => l.documentRef)).not.toContain('INV-K');
    expect(statement.invoicedMinor).toBe(820_000);
    expect(statement.creditedMinor).toBe(45_000);
    expect(statement.paidMinor).toBe(500_000);
    // 100,000 + 820,000 − 45,000 − 500,000 = 375,000
    expect(statement.closingMinor).toBe(375_000);
    expect(statement.reconciles).toBe(true);
  });

  it('shows the disputed amount SEPARATELY — neither owed nor written off', () => {
    const statement = buildStatement({ session: session(), lines: LINES, openingMinor: 100_000 });
    expect(statement.disputedMinor).toBe(88_000);
    expect(statement.closingMinor).not.toBe(375_000 + 88_000);
    expect(statement.detail).toContain('neither owed nor written off');
  });

  it('carries a debit note into the balance rather than dropping it', () => {
    const withDebit: readonly StatementLine[] = [
      ...LINES,
      { partnerId: 'sup-anand', tenantId: 't-sre', documentRef: 'DN-1', kind: 'debit_note', date: '2026-07-31', amountMinor: 12_000, status: 'open' },
    ];
    const statement = buildStatement({ session: session(), lines: withDebit, openingMinor: 100_000 });
    expect(statement.debitedMinor).toBe(12_000);
    expect(statement.closingMinor).toBe(387_000);
    expect(statement.reconciles).toBe(true);
  });

  it('an empty statement without the grant says PERMISSION, not "you owe nothing"', () => {
    const statement = buildStatement({
      session: session({ grants: ['view_orders'] }), lines: LINES, openingMinor: 100_000,
    });
    expect(statement.accessible).toBe(false);
    expect(statement.detail).toContain('NOT a balance of zero');
  });
});

describe('refusals are audited as loudly as successes (hard rule #6)', () => {
  it('marks a cross-partner refusal a security event without being told', () => {
    const entry = auditPartnerAction({
      session: session(), action: 'view_orders', outcome: 'not_your_data',
      detail: 'asked for sup-kumar', at: '2026-08-04T09:00:00Z',
    });
    expect(entry.securityEvent).toBe(true);
    expect(entry.partnerId).toBe('sup-anand');
    expect(entry.userId).toBe('u-anand-1');
  });

  it('does not mark an ordinary refusal a security event', () => {
    const entry = auditPartnerAction({
      session: session(), action: 'submit_invoice', outcome: 'no_grant',
      detail: 'no grant', at: '2026-08-04T09:00:00Z',
    });
    expect(entry.securityEvent).toBe(false);
  });

  it('surfaces somebody trying doors, but not a single mis-click', () => {
    const attempt = (n: number) =>
      auditPartnerAction({
        session: session(), action: 'view_orders', outcome: 'not_your_data',
        detail: `attempt ${n}`, at: `2026-08-04T0${n}:00:00Z`,
      });
    expect(findProbing([attempt(1)])).toEqual([]);
    const pattern = findProbing([attempt(1), attempt(2), attempt(3)]);
    expect(pattern).toHaveLength(1);
    expect(pattern[0]?.attempts).toBe(3);
    expect(pattern[0]?.detail).toContain('somebody trying doors');
  });

  it('ignores successful reads when looking for probing', () => {
    const ok = auditPartnerAction({
      session: session(), action: 'view_orders', outcome: 'allowed',
      detail: 'fine', at: '2026-08-04T09:00:00Z',
    });
    expect(findProbing([ok, ok, ok, ok])).toEqual([]);
  });
});
