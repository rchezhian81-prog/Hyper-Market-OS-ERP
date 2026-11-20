// C-7 (15 Nov pilot audit · M03-FR-02 · batch 20d · hard rules 2, 6, 10 · P-01): a wrongly keyed barcode can be taken off
// the item it was keyed on, or moved to the right item — never on one person's word.
//
//   • Proposed through the OB-773 catalogue-change engine (POST /v1/catalogue/changes, change `barcode_remove` or
//     `barcode_move`, `catalogue.change.propose`): head office checks it now and says what it would do (the before and
//     after); a SECOND person approves it on Approvals (the owner — or, when the owner proposed it himself, the accountant,
//     the OB-613 pattern). Only then does head office make it, through the two routes below, which refuse a direct call.
//   • Append-only (hard rule 2): the register gets a `BarcodeReleased` record (and, for a move, a new `BarcodeAssigned` in the
//     same batch); the old link is never overwritten and stays in the item's barcode history with who proposed it, who
//     approved it, when and why. Bills already made are records of what was sold and are never touched.
//   • The tills get the new mapping with their next catalogue pack (the pack is built from the codes standing now), never in
//     the middle of a bill; a till that is offline keeps selling with the mapping it holds (P-01). A sale that scanned a code
//     which now names another item (or no item) is raised at head office as `barcode_changed_since_the_tills_pack`
//     (services/pos/src/sale-intake.ts) — a visible exception, never a silent wrong sale (hard rule 10).
//   • Refused in plain words: a code that is not on the item; a move to the item that already has it (or to an item head
//     office does not hold); taking the ONLY barcode off an item unless the person ticks that it may be left with none
//     (decided under OB-801 · OB-900: allowed, with the warning carried to the approver).
//
// No AI is involved (hard rule 5). Tests: tests/unit/c7-*.test.ts, tests/integration/c7-*.test.ts, tests/e2e/c7-*.e2e.ts.

import { InMemoryEventStore, type EventStore, ConcurrencyConflictError } from '../../../packages/persistence/src/event-store';
import type { AuditEntry } from '../../../packages/audit/src/index';
import type { BarcodeAssignment } from '../../../packages/product/src/index';
import { apiError, type ApiError, type Route, type RequestContext } from '../../kernel/src/index';
import { catalogueChangeBeingMade } from '../../identity/src/approval-requests';
import type { BarcodeLinkEvent } from '../../catalogue/src/barcodes';
import { barcodeAdapter, productMasterAdapter, approvalRequestsAdapter } from './adapters';

type Recorder = (tenantId: string, entry: AuditEntry) => Promise<unknown> | void;
export type BarcodeAction = 'remove' | 'move';

/** What head office found when it judged a removal or a move — the words the owner reads, and what it would do. */
export interface BarcodeChangeJudged {
  readonly action: BarcodeAction;
  readonly code: string;
  readonly productId: string;
  readonly productName: string;
  readonly toProductId?: string;
  readonly toProductName?: string;
  /** The link standing now (its kind and level travel with a move). */
  readonly standing: BarcodeAssignment;
  /** Every code on the item now, and after the change. */
  readonly codesNow: readonly string[];
  readonly codesAfter: readonly string[];
  /** The target's codes now and after (a move). */
  readonly toCodesNow?: readonly string[];
  readonly toCodesAfter?: readonly string[];
  /** True when the item would be left with no barcode at all (allowed only when the person said so). */
  readonly leavesNoBarcode: boolean;
  /** The code's write-guard version, read before the owner (for the guarded append). */
  readonly version: number;
}

const refuse = (status: number, code: string, whatHappened: string, nextSafeAction = 'Nothing was sent and nothing changed.'): ApiError =>
  apiError(status, { code, whatHappened, wasItSaved: 'not_saved', nextSafeAction });

/**
 * Judge a removal or a move against what head office holds NOW — the same rule when it is proposed and again when it is made
 * (something may have changed in between; then it is not made, and the approver is told why).
 */
