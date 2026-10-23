// API-06 The recall notice list — who bought the recalled batch AND may be contacted about it (M10-FR-04: "identify
// affected … customers (notify per consent)"; "affected customer contact respects consent (M16)"; WF-09 "identify
// stock/sales/customers"; the recall runbook, Part 3: "contact each per their consent").
//
// The lot trace already names the customers a batch reached. Nothing turned that into a list a person may act on with
// the customer's consent checked: a trace names everyone it can, including a customer who has told the shop never to
// message them. This is that list, for ONE recall:
//
//   • who bought the batch — the sales the till recorded it on, head office's FIFO estimate for sales that recorded no
//     batch (labelled as an estimate), and the sales of anything MADE from the batch in the shop's kitchen (D-25), so a
//     recalled ingredient reaches the customers of the dish;
//   • of those, who may be contacted: the customer's OWN recorded consent for messages about what they bought
//     (`transactional`), channel by channel, exactly as their privacy centre shows it to them (`consentPositions`). A
//     "no" on a channel, or nothing on record, is not a yes — silence has never been agreement in this product;
//   • who may NOT be messaged, and why (withdrawn, or nothing on record) — named by reference only, never dropped, so
//     the recall can see the people it still has to reach some other way;
//   • how many sales named nobody (a walk-in) — the notice at the shop entrance is for them.
//
// PII is minimised: a customer reference, the last four digits of a loyalty member's number (as the service desk
// already sees), the channels consented, and what they bought from the batch. No full number, no address.
//
// **Nothing is sent.** Choosing a channel and sending a message — or handing staff a call list instead — is the owner's
// decision D8 ("how affected customers are told about a recall"); this list stops before it and says so in its reply.
//
// The list exists only for a batch that has a recall (open or closed — the closure's evidence is the contact log). Asking
// it for a batch nobody recalled is refused: this is not a way to find out who bought what (purpose limitation, PRV-03).

import type { Route } from '../../kernel/src/index';
import { apiError, notFound } from '../../kernel/src/index';
import { consentPositions } from './privacy-self';
import type { ConsentRecord, Channel } from './index';

/** The consent purpose a recall notice is judged under: messages about something the customer bought. */
export const RECALL_NOTICE_PURPOSE = 'transactional' as const;

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
  readonly status: 'open' | 'closed';
  readonly reason: string;
  readonly initiatedAt: string;
  readonly closedAt: string | null;
}

export interface ContactableCustomer {
  readonly customerRef: string;
  readonly mobileLast4: string | null;
  /** The channels the customer's own latest record says "yes" on, for messages about what they bought. */
  readonly mayMessageOn: readonly Channel[];
  /** When each "yes" was recorded — the record the list rests on, so it can be defended later. */
  readonly consentRecordedAt: Readonly<Partial<Record<Channel, string>>>;
  readonly bought: readonly RecallBuyer[];
}

export interface NotContactableCustomer {
  readonly customerRef: string;
  readonly why: 'withdrawn' | 'no_consent_on_record';
  readonly purchases: number;
}

export interface RecallNoticeList {
  readonly batchId: string;
  readonly recall: NoticeRecall;
  readonly consentPurpose: typeof RECALL_NOTICE_PURPOSE;
  readonly contactable: readonly ContactableCustomer[];
  readonly notContactable: readonly NotContactableCustomer[];
  /** Sales that named no customer — nobody to contact by name; the shop-entrance notice is for them. */
  readonly anonymousSales: number;
  /** Sales on the list only by head office's FIFO estimate (not a till record of the batch). */
  readonly estimatedSales: number;
  readonly sending: { readonly built: false; readonly decision: 'D8'; readonly detail: string };
  readonly detail: string;
}

const SENDING_DETAIL = 'Nothing is sent from here. How the customers on this list are told — a call list for staff, a message through a provider, or both — is the owner\'s decision D8, not yet made.';

/** The customer's consent, for messages about what they bought, on every channel they have answered on. */
function transactionalStanding(customerRef: string, records: readonly ConsentRecord[], now: string): { readonly yes: Map<Channel, string>; readonly anyNo: boolean } {
  const yes = new Map<Channel, string>();
  let anyNo = false;
  for (const p of consentPositions(customerRef, records, now)) {
    if (p.purpose !== RECALL_NOTICE_PURPOSE) continue;
    if (p.granted) yes.set(p.channel, p.recordedAt);
    else anyNo = true;
  }
  return { yes, anyNo };
}

