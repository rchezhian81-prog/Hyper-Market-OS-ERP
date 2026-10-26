// API-06 Telling the customers a recall must reach (M10-FR-04: "identify affected … customers (notify per consent)";
// "affected customer contact respects consent (M16)"; WF-09 "identify stock/sales/customers"; the recall runbook, Part 3).
// Owner decisions, in writing, 23 Oct 2026:
//   • OB-297 (D8) "Call list now, SMS later";
//   • OB-328 "Everyone known — safety first": the call list holds EVERY identified customer who bought the affected
//     lots, whatever their marketing consent — a safety recall is a service notice about goods already bought. A customer
//     who said no to promotions is still on it, noted "said no to promotions — safety call only". The list carries the
//     line "Data-law basis to be confirmed by your CA or lawyer.";
//   • OB-329 "Ask name at enrolment": the list shows the name the member gave, or "not on record".
//
//   • THE CALL LIST — GET /v1/quality/recalls/:batchId/notice-list. Who bought the batch (the bills the till recorded it
//     on, head office's FIFO estimate for bills that recorded no batch — labelled — and the bills for anything the kitchen
//     MADE from it, D-25). Each entry: the customer's name where one is recorded, ONLY the last four digits of their
//     phone, what they bought (the lot and the date), and notes on what they have said no to. Walk-ins are counted — the
//     notice at the shop entrance is for them.
//   • THE MESSAGE NOTICE PORT — POST /v1/quality/recalls/:batchId/notices. SMS, **switched OFF**: it sends nothing unless
//     a message provider is connected (none is — production composes no transport; tests hand in a stand-in) AND the owner
//     has switched recall messages on, in writing (POST /v1/quality/recall-notices/switch). Its rule did NOT change with
//     OB-328: it messages only customers whose own consent to SERVICE messages (purpose `transactional`) on SMS stands at
//     the moment of sending, each once, and keeps every attempt — sent or failed — on the record.
//   • THE "PHONED" TICK (OB-387, owner decision 26 Oct 2026) — POST /v1/quality/recalls/:batchId/call-list/:customerRef/phoned.
//     The person who phoned a customer on the call list ticks them: who, when, kept for good on an append-only stream and
//     sealed on the audit trail. The first tick stands (a second tick for the same customer on the same recall is
//     answered with the first one — never re-written). Only on an OPEN recall, only for a customer on its call list.
//     Any tick refuses the recall's withdrawal by name (`recall_customers_already_phoned`, `recall-withdrawal.ts`).
//
// The list and the port exist only for a recalled batch (purpose limitation, PRV-03): this is not a way to find out who
// bought what. Reading the list is sealed on the audit trail by the composition root, like every trace read.

import type { Route } from '../../kernel/src/index';
import { apiError, notFound } from '../../kernel/src/index';
import type { AuditEntry } from '../../../packages/audit/src/index';
import type { NotificationTransport } from '../../../packages/notifications/src/transport';
import { consentPositions } from './privacy-self';
import type { ConsentRecord, Channel } from './index';

/** The consent purpose a recall notice is judged under: service messages about something the customer bought. */
export const RECALL_NOTICE_PURPOSE = 'transactional' as const;
/** OB-297: the message notice goes by SMS only ("SMS later"). */
export const RECALL_NOTICE_CHANNEL: Channel = 'sms';

/** One sale that carried the recalled batch, or something made from it. */
export interface RecallBuyer {
  readonly saleId: string;
  readonly soldDate: string;
  readonly quantityMinor: number;
  /** `captured`: the till recorded the batch · `fifo_receipt_estimate`: head office's estimate (ADR-0006). */
  readonly source: 'captured' | 'fifo_receipt_estimate';
  /** The customer the sale names, where it names one (a loyalty member keyed at the till, a stored-value movement). */
  readonly customerRef?: string;
  /** The recalled batch itself, or a batch made from it in the shop (D-25). */
  readonly via:
    | { readonly kind: 'this_batch' }
    | { readonly kind: 'made_from_it'; readonly productId: string; readonly batchId: string; readonly runId: string };
}

