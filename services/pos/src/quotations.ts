// API-05 Quotations (M12-FR-02 / M22 B2B) — a price PROMISED, not a sale made, on the live API over the
// tested `packages/suspended-sales` quotation engine.
//
// A quotation is the one document that looks like a sale and must not behave like one, and every control
// here stops it becoming the route around another control:
//   • IT MOVES NO STOCK — quoting 200 kg reserves nothing; the shop keeps selling the goods.
//   • THE PRICE IS HELD, AND ONLY IN ITS VALIDITY WINDOW — a converted quote rings up at the quoted prices
//     while valid, and an EXPIRED one is refused rather than honoured or silently re-priced (both are a
//     person's decision).
//   • YOU CANNOT QUOTE PAST THE MARGIN FLOOR — a below-floor quotation needs the same separate approval a
//     discount needs, and the person quoting cannot approve their own (§28).
//   • CONVERTING IS IDEMPOTENT — a quotation becomes exactly one sale; a second convert returns the first.
//   • A withdrawn or expired quotation is KEPT (hard rule #6) — an unconverted quote is a lost sale, and
//     who quotes and never closes is worth seeing (the follow-up list surfaces expiring ones first).
//
// Event-sourced: each state change is an append-only fact and the current quotation is the latest fact.
// Issue and withdraw are gated `pos.quotation.write`; convert `pos.quotation.convert` (OB-506 — the till's store computer
// holds it, never the write); the list and follow-up read `pos.quotation.read`.
//
// Round 8 (owner, 28 Oct 2026):
//   • OB-525 — head office reads each product's FLOOR itself when a quotation is issued (its buying cost at the quotation's
//     store lifted by the store's margin floor — the till's own floor, OB-500); a line quoted below its floor needs a second
//     person's approval through the maker-checker engine. The request carries no floor and no cost: one that does is refused.
//     A product whose floor head office cannot read (never received at a cost) is said on the answer and kept on the record.
//   • OB-523 — a bill that rang a quotation up and was then CANCELLED at the till frees the quotation again: the store
//     computer relays the cancellation (`POST …/:quotationId/free/synced`, `pos.quotation.free` — the box's own narrow word)
//     and the release is appended as a compensating fact with who cancelled the bill and why. A later bill may ring it up.
// Round 9 (owner, 28 Oct 2026):
//   • OB-532 — a line on a product whose floor head office cannot read (never received at a cost) needs the OWNER's approval
//     (kind `quotation_floor_not_known`, the owner's alone, and a decider who holds the owner role at the quotation's store),
//     like a till price cut on such a product (OB-520); the person quoting can never approve their own.
// Round 10 (owner, 28 Oct 2026):
//   • OB-542 — when the person quoting such a product holds the OWNER role at the quotation's store, the ACCOUNTANT approves
//     it instead (kind `quotation_floor_not_known_owner_quoted`, a decider who holds the accountant role at that store);
//     anyone else's quotation still needs the owner's. The quoter still never approves his own.

import type { Route } from '../../kernel/src/index';
import { apiError, assertBranchInScope } from '../../kernel/src/index';
import {
  issueQuotation, convertQuotation, withdrawQuotation, quotationsNeedingFollowUp, freeQuotation,
  type Quotation, type QuotationLine, type QuotationApproval, type QuotationRelease,
} from '../../../packages/suspended-sales/src/index';
import { actionDetails, approvalNamedIn, type ApprovalPort } from '../../identity/src/approval-requests';
import { shopDateIn } from '../../../packages/calendar/src/shop-clock';

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const isStr = (v: unknown): v is string => typeof v === 'string' && v.trim() !== '';
const isInt = (v: unknown): v is number => typeof v === 'number' && Number.isInteger(v);

