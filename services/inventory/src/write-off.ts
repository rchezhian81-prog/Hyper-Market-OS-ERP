// API-04 Waste / write-off (M28-FR-01). Record what leaves as LOSS — wastage, damage, expiry, donation,
// destruction — as a reason-coded COMPENSATING stock movement (never an edit, hard rule #2), valued for
// finance (M23). A MATERIAL loss (value at/above the tenant's threshold) needs a SEPARATE approver (§28 — the
// person who raised the loss can never approve it) and captured EVIDENCE (photo/witness). The rules are the
// pure `commitWriteOff` engine in `packages/waste/src/waste.ts` (which reuses the M08 `commitAdjustment`
// separation-of-duties check), run here over an ephemeral ledger + outbox; this surface persists the committed
// write-off on its own append-only stream. The raiser is the AUTHENTICATED caller (`ctx.userId`), never a body
// value — so a person can never record a loss in someone else's name. Append-only; idempotent on the id.

import type { Route } from '../../kernel/src/index';
import { apiError } from '../../kernel/src/index';
import {
  commitWriteOff, MissingReasonError, InvalidWriteOffError, MissingEvidenceError,
  type LossType, type WrittenOff,
} from '../../../packages/waste/src/waste';
import { ApprovalRequiredError } from '../../../packages/adjustment/src/adjustment';
import { Ledger, InMemoryLedgerStore } from '../../../packages/ledger/src/ledger';
import { SyncOutbox } from '../../../packages/sync/src/outbox';
import type { DecidedRequest } from '../../../packages/approvals/src/approvals';
import { isCurrencyCode, type CurrencyCode } from '../../../packages/contracts/src/money';

const LOSS_TYPES: readonly LossType[] = ['wastage', 'damage', 'expiry', 'donation', 'destruction'];

const isStr = (v: unknown): v is string => typeof v === 'string' && v.trim() !== '';
const isNonNegInt = (v: unknown): v is number => Number.isInteger(v) && (v as number) >= 0;
const isPosInt = (v: unknown): v is number => Number.isInteger(v) && (v as number) > 0;

/** A committed write-off as it is stored on the append-only stream and read back. */
export interface StoredWriteOff {
  readonly id: string;
  readonly productId: string;
  readonly locationId: string;
  readonly lossType: LossType;
  readonly qtyRemoved: number;
  readonly uom: string;
  readonly valueMinor: number;
  readonly currency: CurrencyCode;
  readonly reasonCode: string;
  readonly requiredApproval: boolean;
  readonly evidenceRef: string | null;
  readonly raisedBy: string;
  readonly approvedBy: string | null;
  readonly at: string;
}

export interface WriteOffDeps {
  /** Whether a write-off id has already been committed (idempotency — an id is used once). */
  readonly writeOffExists: (tenantId: string, id: string) => Promise<boolean> | boolean;
  /** The committed write-offs (for the review surface / a location query). */
  readonly writeOffs: (tenantId: string) => Promise<readonly StoredWriteOff[]> | readonly StoredWriteOff[];
  readonly recordWriteOff: (tenantId: string, rec: StoredWriteOff) => Promise<void> | void;
  readonly now: () => string;
}

