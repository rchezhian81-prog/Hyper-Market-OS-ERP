import { describe, it, expect } from 'vitest';
import { randomUUID } from 'node:crypto';
import { useRestartableBackings } from '../support/p3-backings';
import { P3, p3Shop, caller, issuedOrder, received } from '../support/p3-purchase';
import { parseGstEInvoice } from '../../packages/purchasing/src/invoice-extraction';
import { DEFAULT_RETAIL_POSTING_MAP, type PostingMap } from '../../packages/finance/src/index';
import { capturePortalInvoice, type PurchaseDeps, type SupplierInvoiceRecord } from '../../services/purchase/src/index';

// Pending list 27 Nov 2026 — item 6 (OB-866 B follow-through · M07-FR-04 · WF-05 · D03-FR-02): a GST e-invoice's own round-off
// figure (`ValDtls.RndOffAmt`) is read into the bill's round off exactly as a typed round off is — signed, at most ±₹1.00, part
// of the bill's total and of its check against the order, posted to the accountant's "Purchase round off" account once he names
// it and WAITING (said on the Day book) until then. A round off above the limit is NOT taken: the e-invoice's total then does
// not add up and the difference is shown for a person to decide ("accept the difference"), as before. Lines + charges + round
// off must equal `TotInvVal`. Before: any e-invoice with a round off needed "accept the difference". Synthetic data only.
// In memory and — with DATABASE_URL — on real PostgreSQL, with a cold restart.

const GSTIN = '33ABCDE1234F1Z5';
// 10 rice at ₹50.80 = ₹508.00 + CGST ₹12.70 + SGST ₹12.70 = ₹533.40; the supplier rounds it to ₹533.00 (round off −0.40).
const RICE = [{ productId: 'rice', qty: 10, unitMinor: 5_080 }] as const;
const eInvoice = (no: string, val: Record<string, unknown>, typ = 'INV') => ({
  Version: '1.1', Irn: `irn-synthetic-${no}`,
  TranDtls: { TaxSch: 'GST', SupTyp: 'B2B' },
  DocDtls: { Typ: typ, No: no, Dt: '20/10/2026' },
  SellerDtls: { Gstin: GSTIN, LglNm: 'Synthetic Agro Traders', Addr1: 'Synthetic street', Loc: 'Erode', Pin: 638001, Stcd: '33' },
  BuyerDtls: { Gstin: '33ZZZZZ9999Z1Z9', LglNm: 'Synthetic Hyper Market', Pos: '33', Addr1: 'Synthetic road', Loc: 'Erode', Pin: 638001, Stcd: '33' },
  ItemList: [{ SlNo: '1', PrdDesc: 'Ponni rice 1 kg', IsServc: 'N', HsnCd: '1006', Barcde: 'S-RICE', Qty: 10, Unit: 'NOS', UnitPrice: 50.8, TotAmt: 508, AssAmt: 508, GstRt: 5, CgstAmt: 12.7, SgstAmt: 12.7, IgstAmt: 0, TotItemVal: 533.4 }],
  ValDtls: { AssVal: 508, CgstVal: 12.7, SgstVal: 12.7, IgstVal: 0, ...val },
});
const codeOf = (res: { body: unknown }): string | undefined => (res.body as { error?: { code?: string } }).error?.code;
// The accountant's own name for the account — synthetic; the system never invents one.
const ACCOUNT = 'purchase_round_off_synthetic';

