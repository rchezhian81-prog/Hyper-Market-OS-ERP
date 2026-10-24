// The Investigations page's "from the shop's own records" section (M15-FR-02 · M15-FR-03 · OB-301 · audit-2 P4).
// A tested, DOM-free session. On a click it reads three things head office works out from its own records:
//   • the fraud signals over the stored coupons, points, cash on delivery and supplier bills (GET /v1/fraud-signals/stored),
//     each traced to its records, with how many records each register gave;
//   • the staff purchases that arrived and what the rule says of each (GET /v1/loss-prevention/staff-purchases/exceptions),
//     with the owner's two numbers or "not set";
//   • bank accounts shared between suppliers and staff (GET /v1/fraud-signals/duplicate-bank), masked.
// Read only: a signal is a reason to look, never a verdict (hard rule #5). English and Tamil.

import { makeCaller, type Outcome } from './r4-insight-call';

export type Lang = 'en' | 'ta';

export const LP_SIGNALS_COPY = {
  en: {
    heading: 'From the shop\'s own records', lead: 'Coupons, points, cash on delivery and supplier bills head office holds, staff shopping, and bank accounts shared — each a reason to look, never a verdict. Nothing is blocked from here.',
    read: 'Read the records', from: 'From', to: 'To', signals: 'Fraud signals', none: 'No signal in this window.', reconciles: 'Traced to its records', notTraced: 'Not traced to its records:',
    strong: 'Strong', probable: 'Probable', weak: 'Weak — a look only', value: 'At stake', evidence: 'Records', read2: 'read', notKnown: 'not known —',
    coupon: 'Coupons', loyalty: 'Points', delivery: 'Cash on delivery', supplier: 'Supplier bills', notValued: 'counted but not valued (a percentage coupon)',
    staff: 'Staff purchases', staffNone: 'No staff purchase arrived in this window.', cap: 'Staff discount (owner)', desk: 'Service-desk till (owner)', notSet: 'not set',
    allowed: 'Within the rule', refused: 'Against the rule', bank: 'Shared bank accounts', bankNone: 'No bank account is shared between holders.', employeesFolded: 'staff salary accounts compared',
    supplierH: 'Supplier', employeeH: 'Staff member', blocked: 'Payment blocked until a person reviews it',
    cannotRead: 'Your role cannot read investigations.', nobody: 'Nobody is signed in on this screen.', refusedW: 'Head office refused:', unreachable: 'Head office cannot be reached — nothing was read.',
    k_coupon_beyond_limit: 'A coupon used past its own limit', k_coupon_concentrated_on_one_account: 'Coupon use piled on one account', k_loyalty_earn_without_sale: 'Points with no sale behind them',
    k_loyalty_burn_spike: 'Points spent far above the account\'s own habit', k_cod_short_repeatedly: 'Cash on delivery short, again and again', k_cod_collected_but_not_banked: 'Cash collected and not handed in',
    k_supplier_price_out_of_history: 'A supplier price far from its own history', k_supplier_quantity_out_of_history: 'A supplier quantity far from its own history',
    r_self_billing: 'Rang their own shopping', r_not_at_service_desk: 'Not at the service desk', r_discount_above_cap: 'More off than the staff discount',
  },
  ta: {
    heading: 'கடையின் சொந்தப் பதிவுகளிலிருந்து', lead: 'தலைமை அலுவலகம் வைத்திருக்கும் கூப்பன்கள், புள்ளிகள், டெலிவரியில் பணம், சப்ளையர் பில்கள், பணியாளர் வாங்கல், பகிரப்பட்ட வங்கிக் கணக்குகள் — ஒவ்வொன்றும் பார்க்க ஒரு காரணம், தீர்ப்பு அல்ல. இங்கிருந்து எதுவும் தடுக்கப்படாது.',
    read: 'பதிவுகளைப் படி', from: 'முதல்', to: 'வரை', signals: 'மோசடி அறிகுறிகள்', none: 'இந்தக் காலத்தில் அறிகுறி இல்லை.', reconciles: 'அதன் பதிவுகளுடன் சரிபார்க்கப்பட்டது', notTraced: 'பதிவுகளுடன் பொருந்தவில்லை:',
    strong: 'வலுவானது', probable: 'சாத்தியமானது', weak: 'பலவீனம் — பார்வைக்கு மட்டும்', value: 'ஆபத்தில் உள்ள தொகை', evidence: 'பதிவுகள்', read2: 'படிக்கப்பட்டது', notKnown: 'தெரியவில்லை —',
    coupon: 'கூப்பன்கள்', loyalty: 'புள்ளிகள்', delivery: 'டெலிவரியில் பணம்', supplier: 'சப்ளையர் பில்கள்', notValued: 'எண்ணப்பட்டது, மதிப்பிடப்படவில்லை (சதவீதக் கூப்பன்)',
    staff: 'பணியாளர் வாங்கல்', staffNone: 'இந்தக் காலத்தில் பணியாளர் வாங்கல் இல்லை.', cap: 'பணியாளர் தள்ளுபடி (உரிமையாளர்)', desk: 'சேவை மேசைக் கவுண்டர் (உரிமையாளர்)', notSet: 'அமைக்கப்படவில்லை',
    allowed: 'விதிக்குள்', refused: 'விதிக்கு எதிராக', bank: 'பகிரப்பட்ட வங்கிக் கணக்குகள்', bankNone: 'எந்த வங்கிக் கணக்கும் பகிரப்படவில்லை.', employeesFolded: 'பணியாளர் சம்பளக் கணக்குகள் ஒப்பிடப்பட்டன',
    supplierH: 'சப்ளையர்', employeeH: 'பணியாளர்', blocked: 'ஒருவர் பார்க்கும் வரை பணம் செலுத்துதல் தடுக்கப்பட்டது',
    cannotRead: 'உங்கள் பங்கு விசாரணைகளைப் படிக்க முடியாது.', nobody: 'இந்தத் திரையில் யாரும் உள்நுழையவில்லை.', refusedW: 'தலைமை அலுவலகம் மறுத்தது:', unreachable: 'தலைமை அலுவலகத்தை அடைய முடியவில்லை — எதுவும் படிக்கப்படவில்லை.',
    k_coupon_beyond_limit: 'தன் வரம்பைத் தாண்டிப் பயன்படுத்திய கூப்பன்', k_coupon_concentrated_on_one_account: 'ஒரே கணக்கில் குவிந்த கூப்பன் பயன்பாடு', k_loyalty_earn_without_sale: 'விற்பனை இல்லாத புள்ளிகள்',
    k_loyalty_burn_spike: 'கணக்கின் வழக்கத்தை விட மிக அதிகமாகச் செலவான புள்ளிகள்', k_cod_short_repeatedly: 'டெலிவரிப் பணம் மீண்டும் மீண்டும் குறைவு', k_cod_collected_but_not_banked: 'வசூலித்த பணம் ஒப்படைக்கப்படவில்லை',
    k_supplier_price_out_of_history: 'சப்ளையரின் வழக்கமான விலையிலிருந்து மிக விலகிய விலை', k_supplier_quantity_out_of_history: 'சப்ளையரின் வழக்கமான அளவிலிருந்து மிக விலகிய அளவு',
    r_self_billing: 'தன் சொந்தப் பொருட்களுக்குப் பில் போட்டார்', r_not_at_service_desk: 'சேவை மேசையில் இல்லை', r_discount_above_cap: 'பணியாளர் தள்ளுபடியை விட அதிகம்',
  },
} as const;

