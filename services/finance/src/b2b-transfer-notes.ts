// OB-41 "A" (owner, 11 Oct 2026) · FUL-09 · M22-FR-04 — a business customer PAYS through the portal by telling the shop it
// has sent a bank transfer. Nothing is treated as paid on the customer's word (P-04 · §28 · hard rules #2 #6 #10):
//
//   • The customer, on ITS OWN sign-in (the stored login binding — never a customer id in the request) and holding the
//     `make_payment` grant, records a TRANSFER NOTE: the amount, the day it sent the money, and the bank's reference. The
//     note is PENDING. It never reduces what the customer owes — the statement, the invoices and the credit check read the
//     same balance as before.
//   • FINANCE — a second person, never the customer who wrote the note — reads its own bank statement and MATCHES the note:
//     it records the money it actually received (amount, date, the reference on its statement). Only an exact match of
//     amount and reference is accepted; anything else is refused by name and the note stays pending. The match records the
//     money received through the SAME path the desk's collection uses (the customer's AR ledger, the allocation to invoices,
//     the books' postable) — once: a re-sent match is the same match.
//   • A bank reference already on another note is refused — one transfer is one note. A note finance finds no money for is
//     REJECTED with a reason; it stays on record (hard rule #6), it is never deleted.
//   • The customer sees its notes and their state on the portal; finance sees the pending queue.
//
// Gated by the `b2b` entitlement (M36-FR-01), like the rest of the B2B family.

import type { Route, RequestContext } from '../../kernel/src/index';
import { apiError, notFound } from '../../kernel/src/index';
import { scopeToCustomer, allocatePayment, type Receivable } from '../../../packages/b2b/src/collections';
import type { B2BPortalRefusal } from '../../../packages/b2b/src/portal-access';
import type { AuditEntry } from '../../../packages/audit/src/index';
import type { B2BLoginBinding } from './b2b-portal';
import type { RecordedPayment } from './b2b-collections';

/** What the customer said it sent. Pending until finance matches it to money received. */
export interface B2BTransferNote {
  readonly noteId: string;
  readonly customerId: string;
  readonly amountMinor: number;
  /** The day the customer says it sent the money (YYYY-MM-DD). */
  readonly transferredOn: string;
  /** The bank's reference for the transfer (UTR / transaction id) — one transfer, one note. */
  readonly bankReference: string;
  /** Invoices the customer says the money is for, paid first when it is matched. */
  readonly against: readonly string[];
  readonly recordedBy: string;
  readonly recordedAt: string;
}

/** Finance's decision on a note: matched to money received, or rejected (no such money). One per note. */
export interface B2BTransferDecision {
  readonly noteId: string;
  readonly customerId: string;
  readonly outcome: 'matched' | 'rejected';
  /** Matched: what finance's own bank statement shows arrived, and when. */
  readonly receivedMinor?: number;
  readonly receivedOn?: string;
  /** Matched: the receipt the money was recorded under (the collection's receipt id). */
  readonly receiptId?: string;
  readonly allocatedMinor?: number;
  readonly unappliedMinor?: number;
  /** Rejected: why. */
  readonly reason?: string;
  readonly decidedBy: string;
  readonly decidedAt: string;
}

export type TransferNoteState = 'pending' | 'matched' | 'rejected';

export interface B2BTransferNotesDeps {
  readonly customerForUser: (tenantId: string, userId: string) => Promise<B2BLoginBinding | undefined> | B2BLoginBinding | undefined;
  readonly recordAccessRefusal: (tenantId: string, r: B2BPortalRefusal) => Promise<void> | void;
  readonly notes: (tenantId: string) => Promise<readonly B2BTransferNote[]> | readonly B2BTransferNote[];
  readonly recordNote: (tenantId: string, note: B2BTransferNote) => Promise<void> | void;
  readonly decisions: (tenantId: string) => Promise<readonly B2BTransferDecision[]> | readonly B2BTransferDecision[];
  readonly recordDecision: (tenantId: string, d: B2BTransferDecision) => Promise<void> | void;
  /** The customer's invoices with what is settled against each (collections' projection). */
  readonly invoices: (tenantId: string, customerId: string) => Promise<readonly Receivable[]> | readonly Receivable[];
  /** What the customer owes on the AR ledger the credit check reads. */
  readonly outstandingMinor: (tenantId: string, customerId: string) => Promise<number> | number;
  /** The money received, on the SAME path the desk's collection uses (AR ledger + allocation + the books' postable). */
  readonly recordPaymentWithMoney: (tenantId: string, customerId: string, payment: RecordedPayment, receivedOn: string) => Promise<void>;
  readonly recordAudit?: (tenantId: string, entry: AuditEntry) => Promise<unknown> | void;
  readonly now: () => string;
}

