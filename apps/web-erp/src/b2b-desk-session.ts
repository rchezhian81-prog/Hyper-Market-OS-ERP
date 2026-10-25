// The B2B selling desk — selling to schools, hostels, caterers and offices (M22-FR-01 · M22-FR-02 · M22-FR-04 · §27 ·
// P-07 · OB-288 package 3). A tested, DOM-free session over head office's own routes:
//   • the CUSTOMERS the desk has met, each with where its contract stands (GET /v1/b2b/desk);
//   • one customer: the credit account (limit, owed, available, terms), the contracts, every document in the chain and
//     what each order has delivered and billed (GET /v1/b2b/desk/:customerId), and the money still owed by age;
//   • QUOTE — items and quantities only: the price comes from the customer's contract, else the shop's price list
//     (POST …/quotations/:id, no price sent); a refusal says why (no price on record, contract lapsed);
//   • CONVERT a quotation to an order at the quoted price; over the credit limit (or on a lapsed "block" contract) the
//     person ASKS — the owner decides (OB-290) — and then makes the order naming the approval;
//   • the PROFORMA, the CHALLAN (what actually left) and the TAX INVOICE (from the challans);
//   • CONTRACTS — proposed by one person, approved by another (kind b2b_contract), then put in force;
//   • a PAYMENT received, allocated to the oldest invoices.
// OB-280 (owner, 21 Oct 2026): business bills stay on the old system for real trading — this is the office module, behind
// the shop's `b2b` switch. Nothing is read or written on open; every write is a person's click, in their own name.

import { makeCaller, newId, type Outcome } from './r4-insight-call';

export type Lang = 'en' | 'ta';