/** The recall as the notice list shows it (from the recall register). */
export interface NoticeRecall {
  readonly batchId: string;
  readonly status: 'open' | 'closed' | 'withdrawn';
  readonly reason: string;
  readonly initiatedAt: string;
  readonly closedAt: string | null;
}

/** One thing a customer bought that the recall touches — the lot they took home, and when. */
export interface BoughtLot {
  readonly lot: string;
  readonly date: string;
  readonly saleId: string;
  readonly quantityMinor: number;
  /** The batch the lot was made from, when it is something the kitchen made from the recalled batch. */
  readonly madeFromLot?: string;
  /** Said when the lot is head office's FIFO estimate, not a till record. */
  readonly estimate?: true;
}

/** Something the customer has said no to, shown beside their entry so the caller knows how to treat them (OB-328). */
export type CallNote = 'said_no_to_promotions' | 'said_no_to_service_messages' | 'no_answer_on_service_messages';

export const CALL_NOTE_SAY: Readonly<Record<CallNote, string>> = Object.freeze({
  said_no_to_promotions: 'said no to promotions — safety call only',
  said_no_to_service_messages: 'said no to service messages — safety call only; no message is sent',
  no_answer_on_service_messages: 'no answer on service messages — call only; no message is sent',
});

/** OB-328: the line every call list carries. */
export const DATA_LAW_BASIS = Object.freeze({
  en: 'Data-law basis to be confirmed by your CA or lawyer.',
  ta: 'தரவுச் சட்ட அடிப்படையை உங்கள் பட்டயக் கணக்காளர் அல்லது வழக்கறிஞர் உறுதிப்படுத்த வேண்டும்.',
});

export interface CallListEntry {
  readonly customerRef: string;
  /** The customer's name as recorded (OB-329); null when none is on record (the desk asks — never a made-up value). */
  readonly name: string | null;
  /** ONLY the last four digits of the customer's phone (OB-297); null when no number is on record. */
  readonly phoneLast4: string | null;
  /** The channels the customer's own latest record says "yes" on, for SERVICE messages about what they bought. */
  readonly serviceMessagesOn: readonly Channel[];
  /** Whether the SMS port may message them (a "yes" to service messages by SMS). */
  readonly smsAllowed: boolean;
  /** What they have said no to (OB-328) — codes, with the words in `noteSay`. */
  readonly notes: readonly CallNote[];
  readonly noteSay: readonly string[];
  readonly bought: readonly BoughtLot[];
  /** OB-387: the "phoned" tick on this recall — who ticked it and when; null while nobody has. */
  readonly phoned: { readonly by: string; readonly at: string } | null;
}

/** OB-387: one "phoned" tick — a customer on a recall's call list was phoned. Append-only; never re-written. */
export interface RecallPhonedTick {
  readonly batchId: string;
  readonly customerRef: string;
  /** The recall this tick belongs to (its start time): a later recall on the same batch starts with no ticks. */
  readonly recallStartedAt: string;
  readonly phonedBy: string;
  readonly phonedAt: string;
}

export interface RecallNoticeList {
  readonly batchId: string;
  readonly recall: NoticeRecall;
  readonly decisions: readonly ['OB-297', 'OB-328', 'OB-329'];
  /** OB-328: "Data-law basis to be confirmed by your CA or lawyer." — in English and Tamil. */
  readonly dataLawBasis: typeof DATA_LAW_BASIS;
  /** The consent purpose the SMS port is judged under (service messages). */
  readonly smsConsentPurpose: typeof RECALL_NOTICE_PURPOSE;
  readonly callList: readonly CallListEntry[];
  /** Sales that named no customer — nobody to contact by name; the shop-entrance notice is for them. */
  readonly anonymousSales: number;
  /** Sales on the list only by head office's FIFO estimate (not a till record of the batch). */
  readonly estimatedSales: number;
  /** Of the call list, who a message notice would reach (service-message consent on SMS). */
  readonly smsConsented: number;
  /** OB-387: how many on the call list carry a "phoned" tick. */
  readonly phonedCount: number;
  readonly detail: string;
}

