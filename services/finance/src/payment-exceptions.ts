// API-09 Payment exceptions carried forward from a store's day close (OB-55 "A", owner 11 Oct 2026 · D04-FR-02 · PF-06 ·
// WF-12 "tender settlement" · M14-FR-04 · P-03 · P-08 · hard rules #2, #3, #10).
//
// A card or UPI payment the machine never gave a final answer on used to hold the store's day close until the provider
// answered. The owner chose to let the manager close anyway — but ONLY with their own PIN and a SECOND person's approval on
// the store computer, naming every pending payment — and to carry each one to head office as a named finance exception.
// Here:
//
//   • CARRIED — the store's relayed day close names each payment; each becomes ONE exception, keyed on its attempt id (the
//     close re-sent after a lost reply carries nothing twice). Who approved it is re-checked here (their grants, and the
//     store computer's seal on them) and any doubt is a FLAG on the exception — never a refusal: the day closed at the
//     store (hard rule #10);
//   • SHOWN — the finance/owner list says what is still open, by store, trading day and kind, and the day's tender figures
//     carry the unresolved amounts beside what was taken;
//   • RESOLVED ONCE — by the provider's own answer: either relayed from the store computer (the till's Check payment, which
//     reads the provider's record) or the provider's record given to head office directly, ruled by the same tested
//     `recoverPendingTender` engine. Never by a person's say-so. The first resolution stands; the same one again is a no-op;
//     a DIFFERENT one is refused and recorded as a visible conflict, never a silent last-write-wins (hard rule #10).
//
//   • RAISED AT ONCE — OB-69 "A" (owner, 11 Oct 2026, "The moment it happens"): finance no longer waits for the day close.
//     The store computer relays each attempt the till records as NO ANSWER the moment it is recorded (queued on the box
//     while the line is down, sent on reconnect) — ONE open item per attempt (`stage: 'raised'`). The day close that later
//     carries the same attempt makes that same item `carried`, never a second one, so it is counted once in the open total
//     and the day's tender figures; the provider's answer resolves it once either way.
//
// Every fact is appended, never edited (hard rule #2). A provider reference that looks like a card number is refused
// (hard rule #3).

import type { Route } from '../../kernel/src/index';
import { apiError } from '../../kernel/src/index';
import { recoverPendingTender, type ProviderAuthorisation } from '../../../packages/tender/src/pending-recovery';
import { looksLikeCardNumber } from '../../../packages/ops/src/index';

/** One payment a store's day close carried forward, as the store computer named it. */
export interface CarriedPayment {
  readonly attemptId: string;
  readonly laneId: string;
  readonly billRef: string;
  readonly kind: 'card' | 'upi';
  readonly amountMinor: number;
  readonly askedAt: string;
  readonly state: 'asked' | 'no_answer';
  /** The trading day the payment was asked on — the day whose tender figures it leaves unresolved. */
  readonly tradingDay: string;
}

/**
 * A card/UPI payment with no final answer as head office holds it — ONE per attempt. OB-69 "A" (owner, 11 Oct 2026, "The
 * moment it happens"): it is first RAISED when the store computer records the machine's no-answer (relayed at once, or on
 * reconnect) — `stage: 'raised'`, no day close yet (the close fields are null); the store's day close that later carries the
 * same attempt makes it `stage: 'carried'` — the SAME item, never a second one.
 */
export interface PaymentException extends CarriedPayment {
  readonly storeId: string;
  readonly dayCloseId: string | null;
  readonly closedBy: string | null;
  readonly approvedBy: string | null;
  readonly approvalId: string | null;
  readonly reason: string | null;
  readonly carriedAt: string | null;
  /** What head office found when it re-checked the approver (record-and-flag, never a refusal). */
  readonly governanceFlags: readonly string[];
  /** OB-69: where it stands — raised at the no-answer, or carried by a day close. Absent on records from before OB-69 (carried). */
  readonly stage?: 'raised' | 'carried';
  /** OB-69: when the store computer recorded the no-answer and relayed it (null: it reached head office only with the close). */
  readonly raisedAt?: string | null;
}

/** OB-69: a no-answer the store computer relayed the moment it recorded it — before any day close. */
export interface RaisedNoAnswer extends CarriedPayment {
  readonly storeId: string;
  /** When the till recorded the machine's no-answer. */
  readonly recordedAt: string;
  readonly recordedBy: string;
  /** Who relayed it (the store computer's credential). */
  readonly relayedBy: string;
  readonly raisedAt: string;
}