describe('the e-invoice reader reads ValDtls.RndOffAmt — signed, exactly, or said (unit)', () => {
  it('reads −0.40, +0.60 and "-0.40" as signed paise; nought or none is no round off; an unreadable figure is said, never guessed', () => {
    const minus = parseGstEInvoice(eInvoice('A1', { RndOffAmt: -0.4, TotInvVal: 533 }));
    expect(minus).toMatchObject({ ok: true, invoice: { roundOffMinor: -40, statedTotalMinor: 53_300 } });
    expect(parseGstEInvoice(eInvoice('A2', { RndOffAmt: 0.6, TotInvVal: 534 }))).toMatchObject({ ok: true, invoice: { roundOffMinor: 60 } });
    expect(parseGstEInvoice(eInvoice('A3', { RndOffAmt: '-0.40', TotInvVal: '533.00' }))).toMatchObject({ ok: true, invoice: { roundOffMinor: -40, statedTotalMinor: 53_300 } });
    for (const none of [0, '0.00', null, undefined]) {
      const p = parseGstEInvoice(eInvoice('A4', { RndOffAmt: none, TotInvVal: 533.4 }));
      expect(p.ok && 'roundOffMinor' in p.invoice, `RndOffAmt ${String(none)} is no round off`).toBe(false);
    }
    const smudged = parseGstEInvoice(eInvoice('A5', { RndOffAmt: '-0.405', TotInvVal: 533 }));
    expect(smudged.ok && 'roundOffMinor' in smudged.invoice).toBe(false);
    expect(smudged.ok && smudged.invoice.warnings).toEqual(expect.arrayContaining(['round off (RndOffAmt) "-0.405" has more than two decimals or is not a number — not read']));
    // A figure over a rupee is READ as printed — head office's own limit decides it is not a round off (see the API test).
    expect(parseGstEInvoice(eInvoice('A6', { RndOffAmt: -1.4, TotInvVal: 532 }))).toMatchObject({ ok: true, invoice: { roundOffMinor: -140 } });
  });

  // OB-937 A (27 Nov 2026): head office now REFUSES a credit or debit note on Supplier bills (pending09 test); the reader still
  // names it and still does not take its round off.
  it('a credit or debit note\'s round off is not read (no rule for it yet) — said; the reader names the note so head office refuses it', () => {
    for (const typ of ['CRN', 'DBN']) {
      const p = parseGstEInvoice(eInvoice(`N-${typ}`, { RndOffAmt: -0.4, TotInvVal: 533 }, typ));
      expect(p.ok && 'roundOffMinor' in p.invoice).toBe(false);
      expect(p.ok && p.invoice.documentType).toBe(typ);
      expect(p.ok && p.invoice.warnings).toEqual(expect.arrayContaining([`this e-invoice is a ${typ === 'CRN' ? 'credit' : 'debit'} note (${typ}): its round off (RndOffAmt) is not read — a person decides the difference`]));
    }
  });
});

describe('the register\'s capture holds a read round off to the typed rule (unit)', () => {
  it('a round off over ±₹1.00, or not whole paise, is refused and nothing is recorded; within it, it is part of the total', async () => {
    const kept: SupplierInvoiceRecord[] = [];
    const deps = {
      invoice: () => undefined, purchaseOrder: () => undefined, recordInvoice: (_t: string, r: SupplierInvoiceRecord) => { kept.push(r); },
      now: () => '2026-11-27T06:00:00.000Z',
    } as unknown as PurchaseDeps;
    const input = (roundOffMinor: number, declaredTotalMinor: number) => ({
      invoiceId: 'inv-u', supplierId: 'sup-1', poId: null, declaredTotalMinor, submittedBy: 'u-b', reviewedBy: 'u-b', submissionId: 'd-u', branchId: null, roundOffMinor,
      lines: [{ productId: 'rice', quantity: 10, unitPriceMinor: 5_080, lineTotalMinor: 50_800 }],
    });
    expect(await capturePortalInvoice(deps, 'T', input(-140, 50_660))).toMatchObject({ ok: false, code: 'round_off_more_than_one_rupee' });
    expect(await capturePortalInvoice(deps, 'T', input(-0.4, 50_799.6))).toMatchObject({ ok: false, code: 'not_readable_as_a_supplier_invoice' });
    expect(await capturePortalInvoice(deps, 'T', input(-40, 50_800))).toMatchObject({ ok: false, code: 'does_not_add_up_to_the_invoice_total' });
    expect(kept).toEqual([]);
    expect(await capturePortalInvoice(deps, 'T', input(-40, 50_760))).toMatchObject({ ok: true, record: { totalMinor: 50_760, roundOffMinor: -40 } });
    expect(kept).toHaveLength(1);
  });
});

const backings = useRestartableBackings();

