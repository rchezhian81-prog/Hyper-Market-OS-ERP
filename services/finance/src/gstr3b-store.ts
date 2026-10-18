// API-09 GSTR-3B (R3 · A15 · A16) — the monthly summary return, its reconciliation to the till, the lock to the filed
// GSTR-1, and the amendment that corrects a filed month. On the tested `packages/finance` GSTR-3B engine.
//
//   GET  /v1/finance/gstr3b/:period                       — GSTR-3B for the month (MMYYYY), reconciled to the till, with
//                                                           every difference named and the digest a GSTR-1 preview records.
//   POST /v1/finance/gstr3b/:period/lock                  — lock the outward liability to the FILED GSTR-1 (once).
//   POST /v1/finance/gstr3b/:period/outward-liability     — any attempt to change the outward liability: ALWAYS refused
//                                                           (there is no override — A16; a guardrail binds to it).
//   POST /v1/finance/gstr3b/:period/amendments/:amendmentId — record an amendment of a FILED month: what was banked after
//                                                           filing is declared in the next month, as a compensating event.
//
// Monthly periods only (D2: ₹5–10 crore, no QRMP). Every figure is folded from stored facts; nothing here is typed in.

import type { Route } from '../../kernel/src/index';
import { apiError } from '../../kernel/src/index';
import {
  buildGstr3b, evaluateGstr3bLock, refuseOutwardChange, evaluateAmendment, parseMonthlyPeriod, InvalidGstPeriod, nextMonthlyPeriod,
  type Gstr1Computation, type Gstr1FilingState, type Gstr3bLock, type CarriedAmendment, type TaxHeads, type ItcForPeriod, type Gstr1Figures,
} from '../../../packages/finance/src/index';

/** Everything GSTR-3B reads for one month, folded by the adapter from the stores. */
export interface GstMonth {
  readonly period: string;
  /** GSTR-1 folded from what is stored now, and the till's own sum. */
  readonly current: Gstr1Computation;
  readonly gstr1: {
    readonly state: Gstr1FilingState;
    readonly arn?: string;
    /** The digest the GSTR-1 submission recorded (absent: filed outside this system, or never previewed). */
    readonly returnDigest?: string;
  };
  readonly lock?: Gstr3bLock;
  /** Amendments of the previous month declared in this one. */
  readonly amendmentsIn: readonly CarriedAmendment[];
  /** Amendments of this month declared in the next. */
  readonly amendmentsOut: readonly CarriedAmendment[];
  readonly reverseCharge: { readonly liability: TaxHeads; readonly itcPaid: TaxHeads; readonly unpaid: readonly string[] };
  readonly itc: ItcForPeriod;
}

export interface Gstr3bStoreDeps {
  /** Fold one month. `annualTurnoverMinor` sets the HSN digit rule. */
  readonly month: (tenantId: string, period: string, annualTurnoverMinor: number) => Promise<GstMonth>;
  /** The digest of a month's GSTR-1 figures (sha-256 of the canonical form). */
  readonly digestOf: (figures: Gstr1Figures) => string;
  readonly recordLock: (tenantId: string, lock: Gstr3bLock) => Promise<void>;
  readonly recordAmendment: (tenantId: string, amendment: CarriedAmendment) => Promise<void>;
  readonly now: () => string;
}

/**
 * The turnover the HSN digit rule is judged at when the caller does not send one: the owner's band is ₹5–10 crore (D2),
 * which is above ₹5 crore, so the 6-digit HSN rule applies. One paisa above ₹5 crore says exactly that and no more.
 */
export const D2_TURNOVER_FOR_HSN_RULE_MINOR = 5_00_00_000_00 + 1;

const periodOr400 = (raw: string | undefined): string => {
  try { return parseMonthlyPeriod(raw ?? '').fp; } catch (e) {
    if (e instanceof InvalidGstPeriod) throw apiError(400, { code: 'gst_period_must_be_a_month', whatHappened: e.message, wasItSaved: 'not_saved', nextSafeAction: 'Send the month as MMYYYY (e.g. 052027). This shop files monthly.' });
    throw e;
  }
};

export const turnoverOf = (q: Readonly<Record<string, string>>): number => {
  const raw = q['annualTurnoverMinor'];
  if (raw === undefined) return D2_TURNOVER_FOR_HSN_RULE_MINOR;
  if (!/^\d+$/.test(raw)) throw apiError(400, { code: 'turnover_must_be_whole_paise', whatHappened: 'annualTurnoverMinor must be a whole number of paise.', wasItSaved: 'not_saved', nextSafeAction: 'Omit it (the owner\'s ₹5–10 crore band is used) or send whole paise.' });
  return Number(raw);
};

/** GSTR-3B for one month, from its folded data. Shared by the routes, the calendar and the annual return. */
export function gstr3bOf(m: GstMonth): ReturnType<typeof buildGstr3b> {
  return buildGstr3b({
    period: m.period, current: m.current, gstr1State: m.gstr1.state,
    ...(m.lock !== undefined ? { lock: m.lock } : {}),
    amendmentsIn: m.amendmentsIn, amendmentsOut: m.amendmentsOut,
    reverseCharge: { liability: m.reverseCharge.liability, itcPaid: m.reverseCharge.itcPaid },
    itc: m.itc,
  });
}

