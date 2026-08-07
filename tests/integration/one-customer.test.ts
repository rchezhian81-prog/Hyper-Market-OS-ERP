import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { Client } from 'pg';
import { pgClient } from '../../packages/persistence/src/pg-client';
import { SqlEventStore } from '../../packages/persistence/src/event-store';
import { runMigrations } from '../../packages/persistence/src/migrations';
import { makeEvent } from '../../packages/contracts/src/event';
import {
  searchCatalogue,
  reviewCart,
  recommend,
  type StorefrontProduct,
} from '../../packages/storefront/src/browse';
import {
  checkServiceability,
  bookSlot,
  placeOrder,
  privacyCentre,
  changeConsent,
  type Slot,
} from '../../packages/storefront/src/checkout';
import { redeemCoupon, type Coupon } from '../../packages/loyalty/src/coupons';
import {
  balanceOf,
  redeemValue,
  findDoubleSpends,
  type Instrument,
  type ValueMovement,
} from '../../packages/loyalty/src/stored-value';
import { planCampaign } from '../../packages/service-desk/src/campaigns';
import {
  assessFirstResponse,
  grantCompensation,
  approveDraft,
  type ServiceCase,
} from '../../packages/service-desk/src/service-cases';
import { buildProfile } from '../../packages/customer/src/segments';
import { planErasure, type DataSubjectRequest } from '../../packages/customer/src/data-rights';
import {
  publishTemplateVersion,
  issueDocument,
  reproduceDocument,
  type Renderer,
} from '../../packages/documents/src/templates';

/**
 * STAGE 14 — customer commerce.
 *
 * Gate (roadmap §21): **one customer, end to end, and every promise the shop makes to
 * them is one it can keep.**
 *
 * A single person is followed through the whole customer-facing product against a REAL
 * PostgreSQL: browsing, a coupon, a gift card their household is also spending, an
 * out-of-area address, a slot, a payment the bank does not answer, a complaint,
 * compensation that needs a second signature, an AI reply nobody sends, a marketing
 * campaign they are excluded from, and finally a request to be forgotten that keeps the
 * tax invoices and says so.
 *
 * Set DATABASE_URL to run; without it the suite skips rather than passing quietly.
 */

const DATABASE_URL = process.env['DATABASE_URL'];
const TENANT = '66666666-6666-6666-6666-666666666666';
const RUN = `c${Date.now().toString(36)}`;
const CUSTOMER = `c-priya-${RUN}`;
const HOUSEHOLD = `hh-${RUN}`;

const STORE_LOCATION = { lat: 11.0168, lon: 76.9558 };
const HER_HOME = { lat: 11.0268, lon: 76.9658 };
const HER_MOTHERS_HOUSE = { lat: 11.4, lon: 77.4 };

const CATALOGUE: StorefrontProduct[] = [
  { productId: 'p-atta', name: 'Aashirvaad Atta 5kg', nameTa: 'ஆஷீர்வாத் ஆட்டா 5கிலோ', brand: 'Aashirvaad', categoryId: 'grocery', unitPriceMinor: 26_500, uom: 'ea', barcodes: ['8901030865278'], status: 'active', availableMinor: 40, availabilityAgeMinutes: 4 },
  { productId: 'p-oil', name: 'Sunflower Oil 1L', categoryId: 'grocery', unitPriceMinor: 17_500, uom: 'ea', barcodes: ['8901030000012'], status: 'active', availableMinor: 2, availabilityAgeMinutes: 4 },
  { productId: 'p-ghee', name: 'Ghee 1L', categoryId: 'grocery', unitPriceMinor: 62_000, uom: 'ea', barcodes: ['8901030000029'], status: 'active', availableMinor: 0, availabilityAgeMinutes: 4 },
  { productId: 'p-recall', name: 'Aashirvaad Multigrain', categoryId: 'grocery', unitPriceMinor: 31_000, uom: 'ea', barcodes: ['8901030000036'], status: 'active', recallBlock: true, availableMinor: 12, availabilityAgeMinutes: 4 },
];