describe.each(backings)('pending item 6 — an e-invoice\'s own round off is the bill\'s round off (OB-866 B) — on $name', ({ harness }) => {
  it('is read, adds up to TotInvVal, matches, waits for the Purchase round-off account, then posts once; above ±₹1.00 it is a difference to decide', async () => {
    const h = harness();
    const T = randomUUID();
    await p3Shop(h, T);
    const call = caller(h, T);
    for (const id of ['a', 'b']) {
      await issuedOrder(call, `po-${id}`, RICE);
      await received(call, `grn-${id}`, `po-${id}`, RICE);
    }
    const handIn = (doc: string, bill: unknown, poId: string) => call('POST', `/v1/purchase/invoice-documents/${doc}`, P3.BUYER, { kind: 'e_invoice', eInvoice: bill, supplierId: 'sup-1', poId }, `hand-${doc}`);
    const confirm = (doc: string, invoiceId: string, extra: Record<string, unknown> = {}, key = `confirm-${doc}`) =>
      call('POST', `/v1/purchase/invoice-documents/${doc}/confirm`, P3.BUYER, { invoiceId, lines: [{ lineNo: 1, productId: 'rice' }], ...extra }, key);

    // ── "Round off −0.40": read off the e-invoice, said on the draft, no difference to accept ──────────────────────
    const drafted = await handIn('d-a', eInvoice('SA/1', { RndOffAmt: -0.4, TotInvVal: 533 }), 'po-a');
    expect(drafted.status).toBe(201);
    // Confirmed with NO "accept the difference": the lines (₹533.40) and the round off (−₹0.40) make the printed ₹533.00.
    const a = await confirm('d-a', 'inv-a');
    expect(a.status, `needs no "accept the difference": ${JSON.stringify(a.body)}`).toBe(201);
    const draft = (drafted.body as { document: { extracted: { roundOffMinor?: number; statedTotalMinor: number }; problems: string[] } }).document;
    expect(draft.extracted).toMatchObject({ roundOffMinor: -40, statedTotalMinor: 53_300 });
    expect(draft.problems.some((p) => /round off/i.test(p)), 'a round off within the limit is not a problem').toBe(false);
    expect((a.body as { invoice: Record<string, unknown> }).invoice).toMatchObject({ invoiceId: 'inv-a', totalMinor: 53_300, declaredTotalMinor: 53_300, roundOffMinor: -40, source: 'e-invoice/irn-synthetic-SA/1' });
    // The capture's audit record carries it, as a typed capture's does.
    const trail = (await h.request({ method: 'GET', path: '/v1/audit/trail', userId: P3.OWNER, tenantId: T, query: { action: 'invoice.capture.e_invoice' } })).body as { matches: { objectId: string; after: Record<string, string> | null }[] };
    expect(trail.matches.find((m) => m.objectId === 'inv-a')?.after).toMatchObject({ totalMinor: '53300', roundOffMinor: '-40' });

    // ── "Round off −1.40" is more than a rupee: NOT taken; said on the draft; the total does not add up ────────────
    const big = await handIn('d-b', eInvoice('SA/2', { RndOffAmt: -1.4, TotInvVal: 532 }), 'po-b');
    const bigDraft = (big.body as { document: { problems: string[] } }).document;
    expect(bigDraft.problems).toContain('the e-invoice\'s round off (RndOffAmt) is −₹1.40 — more than one rupee either way, so it is not taken as a round off: the difference is shown for a person to decide');
    const refused = await confirm('d-b', 'inv-b');
    expect(refused.status).toBe(422);
    expect(codeOf(refused)).toBe('does_not_add_up_to_the_bill');
    expect((await call('GET', '/v1/purchase/invoices/inv-b', P3.MATCHER)).status, 'nothing recorded').toBe(404);
    // The person decides: accepting the difference records the bill at its lines, with no round off — as before.
    const accepted = await confirm('d-b', 'inv-b', { acceptTotalDifference: true }, 'confirm-d-b-accept');
    expect(accepted.status).toBe(201);
    const invB = (accepted.body as { invoice: Record<string, unknown> }).invoice;
    expect(invB['totalMinor']).toBe(53_340);
    expect(invB['roundOffMinor']).toBeUndefined();

    // ── The check against the order (a second person): the bill agrees; its round off is payable with it ──────────
    expect((await call('POST', '/v1/purchase/invoices/inv-a/match', P3.MATCHER, {})).status).toBeLessThan(300);
    const matchA = ((await call('GET', '/v1/purchase/invoices/inv-a', P3.MATCHER)).body as { match: Record<string, unknown> }).match;
    expect(matchA).toMatchObject({ blocked: false, payableMinor: 53_300, invoicedMinor: 53_300, withheldMinor: 0, roundOffMinor: -40 });

    // ── The books: the accountant's map without the account → the bill WAITS, by name; nothing of it posts ───────
    const putMap = (map: PostingMap, key: string) => h.request({ method: 'PUT', path: '/v1/finance/posting-map', userId: P3.MATCHER, tenantId: T, idempotencyKey: key, body: map });
    expect((await putMap(DEFAULT_RETAIL_POSTING_MAP, 'map-1')).status).toBeLessThan(300);
    const first = await call('POST', '/v1/finance/payables/post', P3.MATCHER, {}, 'post-1');
    const posted1 = first.body as { journals: { sourceId: string }[]; exceptions: { reason: string; sourceIds: string[]; detail: string }[] };
    expect(posted1.journals.some((j) => j.sourceId === 'inv-a')).toBe(false);
    expect(posted1.exceptions.find((e) => e.sourceIds[0] === 'inv-a')).toMatchObject({ reason: 'purchase_round_off_not_named' });
    expect(posted1.exceptions.find((e) => e.sourceIds[0] === 'inv-a')!.detail).toMatch(/^Bill inv-a \(supplier sup-1\) has a round off of −₹0\.40; it was captured and matched, and nothing of it was posted\./);

    // ── The accountant names his account → the bill posts once: the 40 paise on the round-off account ──────────────
    const named: PostingMap = {
      rules: DEFAULT_RETAIL_POSTING_MAP.rules.map((r) => (r.kind !== 'supplier_invoice' ? r : {
        kind: r.kind, legs: [...r.legs, { account: ACCOUNT, side: 'debit', component: 'purchase_round_off_up' }, { account: ACCOUNT, side: 'credit', component: 'purchase_round_off_down' }],
      })),
    };
    expect((await putMap(named, 'map-2')).status).toBeLessThan(300);
    const second = await call('POST', '/v1/finance/payables/post', P3.MATCHER, {}, 'post-2');
    expect(second.status).toBe(201);
    const ja = (second.body as { journals: { sourceId: string; lines: { accountCode: string; debitMinor: number; creditMinor: number }[] }[] }).journals.find((j) => j.sourceId === 'inv-a')!;
    expect([...ja.lines].sort((x, y) => x.accountCode.localeCompare(y.accountCode))).toEqual([
      { accountCode: 'gst_input_cgst', debitMinor: 1_270, creditMinor: 0 },
      { accountCode: 'gst_input_sgst', debitMinor: 1_270, creditMinor: 0 },
      { accountCode: ACCOUNT, debitMinor: 0, creditMinor: 40 },
      { accountCode: 'purchases_grni', debitMinor: 50_800, creditMinor: 0 },
      { accountCode: 'supplier_payable', debitMinor: 0, creditMinor: 53_300 },
    ]);
    // Posted once: a re-run posts nothing; a cold restart reads the same bill and books.
    expect((await call('POST', '/v1/finance/payables/post', P3.MATCHER, {}, 'post-3')).body).toMatchObject({ journals: [] });
    const cold = caller(harness(h), T);
    expect(((await cold('GET', '/v1/purchase/invoices/inv-a', P3.MATCHER)).body as { invoice: Record<string, unknown> }).invoice).toMatchObject({ totalMinor: 53_300, roundOffMinor: -40 });
    expect((await cold('POST', '/v1/finance/payables/post', P3.MATCHER, {}, 'post-4')).body).toMatchObject({ journals: [] });
  }, 120_000);
});
