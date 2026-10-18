// API-09 Input tax credit through GSTR-2B + IMS (R3 · A17 · M23 · OB-145 "A") — the durable register and its routes.
//
//   • POST /v1/finance/itc/:period/statement           — the accountant uploads the month's GSTR-2B JSON from the portal.
//                                                         Read by the tested engine; a file it cannot read is refused with
//                                                         every problem named, and nothing is kept. The same file again is
//                                                         the same upload; a DIFFERENT file for a month somebody has
//                                                         already acted on is refused (the actions were taken on that one).
//   • GET  /v1/finance/itc/:period                      — the review: every line matched against the booked invoices, its
//                                                         person's action, every exception by name, the totals, the claim.
//   • POST /v1/finance/itc/:period/lines/:lineId/action — accept / reject / keep pending, as the SIGNED-IN person (IMS). A
//                                                         reject or a pending needs a reason; only a matched line may be
//                                                         accepted. Append-only: a change of mind is a newer action.
//   • POST /v1/finance/itc/:period/reversals/:reversalId — a Rule 37 / 42 / 43 or free-sample reversal, a compensating
//                                                         record of its own (hard rule #2).
//   • GET  /v1/finance/itc/:period/claim                — what GSTR-3B Table 4 may claim (the `itcForPeriod` port's answer).
//
// The engine is `packages/input-tax`; the books and the store are head office's (`services/api/src/r3-tax-pay-adapters.ts`).

import type { Route } from '../../kernel/src/index';
import { apiError, notFound } from '../../kernel/src/index';
import {
  readGstr2b, reviewItc, mayAccept, isPeriod, readReversalAmounts, ITC_ACTIONS, REVERSAL_RULES,
  type Gstr2bStatement, type BookedInvoice, type ItcLineAction, type ItcReversal, type ItcAction, type ReversalRule, type ItcReview,
} from '../../../packages/input-tax/src/index';
import type { AuditEntry } from '../../../packages/audit/src/index';

/** A month's uploaded statement as kept: the statement, a fingerprint of the file, who uploaded it and when. */
export interface StoredStatement {
  readonly statement: Gstr2bStatement;
  readonly fingerprint: string;
  readonly uploadedBy: string;
  readonly uploadedAt: string;
}

export interface ItcStoreDeps {
  /** The latest upload per month, every month. */
  readonly statements: (tenantId: string) => Promise<readonly StoredStatement[]> | readonly StoredStatement[];
  readonly recordStatement: (tenantId: string, stored: StoredStatement) => Promise<void> | void;
  /** The shop's booked supplier invoices, as the match reads them. */
  readonly booked: (tenantId: string) => Promise<readonly BookedInvoice[]> | readonly BookedInvoice[];
  readonly actions: (tenantId: string) => Promise<readonly ItcLineAction[]> | readonly ItcLineAction[];
  readonly recordAction: (tenantId: string, action: ItcLineAction) => Promise<void> | void;
  readonly reversals: (tenantId: string) => Promise<readonly ItcReversal[]> | readonly ItcReversal[];
  /** Record a reversal once per id; returns the one that stands (a second writer of the same id gets the first). */
  readonly recordReversal: (tenantId: string, reversal: ItcReversal) => Promise<ItcReversal> | ItcReversal;
  /** A short, stable fingerprint of an uploaded file (sha-256 of its canonical JSON). */
  readonly fingerprint: (raw: unknown) => string;
  readonly recordAudit?: (tenantId: string, entry: AuditEntry) => Promise<unknown> | void;
  readonly now: () => string;
}

const isStr = (v: unknown): v is string => typeof v === 'string' && v.trim() !== '';

const periodOrRefuse = (raw: string | undefined): string => {
  const period = (raw ?? '').trim();
  if (!isPeriod(period)) {
    throw apiError(400, { code: 'itc_period_not_a_month', whatHappened: `"${period}" is not a month — the ITC review is by month, YYYY-MM.`, wasItSaved: 'not_saved', nextSafeAction: 'Send the month as YYYY-MM. Nothing was changed.' });
  }
  return period;
};

