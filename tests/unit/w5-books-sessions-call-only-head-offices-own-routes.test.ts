import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { createBooksPostingsSession, BOOKS_POSTINGS_COPY, streamView, totalsFrom } from '../../apps/web-erp/src/books-postings-session';
import { createAccountClassesSession, ACCOUNT_CLASSES_COPY, classRows } from '../../apps/web-erp/src/account-classes-session';
import { createB2BBooksSession, B2B_BOOKS_COPY } from '../../apps/web-erp/src/b2b-books-session';
import { createConcessionTagsSession, CONCESSION_TAGS_COPY, lineBody } from '../../apps/web-erp/src/concession-tags-session';
import { createRelatedPartyOrderSession, RELATED_PARTY_ORDER_COPY } from '../../apps/web-erp/src/related-party-order-session';
import { createSupplierPaymentSession, SUPPLIER_PAYMENT_COPY, paymentBody } from '../../apps/web-erp/src/supplier-payment-session';
import { createSupplierPortalWatchSession, SUPPLIER_PORTAL_WATCH_COPY } from '../../apps/web-erp/src/supplier-portal-watch-session';
import { actionDetails } from '../../services/identity/src/approval-requests';
import { wireW5Books } from '../../apps/web-erp/src/w5-books-browser-wiring';

/**
 * **W5 — the accountant's books and the commercial ledgers: the head-office routes no screen reached.**
 *
 *   • M23-FR-01 (every operational event maps to a journal or an exception) · M22-FR-02 · D02-FR-06 · D09-FR-06 — Month-end's
 *     "Into the books": B2B invoices and collections, count differences and write-offs, stock confirmed lost, fleet
 *     settlements and display-funding receipts are read and posted through head office's own routes;
 *   • M23-FR-04 (control totals validate before close; a CA can sign them) · D10-FR-01 (centres tie to the ledger) — "For the
 *     CA": the month's independent checks become control totals and the CA's pack, a typed line from another source is
 *     carried with where both sides came from, and the centres are read;
 *   • M23-FR-01 — the account classes the P&L reads are read and saved by the accountant (head office's suggestion only shown);
 *   • M22-FR-01/02/04 · M23 — Business customers: the dunning step, AR against the books, the order's chain, portal probing;
 *   • M27-FR-02/03/04 — Concessions: the counter's lines, a desk record, reversal and adjustment (new lines), marking, breaches,
 *     the store's own stock value;
 *   • M15-FR-03 · OB-301 — the related-party check on an order and the owner's written approval;
 *   • M23-FR-01 · §28 — a supplier payment asked for, approved by a second person, recorded with exactly the approved details
 *     (no money moves);
 *   • M24-FR-02/03/04 — a supplier's papers and statement, and portal probing.
 * Each session is proven against a stand-in head office: it calls only the routes it names (and each exists in the services),
 * a person nobody named or a role without the permission is refused before any call, a form that does not read is refused
 * by name before any call; every word has a Tamil twin.
 */

interface Call { readonly url: string; readonly method: string; readonly body: unknown; readonly key: string | null }
function headOffice(answer: (url: string, method: string) => { status: number; body: unknown } | 'throw' = () => ({ status: 200, body: {} })) {
  const calls: Call[] = [];
  const fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const headers = (init?.headers ?? {}) as Record<string, string>;
    calls.push({ url: String(input), method: init?.method ?? 'GET', body: init?.body === undefined ? undefined : JSON.parse(String(init.body)) as unknown, key: headers['idempotency-key'] ?? null });
    const a = answer(String(input), init?.method ?? 'GET');
    if (a === 'throw') throw new TypeError('Failed to fetch');
    return new Response(JSON.stringify(a.body), { status: a.status, headers: { 'content-type': 'application/json' } });
  }) as typeof globalThis.fetch;
  return { fetch, calls };
}
const TAMIL = /[஀-௿]/;
const ids = () => { let n = 0; return (p: string) => `${p}-${n += 1}`; };

