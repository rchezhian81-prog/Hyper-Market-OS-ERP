import { describe, it, expect } from 'vitest';
import { migrationRoutes, type MigrationDeps, type RecordedFinding, type StoredSignature, type ExtractionRun } from '../../services/migration/src/index';
import { findingsDigest, applicableSignatures } from '../../services/migration/src/witness';
import type { RequestContext, Route } from '../../services/kernel/src/index';
import type { LoadTarget, TargetKind } from '../../packages/migration/src/trial';
import type { DomainFinding } from '../../packages/migration/src/verification-report';
import { planCountSample } from '../../packages/migration/src/count-verification';
import { STOCK, SUPPLIER_ITEMS, BANK_BODY, GSTR1, GSTR3B, SLABS, ACCOUNTS, TB, CA_ONLY } from '../support/witness-fixtures';

/**
 * **The evidence writers and the six witness routes on API-12 (Stage B2).**
 *
 * Route-level, with the dependencies stubbed so every refusal is provable on its own: production is
 * refused first; an unreadable body is 400 and records nothing; evidence the engine finds inadmissible
 * is 422 and records nothing; admissible-but-insufficient evidence records `not_proved`; the signature
 * route resolves the role from the ledger, refuses the extractor, an unready page and an empty
 * statement, and binds the signature to the findings it was given over.
 */

const NOW = '2026-09-29T10:00:00.000Z';

interface Recorded { runs: ExtractionRun[]; findings: RecordedFinding[]; signatures: StoredSignature[] }

const stub = (over: Partial<MigrationDeps> & { targetKind?: TargetKind; rec?: Recorded } = {}) => {
  const rec: Recorded = over.rec ?? { runs: [], findings: [], signatures: [] };
  const deps: MigrationDeps = {
    target: (tenantId): LoadTarget => ({ targetId: `tgt-${tenantId}`, tenantId, kind: over.targetKind ?? 'rehearsal', label: over.targetKind ?? 'rehearsal' }),
    findings: () => {
      const byDomain = new Map<string, DomainFinding>();
      for (const f of rec.findings) byDomain.set(f.domain, f);
      return [...byDomain.values()];
    },
    acceptances: () => [], signatures: () => rec.signatures,
    recordAcceptance: () => {}, ownerId: () => 'u-owner', extractionOperator: () => (rec.runs.length === 0 ? undefined : rec.runs[rec.runs.length - 1]!.operatorId),
    rolesOf: (_t, userId) => (userId === 'u-owner' ? ['owner'] : userId === 'u-ca' ? ['chartered_accountant'] : []),
    exclusions: () => [], recordExclusion: () => {},
    recordExtractionRun: (_t, run) => { rec.runs.push(run); },
    recordFinding: (_t, f) => { rec.findings.push(f); },
    recordSignature: (_t, s) => { rec.signatures.push(s); },
    now: () => NOW,
    ...over,
  };
  return { deps, rec, routes: migrationRoutes(deps) };
};

const ctx = (over: Partial<RequestContext>): RequestContext =>
  ({ tenantId: 't-sre', userId: 'u-owner', branchId: null, params: {}, query: {}, body: undefined, traceId: 't', ...over });

const routeFor = (routes: readonly Route[], method: string, path: string): Route => {
  const r = routes.find((x) => x.method === method && x.path === path);
  if (r === undefined) throw new Error(`no route ${method} ${path}`);
  return r;
};

interface Thrown { readonly status: number; readonly body: { readonly code: string; readonly whatHappened: string } }
async function thrown(fn: () => unknown): Promise<Thrown> {
  try { await fn(); } catch (e) { return e as Thrown; }
  throw new Error('expected the handler to throw');
}

const countBody = (plannedBy = 'u-manager') => {
  const plan = planCountSample({ planId: 'cnt-1', lines: STOCK, plannedBy, extractionOperator: 'u-op', seed: 7 });
  // When the plan itself is refused (planned by the extractor) there is no sample; send every line counted
  // as extracted — the ROUTE must refuse before it looks at any of them.
  const sample = plan.plan?.lines.filter((l) => l.stratum !== 'not_counted') ?? STOCK;
  const counted = sample.map((l) => ({ lineId: l.lineId, countedQty: STOCK.find((s) => s.lineId === l.lineId)!.extractedQty, counterId: 'u-counter' }));
  return { evidenceRef: 'sheet-1', planId: 'cnt-1', plannedBy, seed: 7, lines: STOCK, counted, toleranceMinor: 0 };
};