export interface QuotationsDeps {
  /** Every quotation's latest state, folded from the append-only log. */
  readonly quotations: (tenantId: string) => Promise<readonly Quotation[]> | readonly Quotation[];
  /** Append a quotation's new state (issued / converted / withdrawn). Idempotent on quotation + state. */
  readonly record: (tenantId: string, q: Quotation) => Promise<void> | void;
  /** Head office's maker-checker engine (ADR-0024): a below-floor quote's approver gave it in their own session.
   *  Optional on a bare stub (then every approval is unknown); the running system provides it. */
  readonly approvals?: ApprovalPort;
  /**
   * OB-525: each product's floor price per unit at a store, read by head office from its own records (buying cost × the
   * store's margin floor) — `notKnown` for a product never received at a cost. Absent on a bare stub (no floor read).
   */
  readonly floorsAt?: (tenantId: string, storeId: string, productIds: readonly string[]) => Promise<{ readonly floors: Readonly<Record<string, number>>; readonly notKnown: readonly string[] }>;
  /**
   * OB-532: the people who hold the OWNER role at a store (head office's own grants) — the only ones whose approval lets a
   * product with no known floor be quoted. Absent on a bare stub: then nobody counts as the owner (such a quote is refused).
   */
  readonly ownersAt?: (tenantId: string, storeId: string) => Promise<readonly string[]>;
  /**
   * OB-542: the people who hold the ACCOUNTANT role at a store (head office's own grants) — the only ones whose approval lets
   * the OWNER's own quotation on a product with no known floor be issued. Absent on a bare stub: nobody counts (refused).
   */
  readonly accountantsAt?: (tenantId: string, storeId: string) => Promise<readonly string[]>;
  /**
   * OB-523: append a quotation freed from a cancelled bill — its own fact, keyed on the release, so a re-send collapses.
   * Absent → `record` is used.
   */
  readonly recordFreed?: (tenantId: string, q: Quotation, release: QuotationRelease) => Promise<void> | void;
  readonly now: () => string;
}

function readLine(v: unknown): QuotationLine | undefined {
  if (!isObj(v) || !isStr(v['lineId']) || !isStr(v['productId']) || !isStr(v['description'])
    || !isInt(v['unitPriceMinor']) || !isInt(v['quantityMinor']) || !isStr(v['uom']) || !isInt(v['taxBps'])) {
    return undefined;
  }
  if (v['unitCostMinor'] !== undefined && !isInt(v['unitCostMinor'])) return undefined;
  return {
    lineId: v['lineId'] as string, productId: v['productId'] as string, description: v['description'] as string,
    unitPriceMinor: v['unitPriceMinor'] as number, quantityMinor: v['quantityMinor'] as number,
    uom: v['uom'] as string, taxBps: v['taxBps'] as number,
    ...(isInt(v['unitCostMinor']) ? { unitCostMinor: v['unitCostMinor'] as number } : {}),
  };
}

function readLines(v: unknown): readonly QuotationLine[] | undefined {
  if (!Array.isArray(v)) return undefined;
  const out: QuotationLine[] = [];
  for (const item of v) {
    const one = readLine(item);
    if (one === undefined) return undefined;
    out.push(one);
  }
  return out;
}


