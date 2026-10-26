// The Supplier offer funding page (M05-FR-04 "… vendor funding …"; acceptance "vendor-funded value reconciles to finance"
// · QG-02 · OB-288 P2). A tested, DOM-free session over head office's own funding record (services/finance/src/vendor-funding.ts):
//   • THE REGISTER — each offer a supplier funds: the rate a unit, the cap, the units sold under the offer FOLDED from the
//     banked bills (never typed), what that earns, what has been received, what the ledger holds and what is outstanding —
//     with every finding by exception (not approved by Finance, ledger differs, received more than earned, ended with money
//     outstanding, bills not fully judged);
//   • THE AGREEMENT — the person who launches offers records what the supplier agreed to pay a unit; Finance's approval is
//     named by its approval number (never a typed name) — without one it stays flagged "not approved";
//   • A RECEIPT — finance records money received; head office posts it as a journal (the journal IS the receipt) and
//     refuses one that would pass the cap.
// Head office re-checks every permission and approval; `may` only shapes what is offered. Nothing is read on open.

import { makeCaller, outcomeIn, newId, type Outcome } from './r4-insight-call';
import { paiseOf, rupees } from './blanket-orders-session';

export { rupees };
export type Lang = 'en' | 'ta';

export const PROMOTION_FUNDING_COPY = {
  en: {
    title: 'Supplier offer funding', lead: 'What each supplier agreed to pay towards an offer, what the bills say it earned, what was received and what the books hold — every difference shown.',
    show: 'Show the funding', registerH: 'Funding by offer and supplier', none: 'No supplier funds an offer yet.', offer: 'Offer', supplier: 'Supplier', rate: 'A unit', cap: 'Cap', noCap: 'no cap',
    units: 'Units sold under the offer', earned: 'Earned', received: 'Received', ledger: 'In the books', outstanding: 'Outstanding', agrees: 'Books agree', differs: 'Books differ',
    totals: 'All offers', attention: 'need attention', unitsFrom: 'Units are counted from the banked bills, re-judged by the till\'s own offer rules — never typed.',
    noIncome: 'The posting map names no income account for supplier funding — the books cannot agree until the accountant maps it.',
    f_not_approved_by_finance: 'Not approved by Finance', f_ledger_differs: 'The books differ from the receipts', f_received_more_than_earned: 'Received more than the bills earned',
    f_ended_with_money_outstanding: 'The offer ended with money still owed', f_units_not_fully_judged: 'Some bills could not be judged', f_promotion_not_defined: 'The offer is not on record',
    agreeH: 'Record what a supplier agreed', offerId: 'Offer code', supplierId: 'Supplier code', perUnit: 'Pays a unit (₹)', capRs: 'Cap (₹, optional)', products: 'Only these products (codes, comma between; optional)',
    approvalId: 'Finance\'s approval number (if approved)', record: 'Record the agreement', receiptH: 'Record money received', amount: 'Amount received (₹)', receivedOn: 'Received on (YYYY-MM-DD)', reference: 'Bank or cheque reference',
    recordReceipt: 'Record the receipt', saved: 'Done — head office recorded it.', approvedNow: 'Recorded and approved by Finance.', notApprovedYet: 'Recorded — flagged "not approved" until Finance approves it.', already: 'Already recorded — nothing changed.',
    needAgreement: 'Fill in the offer, the supplier and what it pays a unit.', needReceipt: 'Fill in the offer, the supplier, the amount, the day and the reference.',
    nobody: 'Nobody is signed in on this screen.', cannotRead: 'Your role cannot read the funding register.', cannotRecord: 'Your role cannot record a funding agreement.', cannotReceipt: 'Your role cannot record a receipt.',
    refused: 'Head office refused:', unreachable: 'Head office cannot be reached — nothing was read or saved.',
  },
  ta: {
    title: 'விநியோகஸ்தர் சலுகை நிதி', lead: 'ஒவ்வொரு விநியோகஸ்தரும் ஒரு சலுகைக்குச் செலுத்த ஒப்புக்கொண்டது, பில்கள் சொல்லும் ஈட்டியது, பெறப்பட்டது, கணக்கேட்டில் உள்ளது — ஒவ்வொரு வேறுபாடும் காட்டப்படும்.',
    show: 'நிதியைக் காட்டு', registerH: 'சலுகை மற்றும் விநியோகஸ்தர் வாரியான நிதி', none: 'இன்னும் எந்த விநியோகஸ்தரும் சலுகைக்கு நிதி தரவில்லை.', offer: 'சலுகை', supplier: 'விநியோகஸ்தர்', rate: 'ஒரு அலகுக்கு', cap: 'உச்சவரம்பு', noCap: 'உச்சவரம்பு இல்லை',
    units: 'சலுகையில் விற்ற அலகுகள்', earned: 'ஈட்டியது', received: 'பெறப்பட்டது', ledger: 'கணக்கேட்டில்', outstanding: 'நிலுவை', agrees: 'கணக்கு பொருந்துகிறது', differs: 'கணக்கு வேறுபடுகிறது',
    totals: 'அனைத்துச் சலுகைகளும்', attention: 'கவனம் தேவை', unitsFrom: 'அலகுகள் வங்கியில் செலுத்திய பில்களிலிருந்து, கவுண்டரின் சொந்த சலுகை விதிகளால் மீண்டும் மதிப்பிட்டு எண்ணப்படுகின்றன — ஒருபோதும் தட்டச்சு செய்யப்படுவதில்லை.',
    noIncome: 'பதிவு வரைபடத்தில் விநியோகஸ்தர் நிதிக்கு வருமானக் கணக்கு இல்லை — கணக்காளர் அதை வரையறுக்கும் வரை கணக்கு பொருந்தாது.',
    f_not_approved_by_finance: 'நிதித்துறை அனுமதிக்கவில்லை', f_ledger_differs: 'கணக்கேடு ரசீதுகளிலிருந்து வேறுபடுகிறது', f_received_more_than_earned: 'பில்கள் ஈட்டியதை விட அதிகம் பெறப்பட்டது',
    f_ended_with_money_outstanding: 'சலுகை முடிந்தும் பணம் நிலுவையில் உள்ளது', f_units_not_fully_judged: 'சில பில்களை மதிப்பிட முடியவில்லை', f_promotion_not_defined: 'சலுகை பதிவில் இல்லை',
    agreeH: 'விநியோகஸ்தர் ஒப்புக்கொண்டதைப் பதிவு செய்', offerId: 'சலுகைக் குறியீடு', supplierId: 'விநியோகஸ்தர் குறியீடு', perUnit: 'ஒரு அலகுக்குச் செலுத்துவது (₹)', capRs: 'உச்சவரம்பு (₹, விருப்பம்)', products: 'இந்தப் பொருட்கள் மட்டும் (குறியீடுகள், காற்புள்ளியால் பிரித்து; விருப்பம்)',
    approvalId: 'நிதித்துறையின் அனுமதி எண் (அனுமதிக்கப்பட்டிருந்தால்)', record: 'ஒப்பந்தத்தைப் பதிவு செய்', receiptH: 'பெற்ற பணத்தைப் பதிவு செய்', amount: 'பெற்ற தொகை (₹)', receivedOn: 'பெற்ற நாள் (YYYY-MM-DD)', reference: 'வங்கி அல்லது காசோலைக் குறிப்பு',
    recordReceipt: 'ரசீதைப் பதிவு செய்', saved: 'முடிந்தது — தலைமை அலுவலகம் பதிவு செய்தது.', approvedNow: 'பதிவானது, நிதித்துறை அனுமதித்தது.', notApprovedYet: 'பதிவானது — நிதித்துறை அனுமதிக்கும் வரை "அனுமதிக்கப்படவில்லை" எனக் குறிக்கப்படும்.', already: 'ஏற்கனவே பதிவானது — எதுவும் மாறவில்லை.',
    needAgreement: 'சலுகை, விநியோகஸ்தர், ஒரு அலகுக்குச் செலுத்துவது ஆகியவற்றை நிரப்புங்கள்.', needReceipt: 'சலுகை, விநியோகஸ்தர், தொகை, நாள், குறிப்பு ஆகியவற்றை நிரப்புங்கள்.',
    nobody: 'இந்தத் திரையில் யாரும் உள்நுழையவில்லை.', cannotRead: 'உங்கள் பணி நிதிப் பதிவேட்டைப் படிக்க முடியாது.', cannotRecord: 'உங்கள் பணி நிதி ஒப்பந்தத்தைப் பதிவு செய்ய முடியாது.', cannotReceipt: 'உங்கள் பணி ரசீதைப் பதிவு செய்ய முடியாது.',
    refused: 'தலைமை அலுவலகம் மறுத்தது:', unreachable: 'தலைமை அலுவலகத்தை அடைய முடியவில்லை — எதுவும் படிக்கவோ சேமிக்கவோ இல்லை.',
  },
} as const;