describe('POST /v1/migration/extraction-runs/:runId', () => {
  it('records who ran the extraction, and the page can then name them', async () => {
    const { routes, rec } = stub();
    const r = routeFor(routes, 'POST', '/v1/migration/extraction-runs/:runId');
    const res = await r.handler(ctx({ params: { runId: 'run-1' }, body: { operatorId: 'u-op', sources: ['legacy-erp'] } }));
    expect(res.status).toBe(201);
    expect(rec.runs).toEqual([{ runId: 'run-1', operatorId: 'u-op', startedAt: NOW, recordedBy: 'u-owner', sources: ['legacy-erp'] }]);
    expect(r.permission).toBe('migration.extraction.record');
  });
  it('refuses a run with nobody named, and refuses production before reading anything', async () => {
    const { routes, rec } = stub();
    const r = routeFor(routes, 'POST', '/v1/migration/extraction-runs/:runId');
    expect((await thrown(() => r.handler(ctx({ params: { runId: 'run-1' }, body: { operatorId: '' } })))).status).toBe(400);
    expect(rec.runs).toEqual([]);
    const prod = stub({ targetKind: 'production' });
    const e = await thrown(() => routeFor(prod.routes, 'POST', '/v1/migration/extraction-runs/:runId').handler(ctx({ params: { runId: 'run-1' }, body: { operatorId: 'u-op' } })));
    expect(e).toMatchObject({ status: 403, body: { code: 'target_is_production' } });
  });
  it('refuses 503 rather than pretending, when this deployment has no writer', async () => {
    const { routes } = stub({ recordExtractionRun: undefined });
    const e = await thrown(() => routeFor(routes, 'POST', '/v1/migration/extraction-runs/:runId').handler(ctx({ params: { runId: 'run-1' }, body: { operatorId: 'u-op' } })));
    expect(e).toMatchObject({ status: 503, body: { code: 'evidence_store_not_wired' } });
  });
});

