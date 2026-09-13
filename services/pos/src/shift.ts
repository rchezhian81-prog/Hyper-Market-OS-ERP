// API-05 Shift close — the cashier's blind cash count and over/short (M14-FR-02). The cashier counts
// the drawer WITHOUT seeing the expected figure; this computes the expected cash and the variance,
// requires a reason for a MATERIAL over/short, and records the close — raising a reconciliation
// exception the cash office can see. The rule is the pure `assessShiftClose` in `packages/till`.

import type { Route } from '../../kernel/src/index';
import { apiError } from '../../kernel/src/index';
import { assessShiftClose, checkDenominationCount, assessOverShortReview, type ShiftCloseInput, type DenominationCount } from '../../../packages/till/src/index';

/** A shift close as it is persisted — enough to list over/short and to answer idempotently. */
export interface ClosedShiftRecord {
  readonly shiftId: string;
  readonly tillId: string;
  readonly cashierId: string;
  readonly tradingDay: string;
  readonly expectedMinor: number;
  readonly countedMinor: number;
  readonly varianceMinor: number;
  readonly currency: string;
  readonly exceptionRaised: boolean;
  readonly reasonCode: string | null;
  /**
   * The blind count's denomination breakdown (M14-FR-02), when the cashier entered it note-by-note.
   * Optional so an offline lane that only synced a total still closes; when present it is verified to
   * sum to `countedMinor`, so the cash office and the CA see WHAT was short, not just how much.
   */
  readonly denominations?: readonly DenominationCount[];
  readonly closedAt: string;
}

/**
 * A cash-office sign-off on a material over/short (M14 / P-03). Append-only, one accountable reviewer
 * who is NOT the cashier who counted the drawer. It closes the exception; it never edits the close.
 */
export interface OverShortReview {
  readonly shiftId: string;
  /** The reviewer — the authenticated caller, never the cashier who closed the shift. */
  readonly reviewedBy: string;
  /** The cashier whose drawer this was, copied from the close for the audit trail. */
  readonly cashierId: string;
  readonly varianceMinor: number;
  /** The reviewer's coded finding for why the drawer was over/short. */
  readonly disposition: string;
  /** Optional free-text detail alongside the coded disposition. */
  readonly note: string | null;
  readonly reviewedAt: string;
}

/**
 * What the automatic shortage rule did when a drawer closed materially short (M15-FR-04). The close
 * always succeeds — the shop keeps trading (P-01) — so this reports, separately, whether the
 * investigation was opened, or why it could not be (a visible gap, never a silent one — P-08).
 */
export interface ShortageInvestigationOutcome {
  readonly opened: boolean;
  readonly caseId?: string;
  readonly assignedTo?: string;
  readonly alreadyOpen?: boolean;
  /** Set when no case was opened — e.g. no store manager to assign it to. */
  readonly blockedReason?: string;
  readonly detail?: string;
}

export interface ShiftDeps {
  readonly closedShift: (tenantId: string, shiftId: string) => Promise<ClosedShiftRecord | undefined> | ClosedShiftRecord | undefined;
  readonly recordShiftClose: (tenantId: string, record: ClosedShiftRecord) => Promise<void> | void;
  /**
   * Open a loss-prevention investigation for a drawer that closed materially SHORT, assigned to the
   * store manager (never the cashier). Optional: an offline/store-less lane closes without it, and the
   * close never fails when it is absent or refuses.
   */
  readonly openInvestigationOnShortage?: (tenantId: string, record: ClosedShiftRecord) => Promise<ShortageInvestigationOutcome> | ShortageInvestigationOutcome;
  /** Shifts closed with a material over/short — the cash office's reconciliation list. */
  readonly overShortShifts: (tenantId: string) => Promise<readonly ClosedShiftRecord[]> | readonly ClosedShiftRecord[];
  /** Cash-office sign-offs recorded against material over/shorts, so the list shows what is still open. */
  readonly overShortReviews: (tenantId: string) => Promise<readonly OverShortReview[]> | readonly OverShortReview[];
  readonly recordOverShortReview: (tenantId: string, review: OverShortReview) => Promise<void> | void;
  readonly now: () => string;
}

const NUMS = ['openingFloatMinor', 'cashSalesMinor', 'pickupsMinor', 'cashRefundsMinor', 'countedCashMinor', 'toleranceMinor'] as const;