export const fundingWords = (lang: Lang, key: string): string =>
  (PROMOTION_FUNDING_COPY[lang] as Record<string, string>)[key] ?? (PROMOTION_FUNDING_COPY.en as Record<string, string>)[key] ?? key;
export const fundingOutcomeWords = (lang: Lang, out: Outcome<unknown>): string => {
  if (out.result !== 'ok') return outcomeIn((k) => fundingWords(lang, k), out);
  const v = out.value as { approved?: boolean; alreadyRecorded?: boolean };
  if (v.alreadyRecorded === true) return fundingWords(lang, 'already');
  if (v.approved === true) return fundingWords(lang, 'approvedNow');
  if (v.approved === false) return fundingWords(lang, 'notApprovedYet');
  return fundingWords(lang, 'saved');
};

export interface FundingLine {
  readonly promotionId: string; readonly supplierId: string; readonly perUnitMinor: number; readonly capMinor: number | null; readonly unitsSold: number;
  readonly billsUnderOffer: number; readonly billsNotJudged: number; readonly earnedMinor: number; readonly receivedMinor: number; readonly ledgerMinor: number;
  readonly outstandingMinor: number; readonly agrees: boolean; readonly approved: boolean; readonly findings: readonly string[];
}
export interface FundingRegister {
  readonly lines: readonly FundingLine[]; readonly agrees: boolean; readonly incomeAccount: string | null; readonly earnedMinor: number; readonly receivedMinor: number;
  readonly ledgerMinor: number; readonly needingAttention: number; readonly unitsFrom: string; readonly asAt: string;
}
export interface AgreementForm { readonly promotionId: string; readonly supplierId: string; readonly perUnitRupees: string; readonly capRupees: string; readonly productIds: string; readonly approvalId: string }
export interface ReceiptForm { readonly promotionId: string; readonly supplierId: string; readonly amountRupees: string; readonly receivedOn: string; readonly reference: string }

