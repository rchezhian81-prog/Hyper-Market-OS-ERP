import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { Client } from 'pg';
import { pgClient } from '../../packages/persistence/src/pg-client';
import { SqlEventStore } from '../../packages/persistence/src/event-store';
import { runMigrations } from '../../packages/persistence/src/migrations';
import { issuePurchaseOrder } from '../../packages/purchasing/src/purchasing';
import { scoreSupplier } from '../../packages/purchasing/src/supplier-performance';
import {
  receiveScan,
  captureReceipt,
  matchInvoice,
  bookDockSlot,
  compareAgainstAsn,
  type Asn,
  type BarcodeResolution,
  type CapturedLine,
  type OrderedProduct,
  type ProductReceiptRules,
  type ReceiptPolicy,
} from '../../packages/receiving/src/index';
import { projectStock, availableToSell } from '../../packages/stock/src/index';
import type { PackHierarchy } from '../../packages/product/src/index';
import { makeEvent } from '../../packages/contracts/src/event';
import { money } from '../../packages/contracts/src/money';

/**
 * STAGE 7 GATE — *purchase / GRN / invoice controls pass.*
 *
 * One delivery walked end to end with the real engines: dock booking → purchase
 * order → ASN → handheld scanning → capture and quarantine → three-way match →
 * payment decision → supplier scorecard → the GRN landing in the real cloud ledger.
 *
 * The controls under test are the ones that actually stop money leaking at the back
 * door, and each is asserted where it bites rather than in isolation.
 */

const DATABASE_URL = process.env['DATABASE_URL'];
const TENANT = '33333333-3333-3333-3333-333333333333';
/**
 * The ledger is append-only and the database refuses DELETE, so a fixed key would
 * make the second run of this suite assert against the first run's data. A run-
 * scoped suffix keeps the test genuinely repeatable AND keeps the strong assertion
 * that the first append is new and the replay is deduped.
 */
const RUN = `r${Date.now().toString(36)}`;
const INR = 'INR' as const;
const TODAY = '2026-08-05';

const PACKS: PackHierarchy[] = [
  {
    productId: 'p-rice',
    baseUom: 'ea',
    levels: [
      { level: 'unit', containsMinor: 1 },
      { level: 'case', containsMinor: 24, barcode: '890RICECASE' },
    ],
  },
];

const BARCODES: BarcodeResolution[] = [
  { barcode: '890RICE', productId: 'p-rice', level: 'unit' },
  { barcode: '890RICECASE', productId: 'p-rice', level: 'case' },
  { barcode: '890MILK', productId: 'p-milk', level: 'unit' },
];

const RULES: ProductReceiptRules[] = [
  { productId: 'p-rice', batchTracked: false, mrp: money(60_000, INR) },
  { productId: 'p-milk', batchTracked: true, coldChain: true, mrp: money(3_000, INR) },
];

const RECEIPT_POLICY: ReceiptPolicy = {
  excessToleranceBp: 200,
  shortageToleranceBp: 100,
  nearExpiryDays: 30,
  coldChainMaxC: 5,
};

