// Supplier claims (U6 of the UI/UX gap audit · §27 "Purchase — claims" was PARTIAL · M07-FR-03 "supplier claim raised where
// due" · M24-FR-02 "a supplier raises claims" · §28) — the Supplier claims page's tested, DOM-free session over ONE head
// office register, `GET /v1/purchase/supplier-claims` (`purchase.commitment.read`), that reads both sides from the records
// head office already holds — never a second copy:
//   • the SHOP's claims on a supplier: a debit note a second person's return or claim of short or damaged goods raised
//     (raised until a person ISSUES it under a number — `POST /v1/purchase/suppliers/:id/debit-notes/:ref/issue`,
//     `purchase.invoice.match`, money: the confirm sheet first), goods refused at the dock and never owed, a return still
//     to go back, the numbered debit notes from the DSD door;
//   • the SUPPLIERS' claims on the shop, sent through the portal: awaiting a buyer until one ACCEPTS or REJECTS it with a
//     reason (`POST /v1/supplier-portal/partners/:id/submissions/:sid/review`, `supplier.portal.review`, never the person
//     who sent it; accepting is money — the confirm sheet first).
// The session refuses only the cheap things before a request; head office refuses everything else by name and the page
// shows its words. Head office's own sentences stay in English (OB-553); every word this page adds has a Tamil twin.

import type { ViewerIdentity } from './browser-entry';
import { makeCaller, outcomeIn, type Outcome } from './r4-insight-call';

export type Lang = 'en' | 'ta';

export type ShopClaimKind = 'debit_note' | 'refused_at_door' | 'return_pending' | 'door_debit_note';
export type ShopClaimState = 'raised' | 'issued' | 'never_owed' | 'pending' | 'returned';
export interface ShopClaim {
  readonly supplierId: string;
  readonly claimId: string;
  readonly kind: ShopClaimKind;
  readonly grnId: string;
  readonly poId: string | null;
  readonly productId: string | null;
  readonly quantityMinor: number | null;
  readonly uom?: string;
  readonly valueMinor: number | null;
  readonly reason: string;
  readonly raisedAt: string;
  readonly number: string | null;
  readonly state: ShopClaimState;
}
export type SupplierClaimState = 'awaiting_buyer' | 'accepted' | 'rejected';
export interface SupplierClaim {
  readonly supplierId: string;
  readonly submissionId: string;
  readonly poId: string | null;
  readonly claimMinor: number | null;
  readonly why: string;
  readonly receivedAt: string;
  readonly submittedBy: string | null;
  readonly state: SupplierClaimState;
  readonly decidedBy: string | null;
  readonly decidedAt: string | null;
  readonly reason: string | null;
}
export interface ClaimsRegister {
  readonly shopClaims: readonly ShopClaim[];
  readonly supplierClaims: readonly SupplierClaim[];
  readonly counts: Readonly<Record<string, number>>;
  readonly supplierNames: Readonly<Record<string, string>>;
  readonly unattributed: readonly { readonly grnId: string; readonly reason: string }[];
  readonly asAt: string;
}

