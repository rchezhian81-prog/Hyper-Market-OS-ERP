import { describe, it, expect } from 'vitest';
import { apiHarness, type ApiHarness } from '../support/api-harness';
import { planCountSample } from '../../packages/migration/src/count-verification';
import { planLoyaltySample } from '../../packages/migration/src/loyalty-verification';
import { STOCK, STOCK_VALUE, SUPPLIER_ITEMS, CREDITORS, SLABS, GSTR1, GSTR3B, TAX_DUE, BANK_BODY, GROSS, TB, CA_ONLY, ACCOUNTS, LOYALTY } from '../support/witness-fixtures';

// Stage B2 — the signed verification page, END TO END through the real API (MG-06, QG-07, OB-06):
// the owner records who ran the extraction, feeds the six outside witnesses through the routes, watches
// the twelve domains fill, builds the page, and signs it together with the chartered accountant. Nothing
// here can set a verdict: every finding is what an engine derived from transcribed evidence.

const T = 'ab000000-0000-4000-8000-000000000042';
const OWNER = 'u-owner';
const CA = 'u-ca';
const OPERATOR = 'u-operator';
const MANAGER = 'u-manager';
const CASHIER = 'u-cashier';

async function seeded(): Promise<ApiHarness> {
  const h = apiHarness();
  await h.seedOwner(T, OWNER);
  await h.provisionRole(T, CA, 'chartered_accountant');
  await h.provisionRole(T, OPERATOR, 'store_manager');
  await h.provisionRole(T, CASHIER, 'cashier');
  return h;
}
const post = (h: ApiHarness, path: string, userId: string, key: string, body: unknown) =>
  h.request({ method: 'POST', path, userId, tenantId: T, idempotencyKey: key, body });
const get = (h: ApiHarness, path: string, userId = OWNER) => h.request({ method: 'GET', path, userId, tenantId: T });

const countBody = () => {
  const plan = planCountSample({ planId: 'cnt-1', lines: STOCK, plannedBy: MANAGER, extractionOperator: OPERATOR, seed: 20260807 });
  const counted = plan.plan!.lines.filter((l) => l.stratum !== 'not_counted').map((l) => ({ lineId: l.lineId, countedQty: STOCK.find((s) => s.lineId === l.lineId)!.extractedQty, counterId: 'u-counter' }));
  return { evidenceRef: 'count-sheet-2026-03-31', planId: 'cnt-1', plannedBy: MANAGER, seed: 20260807, lines: STOCK, counted, toleranceMinor: 0 };
};
const suppliersBody = () => ({
  evidenceRef: 'statements-2026-03-31',
  statements: Object.entries(SUPPLIER_ITEMS).map(([supplierId, items]) => ({ supplierId, statementDate: '2026-03-31', ourItems: items, theirItems: items })),
  suppliersAsked: Object.keys(SUPPLIER_ITEMS),
});
const bankBody = () => ({ evidenceRef: 'bank-stmt-2026-03', ...BANK_BODY });
const taxBody = () => ({ evidenceRef: 'gstr-2026-03', periods: [{ period: '2026-03', gstr1: GSTR1, gstr3b: GSTR3B, books: SLABS }], periodsExpected: ['2026-03'] });
const booksBody = () => ({ evidenceRef: 'signed-accounts-2026-03-31', accounts: ACCOUNTS, opening: TB, cutoverDate: '2026-04-01', caOnlyAccountCodes: CA_ONLY });
const loyaltyBody = () => {
  const plan = planLoyaltySample({ planId: 'loy-1', balances: LOYALTY, plannedBy: MANAGER, extractionOperator: OPERATOR, source: 'drawn_before_anybody_was_told', seed: 20260807 });
  const confirmations = plan.plan!.lines.map((l) => ({ customerId: l.customerId, method: 'customer_stated_their_own_figure', statedPoints: LOYALTY.find((b) => b.customerId === l.customerId)!.pointsBalance, confirmedOn: '2026-08-20' }));
  return { evidenceRef: 'customer-calls-2026-08-20', planId: 'loy-1', plannedBy: MANAGER, seed: 20260807, source: 'drawn_before_anybody_was_told', balances: LOYALTY, confirmations, pointCostMinor: 25 };
};

