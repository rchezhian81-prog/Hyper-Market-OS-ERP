// API-02 Compensation-cess schedule per HSN (roadmap v2.1 A7 · GST (Compensation to States) Act 2017 · GST 2.0 holdover).
//
// Tobacco and pan-masala are held over on 28% GST PLUS a compensation cess (ad-valorem, specific, or both). The cess a
// product carries is decided by its HSN and the date — so, like the GST rate (`tax-classes.ts`), it is an effective-dated
// SCHEDULE per HSN, and the rates are DATA the owner enters as the CA confirms them (§4 of the full-roadmap audit), never
// code. The catalogue pack carries the cess in force on its build date to every till, signed; the till charges it inside
// the MRP and the bill and the GST return carry it.
//
// Append-only (hard rule #2): a change is a new period from a later date; a different rate on a date that already has one is
// refused as ambiguous; an identical re-send is a no-op. Setting is `catalogue.pack.publish`; reading `catalogue.pack.read`.
//
// Round 4a (M03.md "Permissions (§28): tax change with Finance approval", as the GST rate in `tax-classes.ts`): the FIRST
// cess of an HSN is setting it up; a CHANGE — a new period on an HSN that already has a cess — needs a Finance approver
// through the maker-checker engine (ADR-0024, kind `cess_rate_change`, checker `catalogue.tax.approve`: the accountant and
// the owner), never the person asking. Every set and change is sealed in the audit trail with who asked and who approved.

import type { Route } from '../../kernel/src/index';
import { apiError } from '../../kernel/src/index';
import { cessRateOn, type CessRatePeriod } from '../../../packages/finance/src/cess';
import type { AuditEntry } from '../../../packages/audit/src/index';
import { actionDetails, approvalNamedIn, type ApprovalPort } from '../../identity/src/approval-requests';

export interface CessRateDeps {
  readonly setCess: (tenantId: string, hsnCode: string, period: CessRatePeriod, key: string) => Promise<void> | void;
  readonly schedule: (tenantId: string, hsnCode: string) => Promise<readonly CessRatePeriod[]> | readonly CessRatePeriod[];
  /** Round 4a: head office's maker-checker engine — a cess CHANGE needs a Finance approver. Absent: every approval is unknown. */
  readonly approvals?: ApprovalPort;
  /** Seal a cess set or change into the audit trail (M34-FR-01). Optional on a bare stub. */
  readonly recordAudit?: (tenantId: string, entry: AuditEntry) => Promise<unknown> | void;
  readonly now?: () => string;
}

const cessWords = (p: CessRatePeriod): string => `${p.advaloremBps} bps${p.specificPerQuantityMinor > 0 ? ` + ${p.specificPerQuantityMinor} paise per ${p.perQuantity}` : ''}`;

const isDate = (s: unknown): s is string =>
  typeof s === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(s) && new Date(`${s}T00:00:00.000Z`).toISOString().slice(0, 10) === s;
const isWholeNonNeg = (v: unknown): v is number => typeof v === 'number' && Number.isInteger(v) && v >= 0;
const HSN = /^\d{4,8}$/;

const same = (a: CessRatePeriod, b: CessRatePeriod): boolean =>
  a.advaloremBps === b.advaloremBps && a.specificPerQuantityMinor === b.specificPerQuantityMinor && a.perQuantity === b.perQuantity;