/** Every route template declared in services/** — so a session can be held to routes that exist. */
const ROUTES: readonly { method: string; path: string }[] = (() => {
  const out: { method: string; path: string }[] = [];
  const walk = (dir: string): void => {
    for (const f of readdirSync(dir)) {
      const p = join(dir, f);
      if (statSync(p).isDirectory()) walk(p);
      else if (f.endsWith('.ts') && !f.endsWith('.test.ts')) for (const m of readFileSync(p, 'utf8').matchAll(/method: '(GET|POST|PUT|DELETE)', path: '([^']+)'/g)) out.push({ method: m[1]!, path: m[2]! });
    }
  };
  walk('services');
  return out;
})();
function isRealRoute(method: string, url: string): boolean {
  const path = url.split('?')[0]!;
  return ROUTES.some((r) => r.method === method && new RegExp(`^${r.path.replace(/:[A-Za-z]+/g, '[^/]+')}$`).test(path));
}
const allReal = (calls: readonly Call[]) => { for (const c of calls) expect(isRealRoute(c.method, c.url), `${c.method} ${c.url} is not a head-office route`).toBe(true); };

describe('every word has a Tamil twin', () => {
  for (const [name, copy] of [['books', BOOKS_POSTINGS_COPY], ['account classes', ACCOUNT_CLASSES_COPY], ['b2b books', B2B_BOOKS_COPY], ['concession tags', CONCESSION_TAGS_COPY],
    ['related party', RELATED_PARTY_ORDER_COPY], ['supplier payment', SUPPLIER_PAYMENT_COPY], ['supplier portal watch', SUPPLIER_PORTAL_WATCH_COPY]] as const) {
    it(name, () => {
      expect(Object.keys(copy.ta).sort()).toEqual(Object.keys(copy.en).sort());
      for (const v of Object.values(copy.ta)) expect(['UPI', 'Cash'].includes(v) || TAMIL.test(v), v).toBe(true);
    });
  }
});

describe('M23-FR-01 · Month-end "Into the books"', () => {
  const ACCT = { userId: 'u-acct', permissions: ['finance.period.read', 'finance.journal.post'] };
  it('reads and posts each register through its own route; records a display-funding receipt in paise; all real routes', async () => {
    const ho = headOffice();
    const s = createBooksPostingsSession({ viewer: ACCT, fetch: ho.fetch, newId: ids() });
    expect(s.may).toEqual({ named: true, read: true, post: true });
    for (const st of ['b2b', 'stock', 'losses', 'fleet'] as const) { await s.read(st); await s.post(st); }
    await s.displayFunding();
    expect((await s.recordReceipt(' dc-1 ', { amountRupees: '12,500.50', receivedOn: '2026-09-04', reference: ' UTR9 ' })).result).toBe('ok');
    expect(ho.calls.map((c) => `${c.method} ${c.url}`)).toEqual([
      'GET /v1/finance/b2b/postings', 'POST /v1/finance/b2b/post', 'GET /v1/finance/stock-adjustments', 'POST /v1/finance/stock-adjustments/post',
      'GET /v1/finance/stock-losses', 'POST /v1/finance/stock-losses/post', 'GET /v1/finance/fleet-settlements', 'POST /v1/finance/fleet-settlements/post',
      'GET /v1/finance/display-funding', 'POST /v1/finance/display-funding/dc-1/receipts/rcpt-1',
    ]);
    expect(ho.calls.at(-1)!.body).toEqual({ amountMinor: 1_250_050, receivedOn: '2026-09-04', reference: 'UTR9' });
    for (const c of ho.calls.filter((x) => x.method !== 'GET')) expect(c.key).not.toBeNull();
    allReal(ho.calls);
  });
  it('a reader may not post; nobody named may not read; a receipt that does not read is refused — all before any call', async () => {
    const ho = headOffice();
    const reader = createBooksPostingsSession({ viewer: { userId: 'u-o', permissions: ['finance.period.read'] }, fetch: ho.fetch });
    expect(await reader.post('b2b')).toEqual({ result: 'invalid', why: 'cannotPost' });
    expect(await reader.recordReceipt('dc-1', { amountRupees: '1', receivedOn: '2026-09-01', reference: 'x' })).toEqual({ result: 'invalid', why: 'cannotPost' });
    const nobody = createBooksPostingsSession({ viewer: { permissions: ['finance.period.read'] }, fetch: ho.fetch });
    expect(await nobody.read('stock')).toEqual({ result: 'invalid', why: 'nobody' });
    const acct = createBooksPostingsSession({ viewer: ACCT, fetch: ho.fetch });
    for (const f of [{ amountRupees: '0', receivedOn: '2026-09-01', reference: 'x' }, { amountRupees: '10', receivedOn: '4 Sep', reference: 'x' }, { amountRupees: '10', receivedOn: '2026-09-01', reference: ' ' }]) {
      expect(await acct.recordReceipt('dc-1', f)).toEqual({ result: 'invalid', why: 'needReceipt' });
    }
    expect(ho.calls).toEqual([]);
  });
  it('lays out every register the same way: a movement with no value is "not known" (never zero), posted or not', () => {
    const stock = streamView('stock', { sources: [{ sourceId: 'count:1', kind: 'stock_count:shortage', productId: 'p', quantityMinor: 2, uom: 'ea', locationId: 'br-1', valueMinor: 5000, reason: 'r' }, { sourceId: 'count:2', kind: 'stock_count:surplus', productId: 'q', quantityMinor: 1, uom: 'ea', locationId: 'br-1', valueMinor: null, reason: 'r' }], unposted: ['count:2'], valueMinor: 5000, postedValueMinor: 5000 });
    expect(stock).toMatchObject({ inRegister: 2, inBooks: 1, waiting: 1, unvalued: 1, valueMinor: 5000, postedValueMinor: 5000 });
    expect(stock.rows.map((r) => [r.id, r.valueMinor, r.posted])).toEqual([['count:1', 5000, true], ['count:2', null, false]]);
    const b2b = streamView('b2b', { facts: [{ sourceId: 'inv-1', kind: 'invoice', customerId: 'c', documentDate: '2026-09-01', components: { total: 11800, net: 10000, tax: 1800 }, ref: 'TI/1' }, { sourceId: 'rc-1', kind: 'receipt', customerId: 'c', documentDate: '2026-09-02', components: { amount: 5000 }, ref: 'R1' }], unposted: ['rc-1'] });
    expect(b2b.rows.map((r) => [r.valueMinor, r.posted])).toEqual([[11800, true], [5000, false]]);
    expect(b2b.valueMinor).toBe(16800);
    const fleet = streamView('fleet', { connected: false, movements: [], unposted: [], detail: 'No books are connected' });
    expect(fleet.connected).toBe(false);
  });
});