async function recordEverything(h: ApiHarness): Promise<void> {
  expect((await post(h, '/v1/migration/extraction-runs/run-1', OWNER, 'run-1', { operatorId: OPERATOR, startedAt: '2026-08-01T09:00:00.000Z', sources: ['legacy-erp'] })).status).toBe(201);
  for (const [name, body] of [['count', countBody()], ['suppliers', suppliersBody()], ['bank', bankBody()], ['tax', taxBody()], ['books', booksBody()], ['loyalty', loyaltyBody()]] as const) {
    const res = await post(h, `/v1/migration/witness/${name}`, OWNER, `w-${name}`, body);
    expect(res.status, `${name}: ${JSON.stringify(res.body).slice(0, 300)}`).toBe(201);
  }
}

describe('every figure has a witness — through the API', () => {
  it('fills all twelve domains from six routes, builds the page, and the owner and the CA sign it', async () => {
    const h = await seeded();
    const before = (await get(h, '/v1/migration/verification/progress')).body as { covered: string[]; missing: string[]; extractionOperatorKnown: boolean };
    expect(before.covered).toEqual([]);
    expect(before.missing).toHaveLength(12);
    expect(before.extractionOperatorKnown).toBe(false);

    await recordEverything(h);

    const progress = (await get(h, '/v1/migration/verification/progress')).body as { covered: string[]; missing: string[]; findings: { domain: string; verdict: string; figureMinor?: number }[]; extractionOperatorKnown: boolean };
    expect(progress.missing).toEqual([]);
    expect(progress.covered).toHaveLength(12);
    expect(progress.extractionOperatorKnown).toBe(true);
    const by = Object.fromEntries(progress.findings.map((f) => [f.domain, f]));
    expect(progress.findings.every((f) => f.verdict === 'proved')).toBe(true);
    // The witnesses tie: the shelves, the suppliers, the bank and the return carry the same figures.
    expect(by['stock']!.figureMinor).toBe(STOCK_VALUE);
    expect(by['suppliers']!.figureMinor).toBe(CREDITORS);
    expect(by['sales']!.figureMinor).toBe(GROSS);
    expect(by['tax']!.figureMinor).toBe(TAX_DUE);

    const report = await get(h, '/v1/migration/verification');
    expect(report.status).toBe(200);
    expect(report.body).toMatchObject({ proved: 12, withDifferences: 0, readyToSign: true });

    const ownerSigns = await post(h, '/v1/migration/verification/signatures', OWNER, 's-owner', { statement: 'I have read every finding and the limits stated against each; the figures may be carried into the opening books.' });
    expect(ownerSigns.status, JSON.stringify(ownerSigns.body)).toBe(201);
    expect(ownerSigns.body).toMatchObject({ signature: { role: 'owner', signedBy: OWNER }, signatures: 1 });
    const caSigns = await post(h, '/v1/migration/verification/signatures', CA, 's-ca', { statement: 'Finance and tax figures agree with the filed returns and my signed accounts to 31 March.' });
    expect(caSigns.status, JSON.stringify(caSigns.body)).toBe(201);
    expect(caSigns.body).toMatchObject({ signature: { role: 'chartered_accountant', signedBy: CA }, signatures: 2 });

    const page = (await get(h, '/v1/migration/verification/page', CA)).body as { markdown: string; signatures: number };
    expect(page.signatures).toBe(2);
    expect(page.markdown).toContain(OWNER);
    expect(page.markdown).toContain(CA);
  });

  it('a signature belongs to the page it was given over: new evidence makes the old signature inapplicable, and the ledger keeps it', async () => {
    const h = await seeded();
    await recordEverything(h);
    expect((await post(h, '/v1/migration/verification/signatures', OWNER, 's1', { statement: 'Every finding read; every limit understood; carry the figures.' })).status).toBe(201);
    // The count is re-run against a different count sheet where one line is short.
    const body = countBody();
    // Five units short on the top line, within a tolerance the owner set — differences, but still a count
    // strong enough to sign against (a shortage beyond the tolerance would be not_proved, honestly).
    const short = { ...body, evidenceRef: 'count-sheet-recount-2026-04-02', toleranceMinor: 100_000, counted: body.counted.map((c, i) => (i === 0 ? { ...c, countedQty: c.countedQty - 5 } : c)) };
    const recount = await post(h, '/v1/migration/witness/count', OWNER, 'w-count-2', short);
    expect(recount.status).toBe(201);
    expect((recount.body as { findings: { verdict: string }[] }).findings[0]!.verdict).toBe('proved_with_differences');
    const progress = (await get(h, '/v1/migration/verification/progress')).body as { signaturesOverThisPage: number; findings: { domain: string; verdict: string }[] };
    expect(progress.signaturesOverThisPage).toBe(0);
    expect(progress.findings.find((f) => f.domain === 'stock')!.verdict).toBe('proved_with_differences');
    expect(progress.findings).toHaveLength(12); // latest per domain, never a duplicate row
    // Still in the ledger: the migration stream holds both the signature and both count findings.
    const events = await h.store.readStream(T, 'migration', { type: 'MigrationReportSigned' });
    expect(events).toHaveLength(1);
    expect(await h.store.readStream(T, 'migration', { type: 'MigrationFindingRaised' })).toHaveLength(12 + 5);
  });

  it('refuses at the door: the extractor cannot sign, a cashier cannot record evidence, the CA cannot record evidence, and a manager who is not the owner is not a signatory', async () => {
    const h = await seeded();
    await recordEverything(h);
    expect((await post(h, '/v1/migration/witness/bank', CASHIER, 'x1', bankBody())).status).toBe(403);
    expect((await post(h, '/v1/migration/witness/bank', CA, 'x2', bankBody())).status).toBe(403);
    // The operator holds store_manager: no sign permission at the door.
    expect((await post(h, '/v1/migration/verification/signatures', OPERATOR, 'x3', { statement: 'I ran it and I say it is right, which is exactly the problem.' })).status).toBe(403);
  });

  it('inadmissible evidence records nothing: a count planned by the extractor, a commission derived from the difference, a return with no acknowledgement', async () => {
    const h = await seeded();
    expect((await post(h, '/v1/migration/extraction-runs/run-1', OWNER, 'run-1', { operatorId: OPERATOR })).status).toBe(201);
    const byExtractor = await post(h, '/v1/migration/witness/count', OWNER, 'c1', { ...countBody(), plannedBy: OPERATOR });
    expect(byExtractor.status).toBe(422);
    expect((byExtractor.body as { error: { code: string } }).error.code).toBe('chosen_by_the_extractor');
    const derived = await post(h, '/v1/migration/witness/bank', OWNER, 'b1', { ...bankBody(), terms: BANK_BODY.terms.map((t) => (t.tender === 'card' ? { ...t, source: 'derived_from_the_difference' } : t)) });
    expect(derived.status).toBe(422);
    expect((derived.body as { error: { code: string } }).error.code).toBe('commission_derived_from_the_difference');
    const noArn = await post(h, '/v1/migration/witness/tax', OWNER, 't1', { ...taxBody(), periods: [{ period: '2026-03', gstr1: { ...GSTR1, acknowledgementRef: '' }, gstr3b: GSTR3B, books: SLABS }] });
    expect(noArn.status).toBe(422);
    expect((noArn.body as { error: { code: string } }).error.code).toBe('no_acknowledgement_reference');
    const progress = (await get(h, '/v1/migration/verification/progress')).body as { covered: string[] };
    expect(progress.covered).toEqual([]);
  });

  it('the page cannot be signed while a domain is unproved and unaccepted, nor with a statement that explains nothing, nor by the extractor', async () => {
    const h = await seeded();
    await recordEverything(h);
    // A shorter bank statement: the last day cannot have landed → sales is not proved.
    const shortStatement = await post(h, '/v1/migration/witness/bank', OWNER, 'b2', { ...bankBody(), evidenceRef: 'bank-stmt-short', statementPeriod: { from: '2026-03-01', to: '2026-03-03' } });
    expect(shortStatement.status).toBe(201);
    expect((shortStatement.body as { findings: { verdict: string }[] }).findings[0]!.verdict).toBe('not_proved');
    const notReady = await post(h, '/v1/migration/verification/signatures', OWNER, 's-nr', { statement: 'Every finding read and the limits understood; carry the figures.' });
    expect(notReady.status).toBe(422);
    expect((notReady.body as { error: { code: string } }).error.code).toBe('exception_not_accepted');
    // Restore a full statement, then try a statement that explains nothing.
    expect((await post(h, '/v1/migration/witness/bank', OWNER, 'b3', { ...bankBody(), evidenceRef: 'bank-stmt-full' })).status).toBe(201);
    const ticked = await post(h, '/v1/migration/verification/signatures', OWNER, 's-ok', { statement: 'ok' });
    expect(ticked.status).toBe(422);
    expect((ticked.body as { error: { code: string } }).error.code).toBe('statement_explains_nothing');
  });
});