describe('the witness routes derive verdicts and record findings', () => {
  const withRun = () => {
    const s = stub();
    s.rec.runs.push({ runId: 'run-1', operatorId: 'u-op', startedAt: NOW, recordedBy: 'u-owner' });
    return s;
  };
  it('count: a clean blind count proves five domains at once, stock carrying the value', async () => {
    const { routes, rec } = withRun();
    const res = await routeFor(routes, 'POST', '/v1/migration/witness/count').handler(ctx({ body: countBody() }));
    expect(res.status).toBe(201);
    expect(rec.findings.map((f) => f.domain).sort()).toEqual(['barcodes', 'batches', 'prices', 'products', 'stock']);
    expect(rec.findings.every((f) => f.verdict === 'proved' && f.provedBy[0] === 'physical_count' && f.whatItCannotProve.length > 20 && f.evidenceRef === 'sheet-1' && f.recordedBy === 'u-owner')).toBe(true);
    expect(rec.findings.find((f) => f.domain === 'stock')!.figureMinor).toBe(STOCK.reduce((t, l) => t + l.extractedValueMinor, 0));
  });
  it('count: a plan chosen by the extractor is inadmissible — 422 and NOTHING recorded', async () => {
    const { routes, rec } = withRun();
    const e = await thrown(() => routeFor(routes, 'POST', '/v1/migration/witness/count').handler(ctx({ body: countBody('u-op') })));
    expect(e).toMatchObject({ status: 422, body: { code: 'chosen_by_the_extractor' } });
    expect(rec.findings).toEqual([]);
  });
  it('count: without a recorded extraction run the page would name nobody, so the count cannot be planned blind', async () => {
    const { routes } = stub();
    const e = await thrown(() => routeFor(routes, 'POST', '/v1/migration/witness/count').handler(ctx({ body: countBody() })));
    expect(e).toMatchObject({ status: 409, body: { code: 'the_page_would_name_nobody' } });
  });
  it('an unreadable body is 400 with the fields named, and records nothing', async () => {
    const { routes, rec } = withRun();
    const e = await thrown(() => routeFor(routes, 'POST', '/v1/migration/witness/suppliers').handler(ctx({ body: { statements: 'no' } })));
    expect(e.status).toBe(400);
    expect(e.body.code).toBe('not_readable_as_supplier_statement_evidence');
    expect(e.body.whatHappened).toContain('evidenceRef');
    expect(rec.findings).toEqual([]);
  });
  it('suppliers: a statement missing from one supplier is a difference, never agreement', async () => {
    const { routes, rec } = withRun();
    const statements = Object.entries(SUPPLIER_ITEMS).slice(0, 2).map(([supplierId, items]) => ({ supplierId, statementDate: '2026-03-31', ourItems: items, theirItems: items }));
    await routeFor(routes, 'POST', '/v1/migration/witness/suppliers').handler(ctx({ body: { evidenceRef: 'stmts', statements, suppliersAsked: Object.keys(SUPPLIER_ITEMS) } }));
    expect(rec.findings.map((f) => f.domain).sort()).toEqual(['purchases', 'suppliers']);
    expect(rec.findings[0]!.verdict).not.toBe('proved');
    expect(rec.findings[0]!.whatItCannotProve).toContain('SUP-K');
  });
  it('bank: terms derived from the difference are refused and record nothing; a full statement proves sales at the gross figure', async () => {
    const { routes, rec } = withRun();
    const derived = { evidenceRef: 'stmt', ...BANK_BODY, terms: BANK_BODY.terms.map((t) => (t.tender === 'card' ? { ...t, source: 'derived_from_the_difference' } : t)) };
    const e = await thrown(() => routeFor(routes, 'POST', '/v1/migration/witness/bank').handler(ctx({ body: derived })));
    expect(e).toMatchObject({ status: 422, body: { code: 'commission_derived_from_the_difference' } });
    expect(rec.findings).toEqual([]);
    const res = await routeFor(routes, 'POST', '/v1/migration/witness/bank').handler(ctx({ body: { evidenceRef: 'stmt', ...BANK_BODY } }));
    expect(res.status).toBe(201);
    expect(rec.findings).toEqual([expect.objectContaining({ domain: 'sales', verdict: 'proved', figureMinor: BANK_BODY.takings.reduce((t, x) => t + x.grossMinor, 0), provedBy: ['bank_statement'] })]);
    expect(rec.findings[0]!.whatItCannotProve).toContain('never what was sold');
  });
  it('tax: a return with no acknowledgement number is not evidence; the filed pair proves tax at the filed figure', async () => {
    const { routes, rec } = withRun();
    const e = await thrown(() => routeFor(routes, 'POST', '/v1/migration/witness/tax').handler(ctx({ body: { evidenceRef: 'arn', periods: [{ period: '2026-03', gstr1: { ...GSTR1, acknowledgementRef: '' }, gstr3b: GSTR3B, books: SLABS }], periodsExpected: ['2026-03'] } })));
    expect(e).toMatchObject({ status: 422, body: { code: 'no_acknowledgement_reference' } });
    expect(rec.findings).toEqual([]);
    const res = await routeFor(routes, 'POST', '/v1/migration/witness/tax').handler(ctx({ body: { evidenceRef: 'arn', periods: [{ period: '2026-03', gstr1: GSTR1, gstr3b: GSTR3B, books: SLABS }], periodsExpected: ['2026-03'] } }));
    expect(res.status).toBe(201);
    expect(rec.findings).toEqual([expect.objectContaining({ domain: 'tax', verdict: 'proved', provedBy: ['filed_gst_return'] })]);
    expect(rec.findings[0]!.whatItCannotProve).toContain('DECLARED');
  });
  it('books: unsigned accounts are refused; the signed set proves the ledgers', async () => {
    const { routes, rec } = withRun();
    const unsigned = { evidenceRef: 'tb', accounts: { ...ACCOUNTS, signedOn: undefined, membershipNumber: undefined }, opening: TB, cutoverDate: '2026-04-01', caOnlyAccountCodes: CA_ONLY };
    const e = await thrown(() => routeFor(routes, 'POST', '/v1/migration/witness/books').handler(ctx({ body: unsigned })));
    expect(e).toMatchObject({ status: 422, body: { code: 'not_signed' } });
    expect(rec.findings).toEqual([]);
    const res = await routeFor(routes, 'POST', '/v1/migration/witness/books').handler(ctx({ body: { evidenceRef: 'tb', accounts: ACCOUNTS, opening: TB, cutoverDate: '2026-04-01', caOnlyAccountCodes: CA_ONLY } }));
    expect(res.status).toBe(201);
    expect(rec.findings).toEqual([expect.objectContaining({ domain: 'ledgers', verdict: 'proved', provedBy: ['ca_prepared_accounts'] })]);
    expect(rec.findings[0]!.whatItCannotProve).toContain('same old system');
  });
});

