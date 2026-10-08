import { describe, it, expect } from 'vitest';
import {
  createBuyingSession, lineArithmeticErrors, UnreadableInvoiceFileError,
  SUPPLIER_INVOICE_TEMPLATE,
  type BuyingConfig, type BuyingPorts, type InvoiceLine,
  type ProposePurchaseOrderPort, type ProposePurchaseOrderOutcome,
} from '../../apps/web-erp/src/buying-session';
import type { DecidedRequest } from '../../packages/approvals/src/index';
import { money } from '../../packages/contracts/src/money';
import { SyncOutbox } from '../../packages/sync/src/outbox';
import { SUPPLIER_INVOICE_CAPTURED } from '../../apps/web-erp/src/buying-session';
import { isRelayable } from '../../packages/sync/src/device-relay';
import { pathFor } from '../../edge/sync-agent/src/http-transport';

/**
 * **The buyer's surface (M06 · M07 · M30 · D03 · §28).**
 *
 * Audit finding A-03 is line-by-line invoice pain: somebody retypes an eighty-line supplier invoice
 * every week. Everything needed to kill that existed and was tested — and **nothing captured an
 * invoice**, so `matchLines` came back empty for every one and the three-way match refused every
 * time, correctly and uselessly.
 *
 * The two controls under test are the ones that make bulk capture safe rather than fast:
 *   • the lines must add up to the total printed on the paper;
 *   • each line's own quantity × price must equal its printed line total.
 */

const AT = '2026-08-06T10:00:00.000Z';

const CONFIG: BuyingConfig = {
  tenantId: 't1', buyerId: 'u-buyer', currency: 'INR',
  quantityToleranceBps: 0, priceToleranceBps: 100, immaterialMinor: 100,
};

const approvalBy = (decidedBy: string, subjectRef: string): DecidedRequest => ({
  id: `ap-${subjectRef}`, subjectType: 'supplier_invoice', subjectRef,
  requestedBy: 'u-buyer', branchId: null, value: null,
  status: 'approved', decidedBy, reason: 'checked_with_supplier', decidedAt: AT,
});

function ports(over: Partial<BuyingPorts> = {}): BuyingPorts {
  return {
    knownProductIds: () => ['p1', 'p2', 'p3'],
    orderedLines: () => [
      { productId: 'p1', qty: 10, unitMinor: 100_00 },
      { productId: 'p2', qty: 5, unitMinor: 50_00 },
    ],
    receivedLines: () => [
      { productId: 'p1', qty: 10 },
      { productId: 'p2', qty: 5 },
    ],
    capturedLines: () => [],
    ...over,
  };
}

const session = (over: Partial<BuyingPorts> = {}, outbox = new SyncOutbox()) => createBuyingSession(CONFIG, ports(over), outbox);

/** A clean two-line invoice: 10 × ₹100 and 5 × ₹50 = ₹1,250.00 */
const CLEAN_FILE = [
  'productId,quantity,unitPriceMinor,lineTotalMinor',
  'p1,10,10000,100000',
  'p2,5,5000,25000',
].join('\n');
const CLEAN_TOTAL = 125_000;

describe('the lines must add up to the total printed on the paper', () => {
  it('accepts a file whose lines reconcile to the invoice total', () => {
    const preview = session().previewInvoice({ text: CLEAN_FILE, declaredTotalMinor: CLEAN_TOTAL });
    expect(preview.problems).toEqual([]);
    expect(preview.sumMinor).toBe(CLEAN_TOTAL);
    expect(preview.readyToApprove).toBe(true);
    expect(preview.lines).toHaveLength(2);
  });

  it('refuses a clean file whose lines do NOT add up to the printed total', () => {
    // They disagree for exactly two reasons — a line is wrong, or a line is missing — and both
    // mean paying something other than what was agreed.
    const preview = session().previewInvoice({ text: CLEAN_FILE, declaredTotalMinor: 200_000 });
    expect(preview.preview.reconciles).toBe(false);
    expect(preview.readyToApprove).toBe(false);

    const outcome = session().captureInvoice({
      invoiceId: 'INV-1', supplierId: 's1', preview,
    });
    expect(outcome).toMatchObject({ ok: false, refusal: 'does_not_add_up_to_the_invoice_total' });
    if (outcome.ok) return;
    expect(outcome.detail).toMatch(/a line is wrong or a line is missing/i);
  });

  it('catches a missing line, which is what a total exists to catch', () => {
    // The realistic version: somebody's export dropped the last row. Every remaining line is
    // perfect, and only the total notices.
    const short = ['productId,quantity,unitPriceMinor,lineTotalMinor', 'p1,10,10000,100000'].join('\n');
    const preview = session().previewInvoice({ text: short, declaredTotalMinor: CLEAN_TOTAL });
    expect(preview.problems).toEqual([]); // nothing wrong with the line that IS there
    expect(preview.readyToApprove).toBe(false);
    expect(preview.sumMinor).toBe(100_000);
  });
});

