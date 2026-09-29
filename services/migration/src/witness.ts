// API-12 — the evidence writers the signed page never had, and the six outside-evidence checks as
// routes (Stage B2; STEP-1-REAL-DATA-PLAN §7.2 items 3 and 4).
//
// Until now `GET /v1/migration/verification` READ findings, an extraction operator and signatures from
// the ledger that nothing could WRITE: the only way to give the six witness engines a bank statement or a
// filed return was for a developer to type the figures into a test file. This module is the door for the
// person doing the work:
//
//   • record who ran the extraction (named on the signed page — load-bearing, §28)
//   • feed each witness engine the TRANSCRIBED outside evidence plus the extract's own figures; the
//     engine judges, the route records what it found as a `MigrationFindingRaised` per domain — the
//     verdict is DERIVED, never posted (an endpoint that could set a verdict is a way to sign the
//     report without doing the work)
//   • see where the twelve domains stand
//   • sign the page — owner or chartered accountant, never whoever ran the extraction, never with a
//     statement that explains nothing; the signature is bound to the findings it was given over
//
// Evidence the engine finds INADMISSIBLE (a count planned by the extractor, a commission derived from
// the difference, a return with no acknowledgement number, unsigned accounts, a balance shown to the
// customer) is refused 422 and records NOTHING: a finding built on inadmissible evidence would read as a
// check that was done. Evidence that is admissible but insufficient records `not_proved`, honestly.

import { createHash } from 'node:crypto';
import type { Route } from '../../kernel/src/index';
import { apiError } from '../../kernel/src/index';
import type { DataDomain, ExternalSource } from '../../../packages/migration/src/extraction';
import {
  buildVerificationReport, signVerificationReport,
  type DomainFinding, type DomainVerdict, type Signature,
} from '../../../packages/migration/src/verification-report';
import { planCountSample, assessCountVerification, type StockLine, type CountedLine } from '../../../packages/migration/src/count-verification';
import { reconcileSupplierStatement, supplierPosition, type LedgerItem } from '../../../packages/migration/src/supplier-reconciliation';
import { verifySalesAgainstBank, type RouteTerms, type DailyTakings, type BankCredit } from '../../../packages/migration/src/banking-verification';
import { reconcileTaxPeriod, taxPosition, type FiledReturn, type TaxSlabLine } from '../../../packages/migration/src/tax-verification';
import { reconcileOpeningBooks, type SignedAccounts, type TrialBalanceLine } from '../../../packages/migration/src/books-verification';
import { planLoyaltySample, assessLoyaltyVerification, type LoyaltyBalance, type CustomerConfirmation, type SampleSource } from '../../../packages/migration/src/loyalty-verification';
import { assertSafeTarget, namedPeople } from './guards';
import type { MigrationDeps } from './index';

// ── What gets recorded ────────────────────────────────────────────────────────────────────────────────

/** Who ran the extraction — the name the signed page carries. */
export interface ExtractionRun {
  readonly runId: string;
  readonly operatorId: string;
  readonly startedAt: string;
  readonly recordedBy: string;
  readonly sources?: readonly string[];
  readonly note?: string;
}

/** A domain finding as the ledger keeps it: the engine's verdict plus who fed it what, and when. */
export interface RecordedFinding extends DomainFinding {
  readonly recordedBy: string;
  readonly recordedAt: string;
  /** The outside document this rests on — a count plan id, a statement date, a bank statement ref, an ARN… */
  readonly evidenceRef: string;
}

/** A signature bound to the findings that were on the page when it was given. */
export interface StoredSignature extends Signature {
  readonly reportId: string;
  readonly findingsDigest: string;
}

/** A short digest of the findings a page is built from — what a signature is bound to. */
export function findingsDigest(findings: readonly DomainFinding[]): string {
  const canonical = [...findings]
    .map((f) => ({ d: f.domain, v: f.verdict, m: f.figureMinor ?? null, l: f.figureLabel ?? null, p: [...(f.provedBy ?? [])].sort() }))
    .sort((a, b) => (a.d < b.d ? -1 : a.d > b.d ? 1 : 0));
  return createHash('sha256').update(JSON.stringify(canonical)).digest('hex').slice(0, 16);
}