/** The customer's consent for service messages about what they bought, on every channel they have answered on. */
function standingOf(customerRef: string, records: readonly ConsentRecord[], now: string): { readonly yes: Map<Channel, string>; readonly serviceNo: boolean; readonly promotionsNo: boolean } {
  const yes = new Map<Channel, string>();
  let serviceNo = false;
  let promotionsNo = false;
  for (const p of consentPositions(customerRef, records, now)) {
    if (p.purpose === 'marketing' && !p.granted) promotionsNo = true;
    if (p.purpose !== RECALL_NOTICE_PURPOSE) continue;
    if (p.granted) yes.set(p.channel, p.recordedAt);
    else serviceNo = true;
  }
  return { yes, serviceNo, promotionsNo };
}

const lotOf = (recallBatch: string, b: RecallBuyer): BoughtLot => ({
  lot: b.via.kind === 'made_from_it' ? b.via.batchId : recallBatch,
  date: b.soldDate, saleId: b.saleId, quantityMinor: b.quantityMinor,
  ...(b.via.kind === 'made_from_it' ? { madeFromLot: recallBatch } : {}),
  ...(b.source === 'fifo_receipt_estimate' ? { estimate: true as const } : {}),
});

/** Fold the buyers and each customer's consent into the call list. Pure: the caller hands in every record it rests on. */
export function buildRecallNoticeList(input: {
  readonly recall: NoticeRecall;
  readonly buyers: readonly RecallBuyer[];
  readonly consentOf: ReadonlyMap<string, readonly ConsentRecord[]>;
  readonly nameOf: ReadonlyMap<string, string>;
  readonly phoneLast4Of: ReadonlyMap<string, string>;
  /** OB-387: the "phoned" ticks on this recall, by customer (the first tick for each). */
  readonly phonedOf?: ReadonlyMap<string, RecallPhonedTick>;
  readonly now: string;
}): RecallNoticeList {
  const byCustomer = new Map<string, RecallBuyer[]>();
  let anonymousSales = 0;
  for (const b of input.buyers) {
    const ref = b.customerRef?.trim();
    if (ref === undefined || ref === '') { anonymousSales += 1; continue; }
    const list = byCustomer.get(ref) ?? [];
    list.push(b);
    byCustomer.set(ref, list);
  }
  // OB-328 "Everyone known — safety first": every identified buyer is on the call list; what they said no to is noted.
  const callList: CallListEntry[] = [];
  for (const [customerRef, bought] of [...byCustomer.entries()].sort((a, b) => (a[0] < b[0] ? -1 : 1))) {
    const standing = standingOf(customerRef, input.consentOf.get(customerRef) ?? [], input.now);
    const channels = [...standing.yes.keys()].sort();
    const notes: CallNote[] = [];
    if (standing.promotionsNo) notes.push('said_no_to_promotions');
    if (channels.length === 0) notes.push(standing.serviceNo ? 'said_no_to_service_messages' : 'no_answer_on_service_messages');
    const last4 = input.phoneLast4Of.get(customerRef);
    callList.push({
      customerRef,
      name: input.nameOf.get(customerRef) ?? null,
      // Only ever four digits, whatever the source handed in (OB-297).
      phoneLast4: last4 === undefined ? null : last4.replace(/\D/g, '').slice(-4) || null,
      serviceMessagesOn: channels,
      smsAllowed: channels.includes(RECALL_NOTICE_CHANNEL),
      notes, noteSay: notes.map((n) => CALL_NOTE_SAY[n]),
      bought: [...bought].sort((a, b) => (a.soldDate < b.soldDate ? -1 : a.soldDate > b.soldDate ? 1 : a.saleId < b.saleId ? -1 : 1)).map((b) => lotOf(input.recall.batchId, b)),
      phoned: ((tick) => (tick === undefined ? null : { by: tick.phonedBy, at: tick.phonedAt }))(input.phonedOf?.get(customerRef)),
    });
  }
  const estimatedSales = input.buyers.filter((b) => b.source === 'fifo_receipt_estimate').length;
  const smsConsented = callList.filter((c) => c.smsAllowed).length;
  const phonedCount = callList.filter((c) => c.phoned !== null).length;
  const parts = [
    `${callList.length} customer(s) to call: everyone the shop knows bought from batch ${input.recall.batchId} (a safety recall)`,
    `${phonedCount} ticked as phoned`,
    `${smsConsented} of them said yes to service messages by SMS`,
    `${anonymousSales} sale(s) named no customer`,
  ];
  if (estimatedSales > 0) parts.push(`${estimatedSales} sale(s) are on this list by head office's FIFO estimate, not a till record of the batch`);
  return {
    batchId: input.recall.batchId, recall: input.recall, decisions: ['OB-297', 'OB-328', 'OB-329'], dataLawBasis: DATA_LAW_BASIS,
    smsConsentPurpose: RECALL_NOTICE_PURPOSE, callList, anonymousSales, estimatedSales, smsConsented, phonedCount,
    detail: `${parts.join('; ')}. ${DATA_LAW_BASIS.en}`,
  };
}

