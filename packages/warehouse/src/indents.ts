// The FLOOR INDENT — the sales floor asks the back store for stock, and the request lives as ONE record from the ask
// to the shelf (WF-06 replenishment · WF-07 stock transfer · M09-FR-03 allocation · M04-FR-03 replenishment tasks ·
// M08-FR-02 in-transit · §28 · P-03 · P-08 · hard rule #2 — SP-8, audit finding F08).
//
// Until this slice the pieces existed and nothing joined them: a refill task was CALCULATED from the planogram and never
// kept; a transfer moved stock but knew nothing of who asked or how much is still owed; a shelf count saved on the
// merchandising screen only mutated page data. The owner named the whole chain — indent → approval → back-store
// allocation → scan issue → in transit → independent floor receipt → shelf availability → sale — and asked that
// requested, issued, received and outstanding be recorded SEPARATELY, that partial issue / partial receipt / wrong item /
// cancellation / floor→back-store return each have a place, and that issue and receipt never create stock twice.
//
// This engine is the pure lifecycle. It moves NO stock itself: every issue and every receipt is a TRANSFER between two
// places head office knows (the back store and the floor), run through the existing `dispatchTransfer` /
// `receiveTransfer` engines so stock leaves the back store exactly once at issue, sits IN TRANSIT at the floor (visible,
// not sellable) and becomes on-hand at the floor exactly once at the receipt — a dispatch is never a receipt. The indent
// only remembers who asked for what, who allocated what, which issues went and which arrived, and says the difference.
//
// Four people, four separations (§28): the requester cannot approve; the requester cannot issue to themselves; the
// issuer cannot receive their own issue; the returner cannot accept their own return. Each is the engine's own check so
// every surface that drives it — a route, a screen, a handheld relay — gets the same refusal.

import type { Money } from '../../contracts/src/money';
import { judgeShortfallResolution, type Transfer, type ShortfallLine, type FoundLine, type ShortfallResolution, type ShortfallResolutionLine } from './transfers';

export type { ShortfallLine, FoundLine, ShortfallResolution, ShortfallResolutionLine };

export type IndentState =
  | 'requested'   // the floor asked; nobody has decided
  | 'approved'    // allocated by a different person; nothing issued yet
  | 'issuing'     // at least one issue has gone; more is still owed
  | 'issued'      // everything allocated (or everything that will be) has gone; receipts may still be due
  | 'received'    // every issue has been received at the floor; nothing owed, nothing on the trolley
  | 'rejected'    // refused by the approver — nothing moves
  | 'cancelled';  // withdrawn before anything was issued — nothing moves

export interface IndentLine {
  readonly productId: string;
  /** How many the floor asked for, in the UOM's minor units. */
  readonly requestedMinor: number;
  readonly uom: string;
}

/** What the approver allocated per line, against what the back store held at that moment (said, never assumed). */
export interface IndentAllocation {
  readonly productId: string;
  readonly allocatedMinor: number;
  /** Head office's own on-hand at the back store when the allocation was made — `null` when it could not be read. */
  readonly availableMinor: number | null;
}

export interface IssueLine {
  readonly productId: string;
  readonly batchId: string | null;
  readonly quantityMinor: number;
  /** SP-8c: the back-store bin the handheld took it from — so head office lowers the SAME bin in the same write. Absent on a desk issue. */
  readonly binId?: string | null;
}

export interface ReceivedLine {
  readonly productId: string;
  readonly batchId: string | null;
  /** The GOOD units counted — what the shelf can sell. */
  readonly quantityMinor: number;
  /** SP-8c: units that ARRIVED damaged — off the trolley, never on the shelf: written off at the floor as a valued exception. */
  readonly damagedMinor?: number;
}


/** SP-8c: units that arrived DAMAGED — they left transit (they are in the building) and were written off at the floor at the
 *  cost they left with. A valued exception with an owner, never silently on the shelf and never silently gone. */
export interface DamagedLine {
  readonly productId: string;
  readonly batchId: string | null;
  readonly quantityMinor: number;
  readonly valueMinor: number;
}

