// The business customer ASKS, ORDERS and TELLS THE SHOP IT PAID — on its own portal login (M22-FR-04 "customer logs in →
// places orders, views invoices/outstanding, pays → collections tracked" · API-09 · OB-41 "A" · §28 · P-04 · P-08 · hard
// rules #3 #6 #10). A tested, DOM-free THIN client over head office's own portal routes; the customer is the one a member
// of staff BOUND this login to, on the server — no customer id is ever sent from here:
//
//   • ASK FOR A QUOTE (`POST /v1/b2b-portal/me/quote-requests/:id`, grant `place_order`) — items and quantities only; the
//     shop prices it (never the customer) and sends a quotation back;
//   • PLACE AN ORDER (`POST /v1/b2b-portal/me/orders/:id`, grant `place_order`) by accepting one of ITS OWN quotations — at
//     the quoted price, inside its window, with credit cleared and the stock held at the store it was quoted from; head
//     office refuses anything else in its own words;
//   • TELL THE SHOP IT PAID (`POST /v1/b2b-portal/me/transfer-notes/:id`, grant `make_payment`) — the amount, the day the
//     money left its bank and the bank's reference. The note is PENDING: what the customer owes does not change until the
//     shop's finance team finds the money on its own bank statement and matches it. No card or bank account detail is
//     asked or sent (hard rule #3);
//   • READ its own orders and quote requests (`GET …/me/orders`) and its own payment notes with their state
//     (`GET …/me/transfer-notes`).
//
// Nothing is read or written on open; every call is the customer's click. The portal's read-only views stay in
// b2b-portal-session.ts.

export type Lang = 'en' | 'ta';