export function writeOffRoutes(deps: WriteOffDeps): readonly Route[] {
  return [
    {
      // Commit a write-off. Reason + positive quantity are always required; a material loss additionally
      // needs captured evidence AND an approval by a DIFFERENT person (§28). The raiser is the caller.
      api: 'API-04', method: 'POST', path: '/v1/inventory/write-off/:writeOffId',
      permission: 'inventory.movement.append', idempotent: true,
      handler: async (ctx) => {
        const writeOffId = ctx.params['writeOffId'] ?? '';
        const b = (ctx.body ?? {}) as Record<string, unknown>;
        if (!isStr(b['productId']) || !isStr(b['locationId']) || !isPosInt(b['qty']) || !isStr(b['uom'])
          || !LOSS_TYPES.includes(b['lossType'] as LossType) || !isStr(b['reasonCode'])
          || !isNonNegInt(b['valueMinor']) || !isNonNegInt(b['thresholdMinor'])
          || (b['currency'] !== undefined && !isCurrencyCode(b['currency'] as string))
          || (b['evidenceRef'] !== undefined && !isStr(b['evidenceRef']))
          || (b['approvedBy'] !== undefined && !isStr(b['approvedBy']))) {
          throw apiError(400, {
            code: 'not_readable_as_a_write_off',
            whatHappened: 'A write-off needs a productId, locationId, whole qty > 0, uom, a lossType (wastage/damage/expiry/donation/destruction), a reasonCode, a whole valueMinor and thresholdMinor.',
            wasItSaved: 'not_saved',
            nextSafeAction: 'Send the write-off fields. Nothing was recorded.',
          });
        }
        if (await deps.writeOffExists(ctx.tenantId, writeOffId)) {
          throw apiError(409, {
            code: 'write_off_already_recorded',
            whatHappened: `Write-off ${writeOffId} has already been recorded — an id is used once; a correction is a new, compensating write-off.`,
            wasItSaved: 'not_saved',
            nextSafeAction: 'Use a new write-off id. Nothing was changed.',
          });
        }

        const currency = (b['currency'] as CurrencyCode) ?? 'INR';
        const at = deps.now();
        const approval: DecidedRequest | undefined = isStr(b['approvedBy'])
          ? { id: writeOffId, subjectType: 'stock_adjustment', subjectRef: writeOffId, requestedBy: ctx.userId, branchId: ctx.branchId, value: null, status: 'approved', decidedBy: b['approvedBy'] as string, reason: b['reasonCode'] as string, decidedAt: at }
          : undefined;

        // The engine runs over an ephemeral ledger + outbox: it validates the reason, the positive quantity,
        // the evidence for a material loss and the separate approver (§28), and produces the compensating
        // movement. We persist the committed write-off on its own append-only stream.
        const ledger = new Ledger(new InMemoryLedgerStore());
        const outbox = new SyncOutbox();
        let result: WrittenOff;
        try {
          result = commitWriteOff({
            id: writeOffId, productId: b['productId'] as string, locationId: b['locationId'] as string,
            qty: b['qty'] as number, uom: b['uom'] as string, lossType: b['lossType'] as LossType,
            reasonCode: b['reasonCode'] as string, value: { minor: b['valueMinor'] as number, currency },
            raisedBy: ctx.userId, at, thresholdMinor: b['thresholdMinor'] as number,
            ...(isStr(b['evidenceRef']) ? { evidenceRef: b['evidenceRef'] as string } : {}),
            ...(approval === undefined ? {} : { approval }),
          }, ledger, outbox);
        } catch (e) {
          if (e instanceof ApprovalRequiredError) {
            throw apiError(422, { code: 'write_off_needs_approval', whatHappened: `${e.message} The person who raised the loss cannot approve it (§28).`, wasItSaved: 'not_saved', nextSafeAction: 'Have a separate person approve the loss with a reason, then re-send. Nothing was recorded.' });
          }
          if (e instanceof MissingEvidenceError) {
            throw apiError(422, { code: 'write_off_needs_evidence', whatHappened: e.message, wasItSaved: 'not_saved', nextSafeAction: 'Capture a photo or witness reference for the material loss and re-send. Nothing was recorded.' });
          }
          if (e instanceof MissingReasonError || e instanceof InvalidWriteOffError) {
            throw apiError(400, { code: 'invalid_write_off', whatHappened: e.message, wasItSaved: 'not_saved', nextSafeAction: 'Correct the write-off and re-send. Nothing was recorded.' });
          }
          throw e;
        }

        const rec: StoredWriteOff = {
          id: writeOffId, productId: b['productId'] as string, locationId: b['locationId'] as string,
          lossType: result.lossType, qtyRemoved: result.qtyRemoved, uom: b['uom'] as string,
          valueMinor: result.value.minor, currency, reasonCode: b['reasonCode'] as string,
          requiredApproval: result.requiredApproval, evidenceRef: result.evidenceRef,
          raisedBy: ctx.userId, approvedBy: isStr(b['approvedBy']) ? (b['approvedBy'] as string) : null, at,
        };
        await deps.recordWriteOff(ctx.tenantId, rec);
        return { status: 201, body: { id: writeOffId, lossType: rec.lossType, qtyRemoved: rec.qtyRemoved, valueMinor: rec.valueMinor, requiredApproval: rec.requiredApproval, evidenceRef: rec.evidenceRef } };
      },
    },
    {
      // The committed write-offs — the review surface reads these. ?locationId= / ?productId= narrow it.
      api: 'API-04', method: 'GET', path: '/v1/inventory/write-offs',
      permission: 'waste.view',
      handler: async (ctx) => {
        const locationId = ctx.query['locationId'];
        const productId = ctx.query['productId'];
        const all = await deps.writeOffs(ctx.tenantId);
        const filtered = all.filter((r) =>
          (locationId === undefined || r.locationId === locationId)
          && (productId === undefined || r.productId === productId));
        const totalLossMinor = filtered.reduce((s, r) => s + Math.abs(r.valueMinor), 0);
        return { status: 200, body: { count: filtered.length, totalLossMinor, writeOffs: filtered, asAt: deps.now() } };
      },
    },
  ];
}