/** One ISSUE from the back store — one transfer, dispatched at issue, received independently at the floor. */
export interface IndentIssue {
  readonly issueId: string;
  readonly transferId: string;
  readonly issuedBy: string;
  readonly issuedAt: string;
  readonly lines: readonly IssueLine[];
  readonly state: 'in_transit' | 'received';
  readonly receivedBy?: string;
  readonly receivedAt?: string;
  readonly received?: readonly ReceivedLine[];
  /** Dispatched and not arrived — a VALUED exception the ledger carries; never absorbed here. */
  readonly shortfall?: readonly ShortfallLine[];
  /** SP-8c: arrived damaged — written off at the floor, valued; on the register beside the shortfall. */
  readonly damaged?: readonly DamagedLine[];
  /** Batch 2: how the shortfall was RESOLVED — by whom, why, what was found and what was lost. Absent while it is open. */
  readonly shortfallResolution?: ShortfallResolution;
  /** SP-8b: what head office found when a RELAYED receipt named its receiver — a breach is flagged, never silently applied. */
  readonly governanceFlags?: readonly string[];
  /** SP-8b: the relay (the store box) that carried the receipt, beside — never instead of — the receiver. */
  readonly relayed?: RelayedBy;
}

/** SP-8b: a step that arrived through the store box's device queue — who relayed it, from which surface, for which store. */
export interface RelayedBy {
  readonly relayedBy: string;
  readonly source: string;
  readonly storeId: string | null;
}

/** A floor → back-store RETURN of stock the indent brought: asked for by the floor, accepted (dispatched + received in one
 *  step, a trolley walk) by a different person at the back store. */
export interface IndentReturn {
  readonly returnId: string;
  readonly transferId: string;
  readonly returnedBy: string;
  readonly requestedAt: string;
  readonly reason: string;
  readonly lines: readonly IssueLine[];
  readonly state: 'requested' | 'accepted';
  readonly acceptedBy?: string;
  readonly acceptedAt?: string;
  readonly received?: readonly ReceivedLine[];
  readonly shortfall?: readonly ShortfallLine[];
}

export const INDENT_FLAGS = Object.freeze([
  'short_stock',          // at approval the back store held less than the floor asked for, on at least one line
  'short_allocated',      // the approver allocated less than requested, on at least one line
  'partial_issue',        // an issue went with some of the allocation still owed
  'partial_receipt',      // an issue arrived short (a valued shortfall is on the exceptions read)
  'arrived_damaged',      // SP-8c: some of an issue arrived damaged — written off at the floor, valued, never on the shelf
  'cancelled_remainder',  // the unissued remainder was withdrawn after something had already gone
] as const);
export type IndentFlag = (typeof INDENT_FLAGS)[number];

export interface FloorIndent {
  readonly indentId: string;
  /** The back store (where the stock is drawn from). */
  readonly fromLocationId: string;
  /** The floor (where it becomes shelf availability — the place the till sells from). */
  readonly toLocationId: string;
  readonly lines: readonly IndentLine[];
  readonly reason: string | null;
  readonly state: IndentState;
  readonly requestedBy: string;
  readonly requestedAt: string;
  readonly approvedBy?: string;
  readonly approvedAt?: string;
  readonly approvalReason?: string | null;
  readonly allocations?: readonly IndentAllocation[];
  readonly rejectedBy?: string;
  readonly rejectedAt?: string;
  readonly rejectionReason?: string;
  readonly cancelledBy?: string;
  readonly cancelledAt?: string;
  readonly cancelReason?: string;
  /** True once the unissued remainder was withdrawn — nothing more will be issued against this indent. */
  readonly remainderCancelled: boolean;
  readonly issues: readonly IndentIssue[];
  readonly returns: readonly IndentReturn[];
  readonly flags: readonly IndentFlag[];
  /** SP-8b: what head office found when a RELAYED request named its requester — flagged, never silently trusted. */
  readonly governanceFlags?: readonly string[];
  /** SP-8b: the relay that carried the request, beside the requester. */
  readonly relayed?: RelayedBy;
}

export type IndentRefusal =
  | 'not_readable_as_an_indent' | 'same_place' | 'duplicate_product'
  | 'indent_not_requested' | 'self_approval' | 'over_allocation' | 'nothing_allocated' | 'not_on_indent'
  | 'indent_not_approved' | 'requester_cannot_issue' | 'over_issue' | 'issue_unknown' | 'issue_already_received'
  | 'issuer_cannot_receive' | 'not_on_issue' | 'indent_not_open' | 'nothing_received' | 'over_return'
  | 'return_unknown' | 'return_already_accepted' | 'returner_cannot_accept' | 'not_on_return'
  // Batch 2 — resolving a shortfall:
  | 'issue_not_received' | 'nothing_short' | 'counter_cannot_resolve' | 'issuer_cannot_resolve' | 'more_found_than_missing'
  | 'not_on_shortfall' | 'shortfall_already_resolved';

