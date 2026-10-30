// D-11 (R3, OB-141 "A") — the direct-store-delivery door check-in on head office's API. The rules are the pure engine
// `packages/receiving/src/dsd-checkin.ts`; this file owns "from where" (the order or the vendor's route sheet, the
// register) and who may act.
//
//   POST /v1/inventory/dsd-routes/:routeId                         a vendor's route sheet (what that van brings this store)
//   GET  /v1/inventory/dsd-routes
//   POST /v1/inventory/dsd-checkins/:checkInId                     the van is at the door: vendor + PO or route, driver
//   POST /v1/inventory/dsd-checkins/:checkInId/scans/:scanId        an item off the van
//   POST /v1/inventory/dsd-checkins/:checkInId/hand-backs/:handBackId  an item handed back to the driver, with its reason
//   POST /v1/inventory/dsd-checkins/:checkInId/close               the signed delivery note — no cash (OB-141)
//   POST /v1/inventory/dsd-checkins/:checkInId/synced              the whole check-in as done on the warehouse handheld
//   POST /v1/inventory/dsd-checkins/:checkInId/held/decide         a second person decides goods kept beyond the order
//   GET  /v1/inventory/dsd-checkins/:checkInId · GET /v1/inventory/dsd-checkins
//
// Append-only: every change is a new version of the check-in record, never an edit (hard rule #2). At close the goods
// kept within the order post as `received` movements once, keyed on the check-in; goods handed back are an on-spot return
// linked to the delivery's debit note `DN-DSD-<checkInId>`; goods kept beyond the order wait for a second person (§28).
//
// OB-196 "A" (owner, 18 Oct 2026, in writing, "Yes, numbered"): that debit note is NUMBERED at close from the shop's own
// gap-free debit-note series (`debit_note`, the series the supplier master issues every debit note under — DN-000001 …,
// packages/numbering), and it shows on the supplier's account statement (services/purchase/src/supplier-account.ts).

import type { Route, RequestContext } from '../../kernel/src/index';
import { apiError } from '../../kernel/src/index';
import {
  reconcileDsd, signDeliveryNote, heldNeedsSecondPerson, isDsdHandBackReason, DsdRefusedError, DSD_HAND_BACK_REASONS, dsdScanCaptureRefusal, dsdBatchKey,
  type DsdExpectedLine, type DsdScan, type DsdHandBack, type DsdReconciliation, type DsdDeliveryNote, type DsdBatchRef,
} from '../../../packages/receiving/src/dsd-checkin';
import type { AuditEntry } from '../../../packages/audit/src/index';
import type { ProductReceiptRules } from '../../../packages/receiving/src/capture';
import { assertLocationInScope, stockReadScope, type LocationBranches } from './location-scope';
import type { Movement } from './index';
import { formatNumber } from '../../../packages/numbering/src/index';

export interface DsdRouteSheet {
  readonly routeId: string;
  readonly supplierId: string;
  readonly storeId: string;
  readonly lines: readonly DsdExpectedLine[];
  readonly recordedBy: string;
  readonly recordedAt: string;
  readonly version: number;
}

export interface DsdOrderView {
  readonly poId: string;
  readonly supplierId: string;
  readonly deliverToLocationId: string | null;
  readonly status: string;
  readonly lines: readonly DsdExpectedLine[];
}

// OB-604: the round-11 `several_batches` flag is gone — a product in several batches is no longer a loss to flag: each batch is
// posted as its own movement.
export type DsdFlag = 'receiver_unknown' | 'receiver_lacks_authority' | 'order_or_route_unknown' | 'cost_unknown';

export interface DsdDebitNote {
  readonly debitNoteRef: string;
  /** OB-196: the number from the shop's own debit-note series (DN-000007), allocated once at close; null only on a bare stub. */
  readonly number: string | null;
  readonly seq: number | null;
  readonly supplierId: string;
  readonly checkInId: string;
  readonly handBackIds: readonly string[];
  /** OB-611: each line names the batch handed back when the hand-back did (a product that came in more than one batch). */
  readonly lines: readonly { readonly productId: string; readonly quantityMinor: number; readonly reason: string; readonly batch?: DsdBatchRef }[];
  /** Σ at cost; null when a line's cost is not known (said, never a zero). */
  readonly valueMinor: number | null;
  readonly raisedAt: string;
}

/** Goods kept beyond the order, waiting for a second person. OB-604: split by batch when the scans named batches. */
export interface DsdHeldLine {
  readonly productId: string;
  readonly quantityMinor: number;
  readonly batchId?: string | null;
  readonly expiry?: string | null;
  readonly manufacturedOn?: string | null;
}