/** The owner's switch for recall messages (OB-297 "SMS later"): off until he turns it on, in writing. */
export interface RecallNoticeSwitch {
  readonly on: boolean;
  readonly by: string;
  readonly at: string;
  readonly reason: string;
}

/** One message attempt, kept whatever happened (never deleted — hard rule #6). */
export interface RecallNoticeAttempt {
  readonly messageId: string;
  readonly batchId: string;
  readonly customerRef: string;
  readonly channel: Channel;
  readonly sentBy: string;
  readonly at: string;
  readonly transport: string;
  readonly outcome: 'sent' | 'failed';
  readonly providerRef?: string;
  readonly reason?: string;
}

export interface RecallNoticeDeps {
  /** The recall on this batch (open or closed), or undefined when nobody recalled it. */
  readonly recall: (tenantId: string, batchId: string) => Promise<NoticeRecall | undefined>;
  /** Every sale of the batch, and of what was made from it, each with the customer it names where it names one. */
  readonly buyers: (tenantId: string, batchId: string) => Promise<readonly RecallBuyer[]>;
  readonly consentRecords: (tenantId: string, customerRef: string) => Promise<readonly ConsentRecord[]> | readonly ConsentRecord[];
  /** The customer's name, where the shop holds one. */
  readonly name: (tenantId: string, customerRef: string) => Promise<string | undefined>;
  /** The last four digits of the customer's phone, where the shop holds a number. */
  readonly phoneLast4: (tenantId: string, customerRef: string) => Promise<string | undefined>;
  /** The owner's switch for recall messages, latest first-wins; undefined = never set = OFF. */
  readonly switchState: (tenantId: string) => Promise<RecallNoticeSwitch | undefined>;
  readonly recordSwitch: (tenantId: string, s: RecallNoticeSwitch) => Promise<void>;
  readonly attempts: (tenantId: string, batchId: string) => Promise<readonly RecallNoticeAttempt[]>;
  readonly recordAttempt: (tenantId: string, a: RecallNoticeAttempt) => Promise<void>;
  /** OB-387: the "phoned" ticks on the recall that started at `recallStartedAt` on this batch (first per customer). */
  readonly phonedTicks: (tenantId: string, batchId: string, recallStartedAt: string) => Promise<readonly RecallPhonedTick[]>;
  /** OB-387: append a tick — one per customer and recall; a second answers with the first (`first`), never re-written. */
  readonly recordPhoned: (tenantId: string, tick: RecallPhonedTick) => Promise<{ readonly tick: RecallPhonedTick; readonly first: boolean }>;
  /** The message provider. NEVER set in production until one is certified; tests hand in a stand-in. */
  readonly transport?: NotificationTransport;
  readonly recordAudit?: (tenantId: string, entry: AuditEntry) => Promise<unknown> | void;
  readonly now: () => string;
}

const BATCH = /^[A-Za-z0-9._/-]{1,40}$/;
const isStr = (v: unknown): v is string => typeof v === 'string' && v.trim() !== '';

function batchOf(raw: string | undefined): string {
  const batchId = (raw ?? '').trim();
  if (!BATCH.test(batchId)) {
    throw apiError(400, {
      code: 'recall_notice_needs_batch',
      whatHappened: 'Name the recalled batch as printed (up to 40 letters, digits, dots, dashes or slashes).',
      wasItSaved: 'not_saved', nextSafeAction: 'Call /v1/quality/recalls/<batch>/notice-list.',
    });
  }
  return batchId;
}