export const lpSignalsWords = (lang: Lang, key: string): string =>
  (LP_SIGNALS_COPY[lang] as Record<string, string>)[key] ?? (LP_SIGNALS_COPY.en as Record<string, string>)[key] ?? key;

export interface StoredSignal { readonly signalId: string; readonly domain: string; readonly kind: string; readonly subjectRef: string; readonly confidence: 'strong' | 'probable' | 'weak'; readonly valueMinor: number; readonly evidenceRefs: readonly string[]; readonly detail: string; readonly reconciles: boolean; readonly unmatchedEvidence: readonly string[] }
export interface SourceRow { readonly domain: string; readonly known: boolean; readonly read: number; readonly history?: number; readonly notValued?: number; readonly why?: string }
export interface StaffBillRow { readonly saleId: string; readonly receiptNumber: string; readonly laneId: string; readonly cashierId: string; readonly employeeId: string; readonly committedAt: string; readonly totalMinor: number; readonly discountBps: number; readonly allowed: boolean; readonly refusals: readonly string[]; readonly words: { readonly en: string; readonly ta: string } }
export interface LpRecordsRead {
  readonly signals: { readonly signals: readonly StoredSignal[]; readonly sources: readonly SourceRow[]; readonly allReconcile: boolean };
  readonly staff: { readonly bills: readonly StaffBillRow[]; readonly policy: { readonly staffDiscountCapBps: number | null; readonly serviceDeskLaneIds: readonly string[] | null } };
  readonly bank: { readonly flags: readonly { readonly accountRef: string; readonly holders: readonly { readonly holderId: string; readonly holderType: string }[] }[]; readonly employeesFolded: number };
}