/** OB-69 (pure): one item per attempt — the carried record where a close carried it, the raised one until then. */
export function mergeRaisedAndCarried(raised: readonly RaisedNoAnswer[], carried: readonly PaymentException[]): PaymentException[] {
  const raisedOf = new Map<string, RaisedNoAnswer>();
  for (const r of raised) if (!raisedOf.has(r.attemptId)) raisedOf.set(r.attemptId, r);
  const out: PaymentException[] = [];
  const seen = new Set<string>();
  for (const c of carried) {
    if (seen.has(c.attemptId)) continue;
    seen.add(c.attemptId);
    out.push({ ...c, stage: 'carried', raisedAt: raisedOf.get(c.attemptId)?.raisedAt ?? null });
  }
  for (const r of raisedOf.values()) {
    if (seen.has(r.attemptId)) continue;
    out.push({
      attemptId: r.attemptId, laneId: r.laneId, billRef: r.billRef, kind: r.kind, amountMinor: r.amountMinor, askedAt: r.askedAt, state: r.state, tradingDay: r.tradingDay,
      storeId: r.storeId, dayCloseId: null, closedBy: null, approvedBy: null, approvalId: null, reason: null, carriedAt: null, governanceFlags: [], stage: 'raised', raisedAt: r.raisedAt,
    });
  }
  return out;
}

/** The provider's answer that resolved it — once. */
export interface PaymentExceptionResolution {
  readonly attemptId: string;
  /** true: the provider took the money; false: it did not. */
  readonly paid: boolean;
  /** What the customer is owed back when the provider took more than the bill. */
  readonly owedToCustomerMinor: number;
  readonly detail: string;
  /** `store_computer` — relayed from the till's provider check; `provider_record` — the provider's record given to head office. */
  readonly via: 'store_computer' | 'provider_record';
  readonly by: string;
  readonly resolvedAt: string;
}

/** A second, DIFFERENT answer for an exception already resolved — kept and shown, never applied. */
export interface PaymentExceptionConflict {
  readonly attemptId: string;
  readonly standing: { readonly paid: boolean; readonly owedToCustomerMinor: number };
  readonly offered: { readonly paid: boolean; readonly owedToCustomerMinor: number; readonly via: string; readonly by: string; readonly detail: string };
  readonly at: string;
}

/**
 * PF-06 (P-04): the machine's answer for an attempt of an EARLIER trading day, typed in at the till on a manager's
 * approval — a PERSON's answer, relayed so head office sees it. It lifts the store's day-close hold; it never resolves a
 * carried-forward exception (only the provider's answer does).
 */
export interface LatePaymentAnswer {
  readonly attemptId: string;
  readonly storeId: string;
  readonly laneId: string;
  readonly billRef: string;
  readonly kind: 'card' | 'upi';
  readonly amountMinor: number;
  readonly askedAt: string;
  readonly tradingDay: string;
  readonly outcome: 'approved' | 'declined';
  readonly answeredBy: string;
  readonly approvedBy: string;
  readonly approvalId: string;
  readonly answeredAt: string;
  /** What head office found re-checking the approver (record-and-flag, never a refusal). */
  readonly flags: readonly string[];
}

export interface PaymentExceptionDeps {
  /** Every payment with no final answer head office holds — one per attempt, raised (OB-69) or carried (OB-55). */
  readonly exceptions: (tenantId: string) => Promise<readonly PaymentException[]>;
  /** OB-69: the no-answers the store computer relayed the moment it recorded them (one per attempt). */
  readonly raised?: (tenantId: string) => Promise<readonly RaisedNoAnswer[]>;
  readonly recordRaised?: (tenantId: string, r: RaisedNoAnswer) => Promise<void>;
  readonly resolutions: (tenantId: string) => Promise<readonly PaymentExceptionResolution[]>;
  readonly conflicts: (tenantId: string) => Promise<readonly PaymentExceptionConflict[]>;
  readonly recordResolution: (tenantId: string, r: PaymentExceptionResolution) => Promise<void>;
  readonly recordConflict: (tenantId: string, c: PaymentExceptionConflict) => Promise<void>;
  readonly lateAnswers: (tenantId: string) => Promise<readonly LatePaymentAnswer[]>;
  readonly recordLateAnswer: (tenantId: string, a: LatePaymentAnswer) => Promise<void>;
  /** The permissions a person holds now (undefined: no grant at all) — to re-check a late answer's approver. */
  readonly permissionsOf?: (tenantId: string, userId: string) => Promise<readonly string[] | undefined>;
  readonly now: () => string;
}

