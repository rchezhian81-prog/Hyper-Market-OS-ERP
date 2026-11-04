import { describe, it, expect } from 'vitest';
import {
  createCutoverEvidenceSession, CUTOVER_EVIDENCE_COPY, evidenceWords, readEvidenceFile, templateOf, witnessBody, shopInstantOf, keptFile,
  EVIDENCE_FILES, DATA_DOMAINS, WITNESSES, WRONG_SIDES, DATE_ORDERS, SAMPLE_SOURCES, LIMIT_NAMES, type EvidenceFile,
} from '../../apps/web-erp/src/cutover-evidence-session';
import { bilingualGaps } from '../../packages/ui/src/index';
import { ALL_DOMAINS } from '../../services/migration/src/witness';
import { ROLLBACK_LIMIT_NAMES } from '../../packages/migration/src/rollback-limits';
import { BOOKS_REPORTS } from '../../packages/migration/src/books-comparison';
import { DATE_ORDERS as HO_DATE_ORDERS } from '../../packages/migration/src/old-erp-reports';

/**
 * W5 · MG-11 · OD-05 · MG-10 · GT-02 — the switch-over evidence sections of the Old system checks page, in their DOM-free
 * session: what each refuses before asking head office, and exactly what it sends.
 *
 *   MG-11  who ran the extraction (run id + operator); the six witnesses read from their transcribed CSV templates into the
 *          shape their routes read (a bad cell is named by file, line and column, and nothing is sent); progress, the page
 *          and a signature with a statement — never the signer's name or role;
 *   OD-05  an acceptance names the kind of record and the owner's reason — never his name or a date (head office takes both);
 *   MG-11  the four going-back limits: an empty field is "not set" (null), never a default; money typed in rupees;
 *   MG-10  the books side of a day carries each report with its column mapping, and NO tolerance (exact); owning a
 *          difference carries only the explanation and the wrong side;
 *   GT-02  a rollback is confirmed with the old system's first bill and a shop-clock time read in Asia/Kolkata; the window is
 *          reconciled with what the old system holds (bills, refunds, stock moves).
 * Synthetic values only.
 */

function recorder(reply: (url: string, method: string) => { status: number; body: unknown } = () => ({ status: 200, body: {} })) {
  const calls: { url: string; method: string; body: unknown; key: string | undefined }[] = [];
  const fetch = (async (url: string, init?: RequestInit) => {
    const headers = (init?.headers ?? {}) as Record<string, string>;
    calls.push({ url, method: init?.method ?? 'GET', body: init?.body === undefined ? undefined : JSON.parse(String(init.body)), key: headers['idempotency-key'] });
    const r = reply(url, init?.method ?? 'GET');
    return new Response(JSON.stringify(r.body), { status: r.status, headers: { 'content-type': 'application/json' } });
  }) as unknown as typeof globalThis.fetch;
  return { calls, fetch };
}
const ALL = ['migration.verification.read', 'migration.extraction.record', 'migration.evidence.record', 'migration.verification.sign', 'migration.exception.accept', 'migration.parallel.read', 'migration.cutover.decide', 'migration.parallel.record'];
const session = (fetch: typeof globalThis.fetch, permissions = ALL, userId: string | null = 'u-owner') =>
  createCutoverEvidenceSession({ viewer: userId === null ? { permissions } : { userId, permissions }, fetch });
const csv = (file: EvidenceFile, ...rows: string[]): string => `${templateOf(file)}${rows.join('\r\n')}\r\n`;