describe('M23-FR-04 · D10-FR-01 · Month-end "For the CA"', () => {
  const READER = { userId: 'u-ca', permissions: ['finance.period.read'] };
  const CHECKS = [{ name: 'Card and UPI takings', leftMinor: 100_000, rightMinor: 100_000, leftDerivation: 'tills', rightDerivation: 'provider file' }];
  it('the month\'s checks become control totals with both derivations; a typed outside line rides beside them; the pack sends the cut-off', async () => {
    const ho = headOffice();
    const s = createBooksPostingsSession({ viewer: READER, fetch: ho.fetch });
    await s.evidence('2026-09');
    await s.controlTotals('2026-09', CHECKS, [{ name: ' GSTR-3B output tax ', booksRupees: '1,800', outsideRupees: '1,800', method: ' books | filed return ' }]);
    await s.evidencePack('2026-09', CHECKS, [], ' 02:00 ');
    await s.centres('2026-09');
    expect(ho.calls.map((c) => `${c.method} ${c.url}`)).toEqual([
      'GET /v1/finance/periods/2026-09/independent-evidence', 'POST /v1/finance/periods/2026-09/control-totals', 'POST /v1/finance/periods/2026-09/evidence-pack', 'GET /v1/finance/periods/2026-09/centres',
    ]);
    expect(ho.calls[1]!.body).toEqual({ totals: [
      { name: 'Card and UPI takings', ledgerMinor: 100_000, postedMinor: 100_000, method: 'tills | provider file' },
      { name: 'GSTR-3B output tax', ledgerMinor: 180_000, postedMinor: 180_000, method: 'books | filed return' },
    ] });
    expect(ho.calls[2]!.body).toEqual({ totals: [{ name: 'Card and UPI takings', ledgerMinor: 100_000, postedMinor: 100_000, method: 'tills | provider file' }], tradingDayCutoff: '02:00' });
    // The pack never types how many postings the accounts never received — head office reads it from the outbox.
    expect(JSON.stringify(ho.calls[2]!.body)).not.toContain('deadLettered');
    allReal(ho.calls);
  });
  it('nothing to compare, a half-typed line, no cut-off, or no month — refused by name before any call; the cut-off is never assumed', async () => {
    const ho = headOffice();
    const s = createBooksPostingsSession({ viewer: READER, fetch: ho.fetch });
    expect(await s.controlTotals('2026-09', [], [])).toEqual({ result: 'invalid', why: 'needLines' });
    expect(await s.controlTotals('2026-09', CHECKS, [{ name: 'x', booksRupees: '10', outsideRupees: '', method: 'm' }])).toEqual({ result: 'invalid', why: 'needLine' });
    expect(await s.evidencePack('2026-09', CHECKS, [], '')).toEqual({ result: 'invalid', why: 'needCutoff' });
    expect(await s.evidencePack('2026-09', CHECKS, [], '25:00')).toEqual({ result: 'invalid', why: 'needCutoff' });
    expect(await s.evidence('Sept')).toEqual({ result: 'invalid', why: 'needMonth' });
    expect(await s.centres('')).toEqual({ result: 'invalid', why: 'needMonth' });
    expect(ho.calls).toEqual([]);
    expect(totalsFrom([], [{ name: '', booksRupees: '', outsideRupees: '', method: '' }])).toEqual([]);
  });
});