describe('each line’s own arithmetic is checked', () => {
  it('catches a mistyped quantity, and names the line to look at', () => {
    // Invisible in a column of numbers, obvious the moment the three are multiplied.
    const wrong = [
      'productId,quantity,unitPriceMinor,lineTotalMinor',
      'p1,1,10000,100000', // says 1 × ₹100 = ₹1,000 — the quantity was meant to be 10
    ].join('\n');
    const preview = session().previewInvoice({ text: wrong, declaredTotalMinor: 100_000 });

    expect(preview.problems).toHaveLength(1);
    expect(preview.problems[0]?.line).toBe(2);
    expect(preview.problems[0]?.message).toMatch(/1 × 10000 is 10000, but the line says 100000/);
    expect(preview.problems[0]?.message).toMatch(/check this line against the paper invoice/i);
    expect(preview.readyToApprove).toBe(false);
  });

  it('is a real check on its own — the helper fires and stays quiet correctly', () => {
    expect(lineArithmeticErrors([{ quantity: '2', unitPriceMinor: '500', lineTotalMinor: '1000' }], [2])).toEqual([]);
    expect(lineArithmeticErrors([{ quantity: '2', unitPriceMinor: '500', lineTotalMinor: '1200' }], [7]))
      .toHaveLength(1);
    // A non-numeric cell is the import engine's problem to report, not this one's — reporting it
    // twice would tell somebody to check two different things about one mistake.
    expect(lineArithmeticErrors([{ quantity: 'ten', unitPriceMinor: '500', lineTotalMinor: '1200' }], [3])).toEqual([]);
  });
});

describe('the buyer sees every problem before anything is written', () => {
  it('names an unknown product by line, rather than importing it', () => {
    const unknown = [
      'productId,quantity,unitPriceMinor,lineTotalMinor',
      'p1,10,10000,100000',
      'p-nope,1,100,100',
    ].join('\n');
    const preview = session().previewInvoice({ text: unknown, declaredTotalMinor: 100_100 });
    expect(preview.problems.some((p) => p.kind === 'unknown_reference' && p.line === 3)).toBe(true);
    expect(preview.readyToApprove).toBe(false);
  });

  it('writes nothing at all while previewing', () => {
    // The whole point of the flow. Nothing below the preview has run.
    let captured = 0;
    const s = createBuyingSession(CONFIG, ports({ capturedLines: () => { captured += 1; return []; } }), new SyncOutbox());
    s.previewInvoice({ text: CLEAN_FILE, declaredTotalMinor: CLEAN_TOTAL });
    expect(captured).toBe(0);
  });

  it('refuses to capture a file that has problems, and says nothing was written', () => {
    const bad = ['productId,quantity,unitPriceMinor,lineTotalMinor', 'p1,1,10000,999'].join('\n');
    const preview = session().previewInvoice({ text: bad, declaredTotalMinor: 999 });
    const outcome = session().captureInvoice({
      invoiceId: 'INV-2', supplierId: 's1', preview,
    });
    expect(outcome).toMatchObject({ ok: false, refusal: 'file_has_problems' });
    if (outcome.ok) return;
    expect(outcome.detail).toMatch(/nothing has been written/i);
  });

  it('treats a file it cannot read as unreadable, never as empty', () => {
    // An empty parse would let the next step say "nothing to import", which sounds like a quiet
    // day rather than a supplier's invoice nobody has read.
    const ragged = ['productId,quantity,unitPriceMinor,lineTotalMinor', 'p1,10,10000'].join('\n');
    expect(() => session().previewInvoice({ text: ragged, declaredTotalMinor: 1 }))
      .toThrow(UnreadableInvoiceFileError);
  });
});