describe('the words, the templates and the pure readers', () => {
  it('every word has a Tamil twin; every kind of record, witness, wrong side, date order, sample source, limit and file has words', () => {
    const keys = Object.keys(CUTOVER_EVIDENCE_COPY.en) as (keyof typeof CUTOVER_EVIDENCE_COPY.en)[];
    expect(bilingualGaps(CUTOVER_EVIDENCE_COPY as never, keys as never)).toEqual({ en: [], ta: [] });
    const need = [...DATA_DOMAINS.map((d) => `d_${d}`), ...WITNESSES.map((w) => `w_${w}`), ...WRONG_SIDES.map((w) => `ws_${w}`), ...DATE_ORDERS.map((d) => `do_${d}`),
      ...SAMPLE_SOURCES.map((s) => `ss_${s}`), ...LIMIT_NAMES.map((n) => `lim_${n}`), ...Object.keys(EVIDENCE_FILES).map((f) => `f_${f}`),
      ...['proved', 'proved_with_differences', 'not_proved', 'no_evidence_exists'].map((v) => `v_${v}`)];
    for (const k of need) { expect(evidenceWords('en', k), k).not.toBe(k); expect(evidenceWords('ta', k), k).not.toBe(k); }
  });
  it('the page\'s lists are head office\'s own: the twelve kinds, the four limits, the date orders', () => {
    expect([...DATA_DOMAINS]).toEqual([...ALL_DOMAINS]);
    expect([...LIMIT_NAMES]).toEqual([...ROLLBACK_LIMIT_NAMES]);
    expect([...DATE_ORDERS]).toEqual([...HO_DATE_ORDERS]);
    expect(BOOKS_REPORTS.length).toBeGreaterThan(0);
  });
  it('a file is read cell by cell: rupees to paise, percent to basis points, quoted commas kept; a bad cell is named by line and column', () => {
    expect(readEvidenceFile('bank_terms', csv('bank_terms', 'card,1.75,18,1,1,merchant_agreement'))).toEqual([
      { tender: 'card', commissionBps: 175, gstOnCommissionBps: 1800, settlementLagDays: 1, toleranceDays: 1, source: 'merchant_agreement' },
    ]);
    expect(readEvidenceFile('bank_credits', csv('bank_credits', 'L1,2026-10-02,"1,250.50","NEFT, card settlement",card'))).toEqual([
      { lineId: 'L1', valueDate: '2026-10-02', amountMinor: 125050, narrative: 'NEFT, card settlement', attributedTo: 'card' },
    ]);
    expect(readEvidenceFile('bank_credits', csv('bank_credits', 'L1,2026-10-02,12.5,x,card', 'L2,02/10/2026,1,x,card'))).toEqual({ result: 'invalid', why: 'csv:bank_credits:3:value_date' });
    expect(readEvidenceFile('bank_takings', 'business_date,gross\n2026-10-01,10\n')).toEqual({ result: 'invalid', why: 'csv:bank_takings:1:tender' });
    expect(readEvidenceFile('bank_takings', templateOf('bank_takings'))).toEqual({ result: 'invalid', why: 'csv:bank_takings:2:' });
    expect(readEvidenceFile('bank_takings', csv('bank_takings', '2026-10-01,cheque,10'))).toEqual({ result: 'invalid', why: 'csv:bank_takings:2:tender' });
    expect(evidenceWords('en', 'csv:bank_credits:3:value_date')).toBe('Fix the file: The bank\'s credit lines (CSV) — line 3, column “value_date”.');
    expect(evidenceWords('en', 'csv:bank_takings:1:tender')).toMatch(/the header has no column “tender”/);
    expect(evidenceWords('ta', 'csv:bank_takings:2:')).toMatch(/தரவு வரி இல்லை/);
    // A contra flag is optional ("yes" or empty); anything else is refused.
    expect(readEvidenceFile('books_accounts', csv('books_accounts', '1001,Cash,asset,500,0,', '2001,Drawings,equity,100,0,yes'))).toEqual([
      { accountCode: '1001', accountName: 'Cash', nature: 'asset', debitMinor: 50000, creditMinor: 0 },
      { accountCode: '2001', accountName: 'Drawings', nature: 'equity', debitMinor: 10000, creditMinor: 0, contra: true },
    ]);
  });
  it('GT-02: a shop-clock time is read in Asia/Kolkata, never as UTC', () => {
    expect(shopInstantOf('2026-11-03T19:05')).toBe('2026-11-03T13:35:00.000Z');
    expect(shopInstantOf('2026-11-04T01:00')).toBe('2026-11-03T19:30:00.000Z');
    expect(shopInstantOf('')).toBeUndefined();
    expect(shopInstantOf('03/11/2026 19:05')).toBeUndefined();
  });
  it('the kept copy is the markdown exactly as head office wrote it', () => {
    const f = keptFile('sheet.md', '# Sheet\n| a |');
    expect(f.name).toBe('sheet.md');
    expect(decodeURIComponent(f.href.replace(/^data:text\/markdown;charset=utf-8,/, ''))).toBe('# Sheet\n| a |\n');
  });
});

