// API-12 OPENING REVERSAL inside the cutover window (OB-44 "A", owner, 11 Oct 2026 — "Trial: new shop; cutover: reverse" ·
// GT-05 · MG-05 · MG-08 · MG-11 · §28 · hard rules #2 #6 #10 · P-08).
//
// Trial loads go into a fresh shop each time — nothing to build. Only inside the REAL cutover window may an opening load be
// undone, and then never by deleting anything: each opening is taken back out through its own domain's compensating path,
// kept beside what it undoes, and read back to zero against the load.
//
//   • WINDOW (OB-52 "A", owner, 11 Oct 2026 — "Opens at your GO", 48 hours) — the window is never typed. It OPENS at the GO
//     the cutover gate recorded (`POST /v1/migration/cutover/decision`: every check passed on head office's records and the
//     owner, signed in, said GO — GT-03) and CLOSES exactly 48 hours later. Before any GO a reversal is refused by name
//     (`no_cutover_go`); after the close, `outside_cutover_window`. `GET /v1/migration/cutover/windows/:cutoverId` reads it;
//     the round-6 route that took typed dates is retired (410).
//   • REQUEST (`POST /v1/migration/opening-reversals/:loadId`) — a NAMED person (the signed-in owner) asks, with a reason, inside
//     the window. EVERY opening is found by head office from the load's own records — never named by the caller (round 7,
//     hard rule #10): its opening receipts, supplier bills and trial balance by the load id, and the gift cards / store credit,
//     credit-customer invoices and points it opened from the opening-item register each of those was written into, atomically,
//     when the load created it (`openingLoadId`). A body that names items is refused; an item the load did not create is never
//     touched; an item that moved since (a spent card, a part-paid invoice, spent points) is refused by name — never half-undone.
//   • APPROVE (`…/approval`) — a SECOND person with the same authority, never the requester (`self_approval`), inside the window,
//     approves; only then are the compensations appended, each keyed on the load so a re-send or an interrupted run lands
//     every one exactly once:
//       stock          an `opening_reversed` movement for every opening-receipt movement — out at the receipt's own cost
//       stored value   an `adjust` movement taking the opening balance back off the instrument
//       receivables    a credit allocation settling the opening invoice (no money received; nothing posts as a receipt)
//       loyalty        a `reversal` points movement for the opening points
//       supplier bills a reversal of each opening bill — off the account, and its posting undone by its own journal
//       ledger         the opening journal's mirror image, its own entry
//   • READ BACK (`GET …`) — per domain, what the load opened, what was taken back, and the net — which must be zero.

import type { Route } from '../../kernel/src/index';
import { apiError } from '../../kernel/src/index';
import type { AuditEntry } from '../../../packages/audit/src/index';

/** OB-52: the cutover GO as the gate recorded it — the owner's signed-in GO on a decision whose every check passed. */
export interface CutoverGo {
  readonly cutoverId: string;
  /** The owner, signed in — never a typed name (GT-03). */
  readonly goBy: string;
  readonly goAt: string;
}

/** OB-52 "A": the reversal window is fixed by the GO — it opens at the GO and closes 48 hours later. */
export const REVERSAL_WINDOW_HOURS = 48;

export interface CutoverWindow {
  readonly cutoverId: string;
  readonly opensAt: string;
  readonly closesAt: string;
  /** Who gave the GO that opened it. */
  readonly goBy: string;
}

/** The window a recorded GO opens: from the GO, for exactly 48 hours. */
export function reversalWindowOf(go: CutoverGo): CutoverWindow {
  const opens = Date.parse(go.goAt);
  return { cutoverId: go.cutoverId, opensAt: new Date(opens).toISOString(), closesAt: new Date(opens + REVERSAL_WINDOW_HOURS * 3_600_000).toISOString(), goBy: go.goBy };
}

/** Round 7: one item a load opened, registered when the load created it (stream `migration/opening-items/<loadId>`). */
export type OpeningItem =
  | { readonly loadId: string; readonly domain: 'stored_value'; readonly instrumentId: string; readonly openedMinor: number }
  | { readonly loadId: string; readonly domain: 'receivable'; readonly customerId: string; readonly invoiceId: string; readonly openedMinor: number }
  | { readonly loadId: string; readonly domain: 'points'; readonly customerId: string; readonly openedMinor: number };