export interface DsdCheckInRecord {
  readonly checkInId: string;
  readonly version: number;
  readonly supplierId: string;
  readonly storeId: string;
  readonly against: { readonly kind: 'po'; readonly poId: string } | { readonly kind: 'route'; readonly routeId: string };
  readonly driverName: string;
  readonly vehicleRef: string | null;
  readonly arrivedAt: string;
  readonly receivedBy: string;
  readonly expected: readonly DsdExpectedLine[];
  readonly scans: readonly DsdScan[];
  readonly handBacks: readonly DsdHandBack[];
  readonly status: 'open' | 'closed';
  readonly via: 'direct' | 'relayed';
  readonly flags: readonly DsdFlag[];
  readonly reconciliation: DsdReconciliation | null;
  readonly deliveryNote: DsdDeliveryNote | null;
  readonly settlement: 'supplier_bill_later';
  readonly debitNote: DsdDebitNote | null;
  readonly receivedMovementIds: readonly string[];
  readonly held: {
    readonly state: 'none' | 'pending' | 'approved' | 'rejected';
    /** OB-604: one held line per product — or, when its scans named batches, per batch (with that batch's facts). */
    readonly lines: readonly DsdHeldLine[];
    readonly valueMinor: number | null;
    readonly decidedBy: string | null; readonly decidedAt: string | null; readonly reason: string | null;
    readonly movementIds: readonly string[];
  };
  readonly closedAt: string | null;
  readonly recordedAt: string;
}

export interface DsdCheckInDeps {
  readonly now: () => string;
  readonly routeSheet: (tenantId: string, routeId: string) => Promise<DsdRouteSheet | undefined>;
  readonly routeSheets: (tenantId: string) => Promise<readonly DsdRouteSheet[]>;
  readonly recordRouteSheet: (tenantId: string, r: DsdRouteSheet) => Promise<void>;
  readonly order: (tenantId: string, poId: string) => Promise<DsdOrderView | undefined>;
  readonly supplierActive: (tenantId: string, supplierId: string) => Promise<boolean>;
  readonly checkIn: (tenantId: string, checkInId: string) => Promise<DsdCheckInRecord | undefined>;
  readonly checkIns: (tenantId: string) => Promise<readonly DsdCheckInRecord[]>;
  /** Append a new version (idempotent on checkInId + version). */
  readonly recordCheckIn: (tenantId: string, r: DsdCheckInRecord) => Promise<void>;
  /** The M08 ledger append — idempotent on the movement id. */
  readonly appendMovement: (tenantId: string, m: Movement) => Promise<void>;
  readonly permissionsOfUser: (tenantId: string, userId: string) => Promise<readonly string[] | undefined>;
  /**
   * OB-196: the next number in the shop's own gap-free `debit_note` series — the SAME series the supplier master issues
   * debit notes under, so the two never give one number twice. Called once, only when a check-in with hand-backs closes.
   */
  readonly allocateDebitNoteNumber?: (tenantId: string) => Promise<number>;
  readonly locationBranches?: LocationBranches;
  readonly recordAudit?: (tenantId: string, entry: AuditEntry) => Promise<unknown> | void;
  /**
   * B4 · OB-504 (round 11): the product's receiving rule from head office's product master — the SAME `productRule` (with the
   * PACKED fact) the goods-receipt routes and the handheld's scan route read. A packed product's door scan with no month and
   * year of manufacture is refused by name. Absent → not judged here (the deps were not given the master).
   */
  readonly productRule?: (tenantId: string, productId: string) => Promise<ProductReceiptRules | undefined> | ProductReceiptRules | undefined;
}

/** The permission a receiver needs — the same as receiving any delivery. */
export const DSD_RECEIVE_PERMISSION = 'inventory.dsd.checkin';
export const dsdDebitNoteRef = (checkInId: string): string => `DN-DSD-${checkInId}`;
/** OB-196: how a debit-note number reads — the supplier master's format (supplier-master.ts), from packages/numbering. */
export const DEBIT_NOTE_NUMBER_FORMAT = Object.freeze({ prefix: 'DN-', padTo: 6 });

const isStr = (v: unknown): v is string => typeof v === 'string' && v.trim() !== '';
const isObj = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === 'object' && !Array.isArray(v);
const posInt = (v: unknown): v is number => Number.isSafeInteger(v) && (v as number) > 0;
const isIso = (v: unknown): v is string => isStr(v) && !Number.isNaN(Date.parse(v));
const bad = (code: string, whatHappened: string): never => {
  throw apiError(400, { code, whatHappened, wasItSaved: 'not_saved', nextSafeAction: 'Correct the request and send it again. Nothing was changed.' });
};
const refuse = (status: number, code: string, whatHappened: string, nextSafeAction = 'Nothing was changed.'): never => {
  throw apiError(status, { code, whatHappened, wasItSaved: 'not_saved', nextSafeAction });
};
const fromEngine = (e: unknown): never => {
  if (e instanceof DsdRefusedError) refuse(422, e.code, e.message, e.code === 'no_cash_at_the_door' ? 'Give the driver the signed delivery note; the supplier is paid later against the bill. Nothing was saved.' : 'Correct it and try again. Nothing was saved.');
  throw e;
};