describe('M23-FR-01 · Account classes', () => {
  it('reads; saves only the accounts given a class (never the suggestion by itself); a reader cannot save', async () => {
    const ho = headOffice();
    const s = createAccountClassesSession({ viewer: { userId: 'u-acct', permissions: ['finance.period.read', 'finance.journal.post'] }, fetch: ho.fetch });
    await s.read();
    await s.save({ sales_revenue: 'income', rent: '', ' cash ': 'asset', bogus: 'profit' });
    expect(ho.calls.map((c) => `${c.method} ${c.url}`)).toEqual(['GET /v1/finance/account-classes', 'PUT /v1/finance/account-classes']);
    expect(ho.calls[1]!.body).toEqual({ classes: { sales_revenue: 'income', cash: 'asset' } });
    allReal(ho.calls);
    expect(await s.save({ rent: '' })).toEqual({ result: 'invalid', why: 'needOne' });
    const reader = createAccountClassesSession({ viewer: { userId: 'u-o', permissions: ['finance.period.read'] }, fetch: ho.fetch });
    expect(await reader.save({ rent: 'expense' })).toEqual({ result: 'invalid', why: 'cannotSave' });
    expect(ho.calls).toHaveLength(2);
    // What the accountant set is shown as set; what head office suggests is only a suggestion beside it.
    expect(classRows({ defined: false, classes: {}, suggested: { rent: 'expense' } })).toEqual([{ account: 'rent', set: null, suggested: 'expense' }]);
  });
});

describe('M22-FR-01/02/04 · M23 · Business customers', () => {
  it('dunning, the books, the chain and probing — each on its own permission, the day sent as given', async () => {
    const ho = headOffice();
    const s = createB2BBooksSession({ viewer: { userId: 'u-acct', permissions: ['b2b.account.read', 'b2b.receivable.record', 'b2b.document.read'] }, fetch: ho.fetch });
    await s.dunning(' cust-1 ', '2026-09-30'); await s.reconciliation('cust-1', '2026-09-30'); await s.chain('cust-1', ' so-1 '); await s.probing();
    expect(ho.calls.map((c) => `${c.method} ${c.url}`)).toEqual([
      'GET /v1/b2b/collections/cust-1/dunning?asOf=2026-09-30', 'GET /v1/b2b/collections/cust-1/reconciliation?asOf=2026-09-30',
      'GET /v1/b2b/documents/cust-1/orders/so-1/chain', 'GET /v1/b2b-portal/probing',
    ]);
    expect(ho.calls.every((c) => c.method === 'GET')).toBe(true);
    allReal(ho.calls);
    const mgr = createB2BBooksSession({ viewer: { userId: 'u-mgr', permissions: ['b2b.account.read'] }, fetch: ho.fetch });
    expect(await mgr.reconciliation('cust-1', '2026-09-30')).toEqual({ result: 'invalid', why: 'cannotReconcile' });
    expect(await mgr.chain('cust-1', 'so-1')).toEqual({ result: 'invalid', why: 'cannotDocs' });
    expect(await mgr.dunning('', '2026-09-30')).toEqual({ result: 'invalid', why: 'needCustomer' });
    expect(await mgr.dunning('c', '30/09')).toEqual({ result: 'invalid', why: 'needDate' });
    expect(ho.calls).toHaveLength(4);
  });
});