describe('the signature route and what a signature is bound to', () => {
  const allProved = (): RecordedFinding[] => (['products', 'barcodes', 'prices', 'stock', 'batches', 'suppliers', 'purchases', 'customers', 'loyalty', 'sales', 'tax', 'ledgers'] as const).map((domain) => ({
    domain, verdict: 'proved', figureLabel: `${domain} checked`, provedBy: ['physical_count'], whatItCannotProve: 'this check has a stated limit of its own here', ownerAction: 'none',
    recordedBy: 'u-owner', recordedAt: NOW, evidenceRef: 'e1',
  }));
  const ready = () => {
    const s = stub();
    s.rec.runs.push({ runId: 'run-1', operatorId: 'u-op', startedAt: NOW, recordedBy: 'u-owner' });
    s.rec.findings.push(...allProved());
    return s;
  };
  const sign = (routes: readonly Route[], userId: string, statement: string) =>
    routeFor(routes, 'POST', '/v1/migration/verification/signatures').handler(ctx({ userId, body: { statement } }));

  it('the owner signs as owner, the CA as chartered accountant, each bound to the findings digest; a re-sign of the same page is the same fact', async () => {
    const { routes, rec, deps } = ready();
    const ownerRes = await sign(routes, 'u-owner', 'Every finding read, every limit understood; the figures may be carried.');
    expect(ownerRes.status).toBe(201);
    const ca = await sign(routes, 'u-ca', 'Finance and tax agree with the filed returns and my signed accounts.');
    expect(ca.status).toBe(201);
    const digest = findingsDigest(await deps.findings('t-sre'));
    expect(rec.signatures.map((s) => [s.role, s.signedBy, s.findingsDigest])).toEqual([['owner', 'u-owner', digest], ['chartered_accountant', 'u-ca', digest]]);
    expect(applicableSignatures(rec.signatures, digest)).toHaveLength(2);
    expect(applicableSignatures(rec.signatures, 'somethingelse')).toHaveLength(0);
  });
  it('refuses a manager (not a signatory), the extractor, a statement that explains nothing, and an unready page', async () => {
    const { routes, rec } = ready();
    expect(await thrown(() => sign(routes, 'u-manager', 'I checked everything carefully and it is right.'))).toMatchObject({ status: 403, body: { code: 'not_a_signatory' } });
    // The extractor happens to be a chartered accountant too — still refused: the page will not even be
    // built for the person who ran the extraction (the report engine's own rule, the same separation QG-07
    // requires of a control total), so the signing engine's `signer_ran_the_extraction` never gets a turn.
    const ext = stub({ rolesOf: (_t, u) => (u === 'u-op' ? ['chartered_accountant'] : []) });
    ext.rec.runs.push({ runId: 'run-1', operatorId: 'u-op', startedAt: NOW, recordedBy: 'u-owner' });
    ext.rec.findings.push(...allProved());
    expect(await thrown(() => sign(ext.routes, 'u-op', 'I ran the extraction and I certify my own work here.'))).toMatchObject({ status: 422, body: { code: 'signed_by_whoever_ran_the_extraction' } });
    expect(await thrown(() => sign(routes, 'u-owner', 'approved'))).toMatchObject({ status: 422, body: { code: 'statement_explains_nothing' } });
    const notReady = ready();
    notReady.rec.findings.push({ ...allProved()[0]!, domain: 'sales', verdict: 'not_proved', evidenceRef: 'e2' });
    expect(await thrown(() => sign(notReady.routes, 'u-owner', 'Every finding read, every limit understood; the figures may be carried.'))).toMatchObject({ status: 422, body: { code: 'exception_not_accepted' } });
    expect(rec.signatures).toEqual([]);
  });
  it('the progress read never refuses: it lists covered and missing domains and how many signatures cover THIS page', async () => {
    const { routes, rec } = stub();
    const empty = await routeFor(routes, 'GET', '/v1/migration/verification/progress').handler(ctx({}));
    expect(empty.body).toMatchObject({ covered: [], extractionOperatorKnown: false, signaturesOverThisPage: 0 });
    expect((empty.body as { missing: string[] }).missing).toHaveLength(12);
    rec.findings.push(allProved()[0]!);
    const one = await routeFor(routes, 'GET', '/v1/migration/verification/progress').handler(ctx({}));
    expect((one.body as { covered: string[]; missing: string[]; detail: string }).covered).toEqual(['products']);
    expect((one.body as { detail: string }).detail).toContain('1 of 12');
  });
  it('the page route shows only signatures over the current findings', async () => {
    const { routes, rec } = ready();
    await sign(routes, 'u-owner', 'Every finding read, every limit understood; the figures may be carried.');
    const page1 = await routeFor(routes, 'GET', '/v1/migration/verification/page').handler(ctx({}));
    expect((page1.body as { signatures: number }).signatures).toBe(1);
    rec.findings.push({ ...allProved()[0]!, figureLabel: 'products re-checked', evidenceRef: 'e3' });
    const page2 = await routeFor(routes, 'GET', '/v1/migration/verification/page').handler(ctx({}));
    expect((page2.body as { signatures: number }).signatures).toBe(0);
    expect(rec.signatures).toHaveLength(1);
  });
});