async function listFor(deps: RecallNoticeDeps, tenantId: string, batchId: string): Promise<RecallNoticeList> {
  const recall = await deps.recall(tenantId, batchId);
  if (recall === undefined) throw notFound(`recall on batch ${batchId} (a call list exists only for a recalled batch)`);
  const buyers = await deps.buyers(tenantId, batchId);
  const refs = [...new Set(buyers.flatMap((b) => (b.customerRef === undefined || b.customerRef.trim() === '' ? [] : [b.customerRef.trim()])))];
  const consentOf = new Map<string, readonly ConsentRecord[]>();
  const nameOf = new Map<string, string>();
  const phoneLast4Of = new Map<string, string>();
  for (const ref of refs) {
    consentOf.set(ref, await deps.consentRecords(tenantId, ref));
    const name = await deps.name(tenantId, ref);
    if (name !== undefined) nameOf.set(ref, name);
    const last4 = await deps.phoneLast4(tenantId, ref);
    if (last4 !== undefined) phoneLast4Of.set(ref, last4);
  }
  const phonedOf = new Map<string, RecallPhonedTick>();
  for (const tick of await deps.phonedTicks(tenantId, batchId, recall.initiatedAt)) {
    if (!phonedOf.has(tick.customerRef)) phonedOf.set(tick.customerRef, tick);
  }
  return buildRecallNoticeList({ recall, buyers, consentOf, nameOf, phoneLast4Of, phonedOf, now: deps.now() });
}

const sendingSaid = (deps: RecallNoticeDeps, s: RecallNoticeSwitch | undefined) => ({
  channel: RECALL_NOTICE_CHANNEL,
  switchedOn: s?.on === true,
  providerConnected: deps.transport !== undefined,
  detail: deps.transport === undefined
    ? 'Recall messages are switched off: no message provider is connected (OB-297 "SMS later"). Call the customers on the list.'
    : s?.on === true
      ? `Recall messages are switched on (by ${s.by} at ${s.at}: ${s.reason}). Only customers who said yes to service messages by SMS are messaged.`
      : 'Recall messages are switched off until the owner switches them on. Call the customers on the list.',
});

