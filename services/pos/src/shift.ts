// API-05 Shift close — the cashier's blind cash count and over/short (M14-FR-02). The cashier counts
// the drawer WITHOUT seeing the expected figure; the store box computes the expected cash and the variance,
// requires a reason for a MATERIAL over/short, and records the close. Head office records the close the box
// relays, re-runs the same pure `assessShiftClose` over it, and raises the reconciliation exception the cash
// office sees. Since PF-08 (OB-27 "A") head office has no direct close of its own.

import type { Route } from '../../kernel/src/index';
import { apiError, assertRecordBranchInScope, narrowScope } from '../../kernel/src/index';
import { assessShiftClose, checkDenominationCount, assessOverShortReview, type DenominationCount } from '../../../packages/till/src/index';
import { personFindings } from './cash';
import { cashierSealFlags, stampIn, type CashierSealFlag } from './store-seal';
import { tillStoreOf, type TillStoreDeps } from './till-store';

/** What the cloud found when it re-verified a close the store box relayed (SP-4c · §28 · hard rule #10). */
export type ShiftGovernanceFlag =
  | 'cashier_unknown' | 'cashier_lacks_authority'
  /** The store computer's seal on who closed it is missing, or does not match this close (ADR-0023 · PF-02). */
  | CashierSealFlag
  /** The relayed expected/variance do not follow from the relayed figures — the box and the cloud disagree; a person looks. */
  | 'figures_inconsistent'
  /** The variance is material and the relayed close carries no reason (the box should have refused it). */
  | 'material_variance_without_reason'
  /** The store pack named no cash tolerance, so the box applied its default — said, never silent. */
  | 'default_tolerance'
  /** The denomination breakdown does not add up to the counted total. */
  | 'denominations_do_not_sum';

