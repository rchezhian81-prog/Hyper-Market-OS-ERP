// API-09 Card and UPI payment disputes (R3 · C14 · NPCI UPI dispute rules) — the durable register and its routes.
//
//   • POST /v1/finance/payment-disputes/:disputeId           — record a dispute notice: the instrument, the provider's
//                                                               case reference (never card data — hard rule #3), the
//                                                               amount, the day received, and the bill. The reply-by date
//                                                               is UPI: 15 days after receipt (computed); card: the date on
//                                                               the acquiring bank's notice. Once per id.
//   • POST /v1/finance/payment-disputes/:disputeId/response  — record the answer sent (the evidence pack's reference). Once.
//   • POST /v1/finance/payment-disputes/:disputeId/outcome   — won or lost, once. A lost dispute posts its compensating
//                                                               entry in the same fact; the sale is never edited.
//   • GET  /v1/finance/payment-disputes?asOf=                — the register, overdue first, and the OWNER's exceptions:
//                                                               every dispute not answered by its due date.
//
// The engine is `packages/payment-disputes`.

import type { Route } from '../../kernel/src/index';
import { apiError, notFound } from '../../kernel/src/index';
import {
  respondByFor, disputeViews, disputeExceptions, lossEntryFor, isIsoDate, DISPUTE_INSTRUMENTS, UPI_DISPUTE_RESPONSE_DAYS,
  type DisputeRecord, type DisputeResponse, type DisputeOutcome, type DisputeInstrument,
} from '../../../packages/payment-disputes/src/index';
import { containsCardNumber } from '../../../packages/tender/src/card-token';
import type { AuditEntry } from '../../../packages/audit/src/index';

export interface PaymentDisputeDeps {
  readonly disputes: (tenantId: string) => Promise<readonly DisputeRecord[]> | readonly DisputeRecord[];
  readonly responses: (tenantId: string) => Promise<readonly DisputeResponse[]> | readonly DisputeResponse[];
  readonly outcomes: (tenantId: string) => Promise<readonly DisputeOutcome[]> | readonly DisputeOutcome[];
  /** Each records once per dispute id and returns the one that stands. */
  readonly recordDispute: (tenantId: string, d: DisputeRecord) => Promise<DisputeRecord> | DisputeRecord;
  readonly recordResponse: (tenantId: string, r: DisputeResponse) => Promise<DisputeResponse> | DisputeResponse;
  readonly recordOutcome: (tenantId: string, o: DisputeOutcome) => Promise<DisputeOutcome> | DisputeOutcome;
  /** How much a bill was paid by an instrument — undefined when head office has not banked the bill. */
  readonly paidBy: (tenantId: string, saleId: string, instrument: DisputeInstrument) => Promise<number | undefined> | number | undefined;
  readonly recordAudit?: (tenantId: string, entry: AuditEntry) => Promise<unknown> | void;
  readonly now: () => string;
}

const isStr = (v: unknown): v is string => typeof v === 'string' && v.trim() !== '';
const cardDataRefusal = () => apiError(422, {
  code: 'looks_like_card_data', whatHappened: 'A reference or note holds what looks like a card number. Card numbers, CVVs and expiry dates are never kept (hard rule #3).',
  wasItSaved: 'not_saved', nextSafeAction: 'Send the provider\'s case or transaction reference instead. Nothing was recorded.',
});