export const SUPPLIER_CLAIMS_COPY = {
  en: {
    title: 'Supplier claims',
    lead: 'Every claim between the shop and its suppliers over a delivery, in one place: what the shop holds against a supplier for short, damaged or refused goods, and what a supplier has claimed from the shop. Nothing here is a second record — each row is read from the delivery, the account and the portal.',
    shopH: 'The shop\'s claims on suppliers', shopLead: 'A debit note is raised when a second person returns or claims short or damaged goods; it is issued under a number by Finance. Goods refused at the door were never owed.',
    supplierH: 'Suppliers\' claims on the shop', supplierLead: 'What a supplier claimed through its portal. A buyer accepts or rejects it with a reason — never the person who sent it. Nothing counts until a buyer accepts it.',
    refresh: 'Read again from head office', covers: 'Every supplier of this shop · read at {time}',
    supplier: 'Supplier', what: 'What', delivery: 'Delivery', order: 'Order', product: 'Product', quantity: 'Quantity', value: 'Value', state: 'State', number: 'Number', raisedOn: 'Raised on', reason: 'Reason', why: 'Why',
    receivedOn: 'Received on', decidedBy: 'Decided by', claimed: 'Claimed',
    kind_debit_note: 'Debit note (goods returned or claimed)', kind_refused_at_door: 'Refused at the door', kind_return_pending: 'Return to the supplier', kind_door_debit_note: 'Debit note from the door',
    state_raised: 'Raised, not yet issued', state_issued: 'Issued', state_never_owed: 'Never owed', state_pending: 'Waiting to go back', state_returned: 'Gone back',
    state_awaiting_buyer: 'Waiting for a buyer', state_accepted: 'Accepted', state_rejected: 'Rejected',
    issue: 'Issue the debit note', issued: 'Issued under its number.', accept: 'Accept', reject: 'Reject', decided: 'Decided.',
    issueTitle: '{value} will be taken off what the shop owes {supplier}', issueDetail: 'The debit note is issued under the next number of the shop\'s series, in your name, and goes on the supplier\'s statement. It cannot be un-issued.',
    acceptTitle: '{value} claimed by {supplier} will be accepted', acceptDetail: 'The claim is accepted in your name with your reason; the supplier reads it on its portal. Settling the money follows the usual payables path.',
    authority: 'You hold the authority for this; a second person sent or raised it.', confirm: 'Confirm', confirmAccept: 'Accept the claim',
    counts: 'raised · issued · never owed · waiting to go back · waiting for a buyer', notAttributed: 'Deliveries whose claim reaches no supplier (no known order):',
    noneShop: 'No claim on any supplier.', noneShopDetail: 'Head office answered: no delivery has a return, a claim or a refusal recorded.',
    noneSupplier: 'No supplier has claimed anything.', noneSupplierDetail: 'Head office answered: no claim has come through the portal.',
    notKnown: 'Not known', notKnownDetail: 'Head office has not answered, so nothing here is known.',
    nobody: 'Nobody is signed in on this screen.', cannotRead: 'Your role cannot read supplier claims.', cannotIssue: 'Your role cannot issue a debit note.', cannotDecide: 'Your role cannot decide a supplier\'s claim.',
    needReason: 'Give the reason first. Nothing was decided.', notConfirmed: 'Not confirmed — nothing was changed.',
    refused: 'Head office refused:', unreachable: 'Head office cannot be reached — nothing was read or changed.', reading: 'Reading from head office…',
    headOfficeEnglish: 'Head office\'s own sentences are in English.', notKnownValue: 'Not known',
  },
  ta: {
    title: 'விநியோகஸ்தர் உரிமைக்கோரல்கள்',
    lead: 'ஒரு விநியோகம் தொடர்பாக கடைக்கும் விநியோகஸ்தர்களுக்கும் இடையே உள்ள ஒவ்வொரு உரிமைக்கோரலும் ஓரிடத்தில்: குறைவான, சேதமடைந்த அல்லது மறுக்கப்பட்ட பொருட்களுக்காக கடை விநியோகஸ்தர் மீது வைத்திருப்பது, விநியோகஸ்தர் கடையிடம் கோரியது. இங்கே எதுவும் இரண்டாவது பதிவு அல்ல — ஒவ்வொரு வரியும் விநியோகம், கணக்கு, போர்ட்டலில் இருந்து படிக்கப்படுகிறது.',
    shopH: 'விநியோகஸ்தர்கள் மீது கடையின் உரிமைக்கோரல்கள்', shopLead: 'இரண்டாம் நபர் குறைவான அல்லது சேதமடைந்த பொருட்களைத் திருப்பும்போது அல்லது கோரும்போது பற்றுக்குறிப்பு எழுப்பப்படும்; நிதித்துறை அதை ஒரு எண்ணில் வெளியிடும். வாசலில் மறுக்கப்பட்ட பொருட்களுக்கு ஒருபோதும் கடன் இல்லை.',
    supplierH: 'கடை மீது விநியோகஸ்தர்களின் உரிமைக்கோரல்கள்', supplierLead: 'விநியோகஸ்தர் தன் போர்ட்டல் வழியாகக் கோரியது. வாங்குபவர் காரணத்துடன் ஏற்கிறார் அல்லது மறுக்கிறார் — அனுப்பியவர் ஒருபோதும் அல்ல. வாங்குபவர் ஏற்கும் வரை எதுவும் கணக்கில் வராது.',
    refresh: 'தலைமை அலுவலகத்திலிருந்து மீண்டும் படி', covers: 'இந்தக் கடையின் ஒவ்வொரு விநியோகஸ்தரும் · படித்தது {time}',
    supplier: 'விநியோகஸ்தர்', what: 'என்ன', delivery: 'விநியோகம்', order: 'ஆணை', product: 'பொருள்', quantity: 'அளவு', value: 'மதிப்பு', state: 'நிலை', number: 'எண்', raisedOn: 'எழுப்பிய நாள்', reason: 'காரணம்', why: 'ஏன்',
    receivedOn: 'பெற்ற நாள்', decidedBy: 'முடிவு செய்தவர்', claimed: 'கோரியது',
    kind_debit_note: 'பற்றுக்குறிப்பு (திருப்பிய அல்லது கோரிய பொருட்கள்)', kind_refused_at_door: 'வாசலில் மறுக்கப்பட்டது', kind_return_pending: 'விநியோகஸ்தருக்குத் திருப்புதல்', kind_door_debit_note: 'வாசலில் இருந்து பற்றுக்குறிப்பு',
    state_raised: 'எழுப்பப்பட்டது, இன்னும் வெளியிடவில்லை', state_issued: 'வெளியிடப்பட்டது', state_never_owed: 'ஒருபோதும் கடன் இல்லை', state_pending: 'திரும்பச் செல்லக் காத்திருக்கிறது', state_returned: 'திரும்பிச் சென்றது',
    state_awaiting_buyer: 'வாங்குபவருக்காகக் காத்திருக்கிறது', state_accepted: 'ஏற்கப்பட்டது', state_rejected: 'மறுக்கப்பட்டது',
    issue: 'பற்றுக்குறிப்பை வெளியிடு', issued: 'அதன் எண்ணில் வெளியிடப்பட்டது.', accept: 'ஏற்று', reject: 'மறு', decided: 'முடிவு செய்யப்பட்டது.',
    issueTitle: '{supplier}க்கு கடை கொடுக்க வேண்டியதிலிருந்து {value} கழிக்கப்படும்', issueDetail: 'பற்றுக்குறிப்பு கடையின் வரிசையின் அடுத்த எண்ணில், உங்கள் பெயரில் வெளியிடப்பட்டு விநியோகஸ்தரின் அறிக்கையில் சேரும். அதைத் திரும்பப் பெற முடியாது.',
    acceptTitle: '{supplier} கோரிய {value} ஏற்கப்படும்', acceptDetail: 'கோரல் உங்கள் பெயரில் உங்கள் காரணத்துடன் ஏற்கப்படும்; விநியோகஸ்தர் அதைத் தன் போர்ட்டலில் படிப்பார். பணத்தைத் தீர்ப்பது வழக்கமான கொடுக்க வேண்டியவை பாதையில் தொடரும்.',
    authority: 'இதற்கான அதிகாரம் உங்களிடம் உள்ளது; இரண்டாம் நபர் இதை அனுப்பினார் அல்லது எழுப்பினார்.', confirm: 'உறுதிப்படுத்து', confirmAccept: 'கோரலை ஏற்று',
    counts: 'எழுப்பியவை · வெளியிட்டவை · கடன் இல்லாதவை · திரும்பக் காத்திருப்பவை · வாங்குபவருக்காகக் காத்திருப்பவை', notAttributed: 'எந்த விநியோகஸ்தரையும் சேராத உரிமைக்கோரல் உள்ள விநியோகங்கள் (தெரிந்த ஆணை இல்லை):',
    noneShop: 'எந்த விநியோகஸ்தர் மீதும் உரிமைக்கோரல் இல்லை.', noneShopDetail: 'தலைமை அலுவலகம் பதிலளித்தது: எந்த விநியோகத்திலும் திருப்புதல், கோரல் அல்லது மறுப்பு பதிவாகவில்லை.',
    noneSupplier: 'எந்த விநியோகஸ்தரும் எதையும் கோரவில்லை.', noneSupplierDetail: 'தலைமை அலுவலகம் பதிலளித்தது: போர்ட்டல் வழியாக எந்தக் கோரலும் வரவில்லை.',
    notKnown: 'தெரியவில்லை', notKnownDetail: 'தலைமை அலுவலகம் பதிலளிக்கவில்லை, எனவே இங்கே எதுவும் தெரியாது.',
    nobody: 'இந்தத் திரையில் யாரும் உள்நுழையவில்லை.', cannotRead: 'உங்கள் பணிப் பொறுப்பால் விநியோகஸ்தர் உரிமைக்கோரல்களைப் படிக்க முடியாது.', cannotIssue: 'உங்கள் பணிப் பொறுப்பால் பற்றுக்குறிப்பை வெளியிட முடியாது.', cannotDecide: 'உங்கள் பணிப் பொறுப்பால் விநியோகஸ்தரின் கோரலை முடிவு செய்ய முடியாது.',
    needReason: 'முதலில் காரணத்தைக் கொடுங்கள். எதுவும் முடிவு செய்யப்படவில்லை.', notConfirmed: 'உறுதிப்படுத்தவில்லை — எதுவும் மாற்றப்படவில்லை.',
    refused: 'தலைமை அலுவலகம் மறுத்தது:', unreachable: 'தலைமை அலுவலகத்தை அடைய முடியவில்லை — எதுவும் படிக்கவோ மாற்றவோ இல்லை.', reading: 'தலைமை அலுவலகத்திலிருந்து படிக்கிறது…',
    headOfficeEnglish: 'தலைமை அலுவலகத்தின் சொந்த வாக்கியங்கள் ஆங்கிலத்தில் உள்ளன.', notKnownValue: 'தெரியவில்லை',
  },
} as const;
export type SupplierClaimsCopyKey = keyof typeof SUPPLIER_CLAIMS_COPY.en;

