// API-09 Independent evidence for the month's close (Wave 5 · PF-12 · M23-FR-02, M23-FR-03, M23-FR-04, QG-07, P-08).
//
// The audit found the month close unwired: `controlTotals` returned nothing because nothing outside the system had ever
// been fed in, so no month could close — honestly, but forever. This file is the join:
//
//   • BANK STATEMENTS are imported with their provenance (who, when, which file) and refused unless they add up to their
//     own declared balances, or when already imported. Provider SETTLEMENT FILES were already importable
//     (`settlement.ts`); they now keep who imported them too.
//   • The CLOSE'S CONTROL TOTALS are built from them — each compares a figure from the books with the same figure from
//     outside, reached a different way:
//       1. card and UPI takings: the tenders the tills banked in the month, against the provider's settlement lines for
//          those same tender references;
//       2. provider payouts: what the provider's files say they paid out in the month, against the credits on the bank
//          statement that name those payouts.
//     A tender the provider never settled, or a payout the bank never received, is a difference — the month does not
//     close over it (P-08). A month with no electronic takings and no payouts has no such check, and with nothing else
//     checked still does not close ("nothing was checked").
//
// Cash banked is NOT yet a check: the system records cash leaving the till for the safe, but no deposit of that cash to
// the bank — there is nothing in the books to compare a bank credit with. Said, not invented.

import type { Route } from '../../kernel/src/index';
import { apiError } from '../../kernel/src/index';
import { checkBankStatement, parseBankStatementCsv, type BankStatement } from '../../../packages/finance/src/bank-statement';
import type { ControlTotalCheck } from './index';

/** Who brought a file in, when, and from which file — kept with the evidence, so a signature rests on something traceable. */
export interface Provenance {
  readonly importedBy: string;
  readonly importedAt: string;
  /** The file's own name as the person chose it, when they gave one. */
  readonly sourceName?: string;
}

export interface ImportedStatement extends BankStatement {
  readonly provenance: Provenance;
}

export interface EvidenceTender { readonly ref: string; readonly kind: string; readonly amountMinor: number; readonly saleId: string }
export interface EvidenceBatch {
  readonly batchId: string; readonly providerId: string; readonly settlementDate: string; readonly declaredNetMinor: number;
  readonly lines: readonly { readonly id: string; readonly ref: string; readonly amountMinor: number }[];
}

/** Every independent comparison for a month, with what matched and what did not — the read behind the close. */
export interface MonthEvidence {
  readonly period: string;
  readonly checks: readonly ControlTotalCheck[];
  readonly unsettledTenders: readonly EvidenceTender[];
  readonly payoutsNotInBank: readonly { readonly batchId: string; readonly netMinor: number }[];
  readonly notChecked: readonly string[];
  /** WF-18: what the books still lack against their registers — the sources each check above is short of. */
  readonly books?: {
    readonly stockAdjustmentsUnposted: readonly string[];
    readonly stockAdjustmentsUnvalued: readonly string[];
    readonly payablesUnposted: number;
    readonly receivablesLedgerMinor: number;
    readonly receivablesBooksMinor: number;
  };
}

/** The close's control totals for one month (YYYY-MM), from the books and the imported files. Pure. */
export function monthEvidence(input: {
  readonly period: string;
  /** Card and UPI tenders on the sales banked in the month (from the sales ledger). */
  readonly tenders: readonly EvidenceTender[];
  /** Every provider settlement file imported (any month — a tender settles T+n). */
  readonly batches: readonly EvidenceBatch[];
  /** Every bank statement imported. */
  readonly statements: readonly BankStatement[];
}): MonthEvidence {
  const checks: ControlTotalCheck[] = [];
  const electronic = input.tenders.filter((t) => (t.kind === 'card' || t.kind === 'upi') && t.ref.trim() !== '');
  const settledByRef = new Map<string, number>();
  for (const b of input.batches) for (const l of b.lines) settledByRef.set(l.ref, (settledByRef.get(l.ref) ?? 0) + l.amountMinor);
  if (electronic.length > 0) {
    checks.push({
      name: `Card and UPI takings for ${input.period}`,
      leftMinor: electronic.reduce((n, t) => n + t.amountMinor, 0),
      rightMinor: electronic.reduce((n, t) => n + (settledByRef.get(t.ref) ?? 0), 0),
      leftDerivation: 'the card and UPI tenders on the sales the tills banked (sales ledger)',
      rightDerivation: 'the provider settlement files imported, matched by tender reference',
    });
  }
  const payouts = input.batches.filter((b) => b.settlementDate.slice(0, 7) === input.period);
  const credits = input.statements.flatMap((s) => s.lines).filter((l) => l.amountMinor > 0);
  const inBank = (batchId: string): number => credits.filter((l) => l.reference.includes(batchId) || (l.narrative ?? '').includes(batchId)).reduce((n, l) => n + l.amountMinor, 0);
  if (payouts.length > 0) {
    checks.push({
      name: `Provider payouts received in ${input.period}`,
      leftMinor: payouts.reduce((n, b) => n + b.declaredNetMinor, 0),
      rightMinor: payouts.reduce((n, b) => n + inBank(b.batchId), 0),
      leftDerivation: 'the net payout each imported provider settlement file declares',
      rightDerivation: 'the credits on the imported bank statements that name each payout',
    });
  }
  return {
    period: input.period, checks,
    unsettledTenders: electronic.filter((t) => (settledByRef.get(t.ref) ?? 0) !== t.amountMinor),
    payoutsNotInBank: payouts.filter((b) => inBank(b.batchId) !== b.declaredNetMinor).map((b) => ({ batchId: b.batchId, netMinor: b.declaredNetMinor })),
    notChecked: ['Cash banked: the system records cash going to the safe but no deposit of it to the bank, so a bank credit has nothing in the books to be compared with.'],
  };
}

