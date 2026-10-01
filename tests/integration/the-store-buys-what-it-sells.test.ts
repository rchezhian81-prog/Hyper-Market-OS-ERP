import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startEdge, type EdgeProcess } from '../../edge/store-edge/src/main';
import { bootPos } from '../../apps/pos/src/browser-entry';
import type { CatalogueSnapshot } from '../../packages/catalogue/src/catalogue';
import { DEFAULT_RETAIL_POSTING_MAP } from '../../packages/finance/src/index';
import { makeTradingDayRule, tradingDateOf } from '../../packages/calendar/src/trading-day';
import { startRealCloud, type RealCloud } from '../support/real-store';

/**
 * **The store buys what it sells, connected — the PURCHASING half of the loop on the REAL cloud, over REAL PostgreSQL,
 * through the REAL box (SP-9-ii · W10 · M06 · M07 · M08 · M09 · M10 · M12 · M23 · §28).**
 *
 * `the-store-trades-a-day` proves the retail leg from a shelf that was simply booked. This suite fills that shelf the way
 * the shop will: a supplier proposed and approved by two people → a purchase order proposed by the buyer and issued by a
 * second person → the delivery received at the back store against the order, part of it damaged and QUARANTINED (never
 * sellable) → a second person disposes of the damaged tins back to the supplier → a floor indent raised by floor staff,
 * approved by the manager against the back store's real stock, issued by the back store (in transit), received
 * INDEPENDENTLY on the floor → the shelf has stock, the back store none → the till (fed by the pulled head-office pack)
 * sells one and the floor falls by one → the supplier's invoice is captured as the paper says and matched by a second
 * person against the STORED order and receipts → the returned tins raise a debit note → the supplier account owes the
 * net → the accountant posts the payables and the day book: every journal balances and the two derivations of what is
 * owed agree. Requested, issued, received and outstanding quantities are recorded separately; issue and receipt never
 * create stock twice; a dispatch is never a receipt.
 *
 * Synthetic data only (hard rule #7): a fresh random tenant per run. Needs DATABASE_URL (the CI job provides one);
 * without it the suite SKIPS — and the CI shell check refuses a run where the database tests silently skipped.
 */

const DATABASE_URL = process.env['DATABASE_URL'];
const describeOrSkip = DATABASE_URL ? describe : describe.skip;

const KEY = ['store', 'buys', 'what', 'it', 'sells', 'key'].join('-').padEnd(48, '0');
const COMPANY = 'C1';
const STORE = 'S1';          // the floor — where the till sells from
const BACK = 'S1-BACK';      // the back store — where deliveries land
const LANE = 'lane-1';
const OWNER = 'u-owner';     // approves the supplier and issues the order (a second person to the buyer)
const BUYER = 'u-buyer';     // store_manager: proposes the supplier and the order, captures the invoice
const RECEIVER = 'u-recv';   // store_manager: receives the delivery at the back store
const CHECKER = 'u-checker'; // store_manager: disposes of quarantined stock, matches the invoice, issues the debit note
const MANAGER = 'u-manager'; // store_manager: approves the floor indent
const BACKSTORE = 'u-back';  // store_manager: issues from the back store
const SHELF = 'u-shelf';     // store_manager: receives on the floor — never the issuer
const CASHIER = 'u-meena';   // cashier: raises the indent as floor staff and sells at the till
const ACCT = 'u-acct';       // accountant: posts the payables and the day book
const BOX = 'u-box';         // the store computer's sync identity
const SUPPLIER = 's-amma';
const PO = 'po-1';
const GRN = 'grn-1';
const INDENT = 'ind-1';
const PRODUCT = 'p-rice';
const BARCODE = '8901234567890';
const PRICE = 48_000;        // ₹480.00 shelf price, GST inside (A9)
const COST = 40_000;         // ₹400.00 delivered cost per bag
const ORDERED = 12;
const GOOD = 10;
const DAMAGED = 2;

interface Reply { readonly status: number; readonly body: unknown }