describe('capturing the bill — the buyer captures, head office checks (§28)', () => {
  const cleanPreview = () => session().previewInvoice({ text: CLEAN_FILE, declaredTotalMinor: CLEAN_TOTAL });

  it('captures a reconciling invoice, all of it', () => {
    const outcome = session().captureInvoice({
      invoiceId: 'INV-3', supplierId: 's1', preview: cleanPreview(),
    });
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.lines).toHaveLength(2);
    expect(outcome.totalMinor).toBe(CLEAN_TOTAL);
  });

  it('needs no checker: the signed-in buyer captures it, and NO checker name rides with it — the check is a second person\'s own act at head office', () => {
    // Head office never trusted a name typed on the buyer's screen; the check is the match, under the
    // checker's own sign-in. So the capture neither asks for one nor carries one.
    const outbox = new SyncOutbox();
    const s = session({}, outbox);
    const outcome = s.captureInvoice({ invoiceId: 'INV-4', supplierId: 's1', preview: cleanPreview() });
    expect(outcome.ok).toBe(true);
    const payload = outbox.find('invoice:INV-4')!.event.payload as Record<string, unknown>;
    expect(payload['capturedBy']).toBe(CONFIG.buyerId);
    expect(payload).not.toHaveProperty('approvedBy');
    expect(payload).not.toHaveProperty('approvedAt');
    expect(payload).not.toHaveProperty('approval');
  });

  it('refuses a file with nothing in it, and queues nothing', () => {
    const outbox = new SyncOutbox();
    const s = session({}, outbox);
    const empty = s.previewInvoice({ text: 'productId,quantity,unitPriceMinor,lineTotalMinor', declaredTotalMinor: 0 });
    expect(s.captureInvoice({ invoiceId: 'INV-5', supplierId: 's1', preview: empty }))
      .toMatchObject({ ok: false, refusal: 'nothing_to_capture' });
    expect(outbox.all()).toEqual([]);
  });

  it('refuses to capture the same invoice twice', () => {
    // Capturing it twice would double what this supplier is owed.
    const already: InvoiceLine[] = [{ productId: 'p1', quantity: 10, unitPriceMinor: 100_00, lineTotalMinor: 100_000 }];
    const s = createBuyingSession(CONFIG, ports({ capturedLines: () => already }), new SyncOutbox());
    const outcome = s.captureInvoice({
      invoiceId: 'INV-7', supplierId: 's1', preview: cleanPreview(),
    });
    expect(outcome).toMatchObject({ ok: false, refusal: 'already_captured' });
    if (outcome.ok) return;
    expect(outcome.detail).toMatch(/double what this supplier is owed/i);
  });
});