/** What head office expects at the door: the order's open lines, or the route sheet's. Unknown → undefined. */
async function expectedFor(deps: DsdCheckInDeps, tenantId: string, supplierId: string, storeId: string, against: DsdCheckInRecord['against']): Promise<readonly DsdExpectedLine[] | undefined | { refused: string }> {
  if (against.kind === 'po') {
    const po = await deps.order(tenantId, against.poId);
    if (po === undefined) return undefined;
    if (po.supplierId !== supplierId) return { refused: `Purchase order ${against.poId} is with ${po.supplierId}, not ${supplierId}.` };
    if (po.status !== 'issued') return { refused: `Purchase order ${against.poId} is ${po.status}, not issued — nothing can be received against it.` };
    if (po.deliverToLocationId !== null && po.deliverToLocationId !== storeId) {
      const branchOf = deps.locationBranches === undefined ? undefined : await deps.locationBranches(tenantId);
      if ((branchOf?.(po.deliverToLocationId) ?? po.deliverToLocationId) !== storeId) return { refused: `Purchase order ${against.poId} is for delivery to ${po.deliverToLocationId}, not ${storeId}.` };
    }
    return po.lines;
  }
  const sheet = await deps.routeSheet(tenantId, against.routeId);
  if (sheet === undefined) return undefined;
  if (sheet.supplierId !== supplierId || sheet.storeId !== storeId) return { refused: `Route sheet ${against.routeId} is ${sheet.supplierId}'s for ${sheet.storeId}, not ${supplierId}'s for ${storeId}.` };
  return sheet.lines;
}

function readAgainst(b: Record<string, unknown>): DsdCheckInRecord['against'] | undefined {
  if (isStr(b['poId']) && b['routeId'] === undefined) return { kind: 'po', poId: b['poId'].trim() };
  if (isStr(b['routeId']) && b['poId'] === undefined) return { kind: 'route', routeId: b['routeId'].trim() };
  return undefined;
}

const nextVersion = (r: DsdCheckInRecord, change: Partial<DsdCheckInRecord>, at: string): DsdCheckInRecord => ({ ...r, ...change, version: r.version + 1, recordedAt: at });

/** Close: reconcile, sign the note, post what is within the order, raise the debit note, hold the rest. */
async function close(deps: DsdCheckInDeps, tenantId: string, rec: DsdCheckInRecord, body: Record<string, unknown>, receiverId: string, at: string): Promise<DsdCheckInRecord> {
  let reconciliation: DsdReconciliation;
  let note: DsdDeliveryNote;
  try {
    reconciliation = reconcileDsd({ against: rec.against.kind, expected: rec.expected, scans: rec.scans, handBacks: rec.handBacks });
    note = signDeliveryNote({ body, reconciliation, receiverId, at });
  } catch (e) { return fromEngine(e); }
  // OB-604: one received movement per product — or, when its scans named batches, one per BATCH, each with its own batch and
  // expiry and an id derived from the check-in and the batch (never the scan order), so a replay never double-posts.
  const movements: Movement[] = reconciliation.lines.flatMap((l) => receivedParts(l).filter((part) => part.quantityMinor > 0).map((part) => ({
    movementId: dsdMovementId(rec.checkInId, l.productId, part), productId: l.productId, locationId: rec.storeId, kind: 'received' as const,
    quantityMinor: part.quantityMinor, uom: l.uom, occurredAt: at, enteredBy: receiverId,
    ...(l.unitCostMinor === null ? {} : { unitCostMinor: l.unitCostMinor }),
    ...batchOnMovement(part),
  })));
  for (const m of movements) await deps.appendMovement(tenantId, m);
  const heldLines: DsdHeldLine[] = reconciliation.lines.flatMap((l) => (l.batches === undefined
    ? (l.heldMinor > 0 ? [{ productId: l.productId, quantityMinor: l.heldMinor }] : [])
    : l.batches.filter((b) => b.heldMinor > 0).map((b) => ({ productId: l.productId, quantityMinor: b.heldMinor, batchId: b.batchId, expiry: b.expiry, manufacturedOn: b.manufacturedOn }))));
  const needsDecision = heldLines.length > 0 && heldNeedsSecondPerson(reconciliation.heldValueMinor);
  // OB-196: numbered from the shop's own series — drawn last, once everything else about the close has succeeded, so a
  // refused close never spends a number (the series stays gap-free).
  const seq = rec.handBacks.length === 0 || deps.allocateDebitNoteNumber === undefined ? null : await deps.allocateDebitNoteNumber(tenantId);
  const debitNote: DsdDebitNote | null = rec.handBacks.length === 0 ? null : {
    debitNoteRef: dsdDebitNoteRef(rec.checkInId), number: seq === null ? null : formatNumber(DEBIT_NOTE_NUMBER_FORMAT, seq), seq,
    supplierId: rec.supplierId, checkInId: rec.checkInId,
    handBackIds: rec.handBacks.map((h) => h.handBackId),
    lines: rec.handBacks.map((h) => ({ productId: h.productId, quantityMinor: h.quantityMinor, reason: h.reason, ...(h.batch === undefined ? {} : { batch: h.batch }) })),
    valueMinor: reconciliation.handedBackValueMinor, raisedAt: at,
  };
  const flags = [...rec.flags];
  if ((reconciliation.handedBackValueMinor === null || reconciliation.heldValueMinor === null) && !flags.includes('cost_unknown')) flags.push('cost_unknown');
  return nextVersion(rec, {
    status: 'closed', reconciliation, deliveryNote: note, debitNote, flags, closedAt: at,
    receivedMovementIds: movements.map((m) => m.movementId),
    held: { state: heldLines.length === 0 ? 'none' : needsDecision ? 'pending' : 'approved', lines: heldLines, valueMinor: reconciliation.heldValueMinor, decidedBy: null, decidedAt: null, reason: null, movementIds: [] },
  }, at);
}