/** The month's review, folded from the stored facts. */
export async function loadItcReview(deps: Pick<ItcStoreDeps, 'statements' | 'booked' | 'actions' | 'reversals'>, tenantId: string, period: string): Promise<ItcReview> {
  const [statements, booked, actions, reversals] = await Promise.all([
    Promise.resolve(deps.statements(tenantId)), Promise.resolve(deps.booked(tenantId)),
    Promise.resolve(deps.actions(tenantId)), Promise.resolve(deps.reversals(tenantId)),
  ]);
  return reviewItc({ period, statements: statements.map((s) => s.statement), booked, actions, reversals });
}

export function itcStoreRoutes(deps: ItcStoreDeps): readonly Route[] {
  const audit = async (tenantId: string, entry: AuditEntry) => { await deps.recordAudit?.(tenantId, entry); };
  return [
    {
      api: 'API-09', method: 'POST', path: '/v1/finance/itc/:period/statement',
      permission: 'finance.itc.import', idempotent: true,
      handler: async (ctx) => {
        const period = periodOrRefuse(ctx.params['period']);
        const raw = (ctx.body as { statement?: unknown } | null)?.statement;
        if (raw === undefined) {
          throw apiError(400, { code: 'itc_statement_missing', whatHappened: 'Send the GSTR-2B file as downloaded from the GST portal, in { statement: … }.', wasItSaved: 'not_saved', nextSafeAction: 'Download the month\'s GSTR-2B (JSON) from the portal and upload it. Nothing was kept.' });
        }
        const read = readGstr2b(raw);
        if (!read.ok) {
          throw apiError(422, { code: 'gstr2b_not_readable', whatHappened: `The GSTR-2B file could not be read: ${read.problems.join('; ')}.`, wasItSaved: 'not_saved', nextSafeAction: 'Download the file from the portal again and upload it unchanged. Nothing was kept.' });
        }
        if (read.statement.period !== period) {
          throw apiError(422, { code: 'gstr2b_for_another_month', whatHappened: `This file is the GSTR-2B for ${read.statement.period}, not ${period}.`, wasItSaved: 'not_saved', nextSafeAction: `Upload it on the ${read.statement.period} review, or download the ${period} file. Nothing was kept.` });
        }
        const fingerprint = deps.fingerprint(raw);
        const existing = (await deps.statements(ctx.tenantId)).find((s) => s.statement.period === period);
        if (existing !== undefined && existing.fingerprint === fingerprint) {
          return { status: 200, body: { period, lines: existing.statement.lines.length, alreadyUploaded: true, uploadedBy: existing.uploadedBy, uploadedAt: existing.uploadedAt } };
        }
        if (existing !== undefined && (await deps.actions(ctx.tenantId)).some((a) => a.period === period)) {
          throw apiError(409, {
            code: 'gstr2b_already_acted_on',
            whatHappened: `A different GSTR-2B for ${period} was uploaded by ${existing.uploadedBy} and people have already accepted, rejected or kept lines of it pending. Replacing it would change what they decided on.`,
            wasItSaved: 'not_saved',
            nextSafeAction: 'Keep the month as it is; a correction the supplier makes appears in a later month\'s GSTR-2B. Nothing was kept.',
          });
        }
        const stored: StoredStatement = { statement: read.statement, fingerprint, uploadedBy: ctx.userId, uploadedAt: deps.now() };
        await deps.recordStatement(ctx.tenantId, stored);
        await audit(ctx.tenantId, {
          actorId: ctx.userId, action: 'finance.itc.statement.upload', objectType: 'gstr2b', objectId: period, at: stored.uploadedAt,
          origin: { tenantId: ctx.tenantId, branchId: ctx.branchId ?? null }, before: existing === undefined ? null : { fingerprint: existing.fingerprint },
          after: { fingerprint, lines: String(read.statement.lines.length), recipientGstin: read.statement.recipientGstin }, correlationId: period,
        });
        return { status: 201, body: { period, lines: read.statement.lines.length, alreadyUploaded: false, uploadedBy: stored.uploadedBy, uploadedAt: stored.uploadedAt, replaced: existing !== undefined } };
      },
    },
    {
      api: 'API-09', method: 'GET', path: '/v1/finance/itc/:period/claim',
      permission: 'finance.itc.read',
      handler: async (ctx) => {
        const period = periodOrRefuse(ctx.params['period']);
        return { status: 200, body: { period, claim: (await loadItcReview(deps, ctx.tenantId, period)).claim, asAt: deps.now() } };
      },
    },
    {
      api: 'API-09', method: 'GET', path: '/v1/finance/itc/:period',
      permission: 'finance.itc.read',
      handler: async (ctx) => {
        const period = periodOrRefuse(ctx.params['period']);
        const review = await loadItcReview(deps, ctx.tenantId, period);
        const stored = (await deps.statements(ctx.tenantId)).find((s) => s.statement.period === period);
        return { status: 200, body: { ...review, uploadedBy: stored?.uploadedBy ?? null, uploadedAt: stored?.uploadedAt ?? null, recipientGstin: stored?.statement.recipientGstin ?? null, asAt: deps.now() } };
      },
    },
    {
      api: 'API-09', method: 'POST', path: '/v1/finance/itc/:period/lines/:lineId/action',
      permission: 'finance.itc.action', idempotent: true,
      handler: async (ctx) => {
        const period = periodOrRefuse(ctx.params['period']);
        const lineId = (ctx.params['lineId'] ?? '').trim();
        const b = (ctx.body ?? {}) as Record<string, unknown>;
        const action = ITC_ACTIONS.find((a) => a === b['action']);
        if (b['by'] !== undefined || b['actedBy'] !== undefined) {
          throw apiError(400, { code: 'itc_action_names_a_person', whatHappened: 'An action is taken by the person signed in; a body cannot name who took it.', wasItSaved: 'not_saved', nextSafeAction: 'Send { action, reason? } only. Nothing was recorded.' });
        }
        if (action === undefined || (b['reason'] !== undefined && typeof b['reason'] !== 'string')) {
          throw apiError(400, { code: 'not_readable_as_an_itc_action', whatHappened: 'An action is { action: accept / reject / pending, reason? }.', wasItSaved: 'not_saved', nextSafeAction: 'Send the action. Nothing was recorded.' });
        }
        const reason = isStr(b['reason']) ? b['reason'].trim().slice(0, 300) : null;
        if (action !== 'accept' && reason === null) {
          throw apiError(422, { code: 'itc_action_needs_a_reason', whatHappened: `To ${action === 'reject' ? 'reject a line' : 'keep a line pending'} the reason must be written — the supplier is told through the portal, and the next person needs to know why.`, wasItSaved: 'not_saved', nextSafeAction: 'Write the reason and send it again. Nothing was recorded.' });
        }
        const review = await loadItcReview(deps, ctx.tenantId, period);
        if (!review.imported) throw notFound(`a GSTR-2B for ${period}`);
        const line = review.lines.find((l) => l.lineId === lineId);
        if (line === undefined) throw notFound(`line ${lineId} in the ${period} GSTR-2B`);
        if (action === 'accept' && !mayAccept(line)) {
          const why = line.match === 'not_in_books' ? `the shop has no booked, three-way-matched invoice ${line.invoiceNo} from ${line.supplierGstin}`
            : line.match === 'in_an_earlier_2b' ? `this bill was already in the ${line.earlierPeriod} GSTR-2B`
              : `the booked invoice differs on ${line.differences.join(', ')}`;
          throw apiError(422, { code: 'itc_line_not_matched', whatHappened: `Line ${line.invoiceNo} (${line.supplierGstin}) cannot be accepted: ${why}. Credit is claimed only for an invoice the shop holds as the supplier reported it.`, wasItSaved: 'not_saved', nextSafeAction: 'Book or correct the invoice and match it, or reject the line or keep it pending with a reason. Nothing was recorded.' });
        }
        const at = deps.now();
        const latest = line.state === 'awaiting_a_person' ? null : { action: line.state, by: line.actedBy, reason: line.reason };
        const same = latest !== null && latest.by === ctx.userId && latest.reason === reason
          && ((action === 'accept' && latest.action === 'accepted') || (action === 'reject' && latest.action === 'rejected') || (action === 'pending' && latest.action === 'pending'));
        if (same) return { status: 200, body: { period, lineId, state: line.state, actedBy: line.actedBy, actedAt: line.actedAt, alreadyRecorded: true } };
        const recorded: ItcLineAction = { period, lineId, action: action as ItcAction, by: ctx.userId, at, reason };
        await deps.recordAction(ctx.tenantId, recorded);
        await audit(ctx.tenantId, {
          actorId: ctx.userId, action: `finance.itc.line.${action}`, objectType: 'gstr2b_line', objectId: `${period}/${lineId}`, at,
          origin: { tenantId: ctx.tenantId, branchId: ctx.branchId ?? null }, before: latest === null ? null : { state: latest.action, by: latest.by ?? '' },
          after: { action, supplierGstin: line.supplierGstin, invoiceNo: line.invoiceNo, reason: reason ?? '' }, ...(reason === null ? {} : { reason }), correlationId: period,
        });
        const state = action === 'accept' ? 'accepted' : action === 'reject' ? 'rejected' : 'pending';
        return { status: 201, body: { period, lineId, state, actedBy: ctx.userId, actedAt: at, alreadyRecorded: false } };
      },
    },
    {
      api: 'API-09', method: 'POST', path: '/v1/finance/itc/:period/reversals/:reversalId',
      permission: 'finance.itc.action', idempotent: true,
      handler: async (ctx) => {
        const period = periodOrRefuse(ctx.params['period']);
        const reversalId = (ctx.params['reversalId'] ?? '').trim();
        const b = (ctx.body ?? {}) as Record<string, unknown>;
        const rule = REVERSAL_RULES.find((r) => r === b['rule']);
        const amounts = readReversalAmounts(b);
        if (reversalId === '' || rule === undefined || amounts === null || !isStr(b['sourceRef']) || !isStr(b['reason'])) {
          throw apiError(400, { code: 'not_readable_as_an_itc_reversal', whatHappened: `A reversal is { rule (${REVERSAL_RULES.join(' / ')}), sourceRef (the invoice, line or free-sample record), reason, igstMinor / cgstMinor / sgstMinor / cessMinor (whole paise, at least one above zero) }.`, wasItSaved: 'not_saved', nextSafeAction: 'Send the reversal. Nothing was recorded.' });
        }
        const prior = (await deps.reversals(ctx.tenantId)).find((r) => r.reversalId === reversalId);
        if (prior !== undefined) return { status: 200, body: { reversal: prior, alreadyRecorded: true } };
        const reversal: ItcReversal = { reversalId, period, rule: rule as ReversalRule, sourceRef: b['sourceRef'].trim(), reason: b['reason'].trim().slice(0, 300), ...amounts, by: ctx.userId, at: deps.now() };
        const standing = await deps.recordReversal(ctx.tenantId, reversal);
        await audit(ctx.tenantId, {
          actorId: ctx.userId, action: 'finance.itc.reversal', objectType: 'itc_reversal', objectId: reversalId, at: reversal.at,
          origin: { tenantId: ctx.tenantId, branchId: ctx.branchId ?? null }, before: null,
          after: { period, rule, sourceRef: reversal.sourceRef, igstMinor: String(reversal.igstMinor), cgstMinor: String(reversal.cgstMinor), sgstMinor: String(reversal.sgstMinor), cessMinor: String(reversal.cessMinor) },
          reason: reversal.reason, correlationId: period,
        });
        return { status: 201, body: { reversal: standing, alreadyRecorded: standing.by !== ctx.userId || standing.at !== reversal.at } };
      },
    },
  ];
}