describe('the three-way match finally has lines to compare', () => {
  const captured: InvoiceLine[] = [
    { productId: 'p1', quantity: 10, unitPriceMinor: 100_00, lineTotalMinor: 100_000 },
    { productId: 'p2', quantity: 5, unitPriceMinor: 50_00, lineTotalMinor: 25_000 },
  ];

  it('agrees when the order, the delivery and the invoice agree', () => {
    const result = createBuyingSession(CONFIG, ports({ capturedLines: () => captured }), new SyncOutbox())
      .match({ poId: 'PO-1', invoiceId: 'INV-1' });
    expect(result.blocked).toBe(false);
    expect(result.payableMinor).toBe(125_000);
    expect(result.ownerAction).toMatch(/agree/i);
  });

  it('still REFUSES when no invoice has been captured — not checked is not clean', () => {
    // The state the whole system was in until today, and the reason this file exists.
    const result = session().match({ poId: 'PO-1', invoiceId: 'INV-nothing' });
    expect(result.blocked).toBe(true);
    expect(result.ownerAction).toMatch(/no order, delivery or invoice line was found to compare/i);
  });

  it('blocks and pays the lower figure when the supplier invoiced more than was delivered', () => {
    const over: InvoiceLine[] = [
      { productId: 'p1', quantity: 12, unitPriceMinor: 100_00, lineTotalMinor: 120_000 },
      { productId: 'p2', quantity: 5, unitPriceMinor: 50_00, lineTotalMinor: 25_000 },
    ];
    const result = createBuyingSession(CONFIG, ports({ capturedLines: () => over }), new SyncOutbox())
      .match({ poId: 'PO-1', invoiceId: 'INV-1' });

    expect(result.blocked).toBe(true);
    // Paying the invoice and investigating later is how an overcharge becomes permanent.
    expect(result.payableMinor).toBe(125_000);
    expect(result.withheldMinor).toBe(20_000);
  });

  it('blocks on a price the supplier put up without agreeing it', () => {
    const dearer: InvoiceLine[] = [
      { productId: 'p1', quantity: 10, unitPriceMinor: 120_00, lineTotalMinor: 120_000 },
      { productId: 'p2', quantity: 5, unitPriceMinor: 50_00, lineTotalMinor: 25_000 },
    ];
    const result = createBuyingSession(CONFIG, ports({ capturedLines: () => dearer }), new SyncOutbox())
      .match({ poId: 'PO-1', invoiceId: 'INV-1' });
    expect(result.blocked).toBe(true);
    expect(result.payableMinor).toBe(125_000); // at the ordered price, not the invoiced one
  });

  it('shows a product that was invoiced but never ordered or received', () => {
    // Skipping it would make the invoice agree with a delivery that did not happen.
    const ghost: InvoiceLine[] = [
      ...captured,
      { productId: 'p3', quantity: 4, unitPriceMinor: 25_00, lineTotalMinor: 10_000 },
    ];
    const result = createBuyingSession(CONFIG, ports({ capturedLines: () => ghost }), new SyncOutbox())
      .match({ poId: 'PO-1', invoiceId: 'INV-1' });

    const line = result.lines.find((l) => l.productId === 'p3');
    expect(line?.status).toBe('blocked');
    expect(line?.payableMinor).toBe(0);
    expect(result.blocked).toBe(true);
  });

  it('shows a product that was ordered and received but never invoiced', () => {
    const partial: InvoiceLine[] = [captured[0]!];
    const result = createBuyingSession(CONFIG, ports({ capturedLines: () => partial }), new SyncOutbox())
      .match({ poId: 'PO-1', invoiceId: 'INV-1' });
    expect(result.lines.map((l) => l.productId)).toEqual(['p1', 'p2']);
    expect(result.lines.find((l) => l.productId === 'p2')?.payableMinor).toBe(0);
  });
});

describe('a purchase order, so what is on order stops being "not known"', () => {
  it('issues one with somebody else’s approval', () => {
    const po = session().raisePurchaseOrder({
      id: 'PO-9', number: 'PO-0009', supplierId: 's1', at: AT,
      lines: [{ productId: 'p1', orderedQty: 10, unitCostMinor: 100_00 }],
      approval: {
        ...approvalBy('u-manager', 'PO-9'), subjectType: 'purchase_order',
      },
    });
    expect(po.status).toBe('issued');
    expect(po.total).toEqual(money(100_000, 'INR'));
    expect(po.approvedBy).toBe('u-manager');
  });

  it('refuses one the buyer approved themselves (§28)', () => {
    expect(() => session().raisePurchaseOrder({
      id: 'PO-10', number: 'PO-0010', supplierId: 's1', at: AT,
      lines: [{ productId: 'p1', orderedQty: 10, unitCostMinor: 100_00 }],
      approval: { ...approvalBy('u-buyer', 'PO-10'), subjectType: 'purchase_order' },
    })).toThrow();
  });

  it('refuses one for a blocked supplier (M06-FR-01)', () => {
    expect(() => session().raisePurchaseOrder({
      id: 'PO-11', number: 'PO-0011', supplierId: 's-blocked', at: AT,
      lines: [{ productId: 'p1', orderedQty: 1, unitCostMinor: 100 }],
      supplierBlocked: true,
      approval: { ...approvalBy('u-manager', 'PO-11'), subjectType: 'purchase_order' },
    })).toThrow();
  });
});