export class IndentRefusedError extends Error {
  constructor(
    public readonly indentId: string,
    public readonly code: IndentRefusal,
    public readonly why: string,
  ) {
    super(`Indent "${indentId}" refused: ${why}`);
    this.name = 'IndentRefusedError';
  }
}

const refuse = (indentId: string, code: IndentRefusal, why: string): never => { throw new IndentRefusedError(indentId, code, why); };
const isPosInt = (v: unknown): v is number => Number.isInteger(v) && (v as number) > 0;
const isNonNegInt = (v: unknown): v is number => Number.isInteger(v) && (v as number) >= 0;
const withFlag = (flags: readonly IndentFlag[], flag: IndentFlag): readonly IndentFlag[] => (flags.includes(flag) ? flags : [...flags, flag]);
const sum = (ns: readonly number[]): number => ns.reduce((s, n) => s + n, 0);

// ── the figures every reader wants, derived — never stored twice ─────────────────────────────────────────────

export interface IndentLineTotals {
  readonly productId: string;
  readonly uom: string;
  readonly requestedMinor: number;
  /** Allocated by the approver; equals requested until approval says otherwise; 0 while merely requested. */
  readonly allocatedMinor: number;
  readonly issuedMinor: number;
  readonly receivedMinor: number;
  /** Issued and not yet received — on the trolley (in transit at the floor on the M08 read). */
  readonly inTransitMinor: number;
  /** Dispatched and never arrived — carried as a valued exception, never quietly lost. */
  readonly shortfallMinor: number;
  /** Batch 2: of the shortfall, what nobody has resolved yet (found or confirmed lost) — what still needs a person. */
  readonly unresolvedShortfallMinor: number;
  /** SP-8c: arrived damaged and written off at the floor — never on the shelf, never quietly lost. */
  readonly damagedMinor: number;
  /** Sent back to the back store and accepted there. */
  readonly returnedMinor: number;
  /** Still owed by the back store: allocated − issued, or 0 once the remainder is cancelled / the indent is closed. */
  readonly outstandingMinor: number;
}

export interface IndentTotals {
  readonly lines: readonly IndentLineTotals[];
  readonly requestedMinor: number;
  readonly allocatedMinor: number;
  readonly issuedMinor: number;
  readonly receivedMinor: number;
  readonly inTransitMinor: number;
  readonly shortfallMinor: number;
  readonly unresolvedShortfallMinor: number;
  readonly damagedMinor: number;
  readonly returnedMinor: number;
  readonly outstandingMinor: number;
}

const OPEN_FOR_ISSUE: readonly IndentState[] = ['approved', 'issuing'];

export function indentTotals(indent: FloorIndent): IndentTotals {
  const lines = indent.lines.map((line): IndentLineTotals => {
    const allocated = indent.allocations?.find((a) => a.productId === line.productId)?.allocatedMinor ?? 0;
    const issued = sum(indent.issues.map((i) => sum(i.lines.filter((l) => l.productId === line.productId).map((l) => l.quantityMinor))));
    const received = sum(indent.issues.map((i) => sum((i.received ?? []).filter((l) => l.productId === line.productId).map((l) => l.quantityMinor))));
    const shortfall = sum(indent.issues.map((i) => sum((i.shortfall ?? []).filter((l) => l.productId === line.productId).map((l) => l.quantityMinor))));
    const unresolved = sum(indent.issues.filter((i) => i.shortfallResolution === undefined).map((i) => sum((i.shortfall ?? []).filter((l) => l.productId === line.productId).map((l) => l.quantityMinor))));
    const damaged = sum(indent.issues.map((i) => sum((i.damaged ?? []).filter((l) => l.productId === line.productId).map((l) => l.quantityMinor))));
    const inTransit = sum(indent.issues.filter((i) => i.state === 'in_transit').map((i) => sum(i.lines.filter((l) => l.productId === line.productId).map((l) => l.quantityMinor))));
    const returned = sum(indent.returns.filter((r) => r.state === 'accepted').map((r) => sum((r.received ?? []).filter((l) => l.productId === line.productId).map((l) => l.quantityMinor))));
    const outstanding = OPEN_FOR_ISSUE.includes(indent.state) && !indent.remainderCancelled ? Math.max(0, allocated - issued) : 0;
    return {
      productId: line.productId, uom: line.uom, requestedMinor: line.requestedMinor, allocatedMinor: allocated,
      issuedMinor: issued, receivedMinor: received, inTransitMinor: inTransit, shortfallMinor: shortfall, unresolvedShortfallMinor: unresolved, damagedMinor: damaged, returnedMinor: returned, outstandingMinor: outstanding,
    };
  });
  const total = (pick: (l: IndentLineTotals) => number): number => sum(lines.map(pick));
  return {
    lines,
    requestedMinor: total((l) => l.requestedMinor), allocatedMinor: total((l) => l.allocatedMinor), issuedMinor: total((l) => l.issuedMinor),
    receivedMinor: total((l) => l.receivedMinor), inTransitMinor: total((l) => l.inTransitMinor), shortfallMinor: total((l) => l.shortfallMinor),
    unresolvedShortfallMinor: total((l) => l.unresolvedShortfallMinor),
    damagedMinor: total((l) => l.damagedMinor), returnedMinor: total((l) => l.returnedMinor), outstandingMinor: total((l) => l.outstandingMinor),
  };
}