const isStr = (v: unknown): v is string => typeof v === 'string' && v.trim() !== '';
const isDate = (s: unknown): s is string => typeof s === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(s) && !Number.isNaN(Date.parse(`${s}T00:00:00.000Z`));
const isPosInt = (n: unknown): n is number => typeof n === 'number' && Number.isInteger(n) && n > 0;
/** A bank reference as banks print them: 6–35 letters, digits, '-' or '/'. Compared without case or spaces. */
const isReference = (v: unknown): v is string => typeof v === 'string' && /^[A-Za-z0-9/-]{6,35}$/.test(v.trim());
const refKey = (r: string): string => r.trim().toUpperCase();

/** A note's state, from finance's decisions (latest wins; a matched note stays matched). */
export function stateOf(note: B2BTransferNote, decisions: readonly B2BTransferDecision[]): { readonly state: TransferNoteState; readonly decision?: B2BTransferDecision } {
  const mine = decisions.filter((d) => d.noteId === note.noteId && d.customerId === note.customerId);
  const matched = mine.find((d) => d.outcome === 'matched');
  if (matched !== undefined) return { state: 'matched', decision: matched };
  const rejected = mine[mine.length - 1];
  return rejected === undefined ? { state: 'pending' } : { state: 'rejected', decision: rejected };
}