describe('MG-11 — the six witnesses become exactly the bodies their routes read', () => {
  it('count: the plan, the extract\'s lines and the blind count', () => {
    const body = witnessBody('count', {
      fields: { evidenceRef: 'COUNT-SHEET-1', planId: 'plan-1', plannedBy: 'u-planner', seed: '7' },
      files: { count_lines: csv('count_lines', 'L1,P-SYN-1,Synthetic soap,12,264.00'), count_counted: csv('count_counted', 'L1,12,u-counter') },
    });
    expect(body).toEqual({ evidenceRef: 'COUNT-SHEET-1', planId: 'plan-1', plannedBy: 'u-planner', seed: 7, lines: [{ lineId: 'L1', productId: 'P-SYN-1', description: 'Synthetic soap', extractedQty: 12, extractedValueMinor: 26400 }], counted: [{ lineId: 'L1', countedQty: 12, counterId: 'u-counter' }] });
    expect(witnessBody('count', { fields: { evidenceRef: 'x', planId: 'p', plannedBy: 'u', seed: 'seven' }, files: {} })).toEqual({ result: 'invalid', why: 'noSeed' });
    expect(witnessBody('count', { fields: { evidenceRef: 'x', planId: 'p', plannedBy: 'u', seed: '1' }, files: {} })).toEqual({ result: 'invalid', why: 'chooseFile' });
    expect(witnessBody('count', { fields: { evidenceRef: ' ' }, files: {} })).toEqual({ result: 'invalid', why: 'noEvidenceRef' });
    expect(witnessBody('gossip', { fields: {}, files: {} })).toEqual({ result: 'invalid', why: 'noWitness' });
  });
  it('suppliers: one items file grouped into each supplier\'s statement, ours and theirs, never netted', () => {
    const body = witnessBody('suppliers', {
      fields: { evidenceRef: 'STMTS-OCT', suppliersAsked: 'SUP-A, SUP-B' },
      files: { supplier_items: csv('supplier_items', 'SUP-A,2026-10-31,ours,INV-1,invoice,1000,2026-10-05,', 'SUP-A,2026-10-31,theirs,INV-1,invoice,1000,2026-10-05,PO-9') },
    });
    expect(body).toEqual({
      evidenceRef: 'STMTS-OCT', suppliersAsked: ['SUP-A', 'SUP-B'],
      statements: [{ supplierId: 'SUP-A', statementDate: '2026-10-31', ourItems: [{ documentNumber: 'INV-1', kind: 'invoice', amountMinor: 100000, documentDate: '2026-10-05' }], theirItems: [{ documentNumber: 'INV-1', kind: 'invoice', amountMinor: 100000, documentDate: '2026-10-05', reference: 'PO-9' }] }],
    });
  });
  it('bank: the dates read off the statement header, takings, credits and the merchant terms', () => {
    const body = witnessBody('bank', {
      fields: { evidenceRef: 'HDFC-OCT', periodStart: '2026-10-01', periodEnd: '2026-10-31', stmtFrom: '2026-10-01', stmtTo: '2026-11-03' },
      files: { bank_takings: csv('bank_takings', '2026-10-01,card,1000'), bank_credits: csv('bank_credits', 'C1,2026-10-02,982.30,card settlement,card'), bank_terms: csv('bank_terms', 'card,1.5,18,1,1,merchant_agreement') },
    }) as Record<string, unknown>;
    expect(body['statementPeriod']).toEqual({ from: '2026-10-01', to: '2026-11-03' });
    expect(body['takings']).toEqual([{ businessDate: '2026-10-01', tender: 'card', grossMinor: 100000 }]);
    expect(witnessBody('bank', { fields: { evidenceRef: 'x', periodStart: '2026-10-01' }, files: {} })).toEqual({ result: 'invalid', why: 'noPeriod' });
  });
  it('tax: each month\'s GSTR-1 and GSTR-3B (with their acknowledgement) and the books, by slab', () => {
    const body = witnessBody('tax', {
      fields: { evidenceRef: 'GST-Q3', periodsExpected: '2026-09' },
      files: {
        tax_returns: csv('tax_returns', '2026-09,gstr1,33AAAAA0000A1Z5,2026-10-11,ARN-1', '2026-09,gstr3b,33AAAAA0000A1Z5,2026-10-20,'),
        tax_lines: csv('tax_lines', '2026-09,gstr1,5,1000,25,25,0,0', '2026-09,gstr3b,5,1000,25,25,0,0', '2026-09,books,5,1000,25,25,0,0'),
      },
    }) as { periods: { period: string; gstr1: Record<string, unknown>; gstr3b: Record<string, unknown>; books: unknown[] }[]; periodsExpected: string[] };
    expect(body.periodsExpected).toEqual(['2026-09']);
    const slab = { rateBps: 500, taxableValueMinor: 100000, cgstMinor: 2500, sgstMinor: 2500, igstMinor: 0, cessMinor: 0 };
    expect(body.periods).toEqual([{
      period: '2026-09',
      gstr1: { period: '2026-09', kind: 'gstr1', gstin: '33AAAAA0000A1Z5', filedOn: '2026-10-11', acknowledgementRef: 'ARN-1', lines: [slab] },
      // A return with no acknowledgement number is SENT as such — head office's check refuses it by name.
      gstr3b: { period: '2026-09', kind: 'gstr3b', gstin: '33AAAAA0000A1Z5', filedOn: '2026-10-20', acknowledgementRef: '', lines: [slab] },
      books: [slab],
    }]);
    expect(witnessBody('tax', { fields: { evidenceRef: 'x', periodsExpected: 'September' }, files: {} })).toEqual({ result: 'invalid', why: 'noPeriods' });
  });
  it('books: the CA\'s signed accounts (unsigned is sent as unsigned) and the opening trial balance', () => {
    const tb = csv('books_accounts', '1001,Cash,asset,500,0,');
    const body = witnessBody('books', {
      fields: { evidenceRef: 'CA-FY26', entity: 'Synthetic Mart', periodEndAcc: '2026-09-30', preparedBy: 'CA Synthetic', signedOn: '', membership: '', cutoverDate: '2026-10-01' },
      files: { books_accounts: tb, books_opening: tb.replace('account_code', 'account_code') },
    }) as Record<string, unknown>;
    expect(body['accounts']).toEqual({ entity: 'Synthetic Mart', periodEnd: '2026-09-30', preparedBy: 'CA Synthetic', lines: [{ accountCode: '1001', accountName: 'Cash', nature: 'asset', debitMinor: 50000, creditMinor: 0 }] });
    expect(body['cutoverDate']).toBe('2026-10-01');
  });
  it('loyalty: the blind sample, how it was drawn and what each customer said', () => {
    const body = witnessBody('loyalty', {
      fields: { evidenceRef: 'CALLS-OCT', planId: 'lp-1', plannedBy: 'u-planner', seed: '3', sampleSource: 'drawn_before_anybody_was_told', pointCost: '0.25' },
      files: { loyalty_balances: csv('loyalty_balances', 'C1,Synthetic customer,120,,,'), loyalty_confirmations: csv('loyalty_confirmations', 'C1,customer_stated_their_own_figure,120,,2026-10-20') },
    }) as Record<string, unknown>;
    expect(body).toMatchObject({ source: 'drawn_before_anybody_was_told', pointCostMinor: 25, seed: 3, balances: [{ customerId: 'C1', customerName: 'Synthetic customer', pointsBalance: 120 }], confirmations: [{ customerId: 'C1', method: 'customer_stated_their_own_figure', statedPoints: 120, confirmedOn: '2026-10-20' }] });
    expect(witnessBody('loyalty', { fields: { evidenceRef: 'x', planId: 'p', plannedBy: 'u', seed: '1', sampleSource: '' }, files: {} })).toEqual({ result: 'invalid', why: 'noSampleSource' });
  });
});