// ── request ──────────────────────────────────────────────────────────────────────────────────────────────────

export function requestIndent(input: {
  readonly indentId: string;
  readonly fromLocationId: string;
  readonly toLocationId: string;
  readonly lines: readonly IndentLine[];
  readonly requestedBy: string;
  readonly at: string;
  readonly reason?: string | null;
}): FloorIndent {
  const { indentId } = input;
  if (input.lines.length === 0) refuse(indentId, 'not_readable_as_an_indent', 'an indent asks for at least one product');
  if (input.fromLocationId === input.toLocationId) refuse(indentId, 'same_place', 'an indent from a place to itself moves nothing');
  const seen = new Set<string>();
  for (const line of input.lines) {
    if (!isPosInt(line.requestedMinor)) refuse(indentId, 'not_readable_as_an_indent', `${line.productId}: the requested quantity must be a whole number above zero`);
    if (seen.has(line.productId)) refuse(indentId, 'duplicate_product', `${line.productId} appears twice — one line per product`);
    seen.add(line.productId);
  }
  return {
    indentId, fromLocationId: input.fromLocationId, toLocationId: input.toLocationId, lines: input.lines,
    reason: input.reason ?? null, state: 'requested', requestedBy: input.requestedBy, requestedAt: input.at,
    remainderCancelled: false, issues: [], returns: [], flags: [],
  };
}

// ── approval / rejection (a DIFFERENT person; the allocation is against head office's own back-store stock) ──

export function approveIndent(input: {
  readonly indent: FloorIndent;
  readonly approvedBy: string;
  readonly at: string;
  /** Head office's on-hand at the back store per product — what the allocation is judged against. Absent = not readable. */
  readonly available: readonly { readonly productId: string; readonly onHandMinor: number }[];
  /** The approver's allocation per product; a product left out is allocated min(requested, available). */
  readonly allocations?: readonly { readonly productId: string; readonly quantityMinor: number }[];
  readonly reason?: string | null;
}): FloorIndent {
  const { indent } = input;
  if (indent.state !== 'requested') refuse(indent.indentId, 'indent_not_requested', `it is ${indent.state}, not waiting for a decision`);
  if (input.approvedBy === indent.requestedBy) refuse(indent.indentId, 'self_approval', `${input.approvedBy} raised this indent and cannot also approve it (§28)`);
  for (const a of input.allocations ?? []) {
    if (!indent.lines.some((l) => l.productId === a.productId)) refuse(indent.indentId, 'not_on_indent', `${a.productId} is not on this indent`);
    if (!isNonNegInt(a.quantityMinor)) refuse(indent.indentId, 'over_allocation', `${a.productId}: an allocation is a whole number, zero or more`);
  }
  let flags = indent.flags;
  const allocations: IndentAllocation[] = indent.lines.map((line) => {
    const avail = input.available.find((s) => s.productId === line.productId);
    const availableMinor = avail === undefined ? null : Math.max(0, avail.onHandMinor);
    const asked = input.allocations?.find((a) => a.productId === line.productId);
    const allocatedMinor = asked === undefined ? Math.min(line.requestedMinor, availableMinor ?? line.requestedMinor) : asked.quantityMinor;
    if (allocatedMinor > line.requestedMinor) refuse(indent.indentId, 'over_allocation', `${line.productId}: ${allocatedMinor} allocated but only ${line.requestedMinor} were asked for`);
    if (availableMinor !== null && availableMinor < line.requestedMinor) flags = withFlag(flags, 'short_stock');
    if (allocatedMinor < line.requestedMinor) flags = withFlag(flags, 'short_allocated');
    return { productId: line.productId, allocatedMinor, availableMinor };
  });
  if (sum(allocations.map((a) => a.allocatedMinor)) === 0) refuse(indent.indentId, 'nothing_allocated', 'nothing was allocated — reject the indent instead, with the reason');
  return { ...indent, state: 'approved', approvedBy: input.approvedBy, approvedAt: input.at, approvalReason: input.reason ?? null, allocations, flags };
}