/** OB-604: what a line receives at close — the whole line, or one part per batch (with that batch's facts). */
interface MovementPart { readonly quantityMinor: number; readonly batched: boolean; readonly batchId?: string | null; readonly expiry?: string | null; readonly manufacturedOn?: string | null }
const receivedParts = (l: DsdReconciliation['lines'][number]): readonly MovementPart[] => (l.batches === undefined
  ? [{ quantityMinor: l.receivableMinor, batched: false }]
  : l.batches.map((b) => ({ quantityMinor: b.receivableMinor, batched: true, batchId: b.batchId, expiry: b.expiry, manufacturedOn: b.manufacturedOn })));
/**
 * OB-604: the movement id — `dsd:<checkIn>:<product>` for a line that named no batch (as before), `…:batch:<key>` for a batch
 * part, `:held` added for goods a second person let in. The key is the batch's own facts (`dsdBatchKey`), so it is the same
 * on every replay.
 */
export const dsdMovementId = (checkInId: string, productId: string, part: { readonly batched?: boolean; readonly batchId?: string | null; readonly expiry?: string | null; readonly manufacturedOn?: string | null }, held = false): string =>
  `dsd:${checkInId}:${productId}${held ? ':held' : ''}${part.batched === true || part.batchId != null || part.expiry != null || part.manufacturedOn != null
    ? `:batch:${dsdBatchKey({ batchId: part.batchId ?? null, expiry: part.expiry ?? null, manufacturedOn: part.manufacturedOn ?? null })}` : ''}`;
/** The batch and expiry a received movement carries (none for a line that named no batch). */
const batchOnMovement = (part: { readonly batchId?: string | null; readonly expiry?: string | null }): { batchId?: string; expiry?: string } => ({
  ...(part.batchId == null ? {} : { batchId: part.batchId }),
  ...(part.expiry == null ? {} : { expiry: part.expiry }),
});

const optText = (v: unknown): v is string | undefined | null => v === undefined || v === null || typeof v === 'string';
function readScan(scanId: string, b: Record<string, unknown>, at: string): DsdScan {
  if (!isStr(b['productId']) || !posInt(b['quantityMinor']) || !optText(b['batchId']) || !optText(b['expiry']) || !optText(b['manufacturedOn'])) {
    bad('not_readable_as_a_dsd_scan', 'A scan needs { productId, quantityMinor (whole, above 0) }, and batchId, expiry (YYYY-MM-DD) and manufacturedOn (YYYY-MM) as text when given.');
  }
  return {
    scanId, productId: (b['productId'] as string).trim(), quantityMinor: b['quantityMinor'] as number, at,
    ...(isStr(b['batchId']) ? { batchId: b['batchId'].trim() } : {}),
    ...(isStr(b['expiry']) ? { expiry: b['expiry'].trim() } : {}),
    ...(isStr(b['manufacturedOn']) ? { manufacturedOn: b['manufacturedOn'].trim() } : {}),
  };
}

/**
 * B4 · OB-504 (round 11) · OB-605: judge door scans by the product master's packed and batch-tracked rules — the same rule (capture.ts) every receiving
 * path uses, read from head office's own master (never the phone's word). Refused by name (422); nothing is saved.
 */
async function judgeScans(deps: DsdCheckInDeps, tenantId: string, scans: readonly DsdScan[], nextSafeAction: string): Promise<void> {
  for (const scan of scans) {
    const rule = deps.productRule === undefined ? undefined : await deps.productRule(tenantId, scan.productId);
    // OB-605: and a BATCH-TRACKED product's scan needs its batch and expiry — the goods receipt's own rule, per scan.
    const refusal = dsdScanCaptureRefusal(scan, rule?.packaged === true, rule?.batchTracked === true);
    if (refusal !== undefined) refuse(422, refusal.code, refusal.message, nextSafeAction);
  }
}
/** OB-611: the batch a hand-back names — `{ batchId, expiry, manufacturedOn }` (each text, or null where none was scanned). */
function readBatchRef(v: unknown): DsdBatchRef | undefined | 'unreadable' {
  if (v === undefined || v === null) return undefined;
  if (!isObj(v) || !optText(v['batchId']) || !optText(v['expiry']) || !optText(v['manufacturedOn'])) return 'unreadable';
  const text = (x: unknown): string | null => (isStr(x) ? x.trim() : null);
  return { batchId: text(v['batchId']), expiry: text(v['expiry']), manufacturedOn: text(v['manufacturedOn']) };
}
function readHandBack(handBackId: string, b: Record<string, unknown>, at: string): DsdHandBack {
  const batch = readBatchRef(b['batch']);
  if (!isStr(b['productId']) || !posInt(b['quantityMinor']) || !isDsdHandBackReason(b['reason']) || batch === 'unreadable') bad('not_readable_as_a_dsd_hand_back', `A hand-back needs { productId, quantityMinor (whole, above 0), reason: ${DSD_HAND_BACK_REASONS.join(' / ')} }, and — for a product that came in more than one batch — batch: { batchId, expiry, manufacturedOn } as scanned (OB-611).`);
  return {
    handBackId, productId: (b['productId'] as string).trim(), quantityMinor: b['quantityMinor'] as number, reason: b['reason'] as DsdHandBack['reason'], note: isStr(b['note']) ? b['note'].trim() : null, at,
    ...(batch === undefined ? {} : { batch: batch as DsdBatchRef }),
  };
}