/** The signatures given over THESE findings. Earlier ones are kept in the ledger, never shown as covering this page. */
export function applicableSignatures(all: readonly Signature[], digest: string): readonly Signature[] {
  return all.filter((s) => (s as Partial<StoredSignature>).findingsDigest === digest);
}

// ── Small shared pieces ───────────────────────────────────────────────────────────────────────────────

const isStr = (v: unknown): v is string => typeof v === 'string' && v.trim() !== '';
const isNum = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);
const isObj = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === 'object' && !Array.isArray(v);
const isArr = (v: unknown): v is unknown[] => Array.isArray(v);

const notReadable = (what: string, needs: string): never => {
  throw apiError(400, {
    code: `not_readable_as_${what}_evidence`,
    whatHappened: `This payload could not be read as ${what.replace(/_/g, ' ')} evidence. It needs ${needs}.`,
    wasItSaved: 'not_saved',
    nextSafeAction: 'Nothing was recorded. Transcribe the document into the fields named and send it again.',
  });
};

const inadmissible = (code: string, detail: string): never => {
  throw apiError(422, {
    code,
    whatHappened: `${detail}. Evidence the check itself refuses is not evidence, so nothing was recorded — a finding built on it would read as a check that was done.`,
    wasItSaved: 'not_saved',
    nextSafeAction: 'Fix what is named (a different planner, the real merchant terms, the filed return with its acknowledgement number, the signed accounts) and send it again.',
  });
};

const notWired = (): never => {
  throw apiError(503, {
    code: 'evidence_store_not_wired',
    whatHappened: 'This deployment has no ledger to record migration evidence into.',
    wasItSaved: 'not_saved',
    nextSafeAction: 'Nothing was recorded. Run against a deployment with the event ledger configured.',
  });
};

const verdictOf = (sufficient: boolean, clean: boolean): DomainVerdict =>
  !sufficient ? 'not_proved' : clean ? 'proved' : 'proved_with_differences';