export function rejectIndent(input: { readonly indent: FloorIndent; readonly rejectedBy: string; readonly at: string; readonly reason: string }): FloorIndent {
  const { indent } = input;
  if (indent.state !== 'requested') refuse(indent.indentId, 'indent_not_requested', `it is ${indent.state}, not waiting for a decision`);
  if (input.rejectedBy === indent.requestedBy) refuse(indent.indentId, 'self_approval', `${input.rejectedBy} raised this indent and cannot also decide it (§28)`);
  return { ...indent, state: 'rejected', rejectedBy: input.rejectedBy, rejectedAt: input.at, rejectionReason: input.reason };
}

// ── issue (the back store sends; the stock leaves through the transfer engine, once) ─────────────────────────

/** A transfer id that names its indent and its issue, so the ledger's movements read back to the ask. */
export const issueTransferId = (indentId: string, issueId: string): string => `${indentId}:${issueId}`;
export const returnTransferId = (indentId: string, returnId: string): string => `${indentId}:return:${returnId}`;

/**
 * Plan an issue: the checks the back store's scan must pass, and the TRANSFER (proposed, in the requester's name so the
 * issuer's dispatch is a second person's approval) that carries the stock. Nothing is recorded here.
 */
export function planIssue(input: {
  readonly indent: FloorIndent;
  readonly issueId: string;
  readonly issuedBy: string;
  readonly lines: readonly IssueLine[];
  /** Head office's own unit cost at the back store per product — what values a shortfall; `null` when unvalued. */
  readonly unitCostsMinor: Readonly<Record<string, number | null>>;
  readonly currency: Money['currency'];
  readonly at: string;
}): { readonly transfer: Transfer; readonly issue: IndentIssue } {
  const { indent } = input;
  if (!OPEN_FOR_ISSUE.includes(indent.state) || indent.remainderCancelled) {
    refuse(indent.indentId, 'indent_not_approved', indent.state === 'requested' ? 'nobody has approved it yet' : indent.remainderCancelled ? 'its remainder was cancelled — nothing more is to be issued' : `it is ${indent.state}`);
  }
  if (indent.issues.some((i) => i.issueId === input.issueId)) refuse(indent.indentId, 'over_issue', `issue ${input.issueId} was already recorded`);
  if (input.issuedBy === indent.requestedBy) refuse(indent.indentId, 'requester_cannot_issue', `${input.issuedBy} raised this indent and cannot also issue it to themselves (§28)`);
  if (input.lines.length === 0) refuse(indent.indentId, 'over_issue', 'an issue sends at least one line');
  const totals = indentTotals(indent);
  const seen = new Set<string>();
  for (const line of input.lines) {
    const t = totals.lines.find((l) => l.productId === line.productId);
    if (t === undefined) refuse(indent.indentId, 'not_on_indent', `${line.productId} is not on this indent — the floor did not ask for it`);
    if (!isPosInt(line.quantityMinor)) refuse(indent.indentId, 'over_issue', `${line.productId}: the issued quantity must be a whole number above zero`);
    const key = `${line.productId}|${line.batchId ?? ''}`;
    if (seen.has(key)) refuse(indent.indentId, 'over_issue', `${line.productId} appears twice on this issue`);
    seen.add(key);
    const sameProduct = sum(input.lines.filter((l) => l.productId === line.productId).map((l) => l.quantityMinor));
    if (sameProduct > t!.outstandingMinor) refuse(indent.indentId, 'over_issue', `${line.productId}: ${sameProduct} issued but only ${t!.outstandingMinor} are still owed on this indent`);
  }
  const transfer: Transfer = {
    transferId: issueTransferId(indent.indentId, input.issueId),
    fromLocationId: indent.fromLocationId, toLocationId: indent.toLocationId,
    lines: input.lines.map((l) => ({
      productId: l.productId, batchId: l.batchId, quantityMinor: l.quantityMinor,
      uom: indent.lines.find((x) => x.productId === l.productId)!.uom,
      unitCost: { minor: input.unitCostsMinor[l.productId] ?? 0, currency: input.currency },
    })),
    state: 'proposed',
    // The floor asked; the back store dispatches. Two people, by the transfer engine's own §28 check.
    requestedBy: indent.requestedBy,
  };
  const issue: IndentIssue = { issueId: input.issueId, transferId: transfer.transferId, issuedBy: input.issuedBy, issuedAt: input.at, lines: input.lines, state: 'in_transit' };
  return { transfer, issue };
}