describe('M27-FR-02/03/04 · Concessions', () => {
  const DESK = { userId: 'u-sup', permissions: ['concession.charge.read', 'concession.tag.record', 'concession.contract.manage'] };
  const LINE = { saleId: 'S1', lineId: '1', productId: 'ring', qty: '1', counterId: 'gold', tillId: 'desk', shiftId: 'sh-1', grossRupees: '5,000', discountRupees: '', taxRupees: '150', source: 'docket-7' };
  it('lists, records, reverses, adjusts, marks, reads breaches and the valuation — each through its own route', async () => {
    const ho = headOffice();
    const s = createConcessionTagsSession({ viewer: DESK, fetch: ho.fetch, newId: ids() });
    await s.tags('ct-gold', '2026-09-01', '2026-09-30');
    await s.record('ct-gold', LINE);
    await s.reverse('ct-gold', 'tag-1', ' wrong counter ');
    await s.adjust('ct-gold', 'tag-1', { grossRupees: '-500', discountRupees: '', taxRupees: '-15' }, ' price corrected ');
    await s.mark('ct-gold', 'included_in_charge', '2026-09-01', '2026-09-30');
    await s.breaches(); await s.valuation(' br-1 ');
    expect(ho.calls.map((c) => `${c.method} ${c.url}`)).toEqual([
      'GET /v1/concession/contracts/ct-gold/tags?from=2026-09-01&to=2026-09-30', 'POST /v1/concession/contracts/ct-gold/tags/tag-1',
      'POST /v1/concession/contracts/ct-gold/tags/tag-1/reverse', 'POST /v1/concession/contracts/ct-gold/tags/tag-1/adjust',
      'POST /v1/concession/contracts/ct-gold/tag-settlement', 'GET /v1/concession/trading-breaches', 'GET /v1/concession/branches/br-1/store-valuation',
    ]);
    expect(ho.calls[1]!.body).toEqual({ saleId: 'S1', lineId: '1', productId: 'ring', qty: 1, counterId: 'gold', tillId: 'desk', shiftId: 'sh-1', grossMinor: 500_000, discountMinor: 0, taxMinor: 15_000, source: 'docket-7' });
    expect(ho.calls[1]!.key).not.toBeNull();
    expect(ho.calls[2]!.body).toEqual({ reasonCode: 'wrong counter' });
    expect(ho.calls[3]!.body).toEqual({ reasonCode: 'price corrected', grossDeltaMinor: -50_000, discountDeltaMinor: 0, taxDeltaMinor: -1_500 });
    expect(ho.calls[4]!.body).toEqual({ status: 'included_in_charge', from: '2026-09-01', to: '2026-09-30' });
    allReal(ho.calls);
  });
  it('an incomplete line, a correction with no reason or no change, a marker without the manager\'s right — refused before any call', async () => {
    const ho = headOffice();
    const s = createConcessionTagsSession({ viewer: { userId: 'u-c', permissions: ['concession.tag.record'] }, fetch: ho.fetch });
    expect(lineBody({ ...LINE, qty: '1.5' })).toBeNull();
    expect(lineBody({ ...LINE, source: '' })).toBeNull();
    expect(await s.record('ct-gold', { ...LINE, grossRupees: '' })).toEqual({ result: 'invalid', why: 'needLine' });
    expect(await s.record('', LINE)).toEqual({ result: 'invalid', why: 'needContract' });
    expect(await s.reverse('ct-gold', 'tag-1', ' ')).toEqual({ result: 'invalid', why: 'needReason' });
    expect(await s.adjust('ct-gold', 'tag-1', { grossRupees: '0', discountRupees: '', taxRupees: '' }, 'x')).toEqual({ result: 'invalid', why: 'needDeltas' });
    expect(await s.mark('ct-gold', 'settled', '2026-09-01', '2026-09-30')).toEqual({ result: 'invalid', why: 'cannotManage' });
    expect(await s.breaches()).toEqual({ result: 'invalid', why: 'cannotRead' });
    expect(ho.calls).toEqual([]);
  });
});