export const B2B_ORDERING_COPY = {
  en: {
    h: 'Ask, order and pay', lead: 'Ask the shop for a quote, place an order from a quotation the shop sent you, or tell the shop you have sent a bank transfer. The shop prices every quote; a payment counts once the shop has seen the money in its bank.',
    show: 'Show my orders and payments',
    askH: 'Ask for a quote', product: 'Item code', qty: 'How many (whole)', addLine: 'Add another item', note: 'A note for the shop (optional)', ask: 'Send the quote request',
    askedNow: 'Sent. The shop will price this and send you a quotation to accept.',
    orderH: 'Place an order from a quotation', quotation: 'Quotation', noQuotation: 'No quotation from the shop is open for you yet.', order: 'Place the order at the quoted price',
    placedNow: 'Order placed at the quoted price.',
    payH: 'Tell the shop you paid', amount: 'Amount sent (₹)', sentOn: 'Day the money left your bank (YYYY-MM-DD)', reference: 'Bank reference (UTR or transaction id, as your bank printed it)', against: 'For invoices (optional, e.g. INV-12, INV-13)', pay: 'Tell the shop',
    paidNow: 'Thank you — the shop will check its bank. Until it sees the money, what you owe does not change.',
    ordersH: 'My orders', ordersNone: 'No order yet.', ordered: 'ordered', delivered: 'delivered', billed: 'billed',
    requestsH: 'My quote requests', requestsNone: 'No quote request sent.',
    notesH: 'Payments I told the shop about', notesNone: 'You have not told the shop about a payment.', st_pending: 'Waiting — the shop is checking its bank', st_matched: 'Received by the shop', st_rejected: 'Not found by the shop',
    owedNow: 'What you owe now (the shop\'s figure)', pendingNow: 'Told the shop, not yet seen in its bank',
    needLines: 'Write each item code and a whole quantity above zero.', needQuotation: 'Choose the quotation to order from.', needPayment: 'Write the amount in rupees, the day (YYYY-MM-DD) and the bank reference (6–35 letters, digits, - or /).',
    nobody: 'Nobody is signed in on this portal.', cannotOrder: 'Your login cannot ask for quotes or place orders — ask the shop to turn it on.', cannotPay: 'Your login cannot tell the shop about payments — ask the shop to turn it on.',
    refused: 'The shop refused:', unreachable: 'The shop cannot be reached — nothing was sent.',
  },
  ta: {
    h: 'கேள், ஆணையிடு, செலுத்து', lead: 'கடையிடம் விலைப்புள்ளி கேளுங்கள், கடை அனுப்பிய விலைப்புள்ளியிலிருந்து ஆணையிடுங்கள், அல்லது வங்கிப் பரிமாற்றம் அனுப்பியதைக் கடைக்குச் சொல்லுங்கள். ஒவ்வொரு விலைப்புள்ளியையும் கடையே விலையிடும்; கடை தன் வங்கியில் பணத்தைப் பார்த்ததும்தான் செலுத்தியதாகக் கணக்கில் வரும்.',
    show: 'என் ஆணைகளையும் செலுத்துதல்களையும் காட்டு',
    askH: 'விலைப்புள்ளி கேள்', product: 'பொருள் குறியீடு', qty: 'எத்தனை (முழு எண்)', addLine: 'இன்னொரு பொருள் சேர்', note: 'கடைக்கு ஒரு குறிப்பு (விருப்பம்)', ask: 'விலைப்புள்ளிக் கோரிக்கையை அனுப்பு',
    askedNow: 'அனுப்பப்பட்டது. கடை இதை விலையிட்டு, ஏற்க ஒரு விலைப்புள்ளியை அனுப்பும்.',
    orderH: 'விலைப்புள்ளியிலிருந்து ஆணையிடு', quotation: 'விலைப்புள்ளி', noQuotation: 'கடையிடமிருந்து உங்களுக்குத் திறந்த விலைப்புள்ளி இன்னும் இல்லை.', order: 'விலைப்புள்ளி விலையில் ஆணையிடு',
    placedNow: 'விலைப்புள்ளி விலையில் ஆணை இடப்பட்டது.',
    payH: 'செலுத்தியதைக் கடைக்குச் சொல்', amount: 'அனுப்பிய தொகை (₹)', sentOn: 'உங்கள் வங்கியிலிருந்து பணம் சென்ற நாள் (YYYY-MM-DD)', reference: 'வங்கிக் குறிப்பு (UTR அல்லது பரிவர்த்தனை எண், வங்கி அச்சிட்டபடி)', against: 'எந்த விலைப்பட்டியல்களுக்கு (விருப்பம், எ.கா. INV-12, INV-13)', pay: 'கடைக்குச் சொல்',
    paidNow: 'நன்றி — கடை தன் வங்கியைச் சரிபார்க்கும். பணத்தைப் பார்க்கும் வரை நீங்கள் தர வேண்டியது மாறாது.',
    ordersH: 'என் ஆணைகள்', ordersNone: 'இன்னும் ஆணை இல்லை.', ordered: 'ஆணையிட்டது', delivered: 'வழங்கியது', billed: 'பில் இட்டது',
    requestsH: 'என் விலைப்புள்ளிக் கோரிக்கைகள்', requestsNone: 'விலைப்புள்ளிக் கோரிக்கை எதுவும் அனுப்பவில்லை.',
    notesH: 'நான் கடைக்குச் சொன்ன செலுத்துதல்கள்', notesNone: 'எந்தச் செலுத்துதலையும் கடைக்குச் சொல்லவில்லை.', st_pending: 'காத்திருக்கிறது — கடை தன் வங்கியைச் சரிபார்க்கிறது', st_matched: 'கடை பெற்றுக்கொண்டது', st_rejected: 'கடை கண்டுபிடிக்கவில்லை',
    owedNow: 'இப்போது நீங்கள் தர வேண்டியது (கடையின் எண்)', pendingNow: 'கடைக்குச் சொன்னது, வங்கியில் இன்னும் பார்க்கவில்லை',
    needLines: 'ஒவ்வொரு பொருள் குறியீட்டையும் பூஜ்ஜியத்துக்கு மேல் ஒரு முழு அளவையும் எழுதுங்கள்.', needQuotation: 'ஆணையிட வேண்டிய விலைப்புள்ளியைத் தேர்ந்தெடுங்கள்.', needPayment: 'ரூபாயில் தொகை, நாள் (YYYY-MM-DD), வங்கிக் குறிப்பு (6–35 எழுத்துகள், எண்கள், - அல்லது /) — எழுதுங்கள்.',
    nobody: 'இந்தப் போர்ட்டலில் யாரும் உள்நுழையவில்லை.', cannotOrder: 'உங்கள் உள்நுழைவு விலைப்புள்ளி கேட்கவோ ஆணையிடவோ முடியாது — கடையிடம் இயக்கச் சொல்லுங்கள்.', cannotPay: 'உங்கள் உள்நுழைவு செலுத்துதலைக் கடைக்குச் சொல்ல முடியாது — கடையிடம் இயக்கச் சொல்லுங்கள்.',
    refused: 'கடை மறுத்தது:', unreachable: 'கடையை அடைய முடியவில்லை — எதுவும் அனுப்பப்படவில்லை.',
  },
} as const;

export const b2bOrderingWords = (lang: Lang, key: string): string =>
  (B2B_ORDERING_COPY[lang] as Record<string, string>)[key] ?? (B2B_ORDERING_COPY.en as Record<string, string>)[key] ?? key;

export type Outcome<T, K extends string = string> =
  | { readonly result: 'ok'; readonly value: T }
  | { readonly result: 'refused'; readonly status: number; readonly code: string; readonly whatHappened: string }
  | { readonly result: 'invalid'; readonly why: K }
  | { readonly result: 'lost_link' };