/** Record a dispatched issue on the indent: issuing while something is still owed, issued once nothing is. */
export function applyIssue(indent: FloorIndent, issue: IndentIssue): FloorIndent {
  const next: FloorIndent = { ...indent, issues: [...indent.issues, issue] };
  const owed = indentTotals({ ...next, state: 'issuing' }).outstandingMinor;
  return { ...next, state: owed > 0 ? 'issuing' : 'issued', flags: owed > 0 ? withFlag(next.flags, 'partial_issue') : next.flags };
}

// ── independent floor receipt (a different person counts what arrived; the transfer engine puts it on the shelf) ──

export function planReceipt(input: {
  readonly indent: FloorIndent;
  readonly issueId: string;
  readonly receivedBy: string;
  readonly counted: readonly ReceivedLine[];
}): IndentIssue {
  const { indent } = input;
  const issue = indent.issues.find((i) => i.issueId === input.issueId);
  if (issue === undefined) refuse(indent.indentId, 'issue_unknown', `no issue ${input.issueId} on this indent`);
  if (issue!.state === 'received') refuse(indent.indentId, 'issue_already_received', `issue ${input.issueId} was already received`);
  if (input.receivedBy === issue!.issuedBy) refuse(indent.indentId, 'issuer_cannot_receive', `${input.receivedBy} issued this stock and cannot also receive it at the floor (§28) — the floor's count is independent`);
  for (const c of input.counted) {
    if (!isNonNegInt(c.quantityMinor)) refuse(indent.indentId, 'not_on_issue', `${c.productId}: a counted quantity is a whole number, zero or more`);
    if (c.damagedMinor !== undefined && !isNonNegInt(c.damagedMinor)) refuse(indent.indentId, 'not_on_issue', `${c.productId}: a damaged quantity is a whole number, zero or more`);
    if (!issue!.lines.some((l) => l.productId === c.productId && l.batchId === c.batchId)) {
      refuse(indent.indentId, 'not_on_issue', `${c.productId}${c.batchId === null ? '' : ` · ${c.batchId}`} was not on issue ${input.issueId} — a wrong item is not received against it`);
    }
  }
  return issue!;
}

export function applyReceipt(indent: FloorIndent, issueId: string, receipt: {
  readonly receivedBy: string;
  readonly at: string;
  readonly received: readonly ReceivedLine[];
  readonly shortfall: readonly ShortfallLine[];
  /** SP-8c: arrived damaged — written off at the floor, valued. */
  readonly damaged?: readonly DamagedLine[];
  readonly governanceFlags?: readonly string[];
  readonly relayed?: RelayedBy;
}): FloorIndent {
  const damaged = receipt.damaged ?? [];
  const issues = indent.issues.map((i) => (i.issueId === issueId
    ? {
      ...i, state: 'received' as const, receivedBy: receipt.receivedBy, receivedAt: receipt.at, received: receipt.received, shortfall: receipt.shortfall,
      ...(damaged.length === 0 ? {} : { damaged }),
      ...(receipt.governanceFlags === undefined ? {} : { governanceFlags: receipt.governanceFlags }),
      ...(receipt.relayed === undefined ? {} : { relayed: receipt.relayed }),
    }
    : i));
  const flagged = receipt.shortfall.length > 0 ? withFlag(indent.flags, 'partial_receipt') : indent.flags;
  const next: FloorIndent = { ...indent, issues, flags: damaged.length > 0 ? withFlag(flagged, 'arrived_damaged') : flagged };
  const everyIssueReceived = issues.every((i) => i.state === 'received');
  const nothingOwed = indentTotals(next).outstandingMinor === 0;
  const closed = everyIssueReceived && (indent.state === 'issued' || nothingOwed);
  return { ...next, state: closed ? 'received' : next.state };
}

