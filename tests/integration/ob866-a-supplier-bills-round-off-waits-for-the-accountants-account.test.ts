import { describe, it, expect } from 'vitest';
import { randomUUID } from 'node:crypto';
import { useRestartableBackings } from '../support/p3-backings';
import { P3, p3Shop, caller, issuedOrder, received } from '../support/p3-purchase';
import { DEFAULT_RETAIL_POSTING_MAP, type PostingMap } from '../../packages/finance/src/index';

// OB-866 B (owner, 19 Nov 2026, in writing) · M07-FR-04 · WF-05 · pilot audit B-10 — a supplier bill typed from the paper may
// carry its "Round off" line (signed, at most ±₹1.00). It is part of the bill's total and of the three-way match. In the books
// it posts to a SEPARATE "Purchase round off" account the accountant names on the posting map; until then the bill's whole
// entry WAITS, named "purchase_round_off_not_named" — nothing goes into purchases silently. Once named, the waiting bill posts
// once (a re-run posts nothing twice) and append-only. Synthetic data. In memory and — with DATABASE_URL — on real PostgreSQL,
// with a cold restart.

const backings = useRestartableBackings();
const codeOf = (res: { body: unknown }): string | undefined => (res.body as { error?: { code?: string } }).error?.code;
const RICE = [{ productId: 'rice', qty: 10, unitMinor: 5_000 }] as const; // ₹500.00 of goods
const lineBody = RICE.map((l) => ({ productId: l.productId, quantity: l.qty, unitPriceMinor: l.unitMinor, lineTotalMinor: l.qty * l.unitMinor }));
// The accountant's own name for the account — synthetic; the system never invents one.
const ACCOUNT = 'purchase_round_off_synthetic';

interface Journal { entryId: string; kind: string; sourceId: string; components: Record<string, number>; lines: { accountCode: string; debitMinor: number; creditMinor: number }[] }
interface Payables {
  journals: Journal[];
  exceptions: { exceptionId: string; kind: string; sourceIds: string[]; reason: string; detail: string; state: string }[];
  open: number;
  reconciliation: { suppliers: { supplierId: string; registerOwedMinor: number; ledgerOwedMinor: number; agrees: boolean }[] };
}