export const B2B_DESK_COPY = {
  en: {
    title: 'Business customers', lead: 'Sell to schools, hostels, caterers and offices: quotation, order, proforma, challan and tax invoice. Prices come from the customer\'s approved contract, or the shop\'s price list — never typed. Business bills stay on the old system until the owner decides otherwise (OB-280).',
    customersH: 'Customers', customerId: 'Customer id', open: 'Open', customersNone: 'No business customer yet. Type a customer id to open one.', inForce: 'contract in force', noContract: 'no contract', blocked: 'contract lapsed — blocks new sales', lapsed: 'contract lapsed — ordinary prices',
    accountH: 'Credit account', limit: 'Credit limit', owed: 'Owed now', available: 'Available', terms: 'Payment terms (days)', noAccount: 'No credit account is set. An order cannot be made until one is (or a contract that sets it is approved).', notSet: 'not set',
    contractsH: 'Contracts', contractNone: 'No contract on record.', standing_awaiting_approval: 'waiting for approval', standing_not_started: 'starts later', standing_in_force: 'in force', standing_expired: 'ended', daysLeft: 'days left', endsOn: 'ends', onExpiry_block: 'on expiry: blocks', onExpiry_fallback: 'on expiry: ordinary prices',
    proposeH: 'Propose a contract', contractIdL: 'Contract id (blank for a new one)', validFrom: 'Valid from', validTo: 'Valid to', onExpiryL: 'When it ends', block: 'Block new sales until renewed', fallback: 'Use the shop\'s ordinary prices', pricesL: 'Price list — one line each: product id = price in rupees', limitL: 'Credit limit (₹, blank to leave as is)', termsL: 'Payment terms in days (blank to leave as is)', noteL: 'Note',
    propose: 'Save the proposal', askApproval: 'Ask for approval', putInForce: 'Put in force', askedFor: 'Asked for approval', approvedBy: 'approved by', rejectedBy: 'rejected by',
    quoteH: 'New quotation', storeL: 'Store it is supplied from', product: 'Product id', description: 'Description', qty: 'Quantity', tax: 'GST %', addLine: 'Add a line', removeLine: 'Remove', validDays: 'Price holds for (days)', issueQuote: 'Issue the quotation', priceNote: 'The price is taken from the contract or the price list.',
    docsH: 'Documents', docsNone: 'No documents yet.', kind_quotation: 'Quotation', kind_sales_order: 'Sales order', kind_proforma: 'Proforma', kind_challan: 'Delivery challan', kind_tax_invoice: 'Tax invoice', converted: 'became an order',
    src_contract: 'contract price', src_price_list: 'price list', src_typed: 'typed (no price on record)',
    toOrder: 'Make the order', askOverride: 'Ask the owner to allow it', withApproval: 'Make the order with the owner\'s approval', proforma: 'Proforma', challan: 'Challan for what left', invoice: 'Tax invoice', dispatchedL: 'Sent now', deliveryState: 'Delivery State code (blank = this State)',
    ordersH: 'Orders — ordered, delivered, billed', ordered: 'ordered', delivered: 'delivered', billed: 'billed', notBilled: 'delivered but not billed',
    collectH: 'Money owed', ageingNone: 'No invoice is owed yet.', overdue: 'overdue', disputed: 'disputed', chaseable: 'to chase', receivedL: 'Payment received (₹)', recordPayment: 'Record the payment',
    requestsH: 'Quote requests from the portal', requestsNone: 'No quote request is waiting.', useRequest: 'Quote this',
    read: 'Read', saved: 'Saved.', nobody: 'Nobody is signed in on this screen — you can read nothing.', cannotRead: 'Your role cannot open the business desk.',
    needCustomer: 'Type the customer id first.', needStore: 'Name the store it is supplied from.', needLines: 'Add at least one line: product, description, a whole quantity and a GST %.', needDates: 'Give both dates (from, to) — the end on or after the start.', needPrices: 'Write the price list: one "product id = rupees" per line.', needMoney: 'Write the amount in rupees, like 1250 or 1250.50.', needDispatched: 'Type how many of each line left the building.',
    refused: 'Head office refused:', unreachable: 'Head office cannot be reached — nothing was read or saved.', offFeature: 'The business-customer feature is switched off for this shop.',
  },
  ta: {
    title: 'வணிக வாடிக்கையாளர்கள்', lead: 'பள்ளிகள், விடுதிகள், கேட்டரர்கள், அலுவலகங்களுக்கு விற்பனை: விலைக்குறிப்பு, ஆர்டர், முன்விலைப்பட்டியல், அனுப்புச்சீட்டு, வரி விலைப்பட்டியல். விலை வாடிக்கையாளரின் அனுமதிக்கப்பட்ட ஒப்பந்தம் அல்லது கடையின் விலைப்பட்டியலிலிருந்து — ஒருபோதும் தட்டச்சு அல்ல. உரிமையாளர் வேறு முடிவு எடுக்கும் வரை வணிக பில்கள் பழைய அமைப்பிலேயே (OB-280).',
    customersH: 'வாடிக்கையாளர்கள்', customerId: 'வாடிக்கையாளர் எண்', open: 'திற', customersNone: 'இன்னும் வணிக வாடிக்கையாளர் இல்லை. திறக்க வாடிக்கையாளர் எண்ணைத் தட்டச்சு செய்யவும்.', inForce: 'ஒப்பந்தம் நடைமுறையில்', noContract: 'ஒப்பந்தம் இல்லை', blocked: 'ஒப்பந்தம் முடிந்தது — புதிய விற்பனை தடை', lapsed: 'ஒப்பந்தம் முடிந்தது — வழக்கமான விலை',
    accountH: 'கடன் கணக்கு', limit: 'கடன் வரம்பு', owed: 'இப்போது நிலுவை', available: 'கிடைப்பது', terms: 'செலுத்தும் காலம் (நாட்கள்)', noAccount: 'கடன் கணக்கு அமைக்கப்படவில்லை. அது அமையும் வரை (அல்லது அதை அமைக்கும் ஒப்பந்தம் அனுமதிக்கப்படும் வரை) ஆர்டர் செய்ய முடியாது.', notSet: 'அமைக்கப்படவில்லை',
    contractsH: 'ஒப்பந்தங்கள்', contractNone: 'எந்த ஒப்பந்தமும் பதிவில் இல்லை.', standing_awaiting_approval: 'அனுமதிக்காகக் காத்திருக்கிறது', standing_not_started: 'பின்னர் தொடங்கும்', standing_in_force: 'நடைமுறையில்', standing_expired: 'முடிந்தது', daysLeft: 'நாட்கள் மீதம்', endsOn: 'முடிவு', onExpiry_block: 'முடிவில்: தடை', onExpiry_fallback: 'முடிவில்: வழக்கமான விலை',
    proposeH: 'ஒப்பந்தம் முன்மொழி', contractIdL: 'ஒப்பந்த எண் (புதியதற்குக் காலியாக)', validFrom: 'தொடக்கம்', validTo: 'முடிவு', onExpiryL: 'முடிந்ததும்', block: 'புதுப்பிக்கும் வரை புதிய விற்பனையைத் தடு', fallback: 'கடையின் வழக்கமான விலையைப் பயன்படுத்து', pricesL: 'விலைப்பட்டியல் — ஒவ்வொரு வரியும்: பொருள் எண் = ரூபாயில் விலை', limitL: 'கடன் வரம்பு (₹, மாற்றாமல் விட காலியாக)', termsL: 'செலுத்தும் காலம் நாட்களில் (மாற்றாமல் விட காலியாக)', noteL: 'குறிப்பு',
    propose: 'முன்மொழிவைச் சேமி', askApproval: 'அனுமதி கேள்', putInForce: 'நடைமுறைப்படுத்து', askedFor: 'அனுமதி கேட்கப்பட்டது', approvedBy: 'அனுமதித்தவர்', rejectedBy: 'நிராகரித்தவர்',
    quoteH: 'புதிய விலைக்குறிப்பு', storeL: 'வழங்கும் கடை', product: 'பொருள் எண்', description: 'விவரம்', qty: 'அளவு', tax: 'GST %', addLine: 'வரியைச் சேர்', removeLine: 'நீக்கு', validDays: 'விலை செல்லுபடி (நாட்கள்)', issueQuote: 'விலைக்குறிப்பை வெளியிடு', priceNote: 'விலை ஒப்பந்தம் அல்லது விலைப்பட்டியலிலிருந்து எடுக்கப்படும்.',
    docsH: 'ஆவணங்கள்', docsNone: 'இன்னும் ஆவணங்கள் இல்லை.', kind_quotation: 'விலைக்குறிப்பு', kind_sales_order: 'விற்பனை ஆர்டர்', kind_proforma: 'முன்விலைப்பட்டியல்', kind_challan: 'அனுப்புச்சீட்டு', kind_tax_invoice: 'வரி விலைப்பட்டியல்', converted: 'ஆர்டராக மாறியது',
    src_contract: 'ஒப்பந்த விலை', src_price_list: 'விலைப்பட்டியல்', src_typed: 'தட்டச்சு (பதிவில் விலை இல்லை)',
    toOrder: 'ஆர்டர் செய்', askOverride: 'உரிமையாளரிடம் அனுமதி கேள்', withApproval: 'உரிமையாளரின் அனுமதியுடன் ஆர்டர் செய்', proforma: 'முன்விலைப்பட்டியல்', challan: 'அனுப்பியதற்கான சீட்டு', invoice: 'வரி விலைப்பட்டியல்', dispatchedL: 'இப்போது அனுப்பியது', deliveryState: 'டெலிவரி மாநிலக் குறியீடு (காலி = இந்த மாநிலம்)',
    ordersH: 'ஆர்டர்கள் — ஆர்டர், டெலிவரி, பில்', ordered: 'ஆர்டர்', delivered: 'டெலிவரி', billed: 'பில்', notBilled: 'டெலிவரி ஆனது, பில் இல்லை',
    collectH: 'நிலுவைப் பணம்', ageingNone: 'இன்னும் எந்த விலைப்பட்டியலும் நிலுவையில் இல்லை.', overdue: 'தாமதம்', disputed: 'தகராறு', chaseable: 'வசூலிக்க', receivedL: 'பெற்ற தொகை (₹)', recordPayment: 'தொகையைப் பதிவு செய்',
    requestsH: 'போர்ட்டலில் வந்த விலைக்குறிப்பு கோரிக்கைகள்', requestsNone: 'எந்தக் கோரிக்கையும் காத்திருக்கவில்லை.', useRequest: 'இதற்கு விலைக்குறிப்பு',
    read: 'படி', saved: 'சேமிக்கப்பட்டது.', nobody: 'இந்தத் திரையில் யாரும் உள்நுழையவில்லை — எதையும் படிக்க முடியாது.', cannotRead: 'உங்கள் பங்கு வணிக மேசையைத் திறக்க முடியாது.',
    needCustomer: 'முதலில் வாடிக்கையாளர் எண்ணைத் தட்டச்சு செய்யவும்.', needStore: 'வழங்கும் கடையைக் குறிப்பிடவும்.', needLines: 'குறைந்தது ஒரு வரி சேர்க்கவும்: பொருள், விவரம், முழு அளவு, GST %.', needDates: 'இரு தேதிகளையும் தரவும் — முடிவு தொடக்கத்திற்குப் பின் அல்லது அதே நாள்.', needPrices: 'விலைப்பட்டியலை எழுதவும்: ஒவ்வொரு வரியிலும் "பொருள் எண் = ரூபாய்".', needMoney: 'தொகையை ரூபாயில் எழுதவும், உதா. 1250 அல்லது 1250.50.', needDispatched: 'ஒவ்வொரு வரியிலும் எத்தனை அனுப்பப்பட்டது என்று தட்டச்சு செய்யவும்.',
    refused: 'தலைமை அலுவலகம் மறுத்தது:', unreachable: 'தலைமை அலுவலகத்தை அடைய முடியவில்லை — எதுவும் படிக்கவோ சேமிக்கவோ இல்லை.', offFeature: 'இந்தக் கடைக்கு வணிக வாடிக்கையாளர் வசதி அணைக்கப்பட்டுள்ளது.',
  },
} as const;