export async function judgeBarcodeChange(deps: { readonly store: EventStore; readonly now: () => string }, tenantId: string, input: {
  readonly action: BarcodeAction; readonly productId: string; readonly code: string; readonly toProductId?: string; readonly leaveWithoutBarcode?: boolean;
}): Promise<BarcodeChangeJudged> {
  const barcodes = barcodeAdapter(deps);
  const products = productMasterAdapter(deps);
  const nameOf = async (id: string): Promise<string | undefined> => (await products.product(tenantId, id))?.name;
  const { code, productId } = input;
  const productName = (await nameOf(productId)) ?? productId;
  const current = await barcodes.current!(tenantId, code);
  const standing = current.assignment;
  if (standing === undefined || standing.productId !== productId) {
    const holder = standing === undefined ? undefined : `${(await nameOf(standing.productId)) ?? standing.productId} (${standing.productId})`;
    throw refuse(422, 'barcode_not_on_this_item',
      `Barcode ${code} is not on ${productName} (${productId}). ${holder === undefined ? 'No item has this barcode now.' : `It is on ${holder}.`}`,
      'Nothing was sent and nothing changed. Open the item that has the barcode, or check the number.');
  }
  const all = await barcodes.all(tenantId);
  const codesNow = all.filter((a) => a.productId === productId).map((a) => a.code);
  const codesAfter = codesNow.filter((c) => c !== code);
  let toProductId: string | undefined;
  let toProductName: string | undefined;
  let toCodesNow: string[] | undefined;
  if (input.action === 'move') {
    toProductId = (input.toProductId ?? '').trim();
    if (toProductId === productId) {
      throw refuse(422, 'barcode_already_on_that_item', `${productName} (${productId}) already has barcode ${code}. There is nothing to move.`,
        'Nothing was sent and nothing changed. Pick the item the barcode really belongs on.');
    }
    toProductName = await nameOf(toProductId);
    if (toProductName === undefined) {
      throw refuse(422, 'no_such_item', `There is no item "${toProductId}" at head office, so barcode ${code} cannot be moved to it.`,
        'Nothing was sent and nothing changed. Pick the item from the list.');
    }
    toCodesNow = all.filter((a) => a.productId === toProductId).map((a) => a.code);
  }
  const leavesNoBarcode = codesAfter.length === 0;
  if (leavesNoBarcode && input.leaveWithoutBarcode !== true) {
    throw refuse(422, 'only_barcode_of_the_item',
      `Barcode ${code} is the only barcode on ${productName}. Without it the tills cannot sell ${productName} by scanning — only by finding it by name.`,
      'Nothing was sent and nothing changed. If that is what you want, tick "Yes, leave it with no barcode" and send again; or first give the item its right barcode.');
  }
  return {
    action: input.action, code, productId, productName, standing, codesNow, codesAfter, leavesNoBarcode, version: current.version,
    ...(toProductId === undefined ? {} : { toProductId, toProductName: toProductName!, toCodesNow: toCodesNow!, toCodesAfter: [...toCodesNow!, code] }),
  };
}

/** C-7: one line of an item's barcode history — given, removed, moved away or moved here; nothing ever erased. */
export interface BarcodeHistoryRow {
  readonly code: string;
  readonly what: 'given' | 'removed' | 'moved_away' | 'moved_here';
  readonly at: string;
  readonly kind: string;
  readonly level?: string;
  /** The other item of a move: where it went, or where it came from. */
  readonly otherProductId?: string;
  readonly proposedBy?: string;
  readonly approvedBy?: string;
  readonly reason?: string;
  readonly requestId?: string;
}

/** C-7: the history of every code that ever named `productId`, oldest first (from the register's own append-only events). */
export function barcodeHistoryOf(events: readonly BarcodeLinkEvent[], productId: string): readonly BarcodeHistoryRow[] {
  const rows: BarcodeHistoryRow[] = [];
  const standing = new Map<string, string>(); // code → the item it names now, as the events unfold
  for (let i = 0; i < events.length; i += 1) {
    const e = events[i]!;
    if (e.type === 'released') {
      const r = e.release;
      if (standing.get(r.code) === r.productId) standing.delete(r.code);
      const meta = { proposedBy: r.proposedBy, approvedBy: r.approvedBy, reason: r.reason, requestId: r.requestId };
      const level = r.level === undefined ? {} : { level: r.level };
      if (r.productId === productId) {
        rows.push(r.movedTo === undefined
          ? { code: r.code, what: 'removed', at: e.at, kind: r.kind, ...level, ...meta }
          : { code: r.code, what: 'moved_away', at: e.at, kind: r.kind, ...level, otherProductId: r.movedTo.productId, ...meta });
      } else if (r.movedTo?.productId === productId) {
        rows.push({ code: r.code, what: 'moved_here', at: e.at, kind: r.movedTo.kind, ...(r.movedTo.level === undefined ? {} : { level: r.movedTo.level }), otherProductId: r.productId, ...meta });
      }
      if (r.movedTo !== undefined) {
        standing.set(r.code, r.movedTo.productId);
        const next = events[i + 1];
        // the move's own new link (same batch), already said as "moved here"
        if (next?.type === 'assigned' && next.assignment.code === r.code && next.assignment.productId === r.movedTo.productId) i += 1;
      }
      continue;
    }
    const a = e.assignment;
    const already = standing.get(a.code) === a.productId;
    standing.set(a.code, a.productId);
    if (a.productId === productId && !already) rows.push({ code: a.code, what: 'given', at: e.at, kind: a.kind, ...(a.level === undefined ? {} : { level: a.level }) });
  }
  return rows;
}

/**
 * Wire C-7 onto the finished surface (one line in main.ts, BEFORE the OB-773 catalogue-change wiring, which finds the two
 * making routes by name): the two routes that make an APPROVED removal or move, and the item's barcode history.
 */