describe('the template stays the shape the shop was told to send', () => {
  it('asks for four columns and no more', () => {
    // Every extra column is one more thing to explain to somebody already retyping eighty lines.
    expect(SUPPLIER_INVOICE_TEMPLATE.columns.map((c) => c.name))
      .toEqual(['productId', 'quantity', 'unitPriceMinor', 'lineTotalMinor']);
  });

  it('sums the LINE TOTAL against the printed invoice total', () => {
    expect(SUPPLIER_INVOICE_TEMPLATE.amountColumn).toBe('lineTotalMinor');
  });
});

/**
 * **Raising a purchase order reaches head office (M06-FR-02 · §28 · P-08).**
 *
 * The buyer's screen used to ISSUE a PO locally with a name typed into an "approved by" box — a weak
 * §28 stand-in a determined buyer could put their own manager's name into. `proposeToCloud` PROPOSES the
 * order at head office under the buyer's OWN session instead: the cloud attributes the requisitioner to
 * the authenticated caller, and NO approver rides with the proposal, so issuing is a genuinely separate
 * second-person act the buyer cannot perform here. And it never claims an order it did not send — a
 * blocked supplier, an empty order or a dropped link comes back as an honest `proposed: false` (P-08).
 */
describe('raising a purchase order reaches head office (M06-FR-02 · §28)', () => {
  interface Recorder {
    calls: Parameters<ProposePurchaseOrderPort['post']>[0][];
    port: ProposePurchaseOrderPort;
  }
  // A port that records what the session sent and answers with a fixed outcome — the cloud's own verdict.
  const recordingPort = (outcome: ProposePurchaseOrderOutcome): Recorder => {
    const calls: Parameters<ProposePurchaseOrderPort['post']>[0][] = [];
    return { calls, port: { post: async (input) => { calls.push(input); return outcome; } } };
  };

  const CLEAN_LINES = [
    { productId: 'p1', orderedQty: 10, unitCostMinor: 5000 },
    { productId: 'p2', orderedQty: 4, unitCostMinor: 2500 },
  ]; // total = 60000

  it('proposes a clean order and reports proposed only after the cloud saved it', async () => {
    const rec = recordingPort({ proposed: true, requisitionedBy: 'u-buyer', totalMinor: 60000 });
    const s = session({ proposeOrder: () => rec.port });
    expect(s.canProposeToCloud).toBe(true);

    const out = await s.proposeToCloud({ poId: 'PO-20', supplierId: 'sup-1', lines: CLEAN_LINES });

    expect(out).toEqual({ proposed: true, requisitionedBy: 'u-buyer', totalMinor: 60000 });
    // The body carried the poId, the supplier and the lines with a proper Money unit cost.
    expect(rec.calls).toHaveLength(1);
    expect(rec.calls[0]?.poId).toBe('PO-20');
    expect(rec.calls[0]?.supplierId).toBe('sup-1');
    expect(rec.calls[0]?.lines).toEqual([
      { productId: 'p1', orderedQty: 10, unitCost: { minor: 5000, currency: 'INR' } },
      { productId: 'p2', orderedQty: 4, unitCost: { minor: 2500, currency: 'INR' } },
    ]);
  });

  it('carries NO approver — a proposed order is a proposal, not a self-approved issue (§28)', async () => {
    const rec = recordingPort({ proposed: true, requisitionedBy: 'u-buyer', totalMinor: 60000 });
    await session({ proposeOrder: () => rec.port }).proposeToCloud({ poId: 'PO-21', supplierId: 'sup-1', lines: CLEAN_LINES });
    const sent = rec.calls[0] as Record<string, unknown>;
    // Nothing in the proposal can name an approver; issuing is a separate authenticated second-person act.
    expect(sent).not.toHaveProperty('approval');
    expect(sent).not.toHaveProperty('approvedBy');
    expect(JSON.stringify(sent)).not.toContain('approv');
  });

  it('surfaces the cloud refusal verbatim and never reports a false raise', async () => {
    // The cloud refuses a blocked supplier — the screen shows exactly that, and reports NOT proposed.
    const rec = recordingPort({ proposed: false, reason: 'supplier is blocked, so no new order may be raised' });
    const out = await session({ proposeOrder: () => rec.port })
      .proposeToCloud({ poId: 'PO-22', supplierId: 'sup-blocked', lines: CLEAN_LINES });
    expect(out).toEqual({ proposed: false, reason: 'supplier is blocked, so no new order may be raised' });
    expect(rec.calls).toHaveLength(1); // it DID ask the cloud; the cloud is the authority on the block
  });

  it('refuses an empty order before any POST (P-08)', async () => {
    const rec = recordingPort({ proposed: true, requisitionedBy: 'u-buyer', totalMinor: 0 });
    const out = await session({ proposeOrder: () => rec.port })
      .proposeToCloud({ poId: 'PO-23', supplierId: 'sup-1', lines: [] });
    expect(out.proposed).toBe(false);
    if (!out.proposed) expect(out.reason).toContain('no lines');
    expect(rec.calls).toHaveLength(0); // nothing left the screen
  });

  it('refuses when no supplier is chosen before any POST (P-08)', async () => {
    const rec = recordingPort({ proposed: true, requisitionedBy: 'u-buyer', totalMinor: 60000 });
    const out = await session({ proposeOrder: () => rec.port })
      .proposeToCloud({ poId: 'PO-24', supplierId: '  ', lines: CLEAN_LINES });
    expect(out.proposed).toBe(false);
    if (!out.proposed) expect(out.reason).toContain('supplier');
    expect(rec.calls).toHaveLength(0);
  });

  it('a box with no cloud wired cannot propose, and says so rather than pretending', async () => {
    const s = session(); // default ports: no proposeOrder
    expect(s.canProposeToCloud).toBe(false);
    const out = await s.proposeToCloud({ poId: 'PO-25', supplierId: 'sup-1', lines: CLEAN_LINES });
    expect(out.proposed).toBe(false);
    if (!out.proposed) expect(out.reason).toContain('not connected to head office');
  });
});

