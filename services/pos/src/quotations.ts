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
// Writes gated `pos.quotation.write`; the list and follow-up read `pos.quotation.read`.

import type { Route } from '../../kernel/src/index';
import { apiError } from '../../kernel/src/index';
import {
  issueQuotation, convertQuotation, withdrawQuotation, quotationsNeedingFollowUp,
  type Quotation, type QuotationLine, type QuotationApproval,
} from '../../../packages/suspended-sales/src/index';

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const isStr = (v: unknown): v is string => typeof v === 'string' && v.trim() !== '';
const isInt = (v: unknown): v is number => typeof v === 'number' && Number.isInteger(v);
const APPROVAL_STATUSES = ['approved', 'rejected', 'pending'] as const;

export interface QuotationsDeps {
  /** Every quotation's latest state, folded from the append-only log. */
  readonly quotations: (tenantId: string) => Promise<readonly Quotation[]> | readonly Quotation[];
  /** Append a quotation's new state (issued / converted / withdrawn). Idempotent on quotation + state. */
  readonly record: (tenantId: string, q: Quotation) => Promise<void> | void;
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

function readApproval(v: unknown): QuotationApproval | undefined {
  if (!isObj(v) || !isStr(v['subjectRef']) || !(APPROVAL_STATUSES as readonly string[]).includes(v['status'] as string)
    || !isStr(v['decidedBy']) || !isStr(v['reason'])) {
    return undefined;
  }
  return { subjectRef: v['subjectRef'] as string, status: v['status'] as QuotationApproval['status'], decidedBy: v['decidedBy'] as string, reason: v['reason'] as string };
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
        const approval = b['approval'] === undefined ? undefined : readApproval(b['approval']);
        if (b['approval'] !== undefined && approval === undefined) {
          throw apiError(400, { code: 'approval_not_readable', whatHappened: 'An approval needs { subjectRef, status, decidedBy, reason }.', wasItSaved: 'not_saved', nextSafeAction: 'Send the approval that authorised the below-floor price, or omit it.' });
        }
        if (b['marginFloorBps'] !== undefined && (!isInt(b['marginFloorBps']) || (b['marginFloorBps'] as number) < 0)) {
          throw apiError(400, { code: 'margin_floor_not_a_number', whatHappened: 'marginFloorBps must be a whole number of basis points when given.', wasItSaved: 'not_saved', nextSafeAction: 'Send the margin floor in basis points, or leave it out.' });
        }
        // A quotation id is issued once — a re-issue is refused, never a silent re-quote.
        if ((await find(ctx.tenantId, quotationId)) !== undefined) {
          throw apiError(409, { code: 'quotation_already_exists', whatHappened: `A quotation '${quotationId}' already exists.`, wasItSaved: 'not_saved', nextSafeAction: 'Use a new quotation id, or convert/withdraw the existing one.' });
        }

        const issuedAt = isStr(b['issuedAt']) ? (b['issuedAt'] as string) : deps.now();
        const result = issueQuotation({
          quotationId, tenantId: ctx.tenantId, storeId: b['storeId'] as string, customerRef: b['customerRef'] as string,
          currency: b['currency'] as string, lines, issuedBy: ctx.userId, issuedAt, validUntil: b['validUntil'] as string,
          ...(isInt(b['marginFloorBps']) ? { marginFloorBps: b['marginFloorBps'] as number } : {}),
          ...(approval !== undefined ? { approval } : {}),
        });
        if (!result.issued || result.quotation === undefined) {
          throw apiError(422, { code: `quotation_${result.outcome}`, whatHappened: result.detail, wasItSaved: 'not_saved', nextSafeAction: 'Nothing was quoted. Address the reason and issue again.' });
        }
        await deps.record(ctx.tenantId, result.quotation);
        return { status: 201, body: { quotationId, state: 'issued', totalMinor: result.quotation.totalMinor, validUntil: result.quotation.validUntil } };
      },
    },
    {
      // CONVERT — ring up the promised prices while the quote is still valid. Idempotent: a second convert
      // returns the sale that already exists. An expired / withdrawn quote is refused, not silently re-priced.
      api: 'API-05', method: 'POST', path: '/v1/pos/quotations/:quotationId/convert',
      permission: 'pos.quotation.write', idempotent: true,
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
          return { status: 200, body: { quotationId, converted: false, alreadyConverted: true, saleId: result.saleId } };
        }
        if (!result.converted) {
          throw apiError(422, { code: `quotation_${result.outcome}`, whatHappened: result.detail, wasItSaved: 'not_saved', nextSafeAction: 'Nothing was rung up. Re-quote if the price is to change.' });
        }
        await deps.record(ctx.tenantId, result.quotation);
        return { status: 200, body: { quotationId, converted: true, saleId: result.saleId, saleLines: result.saleLines } };
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
        const today = isStr(ctx.query['today']) ? (ctx.query['today'] as string) : deps.now().slice(0, 10);
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