describe('what each act sends — and what it never sends', () => {
  it('nobody signed in: every act refuses before asking; a role without the right is refused by name', async () => {
    const r = recorder();
    const anon = session(r.fetch, ALL, null);
    expect(await anon.progress()).toEqual({ result: 'invalid', why: 'nobody' });
    expect(await anon.accept('stock', 'x')).toEqual({ result: 'invalid', why: 'nobody' });
    const ca = session(r.fetch, ['migration.verification.read', 'migration.verification.sign', 'migration.parallel.read'], 'u-ca');
    expect(ca.may).toMatchObject({ verifyRead: true, signPage: true, evidence: false, accept: false, limitsSet: false, parallelRecord: false, rollback: false });
    expect(await ca.setLimits({ controlTotalDifferenceMinor: '1', edgeOutageMinutes: '1', windowMinutes: '1', backupMaxAgeHours: '1' })).toEqual({ result: 'invalid', why: 'notAllowed' });
    expect(await ca.witness('count', { fields: {}, files: {} })).toEqual({ result: 'invalid', why: 'notAllowed' });
    expect(r.calls).toEqual([]);
  });
  it('MG-11: the extraction run, a witness, progress, the page and a signature — never the signer\'s name or role', async () => {
    const r = recorder();
    const s = session(r.fetch);
    expect(await s.recordExtractionRun({ runId: 'bad id!', operatorId: 'u-op', sources: '', note: '' })).toEqual({ result: 'invalid', why: 'noRunId' });
    expect(await s.recordExtractionRun({ runId: 'run-1', operatorId: ' ', sources: '', note: '' })).toEqual({ result: 'invalid', why: 'noOperator' });
    await s.recordExtractionRun({ runId: 'run-1', operatorId: 'u-op', sources: 'old-erp, tally', note: '' });
    await s.witness('bank', { fields: { evidenceRef: 'x', periodStart: '2026-10-01', periodEnd: '2026-10-31', stmtFrom: '2026-10-01', stmtTo: '2026-10-31' }, files: { bank_takings: csv('bank_takings', '2026-10-01,cash,1'), bank_credits: csv('bank_credits', 'C1,2026-10-01,1,cash lodged,cash'), bank_terms: csv('bank_terms', 'cash,0,0,0,0,bank_confirmation') } });
    await s.progress(); await s.page();
    expect(await s.signPage('  ')).toEqual({ result: 'invalid', why: 'noSignStatement' });
    await s.signPage('I read every finding against the documents');
    expect(r.calls.map((c) => `${c.method} ${c.url}`)).toEqual([
      'POST /v1/migration/extraction-runs/run-1', 'POST /v1/migration/witness/bank', 'GET /v1/migration/verification/progress', 'GET /v1/migration/verification/page', 'POST /v1/migration/verification/signatures',
    ]);
    expect(r.calls[0]!.body).toEqual({ operatorId: 'u-op', sources: ['old-erp', 'tally'] });
    expect(r.calls[4]!.body).toEqual({ statement: 'I read every finding against the documents' });
    for (const c of r.calls.filter((x) => x.method === 'POST')) expect(c.key, c.url).toBeDefined();
  });
  it('OD-05: an acceptance is the kind and the reason only — head office takes who and when', async () => {
    const r = recorder();
    const s = session(r.fetch);
    expect(await s.accept('', 'reason')).toEqual({ result: 'invalid', why: 'noDomain' });
    expect(await s.accept('batches', ' ')).toEqual({ result: 'invalid', why: 'noAccReason' });
    await s.accept('batches', 'loose goods never carried batch numbers in the old system');
    expect(r.calls).toEqual([expect.objectContaining({ method: 'POST', url: '/v1/migration/acceptances', body: { domain: 'batches', reason: 'loose goods never carried batch numbers in the old system' } })]);
  });
  it('MG-11: an empty limit is sent as NOT SET (null) — never a default; money typed in rupees goes in paise', async () => {
    const r = recorder();
    const s = session(r.fetch);
    expect(await s.setLimits({ controlTotalDifferenceMinor: 'lots', edgeOutageMinutes: '', windowMinutes: '', backupMaxAgeHours: '' })).toEqual({ result: 'invalid', why: 'noLimit' });
    expect(await s.setLimits({ controlTotalDifferenceMinor: '', edgeOutageMinutes: '30.5', windowMinutes: '', backupMaxAgeHours: '' })).toEqual({ result: 'invalid', why: 'noLimit' });
    await s.setLimits({ controlTotalDifferenceMinor: '500.50', edgeOutageMinutes: '', windowMinutes: '480', backupMaxAgeHours: '' });
    expect(r.calls[0]).toMatchObject({ method: 'PUT', url: '/v1/migration/cutover/rollback-limits', body: { controlTotalDifferenceMinor: 50050, edgeOutageMinutes: null, windowMinutes: 480, backupMaxAgeHours: null } });
  });
  it('MG-10: the books side carries each report with its mapping and no tolerance; owning a difference carries no name', async () => {
    const r = recorder();
    const s = session(r.fetch);
    const templates = [{ report: 'stock_balance', file: 'x.csv', words: { en: 'Stock', ta: 'இருப்பு' }, fields: [{ key: 'item', required: true, words: { en: 'Item', ta: 'பொருள்' } }, { key: 'note', required: false, words: { en: 'Note', ta: 'குறிப்பு' } }] }];
    expect(await s.recordBooks('2026-10-01', [], [])).toEqual({ result: 'invalid', why: 'booksFirst' });
    expect(await s.recordBooks('2026-10-01', [], templates)).toEqual({ result: 'invalid', why: 'noReports' });
    expect(await s.recordBooks('01/10/2026', [], templates)).toEqual({ result: 'invalid', why: 'noBooksDate' });
    expect(await s.recordBooks('2026-10-01', [{ report: 'stock_balance', csv: 'a\n1\n', mapping: { item: '' }, dateOrder: '' }], templates)).toEqual({ result: 'invalid', why: 'noBooksColumns' });
    await s.recordBooks('2026-10-01', [{ report: 'stock_balance', csv: 'Item Code\nP1\n', mapping: { item: 'Item Code', note: '' }, dateOrder: 'dmy' }], templates);
    expect(r.calls[0]).toMatchObject({ method: 'POST', url: '/v1/migration/parallel-run/days/2026-10-01/books', body: { reports: { stock_balance: { csv: 'Item Code\nP1\n', mapping: { item: 'Item Code' }, dateOrder: 'dmy' } } } });
    expect((r.calls[0]!.body as Record<string, unknown>)['tolerance']).toBeUndefined();
    await s.ownDifference('PD-1', 'a refund keyed twice in the old system', 'legacy');
    await s.ownDifference('PD-2', '', '');
    expect(r.calls[1]).toMatchObject({ url: '/v1/migration/parallel-run/differences/PD-1/own', body: { explanation: 'a refund keyed twice in the old system', wrongSide: 'legacy' } });
    expect(r.calls[2]!.body).toEqual({});
    await s.sheet(); await s.parallel(); await s.booksDay('2026-10-01');
    expect(r.calls.slice(3).map((c) => c.url)).toEqual(['/v1/migration/parallel-run/sheet', '/v1/migration/parallel-run', '/v1/migration/parallel-run/days/2026-10-01/books']);
  });
  it('GT-02: confirmation is the first bill and the shop-clock time; reconciliation is what the old system holds', async () => {
    const r = recorder();
    const s = session(r.fetch);
    expect(await s.confirmRollback('C-1', '', '2026-11-03T19:05')).toEqual({ result: 'invalid', why: 'noBill' });
    expect(await s.confirmRollback('C-1', 'OLD-1', '')).toEqual({ result: 'invalid', why: 'noTime' });
    await s.confirmRollback('C-1', 'OLD-1', '2026-11-03T19:05');
    expect(r.calls[0]).toMatchObject({ url: '/v1/migration/cutover/rollback/C-1/confirmation', body: { legacyFirstBillRef: 'OLD-1', legacyTradingFrom: '2026-11-03T13:35:00.000Z' } });
    const rec = { newFromLocal: '2026-11-03T18:00', count: '2', total: '450.00', refunds: '0', refundsTotal: '0', stockCsv: '' };
    expect(await s.reconcileRollback('C-1', { ...rec, count: 'two' })).toEqual({ result: 'invalid', why: 'noCount' });
    expect(await s.reconcileRollback('C-1', { ...rec, total: '' })).toEqual({ result: 'invalid', why: 'noMoney' });
    expect(await s.reconcileRollback('C-1', { ...rec, stockCsv: 'product_id,net_quantity\nP1,many\n' })).toEqual({ result: 'invalid', why: 'csv:rollback_stock:2:net_quantity' });
    await s.reconcileRollback('C-1', { ...rec, stockCsv: 'product_id,net_quantity\nP1,-2\n' });
    expect(r.calls[1]).toMatchObject({ url: '/v1/migration/cutover/rollback/C-1/reconciliation', body: { newSystemTradingFrom: '2026-11-03T12:30:00.000Z', legacyCarriedBack: { count: 2, totalMinor: 45000, refunds: { count: 0, totalMinor: 0 }, stockMovements: [{ productId: 'P1', netQuantityMinor: -2 }] } } });
    await s.reconcileRollback('C-1', rec);
    expect((r.calls[2]!.body as { legacyCarriedBack: { stockMovements: unknown[] } }).legacyCarriedBack.stockMovements).toEqual([]);
  });
  it('a refusal is shown in head office\'s own words', async () => {
    const r = recorder(() => ({ status: 422, body: { error: { code: 'count_plan_refused', whatHappened: 'the planner ran the extraction' } } }));
    const out = await session(r.fetch).progress();
    expect(out).toEqual({ result: 'refused', status: 422, code: 'count_plan_refused', whatHappened: 'the planner ran the extraction' });
  });
});