/** The items a load opened, as the reversal holds them — derived from the register, never from a caller. */
export type OpenedItems = Pick<OpeningReversalRequest, 'storedValue' | 'receivables' | 'pointsCustomers'>;

export function openedItemsOf(items: readonly OpeningItem[]): OpenedItems {
  const storedValue: { instrumentId: string; balanceMinor: number }[] = [];
  const receivables: { customerId: string; invoiceId: string; outstandingMinor: number }[] = [];
  const pointsCustomers: string[] = [];
  for (const i of items) {
    if (i.domain === 'stored_value' && !storedValue.some((x) => x.instrumentId === i.instrumentId)) storedValue.push({ instrumentId: i.instrumentId, balanceMinor: i.openedMinor });
    if (i.domain === 'receivable' && !receivables.some((x) => x.customerId === i.customerId && x.invoiceId === i.invoiceId)) receivables.push({ customerId: i.customerId, invoiceId: i.invoiceId, outstandingMinor: i.openedMinor });
    if (i.domain === 'points' && !pointsCustomers.includes(i.customerId)) pointsCustomers.push(i.customerId);
  }
  const by = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);
  return {
    storedValue: storedValue.sort((a, b) => by(a.instrumentId, b.instrumentId)),
    receivables: receivables.sort((a, b) => by(`${a.customerId}/${a.invoiceId}`, `${b.customerId}/${b.invoiceId}`)),
    pointsCustomers: pointsCustomers.sort(by),
  };
}

export interface OpeningReversalRequest {
  readonly loadId: string;
  readonly cutoverId: string;
  readonly reason: string;
  /** Gift cards / store credit the load opened, with the balance it opened them at — from the opening-item register. */
  readonly storedValue: readonly { readonly instrumentId: string; readonly balanceMinor: number }[];
  /** Credit customers' invoices the load opened, with the outstanding it opened them at. */
  readonly receivables: readonly { readonly customerId: string; readonly invoiceId: string; readonly outstandingMinor: number }[];
  /** Customers the load opened points for (their opening movement is `<loadId>-opening-<customerId>`). */
  readonly pointsCustomers: readonly string[];
  readonly requestedBy: string;
  readonly requestedAt: string;
}

export interface OpeningReversalApproval {
  readonly loadId: string;
  readonly approvedBy: string;
  readonly approvedAt: string;
}

/** One domain's position for the load: what it opened, what was taken back, and the net (zero once reversed). */
export interface ReversalDomainLine {
  readonly domain: 'stock_quantity' | 'stock_value' | 'stored_value' | 'receivables' | 'points' | 'supplier_openings' | 'ledger';
  readonly key: string;
  readonly openedMinor: number;
  readonly reversedMinor: number;
  readonly netMinor: number;
}

export interface OpeningReversalDeps {
  /** Every cutover GO the gate recorded (OB-52) — the first per cutover stands. */
  readonly gos: (tenantId: string) => Promise<readonly CutoverGo[]> | readonly CutoverGo[];
  /** Round 7: every gift card / credit, invoice and points opening the load itself registered when it created them. */
  readonly openedItems: (tenantId: string, loadId: string) => Promise<OpenedItems>;
  readonly requests: (tenantId: string) => Promise<readonly OpeningReversalRequest[]> | readonly OpeningReversalRequest[];
  /** Append; resolve the request that STANDS for the load (another writer's, when theirs landed first). */
  readonly recordRequest: (tenantId: string, r: OpeningReversalRequest) => Promise<OpeningReversalRequest | void> | OpeningReversalRequest | void;
  readonly approvals: (tenantId: string) => Promise<readonly OpeningReversalApproval[]> | readonly OpeningReversalApproval[];
  readonly recordApproval: (tenantId: string, a: OpeningReversalApproval) => Promise<OpeningReversalApproval | void> | OpeningReversalApproval | void;
  /** Every reason the named records cannot be reversed as the load opened them (empty = all can). Reads only. */
  readonly problems: (tenantId: string, r: OpeningReversalRequest) => Promise<readonly string[]>;
  /** Append every compensation, each keyed on the load — a re-run lands only what is missing. */
  readonly execute: (tenantId: string, r: OpeningReversalRequest, a: OpeningReversalApproval) => Promise<void>;
  /** Per domain: opened, reversed, net. */
  readonly position: (tenantId: string, r: OpeningReversalRequest) => Promise<readonly ReversalDomainLine[]>;
  readonly recordAudit?: (tenantId: string, entry: AuditEntry) => Promise<unknown> | void;
  readonly now: () => string;
}