export function quotationsRoutes(deps: QuotationsDeps): readonly Route[] {
  const find = async (tenantId: string, quotationId: string): Promise<Quotation | undefined> =>
    (await deps.quotations(tenantId)).find((q) => q.quotationId === quotationId);

  return [
    {
      // ISSUE — a price promised. Nothing is reserved; a below-floor price needs a separate approval (§28).
      api: 'API-05', method: 'POST', path: '/v1/pos/quotations/:quotationId',
      permission: 'pos.quotation.write', idempotent: true,
      handler: async (ctx) => {
        const quotationId = ctx.params['quotationId'] ?? '';
        const b = (ctx.body ?? {}) as Record<string, unknown>;
        const lines = readLines(b['lines']);
        if (!isStr(b['storeId']) || !isStr(b['customerRef']) || !isStr(b['currency']) || !isStr(b['validUntil']) || lines === undefined) {
          throw apiError(400, {
            code: 'quotation_needs_customer_lines_validity',
            whatHappened: 'Issuing a quotation needs storeId, customerRef, currency, validUntil (YYYY-MM-DD) and lines[] (each lineId, productId, description, unitPriceMinor, quantityMinor, uom, taxBps).',
            wasItSaved: 'not_saved',
            nextSafeAction: 'Send the customer, the lines with their promised prices, and the date the price is held until.',
          });
        }
        // OB-525: the floor and the cost are head office's own — a request that names either is refused, never believed.
        if (deps.floorsAt !== undefined && (b['marginFloorBps'] !== undefined || lines.some((l) => l.unitCostMinor !== undefined))) {
          throw apiError(400, {
            code: 'quotation_carries_floor_or_cost',
            whatHappened: 'This quotation names its own margin floor or buying cost. Head office reads each product\'s floor itself from its own records (OB-525) — never from the request.',
            wasItSaved: 'not_saved',
            nextSafeAction: 'Send the lines with their promised prices only. Nothing was quoted.',
          });
        }
        if (b['marginFloorBps'] !== undefined && (!isInt(b['marginFloorBps']) || (b['marginFloorBps'] as number) < 0)) {
          throw apiError(400, { code: 'margin_floor_not_a_number', whatHappened: 'marginFloorBps must be a whole number of basis points when given.', wasItSaved: 'not_saved', nextSafeAction: 'Send the margin floor in basis points, or leave it out.' });
        }
        // A quotation id is issued once — a re-issue is refused, never a silent re-quote.
        if ((await find(ctx.tenantId, quotationId)) !== undefined) {
          throw apiError(409, { code: 'quotation_already_exists', whatHappened: `A quotation '${quotationId}' already exists.`, wasItSaved: 'not_saved', nextSafeAction: 'Use a new quotation id, or convert/withdraw the existing one.' });
        }

        // OB-525: each product's floor at THIS quotation's store, read here — before the approval is judged, because the kind
        // of approval needed depends on it (OB-532).
        const floors = deps.floorsAt === undefined ? undefined
          : await deps.floorsAt(ctx.tenantId, b['storeId'] as string, [...new Set(lines.map((l) => l.productId))]);
        // OB-532: a line on a product whose floor head office cannot read needs the OWNER's approval (kind
        // `quotation_floor_not_known`, the owner's alone); otherwise a below-floor line needs a second person's (kind
        // `quotation_below_floor`).
        const notKnownHere = floors === undefined ? false : lines.some((l) => floors.notKnown.includes(l.productId));
        // OB-542: the OWNER quoting such a product himself is approved by the ACCOUNTANT — whether the quoter holds the owner
        // role at this store is read from head office's own grants, never from the request.
        const storeId = b['storeId'] as string;
        const quoterIsOwner = notKnownHere && deps.ownersAt !== undefined && (await deps.ownersAt(ctx.tenantId, storeId)).includes(ctx.userId);
        const kind = !notKnownHere ? 'quotation_below_floor' : quoterIsOwner ? 'quotation_floor_not_known_owner_quoted' : 'quotation_floor_not_known';
        // The second person (ADR-0024 · §28 · M05-FR-02): a below-floor quote is approved by someone holding the pricing-
        // approval authority (`price.change.approve`), in their own session, for exactly this quotation (kind
        // `quotation_below_floor`). Before, any name passed — no authority was checked at all. A typed one is refused.
        const opened = await approvalNamedIn(deps.approvals, {
          tenantId: ctx.tenantId, approvalId: b['approvalId'], typedField: 'approval.decidedBy',
          typedValue: isObj(b['approval']) ? (b['approval'] as Record<string, unknown>)['decidedBy'] : undefined,
          kind, subjectRef: quotationId, details: actionDetails(ctx.body, { quotationId }), valueMinor: null,
          maker: ctx.userId, usedBy: `quotation:${quotationId}`, now: deps.now(),
        });
        // OB-532: the owner's approval counts as the owner's only when its decider holds the OWNER role at this store (the
        // till's OB-520 rule) — read here, never taken from the request.
        const byOwner = opened !== undefined && kind === 'quotation_floor_not_known' && deps.ownersAt !== undefined
          && (await deps.ownersAt(ctx.tenantId, storeId)).includes(opened.decision.decidedBy);
        // OB-542: the accountant's approval counts only when its decider holds the ACCOUNTANT role at this store.
        const byAccountant = opened !== undefined && kind === 'quotation_floor_not_known_owner_quoted' && deps.accountantsAt !== undefined
          && (await deps.accountantsAt(ctx.tenantId, storeId)).includes(opened.decision.decidedBy);
        const approval: QuotationApproval | undefined = opened === undefined ? undefined
          : { subjectRef: quotationId, status: 'approved', decidedBy: opened.decision.decidedBy, reason: opened.decision.reason, ...(byOwner ? { byOwner: true } : {}), ...(byAccountant ? { byAccountant: true } : {}) };
        const issuedAt = isStr(b['issuedAt']) ? (b['issuedAt'] as string) : deps.now();
        const result = issueQuotation({
          quotationId, tenantId: ctx.tenantId, storeId: b['storeId'] as string, customerRef: b['customerRef'] as string,
          currency: b['currency'] as string, lines, issuedBy: ctx.userId, issuedAt, validUntil: b['validUntil'] as string,
          ...(isInt(b['marginFloorBps']) ? { marginFloorBps: b['marginFloorBps'] as number } : {}),
          ...(floors === undefined ? {} : { lineFloorsMinor: floors.floors, floorNotKnown: floors.notKnown }),
          ...(quoterIsOwner ? { quoterIsOwner: true } : {}),
          ...(approval !== undefined ? { approval } : {}),
        });
        if (!result.issued || result.quotation === undefined) {
          throw apiError(422, { code: `quotation_${result.outcome}`, whatHappened: result.detail, wasItSaved: 'not_saved', nextSafeAction: result.outcome === 'below_floor_unapproved'
            ? 'Nothing was quoted. Ask for approval (POST /v1/approvals/requests, kind quotation_below_floor, with exactly this quotation); once someone who may approve prices approves it, send the approvalId.'
            : result.outcome === 'floor_not_known_unapproved'
              ? 'Nothing was quoted. Ask the OWNER for approval (POST /v1/approvals/requests, kind quotation_floor_not_known, with exactly this quotation); once the owner approves it, send the approvalId (OB-532).'
              : result.outcome === 'floor_not_known_owner_quoted_unapproved'
                ? 'Nothing was quoted. You hold the owner role, so ask the ACCOUNTANT for approval (POST /v1/approvals/requests, kind quotation_floor_not_known_owner_quoted, with exactly this quotation); once the accountant approves it, send the approvalId (OB-542).'
                : 'Nothing was quoted. Address the reason and issue again.' });
        }
        // Every rule passed: the approval is spent — once — and only then is the quotation recorded.
        await opened?.spend();
        await deps.record(ctx.tenantId, result.quotation);
        return { status: 201, body: {
          quotationId, state: 'issued', totalMinor: result.quotation.totalMinor, validUntil: result.quotation.validUntil,
          // OB-525: a product whose floor head office could not read is SAID — never taken as a floor of zero (P-08).
          ...(result.quotation.floorNotKnown === undefined ? {} : { floorNotKnown: result.quotation.floorNotKnown }),
        } };
      },
    },
    {
      // CONVERT — ring up the promised prices while the quote is still valid. Idempotent: a second convert
      // returns the sale that already exists. An expired / withdrawn quote is refused, not silently re-priced.
      // OB-506 (owner, 28 Oct 2026): the cashier rings a quotation up at the till by its number — the till asks its store
      // computer, which asks HERE under its own credential. So converting is its own narrow word (`pos.quotation.convert`):
      // the store computer may convert, never issue or withdraw a quotation (least privilege, P-04).
      api: 'API-05', method: 'POST', path: '/v1/pos/quotations/:quotationId/convert',
      permission: 'pos.quotation.convert', idempotent: true,
      handler: async (ctx) => {
        const quotationId = ctx.params['quotationId'] ?? '';
        const b = (ctx.body ?? {}) as Record<string, unknown>;
        if (!isStr(b['saleId'])) {
          throw apiError(400, { code: 'convert_needs_a_sale_id', whatHappened: 'Converting a quotation needs the { saleId } it becomes.', wasItSaved: 'not_saved', nextSafeAction: 'Send the sale id this quotation converts to.' });
        }
        const quotation = await find(ctx.tenantId, quotationId);
        if (quotation === undefined) {
          throw apiError(404, { code: 'unknown_quotation', whatHappened: `There is no quotation '${quotationId}'.`, wasItSaved: 'not_saved', nextSafeAction: 'Check the id against GET /v1/pos/quotations.' });
        }
        const quantities = isObj(b['quantities']) && Object.values(b['quantities']).every(isInt) ? (b['quantities'] as Record<string, number>) : undefined;
        const result = convertQuotation({ quotation, saleId: b['saleId'] as string, at: isStr(b['at']) ? (b['at'] as string) : deps.now(), ...(quantities !== undefined ? { quantities } : {}) });

        // Already converted → the quotation became one sale; return that sale rather than making another.
        if (!result.converted && result.outcome === 'already_converted') {
          // OB-506: the SAME bill asking again (a till whose first answer was lost) gets the quoted lines back, so it can ring
          // them; any other bill is told which bill already has it — never a second set of lines.
          const sameSale = result.saleId === (b['saleId'] as string);
          return { status: 200, body: { quotationId, converted: false, alreadyConverted: true, saleId: result.saleId, ...(sameSale ? { sameSale: true, saleLines: quotation.lines } : {}) } };
        }
        if (!result.converted) {
          throw apiError(422, { code: `quotation_${result.outcome}`, whatHappened: result.detail, wasItSaved: 'not_saved', nextSafeAction: 'Nothing was rung up. Re-quote if the price is to change.' });
        }
        await deps.record(ctx.tenantId, result.quotation);
        return { status: 200, body: { quotationId, converted: true, saleId: result.saleId, saleLines: result.saleLines } };
      },
    },
    {
      // OB-523 FREE — the bill that rang this quotation up was CANCELLED at the till: the store computer relays it (queued on
      // its disk when head office was out of reach, sent once). The release is a compensating fact — who cancelled the bill
      // (the person the box verified), why, at which till and when; the convert stays in the history. Only the bill the
      // quotation is on frees it; a re-send of the same release is answered with it.
      api: 'API-05', method: 'POST', path: '/v1/pos/quotations/:quotationId/free/synced',
      permission: 'pos.quotation.free', idempotent: true,
      handler: async (ctx) => {
        const quotationId = ctx.params['quotationId'] ?? '';
        const b = (ctx.body ?? {}) as Record<string, unknown>;
        const isTime = (v: unknown): v is string => isStr(v) && !Number.isNaN(Date.parse(v));
        if (b['quotationId'] !== quotationId || !isStr(b['freeId']) || !isStr(b['saleId']) || !isStr(b['freedBy']) || !isStr(b['reason'])
          || !isStr(b['laneId']) || !isTime(b['at'])) {
          throw apiError(400, {
            code: 'not_readable_as_a_quotation_release',
            whatHappened: 'A quotation freed from a cancelled bill needs { quotationId (matching the address), freeId, saleId (the cancelled bill), freedBy, reason, laneId, at }.',
            wasItSaved: 'not_saved',
            nextSafeAction: 'Keep it in the store computer\'s queue and raise it. The quotation stays rung up on that bill until it is read.',
          });
        }
        const quotation = await find(ctx.tenantId, quotationId);
        if (quotation === undefined) {
          throw apiError(404, { code: 'unknown_quotation', whatHappened: `There is no quotation '${quotationId}'.`, wasItSaved: 'not_saved', nextSafeAction: 'Kept in the store computer\'s queue for a person to check the number.' });
        }
        // The quotation's store as head office holds it — a box of another store never frees it.
        assertBranchInScope(ctx, quotation.storeId);
        const out = freeQuotation({
          quotation, freeId: (b['freeId'] as string).trim(), saleId: (b['saleId'] as string).trim(), freedBy: (b['freedBy'] as string).trim(),
          reason: b['reason'] as string, laneId: (b['laneId'] as string).trim(), at: new Date(Date.parse(b['at'] as string)).toISOString(),
          relayedBy: ctx.userId, recordedAt: deps.now(),
        });
        if (out.outcome === 'already_freed') return { status: 200, body: { quotationId, freed: true, alreadyFreed: true, state: quotation.state, release: out.release } };
        if (out.outcome !== 'freed' || out.release === undefined) {
          throw apiError(422, {
            code: out.outcome === 'not_on_this_bill' ? 'quotation_not_on_this_bill' : 'quotation_release_needs_a_reason',
            whatHappened: out.detail, wasItSaved: 'not_saved',
            nextSafeAction: 'Kept in the store computer\'s queue for a person to check: the quotation was not changed.',
          });
        }
        await (deps.recordFreed ?? ((t: string, q: Quotation) => deps.record(t, q)))(ctx.tenantId, out.quotation, out.release);
        return { status: 201, body: { quotationId, freed: true, state: 'issued', release: out.release } };
      },
    },
    {
      // WITHDRAW — with a reason; the record is kept, never deleted (hard rule #6).
      api: 'API-05', method: 'POST', path: '/v1/pos/quotations/:quotationId/withdraw',
      permission: 'pos.quotation.write', idempotent: true,
      handler: async (ctx) => {
        const quotationId = ctx.params['quotationId'] ?? '';
        const b = (ctx.body ?? {}) as Record<string, unknown>;
        if (!isStr(b['reason'])) {
          throw apiError(400, { code: 'withdraw_needs_a_reason', whatHappened: 'Withdrawing a quotation needs a { reason }.', wasItSaved: 'not_saved', nextSafeAction: 'Send why the quotation is being withdrawn.' });
        }
        const quotation = await find(ctx.tenantId, quotationId);
        if (quotation === undefined) {
          throw apiError(404, { code: 'unknown_quotation', whatHappened: `There is no quotation '${quotationId}'.`, wasItSaved: 'not_saved', nextSafeAction: 'Check the id against GET /v1/pos/quotations.' });
        }
        const result = withdrawQuotation({ quotation, byUserId: ctx.userId, reason: b['reason'] as string, at: isStr(b['at']) ? (b['at'] as string) : deps.now() });
        if (!result.withdrawn) {
          throw apiError(422, { code: 'not_withdrawn', whatHappened: result.detail, wasItSaved: 'not_saved', nextSafeAction: 'Only an issued quotation can be withdrawn.' });
        }
        await deps.record(ctx.tenantId, result.quotation);
        return { status: 200, body: { quotationId, state: 'withdrawn' } };
      },
    },
    {
      // FOLLOW-UP — issued quotations expiring soon (soonest first) and lapsed ones, so a done-but-lost sale
      // is chased before it goes cold. Distinct literal path so it never collides with an id.
      api: 'API-05', method: 'GET', path: '/v1/pos/quotations/follow-up',
      permission: 'pos.quotation.read',
      handler: async (ctx) => {
        const today = isStr(ctx.query['today']) ? (ctx.query['today'] as string) : shopDateIn(deps.now()); // R1c: the shop's today
        const withinDays = isInt(Number(ctx.query['withinDays'])) && ctx.query['withinDays'] !== undefined ? Number(ctx.query['withinDays']) : 3;
        const list = quotationsNeedingFollowUp(await deps.quotations(ctx.tenantId), today, withinDays);
        return { status: 200, body: { today, count: list.length, quotations: list } };
      },
    },
    {
      // LIST — every quotation with its state (an optional ?state= filter).
      api: 'API-05', method: 'GET', path: '/v1/pos/quotations',
      permission: 'pos.quotation.read',
      handler: async (ctx) => {
        const all = await deps.quotations(ctx.tenantId);
        const wanted = ctx.query['state'];
        const quotations = isStr(wanted) ? all.filter((q) => q.state === wanted) : all;
        return { status: 200, body: { count: quotations.length, quotations, asAt: deps.now() } };
      },
    },
  ];
}