/** Fold the buyers and each customer's consent into the list. Pure: the caller hands in every record it rests on. */
export function buildRecallNoticeList(input: {
  readonly recall: NoticeRecall;
  readonly buyers: readonly RecallBuyer[];
  readonly consentOf: ReadonlyMap<string, readonly ConsentRecord[]>;
  readonly mobileLast4Of: ReadonlyMap<string, string>;
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
  const contactable: ContactableCustomer[] = [];
  const notContactable: NotContactableCustomer[] = [];
  for (const [customerRef, bought] of [...byCustomer.entries()].sort((a, b) => (a[0] < b[0] ? -1 : 1))) {
    const standing = transactionalStanding(customerRef, input.consentOf.get(customerRef) ?? [], input.now);
    const sortedBought = [...bought].sort((a, b) => (a.soldDate < b.soldDate ? -1 : a.soldDate > b.soldDate ? 1 : a.saleId < b.saleId ? -1 : 1));
    if (standing.yes.size === 0) {
      notContactable.push({ customerRef, why: standing.anyNo ? 'withdrawn' : 'no_consent_on_record', purchases: bought.length });
      continue;
    }
    const channels = [...standing.yes.keys()].sort();
    contactable.push({
      customerRef,
      mobileLast4: input.mobileLast4Of.get(customerRef) ?? null,
      mayMessageOn: channels,
      consentRecordedAt: Object.fromEntries(channels.map((c) => [c, standing.yes.get(c)!])),
      bought: sortedBought,
    });
  }
  const estimatedSales = input.buyers.filter((b) => b.source === 'fifo_receipt_estimate').length;
  const parts = [
    `${contactable.length} customer(s) bought from batch ${input.recall.batchId} and said yes to messages about what they bought`,
    `${notContactable.length} customer(s) bought it but must not be messaged (withdrawn, or no answer on record)`,
    `${anonymousSales} sale(s) named no customer`,
  ];
  if (estimatedSales > 0) parts.push(`${estimatedSales} sale(s) are on this list by head office's FIFO estimate, not a till record of the batch`);
  return {
    batchId: input.recall.batchId,
    recall: input.recall,
    consentPurpose: RECALL_NOTICE_PURPOSE,
    contactable,
    notContactable,
    anonymousSales,
    estimatedSales,
    sending: { built: false, decision: 'D8', detail: SENDING_DETAIL },
    detail: `${parts.join('; ')}.`,
  };
}

export interface RecallNoticeDeps {
  /** The recall on this batch (open or closed), or undefined when nobody recalled it. */
  readonly recall: (tenantId: string, batchId: string) => Promise<NoticeRecall | undefined>;
  /** Every sale of the batch, and of what was made from it, each with the customer it names where it names one. */
  readonly buyers: (tenantId: string, batchId: string) => Promise<readonly RecallBuyer[]>;
  readonly consentRecords: (tenantId: string, customerRef: string) => Promise<readonly ConsentRecord[]> | readonly ConsentRecord[];
  /** The last four digits of a loyalty member's number, where the customer is a member. */
  readonly mobileLast4: (tenantId: string, customerRef: string) => Promise<string | undefined>;
  readonly now: () => string;
}

const BATCH = /^[A-Za-z0-9._/-]{1,40}$/;

export function recallNoticeRoutes(deps: RecallNoticeDeps): readonly Route[] {
  return [
    {
      // The consent-checked list of the customers a recall must reach. A read; nothing is sent (D8).
      api: 'API-06', method: 'GET', path: '/v1/quality/recalls/:batchId/notice-list',
      permission: 'quality.recall.notice.read',
      handler: async (ctx) => {
        const batchId = (ctx.params['batchId'] ?? '').trim();
        if (!BATCH.test(batchId)) {
          throw apiError(400, {
            code: 'recall_notice_needs_batch',
            whatHappened: 'Name the recalled batch as printed (up to 40 letters, digits, dots, dashes or slashes).',
            wasItSaved: 'not_saved', nextSafeAction: 'Call /v1/quality/recalls/<batch>/notice-list.',
          });
        }
        const recall = await deps.recall(ctx.tenantId, batchId);
        if (recall === undefined) throw notFound(`recall on batch ${batchId} (a notice list exists only for a recalled batch)`);
        const buyers = await deps.buyers(ctx.tenantId, batchId);
        const refs = [...new Set(buyers.flatMap((b) => (b.customerRef === undefined || b.customerRef.trim() === '' ? [] : [b.customerRef.trim()])))];
        const consentOf = new Map<string, readonly ConsentRecord[]>();
        const mobileLast4Of = new Map<string, string>();
        for (const ref of refs) {
          consentOf.set(ref, await deps.consentRecords(ctx.tenantId, ref));
          const last4 = await deps.mobileLast4(ctx.tenantId, ref);
          if (last4 !== undefined) mobileLast4Of.set(ref, last4);
        }
        return { status: 200, body: buildRecallNoticeList({ recall, buyers, consentOf, mobileLast4Of, now: deps.now() }) };
      },
    },
  ];
}