export const supplierClaimsWords = (lang: Lang, key: SupplierClaimsCopyKey | string): string =>
  (SUPPLIER_CLAIMS_COPY[lang] as Record<string, string>)[key] ?? (SUPPLIER_CLAIMS_COPY.en as Record<string, string>)[key] ?? key;
export const supplierClaimsOutcomeWords = (lang: Lang, out: Outcome<unknown>): string => outcomeIn((k) => supplierClaimsWords(lang, k), out, lang);

/** The chip's tone for a claim's state. Pure. */
export function claimStateTone(state: ShopClaimState | SupplierClaimState): 'ok' | 'pending' | 'degraded' | 'error' | 'idle' {
  switch (state) {
    case 'issued': case 'returned': case 'accepted': return 'ok';
    case 'raised': case 'pending': case 'awaiting_buyer': return 'pending';
    case 'rejected': return 'error';
    case 'never_owed': return 'idle';
    default: return 'idle';
  }
}

/** Rupees as the page prints a figure head office gave in paise; "Not known" words come from the page for a null. */
export const rupees = (minor: number): string => `₹${(minor / 100).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

/** The supplier's name beside its id when head office knows it; the id alone otherwise, never blank (G16). Pure. */
export const supplierLabel = (reg: Pick<ClaimsRegister, 'supplierNames'>, supplierId: string): string =>
  reg.supplierNames[supplierId] === undefined ? supplierId : `${reg.supplierNames[supplierId]} (${supplierId})`;

export interface SupplierClaimsSession {
  readonly may: { readonly named: boolean; readonly read: boolean; readonly issue: boolean; readonly decide: boolean };
  register(): Promise<Outcome<ClaimsRegister>>;
  issue(claim: Pick<ShopClaim, 'supplierId' | 'claimId'>): Promise<Outcome<{ readonly number: string }>>;
  decide(claim: Pick<SupplierClaim, 'supplierId' | 'submissionId'>, decision: 'accept' | 'reject', reason: string): Promise<Outcome<unknown>>;
}

export function createSupplierClaimsSession(input: { readonly viewer: ViewerIdentity | undefined; readonly fetch?: typeof globalThis.fetch; readonly newKey?: () => string }): SupplierClaimsSession {
  const perms = new Set(input.viewer?.permissions ?? []);
  const named = input.viewer?.userId !== undefined;
  const may = { named, read: named && perms.has('purchase.commitment.read'), issue: named && perms.has('purchase.invoice.match'), decide: named && perms.has('supplier.portal.review') };
  const call = makeCaller({ keyPrefix: 'supplier-claims', ...(input.fetch === undefined ? {} : { fetch: input.fetch }), ...(input.newKey === undefined ? {} : { newKey: input.newKey }) });
  const enc = encodeURIComponent;
  const gate = (need: 'read' | 'issue' | 'decide'): Outcome<never> | undefined =>
    !named ? { result: 'invalid', why: 'nobody' } : !may[need] ? { result: 'invalid', why: need === 'read' ? 'cannotRead' : need === 'issue' ? 'cannotIssue' : 'cannotDecide' } : undefined;
  return {
    may,
    register: async () => { const g = gate('read'); return g ?? call<ClaimsRegister>('GET', '/v1/purchase/supplier-claims'); },
    issue: async (c) => { const g = gate('issue'); return g ?? call<{ number: string }>('POST', `/v1/purchase/suppliers/${enc(c.supplierId)}/debit-notes/${enc(c.claimId)}/issue`, {}); },
    decide: async (c, decision, reason) => {
      const g = gate('decide'); if (g !== undefined) return g;
      if (reason.trim() === '') return { result: 'invalid', why: 'needReason' };
      return call('POST', `/v1/supplier-portal/partners/${enc(c.supplierId)}/submissions/${enc(c.submissionId)}/review`, { decision, reason: reason.trim() });
    },
  };
}
