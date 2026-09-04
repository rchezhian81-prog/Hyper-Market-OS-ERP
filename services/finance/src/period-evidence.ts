// API-09 Period-close evidence pack & control-total validation (M23-FR-04 / QG-07 / §29.1 / hard rule #2).
//
// A period is signed off on TWO figures agreeing that were reached two DIFFERENT ways — "sum of the sales
// ledger" against "sum of the sales ledger" is arithmetic, not a check. The genuine second side comes from
// OUTSIDE this system (the bank statement, the filed return, the counted shelf), so the caller supplies it;
// the tested `@sre/period-close` engine does the comparison, exactly in integer minor units.
//
//   • CONTROL TOTALS — compare both sides of every total and say, per line, whether it reconciles and by how
//     much a difference is, in words a CA can re-derive.
//   • EVIDENCE PACK — the pack the CA actually SIGNS: it states both sides of every figure and where each
//     came from, so the signature is on something re-derivable rather than on our word. A pack that does NOT
//     reconcile (a difference, or a posting the accounts never received) is still produced — hiding it just
//     moves the conversation later — but marked **not signable**, with the reason on the page (P-08).
//
// Both are pure reads over supplied figures — they write nothing and change no period's state. Gated
// `finance.period.read` (the accountant and owner, who answer for the books). Closing a period is
// `POST /v1/finance/periods/:period/close` and the §28-approved REOPEN of a signed period is
// `POST /v1/finance/periods/:period/reopen` — both in `services/finance/src/index.ts`, where the
// close-idempotency was reworked so a reopened period is re-closable.

import type { Route } from '../../kernel/src/index';
import { apiError } from '../../kernel/src/index';
import {
  validateControlTotals, buildEvidencePack, type ControlTotal,
} from '../../../packages/period-close/src/index';

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const isStr = (v: unknown): v is string => typeof v === 'string' && v.trim() !== '';
const isInt = (v: unknown): v is number => typeof v === 'number' && Number.isInteger(v);

/** A control total — a name, both sides in minor units, and where each side was derived (so a CA can check). */
function readTotal(v: unknown): ControlTotal | undefined {
  if (!isObj(v) || !isStr(v['name']) || !isInt(v['ledgerMinor']) || !isInt(v['postedMinor']) || !isStr(v['method'])) return undefined;
  return { name: v['name'] as string, ledgerMinor: v['ledgerMinor'] as number, postedMinor: v['postedMinor'] as number, method: v['method'] as string };
}

function readTotals(v: unknown): readonly ControlTotal[] | undefined {
  if (!Array.isArray(v)) return undefined;
  const out: ControlTotal[] = [];
  for (const item of v) {
    const one = readTotal(item);
    if (one === undefined) return undefined;
    out.push(one);
  }
  return out;
}

const badTotals = () => apiError(400, {
  code: 'not_readable_as_control_totals',
  whatHappened: 'This needs { totals[] } — each with a name, ledgerMinor and postedMinor (whole minor units) reached two different ways, and the method each side was derived from.',
  wasItSaved: 'not_saved',
  nextSafeAction: 'Send the control totals: the book of record on one side, the independent second source on the other.',
});

export interface PeriodEvidenceDeps {
  readonly now: () => string;
}

export function periodEvidenceRoutes(deps: PeriodEvidenceDeps): readonly Route[] {
  return [
    {
      // CONTROL TOTALS — reconcile both sides of every total (a read; POST because the totals are a body).
      api: 'API-09', method: 'POST', path: '/v1/finance/periods/:period/control-totals',
      permission: 'finance.period.read', idempotent: true,
      handler: async (ctx) => {
        const b = (ctx.body ?? {}) as Record<string, unknown>;
        const totals = readTotals(b['totals']);
        if (totals === undefined) throw badTotals();
        const { results, allReconcile } = validateControlTotals(totals);
        return { status: 200, body: { period: ctx.params['period'] ?? '', results, allReconcile, asAt: deps.now() } };
      },
    },
    {
      // EVIDENCE PACK — the CA's signable pack; a non-reconciling one is still produced, marked not signable.
      api: 'API-09', method: 'POST', path: '/v1/finance/periods/:period/evidence-pack',
      permission: 'finance.period.read', idempotent: true,
      handler: async (ctx) => {
        const b = (ctx.body ?? {}) as Record<string, unknown>;
        const totals = readTotals(b['totals']);
        if (totals === undefined) throw badTotals();
        if (!isStr(b['tradingDayCutoff'])) {
          throw apiError(400, {
            code: 'evidence_pack_needs_a_cutoff',
            whatHappened: 'An evidence pack needs the { tradingDayCutoff } this period aligns to (M01-FR-02) so a day is counted in exactly one period.',
            wasItSaved: 'not_saved',
            nextSafeAction: 'Send the trading-day cut-off for the period.',
          });
        }
        if (b['deadLetteredCount'] !== undefined && (!isInt(b['deadLetteredCount']) || (b['deadLetteredCount'] as number) < 0)) {
          throw apiError(400, { code: 'dead_lettered_count_not_a_count', whatHappened: 'deadLetteredCount must be a whole number when given.', wasItSaved: 'not_saved', nextSafeAction: 'Send how many postings the accounts never received, or leave it out.' });
        }
        const pack = buildEvidencePack({
          period: ctx.params['period'] ?? '',
          tenantId: ctx.tenantId,
          totals,
          tradingDayCutoff: b['tradingDayCutoff'] as string,
          preparedBy: ctx.userId,
          at: deps.now(),
          ...(isInt(b['deadLetteredCount']) ? { deadLetteredCount: b['deadLetteredCount'] as number } : {}),
        });
        return { status: 200, body: pack };
      },
    },
  ];
}