describe('the capture is on the DURABLE device queue before the screen says ok (SP-7a · F02)', () => {
  const cleanPreview = (s: ReturnType<typeof session>) => s.previewInvoice({ text: CLEAN_FILE, declaredTotalMinor: CLEAN_TOTAL });

  it('queues ONE SupplierInvoiceCaptured keyed on the invoice — the invoice\'s own lines, the buyer who captured it and no checker, the order it names, no figures about the order or the delivery', () => {
    const outbox = new SyncOutbox();
    const s = session({}, outbox);
    const outcome = s.captureInvoice({ invoiceId: 'INV-8', supplierId: 's1', poId: 'PO-9', preview: cleanPreview(s) });
    expect(outcome.ok).toBe(true);
    const item = outbox.find('invoice:INV-8')!;
    expect(item.event.type).toBe(SUPPLIER_INVOICE_CAPTURED);
    expect(item.state).toBe('pending');
    expect(item.event.payload).toEqual({
      invoiceId: 'INV-8', supplierId: 's1', poId: 'PO-9',
      lines: [{ productId: 'p1', quantity: 10, unitPriceMinor: 100_00, lineTotalMinor: 100_000 }, { productId: 'p2', quantity: 5, unitPriceMinor: 50_00, lineTotalMinor: 25_000 }],
      declaredTotalMinor: CLEAN_TOTAL, capturedBy: 'u-buyer', capturedAt: expect.any(String) as string,
      storeId: null, source: 'buyer-screen',
    });
    expect(isRelayable(SUPPLIER_INVOICE_CAPTURED, 'manager')).toBe(true);
    expect(isRelayable(SUPPLIER_INVOICE_CAPTURED, 'warehouse')).toBe(false);
    expect(pathFor(item.event)).toBe('/v1/purchase/invoices/INV-8/synced');
  });

  it('the same screen\'s match finds the invoice at once, and a second capture is refused — even when the box never told it about the invoice', () => {
    const outbox = new SyncOutbox();
    const s = session({ capturedLines: () => [] }, outbox);
    expect(s.match({ poId: 'PO-1', invoiceId: 'INV-9' }).blocked).toBe(true); // not yet captured: NOT checked
    s.captureInvoice({ invoiceId: 'INV-9', supplierId: 's1', preview: cleanPreview(s) });
    expect(s.match({ poId: 'PO-1', invoiceId: 'INV-9' })).toMatchObject({ blocked: false, payableMinor: CLEAN_TOTAL, withheldMinor: 0 });
    expect(s.captureInvoice({ invoiceId: 'INV-9', supplierId: 's1', preview: cleanPreview(s) }))
      .toMatchObject({ ok: false, refusal: 'already_captured' });
    // A reload — a new session over the SAME durable queue — knows it too.
    const reloaded = session({ capturedLines: () => [] }, outbox);
    expect(reloaded.match({ poId: 'PO-1', invoiceId: 'INV-9' })).toMatchObject({ blocked: false, payableMinor: CLEAN_TOTAL });
    expect(reloaded.captureInvoice({ invoiceId: 'INV-9', supplierId: 's1', preview: cleanPreview(reloaded) }))
      .toMatchObject({ ok: false, refusal: 'already_captured' });
  });

  it('a refused capture queues nothing', () => {
    const outbox = new SyncOutbox();
    const s = session({}, outbox);
    s.captureInvoice({ invoiceId: 'INV-10', supplierId: 's1', preview: s.previewInvoice({ text: CLEAN_FILE, declaredTotalMinor: 1 }) }); // does not add up
    s.captureInvoice({ invoiceId: 'INV-11', supplierId: 's1', preview: s.previewInvoice({ text: 'productId,quantity,unitPriceMinor,lineTotalMinor\np1,1,10000,999', declaredTotalMinor: 999 }) }); // a bad line
    expect(outbox.all()).toEqual([]);
    expect(s.savedInvoices()).toEqual([]);
  });

  it('lists every saved invoice newest first with the five shared state words — from the queue and the box\'s word, never the screen\'s own say-so', () => {
    const outbox = new SyncOutbox();
    const s = session({}, outbox);
    s.captureInvoice({ invoiceId: 'INV-12', supplierId: 's1', poId: 'PO-1', preview: cleanPreview(s) });
    s.captureInvoice({ invoiceId: 'INV-13', supplierId: 's2', preview: cleanPreview(s) });
    expect(s.savedInvoices().map((w) => [w.invoiceId, w.supplierId, w.poId, w.lineCount, w.totalMinor, w.state])).toEqual([
      ['INV-13', 's2', null, 2, CLEAN_TOTAL, 'saved_here'],
      ['INV-12', 's1', 'PO-1', 2, CLEAN_TOTAL, 'saved_here'],
    ]);
    outbox.recordFailure('invoice:INV-12');
    expect(s.savedInvoices().find((w) => w.invoiceId === 'INV-12')).toMatchObject({ state: 'retrying', attempts: 1 });
    outbox.acknowledge('invoice:INV-12');
    expect(s.handedKeys()).toEqual(['invoice:INV-12']);
    expect(s.savedInvoices().find((w) => w.invoiceId === 'INV-12')?.state).toBe('handed_to_box');
    s.noteBoxStatus([{ key: 'invoice:INV-12', state: 'posted', attempts: 0 }]);
    expect(s.savedInvoices().find((w) => w.invoiceId === 'INV-12')?.state).toBe('posted');
    s.noteBoxStatus([{ key: 'invoice:INV-12', state: 'refused', attempts: 2, reason: 'the cloud answered 422 for SupplierInvoiceCaptured (does_not_add_up_to_the_invoice_total)' }]);
    expect(s.savedInvoices().find((w) => w.invoiceId === 'INV-12')).toMatchObject({ state: 'refused', reason: expect.stringContaining('422') as string });
  });
});