/** Rupees from paise, Indian grouping. */
export const rupees = (minor: number): string => `₹${(minor / 100).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
/** A basis-point figure as a percentage ("10%", "12.5%"). */
export const percent = (bps: number): string => `${Number((bps / 100).toFixed(2))}%`;

/** One source's line in words: "Coupons: 4 read", "Supplier bills: 1 read (5 before)", "Points: not known — why". */
export function sourceWords(lang: Lang, s: SourceRow): string {
  const w = (k: string) => lpSignalsWords(lang, k);
  if (!s.known) return `${w(s.domain)}: ${w('notKnown')} ${s.why ?? ''}`.trim();
  const extra = [s.history === undefined ? '' : ` (+${s.history})`, s.notValued !== undefined && s.notValued > 0 ? ` · ${s.notValued} ${w('notValued')}` : ''].join('');
  return `${w(s.domain)}: ${s.read} ${w('read2')}${extra}`;
}

export function policyWords(lang: Lang, p: LpRecordsRead['staff']['policy']): { readonly cap: string; readonly desk: string } {
  const w = (k: string) => lpSignalsWords(lang, k);
  return { cap: `${w('cap')}: ${p.staffDiscountCapBps === null ? w('notSet') : percent(p.staffDiscountCapBps)}`, desk: `${w('desk')}: ${p.serviceDeskLaneIds === null ? w('notSet') : p.serviceDeskLaneIds.join(', ')}` };
}

export interface LpSignalsSession {
  readonly may: { readonly named: boolean; readonly read: boolean };
  read(input: { readonly from?: string; readonly to?: string }): Promise<Outcome<LpRecordsRead, 'nobody' | 'cannotRead'>>;
}

export function createLpSignalsSession(input: { readonly viewer: { readonly userId?: string; readonly permissions: readonly string[] } | undefined; readonly fetch?: typeof globalThis.fetch }): LpSignalsSession {
  const named = input.viewer?.userId !== undefined;
  const may = { named, read: named && (input.viewer?.permissions ?? []).includes('lp.case.read') };
  const call = makeCaller({ keyPrefix: 'lp-records', ...(input.fetch === undefined ? {} : { fetch: input.fetch }) });
  return {
    may,
    read: async ({ from, to }) => {
      if (!named) return { result: 'invalid', why: 'nobody' };
      if (!may.read) return { result: 'invalid', why: 'cannotRead' };
      const q = new URLSearchParams({ ...(from === undefined || from === '' ? {} : { from }), ...(to === undefined || to === '' ? {} : { to }) }).toString();
      const suffix = q === '' ? '' : `?${q}`;
      const [signals, staff, bank] = await Promise.all([
        call<LpRecordsRead['signals']>('GET', `/v1/fraud-signals/stored${suffix}`), call<LpRecordsRead['staff']>('GET', `/v1/loss-prevention/staff-purchases/exceptions${suffix}`),
        call<LpRecordsRead['bank']>('GET', '/v1/fraud-signals/duplicate-bank'),
      ]);
      for (const o of [signals, staff, bank]) if (o.result !== 'ok') return o;
      return { result: 'ok', value: { signals: (signals as { value: LpRecordsRead['signals'] }).value, staff: (staff as { value: LpRecordsRead['staff'] }).value, bank: (bank as { value: LpRecordsRead['bank'] }).value } };
    },
  };
}
