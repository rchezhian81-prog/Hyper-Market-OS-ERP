// Digital receipts, only for members who ask (R4 · D-28 · D08-FR-05 · OB-214 · OB-222 · OB-29 · hard rules #1, #3, #6).
//
//   • THE MEMBER SWITCHES THEM ON in their own app (OB-214). Nobody is switched on by default; the same one tap switches
//     them off. Each choice is a new fact (append-only); a bill gets a copy only if it was banked while the member was ON.
//   • WHICH MEMBER the app account is: a till names a loyalty member by its member CODE (made from the mobile number on the
//     store computer; the number is never kept). The app account is tied to that code at the desk, by a named person who
//     has seen the number on the customer's own phone — the same check sign-up uses (OB-29 "seen on phone"); the SMS code
//     is switched off (OB-222). Until then the app says so, and shows no receipts.
//   • THE COPY is the banked bill as head office holds it: the same bill number, lines, tax and payments as the paper bill;
//     a card shows its last four digits only (hard rule #3). It is read from the banked sale after the till synced — the
//     till never waits for it and it never changes a sale (hard rule #1); the paper bill prints with the network off.
//   • ANOTHER CUSTOMER'S receipt is refused ("not your receipt") — and the attempt is kept (hard rule #6).
//   • SENDING by SMS or WhatsApp is built switched OFF: nothing is sent, and the app says so (OB-222).
//   • BILLED TO (OB-329): each copy names the member by the name they gave at enrolment; a skipped name is null.

import type { Route } from '../../kernel/src/index';
import { apiError } from '../../kernel/src/index';
import { memberRefFor, normaliseMobile } from '../../../packages/loyalty/src/index';
import { digitalCopyOf, switchedOnAt, RECEIPT_SENDING, type BankedSaleForCopy, type DigitalReceiptChoice, type DigitalReceiptCopy } from '../../../packages/receipt/src/digital-copy';
import { memberNameOf, type MemberRecord } from './loyalty-members';

/** The desk's tie between an app account and a loyalty member code — append-only; the latest for the account stands. */
export interface MemberAppLink {
  readonly customerRef: string;
  readonly memberRef: string;
  readonly linked: boolean;
  readonly verifiedHow: 'seen_on_phone';
  readonly by: string;
  readonly at: string;
}

/** A refused read of a receipt that is not the caller's — kept for staff to see (hard rule #6). */
export interface ReceiptAccessRefusal { readonly customerRef: string; readonly receiptNumber: string; readonly at: string }

export interface DigitalReceiptDeps {
  readonly choices: (tenantId: string, customerRef: string) => Promise<readonly DigitalReceiptChoice[]>;
  readonly recordChoice: (tenantId: string, c: DigitalReceiptChoice) => Promise<void>;
  readonly links: (tenantId: string) => Promise<readonly MemberAppLink[]>;
  readonly recordLink: (tenantId: string, l: MemberAppLink) => Promise<void>;
  /** The key a member code is made with (the store computer's). Absent → the desk link is refused, said. */
  readonly memberKey?: Buffer;
  readonly memberHistory: (tenantId: string, memberRef: string) => Promise<readonly MemberRecord[]>;
  /** Every bill head office BANKED that names this member code. */
  readonly bankedSalesOf: (tenantId: string, memberRef: string) => Promise<readonly BankedSaleForCopy[]>;
  readonly productName: (tenantId: string, productId: string) => Promise<string | undefined>;
  readonly recordRefusal: (tenantId: string, r: ReceiptAccessRefusal) => Promise<void>;
  readonly now: () => string;
}

const currentLink = (links: readonly MemberAppLink[], customerRef: string): MemberAppLink | undefined => {
  const mine = links.filter((l) => l.customerRef === customerRef).sort((a, b) => a.at.localeCompare(b.at));
  const last = mine[mine.length - 1];
  return last?.linked === true ? last : undefined;
};