async function openRecord(deps: DsdCheckInDeps, ctx: RequestContext, checkInId: string, b: Record<string, unknown>, via: 'direct' | 'relayed', receivedBy: string, at: string): Promise<DsdCheckInRecord> {
  const against = readAgainst(b);
  if (!isStr(b['supplierId']) || !isStr(b['storeId']) || against === undefined || !isStr(b['driverName']) || !isIso(b['arrivedAt'])) {
    bad('not_readable_as_a_dsd_check_in', 'A check-in needs { supplierId, storeId, poId OR routeId (exactly one), driverName, arrivedAt }.');
  }
  const supplierId = (b['supplierId'] as string).trim(); const storeId = (b['storeId'] as string).trim();
  await assertLocationInScope(ctx, storeId, deps.locationBranches);
  const flags: DsdFlag[] = [];
  if (!(await deps.supplierActive(ctx.tenantId, supplierId))) {
    if (via === 'direct') refuse(422, 'supplier_not_approved', `${supplierId} is not an approved supplier in the supplier master — a delivery is checked in only against an approved vendor.`);
    flags.push('order_or_route_unknown');
  }
  const exp = await expectedFor(deps, ctx.tenantId, supplierId, storeId, against!);
  let expected: readonly DsdExpectedLine[] = [];
  if (exp === undefined || 'refused' in exp) {
    if (via === 'direct') {
      refuse(exp === undefined ? 404 : 422, exp === undefined ? 'order_or_route_unknown' : 'order_or_route_does_not_match', exp === undefined ? `Head office holds no ${against!.kind === 'po' ? `purchase order ${against!.kind === 'po' ? against!.poId : ''}` : `route sheet ${against!.kind === 'route' ? against!.routeId : ''}`}.` : exp.refused);
    }
    if (!flags.includes('order_or_route_unknown')) flags.push('order_or_route_unknown'); // relayed: the van came; kept goods are all held for a person
  } else expected = exp;
  return {
    checkInId, version: 1, supplierId, storeId, against: against!, driverName: (b['driverName'] as string).trim(),
    vehicleRef: isStr(b['vehicleRef']) ? b['vehicleRef'].trim() : null, arrivedAt: b['arrivedAt'] as string, receivedBy,
    expected, scans: [], handBacks: [], status: 'open', via, flags, reconciliation: null, deliveryNote: null,
    settlement: 'supplier_bill_later', debitNote: null, receivedMovementIds: [],
    held: { state: 'none', lines: [], valueMinor: null, decidedBy: null, decidedAt: null, reason: null, movementIds: [] },
    closedAt: null, recordedAt: at,
  };
}

const audit = async (deps: DsdCheckInDeps, ctx: RequestContext, action: string, rec: DsdCheckInRecord, after: Record<string, string>, actorId = ctx.userId): Promise<void> => {
  await deps.recordAudit?.(ctx.tenantId, {
    actorId, action, objectType: 'dsd_check_in', objectId: rec.checkInId, at: rec.recordedAt,
    origin: { tenantId: ctx.tenantId, branchId: ctx.branchId ?? null }, before: null,
    after: { supplierId: rec.supplierId, storeId: rec.storeId, status: rec.status, version: String(rec.version), ...after },
    reason: action, correlationId: rec.checkInId,
  });
};

const present = (r: DsdCheckInRecord) => ({ ...r, cashAtTheDoor: 'none — paid later as a supplier bill (OB-141)' });