export interface PortalOrder { readonly orderId: string; readonly number: string; readonly grossMinor: number; readonly derivedFrom?: string; readonly chain?: unknown }
export interface PortalQuoteRequest { readonly requestId: string; readonly lines: readonly { readonly productId: string; readonly qty: number }[]; readonly note?: string; readonly at: string }
export interface PortalTransferNote {
  readonly noteId: string; readonly amountMinor: number; readonly transferredOn: string; readonly bankReference: string; readonly state: 'pending' | 'matched' | 'rejected';
  readonly reason?: string; readonly receivedOn?: string;
}
export interface QuoteLineForm { readonly productId: string; readonly qty: string }
export interface PaymentForm { readonly amountRupees: string; readonly sentOn: string; readonly bankReference: string; readonly against: string }

type Why = 'nobody' | 'cannotOrder' | 'cannotPay' | 'needLines' | 'needQuotation' | 'needPayment';
type Done<T> = Promise<Outcome<T, Why>>;
const DAY = /^\d{4}-\d{2}-\d{2}$/;
const REFERENCE = /^[A-Za-z0-9/-]{6,35}$/;

/** Rupees as typed ("1,000" / "1000.50") in whole paise, or null when it is not money above zero. */
export function paiseOfRupees(typed: string): number | null {
  const v = typed.replace(/[₹,\s]/g, '');
  if (!/^\d+(\.\d{1,2})?$/.test(v)) return null;
  const [whole, frac = ''] = v.split('.');
  const minor = Number(whole) * 100 + Number(frac.padEnd(2, '0'));
  return minor > 0 && Number.isSafeInteger(minor) ? minor : null;
}

/** The quote request's lines (blank rows skipped), or null when any typed row is not an item and a whole quantity. */
export function quoteLinesOf(rows: readonly QuoteLineForm[]): readonly { readonly productId: string; readonly qty: number }[] | null {
  const typed = rows.filter((r) => r.productId.trim() !== '' || r.qty.trim() !== '');
  if (typed.length === 0) return null;
  const out: { productId: string; qty: number }[] = [];
  for (const r of typed) {
    if (r.productId.trim() === '' || !/^\d{1,6}$/.test(r.qty.trim()) || Number(r.qty.trim()) <= 0) return null;
    out.push({ productId: r.productId.trim(), qty: Number(r.qty.trim()) });
  }
  return out;
}

/** The payment note as the route reads it, or null when it is not complete. Asks for no bank account or card detail. */
export function transferNoteBody(f: PaymentForm): { readonly amountMinor: number; readonly transferredOn: string; readonly bankReference: string; readonly against?: readonly string[] } | null {
  const amountMinor = paiseOfRupees(f.amountRupees);
  const on = f.sentOn.trim(); const ref = f.bankReference.trim();
  if (amountMinor === null || !DAY.test(on) || Number.isNaN(Date.parse(`${on}T00:00:00.000Z`)) || !REFERENCE.test(ref)) return null;
  const against = f.against.split(/[,\s]+/).map((s) => s.trim()).filter((s) => s !== '');
  return { amountMinor, transferredOn: on, bankReference: ref, ...(against.length === 0 ? {} : { against }) };
}

export const b2bOrderingOutcomeWords = (lang: Lang, out: Outcome<unknown>, good: string): string => {
  const w = (k: string) => b2bOrderingWords(lang, k);
  if (out.result === 'refused') return `${w('refused')} ${out.whatHappened}`;
  if (out.result === 'invalid') return w(out.why);
  if (out.result === 'lost_link') return w('unreachable');
  return w(good);
};

export interface B2BOrderingSession {
  readonly may: { readonly named: boolean; readonly order: boolean; readonly pay: boolean };
  myOrders(): Done<{ readonly orders: readonly PortalOrder[]; readonly quoteRequests: readonly PortalQuoteRequest[] }>;
  myNotes(): Done<{ readonly notes: readonly PortalTransferNote[]; readonly outstandingMinor: number; readonly pendingMinor: number }>;
  /** The shop's quotations to this customer that no order has been made from yet — what "place an order" can accept. */
  openQuotations(): Done<readonly { readonly documentId: string; readonly number: string; readonly grossMinor: number; readonly validUntil?: string }[]>;
  askForQuote(rows: readonly QuoteLineForm[], note: string): Done<{ readonly requestId: string }>;
  placeOrder(fromQuotationId: string): Done<PortalOrder>;
  tellPaid(f: PaymentForm): Done<PortalTransferNote>;
}

/**
 * The page is told who is looking and what they hold (`b2b.portal.self` for a business-customer login); which portal grants
 * the shop gave the login (`place_order`, `make_payment`) only head office knows, and it re-checks them on every call — a
 * login without one is refused in head office's words ("ask the shop to turn it on") and the attempt is recorded.
 */