export const b2bDeskWords = (lang: Lang, key: string): string =>
  (B2B_DESK_COPY[lang] as Record<string, string>)[key] ?? (B2B_DESK_COPY.en as Record<string, string>)[key] ?? key;

export function b2bDeskOutcomeWords(lang: Lang, out: Outcome<unknown>): string {
  const w = (k: string) => b2bDeskWords(lang, k);
  if (out.result === 'refused') return out.code === 'feature_not_entitled' ? w('offFeature') : `${w('refused')} ${out.whatHappened}`;
  if (out.result === 'invalid') return w(out.why);
  if (out.result === 'lost_link') return w('unreachable');
  return w('saved');
}

/** "₹1,250.50" / "1250.5" → paise; undefined when not readable as rupees. */
export function paiseOfRupees(raw: string): number | undefined {
  const v = raw.replace(/[₹,\s]/g, '');
  if (!/^\d{1,9}(\.\d{1,2})?$/.test(v)) return undefined;
  const [whole, frac = ''] = v.split('.');
  return Number(whole) * 100 + Number(frac.padEnd(2, '0'));
}
export const rupees = (minor: number): string => `₹${(minor / 100).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

/** "rice = 1200\ndal=90.50" → [{ productId, priceMinor }]; undefined when any line is not readable. */
export function pricesOf(raw: string): { productId: string; priceMinor: number }[] | undefined {
  const lines = raw.split('\n').map((l) => l.trim()).filter((l) => l !== '');
  if (lines.length === 0) return undefined;
  const out: { productId: string; priceMinor: number }[] = [];
  for (const l of lines) {
    const m = /^([A-Za-z0-9][A-Za-z0-9._-]*)\s*=\s*(.+)$/.exec(l);
    const paise = m === null ? undefined : paiseOfRupees(m[2]!);
    if (m === null || paise === undefined) return undefined;
    out.push({ productId: m[1]!, priceMinor: paise });
  }
  return out;
}

const DATE = /^\d{4}-\d{2}-\d{2}$/;

export interface QuoteLineInput { readonly productId: string; readonly description: string; readonly qty: string; readonly taxPercent: string }
export interface ContractInput {
  readonly customerId: string; readonly contractId: string; readonly validFrom: string; readonly validTo: string; readonly onExpiry: 'block' | 'fallback';
  readonly prices: string; readonly limitRupees: string; readonly termsDays: string; readonly note: string;
}
/** The exact contract body (and its path ids) — what is proposed, what approval is asked for, and what is put in force. */
export interface ContractBody { readonly customerId: string; readonly contractId: string; readonly body: Record<string, unknown> }
export interface AskedRequest { readonly requestId: string; readonly kind: string; readonly status: string; readonly subjectRef: string; readonly details: Record<string, unknown>; readonly decidedBy?: string; readonly decisionReason?: string }

export type Invalid = 'nobody' | 'needCustomer' | 'needStore' | 'needLines' | 'needDates' | 'needPrices' | 'needMoney' | 'needDispatched';

/** Read the contract form into the exact body head office takes. */
export function contractBodyOf(input: ContractInput, makeId: () => string = () => newId('K')): ContractBody | Invalid {
  const customerId = input.customerId.trim();
  if (customerId === '') return 'needCustomer';
  if (!DATE.test(input.validFrom) || !DATE.test(input.validTo) || input.validTo < input.validFrom) return 'needDates';
  const prices = pricesOf(input.prices);
  if (prices === undefined) return 'needPrices';
  const limit = input.limitRupees.trim() === '' ? undefined : paiseOfRupees(input.limitRupees);
  if (input.limitRupees.trim() !== '' && limit === undefined) return 'needMoney';
  const terms = input.termsDays.trim() === '' ? undefined : Number(input.termsDays.trim());
  if (terms !== undefined && !(Number.isInteger(terms) && terms >= 0 && terms <= 365)) return 'needMoney';
  const body: Record<string, unknown> = {
    validFrom: input.validFrom, validTo: input.validTo, onExpiry: input.onExpiry, prices,
    ...(limit === undefined ? {} : { creditLimitMinor: limit }), ...(terms === undefined ? {} : { paymentTermsDays: terms }),
    ...(input.note.trim() === '' ? {} : { note: input.note.trim() }),
  };
  return { customerId, contractId: input.contractId.trim() === '' ? makeId() : input.contractId.trim(), body };
}

/** Read the quotation lines (no price: head office prices them from the record). */
export function quoteLinesOf(lines: readonly QuoteLineInput[]): { lineId: string; productId: string; description: string; qty: number; taxRateBps: number }[] | undefined {
  const out = [];
  let n = 0;
  for (const l of lines) {
    if (l.productId.trim() === '' && l.description.trim() === '' && l.qty.trim() === '') continue;
    const qty = Number(l.qty.trim());
    const tax = Number(l.taxPercent.trim() === '' ? 'x' : l.taxPercent.trim());
    if (l.productId.trim() === '' || l.description.trim() === '' || !Number.isInteger(qty) || qty < 1 || !Number.isFinite(tax) || tax < 0 || tax > 28) return undefined;
    n += 1;
    out.push({ lineId: `l${n}`, productId: l.productId.trim(), description: l.description.trim(), qty, taxRateBps: Math.round(tax * 100) });
  }
  return out.length === 0 ? undefined : out;
}

export interface B2BDeskSession {
  readonly may: { readonly named: boolean; readonly open: boolean; readonly issue: boolean; readonly readContracts: boolean; readonly manageContracts: boolean; readonly collect: boolean; readonly readAccount: boolean };
  readDesk(): Promise<Outcome<{ readonly customers: readonly { readonly customerId: string; readonly contract: { readonly inForce: string | null; readonly lapsed: string | null; readonly blocked: boolean } }[] }>>;
  readCustomer(customerId: string): Promise<Outcome<Record<string, unknown>, 'needCustomer'>>;
  readAgeing(customerId: string): Promise<Outcome<Record<string, unknown>, 'needCustomer'>>;
  readQuoteRequests(): Promise<Outcome<{ readonly requests: readonly { readonly requestId: string; readonly customerId: string; readonly lines: readonly { readonly productId: string; readonly qty: number }[]; readonly note?: string }[] }>>;
  /** The approvals this person asked for on the desk (contracts and credit overrides) and where each stands. */
  readMyRequests(): Promise<Outcome<readonly AskedRequest[]>>;
  quote(input: { readonly customerId: string; readonly locationId: string; readonly lines: readonly QuoteLineInput[]; readonly validForDays: string }): Promise<Outcome<unknown, Invalid>>;
  convert(input: { readonly customerId: string; readonly quotationId: string; readonly locationId: string; readonly documentId?: string; readonly approvalId?: string }): Promise<Outcome<unknown, Invalid>>;
  askOverride(input: { readonly customerId: string; readonly quotationId: string; readonly locationId: string; readonly valueMinor: number; readonly reason: string }): Promise<Outcome<unknown, Invalid>>;
  /** Make the order an approved override is for — exactly what was asked. */
  convertWithApproval(request: AskedRequest): Promise<Outcome<unknown, Invalid>>;
  proforma(customerId: string, orderId: string): Promise<Outcome<unknown, Invalid>>;
  challan(customerId: string, orderId: string, dispatched: Readonly<Record<string, string>>): Promise<Outcome<unknown, Invalid>>;
  invoice(customerId: string, orderId: string, deliveryStateCode: string): Promise<Outcome<unknown, Invalid>>;
  proposeContract(input: ContractInput): Promise<Outcome<unknown, Invalid>>;
  askContractApproval(input: ContractInput, reason: string): Promise<Outcome<unknown, Invalid>>;
  putContractInForce(request: AskedRequest): Promise<Outcome<unknown, Invalid>>;
  recordPayment(customerId: string, rupeesReceived: string): Promise<Outcome<unknown, Invalid>>;
}

export function createB2BDeskSession(input: { readonly viewer: { readonly userId?: string; readonly permissions: readonly string[] } | undefined; readonly fetch?: typeof globalThis.fetch; readonly newKey?: () => string; readonly makeId?: (prefix: string) => string }): B2BDeskSession {
  const named = input.viewer?.userId !== undefined;
  const held = new Set(input.viewer?.permissions ?? []);
  const may = {
    named, open: named && held.has('b2b.document.read'), issue: named && held.has('b2b.document.issue'),
    readContracts: named && held.has('b2b.contract.read'), manageContracts: named && held.has('b2b.contract.manage'),
    collect: named && held.has('b2b.receivable.record'), readAccount: named && held.has('b2b.account.read'),
  };
  const call = makeCaller({ keyPrefix: 'b2b-desk', ...(input.fetch === undefined ? {} : { fetch: input.fetch }), ...(input.newKey === undefined ? {} : { newKey: input.newKey }) });
  const id = input.makeId ?? newId;
  const enc = encodeURIComponent;
  const today = (): string => new Date().toISOString().slice(0, 10);
  const contractOf = (c: ContractInput): ContractBody | Invalid => contractBodyOf(c, () => id('K'));
  const doc = (customerId: string, kind: string, body: unknown, prefix: string) => call('POST', `/v1/b2b/documents/${enc(customerId)}/${kind}/${enc(id(prefix))}`, body);
  return {
    may,
    readDesk: () => call('GET', '/v1/b2b/desk'),
    readCustomer: async (customerId) => (customerId.trim() === '' ? { result: 'invalid', why: 'needCustomer' } : call('GET', `/v1/b2b/desk/${enc(customerId.trim())}`)),
    readAgeing: async (customerId) => (customerId.trim() === '' ? { result: 'invalid', why: 'needCustomer' } : call('GET', `/v1/b2b/collections/${enc(customerId.trim())}/ageing?asOf=${today()}`)),
    readQuoteRequests: () => call('GET', '/v1/b2b/quote-requests'),
    readMyRequests: async () => {
      const r = await call<{ mine?: AskedRequest[] }>('GET', '/v1/approvals/requests');
      if (r.result !== 'ok') return r;
      return { result: 'ok', value: (r.value.mine ?? []).filter((q) => q.kind === 'b2b_contract' || q.kind === 'b2b_credit_override') };
    },
    quote: async ({ customerId, locationId, lines, validForDays }) => {
      if (!named) return { result: 'invalid', why: 'nobody' };
      if (customerId.trim() === '') return { result: 'invalid', why: 'needCustomer' };
      if (locationId.trim() === '') return { result: 'invalid', why: 'needStore' };
      const read = quoteLinesOf(lines);
      if (read === undefined) return { result: 'invalid', why: 'needLines' };
      const days = Number(validForDays.trim());
      return doc(customerId.trim(), 'quotations', { lines: read, locationId: locationId.trim(), ...(Number.isInteger(days) && days > 0 ? { validForDays: days } : {}) }, 'Q');
    },
    convert: async ({ customerId, quotationId, locationId, documentId, approvalId }) => {
      if (!named) return { result: 'invalid', why: 'nobody' };
      if (locationId.trim() === '') return { result: 'invalid', why: 'needStore' };
      return call('POST', `/v1/b2b/documents/${enc(customerId)}/orders/${enc(documentId ?? id('SO'))}`, { fromQuotationId: quotationId, locationId: locationId.trim(), ...(approvalId === undefined ? {} : { approvalId }) });
    },
    askOverride: async ({ customerId, quotationId, locationId, valueMinor, reason }) => {
      if (!named) return { result: 'invalid', why: 'nobody' };
      if (locationId.trim() === '') return { result: 'invalid', why: 'needStore' };
      const documentId = id('SO');
      // Exactly the body the order will be made with, plus its path ids (the engine fingerprints these).
      const details = { fromQuotationId: quotationId, locationId: locationId.trim(), customerId, documentId };
      return call('POST', '/v1/approvals/requests', {
        kind: 'b2b_credit_override', subjectRef: `${customerId}/${documentId}`, details, valueMinor,
        summary: `Let ${customerId}'s order from quotation ${quotationId} go over its credit limit`, reason: reason.trim() === '' ? 'over the credit limit' : reason.trim(),
      });
    },
    convertWithApproval: async (request) => {
      if (!named) return { result: 'invalid', why: 'nobody' };
      const d = request.details as { fromQuotationId: string; locationId: string; customerId: string; documentId: string };
      return call('POST', `/v1/b2b/documents/${enc(d.customerId)}/orders/${enc(d.documentId)}`, { fromQuotationId: d.fromQuotationId, locationId: d.locationId, approvalId: request.requestId });
    },
    proforma: async (customerId, orderId) => (named ? doc(customerId, 'proformas', { fromOrderId: orderId }, 'PF') : { result: 'invalid', why: 'nobody' }),
    challan: async (customerId, orderId, dispatched) => {
      if (!named) return { result: 'invalid', why: 'nobody' };
      const map: Record<string, number> = {};
      for (const [lineId, raw] of Object.entries(dispatched)) {
        if (raw.trim() === '') continue;
        const q = Number(raw.trim());
        if (!Number.isInteger(q) || q < 0) return { result: 'invalid', why: 'needDispatched' };
        map[lineId] = q;
      }
      if (Object.values(map).every((q) => q === 0)) return { result: 'invalid', why: 'needDispatched' };
      return doc(customerId, 'challans', { fromOrderId: orderId, dispatched: map }, 'DC');
    },
    invoice: async (customerId, orderId, deliveryStateCode) => (named
      ? doc(customerId, 'invoices', { fromOrderId: orderId, ...(deliveryStateCode.trim() === '' ? {} : { deliveryStateCode: deliveryStateCode.trim() }) }, 'INV')
      : { result: 'invalid', why: 'nobody' }),
    proposeContract: async (c) => {
      if (!named) return { result: 'invalid', why: 'nobody' };
      const b = contractOf(c);
      if (typeof b === 'string') return { result: 'invalid', why: b };
      return call('POST', `/v1/b2b/contracts/${enc(b.customerId)}/${enc(b.contractId)}`, b.body);
    },
    askContractApproval: async (c, reason) => {
      if (!named) return { result: 'invalid', why: 'nobody' };
      const b = contractOf(c);
      if (typeof b === 'string') return { result: 'invalid', why: b };
      return call('POST', '/v1/approvals/requests', {
        kind: 'b2b_contract', subjectRef: `${b.customerId}/${b.contractId}`, details: { ...b.body, customerId: b.customerId, contractId: b.contractId }, valueMinor: null,
        summary: `Contract ${b.contractId} for ${b.customerId}, ${b.body['validFrom'] as string} to ${b.body['validTo'] as string}`, reason: reason.trim() === '' ? 'new contract terms' : reason.trim(),
      });
    },
    putContractInForce: async (request) => {
      if (!named) return { result: 'invalid', why: 'nobody' };
      // Exactly what was approved: the details minus the path ids, naming the approval.
      const { customerId, contractId, ...body } = request.details as Record<string, unknown> & { customerId: string; contractId: string };
      return call('POST', `/v1/b2b/contracts/${enc(customerId)}/${enc(contractId)}`, { ...body, approvalId: request.requestId });
    },
    recordPayment: async (customerId, rupeesReceived) => {
      if (!named) return { result: 'invalid', why: 'nobody' };
      if (customerId.trim() === '') return { result: 'invalid', why: 'needCustomer' };
      const paise = paiseOfRupees(rupeesReceived);
      if (paise === undefined || paise === 0) return { result: 'invalid', why: 'needMoney' };
      return call('POST', `/v1/b2b/collections/${enc(customerId.trim())}/payments/${enc(id('RCPT'))}`, { receivedMinor: paise });
    },
  };
}