const isStr = (v: unknown): v is string => typeof v === 'string' && v.trim() !== '';
const isObj = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === 'object' && !Array.isArray(v);

/** Where a cutover's reversal window stands now: no GO recorded, open, or not open (closed — or, on a skewed clock, not yet). */
export function windowStanding(gos: readonly CutoverGo[], cutoverId: string, nowIso: string):
  { readonly state: 'no_go' } | { readonly state: 'open' | 'closed'; readonly window: CutoverWindow } {
  const go = gos.find((g) => g.cutoverId === cutoverId); // the FIRST GO stands; a later one never moves the window
  if (go === undefined) return { state: 'no_go' };
  const window = reversalWindowOf(go);
  const now = Date.parse(nowIso);
  return { state: now >= Date.parse(window.opensAt) && now <= Date.parse(window.closesAt) ? 'open' : 'closed', window };
}

const noGo = (cutoverId: string) => apiError(422, {
  code: 'no_cutover_go',
  whatHappened: `Cutover ${cutoverId} has no GO on record, so its reversal window has not opened (OB-52: it opens at the owner's signed-in GO and closes 48 hours later). Trial loads are not reversed — they go into a fresh shop.`,
  wasItSaved: 'not_saved',
  nextSafeAction: 'Rehearse in a fresh shop instead. On the real night, the window opens when the cutover gate says GO with the owner signed in (POST /v1/migration/cutover/decision). Nothing was changed.',
});

const outsideWindow = (w: CutoverWindow) => apiError(422, {
  code: 'outside_cutover_window',
  whatHappened: `An opening load is reversed only inside the cutover window, and cutover ${w.cutoverId}'s window ran from its GO at ${w.opensAt} to ${w.closesAt} (48 hours, OB-52) — it is not open now.`,
  wasItSaved: 'not_saved',
  nextSafeAction: 'Correct what the load got wrong by each domain\'s own correcting route (a stock adjustment, a credit note, a journal) with its own approval. Nothing was changed.',
});

/** Refuse unless the cutover's window is open now. */
function assertWindowOpen(gos: readonly CutoverGo[], cutoverId: string, nowIso: string): void {
  const s = windowStanding(gos, cutoverId, nowIso);
  if (s.state === 'no_go') throw noGo(cutoverId);
  if (s.state === 'closed') throw outsideWindow(s.window);
}

/** The caller says WHICH cutover and WHY — never which items: those are head office's, from the load's own register. */
function readRequestBody(b: Record<string, unknown>): { cutoverId: string; reason: string } | 'names_items' | undefined {
  if (['storedValue', 'receivables', 'pointsCustomers'].some((k) => k in b)) return 'names_items';
  if (!isStr(b['cutoverId']) || !isStr(b['reason'])) return undefined;
  return { cutoverId: (b['cutoverId'] as string).trim(), reason: (b['reason'] as string).trim() };
}

const sameRequest = (a: OpeningReversalRequest, b: { cutoverId: string; reason: string }): boolean => a.cutoverId === b.cutoverId && a.reason === b.reason;