export function gstr3bRoutes(deps: Gstr3bStoreDeps): readonly Route[] {
  const view = (m: GstMonth) => ({
    ...gstr3bOf(m),
    gstr1Filing: m.gstr1,
    /** The digest of GSTR-1's figures as stored NOW — what a maker records when previewing GSTR-1 for filing. */
    gstr1PreviewDigest: deps.digestOf(m.current.figures),
    reverseChargeUnpaid: m.reverseCharge.unpaid,
  });
  return [
    {
      api: 'API-09', method: 'GET', path: '/v1/finance/gstr3b/:period',
      permission: 'finance.gstr.read',
      handler: async (ctx) => {
        const period = periodOr400(ctx.params['period']);
        return { status: 200, body: view(await deps.month(ctx.tenantId, period, turnoverOf(ctx.query))) };
      },
    },
    {
      // A16: freeze the outward liability to the FILED GSTR-1. Once only; refused before GSTR-1 is filed.
      api: 'API-09', method: 'POST', path: '/v1/finance/gstr3b/:period/lock',
      permission: 'finance.gstr.generate', idempotent: true,
      handler: async (ctx) => {
        const period = periodOr400(ctx.params['period']);
        const m = await deps.month(ctx.tenantId, period, turnoverOf(ctx.query));
        const decision = evaluateGstr3bLock({ gstr1State: m.gstr1.state, ...(m.lock !== undefined ? { existing: m.lock } : {}) });
        if (!decision.allowed) {
          if (decision.refusal === 'already_locked') return { status: 200, body: { alreadyLocked: true, ...view(m) } };
          throw apiError(409, { code: `gstr3b_${decision.refusal}`, whatHappened: decision.reason, wasItSaved: 'not_saved', nextSafeAction: 'File GSTR-1 for the month first (prepare → a second person approves → file); then lock GSTR-3B to it.' });
        }
        const computedDigest = deps.digestOf(m.current.figures);
        const lock: Gstr3bLock = {
          period, figures: m.current.figures, arn: m.gstr1.arn ?? 'not recorded', lockedBy: ctx.userId, lockedAt: deps.now(),
          filedDigest: m.gstr1.returnDigest ?? 'not recorded (filed outside this system)', computedDigest,
        };
        await deps.recordLock(ctx.tenantId, lock);
        return { status: 201, body: view(await deps.month(ctx.tenantId, period, turnoverOf(ctx.query))) };
      },
    },
    {
      // A16: the ONLY answer to a request to change the outward liability is a refusal. There is no override path.
      api: 'API-09', method: 'POST', path: '/v1/finance/gstr3b/:period/outward-liability',
      permission: 'finance.gstr.generate', idempotent: true,
      handler: async (ctx) => {
        const period = periodOr400(ctx.params['period']);
        const m = await deps.month(ctx.tenantId, period, turnoverOf(ctx.query));
        const r = refuseOutwardChange({ period, ...(m.lock !== undefined ? { lock: m.lock } : {}) });
        throw apiError(409, { code: `gstr3b_outward_${r.refusal}`, whatHappened: r.reason, wasItSaved: 'not_saved', nextSafeAction: r.nextSafeAction });
      },
    },
    {
      // A16: correct a FILED month by an amendment declared in the next month — a compensating event, never an edit.
      api: 'API-09', method: 'POST', path: '/v1/finance/gstr3b/:period/amendments/:amendmentId',
      permission: 'finance.gstr.generate', idempotent: true,
      handler: async (ctx) => {
        const period = periodOr400(ctx.params['period']);
        const amendmentId = ctx.params['amendmentId'] ?? '';
        const b = (ctx.body ?? {}) as Record<string, unknown>;
        if (!/^[A-Za-z0-9_-]{1,40}$/.test(amendmentId)) throw apiError(400, { code: 'amendment_needs_id', whatHappened: 'The amendment id must be 1–40 letters, digits, "-" or "_".', wasItSaved: 'not_saved', nextSafeAction: 'Send a short id for the amendment in the path.' });
        if (typeof b['reason'] !== 'string' || b['reason'].trim() === '') throw apiError(400, { code: 'amendment_needs_reason', whatHappened: 'An amendment needs a reason.', wasItSaved: 'not_saved', nextSafeAction: 'Send { reason } — why the filed figure is being corrected.' });
        const turnover = turnoverOf(ctx.query);
        const m = await deps.month(ctx.tenantId, period, turnover);
        const already = m.amendmentsOut.find((a) => a.amendmentId === amendmentId);
        if (already !== undefined) return { status: 200, body: { amendment: already, alreadyRecorded: true } };
        const next = await deps.month(ctx.tenantId, nextMonthlyPeriod(period), turnover);
        const decision = evaluateAmendment({ lock: m.lock, current: m.current.figures, alreadyCarried: m.amendmentsOut, nextMonthLocked: next.lock !== undefined });
        if (!decision.allowed) {
          throw apiError(decision.refusal === 'nothing_to_amend' ? 422 : 409, { code: `amendment_${decision.refusal}`, whatHappened: decision.reason, wasItSaved: 'not_saved', nextSafeAction: decision.refusal === 'not_locked' ? 'Correct the sale, return or document itself — an unfiled month follows its data.' : 'Nothing was recorded.' });
        }
        const amendment: CarriedAmendment = {
          amendmentId, fromPeriod: period, intoPeriod: decision.intoPeriod, delta: decision.delta,
          reason: b['reason'].trim(), recordedBy: ctx.userId, recordedAt: deps.now(),
        };
        await deps.recordAmendment(ctx.tenantId, amendment);
        return { status: 201, body: { amendment } };
      },
    },
  ];
}