export function cessRateRoutes(deps: CessRateDeps): readonly Route[] {
  return [
    {
      // Set the compensation cess for an HSN from a date. Body: { advaloremBps, specificPerQuantityMinor, perQuantity }.
      // A cess of 0 / 0 from a date is how a cess ENDS — a later period, never a deletion.
      api: 'API-02', method: 'POST', path: '/v1/catalogue/tax-classes/:hsnCode/cess/:effectiveFrom',
      permission: 'catalogue.pack.publish', idempotent: true,
      handler: async (ctx) => {
        const hsnCode = (ctx.params['hsnCode'] ?? '').trim();
        const effectiveFrom = (ctx.params['effectiveFrom'] ?? '').trim();
        const b = (ctx.body ?? {}) as Record<string, unknown>;
        const specific = b['specificPerQuantityMinor'] ?? 0;
        const block = b['perQuantity'] ?? 1;
        if (!HSN.test(hsnCode) || !isDate(effectiveFrom) || !isWholeNonNeg(b['advaloremBps']) || !isWholeNonNeg(specific)
          || !(Number.isInteger(block) && (block as number) > 0)) {
          throw apiError(400, {
            code: 'not_readable_as_a_cess_rate',
            whatHappened: 'Setting a compensation cess needs an HSN (4–8 digits) and a valid YYYY-MM-DD date in the path, and in the body a whole advaloremBps (basis points of the taxable value, e.g. 3600 for 36%), a whole specificPerQuantityMinor (paisa per block, 0 for none) and a positive whole perQuantity (the block, e.g. 1000 sticks).',
            wasItSaved: 'not_saved',
            nextSafeAction: 'Send { advaloremBps, specificPerQuantityMinor, perQuantity } with the HSN and date in the URL. Use the rates the CA confirmed. Nothing was saved.',
          });
        }
        const period: CessRatePeriod = { effectiveFrom, advaloremBps: b['advaloremBps'], specificPerQuantityMinor: specific, perQuantity: block as number };
        const existing = (await deps.schedule(ctx.tenantId, hsnCode)).find((p) => p.effectiveFrom === effectiveFrom);
        if (existing !== undefined) {
          if (!same(existing, period)) {
            throw apiError(409, {
              code: 'cess_already_set_on_that_date',
              whatHappened: `HSN "${hsnCode}" already has a compensation cess from ${effectiveFrom}; a different cess cannot also start that day — a sale that day could be taxed two ways.`,
              wasItSaved: 'not_saved',
              nextSafeAction: 'To change the cess, set the new rate from a LATER date. Nothing was changed.',
            });
          }
          return { status: 201, body: { cess: existing } };
        }
        // Round 4a (M03-FR-03 §28): an HSN that already has a cess is CHANGED only with a Finance approver's approval.
        const before = [...(await deps.schedule(ctx.tenantId, hsnCode))].sort((x, y) => (x.effectiveFrom < y.effectiveFrom ? -1 : 1));
        const now = deps.now?.() ?? new Date().toISOString();
        const opened = await approvalNamedIn(deps.approvals, {
          tenantId: ctx.tenantId, approvalId: b['approvalId'], typedField: 'approvedBy', typedValue: b['approvedBy'],
          kind: 'cess_rate_change', subjectRef: hsnCode, details: actionDetails(ctx.body, { hsnCode, effectiveFrom }), valueMinor: null,
          maker: ctx.userId, usedBy: `cess-rate:${hsnCode}:${effectiveFrom}`, now,
        });
        if (before.length > 0 && opened === undefined) {
          const inForce = before.filter((p) => p.effectiveFrom <= effectiveFrom).at(-1) ?? before[0]!;
          throw apiError(422, {
            code: 'cess_change_needs_finance_approval',
            whatHappened: `HSN "${hsnCode}" already carries a compensation cess of ${cessWords(inForce)} (from ${inForce.effectiveFrom}); changing it to ${cessWords(period)} from ${effectiveFrom} is a tax change, which needs a Finance approver (the accountant or the owner) — never the person asking.`,
            wasItSaved: 'not_saved',
            nextSafeAction: 'Ask for approval (POST /v1/approvals/requests, kind cess_rate_change, subjectRef the HSN, with exactly this change and the HSN and date); once a Finance approver approves it, send the approvalId. Nothing was changed.',
          });
        }
        await opened?.spend();
        await deps.setCess(ctx.tenantId, hsnCode, period, ctx.idempotencyKey ?? `${hsnCode}:${effectiveFrom}`);
        await deps.recordAudit?.(ctx.tenantId, {
          actorId: ctx.userId, action: before.length === 0 ? 'catalogue.cess_rate.set' : 'catalogue.cess_rate.change', objectType: 'tax_class', objectId: hsnCode,
          at: now, origin: { tenantId: ctx.tenantId, branchId: ctx.branchId ?? null },
          before: before.length === 0 ? null : { schedule: before.map((p) => `${p.effectiveFrom}:${p.advaloremBps}/${p.specificPerQuantityMinor}/${p.perQuantity}`).join(',') },
          after: { effectiveFrom, advaloremBps: String(period.advaloremBps), specificPerQuantityMinor: String(period.specificPerQuantityMinor), perQuantity: String(period.perQuantity), approvedBy: opened?.decision.decidedBy ?? '' },
          ...(opened === undefined ? {} : { approvalId: opened.decision.requestId }),
          correlationId: `cess-rate:${hsnCode}:${effectiveFrom}`,
        });
        return { status: 201, body: { cess: period, ...(opened === undefined ? {} : { approvedBy: opened.decision.decidedBy }) } };
      },
    },
    {
      // The schedule for an HSN, and the cess in force on a date (?on=YYYY-MM-DD) — "none" when not cess-liable then.
      api: 'API-02', method: 'GET', path: '/v1/catalogue/tax-classes/:hsnCode/cess',
      permission: 'catalogue.pack.read',
      handler: async (ctx) => {
        const hsnCode = (ctx.params['hsnCode'] ?? '').trim();
        const on = ctx.query['on'];
        if (!HSN.test(hsnCode) || (on !== undefined && !isDate(on))) {
          throw apiError(400, {
            code: 'not_readable_as_a_cess_rate',
            whatHappened: 'Reading a compensation cess needs an HSN (4–8 digits) in the path, and ?on=YYYY-MM-DD when you ask for the rate on a day.',
            wasItSaved: 'not_saved',
            nextSafeAction: 'Send the HSN, and a valid date if you want the rate in force on it.',
          });
        }
        const schedule = [...await deps.schedule(ctx.tenantId, hsnCode)].sort((a, b) => (a.effectiveFrom < b.effectiveFrom ? -1 : 1));
        const inForce = on === undefined ? undefined : cessRateOn(schedule, on);
        return { status: 200, body: { hsnCode, schedule, ...(on === undefined ? {} : { on, inForce: inForce ?? null, cessLiable: inForce !== undefined }) } };
      },
    },
  ];
}