export function digitalReceiptRoutes(deps: DigitalReceiptDeps): readonly Route[] {
  /** My copies: every bill banked for MY member code while I had receipts switched on — newest first. */
  const myCopies = async (tenantId: string, customerRef: string): Promise<{ readonly link?: MemberAppLink; readonly copies: readonly (DigitalReceiptCopy & { readonly billedTo: string | null })[] }> => {
    const links = await deps.links(tenantId);
    const link = currentLink(links, customerRef);
    if (link === undefined) return { copies: [] };
    // A member code tied to a LATER account is that account's from then on; mine are only the bills banked while it was mine.
    const takenOverAt = links.filter((l) => l.memberRef === link.memberRef && l.customerRef !== customerRef && l.linked && l.at > link.at).map((l) => l.at).sort()[0];
    const choices = await deps.choices(tenantId, customerRef);
    const names = new Map<string, string | undefined>();
    // OB-329: the copy is billed to the name the member gave at enrolment — or to nobody by name (never a made-up one).
    const billedTo = memberNameOf(await deps.memberHistory(tenantId, link.memberRef)) ?? null;
    const copies: (DigitalReceiptCopy & { readonly billedTo: string | null })[] = [];
    for (const sale of await deps.bankedSalesOf(tenantId, link.memberRef)) {
      if (sale.customerRef !== link.memberRef || sale.committedAt < link.at || (takenOverAt !== undefined && sale.committedAt >= takenOverAt) || !switchedOnAt(choices, sale.committedAt)) continue;
      for (const l of sale.lines) if (!names.has(l.productId)) names.set(l.productId, await deps.productName(tenantId, l.productId));
      copies.push({ ...digitalCopyOf(sale, (id) => names.get(id)), billedTo });
    }
    return { link, copies: copies.sort((a, b) => b.committedAt.localeCompare(a.committedAt)) };
  };
  const choiceNow = async (tenantId: string, customerRef: string): Promise<boolean> => switchedOnAt(await deps.choices(tenantId, customerRef), '￿');

  return [
    {
      // My digital-receipt choice, which member this app account is tied to, and whether sending is on (it is not).
      api: 'API-06', method: 'GET', path: '/v1/me/receipts/choice',
      permission: 'storefront.order.read', entitlement: 'customer_app',
      handler: async (ctx) => {
        const link = currentLink(await deps.links(ctx.tenantId), ctx.userId);
        // The last four digits are read from the member's own (sealed) record, never kept on the link itself.
        const history = link === undefined ? [] : await deps.memberHistory(ctx.tenantId, link.memberRef);
        return { status: 200, body: {
          on: await choiceNow(ctx.tenantId, ctx.userId),
          member: link === undefined ? null : { mobileLast4: history[history.length - 1]?.mobileLast4 ?? null, linkedAt: link.at },
          ...(link === undefined ? { notLinkedSay: `Your app is not yet tied to your loyalty membership. Show this reference at the service desk with your phone: ${ctx.userId}` } : {}),
          appReference: ctx.userId, sending: RECEIPT_SENDING,
        } };
      },
    },
    {
      // Switch digital receipts on or off — one tap either way. Body: { on: true | false }.
      api: 'API-06', method: 'POST', path: '/v1/me/receipts/choice',
      permission: 'storefront.order.place', entitlement: 'customer_app', idempotent: true,
      handler: async (ctx) => {
        const on = ((ctx.body ?? {}) as Record<string, unknown>)['on'];
        if (typeof on !== 'boolean') throw apiError(400, { code: 'not_readable_as_a_choice', whatHappened: 'The choice is { on: true or false }.', wasItSaved: 'not_saved', nextSafeAction: 'Tap the switch again. Your earlier choice stands.' });
        if ((await choiceNow(ctx.tenantId, ctx.userId)) !== on) await deps.recordChoice(ctx.tenantId, { customerRef: ctx.userId, on, at: deps.now() });
        return { status: 200, body: { on, sending: RECEIPT_SENDING } };
      },
    },
    {
      // My receipts — newest first.
      api: 'API-06', method: 'GET', path: '/v1/me/receipts',
      permission: 'storefront.order.read', entitlement: 'customer_app',
      handler: async (ctx) => {
        const { link, copies } = await myCopies(ctx.tenantId, ctx.userId);
        const on = await choiceNow(ctx.tenantId, ctx.userId);
        return { status: 200, body: {
          on, linked: link !== undefined, receipts: copies, count: copies.length, sending: RECEIPT_SENDING,
          say: !on ? 'Digital receipts are off. Switch them on to get a copy of each bill here.'
            : link === undefined ? 'Your app is not yet tied to your loyalty membership — ask at the service desk.'
              : copies.length === 0 ? 'No bills yet since you switched digital receipts on. A copy appears here after the till sends the bill to the shop.' : `${copies.length} bill(s).`,
        } };
      },
    },
    {
      // One of my receipts by its bill number — anyone else's is refused ("not your receipt"), and the attempt kept.
      api: 'API-06', method: 'GET', path: '/v1/me/receipts/:receiptNumber',
      permission: 'storefront.order.read', entitlement: 'customer_app',
      handler: async (ctx) => {
        const receiptNumber = ctx.params['receiptNumber'] ?? '';
        const copy = (await myCopies(ctx.tenantId, ctx.userId)).copies.find((c) => c.receiptNumber === receiptNumber);
        if (copy === undefined) {
          await deps.recordRefusal(ctx.tenantId, { customerRef: ctx.userId, receiptNumber, at: deps.now() });
          throw apiError(403, { code: 'not_your_receipt', whatHappened: 'not your receipt — you can only see bills of your own, banked while your digital receipts were on. This attempt was recorded.', wasItSaved: 'not_saved', nextSafeAction: 'Open My receipts to see your own bills.' });
        }
        return { status: 200, body: { receipt: copy } };
      },
    },
    {
      // Send a receipt by SMS or WhatsApp — switched off (OB-222): nothing is sent.
      api: 'API-06', method: 'POST', path: '/v1/me/receipts/:receiptNumber/send',
      permission: 'storefront.order.place', entitlement: 'customer_app', idempotent: true,
      handler: async () => {
        throw apiError(409, { code: 'sending_switched_off', whatHappened: RECEIPT_SENDING.say, wasItSaved: 'not_saved', nextSafeAction: 'Open the receipt here in the app.' });
      },
    },
    {
      // THE DESK ties an app account to a loyalty member, having seen the number on the customer's own phone (OB-29).
      // Body: { mobile, appCustomerRef, verifiedHow: 'seen_on_phone', linked? (false to untie) }. The number is never kept.
      api: 'API-06', method: 'POST', path: '/v1/loyalty/members/app-link',
      permission: 'loyalty.member.enrol', idempotent: true,
      handler: async (ctx) => {
        if (deps.memberKey === undefined) throw apiError(503, { code: 'loyalty_not_configured', whatHappened: 'This head office has no member key, so it cannot turn a phone number into a member code.', wasItSaved: 'not_saved', nextSafeAction: 'Ask the administrator to configure the pack signing key.' });
        const b = (ctx.body ?? {}) as Record<string, unknown>;
        const mobile = typeof b['mobile'] === 'string' ? normaliseMobile(b['mobile']) : undefined;
        const app = typeof b['appCustomerRef'] === 'string' ? b['appCustomerRef'].trim() : '';
        if (mobile === undefined || app === '' || app.length > 128 || (b['linked'] !== undefined && typeof b['linked'] !== 'boolean')) {
          throw apiError(400, { code: 'not_readable_as_a_link', whatHappened: 'A link needs { mobile (10 digits), appCustomerRef (shown in the customer\'s app), verifiedHow: "seen_on_phone", linked? }.', wasItSaved: 'not_saved', nextSafeAction: 'Nothing was changed.' });
        }
        if (b['verifiedHow'] !== 'seen_on_phone') throw apiError(422, { code: 'number_not_checked', whatHappened: 'The number has not been checked. The desk checks it on the customer\'s own phone (the SMS code is switched off).', wasItSaved: 'not_saved', nextSafeAction: 'Look at the number on the customer\'s phone, then send verifiedHow "seen_on_phone".' });
        const memberRef = memberRefFor(deps.memberKey, mobile)!;
        const history = await deps.memberHistory(ctx.tenantId, memberRef);
        if (history[history.length - 1]?.status !== 'member') throw apiError(422, { code: 'not_a_member', whatHappened: 'This number is not a loyalty member, so there are no bills to tie to the app.', wasItSaved: 'not_saved', nextSafeAction: 'Enrol the customer first (with their yes), then tie the app.' });
        const link: MemberAppLink = { customerRef: app, memberRef, linked: b['linked'] !== false, verifiedHow: 'seen_on_phone', by: ctx.userId, at: deps.now() };
        await deps.recordLink(ctx.tenantId, link);
        return { status: 201, body: { appCustomerRef: app, mobileLast4: history[history.length - 1]!.mobileLast4, linked: link.linked } };
      },
    },
  ];
}