// ── resolve a shortfall (Batch 2) ────────────────────────────────────────────────────────────────────────────

/**
 * Judge a shortfall resolution. The issue must have been received short and not yet resolved; the resolver is neither the
 * person who issued nor the person who counted it (§28 — "cannot self-approve material variance"); every found line is on
 * the shortfall, found where the stock could be (the floor or the back store), never more than went missing. Pure.
 */
export function planShortfallResolution(input: {
  readonly indent: FloorIndent;
  readonly issueId: string;
  readonly resolvedBy: string;
  readonly found: readonly FoundLine[];
  readonly reasonCode: string;
  readonly note: string;
  readonly at: string;
}): ShortfallResolution {
  const { indent } = input;
  const issue = indent.issues.find((i) => i.issueId === input.issueId);
  if (issue === undefined) refuse(indent.indentId, 'issue_unknown', `there is no issue ${input.issueId} on this indent`);
  if (issue!.state !== 'received') refuse(indent.indentId, 'issue_not_received', `issue ${input.issueId} has not been counted in at the floor yet — there is no shortfall to resolve`);
  const judged = judgeShortfallResolution({
    what: `issue ${input.issueId}`, shortfall: issue!.shortfall ?? [], prior: issue!.shortfallResolution,
    sentBy: issue!.issuedBy, countedBy: issue!.receivedBy, fromLocationId: indent.fromLocationId, toLocationId: indent.toLocationId,
    resolvedBy: input.resolvedBy, found: input.found, reasonCode: input.reasonCode, note: input.note, at: input.at,
  });
  if (!judged.ok) return refuse(indent.indentId, judged.code, judged.why);
  return judged.resolution;
}

export function applyShortfallResolution(indent: FloorIndent, issueId: string, resolution: ShortfallResolution): FloorIndent {
  return { ...indent, issues: indent.issues.map((i) => (i.issueId === issueId ? { ...i, shortfallResolution: resolution } : i)) };
}

// ── cancel (the unissued remainder only — stock on the trolley must still be received) ───────────────────────

export function cancelIndent(input: { readonly indent: FloorIndent; readonly cancelledBy: string; readonly at: string; readonly reason: string }): FloorIndent {
  const { indent } = input;
  if (!['requested', 'approved', 'issuing'].includes(indent.state)) refuse(indent.indentId, 'indent_not_open', `it is ${indent.state} — nothing is left to cancel`);
  const base = { ...indent, cancelledBy: input.cancelledBy, cancelledAt: input.at, cancelReason: input.reason };
  if (indent.issues.length === 0) return { ...base, state: 'cancelled', remainderCancelled: true };
  // Something has gone: the remainder is withdrawn, the issues stand and must still be received.
  const everyIssueReceived = indent.issues.every((i) => i.state === 'received');
  return { ...base, remainderCancelled: true, state: everyIssueReceived ? 'received' : 'issued', flags: withFlag(indent.flags, 'cancelled_remainder') };
}

// ── return floor → back store (the floor asks; a different person at the back store accepts) ─────────────────

export function planReturn(input: {
  readonly indent: FloorIndent;
  readonly returnId: string;
  readonly returnedBy: string;
  readonly lines: readonly IssueLine[];
  readonly reason: string;
  readonly at: string;
}): IndentReturn {
  const { indent } = input;
  if (indent.returns.some((r) => r.returnId === input.returnId)) refuse(indent.indentId, 'over_return', `return ${input.returnId} was already recorded`);
  const totals = indentTotals(indent);
  if (totals.receivedMinor === 0) refuse(indent.indentId, 'nothing_received', 'nothing from this indent has reached the floor yet — there is nothing to send back');
  if (input.lines.length === 0) refuse(indent.indentId, 'over_return', 'a return sends at least one line');
  for (const line of input.lines) {
    const t = totals.lines.find((l) => l.productId === line.productId);
    if (t === undefined) refuse(indent.indentId, 'not_on_indent', `${line.productId} is not on this indent`);
    if (!isPosInt(line.quantityMinor)) refuse(indent.indentId, 'over_return', `${line.productId}: the returned quantity must be a whole number above zero`);
    const pending = sum(indent.returns.filter((r) => r.state === 'requested').flatMap((r) => r.lines.filter((l) => l.productId === line.productId).map((l) => l.quantityMinor)));
    const sameProduct = sum(input.lines.filter((l) => l.productId === line.productId).map((l) => l.quantityMinor));
    const returnable = t!.receivedMinor - t!.returnedMinor - pending;
    if (sameProduct > returnable) refuse(indent.indentId, 'over_return', `${line.productId}: ${sameProduct} to return but only ${returnable} of what this indent brought is on the floor to send back`);
  }
  return {
    returnId: input.returnId, transferId: returnTransferId(indent.indentId, input.returnId), returnedBy: input.returnedBy,
    requestedAt: input.at, reason: input.reason, lines: input.lines, state: 'requested',
  };
}