describe('M15-FR-03 · OB-301 · the related-party check', () => {
  it('a buyer checks; only a holder of the owner\'s approval is offered approve, with a written reason', async () => {
    const ho = headOffice();
    const owner = createRelatedPartyOrderSession({ viewer: { userId: 'u-owner', permissions: ['purchase.commitment.read', 'purchase.relatedparty.approve'] }, fetch: ho.fetch });
    await owner.check(' PO-1 ');
    await owner.approve('PO-1', ' my brother-in-law\'s firm; price checked ');
    expect(ho.calls.map((c) => `${c.method} ${c.url}`)).toEqual(['GET /v1/purchase/orders/PO-1/related-party', 'POST /v1/purchase/orders/PO-1/related-party-approval']);
    expect(ho.calls[1]!.body).toEqual({ reason: 'my brother-in-law\'s firm; price checked' });
    allReal(ho.calls);
    expect(await owner.approve('PO-1', '')).toEqual({ result: 'invalid', why: 'needReason' });
    const buyer = createRelatedPartyOrderSession({ viewer: { userId: 'u-buyer', permissions: ['purchase.commitment.read'] }, fetch: ho.fetch });
    expect(buyer.may.approve).toBe(false);
    expect(await buyer.approve('PO-1', 'ok')).toEqual({ result: 'invalid', why: 'onlyOwner' });
    expect(await buyer.check('')).toEqual({ result: 'invalid', why: 'needPo' });
    expect(ho.calls).toHaveLength(2);
  });
});

describe('M23-FR-01 · §28 · a supplier payment — asked, approved by another, recorded exactly as approved', () => {
  it('asks with the record route\'s own details (the engine\'s fingerprint) and records them, naming the approval', async () => {
    const ho = headOffice((url, method) => (method === 'GET' ? { status: 200, body: { mine: [
      { requestId: 'areq-1', kind: 'supplier_payment', subjectRef: 'sup-1/pay-1', status: 'approved', valueMinor: 250_000, details: { amountMinor: 250_000, paidOn: '2026-09-05', method: 'bank_transfer', reference: 'UTR1', supplierId: 'sup-1', paymentId: 'pay-1' } },
      { requestId: 'areq-2', kind: 'supplier_payment', subjectRef: 'advance:adv-1', status: 'approved', valueMinor: 1, details: {} },
      { requestId: 'areq-3', kind: 'stock_write_off', subjectRef: 'x/y', status: 'approved', valueMinor: 1, details: {} },
    ] } } : url === '/v1/approvals/requests' ? { status: 201, body: { requestId: 'areq-1' } } : { status: 201, body: { payment: {}, alreadyRecorded: false, owedMinor: 0 } }));
    const s = createSupplierPaymentSession({ viewer: { userId: 'u-acct', permissions: ['purchase.supplier.pay'] }, fetch: ho.fetch, newId: () => 'pay-1' });
    const asked = await s.ask({ supplierId: ' sup-1 ', amountRupees: '2,500', paidOn: '2026-09-05', method: 'bank_transfer', reference: ' UTR1 ' });
    expect(asked).toEqual({ result: 'ok', value: { requestId: 'areq-1', paymentId: 'pay-1' } });
    const ask = ho.calls[0]!.body as { kind: string; subjectRef: string; details: Record<string, unknown>; valueMinor: number };
    expect(ask).toMatchObject({ kind: 'supplier_payment', subjectRef: 'sup-1/pay-1', valueMinor: 250_000 });
    const mine = await s.myAsks();
    expect(mine.result === 'ok' ? mine.value.map((a) => a.requestId) : []).toEqual(['areq-1']);
    await s.record((mine as { value: readonly Parameters<typeof s.record>[0][] }).value[0]!);
    const rec = ho.calls[2]!;
    expect(`${rec.method} ${rec.url}`).toBe('POST /v1/purchase/suppliers/sup-1/payments/pay-1');
    expect(rec.body).toEqual({ amountMinor: 250_000, paidOn: '2026-09-05', method: 'bank_transfer', reference: 'UTR1', approvalId: 'areq-1' });
    // The details asked for are exactly what head office fingerprints on the record route.
    expect(actionDetails(rec.body, { supplierId: 'sup-1', paymentId: 'pay-1' })).toEqual(ask.details);
    expect(JSON.stringify(ho.calls)).not.toMatch(/approvedBy|card|cvv/i);
    allReal(ho.calls);
  });
  it('a person without the right to pay, or a payment that does not read, is refused before any call', async () => {
    const ho = headOffice();
    const viewer = createSupplierPaymentSession({ viewer: { userId: 'u-b', permissions: ['supplier.view'] }, fetch: ho.fetch });
    expect(await viewer.ask({ supplierId: 's', amountRupees: '1', paidOn: '2026-09-01', method: 'cash', reference: 'r' })).toEqual({ result: 'invalid', why: 'cannotPay' });
    expect(paymentBody({ supplierId: 's', amountRupees: '1', paidOn: '2026-09-01', method: 'card', reference: 'r' })).toBeNull();
    expect(paymentBody({ supplierId: 's', amountRupees: '-1', paidOn: '2026-09-01', method: 'cash', reference: 'r' })).toBeNull();
    const payer = createSupplierPaymentSession({ viewer: { userId: 'u-a', permissions: ['purchase.supplier.pay'] }, fetch: ho.fetch });
    expect(await payer.ask({ supplierId: '', amountRupees: '1', paidOn: '2026-09-01', method: 'cash', reference: 'r' })).toEqual({ result: 'invalid', why: 'needPayment' });
    expect(ho.calls).toEqual([]);
  });
});