export function paymentDisputeRoutes(deps: PaymentDisputeDeps): readonly Route[] {
  const audit = async (t: string, e: AuditEntry) => { await deps.recordAudit?.(t, e); };
  const find = async (t: string, id: string) => (await deps.disputes(t)).find((d) => d.disputeId === id);
  return [
    {
      api: 'API-09', method: 'GET', path: '/v1/finance/payment-disputes',
      permission: 'payment.dispute.read',
      handler: async (ctx) => {
        const asOfRaw = ctx.query['asOf'];
        if (asOfRaw !== undefined && !isIsoDate(asOfRaw)) {
          throw apiError(400, { code: 'disputes_need_a_date', whatHappened: '?asOf must be YYYY-MM-DD (default today).', wasItSaved: 'not_saved', nextSafeAction: 'Send a date or leave it out. A read never writes.' });
        }
        const asOf = asOfRaw ?? deps.now().slice(0, 10);
        const [disputes, responses, outcomes] = await Promise.all([deps.disputes(ctx.tenantId), deps.responses(ctx.tenantId), deps.outcomes(ctx.tenantId)]);
        const views = disputeViews({ disputes, responses, outcomes, asOf });
        const exceptions = disputeExceptions(views);
        const lossEntries = outcomes.flatMap((o) => (o.lossEntry === null ? [] : [o.lossEntry]));
        return {
          status: 200,
          body: {
            asOf, upiResponseDays: UPI_DISPUTE_RESPONSE_DAYS, disputes: views, ownerExceptions: exceptions,
            open: views.filter((v) => v.state === 'open').length, lostMinor: lossEntries.reduce((s, e) => s + e.amountMinor, 0), lossEntries,
          },
        };
      },
    },
    {
      api: 'API-09', method: 'POST', path: '/v1/finance/payment-disputes/:disputeId',
      permission: 'payment.dispute.record', idempotent: true,
      handler: async (ctx) => {
        const disputeId = (ctx.params['disputeId'] ?? '').trim();
        const b = (ctx.body ?? {}) as Record<string, unknown>;
        const instrument = DISPUTE_INSTRUMENTS.find((i) => i === b['instrument']);
        if (disputeId === '' || instrument === undefined || !isStr(b['providerRef']) || !Number.isSafeInteger(b['amountMinor']) || (b['amountMinor'] as number) <= 0
          || !isStr(b['reason']) || (b['saleId'] !== undefined && b['saleId'] !== null && !isStr(b['saleId'])) || (b['respondBy'] !== undefined && typeof b['respondBy'] !== 'string')) {
          throw apiError(400, { code: 'not_readable_as_a_payment_dispute', whatHappened: 'A dispute is { instrument (upi / card), providerRef (the bank\'s case or transaction reference), amountMinor, receivedOn (YYYY-MM-DD), reason, saleId?, respondBy? (a card\'s reply-by date from the bank\'s notice) }.', wasItSaved: 'not_saved', nextSafeAction: 'Send the dispute as the bank\'s notice states it. Nothing was recorded.' });
        }
        if (containsCardNumber(b['providerRef']) || containsCardNumber(b['reason'])) throw cardDataRefusal();
        const due = respondByFor({ instrument, receivedOn: String(b['receivedOn'] ?? ''), ...(typeof b['respondBy'] === 'string' ? { statedRespondBy: b['respondBy'] } : {}) });
        if ('problem' in due) {
          throw apiError(422, { code: 'dispute_due_date_not_known', whatHappened: `The answer-by date cannot be set: ${due.problem}.`, wasItSaved: 'not_saved', nextSafeAction: 'Send the dates from the bank\'s notice. Nothing was recorded.' });
        }
        const prior = await find(ctx.tenantId, disputeId);
        if (prior !== undefined) return { status: 200, body: { dispute: prior, alreadyRecorded: true } };
        const saleId = isStr(b['saleId']) ? b['saleId'].trim() : null;
        if (saleId !== null) {
          const paid = await deps.paidBy(ctx.tenantId, saleId, instrument);
          if (paid === undefined) throw notFound(`sale ${saleId}`);
          if ((b['amountMinor'] as number) > paid) {
            throw apiError(422, { code: 'dispute_more_than_paid', whatHappened: `Bill ${saleId} was paid ${paid} paise by ${instrument}; a dispute of ${b['amountMinor']} is more than that.`, wasItSaved: 'not_saved', nextSafeAction: 'Check the bill and the amount on the bank\'s notice. Nothing was recorded.' });
          }
        }
        const d: DisputeRecord = {
          disputeId, instrument, saleId, providerRef: b['providerRef'].trim(), amountMinor: b['amountMinor'] as number,
          receivedOn: String(b['receivedOn']), respondBy: due.respondBy, reason: b['reason'].trim().slice(0, 300), recordedBy: ctx.userId, recordedAt: deps.now(),
        };
        const standing = await deps.recordDispute(ctx.tenantId, d);
        await audit(ctx.tenantId, {
          actorId: ctx.userId, action: 'payment.dispute.record', objectType: 'payment_dispute', objectId: disputeId, at: d.recordedAt,
          origin: { tenantId: ctx.tenantId, branchId: ctx.branchId ?? null }, before: null,
          after: { instrument, saleId: saleId ?? '', amountMinor: String(d.amountMinor), receivedOn: d.receivedOn, respondBy: d.respondBy }, correlationId: disputeId,
        });
        return { status: 201, body: { dispute: standing, alreadyRecorded: false } };
      },
    },
    {
      api: 'API-09', method: 'POST', path: '/v1/finance/payment-disputes/:disputeId/response',
      permission: 'payment.dispute.record', idempotent: true,
      handler: async (ctx) => {
        const disputeId = (ctx.params['disputeId'] ?? '').trim();
        const b = (ctx.body ?? {}) as Record<string, unknown>;
        if (!isIsoDate(b['respondedOn']) || !isStr(b['evidenceRef'])) {
          throw apiError(400, { code: 'not_readable_as_a_dispute_response', whatHappened: 'An answer is { respondedOn (YYYY-MM-DD), evidenceRef (the evidence pack as the bank received it) }.', wasItSaved: 'not_saved', nextSafeAction: 'Send the answer. Nothing was recorded.' });
        }
        if (containsCardNumber(b['evidenceRef'])) throw cardDataRefusal();
        const d = await find(ctx.tenantId, disputeId);
        if (d === undefined) throw notFound(`payment dispute ${disputeId}`);
        if (b['respondedOn'] < d.receivedOn) throw apiError(422, { code: 'answered_before_received', whatHappened: `The answer date ${b['respondedOn']} is before the notice was received (${d.receivedOn}).`, wasItSaved: 'not_saved', nextSafeAction: 'Check the date. Nothing was recorded.' });
        const prior = (await deps.responses(ctx.tenantId)).find((r) => r.disputeId === disputeId);
        if (prior !== undefined) return { status: 200, body: { response: prior, alreadyRecorded: true } };
        if ((await deps.outcomes(ctx.tenantId)).some((o) => o.disputeId === disputeId)) {
          throw apiError(409, { code: 'dispute_already_decided', whatHappened: `Dispute ${disputeId} is already decided; an answer can no longer be recorded.`, wasItSaved: 'not_saved', nextSafeAction: 'Nothing was recorded.' });
        }
        const r: DisputeResponse = { disputeId, respondedOn: b['respondedOn'], evidenceRef: b['evidenceRef'].trim(), by: ctx.userId, at: deps.now() };
        const standing = await deps.recordResponse(ctx.tenantId, r);
        await audit(ctx.tenantId, {
          actorId: ctx.userId, action: 'payment.dispute.respond', objectType: 'payment_dispute', objectId: disputeId, at: r.at,
          origin: { tenantId: ctx.tenantId, branchId: ctx.branchId ?? null }, before: { state: 'open' },
          after: { respondedOn: r.respondedOn, evidenceRef: r.evidenceRef, late: String(r.respondedOn > d.respondBy) }, correlationId: disputeId,
        });
        return { status: 201, body: { response: standing, answeredLate: standing.respondedOn > d.respondBy, alreadyRecorded: false } };
      },
    },
    {
      api: 'API-09', method: 'POST', path: '/v1/finance/payment-disputes/:disputeId/outcome',
      permission: 'payment.dispute.record', idempotent: true,
      handler: async (ctx) => {
        const disputeId = (ctx.params['disputeId'] ?? '').trim();
        const b = (ctx.body ?? {}) as Record<string, unknown>;
        if ((b['outcome'] !== 'won' && b['outcome'] !== 'lost') || !isIsoDate(b['decidedOn'])) {
          throw apiError(400, { code: 'not_readable_as_a_dispute_outcome', whatHappened: 'An outcome is { outcome (won / lost), decidedOn (YYYY-MM-DD) }.', wasItSaved: 'not_saved', nextSafeAction: 'Send the outcome the bank gave. Nothing was recorded.' });
        }
        const d = await find(ctx.tenantId, disputeId);
        if (d === undefined) throw notFound(`payment dispute ${disputeId}`);
        const prior = (await deps.outcomes(ctx.tenantId)).find((o) => o.disputeId === disputeId);
        if (prior !== undefined) {
          if (prior.outcome !== b['outcome']) throw apiError(409, { code: 'dispute_already_decided', whatHappened: `Dispute ${disputeId} was already recorded as ${prior.outcome} by ${prior.by}. An outcome is recorded once.`, wasItSaved: 'not_saved', nextSafeAction: 'If the bank reversed its decision, record it as a new dispute with the bank\'s new reference. Nothing was recorded.' });
          return { status: 200, body: { outcome: prior, alreadyRecorded: true } };
        }
        const o: DisputeOutcome = {
          disputeId, outcome: b['outcome'], decidedOn: b['decidedOn'], by: ctx.userId, at: deps.now(),
          lossEntry: b['outcome'] === 'lost' ? lossEntryFor(d, b['decidedOn']) : null,
        };
        const standing = await deps.recordOutcome(ctx.tenantId, o);
        await audit(ctx.tenantId, {
          actorId: ctx.userId, action: `payment.dispute.${o.outcome}`, objectType: 'payment_dispute', objectId: disputeId, at: o.at,
          origin: { tenantId: ctx.tenantId, branchId: ctx.branchId ?? null }, before: null,
          after: { outcome: o.outcome, decidedOn: o.decidedOn, lossMinor: String(o.lossEntry?.amountMinor ?? 0) }, correlationId: disputeId,
        });
        return { status: 201, body: { outcome: standing, alreadyRecorded: false } };
      },
    },
  ];
}