describe.each(backings)('OB-866 B — a supplier bill\'s round off (M07-FR-04 · WF-05) — on $name', ({ harness }) => {
  it('is typed, adds up, matches; waits by name until the accountant names the Purchase round-off account; then posts once', async () => {
    const h = harness();
    const T = randomUUID();
    await p3Shop(h, T);
    const call = caller(h, T);
    for (const id of ['a', 'b', 'c']) {
      await issuedOrder(call, `po-${id}`, RICE);
      await received(call, `grn-${id}`, `po-${id}`, RICE);
    }
    const capture = (id: string, poId: string, declaredTotalMinor: number, roundOffMinor?: unknown) =>
      call('POST', `/v1/purchase/invoices/${id}/capture`, P3.BUYER, { supplierId: 'sup-1', poId, declaredTotalMinor, lines: lineBody, ...(roundOffMinor === undefined ? {} : { roundOffMinor }) });

    // ── More than a rupee is refused in plain words; nothing is saved ─────────────────────────────────────────────
    const big = await capture('inv-a', 'po-a', 49_850, -150);
    expect(big.status).toBe(422);
    expect(codeOf(big)).toBe('round_off_more_than_one_rupee');
    expect(JSON.stringify(big.body)).toContain('A round off is at most one rupee either way');
    expect(codeOf(await capture('inv-a', 'po-a', 49_960, 'minus forty'))).toBe('not_readable_as_a_supplier_invoice');
    expect(codeOf(await capture('inv-a', 'po-a', 49_960, -0.4))).toBe('not_readable_as_a_supplier_invoice');
    // The round off is part of the total: typed without it, the paper's total does not add up.
    expect(codeOf(await capture('inv-a', 'po-a', 49_960))).toBe('does_not_add_up_to_the_invoice_total');
    expect((await call('GET', '/v1/purchase/invoices/inv-a', P3.MATCHER)).status).toBe(404);

    // ── "Round off −0.40" and "Round off +0.60" are captured; a third bill has none ───────────────────────────────
    const a = await capture('inv-a', 'po-a', 49_960, -40);
    expect(a.status).toBe(201);
    expect((a.body as { invoice: { totalMinor: number; roundOffMinor: number } }).invoice).toMatchObject({ totalMinor: 49_960, roundOffMinor: -40 });
    expect((await capture('inv-c', 'po-c', 50_060, 60)).status).toBe(201);
    const b = await capture('inv-b', 'po-b', 50_000, 0);
    expect((b.body as { invoice: Record<string, unknown> }).invoice['roundOffMinor'], 'nought is none').toBeUndefined();

    // ── It is part of the three-way match: the bill agrees and its round off is payable with it ─────────────────────
    for (const id of ['a', 'b', 'c']) expect((await call('POST', `/v1/purchase/invoices/inv-${id}/match`, P3.MATCHER, {})).status).toBeLessThan(300);
    const matchOf = async (id: string) => ((await call('GET', `/v1/purchase/invoices/${id}`, P3.MATCHER)).body as { match: { blocked: boolean; payableMinor: number; invoicedMinor: number; withheldMinor: number; roundOffMinor?: number } }).match;
    expect(await matchOf('inv-a')).toMatchObject({ blocked: false, payableMinor: 49_960, invoicedMinor: 49_960, withheldMinor: 0, roundOffMinor: -40 });
    expect(await matchOf('inv-c')).toMatchObject({ blocked: false, payableMinor: 50_060, roundOffMinor: 60 });

    // ── The posting map offers the round-off figures blank — no account suggested ─────────────────────────────────
    const offered = (await call('GET', '/v1/finance/posting-map', P3.MATCHER)).body as { legsToName: { kind: string; legs: { side: string; component: string }[] }[]; suggested: PostingMap };
    expect(offered.legsToName).toContainEqual({ kind: 'supplier_invoice', legs: [{ side: 'debit', component: 'purchase_round_off_up' }, { side: 'credit', component: 'purchase_round_off_down' }] });
    expect(JSON.stringify(offered.suggested)).not.toContain('purchase_round_off');

    // ── The accountant's map without the account: the plain bill posts; the two with a round off WAIT, by name ──────
    const putMap = (map: PostingMap, key: string) => h.request({ method: 'PUT', path: '/v1/finance/posting-map', userId: P3.MATCHER, tenantId: T, idempotencyKey: key, body: map });
    expect((await putMap(DEFAULT_RETAIL_POSTING_MAP, 'map-1')).status).toBeLessThan(300);
    const first = await call('POST', '/v1/finance/payables/post', P3.MATCHER, {}, 'post-1');
    expect(first.status).toBe(201);
    const posted1 = first.body as { journals: Journal[]; exceptions: { reason: string; sourceIds: string[]; detail: string }[] };
    expect(posted1.journals.map((j) => j.sourceId)).toEqual(['inv-b']);
    expect(posted1.exceptions.map((e) => [e.sourceIds[0], e.reason]).sort()).toEqual([['inv-a', 'purchase_round_off_not_named'], ['inv-c', 'purchase_round_off_not_named']]);
    expect(posted1.exceptions.find((e) => e.sourceIds[0] === 'inv-a')!.detail).toMatch(/^Bill inv-a \(supplier sup-1\) has a round off of −₹0\.40; it was captured and matched, and nothing of it was posted\./);
    let books = (await call('GET', '/v1/finance/payables', P3.MATCHER)).body as Payables;
    expect(books.open).toBe(2);
    expect(books.journals.some((j) => j.sourceId === 'inv-a' || j.sourceId === 'inv-c'), 'nothing of a waiting bill is in the books — not even into purchases').toBe(false);
    expect(books.reconciliation.suppliers[0]).toMatchObject({ registerOwedMinor: 150_020, ledgerOwedMinor: 50_000, agrees: false });
    // A second press posts nothing new and still says they wait.
    const again = await call('POST', '/v1/finance/payables/post', P3.MATCHER, {}, 'post-2');
    expect(again.status).toBe(200);
    expect((again.body as { journals: unknown[] }).journals).toEqual([]);

    // ── The accountant names the account (his own name for it) on the supplier-bill rule ──────────────────────────
    const named: PostingMap = {
      rules: DEFAULT_RETAIL_POSTING_MAP.rules.map((r) => (r.kind !== 'supplier_invoice' ? r : {
        kind: r.kind, legs: [...r.legs, { account: ACCOUNT, side: 'debit', component: 'purchase_round_off_up' }, { account: ACCOUNT, side: 'credit', component: 'purchase_round_off_down' }],
      })),
    };
    expect((await putMap(named, 'map-2')).status).toBeLessThan(300);
    const second = await call('POST', '/v1/finance/payables/post', P3.MATCHER, {}, 'post-3');
    expect(second.status).toBe(201);
    const posted2 = (second.body as { journals: Journal[] }).journals;
    expect(posted2.map((j) => j.sourceId).sort()).toEqual(['inv-a', 'inv-c']);
    const ja = posted2.find((j) => j.sourceId === 'inv-a')!;
    // −0.40: goods ₹500.00 to purchases, the supplier owed ₹499.60, the 40 paise CREDITED to the round-off account.
    expect(ja.lines).toEqual([
      { accountCode: 'purchases_grni', debitMinor: 50_000, creditMinor: 0 },
      { accountCode: 'supplier_payable', debitMinor: 0, creditMinor: 49_960 },
      { accountCode: ACCOUNT, debitMinor: 0, creditMinor: 40 },
    ]);
    const jc = posted2.find((j) => j.sourceId === 'inv-c')!;
    expect(jc.lines).toEqual([
      { accountCode: 'purchases_grni', debitMinor: 50_000, creditMinor: 0 },
      { accountCode: 'supplier_payable', debitMinor: 0, creditMinor: 50_060 },
      { accountCode: ACCOUNT, debitMinor: 60, creditMinor: 0 },
    ]);
    books = (await call('GET', '/v1/finance/payables', P3.MATCHER)).body as Payables;
    expect(books.open, 'the waiting items are resolved by their journals').toBe(0);
    expect(books.exceptions.every((e) => e.state === 'resolved'), 'the waiting record is kept as evidence, resolved').toBe(true);
    expect(books.reconciliation.suppliers[0]).toMatchObject({ registerOwedMinor: 150_020, ledgerOwedMinor: 150_020, agrees: true });
    // The plain bill's journal is untouched (append-only): still one journal for inv-b.
    expect(books.journals.filter((j) => j.sourceId === 'inv-b')).toHaveLength(1);

    // ── Posted once: a re-run posts nothing, and a cold restart reads the same books ──────────────────────────────
    const third = await call('POST', '/v1/finance/payables/post', P3.MATCHER, {}, 'post-4');
    expect(third.status).toBe(200);
    expect((third.body as { journals: unknown[] }).journals).toEqual([]);
    const cold = caller(harness(h), T);
    const coldBooks = (await cold('GET', '/v1/finance/payables', P3.MATCHER)).body as Payables;
    expect(coldBooks.journals.map((j) => j.entryId).sort()).toEqual(books.journals.map((j) => j.entryId).sort());
    expect((await cold('POST', '/v1/finance/payables/post', P3.MATCHER, {}, 'post-5')).body).toMatchObject({ journals: [] });
  }, 120_000);
});