/** The manager's authority a late answer's approval needs — the till approval authority head office re-checks. */
export const LATE_ANSWER_AUTHORITY = 'pos.return.approve';

/** The list as finance and the owner read it: every exception with its state, and the open amounts by kind and day. */
export function paymentExceptionList(exceptions: readonly PaymentException[], resolutions: readonly PaymentExceptionResolution[], conflicts: readonly PaymentExceptionConflict[], lateAnswers: readonly LatePaymentAnswer[] = []) {
  const resolvedBy = new Map<string, PaymentExceptionResolution>();
  for (const r of resolutions) if (!resolvedBy.has(r.attemptId)) resolvedBy.set(r.attemptId, r);
  const rows = exceptions.map((e) => {
    const r = resolvedBy.get(e.attemptId);
    return {
      ...e,
      state: r === undefined ? 'open' as const : r.paid ? 'resolved_paid' as const : 'resolved_not_paid' as const,
      resolution: r ?? null,
      conflicts: conflicts.filter((c) => c.attemptId === e.attemptId),
      lateAnswer: lateAnswers.find((a) => a.attemptId === e.attemptId) ?? null,
    };
  }).sort((a, b) => (a.tradingDay === b.tradingDay ? a.attemptId.localeCompare(b.attemptId) : a.tradingDay.localeCompare(b.tradingDay)));
  const open = rows.filter((r) => r.state === 'open');
  const sumOf = (xs: readonly { kind: 'card' | 'upi'; amountMinor: number }[], k: 'card' | 'upi'): number => xs.filter((x) => x.kind === k).reduce((n, x) => n + x.amountMinor, 0);
  return {
    exceptions: rows,
    open: open.length,
    openMinor: { card: sumOf(open, 'card'), upi: sumOf(open, 'upi') },
    owedToCustomersMinor: rows.reduce((n, r) => n + (r.resolution?.owedToCustomerMinor ?? 0), 0),
    flagged: rows.filter((r) => r.governanceFlags.length > 0 || r.conflicts.length > 0).map((r) => r.attemptId),
    // PF-06: every machine answer typed in late on a manager's approval — shown, with any doubt about the approver.
    lateAnswers,
  };
}

/** The unresolved card/UPI amounts of a trading day (for the day's tender figures). Pure. */
export function unresolvedOnDay(exceptions: readonly PaymentException[], resolutions: readonly PaymentExceptionResolution[], tradingDay: string): readonly { readonly kind: 'card' | 'upi'; readonly amountMinor: number; readonly attemptIds: readonly string[] }[] {
  const resolved = new Set(resolutions.map((r) => r.attemptId));
  const open = exceptions.filter((e) => e.tradingDay === tradingDay && !resolved.has(e.attemptId));
  return (['card', 'upi'] as const).map((kind) => {
    const mine = open.filter((e) => e.kind === kind);
    return { kind, amountMinor: mine.reduce((n, e) => n + e.amountMinor, 0), attemptIds: mine.map((e) => e.attemptId) };
  }).filter((x) => x.attemptIds.length > 0);
}

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const isStr = (v: unknown): v is string => typeof v === 'string' && v.trim() !== '';
const isInt = (v: unknown): v is number => typeof v === 'number' && Number.isSafeInteger(v);