describeOrSkip('the store buys what it sells — purchase → receipt / quarantine → back store → floor → sale → invoice → books, on the REAL stack (SP-9-ii)', () => {
  let cloud: RealCloud;
  const edges: EdgeProcess[] = [];
  const dirs: string[] = [];
  const today = new Date().toISOString().slice(0, 10);

  beforeAll(async () => {
    cloud = await startRealCloud({ databaseUrl: DATABASE_URL!, tenantId: randomUUID(), owner: OWNER, packSigningKey: KEY });
    for (const u of [BUYER, RECEIVER, CHECKER, MANAGER, BACKSTORE, SHELF]) await cloud.grant(u, 'store_manager');
    await cloud.grant(CASHIER, 'cashier');
    await cloud.grant(BOX, 'cashier');
    await cloud.grant(ACCT, 'accountant');
    // The box in this run keeps this machine's clock (UTC); the owner tells head office so (F14 fixed).
    expect((await call('PUT', '/v1/platform/setup/locale.time_zone', OWNER, { value: 'UTC' }, 'setup-tz-utc')).status).toBe(200);
    // The owner's receiving tolerances (M07): nothing short or over is waved through unsaid.
    expect((await call('POST', '/v1/inventory/receipt-policy', OWNER, { excessToleranceBp: 0, shortageToleranceBp: 0, nearExpiryDays: 7 }, 'receipt-policy')).status).toBe(201);
    await places();
    await publishCatalogue();
  }, 60_000);
  afterAll(async () => { await cloud?.stop(); });
  afterEach(async () => {
    for (const edge of edges.splice(0)) await edge.stop();
    for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true });
  });

  const call = (method: 'GET' | 'POST' | 'PUT', path: string, userId: string, body?: unknown, idempotencyKey?: string): Promise<Reply> =>
    cloud.request({ method, path, userId, ...(body === undefined ? {} : { body }), ...(idempotencyKey === undefined ? {} : { idempotencyKey }) });
  const ok = async (p: Promise<Reply>, expected: number): Promise<Record<string, unknown>> => {
    const r = await p;
    expect(r.status, JSON.stringify(r.body)).toBe(expected);
    return r.body as Record<string, unknown>;
  };
  const codeOf = (r: Reply): string | undefined => (r.body as { error?: { code?: string } }).error?.code;

  /** The places head office knows: the company, the store (the floor) and its back store (M01-FR-01). */
  async function places(): Promise<void> {
    await ok(call('POST', `/v1/org/nodes/${COMPANY}`, OWNER, { kind: 'company', name: 'SRE Retail' }, `org-${COMPANY}`), 201);
    await ok(call('POST', `/v1/org/nodes/${STORE}`, OWNER, { kind: 'branch', name: 'SRE Hyper Market', parentId: COMPANY, companyId: COMPANY }, `org-${STORE}`), 201);
    await ok(call('POST', `/v1/org/nodes/${BACK}`, OWNER, { kind: 'warehouse', name: 'Back store', parentId: STORE, companyId: COMPANY }, `org-${BACK}`), 201);
  }

  /** Head office authors the one product this shop sells today — no stock: the delivery brings it. */
  async function publishCatalogue(): Promise<void> {
    await ok(call('POST', '/v1/catalogue/tax-classes/1006/rates/2017-07-01', OWNER, { rateBps: 500 }, 'tax-1006'), 201);
    await ok(call('POST', `/v1/catalogue/products/${PRODUCT}/publish`, OWNER, {
      product: { sku: 'RICE-5KG', name: 'Ponni rice 5kg', baseUom: 'ea', primaryCategoryId: 'grocery', taxClass: '1006', lifecycle: 'active' },
      categories: [{ categoryId: 'grocery', name: 'Grocery', parentId: null }],
    }, `publish-${PRODUCT}`), 201);
    await ok(call('POST', `/v1/prices/list/${PRODUCT}/entries/e1`, OWNER, {
      scope: 'store', scopeRef: STORE, priceMinor: PRICE, mrpMinor: 50_000, costMinor: COST, marginFloorBps: 0, currency: 'INR', effectiveFrom: today,
    }, `price-${PRODUCT}`), 201);
    await ok(call('POST', `/v1/catalogue/products/${PRODUCT}/barcodes/${BARCODE}`, OWNER, { kind: 'ean' }, `barcode-${PRODUCT}`), 201);
    await ok(call('POST', '/v1/catalogue/pack', OWNER, { storeId: STORE, asOf: today }, 'pack-1'), 201);
  }

  /** A store box: a policies-only pack file (the one-PC install), its own disk, its own lane id; the cloud URL is the live one unless the line is "cut". */
  async function startBox(token: string, opts: { laneId?: string; dir?: string; cloudUrl?: string } = {}): Promise<EdgeProcess> {
    const dataDir = opts.dir ?? await mkdtemp(join(tmpdir(), 'sre-buys-what-it-sells-'));
    if (opts.dir === undefined) dirs.push(dataDir);
    const packFile = join(dataDir, 'store-pack.json');
    await writeFile(packFile, JSON.stringify({
      version: 1,
      policies: { storeId: STORE, branchId: STORE, branchName: 'SRE Hyper Market', warehouseId: BACK, tradingDayCutoff: '00:00', staleAfterSeconds: 900, countApprovalThresholdMinor: 0 },
      lossPreventionRules: [],
    }), 'utf8');
    const edge = (await startEdge({
      EDGE_DATA_DIR: dataDir, EDGE_TENANT_ID: cloud.tenantId, PACK_SIGNING_KEY: KEY, EDGE_CAPACITY_BYTES: '10485760',
      EDGE_LANE_PORT: '0', EDGE_LANE_ID: opts.laneId ?? LANE, EDGE_SCREEN_PORT: '0', EDGE_APPS_DIR: 'apps', EDGE_PACK_FILE: packFile,
      CLOUD_API_URL: opts.cloudUrl ?? cloud.baseUrl, CLOUD_API_TOKEN: token,
    }, () => {}))!;
    edges.push(edge);
    return edge;
  }
  async function stopBox(edge: EdgeProcess): Promise<void> {
    const i = edges.indexOf(edge);
    if (i >= 0) edges.splice(i, 1);
    await edge.stop();
  }
  async function servedTillCatalogue(edge: EdgeProcess): Promise<CatalogueSnapshot | undefined> {
    const html = await (await fetch(`http://127.0.0.1:${edge.screens!.port}/pos/`)).text();
    const match = /<script>window\.posCatalogue = ([\s\S]*?);<\/script>/.exec(html);
    return match === null ? undefined : JSON.parse(match[1]!) as CatalogueSnapshot;
  }

  interface Availability { rows: { locationId: string; onHandMinor: number }[]; inTransit: { transferId: string; locationId: string; fromLocationId: string; quantityMinor: number }[] }
  const availability = async (): Promise<Availability> => (await ok(call('GET', `/v1/inventory/availability?productId=${PRODUCT}`, OWNER), 200)) as unknown as Availability;
  const onHandAt = async (locationId: string): Promise<number> => (await availability()).rows.find((r) => r.locationId === locationId)?.onHandMinor ?? 0;
  const valuationAt = async (locationId: string): Promise<number> => {
    const v = await ok(call('GET', `/v1/inventory/valuation?productId=${PRODUCT}`, OWNER), 200) as { rows: { locationId: string; productId: string; value: { minor: number } }[] };
    return v.rows.filter((r) => r.locationId === locationId && r.productId === PRODUCT).reduce((s, r) => s + r.value.minor, 0);
  };

  it('supplier → order → delivery (two tins damaged, quarantined) → return → back store → indent → issue → floor receipt → the till sells one → invoice matched → debit note → account → payables and day book posted and reconciled', async () => {
    const unitCost = { minor: COST, currency: 'INR' };
    expect(await onHandAt(BACK)).toBe(0);
    expect(await onHandAt(STORE)).toBe(0);

    // ── 1. The supplier: proposed by the buyer, approved by a DIFFERENT person who holds the authority (M06-FR-01 · §28). A store
    //      manager holds no supplier-approval right at all, so the buyer is refused before the question of self-approval arises.
    expect((await call('POST', `/v1/purchase/suppliers/${SUPPLIER}`, BUYER, { name: 'Amma Traders' }, `sup-${SUPPLIER}`)).status).toBe(201);
    expect(codeOf(await call('POST', `/v1/purchase/suppliers/${SUPPLIER}/approval`, BUYER, { reason: 'documents checked' }, 'sup-approve-self'))).toBe('forbidden');
    await ok(call('POST', `/v1/purchase/suppliers/${SUPPLIER}/approval`, OWNER, { reason: 'GST certificate and FSSAI licence checked' }, 'sup-approve'), 200);

    // ── 2. The order: proposed by the buyer, ISSUED by the owner (M06-FR-02). Until issued nothing is committed.
    const proposed = await ok(call('POST', `/v1/purchase/orders/${PO}`, BUYER, { supplierId: SUPPLIER, lines: [{ productId: PRODUCT, orderedQty: ORDERED, unitCost }] }, `po-${PO}`), 201);
    expect(proposed['order']).toMatchObject({ status: 'proposed', requisitionedBy: BUYER, totalMinor: ORDERED * COST });
    expect(codeOf(await call('POST', `/v1/purchase/orders/${PO}/approval`, BUYER, { reason: 'mine' }, 'po-approve-self'))).toBeDefined(); // refused: the requisitioner cannot issue
    const issued = await ok(call('POST', `/v1/purchase/orders/${PO}/approval`, OWNER, { reason: 'within the month budget' }, 'po-approve'), 200);
    expect(issued['order']).toMatchObject({ status: 'issued', approvedBy: OWNER });
    // What the shop is now on the hook to pay for: the whole order, until it arrives.
    expect(await ok(call('GET', '/v1/purchase/commitments', OWNER), 200)).toMatchObject({ known: true, valueMinor: ORDERED * COST });

    // ── 3. The delivery, at the BACK STORE, against the order: 10 good bags and 2 damaged. The damaged ones are QUARANTINED —
    //      in our custody, never sellable — and the receipt folds into the order (SP-6 · F01). The receiver cannot name the rules.
    const delivery = {
      warehouseId: BACK, receivedOnDate: today, currency: 'INR', poId: PO,
      lines: [
        { lineId: 'L1', productId: PRODUCT, orderedMinor: ORDERED, countedMinor: GOOD, uom: 'ea', unitCost, condition: 'good' },
        { lineId: 'L2', productId: PRODUCT, orderedMinor: ORDERED, countedMinor: DAMAGED, uom: 'ea', unitCost, condition: 'damaged' },
      ],
    };
    const grn = await ok(call('POST', `/v1/inventory/goods-receipt/${GRN}`, RECEIVER, delivery, GRN), 201);
    const grnRecord = grn['grn'] as {
      captured: {
        lines: { lineId: string; sellableMinor: number; quarantinedMinor: number; rejectedMinor: number; disposition: string }[];
        discrepancies: { kind: string; lineId: string; quantityMinor: number; requiresApproval: boolean }[];
        discrepancyValue: { minor: number };
      };
      availableMinor: number; heldMinor: number; poId: string | null; receivedBy: string; governanceFlags?: string[];
      poReceipt?: { receivedByProduct: Record<string, number> } | null;
    };
    expect(grnRecord).toMatchObject({ poId: PO, receivedBy: RECEIVER, availableMinor: GOOD, heldMinor: 0, governanceFlags: [] });
    // The order's 12 apportioned across the two lines as counted (F16 fixed): the delivery is COMPLETE — the only discrepancy is
    // the damage, valued, and it needs a second person. No false "short" claim against a supplier who delivered everything.
    expect(grnRecord.captured.lines.map((l) => [l.lineId, l.sellableMinor, l.quarantinedMinor, l.rejectedMinor, l.disposition]))
      .toEqual([['L1', GOOD, 0, 0, 'sellable'], ['L2', 0, DAMAGED, 0, 'quarantine']]);
    expect(grnRecord.captured.discrepancies.map((d) => [d.kind, d.lineId, d.quantityMinor, d.requiresApproval])).toEqual([['damaged', 'L2', DAMAGED, true]]);
    expect(grnRecord.captured.discrepancyValue.minor).toBe(DAMAGED * COST);
    // What folded into the order: everything that came into our custody — the good AND the quarantined (SP-6 · F01).
    expect(grnRecord.poReceipt?.receivedByProduct).toEqual({ [PRODUCT]: ORDERED });
    // Only the SELLABLE ten are on hand at the back store; the quarantined two are on the receipt, in custody, never on-hand and
    // never sellable (M08 status · M10). Nothing is on the floor yet.
    expect(await onHandAt(BACK)).toBe(GOOD);
    expect(await onHandAt(STORE)).toBe(0);
    expect(await valuationAt(BACK)).toBe(GOOD * COST);
    // The order knows it was received in full (the quarantined two included — they came into our custody): nothing is open.
    expect(await ok(call('GET', '/v1/purchase/commitments', OWNER), 200)).toMatchObject({ known: true, valueMinor: 0 });
    // The same delivery keyed again is the same delivery — no second stock; a DIFFERENT delivery under the same key is a visible
    // conflict, never a silent second posting (hard rule #10 · F12).
    expect((await ok(call('POST', `/v1/inventory/goods-receipt/${GRN}`, RECEIVER, delivery, GRN), 201))['grn']).toMatchObject({ grnId: GRN, receivedAt: (grn['grn'] as { receivedAt: string }).receivedAt }); // the kernel replays the one answer
    expect(codeOf(await call('POST', `/v1/inventory/goods-receipt/${GRN}`, RECEIVER, { ...delivery, lines: [delivery.lines[0]] }, GRN))).toBe('idempotency_key_reused');
    expect(await onHandAt(BACK)).toBe(GOOD);

    // ── 4. QC's verdict on the damaged tins: a SECOND person (never the receiver) sends them back. They were never on hand, so no
    //      stock moves — the decision is recorded once, valued at the delivered cost, and it is what the debit note will stand on.
    expect(codeOf(await call('POST', `/v1/inventory/goods-receipt/${GRN}/lines/L2/disposition`, RECEIVER, { disposition: 'return', reason: 'dented' }, 'disp-self'))).toBe('self_approval');
    expect(codeOf(await call('POST', `/v1/inventory/goods-receipt/${GRN}/lines/L1/disposition`, CHECKER, { disposition: 'return', reason: 'x' }, 'disp-good'))).toBe('nothing_to_dispose');
    const disposed = await ok(call('POST', `/v1/inventory/goods-receipt/${GRN}/lines/L2/disposition`, CHECKER, { disposition: 'return', reason: 'dented tins, supplier to collect' }, 'disp-L2'), 200);
    expect(disposed).toMatchObject({ disposition: 'return', quantityMinor: DAMAGED, valueMinor: DAMAGED * COST, decidedBy: CHECKER, alreadyDecided: false, movementIds: [] });
    expect(await onHandAt(BACK)).toBe(GOOD);
    expect(await valuationAt(BACK)).toBe(GOOD * COST);
    expect(await ok(call('POST', `/v1/inventory/goods-receipt/${GRN}/lines/L2/disposition`, CHECKER, { disposition: 'return', reason: 'again' }, 'disp-L2-again'), 200)).toMatchObject({ alreadyDecided: true });

    // ── 5. The floor asks for the ten; the manager approves against the back store's REAL stock; the back store issues (in transit —
    //      visible, not on hand, not sellable); the floor receives INDEPENDENTLY. Requested / issued / received / outstanding kept apart.
    const asked = await ok(call('POST', `/v1/floor/indents/${INDENT}`, CASHIER, { fromLocationId: BACK, toLocationId: STORE, lines: [{ productId: PRODUCT, quantityMinor: GOOD, uom: 'EA' }], reason: 'shelf 4 empty' }, INDENT), 201);
    expect(asked['indent']).toMatchObject({ state: 'requested', requestedBy: CASHIER, totals: expect.objectContaining({ requestedMinor: GOOD, allocatedMinor: 0 }) });
    expect(codeOf(await call('POST', `/v1/floor/indents/${INDENT}/approval`, CASHIER, {}, 'ind-ap-self'))).toBe('forbidden'); // floor staff hold no approval right
    const approved = await ok(call('POST', `/v1/floor/indents/${INDENT}/approval`, MANAGER, {}, 'ind-ap'), 200);
    expect(approved['indent']).toMatchObject({ state: 'approved', approvedBy: MANAGER, totals: expect.objectContaining({ allocatedMinor: GOOD, outstandingMinor: GOOD }) });
    expect(codeOf(await call('POST', `/v1/floor/indents/${INDENT}/issues/is-over`, BACKSTORE, { lines: [{ productId: PRODUCT, quantityMinor: GOOD + 1 }] }, 'ind-is-over'))).toBe('over_issue');
    const issuedOut = await ok(call('POST', `/v1/floor/indents/${INDENT}/issues/is-1`, BACKSTORE, { lines: [{ productId: PRODUCT, quantityMinor: GOOD }] }, 'ind-is-1'), 201);
    expect(issuedOut).toMatchObject({ transferId: `${INDENT}:is-1`, lineCostsMinor: [COST] });
    expect(issuedOut['indent']).toMatchObject({ totals: expect.objectContaining({ issuedMinor: GOOD, inTransitMinor: GOOD, receivedMinor: 0 }) });
    let stock = await availability();
    expect(stock.rows.find((r) => r.locationId === BACK)?.onHandMinor ?? 0).toBe(0);
    expect(stock.rows.find((r) => r.locationId === STORE)?.onHandMinor ?? 0).toBe(0); // dispatched is NOT received
    expect(stock.inTransit).toEqual([expect.objectContaining({ transferId: `${INDENT}:is-1`, fromLocationId: BACK, locationId: STORE, quantityMinor: GOOD })]);
    expect(codeOf(await call('POST', `/v1/floor/indents/${INDENT}/issues/is-1/receipt`, BACKSTORE, { counted: [{ productId: PRODUCT, quantityMinor: GOOD }] }, 'ind-rc-self'))).toBe('issuer_cannot_receive');
    const received = await ok(call('POST', `/v1/floor/indents/${INDENT}/issues/is-1/receipt`, SHELF, { counted: [{ productId: PRODUCT, quantityMinor: GOOD }] }, 'ind-rc-1'), 201);
    expect(received).toMatchObject({ discrepancies: [] });
    expect(received['indent']).toMatchObject({ totals: expect.objectContaining({ issuedMinor: GOOD, receivedMinor: GOOD, inTransitMinor: 0, outstandingMinor: 0, shortfallMinor: 0 }) });
    stock = await availability();
    expect(stock.inTransit).toEqual([]);
    expect(await onHandAt(STORE)).toBe(GOOD);
    expect(await onHandAt(BACK)).toBe(0);
    expect(await valuationAt(STORE)).toBe(GOOD * COST);
    // The same receipt keyed again is the same receipt — the shelf does not double.
    await call('POST', `/v1/floor/indents/${INDENT}/issues/is-1/receipt`, SHELF, { counted: [{ productId: PRODUCT, quantityMinor: GOOD }] }, 'ind-rc-1');
    expect(await onHandAt(STORE)).toBe(GOOD);

    // ── 6. The till sells one of them — from the pulled head-office pack, through the real box, banked on the next pass.
    const edge = await startBox(cloud.token(BOX));
    expect(await edge.refreshPack!()).toMatchObject({ status: 'updated', heldVersion: 1 });
    const served = (await servedTillCatalogue(edge))!;
    expect(served).toMatchObject({ source: 'head_office', version: 1 });
    expect(served.products.map((p) => p.productId)).toEqual([PRODUCT]);
    const till = bootPos({ laneId: LANE, catalogue: served, lanePort: edge.lane!.port, tradingDayCutoff: '00:00' });
    till.signIn(CASHIER);
    const soldAt = new Date().toISOString();
    const tradingDay = tradingDateOf(soldAt, makeTradingDayRule('00:00'));
    expect(till.scanBarcode(BARCODE)).toMatchObject({ amountMinor: PRICE });
    expect(await till.tenderCash('S-1', 'R-S-1', soldAt)).toBe('R-S-1');
    expect(await edge.syncOnce!()).toMatchObject({ dead: 0, remaining: 0 });
    expect((await call('GET', '/v1/sales/S-1', OWNER)).body).toMatchObject({ saleId: 'S-1', banked: true });
    expect(await onHandAt(STORE)).toBe(GOOD - 1);
    expect(await valuationAt(STORE)).toBe((GOOD - 1) * COST);

    // ── 7. The supplier's bill for the twelve, captured as the paper says by the buyer, MATCHED by a second person against the
    //      STORED order and receipts (SP-7a): all twelve came into our custody, so the match owes twelve — and the two returned
    //      tins come off through a debit note (SP-7b), never by editing the invoice.
    const paper = { supplierId: SUPPLIER, poId: PO, declaredTotalMinor: ORDERED * COST, lines: [{ productId: PRODUCT, quantity: ORDERED, unitPriceMinor: COST, lineTotalMinor: ORDERED * COST }] };
    const captured = await ok(call('POST', '/v1/purchase/invoices/inv-1/capture', BUYER, { ...paper, approvedBy: CHECKER }, 'cap-inv-1'), 201);
    expect(captured).toMatchObject({ alreadyCaptured: false, invoice: { invoiceId: 'inv-1', supplierId: SUPPLIER, poId: PO, totalMinor: ORDERED * COST, capturedBy: BUYER, approvedBy: CHECKER } });
    // The capturer may not name themself as the invoice's approver (§28) — refused at capture, nothing stored.
    expect((await call('POST', '/v1/purchase/invoices/inv-self/capture', BUYER, { ...paper, approvedBy: BUYER }, 'cap-inv-self')).status).toBeGreaterThanOrEqual(400);
    expect((await call('GET', '/v1/purchase/invoices/inv-self', OWNER)).status).toBe(404);
    const matched = await ok(call('POST', '/v1/purchase/invoices/inv-1/match', CHECKER, {}, 'mat-inv-1'), 200);
    expect(matched).toMatchObject({ invoiceId: 'inv-1', poId: PO, blocked: false, payableMinor: ORDERED * COST, withheldMinor: 0, matchedBy: CHECKER });
    const note = await ok(call('POST', `/v1/purchase/suppliers/${SUPPLIER}/debit-notes/DN-${GRN}-L2/issue`, CHECKER, {}, 'dn-1'), 201);
    expect(note).toMatchObject({ debitNoteRef: `DN-${GRN}-L2`, valueMinor: DAMAGED * COST, issuedBy: CHECKER, alreadyIssued: false });
    const account = await ok(call('GET', `/v1/purchase/suppliers/${SUPPLIER}/account`, OWNER), 200) as { totals: Record<string, number> };
    expect(account.totals).toMatchObject({ invoicedMinor: ORDERED * COST, accruedMinor: ORDERED * COST, withheldMinor: 0, debitNotesMinor: DAMAGED * COST, paidMinor: 0, owedMinor: GOOD * COST });

    // ── 8. The books: the accountant maps the accounts once, posts the payables (accrual + debit note, balanced) and the day book
    //      (the sale, balanced); the register's "owed" and the ledger's agree to the paisa.
    await ok(call('PUT', '/v1/finance/posting-map', ACCT, DEFAULT_RETAIL_POSTING_MAP, 'map-1'), 200);
    const payables = await ok(call('POST', '/v1/finance/payables/post', ACCT, {}, 'pay-1'), 201) as { journals: { kind: string; lines: { debitMinor: number; creditMinor: number }[] }[]; exceptions: unknown[] };
    expect(payables.exceptions).toEqual([]);
    expect(payables.journals.map((j) => j.kind).sort()).toEqual(['supplier_debit_note', 'supplier_invoice']);
    for (const j of payables.journals) {
      expect(j.lines.reduce((s, l) => s + l.debitMinor, 0), `journal ${j.kind} does not balance`).toBe(j.lines.reduce((s, l) => s + l.creditMinor, 0));
    }
    const ledger = await ok(call('GET', '/v1/finance/payables', ACCT), 200) as { reconciliation: { agrees: boolean; registerOwedMinor: number; ledgerOwedMinor: number; differenceMinor: number } };
    expect(ledger.reconciliation).toMatchObject({ agrees: true, registerOwedMinor: GOOD * COST, ledgerOwedMinor: GOOD * COST, differenceMinor: 0 });
    const dayPost = await call('POST', `/v1/finance/day-book/${tradingDay}/post`, ACCT, undefined, `post-${tradingDay}`);
    expect(dayPost.status, JSON.stringify(dayPost.body)).toBeLessThan(300);
    const day = dayPost.body as { journals: { kind: string; lines: { debitMinor: number; creditMinor: number }[] }[]; exceptions: unknown[] };
    expect(day.exceptions).toEqual([]);
    expect(day.journals.map((j) => j.kind)).toEqual(expect.arrayContaining(['sale', 'tender:cash']));
    for (const j of day.journals) {
      expect(j.lines.reduce((s, l) => s + l.debitMinor, 0), `journal ${j.kind} does not balance`).toBe(j.lines.reduce((s, l) => s + l.creditMinor, 0));
    }
    // ── 9. The owner's dashboard shows the one sale, dated by the shop's day.
    const dash = await ok(call('GET', '/v1/reports/dashboard', OWNER), 200) as { figures: { name: string; valueMinor?: number }[] };
    expect(dash.figures.find((f) => f.name === 'Sales today')).toMatchObject({ valueMinor: PRICE });
  }, 120_000);

  it('two tills sell from the same shelf at once; one loses the line to head office mid-day, keeps trading from the pack it holds, and banks when the line returns — stock falls once per sale, nothing doubles, nothing is lost', async () => {
    const before = await onHandAt(STORE); // what the first case left on the shelf
    const sold = async (edge: EdgeProcess, laneId: string, saleId: string, receipt: string): Promise<void> => {
      const served = (await servedTillCatalogue(edge))!;
      expect(served).toMatchObject({ source: 'head_office', version: 1 });
      const till = bootPos({ laneId, catalogue: served, lanePort: edge.lane!.port, tradingDayCutoff: '00:00' });
      till.signIn(CASHIER);
      till.scanBarcode(BARCODE);
      expect(await till.tenderCash(saleId, receipt, new Date().toISOString())).toBe(receipt);
    };

    // Two lanes, two boxes, one shelf — both pull the same pack from head office this morning.
    const laneA = await startBox(cloud.token(BOX), { laneId: 'lane-1' });
    const laneB = await startBox(cloud.token(BOX), { laneId: 'lane-2' });
    expect(await laneA.refreshPack!()).toMatchObject({ status: 'updated', heldVersion: 1 });
    expect(await laneB.refreshPack!()).toMatchObject({ status: 'updated', heldVersion: 1 });
    const laneBDir = dirs[dirs.length - 1]!;

    // Mid-day lane 2's line to head office is cut (the box comes back up with head office unreachable). It still trades: the
    // till is served from the pack the box restored from its own disk, and the sale is on that disk first.
    await stopBox(laneB);
    const cutOff = await startBox(cloud.token(BOX), { laneId: 'lane-2', dir: laneBDir, cloudUrl: 'http://127.0.0.1:9' });
    expect(cutOff.node.pack()?.snapshot.version).toBe(1);
    await sold(laneA, 'lane-1', 'S-A1', 'R-A1');
    await sold(cutOff, 'lane-2', 'S-B1', 'R-B1');
    expect(cutOff.outbox.pending()[0]!.event.payload).toMatchObject({ saleId: 'S-B1', laneId: 'lane-2', locationId: STORE, totalMinor: PRICE });
    expect(await onHandAt(STORE)).toBe(before); // nothing has reached head office yet

    // Lane 1 reaches head office: the shelf falls by ITS sale only. Lane 2 tries, cannot, and keeps the sale — pending,
    // visible, never dead-lettered, still findable for a refund on that lane (offline first, hard rule #1).
    expect(await laneA.syncOnce!()).toMatchObject({ sent: 1, dead: 0, remaining: 0 });
    expect(await onHandAt(STORE)).toBe(before - 1);
    expect(await cutOff.syncOnce!()).toMatchObject({ sent: 0, dead: 0, remaining: 1 });
    expect((await call('GET', '/v1/sales/S-B1', OWNER)).status).toBe(404);
    expect(await onHandAt(STORE)).toBe(before - 1);
    expect(await cutOff.node.lookupSale('R-B1')).toBeDefined();

    // The line returns (the box restarted on the live URL): the queued sale is rebuilt from the disk, banks once, the shelf
    // falls once more, and a second pass sends nothing.
    await stopBox(cutOff);
    const back = await startBox(cloud.token(BOX), { laneId: 'lane-2', dir: laneBDir });
    expect(await back.syncOnce!()).toMatchObject({ sent: 1, dead: 0, remaining: 0 });
    expect((await call('GET', '/v1/sales/S-B1', OWNER)).body).toMatchObject({ saleId: 'S-B1', banked: true });
    expect(await onHandAt(STORE)).toBe(before - 2);
    expect(await back.syncOnce!()).toMatchObject({ sent: 0, dead: 0, remaining: 0 });
    expect(await onHandAt(STORE)).toBe(before - 2);

    // Head office's day: three sales (one from the first case, one per lane), each named by its lane and cashier.
    const dash = await ok(call('GET', '/v1/reports/dashboard', OWNER), 200) as { figures: { name: string; valueMinor?: number }[] };
    expect(dash.figures.find((f) => f.name === 'Sales today')).toMatchObject({ valueMinor: 3 * PRICE });
    expect(dash.figures.find((f) => f.name === 'Sales today — receipts')).toMatchObject({ valueMinor: 3 });
  }, 120_000);
});