/** A shift close as it is persisted — enough to list over/short and to answer idempotently. */
export interface ClosedShiftRecord {
  readonly shiftId: string;
  readonly tillId: string;
  /**
   * OB-80 "A" (owner, 12 Oct 2026): the store whose till this is — a till is (store, till). The relaying box's own store
   * (stamped by head office from its credential), else the store the body names. Absent on a close taken before OB-80
   * (read as the till's store under the migration rule in `services/api/src/till-identity.ts`).
   */
  readonly storeId?: string;
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
  /** Set on a close the store box relayed (SP-4c): where it happened, the window it covers, the figures, and what the cloud found. */
  readonly laneId?: string;
  readonly openedAt?: string;
  readonly openingFloatMinor?: number;
  readonly cashSalesMinor?: number;
  readonly pickupsMinor?: number;
  readonly cashRefundsMinor?: number;
  readonly toleranceMinor?: number;
  readonly relayed?: true;
  readonly flags?: readonly ShiftGovernanceFlag[];
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

export interface ShiftDeps extends TillStoreDeps {
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
  /**
   * The permissions a named person holds through their grants; `undefined` when they hold none. The synced route
   * re-verifies the cashier a relayed close names (SP-4c · §28 · hard rule #4). Absent → no person finding.
   */
  readonly permissionsOfUser?: (tenantId: string, userId: string) => Promise<readonly string[] | undefined> | readonly string[] | undefined;
  /** The key head office checks the store computer's seal with (ADR-0023) — on a relayed close. Absent → not checked. */
  readonly tillSealKey?: Buffer;
}

/** OB-80/OB-82: the store a close belongs to — the store it names, else (kept before OB-80) its till's one-time legacy placement. */
async function closeStoreOf(deps: ShiftDeps, tenantId: string, r: ClosedShiftRecord): Promise<string | undefined> {
  if (r.storeId !== undefined && r.storeId !== '') return r.storeId;
  return deps.legacyStoreOfTill === undefined ? undefined : deps.legacyStoreOfTill(tenantId, r.tillId);
}

export function shiftRoutes(deps: ShiftDeps): readonly Route[] {
  return [
    // PF-08 · OB-27 "A" (9 Oct 2026): there is NO direct close here. A shift closes at the till, through the store box,
    // which works out every figure but the count from its own logs and judges it; head office only RECORDS the close the
    // box relays (below) and re-runs the rule over it. The retired direct route took every figure — float, sales, count,
    // even the tolerance — from the caller, so a caller could invent a balanced drawer.
    {
      // A shift close that ALREADY HAPPENED at the till, relayed by the store box under the store's sync identity
      // (SP-4c · F10 · M14-FR-02 · §31 · §28). The box worked the figures out from its own logs and decided the close
      // against the cashier's blind count; the cloud never refuses it (202 always). It RE-VERIFIES the cashier from their
      // grants, RE-RUNS the same rule over the relayed figures (a disagreement is a flag, never a silent correction), and
      // records the close with any finding as a visible flag — then, exactly as a direct close does, a material SHORT
      // opens a loss-prevention investigation (M15-FR-04). Idempotent on the shift id.
      api: 'API-05', method: 'POST', path: '/v1/shifts/:shiftId/close/synced',
      permission: 'till.shift.sync', idempotent: true,
      handler: async (ctx) => {
        const shiftId = ctx.params['shiftId'] ?? '';
        const already = await deps.closedShift(ctx.tenantId, shiftId);
        if (already !== undefined) {
          return { status: 200, body: { shiftId, recorded: true, alreadyClosed: true, varianceMinor: already.varianceMinor, exceptionRaised: already.exceptionRaised, flags: already.flags ?? [] } };
        }
        const b = (ctx.body ?? {}) as Record<string, unknown>;
        const str = (k: string): string | undefined => (typeof b[k] === 'string' && (b[k] as string).trim() !== '' ? (b[k] as string) : undefined);
        const tillId = str('tillId'); const cashierId = str('cashierId'); const tradingDay = str('tradingDay'); const closedAt = str('closedAt');
        const laneId = str('laneId'); const openedAt = str('openedAt'); const reasonCode = str('reasonCode');
        const RELAYED_NUMS = ['openingFloatMinor', 'cashSalesMinor', 'pickupsMinor', 'cashRefundsMinor', 'countedMinor', 'expectedMinor', 'varianceMinor', 'toleranceMinor'] as const;
        if (tillId === undefined || cashierId === undefined || tradingDay === undefined || closedAt === undefined || Number.isNaN(Date.parse(closedAt))
          || !RELAYED_NUMS.every((k) => Number.isInteger(b[k])) || typeof b['exceptionRaised'] !== 'boolean') {
          throw apiError(400, {
            code: 'not_readable_as_a_synced_shift_close',
            whatHappened: 'A relayed shift close needs the till, the cashier, the trading day, the moment, and the whole figures the box decided on (float, cash sales, pickups, refunds, counted, expected, variance, tolerance).',
            wasItSaved: 'not_saved',
            nextSafeAction: 'Nothing was recorded. The box must send the close as it recorded it.',
          });
        }
        const n = (k: typeof RELAYED_NUMS[number]): number => b[k] as number;
        // OB-80: the till is (store, till) — a box's own store is stamped on the close by head office.
        const storeId = await tillStoreOf(deps, ctx, tillId, b['storeId']);

        const flags: string[] = [
          ...await personFindings(deps, ctx.tenantId, cashierId, 'cashier_unknown', 'cashier_lacks_authority'),
          // Whether the store computer vouches for who closed it (ADR-0023 · PF-02).
          ...cashierSealFlags(deps.tillSealKey, {
            fact: 'shift_close', tenantId: ctx.tenantId, recordId: shiftId, amountMinor: n('countedMinor'), named: cashierId,
            stamp: stampIn(ctx.body, 'operatorVerified'),
          }),
        ];
        // The same rule, re-run over the relayed figures. The box's answer must follow from them; a disagreement is said.
        const recomputed = assessShiftClose({
          openingFloatMinor: n('openingFloatMinor'), cashSalesMinor: n('cashSalesMinor'), pickupsMinor: n('pickupsMinor'), cashRefundsMinor: n('cashRefundsMinor'),
          countedCashMinor: n('countedMinor'), toleranceMinor: n('toleranceMinor'), ...(reasonCode === undefined ? {} : { reasonCode }),
        });
        if (recomputed.expectedMinor !== n('expectedMinor') || recomputed.varianceMinor !== n('varianceMinor') || recomputed.exceptionRaised !== b['exceptionRaised']) flags.push('figures_inconsistent');
        if (!recomputed.ok) flags.push('material_variance_without_reason');
        if (b['toleranceKnown'] === false) flags.push('default_tolerance');

        let denominations: readonly DenominationCount[] | undefined;
        if (Array.isArray(b['denominations'])) {
          const parsed = (b['denominations'] as unknown[]).flatMap((d): DenominationCount[] => {
            const x = (d ?? {}) as Record<string, unknown>;
            return Number.isInteger(x['denominationMinor']) && Number.isInteger(x['count']) ? [{ denominationMinor: x['denominationMinor'] as number, count: x['count'] as number }] : [];
          });
          if (!checkDenominationCount({ denominations: parsed, countedCashMinor: n('countedMinor') }).ok) flags.push('denominations_do_not_sum');
          denominations = parsed;
        }

        const record: ClosedShiftRecord = {
          shiftId, tillId, ...(storeId === undefined ? {} : { storeId }), cashierId, tradingDay,
          expectedMinor: recomputed.expectedMinor, countedMinor: n('countedMinor'), varianceMinor: recomputed.varianceMinor,
          currency: typeof b['currency'] === 'string' ? (b['currency'] as string) : 'INR',
          exceptionRaised: recomputed.exceptionRaised, reasonCode: recomputed.reasonCode,
          ...(denominations !== undefined ? { denominations } : {}),
          closedAt,
          ...(laneId === undefined ? {} : { laneId }), ...(openedAt === undefined ? {} : { openedAt }),
          openingFloatMinor: n('openingFloatMinor'), cashSalesMinor: n('cashSalesMinor'), pickupsMinor: n('pickupsMinor'), cashRefundsMinor: n('cashRefundsMinor'),
          toleranceMinor: n('toleranceMinor'), relayed: true,
          ...(flags.length === 0 ? {} : { flags: flags as ShiftGovernanceFlag[] }),
        };
        await deps.recordShiftClose(ctx.tenantId, record);

        let investigation: ShortageInvestigationOutcome | undefined;
        if (recomputed.exceptionRaised && recomputed.isShort && deps.openInvestigationOnShortage !== undefined) {
          investigation = await deps.openInvestigationOnShortage(ctx.tenantId, record);
        }
        return {
          status: 202,
          body: {
            shiftId, tillId, storeId: storeId ?? null, recorded: true, expectedMinor: recomputed.expectedMinor, varianceMinor: recomputed.varianceMinor,
            exceptionRaised: recomputed.exceptionRaised, flags, ...(investigation !== undefined ? { investigation } : {}),
          },
        };
      },
    },
    {
      api: 'API-05', method: 'GET', path: '/v1/shifts/over-short',
      permission: 'till.shift.read',
      handler: async (ctx) => {
        // OB-83 "A" (owner, 12 Oct 2026, "Own store's manager only"): a branch-limited person sees ONLY their own stores'
        // over/shorts — the store of each close is head office's own (its storeId; a close kept before OB-80 by the till's
        // one-time legacy placement, OB-82). Head office / the owner (company-wide scope) sees every store. A close no store
        // can be found for is shop-wide: only a company-wide reader sees it. `?storeId=` narrows (refused by name when not held).
        const asked = typeof ctx.query['storeId'] === 'string' && ctx.query['storeId'].trim() !== '' ? ctx.query['storeId'] : undefined;
        const scope = narrowScope(ctx, asked === undefined ? undefined : [asked]);
        const placed = await Promise.all((await deps.overShortShifts(ctx.tenantId)).map(async (r) => ({ r, store: await closeStoreOf(deps, ctx.tenantId, r) })));
        const rows = placed
          .filter(({ store }) => (scope === 'all' ? asked === undefined || store === asked : store !== undefined && scope.includes(store)))
          .map(({ r, store }) => ({ ...r, storeId: store, legacyPlaced: r.storeId === undefined && store !== undefined }));
        const reviews = await deps.overShortReviews(ctx.tenantId);
        const reviewByShift = new Map(reviews.map((r) => [r.shiftId, r] as const));
        const mapped = rows.map((r) => {
          const review = reviewByShift.get(r.shiftId);
          return {
            shiftId: r.shiftId, tillId: r.tillId, storeId: r.storeId ?? null, ...(r.legacyPlaced ? { legacyPlaced: true } : {}), cashierId: r.cashierId, tradingDay: r.tradingDay,
            varianceMinor: r.varianceMinor, reasonCode: r.reasonCode, denominations: r.denominations ?? null,
            // A relayed close and what the cloud found when it re-verified it (SP-4c), for the cash office (P-08).
            laneId: r.laneId ?? null, relayed: r.relayed === true, flags: r.flags ?? [],
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

        // OB-83 "A": only a person whose own scope covers the close's store signs it off (head office covers all); a close
        // with no store is shop-wide, so only a company-wide person may (PA-01 helpers — refused by name, nothing saved).
        assertRecordBranchInScope(ctx, await closeStoreOf(deps, ctx.tenantId, record));

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