const money = (minor: number): string => `₹${(minor / 100).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

interface FindingSeed {
  readonly verdict: DomainVerdict;
  readonly figureMinor?: number;
  readonly figureLabel?: string;
  readonly provedBy: readonly ExternalSource[];
  readonly whatItCannotProve: string;
  readonly ownerAction: string;
}

async function recordFindings(
  deps: MigrationDeps, tenantId: string, recordedBy: string, evidenceRef: string,
  seeds: readonly (FindingSeed & { readonly domain: DataDomain })[],
): Promise<readonly RecordedFinding[]> {
  if (deps.recordFinding === undefined) notWired();
  const at = deps.now();
  const out: RecordedFinding[] = [];
  for (const seed of seeds) {
    const finding: RecordedFinding = {
      domain: seed.domain, verdict: seed.verdict,
      ...(seed.figureMinor === undefined ? {} : { figureMinor: seed.figureMinor }),
      ...(seed.figureLabel === undefined ? {} : { figureLabel: seed.figureLabel }),
      provedBy: seed.provedBy, whatItCannotProve: seed.whatItCannotProve, ownerAction: seed.ownerAction,
      recordedBy, recordedAt: at, evidenceRef,
    };
    await deps.recordFinding!(tenantId, finding);
    out.push(finding);
  }
  return out;
}

const ALL_DOMAINS: readonly DataDomain[] = ['products', 'barcodes', 'prices', 'stock', 'batches', 'suppliers', 'purchases', 'customers', 'loyalty', 'sales', 'tax', 'ledgers'];

// ── The routes ────────────────────────────────────────────────────────────────────────────────────────

export function witnessRoutes(deps: MigrationDeps): readonly Route[] {
  return [
    {
      // Who ran the extraction. Named on the signed page; the rule that the extractor cannot choose which
      // stock lines get counted, nor sign, only means anything if the page says who that was.
      // Body: { operatorId, startedAt?, sources?, note? }. Idempotent on the run id.
      api: 'API-12', method: 'POST', path: '/v1/migration/extraction-runs/:runId',
      permission: 'migration.extraction.record', idempotent: true,
      handler: async (ctx) => {
        await assertSafeTarget(deps, ctx.tenantId);
        const runId = (ctx.params['runId'] ?? '').trim();
        const b = isObj(ctx.body) ? ctx.body : {};
        if (runId === '' || !isStr(b['operatorId']) || (b['startedAt'] !== undefined && !isStr(b['startedAt']))
          || (b['sources'] !== undefined && !(isArr(b['sources']) && b['sources'].every(isStr)))
          || (b['note'] !== undefined && typeof b['note'] !== 'string')) {
          throw apiError(400, {
            code: 'not_readable_as_an_extraction_run',
            whatHappened: 'Recording an extraction run needs the run id in the path and the operator who ran it (operatorId); startedAt, sources[] and note are optional.',
            wasItSaved: 'not_saved',
            nextSafeAction: 'Nothing was recorded. Name the person who ran the extraction and send it again.',
          });
        }
        if (deps.recordExtractionRun === undefined) notWired();
        const run: ExtractionRun = {
          runId, operatorId: (b['operatorId'] as string).trim(), startedAt: isStr(b['startedAt']) ? b['startedAt'] : deps.now(),
          recordedBy: ctx.userId,
          ...(b['sources'] === undefined ? {} : { sources: b['sources'] as string[] }),
          ...(isStr(b['note']) ? { note: b['note'] } : {}),
        };
        await deps.recordExtractionRun!(ctx.tenantId, run);
        return { status: 201, body: { run } };
      },
    },
    {
      // Where the twelve domains stand: which have a finding (latest each), which are still missing, and
      // whether the page could name its people. Never refuses for incompleteness — that is the point of it.
      api: 'API-12', method: 'GET', path: '/v1/migration/verification/progress',
      permission: 'migration.verification.read',
      handler: async (ctx) => {
        await assertSafeTarget(deps, ctx.tenantId);
        const findings = await deps.findings(ctx.tenantId);
        const covered = new Set(findings.map((f) => f.domain));
        const missing = ALL_DOMAINS.filter((d) => !covered.has(d));
        const ownerId = await deps.ownerId(ctx.tenantId);
        const extractionOperator = await deps.extractionOperator(ctx.tenantId);
        const signatures = await deps.signatures(ctx.tenantId);
        const digest = findingsDigest(findings);
        return {
          status: 200,
          body: {
            covered: [...covered].sort(), missing, findings,
            ownerKnown: ownerId !== undefined, extractionOperatorKnown: extractionOperator !== undefined,
            signaturesOverThisPage: applicableSignatures(signatures, digest).length,
            detail: missing.length === 0
              ? `all ${ALL_DOMAINS.length} domains have a finding`
              : `${covered.size} of ${ALL_DOMAINS.length} domains have a finding; still missing: ${missing.join(', ')}`,
          },
        };
      },
    },
    {
      // Sign the page. The caller signs in their own name, in the role the ledger says they hold: the
      // owner as owner, a chartered accountant as chartered accountant, nobody else. The engine refuses the
      // extractor, an unready report, and a statement that explains nothing. Body: { statement }.
      api: 'API-12', method: 'POST', path: '/v1/migration/verification/signatures',
      permission: 'migration.verification.sign', idempotent: true,
      handler: async (ctx) => {
        await assertSafeTarget(deps, ctx.tenantId);
        const b = isObj(ctx.body) ? ctx.body : {};
        if (typeof b['statement'] !== 'string') {
          throw apiError(400, {
            code: 'not_readable_as_a_signature',
            whatHappened: 'Signing needs a statement — what you checked and what you are putting your name to.',
            wasItSaved: 'not_saved',
            nextSafeAction: 'Nothing was signed. Write the statement in your own words and send it again.',
          });
        }
        const people = await namedPeople(deps, ctx.tenantId);
        const roles = deps.rolesOf === undefined ? [] : await deps.rolesOf(ctx.tenantId, ctx.userId);
        const role: Signature['role'] | undefined = ctx.userId === people.ownerId ? 'owner'
          : roles.includes('chartered_accountant') ? 'chartered_accountant' : undefined;
        if (role === undefined) {
          throw apiError(403, {
            code: 'not_a_signatory',
            whatHappened: `${ctx.userId} is neither the owner nor a chartered accountant of this tenant, so their signature would certify nothing.`,
            wasItSaved: 'not_saved',
            nextSafeAction: 'Nothing was signed. The owner and the chartered accountant sign this page.',
          });
        }
        const built = buildVerificationReport({
          reportId: `VR-${ctx.tenantId}`, asAt: deps.now(), preparedBy: ctx.userId,
          extractionOperator: people.extractionOperator,
          findings: await deps.findings(ctx.tenantId), acceptances: await deps.acceptances(ctx.tenantId),
          ownerId: people.ownerId,
        });
        if (!built.ok || built.report === undefined) {
          throw apiError(422, {
            code: built.refusedBecause ?? 'report_not_built',
            whatHappened: built.detail,
            wasItSaved: 'not_saved',
            nextSafeAction: 'Nothing was signed. A page that cannot be built cannot be signed.',
          });
        }
        const digest = findingsDigest(built.report.findings);
        const existing = applicableSignatures(await deps.signatures(ctx.tenantId), digest);
        const signed = signVerificationReport({
          report: built.report, signatures: existing, signedBy: ctx.userId, role,
          extractionOperator: people.extractionOperator, statement: b['statement'], now: deps.now(),
        });
        if (!signed.ok) {
          throw apiError(422, {
            code: signed.refusedBecause ?? 'signature_refused',
            whatHappened: signed.detail,
            wasItSaved: 'not_saved',
            nextSafeAction: 'Nothing was signed.',
          });
        }
        if (deps.recordSignature === undefined) notWired();
        const signature = signed.signatures[signed.signatures.length - 1]!;
        const stored: StoredSignature = { ...signature, reportId: built.report.reportId, findingsDigest: digest };
        await deps.recordSignature!(ctx.tenantId, stored);
        return { status: 201, body: { signature: stored, signatures: signed.signatures.length, detail: signed.detail } };
      },
    },

    // ── The six witnesses ─────────────────────────────────────────────────────────────────────────────
    {
      // The shelves. Body: { evidenceRef, planId, plannedBy, seed, lines: StockLine[], counted: CountedLine[],
      // toleranceMinor?, censusValueTargetBps?, tailSampleRateBps? }. Plans the blind count with the engine
      // (refusing a planner who ran the extraction) and assesses what was counted against what was extracted.
      api: 'API-12', method: 'POST', path: '/v1/migration/witness/count',
      permission: 'migration.evidence.record', idempotent: true,
      handler: async (ctx) => {
        await assertSafeTarget(deps, ctx.tenantId);
        const b = isObj(ctx.body) ? ctx.body : {};
        if (!isStr(b['evidenceRef']) || !isStr(b['planId']) || !isStr(b['plannedBy']) || !isNum(b['seed'])
          || !isArr(b['lines']) || b['lines'].length === 0 || !isArr(b['counted'])) {
          notReadable('a_physical_count', 'evidenceRef, planId, plannedBy, a numeric seed, the extracted lines[] and the counted[] lines');
        }
        const people = await namedPeople(deps, ctx.tenantId);
        const plan = planCountSample({
          planId: b['planId'] as string, lines: b['lines'] as StockLine[], plannedBy: b['plannedBy'] as string,
          extractionOperator: people.extractionOperator, seed: b['seed'] as number,
          ...(isNum(b['censusValueTargetBps']) ? { censusValueTargetBps: b['censusValueTargetBps'] } : {}),
          ...(isNum(b['tailSampleRateBps']) ? { tailSampleRateBps: b['tailSampleRateBps'] } : {}),
        });
        if (!plan.ok || plan.plan === undefined) inadmissible(plan.refusedBecause ?? 'count_plan_refused', plan.detail);
        const result = assessCountVerification({
          plan: plan.plan!, extracted: b['lines'] as StockLine[], counted: b['counted'] as CountedLine[],
          ...(isNum(b['toleranceMinor']) ? { toleranceMinor: b['toleranceMinor'] } : {}),
        });
        const verdict = verdictOf(result.sufficientToVerify, result.cleanCount);
        const cannot = `A count proves what was on the shelf on the count day for the ${result.linesCounted} line(s) counted; the ${plan.plan!.notCountedLines} not counted carry an estimate, stated as one (${result.estimateBasis}). It says nothing about a barcode that scans to the wrong item or a price on the shelf edge — those are checked by scanning and by the label, not by counting.`;
        const label = (what: string): string => `${(b['lines'] as StockLine[]).length} ${what}, ${result.linesCounted} counted, ${result.variances.length} differing`;
        const findings = await recordFindings(deps, ctx.tenantId, ctx.userId, b['evidenceRef'] as string, [
          { domain: 'stock', verdict, figureMinor: plan.plan!.totalValueMinor, provedBy: ['physical_count'], whatItCannotProve: cannot, ownerAction: result.ownerAction },
          { domain: 'products', verdict, figureLabel: label('products'), provedBy: ['physical_count'], whatItCannotProve: cannot, ownerAction: result.ownerAction },
          { domain: 'barcodes', verdict, figureLabel: label('barcodes'), provedBy: ['physical_count'], whatItCannotProve: cannot, ownerAction: result.ownerAction },
          { domain: 'prices', verdict, figureLabel: label('prices'), provedBy: ['physical_count'], whatItCannotProve: cannot, ownerAction: result.ownerAction },
          { domain: 'batches', verdict, figureLabel: label('batches'), provedBy: ['physical_count'], whatItCannotProve: cannot, ownerAction: result.ownerAction },
        ]);
        return { status: 201, body: { plan: plan.plan, result, findings } };
      },
    },
    {
      // The suppliers' own statements. Body: { evidenceRef, statements: [{ supplierId, statementDate, ourItems, theirItems, timingWindowDays? }],
      // suppliersAsked: string[], toleranceMinor? }. Matched document by document, never netted.
      api: 'API-12', method: 'POST', path: '/v1/migration/witness/suppliers',
      permission: 'migration.evidence.record', idempotent: true,
      handler: async (ctx) => {
        await assertSafeTarget(deps, ctx.tenantId);
        const b = isObj(ctx.body) ? ctx.body : {};
        const statements = b['statements'];
        if (!isStr(b['evidenceRef']) || !isArr(statements) || !isArr(b['suppliersAsked']) || !(b['suppliersAsked'] as unknown[]).every(isStr)
          || !statements.every((s) => isObj(s) && isStr(s['supplierId']) && isStr(s['statementDate']) && isArr(s['ourItems']) && isArr(s['theirItems']))) {
          notReadable('supplier_statement', 'evidenceRef, statements[] each with supplierId, statementDate, ourItems[] and theirItems[], and suppliersAsked[]');
        }
        const reconciliations = (statements as Record<string, unknown>[]).map((s) => reconcileSupplierStatement({
          supplierId: s['supplierId'] as string, statementDate: s['statementDate'] as string,
          ourItems: s['ourItems'] as LedgerItem[], theirItems: s['theirItems'] as LedgerItem[],
          ...(isNum(s['timingWindowDays']) ? { timingWindowDays: s['timingWindowDays'] } : {}),
        }));
        const position = supplierPosition({
          reconciliations, suppliersAsked: b['suppliersAsked'] as string[],
          ...(isNum(b['toleranceMinor']) ? { toleranceMinor: b['toleranceMinor'] } : {}),
        });
        const clean = position.withDifferences === 0 && position.noStatementReceived.length === 0;
        const verdict = verdictOf(position.sufficientToVerify, clean);
        const theirs = reconciliations.reduce((t, r) => t + r.theirBalanceMinor, 0);
        const cannot = `A supplier's statement proves what that supplier says we owed on its date, document by document. It says nothing about ${position.noStatementReceived.length} supplier(s) who sent none (${position.noStatementReceived.join(', ') || 'none missing'}), nothing about goods received and never invoiced, and nothing about the prices being the agreed ones.`;
        const ownerAction = reconciliations.map((r) => r.ownerAction).find((a) => a.trim() !== '') ?? position.detail;
        const findings = await recordFindings(deps, ctx.tenantId, ctx.userId, b['evidenceRef'] as string, [
          { domain: 'suppliers', verdict, figureMinor: theirs, provedBy: ['supplier_statement'], whatItCannotProve: cannot, ownerAction },
          { domain: 'purchases', verdict, figureLabel: `${reconciliations.length} statement(s), ${position.agreed} agreed, unexplained ${money(position.totalUnexplainedMinor)}`, provedBy: ['supplier_statement'], whatItCannotProve: cannot, ownerAction },
        ]);
        return { status: 201, body: { position, findings } };
      },
    },
    {
      // The bank. Body: { evidenceRef, periodStart, periodEnd, statementPeriod: {from,to}, takings[], credits[], terms[], toleranceMinor? }.
      // Refuses commission "derived from the difference" (the engine's rule) and records nothing then.
      api: 'API-12', method: 'POST', path: '/v1/migration/witness/bank',
      permission: 'migration.evidence.record', idempotent: true,
      handler: async (ctx) => {
        await assertSafeTarget(deps, ctx.tenantId);
        const b = isObj(ctx.body) ? ctx.body : {};
        const sp = b['statementPeriod'];
        if (!isStr(b['evidenceRef']) || !isStr(b['periodStart']) || !isStr(b['periodEnd']) || !isObj(sp) || !isStr(sp['from']) || !isStr(sp['to'])
          || !isArr(b['takings']) || !isArr(b['credits']) || !isArr(b['terms'])) {
          notReadable('a_bank_statement', 'evidenceRef, periodStart, periodEnd, statementPeriod {from,to} read off the statement header, takings[], credits[] and the merchant terms[]');
        }
        const statementPeriod = sp as Record<string, unknown>;
        let result;
        try {
          result = verifySalesAgainstBank({
            periodStart: b['periodStart'] as string, periodEnd: b['periodEnd'] as string,
            statementPeriod: { from: statementPeriod['from'] as string, to: statementPeriod['to'] as string },
            takings: b['takings'] as DailyTakings[], credits: b['credits'] as BankCredit[], terms: b['terms'] as RouteTerms[],
            ...(isNum(b['toleranceMinor']) ? { toleranceMinor: b['toleranceMinor'] } : {}),
          });
        } catch {
          notReadable('a_bank_statement', 'well-formed takings (businessDate, tender, grossMinor), credits (lineId, valueDate, amountMinor, narrative, attributedTo) and terms');
        }
        if (!result!.termsAccepted) inadmissible(result!.refusedBecause ?? 'terms_refused', result!.detail);
        const clean = result!.unbanked.length === 0 && result!.unexplainedCredits.length === 0 && result!.cashNotBankedMinor === 0;
        const verdict = verdictOf(result!.sufficientToVerify, clean);
        const gross = result!.routes.reduce((t, r) => t + r.grossMinor, 0);
        const cannot = 'The bank proves what arrived, never what was sold: a sale rung without a receipt, or never rung at all, leaves no trace here. Cash proves only what was lodged.';
        const findings = await recordFindings(deps, ctx.tenantId, ctx.userId, b['evidenceRef'] as string, [
          { domain: 'sales', verdict, figureMinor: gross, provedBy: ['bank_statement'], whatItCannotProve: cannot, ownerAction: result!.ownerAction },
        ]);
        return { status: 201, body: { result, findings } };
      },
    },
    {
      // The filed GST returns. Body: { evidenceRef, periods: [{ period, gstr1, gstr3b, books, permittedSlabsBps?, toleranceMinor? }], periodsExpected: string[] }.
      // A return without its acknowledgement number is refused by the engine and records nothing.
      api: 'API-12', method: 'POST', path: '/v1/migration/witness/tax',
      permission: 'migration.evidence.record', idempotent: true,
      handler: async (ctx) => {
        await assertSafeTarget(deps, ctx.tenantId);
        const b = isObj(ctx.body) ? ctx.body : {};
        const periods = b['periods'];
        if (!isStr(b['evidenceRef']) || !isArr(periods) || periods.length === 0 || !isArr(b['periodsExpected']) || !(b['periodsExpected'] as unknown[]).every(isStr)
          || !periods.every((p) => isObj(p) && isStr(p['period']) && isObj(p['gstr1']) && isObj(p['gstr3b']) && isArr(p['books']))) {
          notReadable('a_filed_return', 'evidenceRef, periods[] each with period (YYYY-MM), the filed gstr1 and gstr3b (with acknowledgement numbers), the books[] by slab, and periodsExpected[]');
        }
        let reconciliations;
        try {
          reconciliations = (periods as Record<string, unknown>[]).map((p) => reconcileTaxPeriod({
            period: p['period'] as string, gstr1: p['gstr1'] as FiledReturn, gstr3b: p['gstr3b'] as FiledReturn, books: p['books'] as TaxSlabLine[],
            ...(isArr(p['permittedSlabsBps']) ? { permittedSlabsBps: p['permittedSlabsBps'] as number[] } : {}),
            ...(isNum(p['toleranceMinor']) ? { toleranceMinor: p['toleranceMinor'] } : {}),
          }));
        } catch {
          notReadable('a_filed_return', 'well-formed returns (period, kind, gstin, filedOn, acknowledgementRef, lines[]) and slab lines');
        }
        const refused = reconciliations!.find((r) => !r.accepted);
        if (refused !== undefined) inadmissible(refused.refusedBecause ?? 'return_refused', `${refused.period}: ${refused.detail}`);
        const position = taxPosition({ reconciliations: reconciliations!, periodsExpected: b['periodsExpected'] as string[] });
        const clean = position.totalBooksMustMoveByMinor === 0 && position.disclosuresRequired.length === 0 && position.periodsWithNoReturn.length === 0;
        const verdict = verdictOf(position.sufficientToVerify, clean);
        const filed = reconciliations!.reduce((t, r) => t + r.filedTaxMinor, 0);
        const cannot = 'A filed return proves what was DECLARED, never what was correctly CHARGED: sell at 5% what should have been 12% and the books and the return agree exactly. Periods with no return are unverified, not agreed.';
        const findings = await recordFindings(deps, ctx.tenantId, ctx.userId, b['evidenceRef'] as string, [
          { domain: 'tax', verdict, figureMinor: filed, provedBy: ['filed_gst_return'], whatItCannotProve: cannot, ownerAction: position.ownerAction },
        ]);
        return { status: 201, body: { position, findings } };
      },
    },
    {
      // The CA's signed accounts. Body: { evidenceRef, accounts: SignedAccounts, opening: TrialBalanceLine[], cutoverDate, caOnlyAccountCodes?, toleranceMinor? }.
      // Unsigned or unbalanced accounts, or a balancing figure, are refused by the engine and record nothing.
      api: 'API-12', method: 'POST', path: '/v1/migration/witness/books',
      permission: 'migration.evidence.record', idempotent: true,
      handler: async (ctx) => {
        await assertSafeTarget(deps, ctx.tenantId);
        const b = isObj(ctx.body) ? ctx.body : {};
        if (!isStr(b['evidenceRef']) || !isObj(b['accounts']) || !isArr(b['opening']) || !isStr(b['cutoverDate'])
          || (b['caOnlyAccountCodes'] !== undefined && !(isArr(b['caOnlyAccountCodes']) && b['caOnlyAccountCodes'].every(isStr)))) {
          notReadable('signed_accounts', 'evidenceRef, the signed accounts (entity, periodEnd, preparedBy, signedOn, membershipNumber, lines[]), the opening[] trial balance and the cutoverDate');
        }
        let result;
        try {
          result = reconcileOpeningBooks({
            accounts: b['accounts'] as unknown as SignedAccounts, opening: b['opening'] as TrialBalanceLine[], cutoverDate: b['cutoverDate'] as string,
            ...(b['caOnlyAccountCodes'] === undefined ? {} : { caOnlyAccountCodes: b['caOnlyAccountCodes'] as string[] }),
            ...(isNum(b['toleranceMinor']) ? { toleranceMinor: b['toleranceMinor'] } : {}),
          });
        } catch {
          notReadable('signed_accounts', 'well-formed trial-balance lines (accountCode, accountName, nature, debitMinor, creditMinor)');
        }
        if (!result!.accepted) inadmissible(result!.refusedBecause ?? 'accounts_refused', result!.detail);
        const clean = result!.balances && result!.lines.every((l) => l.status === 'agrees') && result!.missingFromOpening.length === 0;
        const verdict = verdictOf(result!.reconciles, clean);
        const cannot = 'The accounts were prepared from the same old system. This proves the opening books were assembled as the signed accounts say, not that the accounts are true — the bank, the suppliers and the shelves are the independent evidence.';
        const findings = await recordFindings(deps, ctx.tenantId, ctx.userId, b['evidenceRef'] as string, [
          { domain: 'ledgers', verdict, figureLabel: `${result!.lines.length} account(s) compared, out of balance by ${money(result!.outOfBalanceByMinor)}`, provedBy: ['ca_prepared_accounts'], whatItCannotProve: cannot, ownerAction: result!.ownerAction },
        ]);
        return { status: 201, body: { result, findings } };
      },
    },
    {
      // The customers themselves. Body: { evidenceRef, planId, plannedBy, seed, source, balances[], confirmations[], pointCostMinor,
      // tolerancePoints?, tierThresholds?, tierBoundaryWindow? }. The sample is planned blind; a balance shown to a customer is refused.
      api: 'API-12', method: 'POST', path: '/v1/migration/witness/loyalty',
      permission: 'migration.evidence.record', idempotent: true,
      handler: async (ctx) => {
        await assertSafeTarget(deps, ctx.tenantId);
        const b = isObj(ctx.body) ? ctx.body : {};
        if (!isStr(b['evidenceRef']) || !isStr(b['planId']) || !isStr(b['plannedBy']) || !isNum(b['seed']) || !isStr(b['source'])
          || !isArr(b['balances']) || b['balances'].length === 0 || !isArr(b['confirmations']) || !isNum(b['pointCostMinor'])) {
          notReadable('a_customer_confirmation', 'evidenceRef, planId, plannedBy, a numeric seed, source (how the sample was drawn), balances[], confirmations[] and pointCostMinor');
        }
        const people = await namedPeople(deps, ctx.tenantId);
        const plan = planLoyaltySample({
          planId: b['planId'] as string, balances: b['balances'] as LoyaltyBalance[], plannedBy: b['plannedBy'] as string,
          extractionOperator: people.extractionOperator, source: b['source'] as SampleSource, seed: b['seed'] as number,
          ...(isArr(b['tierThresholds']) ? { tierThresholds: b['tierThresholds'] as number[] } : {}),
          ...(isNum(b['tierBoundaryWindow']) ? { tierBoundaryWindow: b['tierBoundaryWindow'] } : {}),
        });
        if (!plan.ok || plan.plan === undefined) inadmissible(plan.refusedBecause ?? 'sample_refused', plan.detail);
        const result = assessLoyaltyVerification({
          migrated: b['balances'] as LoyaltyBalance[], confirmations: b['confirmations'] as CustomerConfirmation[],
          asked: plan.plan!.lines.map((l) => l.customerId), pointCostMinor: b['pointCostMinor'] as number,
          ...(isNum(b['tolerancePoints']) ? { tolerancePoints: b['tolerancePoints'] } : {}),
        });
        if (!result.accepted) inadmissible(result.refusedBecause ?? 'confirmation_refused', result.detail);
        const clean = result.weMigratedMorePoints === 0 && result.weMigratedFewerPoints === 0 && result.tierDrops.length === 0 && result.noAnswer.length === 0;
        const verdict = verdictOf(result.sufficientToVerify, clean);
        const outstanding = (b['balances'] as LoyaltyBalance[]).reduce((t, x) => t + x.pointsBalance, 0);
        const cannot = 'A customer confirming a balance confirms the balance, not that it was ever earned: award double points by mistake for a year and every customer confirms the wrong figure cheerfully. Customers who did not answer are unverified, not agreed.';
        const label = `${(b['balances'] as LoyaltyBalance[]).length} customers, ${plan.plan!.lines.length} asked, ${result.noAnswer.length} no answer, ${outstanding} points outstanding`;
        const findings = await recordFindings(deps, ctx.tenantId, ctx.userId, b['evidenceRef'] as string, [
          { domain: 'loyalty', verdict, figureLabel: label, provedBy: ['customer_confirmation'], whatItCannotProve: cannot, ownerAction: result.ownerAction },
          { domain: 'customers', verdict, figureLabel: label, provedBy: ['customer_confirmation'], whatItCannotProve: cannot, ownerAction: result.ownerAction },
        ]);
        return { status: 201, body: { plan: plan.plan, result, findings } };
      },
    },
  ];
}