export function applyReturnRequest(indent: FloorIndent, ret: IndentReturn): FloorIndent {
  return { ...indent, returns: [...indent.returns, ret] };
}

/** The transfer a return travels on: floor → back store, in the returner's name, so the acceptor's dispatch is the second person. */
export function returnTransfer(indent: FloorIndent, ret: IndentReturn, unitCostsMinor: Readonly<Record<string, number | null>>, currency: Money['currency']): Transfer {
  return {
    transferId: ret.transferId, fromLocationId: indent.toLocationId, toLocationId: indent.fromLocationId,
    lines: ret.lines.map((l) => ({
      productId: l.productId, batchId: l.batchId, quantityMinor: l.quantityMinor,
      uom: indent.lines.find((x) => x.productId === l.productId)!.uom,
      unitCost: { minor: unitCostsMinor[l.productId] ?? 0, currency },
    })),
    state: 'proposed', requestedBy: ret.returnedBy,
  };
}

export function planReturnAcceptance(input: {
  readonly indent: FloorIndent;
  readonly returnId: string;
  readonly acceptedBy: string;
  readonly counted: readonly ReceivedLine[];
}): IndentReturn {
  const { indent } = input;
  const ret = indent.returns.find((r) => r.returnId === input.returnId);
  if (ret === undefined) refuse(indent.indentId, 'return_unknown', `no return ${input.returnId} on this indent`);
  if (ret!.state === 'accepted') refuse(indent.indentId, 'return_already_accepted', `return ${input.returnId} was already accepted`);
  if (input.acceptedBy === ret!.returnedBy) refuse(indent.indentId, 'returner_cannot_accept', `${input.acceptedBy} sent this stock back and cannot also accept it at the back store (§28)`);
  for (const c of input.counted) {
    if (!isNonNegInt(c.quantityMinor)) refuse(indent.indentId, 'not_on_return', `${c.productId}: a counted quantity is a whole number, zero or more`);
    if (!ret!.lines.some((l) => l.productId === c.productId && l.batchId === c.batchId)) refuse(indent.indentId, 'not_on_return', `${c.productId} was not on return ${input.returnId}`);
  }
  return ret!;
}

export function applyReturnAcceptance(indent: FloorIndent, returnId: string, acceptance: {
  readonly acceptedBy: string;
  readonly at: string;
  readonly received: readonly ReceivedLine[];
  readonly shortfall: readonly ShortfallLine[];
}): FloorIndent {
  return {
    ...indent,
    returns: indent.returns.map((r) => (r.returnId === returnId
      ? { ...r, state: 'accepted' as const, acceptedBy: acceptance.acceptedBy, acceptedAt: acceptance.at, received: acceptance.received, shortfall: acceptance.shortfall }
      : r)),
  };
}

/** Whether an indent needs a person right now, and why — the register lists these first (P-03). */
export function indentAttention(indent: FloorIndent): readonly string[] {
  const out: string[] = [];
  const t = indentTotals(indent);
  if (indent.state === 'requested') out.push('awaiting_approval');
  if (t.outstandingMinor > 0) out.push('owed_by_back_store');
  if (t.inTransitMinor > 0) out.push('on_the_trolley');
  if (t.unresolvedShortfallMinor > 0) out.push('arrived_short');
  if (t.damagedMinor > 0) out.push('arrived_damaged');
  if (indent.returns.some((r) => r.state === 'requested')) out.push('return_awaiting_back_store');
  return out;
}