export function createB2BOrderingSession(input: {
  readonly viewer: { readonly userId?: string; readonly permissions?: readonly string[] } | undefined;
  readonly fetch?: typeof globalThis.fetch; readonly newId?: (prefix: string) => string;
}): B2BOrderingSession {
  const named = input.viewer?.userId !== undefined && input.viewer.userId.trim() !== '';
  const portal = named && (input.viewer?.permissions ?? []).includes('b2b.portal.self');
  const may = { named, order: portal, pay: portal };
  const rand = (): string => (globalThis.crypto?.randomUUID?.() ?? `${Date.now().toString(36)}${Math.random().toString(36).slice(2)}`).replace(/[^A-Za-z0-9]/g, '').slice(0, 12);
  const idOf = input.newId ?? ((p: string) => `${p}-${rand()}`);
  const http = input.fetch ?? ((...a: Parameters<typeof globalThis.fetch>) => globalThis.fetch(...a));
  const call = async <T>(method: 'GET' | 'POST', path: string, body?: unknown, key?: string): Promise<Outcome<T, never>> => {
    try {
      const res = await http(path, {
        method, credentials: 'same-origin',
        headers: { accept: 'application/json', ...(method === 'POST' ? { 'content-type': 'application/json', 'idempotency-key': key ?? idOf('b2b-portal') } : {}) },
        ...(method === 'POST' ? { body: JSON.stringify(body ?? {}) } : {}),
      });
      const json = (await res.json().catch(() => ({}))) as Record<string, unknown>;
      if (!res.ok) {
        const err = (json['error'] ?? {}) as { code?: string; whatHappened?: string };
        return { result: 'refused', status: res.status, code: err.code ?? String(res.status), whatHappened: err.whatHappened ?? `status ${res.status}` };
      }
      return { result: 'ok', value: json as T };
    } catch { return { result: 'lost_link' }; }
  };
  const gate = (need: 'order' | 'pay'): { result: 'invalid'; why: Why } | undefined =>
    !named ? { result: 'invalid', why: 'nobody' } : !may[need] ? { result: 'invalid', why: need === 'order' ? 'cannotOrder' : 'cannotPay' } : undefined;
  return {
    may,
    myOrders: async () => (!named ? { result: 'invalid', why: 'nobody' } : call('GET', '/v1/b2b-portal/me/orders')),
    myNotes: async () => (!named ? { result: 'invalid', why: 'nobody' } : call('GET', '/v1/b2b-portal/me/transfer-notes')),
    openQuotations: async () => {
      if (!named) return { result: 'invalid', why: 'nobody' };
      const out = await call<{ documents?: readonly { documentId: string; kind: string; number: string; grossMinor: number; derivedFrom?: string; validUntil?: string }[] }>('GET', '/v1/b2b-portal/me/documents');
      if (out.result !== 'ok') return out;
      const docs = out.value.documents ?? [];
      const ordered = new Set(docs.filter((d) => d.kind === 'sales_order' && d.derivedFrom !== undefined).map((d) => d.derivedFrom));
      return { result: 'ok', value: docs.filter((d) => d.kind === 'quotation' && !ordered.has(d.documentId)).map((d) => ({ documentId: d.documentId, number: d.number, grossMinor: d.grossMinor, ...(d.validUntil === undefined ? {} : { validUntil: d.validUntil }) })) };
    },
    askForQuote: async (rows, note) => {
      const no = gate('order'); if (no !== undefined) return no;
      const lines = quoteLinesOf(rows);
      if (lines === null) return { result: 'invalid', why: 'needLines' };
      const requestId = idOf('QR');
      // The request's own id is its idempotency: a re-sent click answers "already recorded", never a second request.
      return call('POST', `/v1/b2b-portal/me/quote-requests/${encodeURIComponent(requestId)}`, { lines, ...(note.trim() === '' ? {} : { note: note.trim() }) }, requestId);
    },
    placeOrder: async (fromQuotationId) => {
      const no = gate('order'); if (no !== undefined) return no;
      if (fromQuotationId.trim() === '') return { result: 'invalid', why: 'needQuotation' };
      const documentId = idOf('SO');
      return call('POST', `/v1/b2b-portal/me/orders/${encodeURIComponent(documentId)}`, { fromQuotationId: fromQuotationId.trim() }, documentId);
    },
    tellPaid: async (f) => {
      const no = gate('pay'); if (no !== undefined) return no;
      const body = transferNoteBody(f);
      if (body === null) return { result: 'invalid', why: 'needPayment' };
      const noteId = idOf('TN');
      return call('POST', `/v1/b2b-portal/me/transfer-notes/${encodeURIComponent(noteId)}`, body, noteId);
    },
  };
}