describe.skipIf(!DATABASE_URL)('Stage 7 — purchase to payment (real PostgreSQL)', () => {
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

  it('walks one delivery from purchase order to payment, with every control biting', async () => {
    // ---- 1. Dock booking -----------------------------------------------------
    const slot = bookDockSlot(
      {
        slotId: 'ds-1',
        storeId: 'store-1',
        dockId: 'dock-A',
        startsAt: '2026-08-05T06:00:00Z',
        endsAt: '2026-08-05T07:00:00Z',
        supplierId: 'sup-1',
        poIds: ['po-1'],
        status: 'booked',
      },
      [],
    );
    expect(slot.status).toBe('booked');

    // ---- 2. Purchase order, issued with a separate approver (§28) ------------
    const po = issuePurchaseOrder({
      id: 'po-1',
      number: 'PO-2026-000001',
      supplierId: 'sup-1',
      requisitionedBy: 'buyer-1',
      at: '2026-08-01T09:00:00Z',
      lines: [{ productId: 'p-rice', orderedQty: 100, unitCost: money(4_000, INR) }],
      approval: {
        id: 'apr-po-1',
        subjectType: 'purchase_order',
        subjectRef: 'po-1',
        requestedBy: 'buyer-1',
        branchId: 'store-1',
        value: money(400_000, INR),
        status: 'approved',
        decidedBy: 'manager-1',
        reason: 'within budget for the month',
        decidedAt: '2026-08-01T09:05:00Z',
      },
    });
    expect(po.total).toEqual(money(400_000, INR)); // ₹4,000.00

    // Two views of the same order: by product for the handheld, by line for the
    // three-way match.
    const orderedForScanning: OrderedProduct[] = [
      { productId: 'p-rice', quantityMinor: 100, unitCost: money(4_000, INR) },
    ];
    const orderedForMatching = [
      { lineId: 'l1', productId: 'p-rice', quantityMinor: 100, unitCost: money(4_000, INR) },
    ];

    // ---- 3. The lorry arrives; the ASN promises 100 --------------------------
    const asn: Asn = {
      asnId: 'asn-1',
      supplierId: 'sup-1',
      poId: 'po-1',
      expectedAt: '2026-08-05T06:00:00Z',
      lines: [{ lineId: 'l1', productId: 'p-rice', quantityMinor: 100, uom: 'ea' }],
    };

    // ---- 4. Handheld scanning, with the controls firing ----------------------
    const applied: string[] = [];
    const receivedSoFar: Record<string, number> = {};
    const scan = (
      over: Parameters<typeof receiveScan>[0]['command'],
      approval?: Parameters<typeof receiveScan>[0]['approval'],
    ) =>
      receiveScan({
        command: over,
        appliedCommandIds: applied,
        barcodes: BARCODES,
        packs: PACKS,
        ordered: orderedForScanning,
        receivedSoFar,
        ...(approval !== undefined ? { approval } : {}),
      });

    const base = {
      grnId: 'grn-1',
      storeId: 'store-1',
      receivedBy: 'receiver-1',
      at: '2026-08-05T06:15:00Z',
      source: 'po' as const,
      poId: 'po-1',
    };

    // Three cases scanned = 72 units, not 3.
    const cases = scan({ ...base, commandId: 'c-1', barcode: '890RICECASE', scannedQuantity: 3 });
    expect(cases.quantityMinor).toBe(72);
    applied.push('c-1');
    receivedSoFar['p-rice'] = 72;

    // The handheld hesitates and the receiver scans again — must change nothing.
    const doubled = scan({ ...base, commandId: 'c-1', barcode: '890RICECASE', scannedQuantity: 3 });
    expect(doubled.outcome).toBe('duplicate_ignored');
    expect(receivedSoFar['p-rice']).toBe(72);

    // An unknown barcode goes to the queue; the delivery carries on.
    const unknown = scan({ ...base, commandId: 'c-2', barcode: '000MYSTERY', scannedQuantity: 1 });
    expect(unknown.outcome).toBe('unknown_barcode');
    expect(unknown.resolutionRequired).toBe(true);

    // The receiver cannot rewrite the agreed price at the door.
    const priceEdit = scan({
      ...base,
      commandId: 'c-3',
      barcode: '890RICE',
      scannedQuantity: 1,
      declaredUnitCost: money(4_500, INR),
    });
    expect(priceEdit.outcome).toBe('price_change_refused');

    // The rest of the delivery: 20 loose units, so 92 of 100 arrived.
    const loose = scan({ ...base, commandId: 'c-4', barcode: '890RICE', scannedQuantity: 20 });
    expect(loose.accepted).toBe(true);
    applied.push('c-4');
    receivedSoFar['p-rice'] = 92;

    // ---- 5. The ASN was a promise; 8 are missing ----------------------------
    const differences = compareAgainstAsn(asn, receivedSoFar);
    expect(differences[0]?.differenceMinor).toBe(-8);
    expect(differences[0]?.detail).toContain('the note is a promise, not a receipt');

    // ---- 6. Capture: what may actually be sold ------------------------------
    const lines: CapturedLine[] = [
      {
        lineId: 'gl-1',
        productId: 'p-rice',
        orderedMinor: 100,
        countedMinor: 92,
        uom: 'ea',
        unitCost: money(4_000, INR),
        condition: 'good',
      },
      {
        lineId: 'gl-2',
        productId: 'p-milk',
        orderedMinor: 0,
        countedMinor: 20,
        uom: 'ea',
        unitCost: money(2_400, INR),
        condition: 'damaged',
        batchId: 'B-MILK-1',
        expiry: '2026-08-20',
        temperatureC: 4,
      },
    ];
    const captured = captureReceipt({
      receiptId: 'grn-1',
      lines,
      rules: RULES,
      policy: RECEIPT_POLICY,
      receivedOnDate: TODAY,
      currency: INR,
    });

    // The shortage is valued, not just noted: 8 × ₹40.00 = ₹320.00 owed back.
    const short = captured.discrepancies.find((d) => d.kind === 'short');
    expect(short?.value).toEqual(money(32_000, INR));
    expect(short?.detail).toContain('credit note');
    // Damaged milk is quarantined and needs a second person.
    expect(captured.lines[1]?.disposition).toBe('quarantine');
    expect(captured.requiresApproval).toBe(true);

    // ---- 7. Quarantine really is unsellable, in the stock model -------------
    const projection = projectStock([
      {
        movementId: 'm-1',
        productId: 'p-rice',
        locationId: 'store-1',
        batchId: null,
        from: null,
        to: 'on_hand',
        quantityMinor: captured.lines[0]!.sellableMinor,
        uom: 'ea',
        at: '2026-08-05T06:30:00Z',
      },
      {
        movementId: 'm-2',
        productId: 'p-milk',
        locationId: 'store-1',
        batchId: 'B-MILK-1',
        from: null,
        to: 'quarantine',
        quantityMinor: captured.lines[1]!.quarantinedMinor,
        uom: 'ea',
        at: '2026-08-05T06:30:00Z',
      },
    ]);
    expect(availableToSell(projection, 'p-rice')).toBe(92);
    expect(availableToSell(projection, 'p-milk')).toBe(0);

    // ---- 8. The invoice arrives, for 100 at a higher price ------------------
    const overcharged = matchInvoice({
      invoiceId: 'inv-1',
      ordered: orderedForMatching,
      received: [{ lineId: 'l1', productId: 'p-rice', quantityMinor: 92 }],
      invoiced: [{ lineId: 'l1', productId: 'p-rice', quantityMinor: 100, unitCost: money(4_400, INR) }],
      policy: { priceToleranceBp: 100, quantityToleranceBp: 0, immaterialMinor: 100 },
      currency: INR,
      receivedBy: 'receiver-1',
    });

    // Blocked twice over: charged above the agreed price AND for goods that never came.
    expect(overcharged.payable).toBe(false);
    expect(overcharged.variances.map((v) => v.kind)).toEqual(
      expect.arrayContaining(['price_over', 'quantity_over_invoiced']),
    );
    expect(overcharged.blockedReason).toContain('needs approval before payment');

    // The receiver cannot clear their own receipt.
    const selfApproved = matchInvoice({
      invoiceId: 'inv-1',
      ordered: orderedForMatching,
      received: [{ lineId: 'l1', productId: 'p-rice', quantityMinor: 92 }],
      invoiced: [{ lineId: 'l1', productId: 'p-rice', quantityMinor: 100, unitCost: money(4_400, INR) }],
      policy: { priceToleranceBp: 100, quantityToleranceBp: 0, immaterialMinor: 100 },
      currency: INR,
      receivedBy: 'receiver-1',
      approval: { subjectRef: 'inv-1', status: 'approved', decidedBy: 'receiver-1' },
    });
    expect(selfApproved.payable).toBe(false);
    expect(selfApproved.blockedReason).toContain('cannot approve the variance');

    // ---- 9. A corrected invoice — for what actually arrived, at the agreed price
    const corrected = matchInvoice({
      invoiceId: 'inv-2',
      ordered: orderedForMatching,
      received: [{ lineId: 'l1', productId: 'p-rice', quantityMinor: 92 }],
      invoiced: [{ lineId: 'l1', productId: 'p-rice', quantityMinor: 92, unitCost: money(4_000, INR) }],
      charges: { freight: money(20_000, INR) },
      policy: { priceToleranceBp: 100, quantityToleranceBp: 0, immaterialMinor: 100 },
      currency: INR,
      receivedBy: 'receiver-1',
    });
    expect(corrected.payable).toBe(true);
    // Freight lands on the goods: ₹368.00 + ₹200.00 = ₹568.00 landed.
    expect(corrected.landedCost[0]?.landedValue).toEqual(money(388_000, INR));

    // ---- 10. The supplier's record reflects what they actually did ----------
    const card = scoreSupplier({
      supplierId: 'sup-1',
      receipts: [
        {
          poId: 'po-1',
          supplierId: 'sup-1',
          orderedOn: '2026-08-01',
          receivedOn: '2026-08-05',
          orderedQtyMinor: 100,
          receivedQtyMinor: 92,
          agreedValue: money(400_000, INR),
          invoicedValue: money(368_000, INR),
        },
      ],
      contract: {
        contractId: 'c-1',
        supplierId: 'sup-1',
        startsOn: '2026-01-01',
        endsOn: '2026-12-31',
        agreedLeadTimeDays: 7,
        approvedBy: 'purchase-1',
      },
    });
    expect(card.fillRate).toEqual({ kind: 'rated', bp: 9_200 });
    expect(card.summary).toContain('the lost sale dwarfs any price advantage');

    // ---- 11. The GRN lands in the real cloud ledger, once -------------------
    const event = makeEvent({
      id: `evt-grn-${RUN}`,
      type: 'GoodsReceived',
      occurredAt: '2026-08-05T06:30:00Z',
      idempotencyKey: `grn-${RUN}`,
      source: 'handheld-2',
      payload: { grnId: 'grn-1', poId: 'po-1', receivedMinor: 92, totalMinor: 368_000 },
    });
    const stream = `grn/${RUN}`;
    const first = await store.append(TENANT, stream, event);
    expect(first.deduped).toBe(false);
    // A retried sync banks it once.
    const replay = await store.append(TENANT, stream, event);
    expect(replay.deduped).toBe(true);
    expect(await store.readStream(TENANT, stream)).toHaveLength(1);
  });
});