describe('M24-FR-02/03/04 · a supplier\'s papers, statement and portal probing', () => {
  it('reads only, on the reviewer\'s permission', async () => {
    const ho = headOffice();
    const s = createSupplierPortalWatchSession({ viewer: { userId: 'u-buyer', permissions: ['supplier.portal.review'] }, fetch: ho.fetch });
    await s.compliance(' sup-1 ', '2026-09-30'); await s.statement('sup-1'); await s.probing();
    expect(ho.calls.map((c) => `${c.method} ${c.url}`)).toEqual(['GET /v1/supplier-portal/partners/sup-1/compliance?asOf=2026-09-30', 'GET /v1/supplier-portal/partners/sup-1/statement', 'GET /v1/supplier-portal/probing']);
    allReal(ho.calls);
    const other = createSupplierPortalWatchSession({ viewer: { userId: 'u-c', permissions: [] }, fetch: ho.fetch });
    expect(await other.probing()).toEqual({ result: 'invalid', why: 'cannotRead' });
    expect(await s.compliance('', '2026-09-30')).toEqual({ result: 'invalid', why: 'needPartner' });
    expect(ho.calls).toHaveLength(3);
  });
});

describe('the browser wiring attaches each section to its own page only', () => {
  it('each page global gets its section; a page without it gets nothing', () => {
    const viewer = (raw: unknown) => (raw as { userId?: string; permissions: string[] });
    const win: Record<string, unknown> = { financeCloseData: { userId: 'u', permissions: [] }, buyingData: { buyerId: 'u-b', permissions: ['purchase.commitment.read'] } };
    wireW5Books(win, viewer);
    expect(Object.keys(win).sort()).toEqual(['booksPostings', 'buyingData', 'financeCloseData', 'relatedPartyOrders']);
    expect((win['relatedPartyOrders'] as { session: { may: { named: boolean; read: boolean } } }).session.may).toEqual({ named: true, read: true, approve: false });
  });
  it('the page scripts load after the page\'s own script and before the chrome', () => {
    for (const [page, script] of [['finance-close', 'finance-close-books'], ['posting-map', 'posting-map-classes'], ['b2b', 'b2b-books'], ['concessions', 'concession-tags'], ['buying', 'buying-related-party'], ['suppliers', 'supplier-payments'], ['supplier-submissions', 'supplier-portal-watch']]) {
      const html = readFileSync(`apps/web-erp/web/${page}.html`, 'utf8');
      const at = html.indexOf(`./${script}.js`);
      expect(at, `${page} loads ${script}.js`).toBeGreaterThan(html.indexOf(`./${page}.js`));
      expect(at).toBeLessThan(html.indexOf('./sre-chrome.js"></script>'));
    }
  });
});