export function paymentExceptionRoutes(deps: PaymentExceptionDeps): readonly Route[] {
  /** Record the provider's answer once; the same again is a no-op; a different one is a visible conflict. */
  const resolve = async (tenantId: string, attemptId: string, r: PaymentExceptionResolution) => {
    const exception = (await deps.exceptions(tenantId)).find((e) => e.attemptId === attemptId);
    if (exception === undefined) {
      throw apiError(404, {
        code: 'not_a_carried_payment',
        whatHappened: `No store computer raised, and no store day close carried, a payment ${attemptId} to head office.`,
        wasItSaved: 'not_saved',
        nextSafeAction: 'Check the payment reference. A store\'s answer that arrives before its day close is kept at the store and sent again.',
      });
    }
    const standing = (await deps.resolutions(tenantId)).find((x) => x.attemptId === attemptId);
    if (standing !== undefined) {
      if (standing.paid === r.paid && standing.owedToCustomerMinor === r.owedToCustomerMinor) {
        return { status: 200, body: { attemptId, resolved: true, alreadyResolved: true, resolution: standing } };
      }
      await deps.recordConflict(tenantId, {
        attemptId, standing: { paid: standing.paid, owedToCustomerMinor: standing.owedToCustomerMinor },
        offered: { paid: r.paid, owedToCustomerMinor: r.owedToCustomerMinor, via: r.via, by: r.by, detail: r.detail }, at: deps.now(),
      });
      throw apiError(409, {
        code: 'resolution_conflicts',
        whatHappened: `Payment ${attemptId} was already resolved as ${standing.paid ? 'paid' : 'not paid'} (${standing.via}, ${standing.resolvedAt}); this answer says ${r.paid ? 'paid' : 'not paid'}. The first answer stands and this one is recorded as a conflict on the exception list.`,
        wasItSaved: 'not_saved',
        nextSafeAction: 'Finance compares the two provider records and raises it with the provider. Nothing was changed.',
      });
    }
    await deps.recordResolution(tenantId, r);
    return { status: 201, body: { attemptId, resolved: true, resolution: r, exception } };
  };

  return [
    {
      // The finance / owner exception list: every carried payment, open or resolved, flags and conflicts shown.
      api: 'API-09', method: 'GET', path: '/v1/finance/payment-exceptions',
      permission: 'finance.period.read',
      handler: async (ctx) => {
        const [e, r, c, la] = await Promise.all([deps.exceptions(ctx.tenantId), deps.resolutions(ctx.tenantId), deps.conflicts(ctx.tenantId), deps.lateAnswers(ctx.tenantId)]);
        return { status: 200, body: { ...paymentExceptionList(e, r, c, la), asAt: deps.now() } };
      },
    },
    {
      // OB-69 "A" (owner, 11 Oct 2026, "The moment it happens"): the store computer relays a card/UPI attempt the moment the
      // till records the machine's NO ANSWER (queued on the box while the line is down, sent on reconnect). It becomes ONE
      // open finance item, keyed on the attempt: a re-send is a no-op; the day close that later carries it is the same item;
      // the provider's answer resolves it once. A reference that looks like card data is refused (hard rule #3).
      api: 'API-09', method: 'POST', path: '/v1/finance/payment-exceptions/:attemptId/no-answer/synced',
      permission: 'till.dayclose.sync', idempotent: true,
      handler: async (ctx) => {
        const attemptId = ctx.params['attemptId'] ?? '';
        const b = isObj(ctx.body) ? ctx.body : {};
        const ok = isStr(attemptId) && (b['attemptId'] === undefined || b['attemptId'] === attemptId) && isStr(b['laneId']) && isStr(b['billRef'])
          && (b['kind'] === 'card' || b['kind'] === 'upi') && isInt(b['amountMinor']) && (b['amountMinor'] as number) > 0
          && isStr(b['askedAt']) && isStr(b['tradingDay']) && isStr(b['recordedAt']) && isStr(b['recordedBy'])
          // OB-54 r12: placed by its store — a store computer's is stamped from its credential; one naming none is not read.
          && isStr(b['storeId']);
        if (!ok || deps.recordRaised === undefined || deps.raised === undefined) {
          throw apiError(400, {
            code: 'not_readable_as_a_no_answer',
            whatHappened: 'A relayed no-answer needs the attempt (store, till, bill, card or UPI, amount, when it was asked, its trading day), when the till recorded the no-answer and who.',
            wasItSaved: 'not_saved',
            nextSafeAction: 'Keep it at the store and raise it. Nothing was changed.',
          });
        }
        if (looksLikeCardNumber(attemptId) || looksLikeCardNumber(b['billRef'] as string)) {
          throw apiError(422, {
            code: 'provider_ref_not_a_token',
            whatHappened: 'A reference looked like raw card data rather than a payment reference. Card numbers are never taken (hard rule #3).',
            wasItSaved: 'not_saved',
            nextSafeAction: 'Nothing was recorded. Raise it with the store.',
          });
        }
        const existing = (await deps.exceptions(ctx.tenantId)).find((e) => e.attemptId === attemptId);
        if (existing !== undefined) return { status: 200, body: { attemptId, recorded: true, alreadyRecorded: true, stage: existing.stage ?? 'carried' } };
        const rec: RaisedNoAnswer = {
          attemptId, laneId: b['laneId'] as string, billRef: b['billRef'] as string, kind: b['kind'] as 'card' | 'upi', amountMinor: b['amountMinor'] as number,
          askedAt: b['askedAt'] as string, state: 'no_answer', tradingDay: b['tradingDay'] as string, storeId: b['storeId'] as string,
          recordedAt: b['recordedAt'] as string, recordedBy: b['recordedBy'] as string, relayedBy: ctx.userId, raisedAt: deps.now(),
        };
        await deps.recordRaised(ctx.tenantId, rec);
        return { status: 202, body: { attemptId, recorded: true, alreadyRecorded: false, stage: 'raised' } };
      },
    },
    {
      // PF-06: the store computer relays a machine answer typed in late for an earlier day's attempt, on a manager's
      // approval at the till. Recorded once per attempt; the approver is re-checked and any doubt is a flag.
      api: 'API-09', method: 'POST', path: '/v1/finance/payment-exceptions/:attemptId/late-answer/synced',
      permission: 'till.dayclose.sync', idempotent: true,
      handler: async (ctx) => {
        const attemptId = ctx.params['attemptId'] ?? '';
        const b = isObj(ctx.body) ? ctx.body : {};
        const ok = isStr(b['laneId']) && isStr(b['billRef']) && (b['kind'] === 'card' || b['kind'] === 'upi') && isInt(b['amountMinor'])
          && isStr(b['askedAt']) && isStr(b['tradingDay']) && (b['outcome'] === 'approved' || b['outcome'] === 'declined')
          && isStr(b['answeredBy']) && isStr(b['approvedBy']) && isStr(b['approvalId']) && isStr(b['answeredAt'])
          // OB-54 r12: placed by its store (stamped from a store computer's credential).
          && isStr(b['storeId']);
        if (!ok) {
          throw apiError(400, {
            code: 'not_readable_as_a_late_answer',
            whatHappened: 'A late answer needs the attempt (store, till, bill, card or UPI, amount, when asked, trading day), the answer, who typed it, the manager who approved it and the approval.',
            wasItSaved: 'not_saved',
            nextSafeAction: 'Keep it at the store and raise it. Nothing was changed.',
          });
        }
        const existing = (await deps.lateAnswers(ctx.tenantId)).find((a) => a.attemptId === attemptId);
        if (existing !== undefined) return { status: 200, body: { attemptId, recorded: true, alreadyRecorded: true, flags: existing.flags } };
        const flags: string[] = [];
        if (b['approvedBy'] === b['answeredBy']) flags.push('approved_by_the_person_who_answered');
        else if (deps.permissionsOf !== undefined) {
          const held = await deps.permissionsOf(ctx.tenantId, b['approvedBy'] as string);
          if (held === undefined) flags.push('approver_unknown');
          else if (!held.includes(LATE_ANSWER_AUTHORITY)) flags.push('approver_lacks_authority');
        }
        const rec: LatePaymentAnswer = {
          attemptId, storeId: b['storeId'] as string, laneId: b['laneId'] as string, billRef: b['billRef'] as string, kind: b['kind'] as 'card' | 'upi',
          amountMinor: b['amountMinor'] as number, askedAt: b['askedAt'] as string, tradingDay: b['tradingDay'] as string, outcome: b['outcome'] as 'approved' | 'declined',
          answeredBy: b['answeredBy'] as string, approvedBy: b['approvedBy'] as string, approvalId: b['approvalId'] as string, answeredAt: b['answeredAt'] as string, flags,
        };
        await deps.recordLateAnswer(ctx.tenantId, rec);
        return { status: 202, body: { attemptId, recorded: true, flags } };
      },
    },
    {
      // The store computer relays the provider's later answer (the till's Check payment read the provider's record).
      // Under the store's sync permission, like the day close it follows. Idempotent per payment.
      api: 'API-09', method: 'POST', path: '/v1/finance/payment-exceptions/:attemptId/resolved/synced',
      permission: 'till.dayclose.sync', idempotent: true,
      handler: async (ctx) => {
        const attemptId = ctx.params['attemptId'] ?? '';
        const b = isObj(ctx.body) ? ctx.body : {};
        if (typeof b['paid'] !== 'boolean' || (b['owedToCustomerMinor'] !== undefined && !isInt(b['owedToCustomerMinor']))) {
          throw apiError(400, {
            code: 'not_readable_as_a_resolution',
            whatHappened: 'A relayed resolution needs { paid: true|false } and, when the provider took more than the bill, { owedToCustomerMinor }.',
            wasItSaved: 'not_saved',
            nextSafeAction: 'Keep it at the store and raise it. Nothing was changed.',
          });
        }
        return resolve(ctx.tenantId, attemptId, {
          attemptId, paid: b['paid'], owedToCustomerMinor: isInt(b['owedToCustomerMinor']) ? b['owedToCustomerMinor'] : 0,
          detail: isStr(b['detail']) ? b['detail'].slice(0, 300) : '', via: 'store_computer', by: ctx.userId,
          resolvedAt: isStr(b['resolvedAt']) ? b['resolvedAt'] : deps.now(),
        });
      },
    },
    {
      // Finance gives head office the PROVIDER's own record for the payment (from the acquirer / UPI switch report); the
      // tested engine rules on it. An incomplete record with no authorisation is NOT a decline: it stays open.
      api: 'API-09', method: 'POST', path: '/v1/finance/payment-exceptions/:attemptId/resolve',
      permission: 'settlement.investigation.manage', idempotent: true,
      handler: async (ctx) => {
        const attemptId = ctx.params['attemptId'] ?? '';
        const b = isObj(ctx.body) ? ctx.body : {};
        const auths = Array.isArray(b['authorisations']) ? b['authorisations'] : undefined;
        const readable = auths !== undefined && typeof b['statementComplete'] === 'boolean' && auths.every((a) => isObj(a) && isStr(a['ref']) && isInt(a['amountMinor']) && ['captured', 'declined', 'voided'].includes(a['status'] as string) && isStr(a['at']));
        if (!readable) {
          throw apiError(400, {
            code: 'not_readable_as_a_provider_record',
            whatHappened: 'The provider\'s record is { authorisations: [{ ref, amountMinor, status: captured|declined|voided, at }], statementComplete: true|false }.',
            wasItSaved: 'not_saved',
            nextSafeAction: 'Send the provider\'s record for this payment reference. Nothing was changed.',
          });
        }
        if ((auths as Record<string, unknown>[]).some((a) => looksLikeCardNumber(a['ref'] as string))) {
          throw apiError(422, {
            code: 'provider_ref_not_a_token',
            whatHappened: 'A reference looked like raw card data rather than a provider reference. Card numbers are never taken (hard rule #3).',
            wasItSaved: 'not_saved',
            nextSafeAction: 'Send the provider\'s reference for the payment, not card details.',
          });
        }
        const e = (await deps.exceptions(ctx.tenantId)).find((x) => x.attemptId === attemptId);
        if (e === undefined) return resolve(ctx.tenantId, attemptId, { attemptId, paid: false, owedToCustomerMinor: 0, detail: '', via: 'provider_record', by: ctx.userId, resolvedAt: deps.now() });
        const at = deps.now();
        const ruling = recoverPendingTender({
          tender: { tenderId: e.attemptId, saleId: e.billRef, laneId: e.laneId, kind: e.kind, providerRef: e.attemptId, amountMinor: e.amountMinor, currency: 'INR', capturedAt: e.askedAt },
          authorisations: (auths as unknown as ProviderAuthorisation[]).filter((a) => a.ref === e.attemptId), statementComplete: b['statementComplete'] as boolean, at,
        });
        if (!ruling.resolved) {
          throw apiError(422, {
            code: 'still_unknown',
            whatHappened: `${ruling.detail}. The provider's record does not settle payment ${attemptId} — it stays open on the exception list.`,
            wasItSaved: 'not_saved',
            nextSafeAction: 'Ask the provider for its complete record for this reference, then try again. Do not settle it by hand.',
          });
        }
        return resolve(ctx.tenantId, attemptId, {
          attemptId, paid: ruling.outcome === 'confirmed_paid' || ruling.outcome === 'paid_more_than_once',
          owedToCustomerMinor: ruling.owedBy === 'customer' ? ruling.owedMinor : 0,
          detail: ruling.detail, via: 'provider_record', by: ctx.userId, resolvedAt: at,
        });
      },
    },
  ];
}