export function b2bTransferNoteRoutes(deps: B2BTransferNotesDeps): readonly Route[] {
  // The caller's own customer, from the stored binding — and the `make_payment` grant (a reach for another account is
  // refused and recorded, as the rest of the portal does).
  const me = async (ctx: RequestContext, action: string): Promise<string> => {
    const binding = await deps.customerForUser(ctx.tenantId, ctx.userId);
    if (binding === undefined) {
      throw apiError(403, { code: 'not_a_b2b_login', whatHappened: 'This login is not bound to any business customer.', wasItSaved: 'not_saved', nextSafeAction: 'Ask the shop to bind your login to your account.' });
    }
    const requested = isStr(ctx.query['customerId']) ? ctx.query['customerId'] : undefined;
    const decision = scopeToCustomer({
      session: { sessionId: `b2b-portal-${binding.customerId}`, customerId: binding.customerId, tenantId: ctx.tenantId, userId: ctx.userId, grants: binding.grants },
      rows: [{ customerId: binding.customerId }], grant: 'make_payment', ...(requested === undefined ? {} : { requestedCustomerId: requested }),
    });
    if (decision.securityEvent) {
      await deps.recordAccessRefusal(ctx.tenantId, { customerId: binding.customerId, userId: ctx.userId, requestedCustomerId: requested ?? '', action, outcome: decision.outcome, at: deps.now() });
    }
    if (!decision.allowed) {
      throw apiError(403, { code: decision.outcome, whatHappened: decision.detail, wasItSaved: 'not_saved', nextSafeAction: decision.outcome === 'not_your_data' ? 'You can only act on your own account. This attempt was recorded.' : 'Ask the shop to grant payments on your portal login.' });
    }
    return binding.customerId;
  };

  const view = (note: B2BTransferNote, decisions: readonly B2BTransferDecision[]) => {
    const { state, decision } = stateOf(note, decisions);
    return {
      ...note, state,
      ...(decision === undefined ? {} : {
        decidedBy: decision.decidedBy, decidedAt: decision.decidedAt,
        ...(decision.receiptId === undefined ? {} : { receiptId: decision.receiptId, receivedMinor: decision.receivedMinor, receivedOn: decision.receivedOn, allocatedMinor: decision.allocatedMinor, unappliedMinor: decision.unappliedMinor }),
        ...(decision.reason === undefined ? {} : { reason: decision.reason }),
      }),
    };
  };

  const audit = async (ctx: RequestContext, action: string, objectId: string, after: Record<string, string>): Promise<void> => {
    await deps.recordAudit?.(ctx.tenantId, {
      actorId: ctx.userId, action, objectType: 'b2b_transfer_note', objectId, at: deps.now(),
      origin: { tenantId: ctx.tenantId, branchId: ctx.branchId ?? null }, before: null, after, correlationId: objectId,
    });
  };

  return [
    {
      // The customer records a transfer it sent. Body: { amountMinor, transferredOn: YYYY-MM-DD, bankReference, against?: [invoiceId] }.
      api: 'API-09', method: 'POST', path: '/v1/b2b-portal/me/transfer-notes/:noteId',
      permission: 'b2b.portal.self', idempotent: true, entitlement: 'b2b',
      handler: async (ctx) => {
        const customerId = await me(ctx, 'record:transfer-note');
        const noteId = (ctx.params['noteId'] ?? '').trim();
        const b = (ctx.body ?? {}) as Record<string, unknown>;
        const against = b['against'] === undefined ? [] : Array.isArray(b['against']) && b['against'].every(isStr) ? (b['against'] as string[]) : undefined;
        if (noteId === '' || !isPosInt(b['amountMinor']) || !isDate(b['transferredOn']) || !isReference(b['bankReference']) || against === undefined) {
          throw apiError(400, {
            code: 'not_readable_as_a_transfer_note',
            whatHappened: 'A transfer note is { amountMinor (whole, above zero), transferredOn: YYYY-MM-DD, bankReference (6–35 letters, digits, - or /, as your bank printed it), against?: [invoice ids] }.',
            wasItSaved: 'not_saved', nextSafeAction: 'Send it again with those. Nothing was recorded and nothing on your account changed.',
          });
        }
        if (b['transferredOn'] > deps.now().slice(0, 10)) {
          throw apiError(400, { code: 'transfer_date_in_the_future', whatHappened: `A transfer cannot have been sent on ${b['transferredOn']}, which has not come yet.`, wasItSaved: 'not_saved', nextSafeAction: 'Send the day the money left your bank. Nothing was recorded.' });
        }
        const all = await deps.notes(ctx.tenantId);
        const prior = all.find((n) => n.noteId === noteId);
        if (prior !== undefined) {
          if (prior.customerId !== customerId) throw notFound(`transfer note ${noteId}`);
          const same = prior.amountMinor === b['amountMinor'] && prior.transferredOn === b['transferredOn'] && refKey(prior.bankReference) === refKey(b['bankReference']);
          if (!same) {
            throw apiError(409, { code: 'transfer_note_exists', whatHappened: `Transfer note ${noteId} is already on record with different figures; a note is never changed.`, wasItSaved: 'not_saved', nextSafeAction: 'Use a new note for a different transfer. Nothing was changed.' });
          }
          return { status: 200, body: { ...view(prior, await deps.decisions(ctx.tenantId)), alreadyRecorded: true } };
        }
        const dup = all.find((n) => refKey(n.bankReference) === refKey(b['bankReference'] as string));
        if (dup !== undefined) {
          throw apiError(409, {
            code: 'duplicate_bank_reference',
            whatHappened: 'This bank reference is already on a transfer note — one transfer is one note, so it is not recorded twice.',
            wasItSaved: 'not_saved', nextSafeAction: 'Check the reference on your bank\'s advice. If it is the same transfer, it is already with the shop.',
          });
        }
        const note: B2BTransferNote = {
          noteId, customerId, amountMinor: b['amountMinor'], transferredOn: b['transferredOn'], bankReference: (b['bankReference'] as string).trim(),
          against, recordedBy: ctx.userId, recordedAt: deps.now(),
        };
        await deps.recordNote(ctx.tenantId, note);
        await audit(ctx, 'b2b.transfer_note.record', noteId, { customerId, amountMinor: String(note.amountMinor), transferredOn: note.transferredOn, bankReference: note.bankReference, state: 'pending' });
        return {
          status: 201,
          body: {
            ...note, state: 'pending' as const, outstandingMinor: await deps.outstandingMinor(ctx.tenantId, customerId),
            tellTheCustomer: 'Thank you — the shop will check its bank. Until it sees the money, your balance does not change.',
          },
        };
      },
    },
    {
      // The customer's own notes and their state; the balance beside them is the ledger's (pending notes do not reduce it).
      api: 'API-09', method: 'GET', path: '/v1/b2b-portal/me/transfer-notes',
      permission: 'b2b.portal.self', entitlement: 'b2b',
      handler: async (ctx) => {
        const customerId = await me(ctx, 'read:transfer-notes');
        const decisions = await deps.decisions(ctx.tenantId);
        const notes = (await deps.notes(ctx.tenantId)).filter((n) => n.customerId === customerId).map((n) => view(n, decisions));
        return {
          status: 200,
          body: {
            customerId, notes, count: notes.length,
            pendingMinor: notes.filter((n) => n.state === 'pending').reduce((s, n) => s + n.amountMinor, 0),
            outstandingMinor: await deps.outstandingMinor(ctx.tenantId, customerId),
            detail: 'A pending note is what you told the shop you sent; it reduces what you owe only once the shop has received the money.',
            asAt: deps.now(),
          },
        };
      },
    },
    {
      // Finance's queue — the pending notes first (control by exception, P-03), every note with its state.
      api: 'API-09', method: 'GET', path: '/v1/b2b/transfer-notes',
      permission: 'b2b.receivable.record', entitlement: 'b2b',
      handler: async (ctx) => {
        const decisions = await deps.decisions(ctx.tenantId);
        const all = (await deps.notes(ctx.tenantId)).map((n) => view(n, decisions));
        const pending = all.filter((n) => n.state === 'pending').sort((a, b) => a.recordedAt.localeCompare(b.recordedAt));
        const want = ctx.query['state'];
        const rows = want === 'pending' || want === 'matched' || want === 'rejected' ? all.filter((n) => n.state === want) : [...pending, ...all.filter((n) => n.state !== 'pending')];
        return { status: 200, body: { notes: rows, count: rows.length, pending: pending.length, pendingMinor: pending.reduce((s, n) => s + n.amountMinor, 0), asAt: deps.now() } };
      },
    },
    {
      // Finance matches a note to money its OWN bank statement shows. Body: { receivedMinor, receivedOn, bankReference }.
      // Exact amount and reference, or refused by name (the note stays pending). Once matched, the money is recorded through
      // the collection path — the customer's AR, the allocation, the books — once.
      api: 'API-09', method: 'POST', path: '/v1/b2b/transfer-notes/:noteId/match',
      permission: 'b2b.receivable.record', idempotent: true, entitlement: 'b2b',
      handler: async (ctx) => {
        const noteId = (ctx.params['noteId'] ?? '').trim();
        const b = (ctx.body ?? {}) as Record<string, unknown>;
        if (!isPosInt(b['receivedMinor']) || !isDate(b['receivedOn']) || !isReference(b['bankReference'])) {
          throw apiError(400, { code: 'not_readable_as_a_receipt', whatHappened: 'Matching a note needs what YOUR bank statement shows: { receivedMinor, receivedOn: YYYY-MM-DD, bankReference }.', wasItSaved: 'not_saved', nextSafeAction: 'Read the line off the bank statement and send it. Nothing was recorded.' });
        }
        const note = (await deps.notes(ctx.tenantId)).find((n) => n.noteId === noteId);
        if (note === undefined) throw notFound(`transfer note ${noteId}`);
        const decisions = await deps.decisions(ctx.tenantId);
        const { state, decision } = stateOf(note, decisions);
        if (state === 'matched') return { status: 200, body: { ...view(note, decisions), alreadyMatched: true } };
        if (state === 'rejected') {
          throw apiError(409, { code: 'transfer_note_rejected', whatHappened: `Note ${noteId} was rejected by ${decision!.decidedBy} (${decision!.reason ?? ''}); it stays on record and is not matched later.`, wasItSaved: 'not_saved', nextSafeAction: 'If the money has now arrived, the customer records a new note for it. Nothing was changed.' });
        }
        if (note.recordedBy === ctx.userId) {
          throw apiError(403, { code: 'maker_cannot_approve', whatHappened: 'The person who recorded a transfer note cannot also confirm the money arrived — a second person checks the bank (§28).', wasItSaved: 'not_saved', nextSafeAction: 'Someone in finance matches it from the bank statement. Nothing was changed.' });
        }
        if (refKey(b['bankReference']) !== refKey(note.bankReference)) {
          throw apiError(409, { code: 'bank_reference_mismatch', whatHappened: `The bank statement's reference ${b['bankReference']} is not the note's reference ${note.bankReference}.`, wasItSaved: 'not_saved', nextSafeAction: 'Match the note only to the statement line with its own reference. The note stays pending.' });
        }
        if (b['receivedMinor'] !== note.amountMinor) {
          throw apiError(409, { code: 'amount_mismatch', whatHappened: `The bank shows ${b['receivedMinor']} received; the note says ${note.amountMinor} was sent. A different amount is not this transfer as noted.`, wasItSaved: 'not_saved', nextSafeAction: 'Ask the customer, or reject the note and have them record what they actually sent. The note stays pending and nothing is owed differently.' });
        }
        // One bank receipt settles one note: the same reference already matched on another note is refused.
        const other = (await deps.notes(ctx.tenantId)).find((n) => n.noteId !== noteId && refKey(n.bankReference) === refKey(note.bankReference) && stateOf(n, decisions).state === 'matched');
        if (other !== undefined) {
          throw apiError(409, { code: 'duplicate_bank_reference', whatHappened: `The bank receipt ${note.bankReference} already settled note ${other.noteId}.`, wasItSaved: 'not_saved', nextSafeAction: 'Reject this note: the money it names was already counted once. Nothing was changed.' });
        }
        const receiptId = `TN-${noteId}`;
        const allocation = allocatePayment({ receiptId, customerId: note.customerId, receivedMinor: note.amountMinor, invoices: await deps.invoices(ctx.tenantId, note.customerId), against: note.against });
        const payment: RecordedPayment = { receiptId, receivedMinor: allocation.receivedMinor, allocations: allocation.allocations };
        await deps.recordPaymentWithMoney(ctx.tenantId, note.customerId, payment, b['receivedOn']);
        const matched: B2BTransferDecision = {
          noteId, customerId: note.customerId, outcome: 'matched', receivedMinor: b['receivedMinor'], receivedOn: b['receivedOn'], receiptId,
          allocatedMinor: allocation.allocatedMinor, unappliedMinor: allocation.unappliedMinor, decidedBy: ctx.userId, decidedAt: deps.now(),
        };
        await deps.recordDecision(ctx.tenantId, matched);
        await audit(ctx, 'b2b.transfer_note.match', noteId, { customerId: note.customerId, receivedMinor: String(matched.receivedMinor), receivedOn: matched.receivedOn!, receiptId, recordedBy: note.recordedBy });
        return { status: 200, body: { ...view(note, [...decisions, matched]), outstandingMinor: await deps.outstandingMinor(ctx.tenantId, note.customerId) } };
      },
    },
    {
      // Finance finds no such money: the note is REJECTED with a reason — kept on record, never deleted. Body: { reason }.
      api: 'API-09', method: 'POST', path: '/v1/b2b/transfer-notes/:noteId/reject',
      permission: 'b2b.receivable.record', idempotent: true, entitlement: 'b2b',
      handler: async (ctx) => {
        const noteId = (ctx.params['noteId'] ?? '').trim();
        const reason = ((ctx.body ?? {}) as { reason?: unknown }).reason;
        if (!isStr(reason)) throw apiError(400, { code: 'rejection_needs_a_reason', whatHappened: 'Rejecting a transfer note needs { reason } — the customer will read it.', wasItSaved: 'not_saved', nextSafeAction: 'Say why (e.g. no such credit on the statement). Nothing was changed.' });
        const note = (await deps.notes(ctx.tenantId)).find((n) => n.noteId === noteId);
        if (note === undefined) throw notFound(`transfer note ${noteId}`);
        const decisions = await deps.decisions(ctx.tenantId);
        const { state } = stateOf(note, decisions);
        if (state === 'matched') throw apiError(409, { code: 'transfer_note_matched', whatHappened: `Note ${noteId} was already matched to money received; a matched receipt is corrected by its own entry, never by rejecting the note.`, wasItSaved: 'not_saved', nextSafeAction: 'Nothing was changed.' });
        if (state === 'rejected') return { status: 200, body: { ...view(note, decisions), alreadyRejected: true } };
        if (note.recordedBy === ctx.userId) throw apiError(403, { code: 'maker_cannot_approve', whatHappened: 'The person who recorded a transfer note cannot also decide it.', wasItSaved: 'not_saved', nextSafeAction: 'Someone in finance decides it. Nothing was changed.' });
        const rejected: B2BTransferDecision = { noteId, customerId: note.customerId, outcome: 'rejected', reason: reason.slice(0, 300), decidedBy: ctx.userId, decidedAt: deps.now() };
        await deps.recordDecision(ctx.tenantId, rejected);
        await audit(ctx, 'b2b.transfer_note.reject', noteId, { customerId: note.customerId, reason: rejected.reason! });
        return { status: 200, body: view(note, [...decisions, rejected]) };
      },
    },
  ];
}