export function recallNoticeRoutes(deps: RecallNoticeDeps): readonly Route[] {
  return [
    {
      // The consent-checked CALL LIST of the customers a recall must reach (OB-297). A read; it sends nothing.
      api: 'API-06', method: 'GET', path: '/v1/quality/recalls/:batchId/notice-list',
      permission: 'quality.recall.notice.read',
      handler: async (ctx) => {
        const batchId = batchOf(ctx.params['batchId']);
        const list = await listFor(deps, ctx.tenantId, batchId);
        return { status: 200, body: { ...list, messages: sendingSaid(deps, await deps.switchState(ctx.tenantId)) } };
      },
    },
    {
      // OB-387: tick a customer on the call list as PHONED — who, when; append-only and sealed. Any tick refuses the
      // recall's withdrawal. No body is needed; the person is the one signed in, the time is head office's.
      api: 'API-06', method: 'POST', path: '/v1/quality/recalls/:batchId/call-list/:customerRef/phoned',
      permission: 'quality.recall.notice.phoned', idempotent: true,
      handler: async (ctx) => {
        const batchId = batchOf(ctx.params['batchId']);
        const customerRef = (ctx.params['customerRef'] ?? '').trim();
        const list = await listFor(deps, ctx.tenantId, batchId);
        if (list.recall.status !== 'open') {
          throw apiError(409, {
            code: 'recall_is_not_open_for_phone_ticks',
            whatHappened: `The recall on batch ${batchId} is ${list.recall.status}, so no customer is ticked as phoned on it now. Its call list is kept as it was.`,
            wasItSaved: 'not_saved', nextSafeAction: 'Nothing was changed. Record any later call in the recall\'s closure evidence.',
          });
        }
        const entry = list.callList.find((c) => c.customerRef === customerRef);
        if (entry === undefined) {
          throw apiError(404, {
            code: 'customer_not_on_the_recall_call_list',
            whatHappened: `Customer "${customerRef}" is not on the call list of the recall on batch ${batchId}.`,
            wasItSaved: 'not_saved', nextSafeAction: 'Open the call list again and tick the customer from it. Nothing was changed.',
          });
        }
        const at = deps.now();
        const { tick, first } = await deps.recordPhoned(ctx.tenantId, { batchId, customerRef, recallStartedAt: list.recall.initiatedAt, phonedBy: ctx.userId, phonedAt: at });
        if (first) {
          await deps.recordAudit?.(ctx.tenantId, {
            actorId: ctx.userId, action: 'quality.recall.customer.phoned', objectType: 'recall-call', objectId: `recall:${batchId}:customer:${customerRef}`,
            at: tick.phonedAt, origin: { tenantId: ctx.tenantId, branchId: ctx.branchId ?? null }, before: { phoned: 'no' },
            after: { phoned: 'yes', phonedBy: tick.phonedBy, recallStartedAt: tick.recallStartedAt }, correlationId: ctx.traceId,
          });
        }
        return {
          status: first ? 201 : 200,
          body: {
            batchId, customerRef, phoned: { by: tick.phonedBy, at: tick.phonedAt }, alreadyTicked: !first,
            detail: first
              ? `Ticked as phoned by ${tick.phonedBy}. The recall can no longer be withdrawn; it is closed with evidence (OB-387).`
              : `Already ticked as phoned by ${tick.phonedBy} at ${tick.phonedAt}. The first tick stands; nothing was changed.`,
          },
        };
      },
    },
    {
      // Where recall messages stand: switched on or off (and by whom, why), and whether a provider is connected.
      api: 'API-06', method: 'GET', path: '/v1/quality/recall-notices/switch',
      permission: 'quality.recall.notice.read',
      handler: async (ctx) => {
        const s = await deps.switchState(ctx.tenantId);
        return { status: 200, body: { switch: s ?? null, messages: sendingSaid(deps, s) } };
      },
    },
    {
      // The owner switches recall messages on or off, in writing. Off until he does (OB-297 "SMS later").
      api: 'API-06', method: 'POST', path: '/v1/quality/recall-notices/switch',
      permission: 'quality.recall.notice.switch', idempotent: true,
      handler: async (ctx) => {
        const b = (ctx.body ?? {}) as Record<string, unknown>;
        if (typeof b['on'] !== 'boolean' || !isStr(b['reason']) || b['reason'].trim().length < 5) {
          throw apiError(400, {
            code: 'not_readable_as_a_switch',
            whatHappened: 'Switching recall messages needs { on: true|false, reason } — the reason, in words, is what the record keeps.',
            wasItSaved: 'not_saved', nextSafeAction: 'Send { "on": true, "reason": "…" }. Nothing was changed.',
          });
        }
        const s: RecallNoticeSwitch = { on: b['on'], by: ctx.userId, at: deps.now(), reason: b['reason'].trim() };
        await deps.recordSwitch(ctx.tenantId, s);
        await deps.recordAudit?.(ctx.tenantId, {
          actorId: ctx.userId, action: 'quality.recall.notice.switch', objectType: 'recall-notice-switch', objectId: 'recall-messages',
          at: s.at, origin: { tenantId: ctx.tenantId, branchId: ctx.branchId ?? null }, before: null,
          after: { on: String(s.on) }, reason: s.reason, correlationId: ctx.traceId,
        });
        return { status: 200, body: { switch: s, messages: sendingSaid(deps, s) } };
      },
    },
    {
      // Send the recall notice by SMS — only when a provider is connected AND the owner has switched it on, and only to
      // customers whose consent to service messages by SMS stands now. Body: { text } (the words, written by the sender).
      api: 'API-06', method: 'POST', path: '/v1/quality/recalls/:batchId/notices',
      permission: 'quality.recall.notice.send', idempotent: true,
      handler: async (ctx) => {
        const batchId = batchOf(ctx.params['batchId']);
        const transport = deps.transport;
        if (transport === undefined) {
          throw apiError(503, {
            code: 'recall_messages_have_no_provider',
            whatHappened: 'No message provider is connected, so no recall message can be sent (OB-297: call list now, SMS later).',
            wasItSaved: 'not_saved', nextSafeAction: 'Call the customers on the recall\'s call list. Nothing was sent.',
          });
        }
        const s = await deps.switchState(ctx.tenantId);
        if (s?.on !== true) {
          throw apiError(409, {
            code: 'recall_messages_switched_off',
            whatHappened: 'Recall messages are switched off. Only the owner switches them on, in writing.',
            wasItSaved: 'not_saved', nextSafeAction: 'Call the customers on the recall\'s call list, or ask the owner to switch recall messages on. Nothing was sent.',
          });
        }
        const b = (ctx.body ?? {}) as Record<string, unknown>;
        const text = isStr(b['text']) ? b['text'].trim() : '';
        if (text.length < 10 || text.length > 480) {
          throw apiError(400, {
            code: 'recall_notice_needs_words',
            whatHappened: 'A recall message needs its words: { text } of 10 to 480 characters.',
            wasItSaved: 'not_saved', nextSafeAction: 'Write what the customer must do, then send again. Nothing was sent.',
          });
        }
        const list = await listFor(deps, ctx.tenantId, batchId);
        if (list.recall.status !== 'open') {
          throw apiError(409, {
            code: 'recall_is_closed',
            whatHappened: `The recall on batch ${batchId} is closed, so no new message is sent for it.`,
            wasItSaved: 'not_saved', nextSafeAction: 'Nothing was sent.',
          });
        }
        const already = new Set((await deps.attempts(ctx.tenantId, batchId)).filter((a) => a.outcome === 'sent').map((a) => a.customerRef));
        const sent: string[] = [];
        const failed: { customerRef: string; reason: string }[] = [];
        const alreadyTold: string[] = [];
        const notOnSms: string[] = [];
        for (const c of list.callList) {
          // Consent is checked HERE, at the moment of sending (the list was folded from the ledger just now).
          if (!c.smsAllowed) { notOnSms.push(c.customerRef); continue; }
          if (already.has(c.customerRef)) { alreadyTold.push(c.customerRef); continue; }
          const messageId = `recall-${batchId}-${c.customerRef}-${RECALL_NOTICE_CHANNEL}`;
          const outcome = await transport.send({ messageId, channel: RECALL_NOTICE_CHANNEL, customerId: c.customerRef, text });
          const at = deps.now();
          const attempt: RecallNoticeAttempt = outcome.ok
            ? { messageId, batchId, customerRef: c.customerRef, channel: RECALL_NOTICE_CHANNEL, sentBy: ctx.userId, at, transport: transport.name, outcome: 'sent', providerRef: outcome.providerRef }
            : { messageId, batchId, customerRef: c.customerRef, channel: RECALL_NOTICE_CHANNEL, sentBy: ctx.userId, at, transport: transport.name, outcome: 'failed', reason: outcome.reason };
          await deps.recordAttempt(ctx.tenantId, attempt);
          if (outcome.ok) sent.push(c.customerRef); else failed.push({ customerRef: c.customerRef, reason: outcome.reason });
        }
        await deps.recordAudit?.(ctx.tenantId, {
          actorId: ctx.userId, action: 'quality.recall.notice.send', objectType: 'recall-notice', objectId: `recall-notice:${batchId}`,
          at: deps.now(), origin: { tenantId: ctx.tenantId, branchId: ctx.branchId ?? null }, before: null,
          after: { sent: String(sent.length), failed: String(failed.length), alreadyTold: String(alreadyTold.length), notOnSms: String(notOnSms.length), transport: transport.name },
          correlationId: ctx.traceId,
        });
        return {
          status: 200,
          body: {
            batchId, channel: RECALL_NOTICE_CHANNEL, transport: transport.name, sent, failed, alreadyTold, notOnSms,
            detail: `${sent.length} message(s) sent, ${failed.length} failed (kept on the record — call them), ${alreadyTold.length} already told, ${notOnSms.length} on the call list without service-message consent by SMS (call them).`,
          },
        };
      },
    },
  ];
}