export interface PromotionFundingSession {
  readonly may: { readonly named: boolean; readonly read: boolean; readonly record: boolean; readonly receipt: boolean };
  register(): Promise<Outcome<FundingRegister, 'nobody' | 'cannotRead'>>;
  agree(form: AgreementForm): Promise<Outcome<{ readonly approved: boolean }, 'nobody' | 'cannotRecord' | 'needAgreement'>>;
  receipt(form: ReceiptForm): Promise<Outcome<{ readonly alreadyRecorded: boolean }, 'nobody' | 'cannotReceipt' | 'needReceipt'>>;
}

const seg = (s: string): string => encodeURIComponent(s.trim());

export function createPromotionFundingSession(input: { readonly viewer: { readonly userId?: string; readonly permissions: readonly string[] } | undefined; readonly fetch?: typeof globalThis.fetch; readonly newKey?: () => string; readonly newReceiptId?: () => string }): PromotionFundingSession {
  const named = input.viewer?.userId !== undefined;
  const held = new Set(input.viewer?.permissions ?? []);
  const may = { named, read: named && held.has('finance.period.read'), record: named && held.has('promotion.launch'), receipt: named && held.has('finance.journal.post') };
  const call = makeCaller({ keyPrefix: 'funding', ...(input.fetch === undefined ? {} : { fetch: input.fetch }), ...(input.newKey === undefined ? {} : { newKey: input.newKey }) });
  const receiptIdOf = input.newReceiptId ?? (() => newId('rcpt'));
  return {
    may,
    register: async () => {
      if (!named) return { result: 'invalid', why: 'nobody' };
      if (!may.read) return { result: 'invalid', why: 'cannotRead' };
      return call('GET', '/v1/finance/promotion-funding');
    },
    agree: async (f) => {
      if (!named) return { result: 'invalid', why: 'nobody' };
      if (!may.record) return { result: 'invalid', why: 'cannotRecord' };
      const perUnitMinor = paiseOf(f.perUnitRupees);
      const capMinor = f.capRupees.trim() === '' ? undefined : paiseOf(f.capRupees);
      if (f.promotionId.trim() === '' || f.supplierId.trim() === '' || perUnitMinor === null || perUnitMinor <= 0 || capMinor === null || capMinor === 0) return { result: 'invalid', why: 'needAgreement' };
      const productIds = f.productIds.split(',').map((p) => p.trim()).filter((p) => p !== '');
      return call('POST', `/v1/promotions/${seg(f.promotionId)}/funding/${seg(f.supplierId)}`, {
        perUnitMinor, ...(capMinor === undefined ? {} : { capMinor }), ...(productIds.length === 0 ? {} : { productIds }),
        ...(f.approvalId.trim() === '' ? {} : { approvalId: f.approvalId.trim() }),
      });
    },
    receipt: async (f) => {
      if (!named) return { result: 'invalid', why: 'nobody' };
      if (!may.receipt) return { result: 'invalid', why: 'cannotReceipt' };
      const amountMinor = paiseOf(f.amountRupees);
      if (f.promotionId.trim() === '' || f.supplierId.trim() === '' || amountMinor === null || amountMinor <= 0 || !/^\d{4}-\d{2}-\d{2}$/.test(f.receivedOn.trim()) || f.reference.trim() === '') {
        return { result: 'invalid', why: 'needReceipt' };
      }
      return call('POST', `/v1/finance/promotion-funding/${seg(f.promotionId)}/${seg(f.supplierId)}/receipts/${encodeURIComponent(receiptIdOf())}`, {
        amountMinor, receivedOn: f.receivedOn.trim(), reference: f.reference.trim(),
      });
    },
  };
}