// W5 · OB-686 (owner, 3 Nov 2026) · M22-FR-04 · M24-FR-04: the business-customer chasing steps are the owner's (no built-in
// ₹500 or 7 / 60 / 90 days), and the probing views' 3 refusals say they are built-in, not yet set by the owner.
describe('OB-686 · the owner\'s chasing steps and the built-in probing count', () => {
  it('reads the steps; only the owner sets them — rupees and three rising whole days, all four together', async () => {
    const ho = headOffice();
    const owner = createB2BBooksSession({ viewer: { userId: 'u-owner', permissions: ['b2b.account.read', 'b2b.chasing.steps.set'] }, fetch: ho.fetch });
    expect(owner.may.setSteps).toBe(true);
    await owner.chasingSteps();
    expect(await owner.setChasingSteps({ floorRupees: '500', reminderDays: '60', finalDays: '7', stopDays: '90' })).toEqual({ result: 'invalid', why: 'needSteps' });
    expect(await owner.setChasingSteps({ floorRupees: '', reminderDays: '7', finalDays: '60', stopDays: '90' })).toEqual({ result: 'invalid', why: 'needSteps' });
    expect(await owner.setChasingSteps({ floorRupees: '500', reminderDays: '0', finalDays: '60', stopDays: '90' })).toEqual({ result: 'invalid', why: 'needSteps' });
    await owner.setChasingSteps({ floorRupees: '₹1,500.50', reminderDays: ' 10 ', finalDays: '30', stopDays: '45' });
    expect(ho.calls.map((c) => [`${c.method} ${c.url}`, c.body])).toEqual([
      ['GET /v1/b2b/collections/chasing-steps', undefined],
      ['POST /v1/b2b/collections/chasing-steps', { minimumChaseMinor: 150_050, reminderAfterDays: 10, finalNoticeAfterDays: 30, stopSupplyAfterDays: 45 }],
    ]);
    allReal(ho.calls);
    const acct = createB2BBooksSession({ viewer: { userId: 'u-acct', permissions: ['b2b.account.read', 'b2b.receivable.record'] }, fetch: ho.fetch });
    expect(await acct.setChasingSteps({ floorRupees: '500', reminderDays: '7', finalDays: '60', stopDays: '90' })).toEqual({ result: 'invalid', why: 'cannotSetSteps' });
    expect(ho.calls).toHaveLength(2);
  });

  it('says "not set by the owner" and the built-in 3 refusals in one wording, English and Tamil', () => {
    expect(B2B_BOOKS_COPY.en.stepsNotSet).toMatch(/^Not set by the owner — no chasing step is given/);
    expect(B2B_BOOKS_COPY.en.stepsNoStep).toBe('No step: the chasing steps are not set by the owner.');
    for (const c of [B2B_BOOKS_COPY, SUPPLIER_PORTAL_WATCH_COPY]) {
      expect(c.en.thresholdBuiltIn).toBe('Counted from {threshold} refusals — built-in, not yet set by the owner');
      expect(c.ta.thresholdBuiltIn).toBe('{threshold} மறுப்புகளிலிருந்து எண்ணப்பட்டது — உள்ளமைந்தது, உரிமையாளர் இன்னும் அமைக்கவில்லை');
    }
    expect(Object.keys(B2B_BOOKS_COPY.ta).sort()).toEqual(Object.keys(B2B_BOOKS_COPY.en).sort());
    expect(Object.keys(SUPPLIER_PORTAL_WATCH_COPY.ta).sort()).toEqual(Object.keys(SUPPLIER_PORTAL_WATCH_COPY.en).sort());
  });
});