describe.skipIf(!DATABASE_URL)('Stage 14 — one customer, end to end (real PostgreSQL)', () => {
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

  it('she searches with a typo and never sees what the till would refuse', () => {
    const hits = searchCatalogue({ query: 'aashirwad', products: CATALOGUE });
    const ids = hits.map((h) => h.product.productId);

    expect(ids).toContain('p-atta');
    // The recalled multigrain would also match "aashirvaad" — it is excluded entirely.
    expect(ids).not.toContain('p-recall');
    expect(hits[0]?.match).toBe('fuzzy');

    // And in Tamil.
    expect(searchCatalogue({ query: 'ஆஷீர்வாத்', products: CATALOGUE, language: 'ta' }).length).toBeGreaterThan(0);
  });

  it('her cart is corrected BEFORE the payment screen, not at the door', () => {
    const review = reviewCart({
      lines: [
        { productId: 'p-atta', quantityMinor: 2 },
        { productId: 'p-oil', quantityMinor: 5 },
        { productId: 'p-ghee', quantityMinor: 1 },
      ],
      products: CATALOGUE,
    });

    expect(review.shortfalls[0]?.detail).toBe('only 2 of 5 available');
    expect(review.unavailable.map((l) => l.productId)).toEqual(['p-ghee']);
    // ₹530.00 of atta + ₹350.00 of oil, and nothing for the ghee she cannot have.
    expect(review.subtotalMinor).toBe(53_000 + 35_000);
    expect(review.detail).toContain('rather than at the payment screen');
  });

  it('she has not consented to profiling, so the app says so instead of quietly showing less', () => {
    const result = recommend({
      customerRef: CUSTOMER,
      consents: ['service'],
      aggregateAlsoBought: [{ productId: 'p-oil', count: 90 }],
      personalHistory: [{ productId: 'p-atta', lastBoughtAt: '2026-07-20T10:00:00Z' }],
    });
    expect(result.recommendations.every((r) => r.basis === 'aggregate')).toBe(true);
    expect(result.personalisationOmitted).toContain('not consented to profiling');
  });

  it('her coupon works offline, and the second attempt on another lane does not', () => {
    const coupon: Coupon = {
      code: `SAVE50-${RUN}`, kind: 'amount_off', valueMinor: 5_000,
      issuedAt: '2026-08-01T00:00:00Z', validUntil: '2026-08-31',
      maxRedemptions: 1, maxPerCustomer: 1,
    };
    const redemption = { redemptionId: `RD-${RUN}-1`, code: coupon.code, customerRef: CUSTOMER, at: '2026-08-05T10:00:00Z', saleId: `S-${RUN}` };

    const first = redeemCoupon({
      coupon, redemption, knownRedemptions: [], basketMinor: 88_000,
      cacheAgeMinutes: 90, staleAfterMinutes: 15,
    });
    expect(first.redeemed).toBe(true);
    expect(first.discountMinor).toBe(5_000);
    // The lane is offline with an old list, and it says so rather than pretending.
    expect(first.countMayBeStale).toBe(true);

    const second = redeemCoupon({
      coupon,
      redemption: { ...redemption, redemptionId: `RD-${RUN}-2`, saleId: `S-${RUN}-b` },
      knownRedemptions: [redemption],
      basketMinor: 40_000,
    });
    expect(second.redeemed).toBe(false);
    expect(second.outcome).toBe('limit_reached');
  });

  it('her household gift card is spent twice at once — and BOTH are kept', () => {
    const card: Instrument = {
      instrumentId: `GC-${RUN}`, kind: 'gift_card', ownerRef: HOUSEHOLD,
      issuedAt: '2026-07-01T00:00:00Z', expiresOn: '2027-06-30',
    };
    const loaded: ValueMovement[] = [
      { movementId: `${RUN}-load`, instrumentId: card.instrumentId, kind: 'issue', deltaMinor: 50_000, at: '2026-07-01T00:00:00Z', channel: 'store' },
    ];

    // She pays at the till, offline, within the cap.
    const atTill = redeemValue({
      instrument: card,
      movements: loaded,
      movement: { movementId: `${RUN}-till`, instrumentId: card.instrumentId, kind: 'redeem', deltaMinor: -50_000, at: '2026-08-05T14:00:00Z', channel: 'store', customerRef: CUSTOMER, capturedOffline: true },
      policy: { offlineCapMinor: 50_000 },
    });
    expect(atTill.redeemed).toBe(true);

    // Her mother spends the same balance on the app twenty seconds later.
    const onApp: ValueMovement = { movementId: `${RUN}-app`, instrumentId: card.instrumentId, kind: 'redeem', deltaMinor: -50_000, at: '2026-08-05T14:00:20Z', channel: 'app', customerRef: `c-mother-${RUN}` };

    const all = [...loaded, atTill.movement!, onApp];
    expect(balanceOf(all, card.instrumentId)).toBe(-50_000);

    const doubles = findDoubleSpends(all, [card]);
    expect(doubles).toHaveLength(1);
    expect(doubles[0]?.overspentMinor).toBe(50_000);
    expect(doubles[0]?.channels).toEqual(['app', 'store']);
    // Neither is silently reversed. Two people genuinely received goods.
    expect(doubles[0]?.movements.map((m) => m.movementId)).toEqual([`${RUN}-till`, `${RUN}-app`]);
    expect(doubles[0]?.detail).toContain('nothing is silently reversed');
  });

  it('her mother\'s address is out of area — refused clearly, before a basket is filled', () => {
    const result = checkServiceability({
      storeLocation: STORE_LOCATION,
      deliveryLocation: HER_MOTHERS_HOUSE,
      basketMinor: 88_000,
      policy: { radiusMetres: 10_000, deliveryFeeMinor: 4_000, freeDeliveryAboveMinor: 100_000 },
    });
    expect(result.serviceable).toBe(false);
    expect(result.detail).toContain('we deliver up to 10 km');
    expect(result.detail).toContain('you can still collect from the store');
  });

  it('her own address is fine, the fee is stated up front, and the full slot offers alternatives', () => {
    const serviceable = checkServiceability({
      storeLocation: STORE_LOCATION, deliveryLocation: HER_HOME, basketMinor: 88_000,
      policy: { radiusMetres: 10_000, deliveryFeeMinor: 4_000, freeDeliveryAboveMinor: 100_000 },
    });
    expect(serviceable.serviceable).toBe(true);
    expect(serviceable.deliveryFeeMinor).toBe(4_000);
    expect(serviceable.detail).toContain('free above 100000');

    const slots: Slot[] = [
      { slotId: 's-full', startsAt: '2026-08-05T16:00:00Z', endsAt: '2026-08-05T18:00:00Z', capacity: 8, booked: 8, kind: 'delivery' },
      { slotId: 's-open', startsAt: '2026-08-05T18:00:00Z', endsAt: '2026-08-05T20:00:00Z', capacity: 8, booked: 2, kind: 'delivery' },
    ];
    const full = bookSlot({ slotId: 's-full', slots, now: '2026-08-05T14:00:00Z' });
    expect(full.booked).toBe(false);
    expect(full.alternatives.map((a) => a.slotId)).toEqual(['s-open']);

    expect(bookSlot({ slotId: 's-open', slots, now: '2026-08-05T14:00:00Z' }).booked).toBe(true);
  });

  it('HER BANK DOES NOT ANSWER — nothing is confirmed and nothing is picked', async () => {
    const serviceable = checkServiceability({
      storeLocation: STORE_LOCATION, deliveryLocation: HER_HOME, basketMinor: 88_000,
      policy: { radiusMetres: 10_000, deliveryFeeMinor: 4_000 },
    });

    const pending = placeOrder({
      orderId: `O-${RUN}`, customerRef: CUSTOMER, slotId: 's-open',
      itemsMinor: 88_000, deliveryFeeMinor: 4_000, serviceability: serviceable,
      payment: { result: 'unknown', reason: 'gateway timeout after 30s' },
    });
    expect(pending.state).toBe('payment_pending');
    expect(pending.releaseForPicking).toBe(false);
    expect(pending.tellTheCustomer).toContain('do not pay again');

    // The bank answers later. The order is placed, and banked in PostgreSQL.
    const confirmed = placeOrder({
      orderId: `O-${RUN}`, customerRef: CUSTOMER, slotId: 's-open',
      itemsMinor: 88_000, deliveryFeeMinor: 4_000, serviceability: serviceable,
      payment: { result: 'authorised', providerRef: `tok_${RUN}` },
    });
    expect(confirmed.state).toBe('confirmed');
    expect(confirmed.releaseForPicking).toBe(true);
    expect(confirmed.payableMinor).toBe(92_000);

    await store.append(
      TENANT,
      `order/${RUN}`,
      makeEvent({
        id: `O-${RUN}`,
        type: 'OrderPlaced',
        occurredAt: '2026-08-05T14:05:00Z',
        idempotencyKey: `${RUN}:order`,
        source: 'app',
        payload: { orderId: `O-${RUN}`, customerRef: CUSTOMER, payableMinor: confirmed.payableMinor, providerRef: confirmed.providerRef },
      }),
    );
    const banked = await store.readStream(TENANT, `order/${RUN}`);
    expect(banked).toHaveLength(1);
    // The token is stored. A card number never was, and never could be.
    expect((banked[0]?.event.payload as { providerRef: string }).providerRef).toBe(`tok_${RUN}`);
  });

  it('her invoice is frozen: the shop moves premises and July\'s copy does not change', () => {
    const render: Renderer = (t, d) => `${t.branding?.['address'] ?? ''}\n${t.body}\nTotal: ${String(d['totalMinor'])}`;
    const v1 = publishTemplateVersion({
      templateId: `tpl-${RUN}`, tenantId: TENANT, kind: 'tax_invoice', body: 'TAX INVOICE',
      branding: { address: '12 Old Street, Coimbatore' }, createdBy: 'u-designer',
      approvedBy: 'u-finance', changeNote: 'initial', at: '2026-07-01T09:00:00Z', existing: [],
    }).template!;

    const hers = issueDocument({
      documentId: `INV-${RUN}`, tenantId: TENANT, kind: 'tax_invoice', subjectRef: `O-${RUN}`,
      templateId: `tpl-${RUN}`, versions: [v1], data: { totalMinor: 92_000 },
      render, issuedBy: 'u-system', at: '2026-08-05T14:10:00Z',
    }).document!;
    expect(hers.content).toContain('12 Old Street');

    // The shop moves. A new version is published; v1 is kept.
    const v2 = publishTemplateVersion({
      templateId: `tpl-${RUN}`, tenantId: TENANT, kind: 'tax_invoice', body: 'TAX INVOICE (GST)',
      branding: { address: '88 New Road, Coimbatore' }, createdBy: 'u-designer',
      approvedBy: 'u-finance', changeNote: 'we moved premises', at: '2026-09-01T09:00:00Z',
      existing: [v1],
    });
    expect(v2.version).toBe(2);

    // Her invoice, reproduced months later, is byte-for-byte what she received.
    const reproduced = reproduceDocument(hers);
    expect(reproduced.content).toContain('12 Old Street');
    expect(reproduced.content).not.toContain('88 New Road');
    expect(reproduced.templateVersion).toBe(1);
  });

  it('the milk was sour: first response is breached, compensation needs a second name, AI drafts only', () => {
    // The desk can still look her up to answer her OWN complaint, even though she
    // refused marketing: that is performance of the contract, not consent (M16-FR-04).
    const forService = buildProfile({
      customerRef: CUSTOMER,
      orders: [{ orderId: `O-${RUN}`, customerRef: CUSTOMER, at: '2026-08-05T14:05:00Z', netMinor: 88_000, marginMinor: 17_600, channel: 'app' }],
      purpose: 'service',
      asOf: '2026-08-05T19:00:00Z',
    });
    expect(forService.segment).not.toBe('not_profiled');
    expect(forService.lifetimeMarginMinor).toBe(17_600);

    // The same customer, for marketing, is refused — with the reason.
    const forMarketing = buildProfile({
      customerRef: CUSTOMER,
      orders: [{ orderId: `O-${RUN}`, customerRef: CUSTOMER, at: '2026-08-05T14:05:00Z', netMinor: 88_000, marginMinor: 17_600, channel: 'app' }],
      purpose: 'marketing',
      asOf: '2026-08-05T19:00:00Z',
    });
    expect(forMarketing.segment).toBe('not_profiled');

    const complaint: ServiceCase = {
      caseId: `CASE-${RUN}`, tenantId: TENANT, kind: 'complaint', customerRef: CUSTOMER,
      openedAt: '2026-08-05T19:00:00Z', assignedTo: 'u-agent', priority: 'urgent',
      state: 'open', summary: 'Delivered milk was sour', orderRef: `O-${RUN}`,
    };

    // Ninety minutes with nobody replying, against a 30-minute first-response target.
    const response = assessFirstResponse({ serviceCase: complaint, now: '2026-08-05T20:30:00Z' });
    expect(response.status).toBe('breached');
    expect(response.shouldEscalate).toBe(true);
    expect(response.detail).toContain('this is the wait a customer actually feels');

    // The agent wants to give ₹500 of goodwill; their limit is ₹200.
    const unapproved = grantCompensation({
      serviceCase: complaint, kind: 'goodwill_credit', amountMinor: 50_000,
      grantedBy: 'u-agent', reason: 'sour milk, second complaint this month',
      agentAuthorityMinor: 20_000, at: '2026-08-05T20:40:00Z',
    });
    expect(unapproved.granted).toBe(false);
    expect(unapproved.outcome).toBe('needs_approval');

    const approved = grantCompensation({
      serviceCase: complaint, kind: 'goodwill_credit', amountMinor: 50_000,
      grantedBy: 'u-agent', reason: 'sour milk, second complaint this month',
      agentAuthorityMinor: 20_000, at: '2026-08-05T20:45:00Z',
      approval: { subjectRef: complaint.caseId, status: 'approved', decidedBy: 'u-manager', reason: 'repeat issue, keep the customer' },
    });
    expect(approved.granted).toBe(true);
    expect(approved.approvedBy).toBe('u-manager');

    // A model writes the reply. It is not sent until a person puts their name to it.
    const reply = approveDraft({
      draft: {
        draftId: `DR-${RUN}`, caseId: complaint.caseId,
        text: 'We are very sorry the milk was sour. We have credited ₹500 to your account.',
        modelRef: 'gw/model-a', generatedAt: '2026-08-05T20:41:00Z',
        evidenceRefs: [complaint.caseId, `O-${RUN}`], approved: false,
      },
      decision: 'approved', approvedBy: 'u-manager', at: '2026-08-05T20:46:00Z',
    });
    expect(reply.sendable).toBe(true);
    if (!reply.sendable) throw new Error('unreachable');
    expect(reply.approvedBy).toBe('u-manager');
  });

  it('she is excluded from the Diwali campaign, and the count says so', () => {
    const plan = planCampaign({
      campaign: {
        campaignId: `CMP-${RUN}`, purpose: 'marketing', channel: 'whatsapp',
        templateId: 'tpl-diwali', templateApproved: true, containsPromotion: true,
      },
      audience: [CUSTOMER, `c-other-${RUN}`],
      consents: [
        { customerRef: CUSTOMER, granted: [{ purpose: 'service', channel: 'whatsapp' }] },
        { customerRef: `c-other-${RUN}`, granted: [{ purpose: 'marketing', channel: 'whatsapp' }] },
      ],
    });
    expect(plan.sendTo).toEqual([`c-other-${RUN}`]);
    expect(plan.excludedCount).toBe(1);
    expect(plan.detail).toContain('the number is stated so the check stays defensible');

    // Her order confirmation still reaches her — that rides the contract, not consent.
    const transactional = planCampaign({
      campaign: {
        campaignId: `CMP-${RUN}-tx`, purpose: 'transactional', channel: 'whatsapp',
        templateId: 'tpl-order', templateApproved: true, containsPromotion: false,
      },
      audience: [CUSTOMER],
      consents: [{ customerRef: CUSTOMER, granted: [{ purpose: 'service', channel: 'whatsapp' }] }],
    });
    expect(transactional.sendTo).toEqual([CUSTOMER]);
  });

  it('SHE ASKS TO BE FORGOTTEN — and is told exactly what stays and why', () => {
    // The privacy centre first: it shows her everything, including what cannot go.
    const centre = privacyCentre({
      customerRef: CUSTOMER,
      categories: [
        { category: 'Marketing preferences', recordCount: 1 },
        { category: 'App activity', recordCount: 412 },
        { category: 'Sales invoices', recordCount: 1, retained: true },
      ],
      consents: ['service'],
    });
    expect(centre.held[2]?.summary).toContain('kept because the law requires it');

    // Switching marketing off applies to the very next message.
    const off = changeConsent({ customerRef: CUSTOMER, purpose: 'marketing', granted: false, at: '2026-08-06T09:00:00Z' });
    expect(off.effectiveImmediately).toBe(true);
    expect(off.detail).toContain('the very next message, not to the next batch');

    const request: DataSubjectRequest = {
      requestId: `DSR-${RUN}`, tenantId: TENANT, customerRef: CUSTOMER, kind: 'erasure',
      raisedAt: '2026-08-06T09:05:00Z', verifiedBy: 'u-dpo', verifiedAt: '2026-08-06T10:00:00Z',
      state: 'verified', dueBy: '2026-09-05',
    };
    const plan = planErasure({
      request,
      categories: [
        { category: 'Marketing preferences', recordCount: 1 },
        { category: 'App activity', recordCount: 412 },
        { category: 'Sales invoices', recordCount: 1, retentionBasis: 'tax_invoice', retainUntil: '2034-03-31', minimisable: true },
        { category: 'Audit trail', recordCount: 96, retentionBasis: 'audit_evidence', minimisable: true },
      ],
      at: '2026-08-06T11:00:00Z',
    });

    expect(plan.erasedRecordCount).toBe(413);
    expect(plan.minimisedRecordCount).toBe(97);
    expect(plan.partial).toBe(true);

    const statement = plan.customerStatement.join(' ');
    expect(statement).toContain('income-tax law requires sales invoices to be kept for eight years');
    expect(statement).toContain('until 2034-03-31');
    expect(statement).toContain('can never be deleted by anyone, including us');
    expect(statement).toContain('rather tell you exactly which than let you believe they were gone');
    expect(statement).toContain('not used for marketing');
  });

  it('and her order, invoice and audit trail survive every one of those requests', async () => {
    // The database refuses to delete the events behind them — including for an erasure.
    const refusalFor = async (sql: string): Promise<string> => {
      try {
        await client.query(sql, [TENANT]);
        return 'THE DATABASE ALLOWED IT';
      } catch (error) {
        return (error as Error).message;
      }
    };
    expect(await refusalFor('DELETE FROM event_ledger WHERE tenant_id = $1')).toMatch(/append-only/i);

    const still = await store.readStream(TENANT, `order/${RUN}`);
    expect(still).toHaveLength(1);
    expect((still[0]?.event.payload as { customerRef: string }).customerRef).toBe(CUSTOMER);
  });
});