export function dsdCheckInRoutes(deps: DsdCheckInDeps): readonly Route[] {
  const openOne = async (ctx: RequestContext): Promise<DsdCheckInRecord> => {
    const id = (ctx.params['checkInId'] ?? '').trim();
    const rec = await deps.checkIn(ctx.tenantId, id);
    if (rec === undefined) return refuse(404, 'dsd_check_in_unknown', `No door check-in ${id} is on file.`);
    await assertLocationInScope(ctx, rec.storeId, deps.locationBranches);
    if (rec.status !== 'open') return refuse(409, 'dsd_check_in_closed', `Check-in ${id} was closed at ${rec.closedAt ?? '?'} with its signed delivery note; nothing more can be scanned or handed back.`);
    return rec;
  };
  return [
    {
      api: 'API-04', method: 'POST', path: '/v1/inventory/dsd-routes/:routeId',
      permission: 'inventory.dsd.route.manage', idempotent: true,
      handler: async (ctx) => {
        const routeId = (ctx.params['routeId'] ?? '').trim();
        const b = (ctx.body ?? {}) as Record<string, unknown>;
        const lines = b['lines'];
        if (routeId === '' || !isStr(b['supplierId']) || !isStr(b['storeId']) || !Array.isArray(lines) || lines.length === 0
          || !lines.every((l) => isObj(l) && isStr(l['productId']) && posInt(l['expectedMinor']) && (l['unitCostMinor'] === undefined || posInt(l['unitCostMinor'])))) {
          bad('not_readable_as_a_route_sheet', 'A route sheet needs { supplierId, storeId, lines: [{ productId, expectedMinor, unitCostMinor? }] }.');
        }
        await assertLocationInScope(ctx, b['storeId'] as string, deps.locationBranches);
        if (!(await deps.supplierActive(ctx.tenantId, b['supplierId'] as string))) refuse(422, 'supplier_not_approved', `${String(b['supplierId'])} is not an approved supplier.`);
        const prior = await deps.routeSheet(ctx.tenantId, routeId);
        const sheet: DsdRouteSheet = {
          routeId, supplierId: (b['supplierId'] as string).trim(), storeId: (b['storeId'] as string).trim(),
          lines: (lines as Record<string, unknown>[]).map((l) => ({ productId: (l['productId'] as string).trim(), expectedMinor: l['expectedMinor'] as number, ...(l['unitCostMinor'] === undefined ? {} : { unitCostMinor: l['unitCostMinor'] as number }), uom: isStr(l['uom']) ? (l['uom'] as string) : 'ea' })),
          recordedBy: ctx.userId, recordedAt: deps.now(), version: (prior?.version ?? 0) + 1,
        };
        await deps.recordRouteSheet(ctx.tenantId, sheet);
        return { status: 201, body: { routeSheet: sheet } };
      },
    },
    {
      api: 'API-04', method: 'GET', path: '/v1/inventory/dsd-routes',
      permission: 'inventory.availability.read',
      handler: async (ctx) => {
        const scope = await stockReadScope(ctx, deps.locationBranches);
        return { status: 200, body: { routeSheets: (await deps.routeSheets(ctx.tenantId)).filter((r) => scope.covers(r.storeId)), asAt: deps.now() } };
      },
    },
    {
      api: 'API-04', method: 'POST', path: '/v1/inventory/dsd-checkins/:checkInId',
      permission: DSD_RECEIVE_PERMISSION, idempotent: true,
      handler: async (ctx) => {
        const checkInId = (ctx.params['checkInId'] ?? '').trim();
        if (checkInId === '') bad('not_readable_as_a_dsd_check_in', 'The check-in id is in the path.');
        const prior = await deps.checkIn(ctx.tenantId, checkInId);
        if (prior !== undefined) return { status: 200, body: { checkIn: present(prior), alreadyOpen: true } };
        const rec = await openRecord(deps, ctx, checkInId, (ctx.body ?? {}) as Record<string, unknown>, 'direct', ctx.userId, deps.now());
        await deps.recordCheckIn(ctx.tenantId, rec);
        await audit(deps, ctx, 'dsd.check_in.open', rec, { against: rec.against.kind === 'po' ? `po:${rec.against.poId}` : `route:${rec.against.routeId}`, driverName: rec.driverName });
        return { status: 201, body: { checkIn: present(rec) } };
      },
    },
    {
      api: 'API-04', method: 'POST', path: '/v1/inventory/dsd-checkins/:checkInId/scans/:scanId',
      permission: DSD_RECEIVE_PERMISSION, idempotent: true,
      handler: async (ctx) => {
        const rec = await openOne(ctx);
        const scanId = (ctx.params['scanId'] ?? '').trim();
        if (rec.scans.some((s) => s.scanId === scanId)) return { status: 200, body: { checkIn: present(rec), alreadyScanned: true } };
        const at = deps.now();
        const scan = readScan(scanId, (ctx.body ?? {}) as Record<string, unknown>, at);
        await judgeScans(deps, ctx.tenantId, [scan], 'Give what the pack prints (its batch, expiry and month of manufacture) and scan the item again. Nothing was saved.');
        const next = nextVersion(rec, { scans: [...rec.scans, scan] }, at);
        await deps.recordCheckIn(ctx.tenantId, next);
        const live = reconcileDsd({ against: next.against.kind, expected: next.expected, scans: next.scans, handBacks: next.handBacks });
        return { status: 201, body: { checkIn: present(next), discrepancies: live.discrepancies } };
      },
    },
    {
      api: 'API-04', method: 'POST', path: '/v1/inventory/dsd-checkins/:checkInId/hand-backs/:handBackId',
      permission: DSD_RECEIVE_PERMISSION, idempotent: true,
      handler: async (ctx) => {
        const rec = await openOne(ctx);
        const handBackId = (ctx.params['handBackId'] ?? '').trim();
        if (rec.handBacks.some((h) => h.handBackId === handBackId)) return { status: 200, body: { checkIn: present(rec), alreadyHandedBack: true } };
        const at = deps.now();
        const hb = readHandBack(handBackId, (ctx.body ?? {}) as Record<string, unknown>, at);
        try { reconcileDsd({ against: rec.against.kind, expected: rec.expected, scans: rec.scans, handBacks: [...rec.handBacks, hb] }); } catch (e) { fromEngine(e); }
        const next = nextVersion(rec, { handBacks: [...rec.handBacks, hb] }, at);
        await deps.recordCheckIn(ctx.tenantId, next);
        return { status: 201, body: { checkIn: present(next), debitNoteRef: dsdDebitNoteRef(rec.checkInId) } };
      },
    },
    {
      api: 'API-04', method: 'POST', path: '/v1/inventory/dsd-checkins/:checkInId/close',
      permission: DSD_RECEIVE_PERMISSION, idempotent: true,
      handler: async (ctx) => {
        const id = (ctx.params['checkInId'] ?? '').trim();
        const existing = await deps.checkIn(ctx.tenantId, id);
        if (existing?.status === 'closed') return { status: 200, body: { checkIn: present(existing), alreadyClosed: true } };
        const rec = await openOne(ctx);
        const done = await close(deps, ctx.tenantId, rec, (ctx.body ?? {}) as Record<string, unknown>, ctx.userId, deps.now());
        await deps.recordCheckIn(ctx.tenantId, done);
        await audit(deps, ctx, 'dsd.check_in.close', done, { noteRef: done.deliveryNote!.noteRef, driverSignedName: done.deliveryNote!.driverSignedName, debitNoteRef: done.debitNote?.debitNoteRef ?? '', debitNoteNumber: done.debitNote?.number ?? '', held: done.held.state, discrepancies: String(done.reconciliation!.discrepancies.length) });
        return { status: 200, body: { checkIn: present(done) } };
      },
    },
    {
      // The whole check-in as done on the warehouse handheld, relayed by the store computer. The RECEIVER named is
      // re-verified from their own grants and record-and-flagged; the expected lines are head office's own.
      api: 'API-04', method: 'POST', path: '/v1/inventory/dsd-checkins/:checkInId/synced',
      permission: 'inventory.dsd.sync', idempotent: true,
      handler: async (ctx) => {
        const checkInId = (ctx.params['checkInId'] ?? '').trim();
        const b = (ctx.body ?? {}) as Record<string, unknown>;
        if (checkInId === '' || b['checkInId'] !== checkInId || !isStr(b['receivedBy']) || !Array.isArray(b['scans']) || !Array.isArray(b['handBacks']) || !isIso(b['at'])) {
          bad('not_readable_as_a_relayed_dsd_check_in', 'A relayed check-in needs the checkInId matching the path, receivedBy, scans[], handBacks[], at, and the check-in and delivery-note fields.');
        }
        const prior = await deps.checkIn(ctx.tenantId, checkInId);
        if (prior !== undefined) return { status: 200, body: { checkIn: present(prior), alreadyRecorded: true } };
        const receivedBy = (b['receivedBy'] as string).trim();
        const at = b['at'] as string;
        const opened = await openRecord(deps, ctx, checkInId, b, 'relayed', receivedBy, at);
        const perms = await deps.permissionsOfUser(ctx.tenantId, receivedBy);
        const flags = [...opened.flags];
        if (perms === undefined) flags.push('receiver_unknown');
        else if (!perms.includes(DSD_RECEIVE_PERMISSION)) flags.push('receiver_lacks_authority');
        const scans = (b['scans'] as unknown[]).map((s, i) => readScan(isObj(s) && isStr(s['scanId']) ? s['scanId'] : `s${i}`, isObj(s) ? s : {}, isObj(s) && isIso(s['at']) ? s['at'] : at));
        // B4 · OB-504 (round 11): a packed product's scan with no month of manufacture is refused by name (422) — nothing is
        // posted, and the store computer keeps the record as a dead letter for a person (hard rule #6).
        await judgeScans(deps, ctx.tenantId, scans, 'Nothing was posted. The check-in stays on the store computer for a person: the item needs what its pack prints (its batch, expiry or month of manufacture — OB-504 · OB-605).');
        const handBacks = (b['handBacks'] as unknown[]).map((h, i) => readHandBack(isObj(h) && isStr(h['handBackId']) ? h['handBackId'] : `h${i}`, isObj(h) ? h : {}, isObj(h) && isIso(h['at']) ? h['at'] : at));
        // A receiver the grants do not back keeps nothing on their word: everything kept is held for a person (§28) —
        // judged as if there were no order, so nothing is receivable without a second person. The record keeps the real one.
        const unbacked = flags.includes('receiver_unknown') || flags.includes('receiver_lacks_authority');
        const judged: DsdCheckInRecord = { ...opened, scans, handBacks, flags, ...(unbacked ? { against: { kind: 'route', routeId: 'receiver-not-backed' } as const } : {}) };
        const done = await close(deps, ctx.tenantId, judged, b, receivedBy, deps.now());
        const kept: DsdCheckInRecord = { ...done, against: opened.against };
        await deps.recordCheckIn(ctx.tenantId, kept);
        await audit(deps, ctx, 'dsd.check_in.synced', kept, { relayedBy: ctx.userId, flags: kept.flags.join(','), held: kept.held.state, debitNoteNumber: kept.debitNote?.number ?? '' }, receivedBy);
        return { status: 201, body: { checkIn: present(kept), flags: kept.flags } };
      },
    },
    {
      api: 'API-04', method: 'POST', path: '/v1/inventory/dsd-checkins/:checkInId/held/decide',
      permission: 'inventory.adjustment.approve', idempotent: true,
      handler: async (ctx) => {
        const id = (ctx.params['checkInId'] ?? '').trim();
        const b = (ctx.body ?? {}) as Record<string, unknown>;
        if ((b['decision'] !== 'approved' && b['decision'] !== 'rejected') || !isStr(b['reason'])) bad('not_readable_as_a_dsd_decision', 'A decision needs { decision: "approved" | "rejected", reason }.');
        const rec = await deps.checkIn(ctx.tenantId, id);
        if (rec === undefined) return refuse(404, 'dsd_check_in_unknown', `No door check-in ${id} is on file.`);
        await assertLocationInScope(ctx, rec.storeId, deps.locationBranches);
        if (rec.held.state === 'none') return refuse(409, 'nothing_held', `Check-in ${id} holds nothing for a decision.`);
        if (rec.held.state !== 'pending') {
          if ((rec.held.state === 'approved') === (b['decision'] === 'approved')) return { status: 200, body: { checkIn: present(rec), alreadyDecided: true } };
          return refuse(409, 'dsd_held_already_decided', `The held goods on ${id} were already ${rec.held.state} by ${rec.held.decidedBy ?? '?'}.`);
        }
        if (rec.receivedBy === ctx.userId) return refuse(422, 'self_approval', `${ctx.userId} received this delivery and cannot approve keeping goods beyond the order (§28).`, 'A different person with approval authority must decide it. Nothing was changed.');
        const at = deps.now();
        const line = (p: string) => rec.reconciliation?.lines.find((l) => l.productId === p);
        const movements: Movement[] = b['decision'] === 'approved' ? rec.held.lines.map((h) => ({
          // OB-604: one movement per held line — per batch when the line names one, with its own id, batch and expiry.
          movementId: dsdMovementId(rec.checkInId, h.productId, { batched: 'batchId' in h || 'expiry' in h || 'manufacturedOn' in h, ...h }, true), productId: h.productId, locationId: rec.storeId, kind: 'received' as const,
          quantityMinor: h.quantityMinor, uom: line(h.productId)?.uom ?? 'ea', occurredAt: at, enteredBy: rec.receivedBy, approvedBy: ctx.userId,
          ...(line(h.productId)?.unitCostMinor == null ? {} : { unitCostMinor: line(h.productId)!.unitCostMinor! }),
          ...batchOnMovement(h),
        })) : [];
        for (const m of movements) await deps.appendMovement(ctx.tenantId, m);
        const next = nextVersion(rec, { held: { ...rec.held, state: b['decision'] as 'approved' | 'rejected', decidedBy: ctx.userId, decidedAt: at, reason: (b['reason'] as string).trim(), movementIds: movements.map((m) => m.movementId) } }, at);
        await deps.recordCheckIn(ctx.tenantId, next);
        await audit(deps, ctx, `dsd.held.${String(b['decision'])}`, next, { movementIds: movements.map((m) => m.movementId).join(','), receivedBy: rec.receivedBy });
        return { status: 200, body: { checkIn: present(next), ...(b['decision'] === 'rejected' ? { toReturnToSupplier: rec.held.lines } : {}) } };
      },
    },
    {
      api: 'API-04', method: 'GET', path: '/v1/inventory/dsd-checkins/:checkInId',
      permission: 'inventory.availability.read',
      handler: async (ctx) => {
        const id = (ctx.params['checkInId'] ?? '').trim();
        const rec = await deps.checkIn(ctx.tenantId, id);
        if (rec === undefined) return refuse(404, 'dsd_check_in_unknown', `No door check-in ${id} is on file.`);
        await assertLocationInScope(ctx, rec.storeId, deps.locationBranches);
        const live = rec.reconciliation ?? reconcileDsd({ against: rec.against.kind, expected: rec.expected, scans: rec.scans, handBacks: rec.handBacks });
        return { status: 200, body: { checkIn: present(rec), reconciliation: live } };
      },
    },
    {
      api: 'API-04', method: 'GET', path: '/v1/inventory/dsd-checkins',
      permission: 'inventory.availability.read',
      handler: async (ctx) => {
        const scope = await stockReadScope(ctx, deps.locationBranches);
        const supplierId = ctx.query['supplierId'];
        const list = (await deps.checkIns(ctx.tenantId)).filter((r) => scope.covers(r.storeId) && (supplierId === undefined || r.supplierId === supplierId));
        return {
          status: 200,
          body: {
            checkIns: list.map(present), open: list.filter((r) => r.status === 'open').length,
            heldForDecision: list.filter((r) => r.held.state === 'pending').length,
            debitNotes: list.flatMap((r) => (r.debitNote === null ? [] : [r.debitNote])), asAt: deps.now(),
          },
        };
      },
    },
  ];
}
