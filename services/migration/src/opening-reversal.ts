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
//     the window. The load's own openings are found by head office (its opening receipts, its supplier bills, its trial
//     balance, its points movements); the gift cards / store credit and credit-customer invoices it opened are named from the
//     load's extract and each is checked against what the load recorded (an instrument whose balance moved since, an
//     invoice already part-paid, is refused by name — never half-undone).
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

export interface OpeningReversalRequest {
  readonly loadId: string;
  readonly cutoverId: string;
  readonly reason: string;
  /** Gift cards / store credit the load opened, with the balance it opened them at. */
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
const isMinor = (v: unknown): v is number => Number.isSafeInteger(v) && (v as number) >= 0;

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

function readRequestBody(b: Record<string, unknown>): Omit<OpeningReversalRequest, 'loadId' | 'requestedBy' | 'requestedAt'> | undefined {
  if (!isStr(b['cutoverId']) || !isStr(b['reason'])) return undefined;
  const sv = b['storedValue'] ?? [];
  const rc = b['receivables'] ?? [];
  const pc = b['pointsCustomers'] ?? [];
  if (!Array.isArray(sv) || !sv.every((x) => isObj(x) && isStr(x['instrumentId']) && isMinor(x['balanceMinor']))) return undefined;
  if (!Array.isArray(rc) || !rc.every((x) => isObj(x) && isStr(x['customerId']) && isStr(x['invoiceId']) && isMinor(x['outstandingMinor']))) return undefined;
  if (!Array.isArray(pc) || !pc.every(isStr)) return undefined;
  return {
    cutoverId: (b['cutoverId'] as string).trim(), reason: (b['reason'] as string).trim(),
    storedValue: (sv as Record<string, unknown>[]).map((x) => ({ instrumentId: x['instrumentId'] as string, balanceMinor: x['balanceMinor'] as number })),
    receivables: (rc as Record<string, unknown>[]).map((x) => ({ customerId: x['customerId'] as string, invoiceId: x['invoiceId'] as string, outstandingMinor: x['outstandingMinor'] as number })),
    pointsCustomers: [...(pc as string[])],
  };
}

const sameRequest = (a: OpeningReversalRequest, b: Omit<OpeningReversalRequest, 'loadId' | 'requestedBy' | 'requestedAt'>): boolean =>
  a.cutoverId === b.cutoverId && a.reason === b.reason
  && a.storedValue.length === b.storedValue.length && a.storedValue.every((x, i) => x.instrumentId === b.storedValue[i]!.instrumentId && x.balanceMinor === b.storedValue[i]!.balanceMinor)
  && a.receivables.length === b.receivables.length && a.receivables.every((x, i) => x.customerId === b.receivables[i]!.customerId && x.invoiceId === b.receivables[i]!.invoiceId && x.outstandingMinor === b.receivables[i]!.outstandingMinor)
  && a.pointsCustomers.length === b.pointsCustomers.length && a.pointsCustomers.every((x, i) => x === b.pointsCustomers[i]);

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
        if (loadId === '' || body === undefined) {
          throw apiError(400, { code: 'not_readable_as_an_opening_reversal', whatHappened: 'Reversing an opening load needs the loadId in the path and { cutoverId, reason, storedValue?: [{ instrumentId, balanceMinor }], receivables?: [{ customerId, invoiceId, outstandingMinor }], pointsCustomers?: [customerId] } — the instruments, invoices and points the load opened, from its extract.', wasItSaved: 'not_saved', nextSafeAction: 'Send why, and what the load opened. Nothing was recorded.' });
        }
        const t = ctx.tenantId;
        const { request: prior, approval } = await read(t, loadId);
        if (prior !== undefined) {
          if (sameRequest(prior, body)) return { status: 200, body: { request: prior, alreadyRequested: true, approved: approval !== undefined } };
          throw apiError(409, { code: 'opening_reversal_conflict', whatHappened: `A reversal of load ${loadId} was already requested by ${prior.requestedBy} with different figures. A request is never overwritten.`, wasItSaved: 'not_saved', nextSafeAction: 'Read the request on record and decide on that one. Nothing was changed.' });
        }
        assertWindowOpen(await deps.gos(t), body.cutoverId, deps.now());
        const request: OpeningReversalRequest = { ...body, loadId, requestedBy: ctx.userId, requestedAt: deps.now() };
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