export interface IndependentEvidenceDeps {
  readonly statements: (tenantId: string) => Promise<readonly ImportedStatement[]>;
  readonly recordStatement: (tenantId: string, statement: ImportedStatement) => Promise<void>;
  /** The month's evidence, built by the composition from the sales ledger and the imported files (`monthEvidence`). */
  readonly evidenceFor: (tenantId: string, period: string) => Promise<MonthEvidence>;
  readonly now: () => string;
}

const PERIOD = /^\d{4}-(0[1-9]|1[0-2])$/;

export function independentEvidenceRoutes(deps: IndependentEvidenceDeps): readonly Route[] {
  return [
    {
      // Import a bank statement — structured, or the bank's CSV export with the statement's own figures beside it.
      api: 'API-09', method: 'POST', path: '/v1/finance/bank-statements',
      permission: 'settlement.batch.import', idempotent: true,
      handler: async (ctx) => {
        const b = (ctx.body ?? {}) as Record<string, unknown>;
        const reading = typeof b['csv'] === 'string'
          ? parseBankStatementCsv(b['csv'], {
            statementId: String(b['statementId'] ?? ''), accountRef: String(b['accountRef'] ?? ''), fromDate: String(b['fromDate'] ?? ''),
            toDate: String(b['toDate'] ?? ''), openingMinor: Number(b['openingMinor']), closingMinor: Number(b['closingMinor']),
          })
          : checkBankStatement(b);
        if (!reading.ok) {
          throw apiError(422, {
            code: 'bank_statement_refused',
            whatHappened: `The statement was not imported: ${reading.problems.join('; ')}.`,
            wasItSaved: 'not_saved',
            nextSafeAction: 'Check the file against the bank\'s printed statement and import it again. Nothing was imported, so nothing was corrupted.',
          });
        }
        const prior = await deps.statements(ctx.tenantId);
        if (prior.some((s) => s.statementId === reading.statement.statementId)) {
          throw apiError(422, {
            code: 'duplicate_statement',
            whatHappened: `Statement ${reading.statement.statementId} is already imported — importing it twice would count every credit twice.`,
            wasItSaved: 'not_saved',
            nextSafeAction: 'Nothing to do; it is already part of the evidence.',
          });
        }
        const imported: ImportedStatement = {
          ...reading.statement,
          provenance: { importedBy: ctx.userId, importedAt: deps.now(), ...(typeof b['sourceName'] === 'string' && b['sourceName'].trim() !== '' ? { sourceName: b['sourceName'].trim().slice(0, 200) } : {}) },
        };
        await deps.recordStatement(ctx.tenantId, imported);
        return { status: 201, body: { statementId: imported.statementId, lines: imported.lines.length, provenance: imported.provenance } };
      },
    },
    {
      api: 'API-09', method: 'GET', path: '/v1/finance/bank-statements',
      permission: 'settlement.review.read',
      handler: async (ctx) => ({
        status: 200,
        body: { statements: (await deps.statements(ctx.tenantId)).map((s) => ({ statementId: s.statementId, accountRef: s.accountRef, fromDate: s.fromDate, toDate: s.toDate, openingMinor: s.openingMinor, closingMinor: s.closingMinor, lines: s.lines.length, provenance: s.provenance })) },
      }),
    },
    {
      // What the close of a month will compare, and what is missing — before anyone asks for a signature.
      api: 'API-09', method: 'GET', path: '/v1/finance/periods/:period/independent-evidence',
      permission: 'finance.period.read',
      handler: async (ctx) => {
        const period = ctx.params['period'] ?? '';
        if (!PERIOD.test(period)) {
          throw apiError(400, { code: 'bad_period', whatHappened: `'${period}' is not a month (YYYY-MM).`, wasItSaved: 'not_saved', nextSafeAction: 'Send the month as YYYY-MM.' });
        }
        const e = await deps.evidenceFor(ctx.tenantId, period);
        return {
          status: 200,
          body: { ...e, agrees: e.checks.length > 0 && e.checks.every((c) => c.leftMinor === c.rightMinor), asAt: deps.now() },
        };
      },
    },
  ];
}