export function barcodeLinkChangeRoutes(surface: Route[], input: {
  readonly store: EventStore | undefined;
  readonly now: () => string;
  readonly recordAudit?: Recorder;
}): void {
  const store = input.store ?? new InMemoryEventStore();
  const { now } = input;
  const barcodes = barcodeAdapter({ store, now });
  const approvals = approvalRequestsAdapter({ store, now });

  const make = (action: BarcodeAction) => async (ctx: RequestContext) => {
    // Only as an approved catalogue change (OB-773 engine, a second person): never on one person's direct word.
    const requestId = catalogueChangeBeingMade();
    if (requestId === undefined) {
      throw apiError(403, {
        code: 'barcode_change_needs_a_second_person',
        whatHappened: `A barcode is ${action === 'remove' ? 'removed from an item' : 'moved to another item'} only as a proposal that a second person approves.`,
        wasItSaved: 'not_saved',
        nextSafeAction: 'Open the item (Product details → Barcodes and packs), press Remove or Move on the barcode and send it for approval. Nothing was changed.',
      });
    }
    const state = await approvals.approvalState(ctx.tenantId, requestId);
    const b = (ctx.body ?? {}) as Record<string, unknown>;
    const productId = (ctx.params['productId'] ?? '').trim();
    const code = (ctx.params['code'] ?? '').trim();
    for (let attempt = 0; ; attempt += 1) {
      const judged = await judgeBarcodeChange({ store, now }, ctx.tenantId, {
        action, productId, code, leaveWithoutBarcode: b['leaveWithoutBarcode'] === true,
        ...(typeof b['toProductId'] === 'string' ? { toProductId: b['toProductId'] } : {}),
      });
      const s = judged.standing;
      const release = {
        code, productId, kind: s.kind, ...(s.level === undefined ? {} : { level: s.level }),
        ...(judged.toProductId === undefined ? {} : { movedTo: { code, productId: judged.toProductId, kind: s.kind, ...(s.level === undefined ? {} : { level: s.level }) } }),
        requestId, proposedBy: state?.request.requestedBy ?? '', approvedBy: ctx.userId, reason: state?.request.reason ?? '',
      };
      try {
        await barcodes.release!(ctx.tenantId, release, ctx.idempotencyKey ?? `${requestId}-${code}`, judged.version);
      } catch (err) {
        if (err instanceof ConcurrencyConflictError && attempt < 4) continue;
        if (err instanceof ConcurrencyConflictError) {
          throw apiError(409, { code: 'barcode_changed_meanwhile', whatHappened: `Barcode ${code} kept changing while this was being made.`, wasItSaved: 'not_saved', nextSafeAction: 'Look the barcode up and propose it again. Nothing was changed.' });
        }
        throw err;
      }
      await input.recordAudit?.(ctx.tenantId, {
        actorId: ctx.userId, action: action === 'remove' ? 'catalogue.barcode.remove' : 'catalogue.barcode.move', objectType: 'product', objectId: productId,
        at: now(), origin: { tenantId: ctx.tenantId, branchId: ctx.branchId ?? null },
        before: { code, item: productId, barcodes: judged.codesNow.join(', ') },
        after: {
          code, item: judged.toProductId ?? '', barcodes: judged.codesAfter.join(', '), proposedBy: release.proposedBy, approvedBy: ctx.userId,
          ...(judged.leavesNoBarcode ? { noBarcodeLeft: 'yes' } : {}),
        },
        reason: release.reason, approvalId: requestId, correlationId: `barcode:${code}`,
      });
      return {
        status: 201,
        body: {
          barcodeChange: {
            action, code, productId, ...(judged.toProductId === undefined ? {} : { toProductId: judged.toProductId }),
            codesAfter: judged.codesAfter, leavesNoBarcode: judged.leavesNoBarcode,
            tills: 'The tills get this with their next catalogue pack, never in the middle of a bill. Bills already made are unchanged.',
          },
        },
      };
    }
  };

  surface.push(
    {
      api: 'API-02', method: 'POST', path: '/v1/catalogue/products/:productId/barcodes/:code/remove',
      permission: 'catalogue.pack.publish', idempotent: true, handler: make('remove'),
    },
    {
      api: 'API-02', method: 'POST', path: '/v1/catalogue/products/:productId/barcodes/:code/move',
      permission: 'catalogue.pack.publish', idempotent: true, handler: make('move'),
    },
    {
      // C-7: every code that ever named this item — given, removed, moved away or here — with who, when and why.
      api: 'API-02', method: 'GET', path: '/v1/catalogue/products/:productId/barcode-history',
      permission: 'catalogue.pack.read',
      handler: async (ctx) => {
        const productId = (ctx.params['productId'] ?? '').trim();
        const history = barcodeHistoryOf(await barcodes.links!(ctx.tenantId), productId);
        return { status: 200, body: { productId, history, count: history.length } };
      },
    },
  );
}