export function openingReversalRoutes(deps: OpeningReversalDeps): readonly Route[] {
  const audit = async (tenantId: string, entry: AuditEntry): Promise<void> => { await deps.recordAudit?.(tenantId, entry); };
  const read = async (tenantId: string, loadId: string) => {
    const request = (await deps.requests(tenantId)).find((r) => r.loadId === loadId);
    const approval = (await deps.approvals(tenantId)).find((a) => a.loadId === loadId);
    return { request, approval };
  };
  return [
    {
      // OB-52 "A": RETIRED. The round-6 route took the window's opening and closing as typed dates; the window is now fixed
      // by the recorded GO (it opens at the GO and closes 48 hours later), so a typed window is refused, nothing recorded.
      api: 'API-12', method: 'POST', path: '/v1/migration/cutover/windows/:cutoverId',
      permission: 'migration.cutover.decide', idempotent: true,
      handler: () => {
        throw apiError(410, {
          code: 'cutover_window_is_set_by_the_go',
          whatHappened: 'The reversal window is no longer typed in. It opens at the owner\'s signed-in cutover GO and closes 48 hours later (OB-52).',
          wasItSaved: 'not_saved',
          nextSafeAction: 'Give GO on the cutover gate (POST /v1/migration/cutover/decision, signed in as the owner); read the window at GET /v1/migration/cutover/windows/:cutoverId. Nothing was recorded.',
        });
      },
    },
    {
      // OB-52: READ the window a cutover's recorded GO opened — when it opens and closes, and whether it is open now.
      api: 'API-12', method: 'GET', path: '/v1/migration/cutover/windows/:cutoverId',
      permission: 'migration.parallel.read',
      handler: async (ctx) => {
        const cutoverId = (ctx.params['cutoverId'] ?? '').trim();
        const now = deps.now();
        const s = windowStanding(await deps.gos(ctx.tenantId), cutoverId, now);
        if (s.state === 'no_go') return { status: 200, body: { cutoverId, go: false, window: null, openNow: false, asAt: now } };
        return { status: 200, body: { cutoverId, go: true, window: s.window, openNow: s.state === 'open', asAt: now } };
      },
    },
    {
      api: 'API-12', method: 'POST', path: '/v1/migration/opening-reversals/:loadId',
      permission: 'migration.cutover.decide', idempotent: true,
      handler: async (ctx) => {
        const loadId = (ctx.params['loadId'] ?? '').trim();
        const body = readRequestBody(isObj(ctx.body) ? ctx.body : {});
        if (body === 'names_items') {
          throw apiError(400, { code: 'opening_items_come_from_the_load', whatHappened: 'What a reversal takes back is never named by the person asking: head office reads every gift card, credit, invoice and points opening from the load\'s own register (hard rule #10).', wasItSaved: 'not_saved', nextSafeAction: 'Send only { cutoverId, reason }. Nothing was recorded.' });
        }
        if (loadId === '' || body === undefined) {
          throw apiError(400, { code: 'not_readable_as_an_opening_reversal', whatHappened: 'Reversing an opening load needs the loadId in the path and { cutoverId, reason }.', wasItSaved: 'not_saved', nextSafeAction: 'Send which cutover and why. Nothing was recorded.' });
        }
        const t = ctx.tenantId;
        const { request: prior, approval } = await read(t, loadId);
        if (prior !== undefined) {
          if (sameRequest(prior, body)) return { status: 200, body: { request: prior, alreadyRequested: true, approved: approval !== undefined } };
          throw apiError(409, { code: 'opening_reversal_conflict', whatHappened: `A reversal of load ${loadId} was already requested by ${prior.requestedBy} with different figures. A request is never overwritten.`, wasItSaved: 'not_saved', nextSafeAction: 'Read the request on record and decide on that one. Nothing was changed.' });
        }
        assertWindowOpen(await deps.gos(t), body.cutoverId, deps.now());
        const request: OpeningReversalRequest = { ...body, ...(await deps.openedItems(t, loadId)), loadId, requestedBy: ctx.userId, requestedAt: deps.now() };
        const problems = await deps.problems(t, request);
        if (problems.length > 0) {
          throw apiError(422, { code: 'opening_cannot_be_reversed_as_loaded', whatHappened: `Load ${loadId} cannot be reversed as it stands: ${problems.join('; ')}.`, wasItSaved: 'not_saved', nextSafeAction: 'Settle each named item (a spent gift card, a part-paid invoice) by its own route first, or leave it and reverse the rest by a corrected request. Nothing was recorded.' });
        }
        const stood = (await deps.recordRequest(t, request)) ?? request;
        if (stood.requestedBy !== request.requestedBy || stood.requestedAt !== request.requestedAt) return { status: 200, body: { request: stood, alreadyRequested: true, approved: false } };
        await audit(t, { actorId: ctx.userId, action: 'migration.opening_reversal.request', objectType: 'migration_load', objectId: loadId, at: request.requestedAt, origin: { tenantId: t, branchId: ctx.branchId ?? null }, before: {}, after: { cutoverId: request.cutoverId, reason: request.reason }, correlationId: loadId });
        return { status: 201, body: { request, alreadyRequested: false, approved: false, position: await deps.position(t, request) } };
      },
    },
    {
      api: 'API-12', method: 'POST', path: '/v1/migration/opening-reversals/:loadId/approval',
      permission: 'migration.cutover.decide', idempotent: true,
      handler: async (ctx) => {
        const loadId = (ctx.params['loadId'] ?? '').trim();
        const t = ctx.tenantId;
        const { request, approval: prior } = await read(t, loadId);
        if (request === undefined) {
          throw apiError(404, { code: 'no_opening_reversal_requested', whatHappened: `No reversal of load ${loadId} has been requested.`, wasItSaved: 'not_saved', nextSafeAction: 'A named person requests it first. Nothing was changed.' });
        }
        if (prior !== undefined) {
          // Approved already: complete anything an interruption cut short — every compensation is keyed on the load.
          await deps.execute(t, request, prior);
          return { status: 200, body: { approval: prior, alreadyApproved: true, position: await deps.position(t, request) } };
        }
        if (request.requestedBy === ctx.userId) {
          throw apiError(403, { code: 'self_approval', whatHappened: `You requested the reversal of load ${loadId}, so you cannot also approve it (OB-44 · §28: a second approver).`, wasItSaved: 'not_saved', nextSafeAction: 'Ask another person with the authority to decide the cutover. Nothing was changed.' });
        }
        assertWindowOpen(await deps.gos(t), request.cutoverId, deps.now());
        const problems = await deps.problems(t, request);
        if (problems.length > 0) {
          throw apiError(422, { code: 'opening_cannot_be_reversed_as_loaded', whatHappened: `Since the request, load ${loadId} can no longer be reversed as it stands: ${problems.join('; ')}.`, wasItSaved: 'not_saved', nextSafeAction: 'Nothing was reversed. Settle what is named, then request again.' });
        }
        const approval: OpeningReversalApproval = { loadId, approvedBy: ctx.userId, approvedAt: deps.now() };
        const stood = (await deps.recordApproval(t, approval)) ?? approval;
        await deps.execute(t, request, stood);
        await audit(t, { actorId: ctx.userId, action: 'migration.opening_reversal.approve', objectType: 'migration_load', objectId: loadId, at: approval.approvedAt, origin: { tenantId: t, branchId: ctx.branchId ?? null }, before: {}, after: { requestedBy: request.requestedBy, cutoverId: request.cutoverId }, correlationId: loadId });
        return { status: 201, body: { approval: stood, alreadyApproved: stood.approvedBy !== approval.approvedBy, position: await deps.position(t, request) } };
      },
    },
    {
      api: 'API-12', method: 'GET', path: '/v1/migration/opening-reversals/:loadId',
      permission: 'migration.parallel.read',
      handler: async (ctx) => {
        const loadId = (ctx.params['loadId'] ?? '').trim();
        const { request, approval } = await read(ctx.tenantId, loadId);
        if (request === undefined) throw apiError(404, { code: 'no_opening_reversal_requested', whatHappened: `No reversal of load ${loadId} is on record.`, wasItSaved: 'not_saved', nextSafeAction: 'Nothing to show.' });
        const position = await deps.position(ctx.tenantId, request);
        const atZero = position.every((l) => l.netMinor === 0);
        return { status: 200, body: { request, approval: approval ?? null, position, reversedToZero: approval !== undefined && atZero, asAt: deps.now() } };
      },
    },
  ];
}