export function shiftRoutes(deps: ShiftDeps): readonly Route[] {
  return [
    {
      // Close a shift against the blind count. A material variance needs a reason; on success the
      // close is recorded and, if material, flagged for reconciliation. Idempotent per shift.
      api: 'API-05', method: 'POST', path: '/v1/shifts/:shiftId/close',
      permission: 'till.shift.close', idempotent: true,
      handler: async (ctx) => {
        const shiftId = ctx.params['shiftId'] ?? '';
        const already = await deps.closedShift(ctx.tenantId, shiftId);
        if (already !== undefined) {
          return { status: 200, body: { shiftId, closed: true, varianceMinor: already.varianceMinor, exceptionRaised: already.exceptionRaised, alreadyClosed: true } };
        }

        const b = (ctx.body ?? {}) as Record<string, unknown>;
        if (typeof b['tillId'] !== 'string' || (b['tillId'] as string).trim() === ''
          || typeof b['cashierId'] !== 'string' || (b['cashierId'] as string).trim() === ''
          || typeof b['tradingDay'] !== 'string' || (b['tradingDay'] as string).trim() === ''
          || !NUMS.every((k) => Number.isInteger(b[k]))) {
          throw apiError(400, {
            code: 'not_readable_as_a_shift_close',
            whatHappened: 'Closing a shift needs a till, a cashier, a trading day, and whole opening float, cash sales, pickups, cash refunds, counted cash and a tolerance.',
            wasItSaved: 'not_saved',
            nextSafeAction: 'Nothing was closed. Send the till, cashier, day and the cash figures.',
          });
        }

        // Optional denomination breakdown of the blind count. When present, every entry must read as a
        // {denominationMinor, count} pair and the whole breakdown must SUM to the counted total — a
        // breakdown that does not sum is an entry error caught here at the drawer, never a variance the
        // cash office chases at audit.
        let denominations: readonly DenominationCount[] | undefined;
        if (b['denominations'] !== undefined) {
          if (!Array.isArray(b['denominations'])
            || !b['denominations'].every((d) => d !== null && typeof d === 'object'
              && Number.isInteger((d as Record<string, unknown>)['denominationMinor'])
              && Number.isInteger((d as Record<string, unknown>)['count']))) {
            throw apiError(400, {
              code: 'denominations_not_readable',
              whatHappened: 'The denomination breakdown must be a list of notes/coins, each with a whole face value in paise and a whole count.',
              wasItSaved: 'not_saved',
              nextSafeAction: 'Nothing was closed. Send the breakdown as a list of {denominationMinor, count}, or leave it out to close on the total alone.',
            });
          }
          const parsed = (b['denominations'] as readonly Record<string, unknown>[]).map((d) => ({
            denominationMinor: d['denominationMinor'] as number, count: d['count'] as number,
          }));
          const check = checkDenominationCount({ denominations: parsed, countedCashMinor: b['countedCashMinor'] as number });
          if (!check.ok) {
            throw apiError(422, {
              code: check.refusedBecause!,
              whatHappened: check.detail,
              wasItSaved: 'not_saved',
              nextSafeAction: 'The drawer was NOT closed. Recount the notes and coins so the breakdown matches the counted total, then close again.',
            });
          }
          denominations = parsed;
        }

        const input: ShiftCloseInput = {
          openingFloatMinor: b['openingFloatMinor'] as number, cashSalesMinor: b['cashSalesMinor'] as number,
          pickupsMinor: b['pickupsMinor'] as number, cashRefundsMinor: b['cashRefundsMinor'] as number,
          countedCashMinor: b['countedCashMinor'] as number, toleranceMinor: b['toleranceMinor'] as number,
          ...(typeof b['reasonCode'] === 'string' ? { reasonCode: b['reasonCode'] } : {}),
        };
        const result = assessShiftClose(input);
        if (!result.ok) {
          throw apiError(422, {
            code: result.refusedBecause!,
            whatHappened: result.detail,
            wasItSaved: 'not_saved',
            nextSafeAction: 'The drawer is not balanced within tolerance. Enter the reason for the over/short and close it again.',
          });
        }

        const record: ClosedShiftRecord = {
          shiftId, tillId: b['tillId'] as string, cashierId: b['cashierId'] as string, tradingDay: b['tradingDay'] as string,
          expectedMinor: result.expectedMinor, countedMinor: result.countedMinor, varianceMinor: result.varianceMinor,
          currency: typeof b['currency'] === 'string' ? b['currency'] as string : 'INR',
          exceptionRaised: result.exceptionRaised, reasonCode: result.reasonCode,
          ...(denominations !== undefined ? { denominations } : {}),
          closedAt: deps.now(),
        };
        await deps.recordShiftClose(ctx.tenantId, record);

        // A material SHORT auto-opens a loss-prevention investigation, assigned to the store manager
        // (M15-FR-04). It never blocks the close — the shop keeps trading (P-01) — and its outcome
        // (opened, or why not) is reported alongside so a gap is visible, not silent (P-08).
        let investigation: ShortageInvestigationOutcome | undefined;
        if (result.exceptionRaised && result.isShort && deps.openInvestigationOnShortage !== undefined) {
          investigation = await deps.openInvestigationOnShortage(ctx.tenantId, record);
        }

        return {
          status: 201,
          body: {
            shiftId, closed: true, expectedMinor: result.expectedMinor, countedMinor: result.countedMinor,
            varianceMinor: result.varianceMinor, isOver: result.isOver, isShort: result.isShort,
            exceptionRaised: result.exceptionRaised, denominationsRecorded: denominations !== undefined,
            ...(investigation !== undefined ? { investigation } : {}),
          },
        };
      },
    },
    {
      api: 'API-05', method: 'GET', path: '/v1/shifts/over-short',
      permission: 'till.shift.read',
      handler: async (ctx) => {
        const rows = await deps.overShortShifts(ctx.tenantId);
        const reviews = await deps.overShortReviews(ctx.tenantId);
        const reviewByShift = new Map(reviews.map((r) => [r.shiftId, r] as const));
        const mapped = rows.map((r) => {
          const review = reviewByShift.get(r.shiftId);
          return {
            shiftId: r.shiftId, tillId: r.tillId, cashierId: r.cashierId, tradingDay: r.tradingDay,
            varianceMinor: r.varianceMinor, reasonCode: r.reasonCode, denominations: r.denominations ?? null,
            reviewed: review !== undefined,
            reviewedBy: review?.reviewedBy ?? null,
            disposition: review?.disposition ?? null,
            reviewedAt: review?.reviewedAt ?? null,
          };
        });
        return {
          status: 200,
          body: {
            overShort: mapped,
            totalVarianceMinor: rows.reduce((s, r) => s + r.varianceMinor, 0),
            // The cash office works the OPEN ones — a shortage nobody signed off is the one that matters.
            openCount: mapped.filter((r) => !r.reviewed).length,
            asAt: deps.now(),
          },
        };
      },
    },
    {
      // Sign off a material over/short (P-03 control by exception). The reviewer is the authenticated
      // caller — never the cashier who counted the drawer (separation of duties) — and must state a
      // finding. Append-only: it closes the exception, it never edits the close. Idempotent per shift.
      api: 'API-05', method: 'POST', path: '/v1/shifts/:shiftId/over-short/review',
      permission: 'till.overshort.review', idempotent: true,
      handler: async (ctx) => {
        const shiftId = ctx.params['shiftId'] ?? '';
        const record = await deps.closedShift(ctx.tenantId, shiftId);
        if (record === undefined) {
          throw apiError(404, {
            code: 'no_such_closed_shift',
            whatHappened: `There is no closed shift "${shiftId}" to review.`,
            wasItSaved: 'not_saved',
            nextSafeAction: 'Check the shift id on the over/short list and try again.',
          });
        }

        const existing = (await deps.overShortReviews(ctx.tenantId)).find((r) => r.shiftId === shiftId);
        if (existing !== undefined) {
          return { status: 200, body: { shiftId, reviewed: true, reviewedBy: existing.reviewedBy, disposition: existing.disposition, alreadyReviewed: true } };
        }

        const b = (ctx.body ?? {}) as Record<string, unknown>;
        if (typeof b['disposition'] !== 'string' || (b['note'] !== undefined && typeof b['note'] !== 'string')) {
          throw apiError(400, {
            code: 'not_readable_as_a_review',
            whatHappened: 'Signing off an over/short needs a disposition (a coded finding); a note is optional text.',
            wasItSaved: 'not_saved',
            nextSafeAction: 'Nothing was signed off. Send a disposition, and optionally a note.',
          });
        }

        const disposition = b['disposition'] as string;
        const assessment = assessOverShortReview({
          reviewerId: ctx.userId, cashierId: record.cashierId,
          exceptionRaised: record.exceptionRaised, disposition,
        });
        if (!assessment.ok) {
          throw apiError(422, {
            code: assessment.refusedBecause!,
            whatHappened: assessment.detail,
            wasItSaved: 'not_saved',
            nextSafeAction: assessment.refusedBecause === 'cannot_review_your_own_drawer'
              ? 'A different person — the cash office or the store manager — must sign this off.'
              : 'Send a stated finding for the over/short, or pick a shift that actually has one.',
          });
        }

        const review: OverShortReview = {
          shiftId, reviewedBy: ctx.userId, cashierId: record.cashierId, varianceMinor: record.varianceMinor,
          disposition, note: typeof b['note'] === 'string' ? b['note'] : null, reviewedAt: deps.now(),
        };
        await deps.recordOverShortReview(ctx.tenantId, review);
        return { status: 201, body: { shiftId, reviewed: true, reviewedBy: review.reviewedBy, disposition: review.disposition, varianceMinor: review.varianceMinor } };
      },
    },
  ];
}
