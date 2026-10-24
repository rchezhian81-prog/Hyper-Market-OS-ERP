// The Concessions page — counters inside the shop that are not the shop's business (M27-FR-01 · M27-FR-02 · M27-FR-03 ·
// M27-FR-04 · §27 · P-07 · OB-288 package 3). OB-304 (owner, 23 Oct 2026): SRE runs no concessions today — the screen is
// built in full and says plainly when the feature is switched off. A tested, DOM-free session over head office's routes:
//   • the COUNTERS: each contract, whether it may trade today and why not, its deposit (a liability, never rent) and its
//     expiry alerts — agreement, insurance and licence, 30 and 7 days ahead and lapsed (GET /v1/concession/contracts);
//   • a CONTRACT recorded, then approved by ANOTHER person (kind concession_contract) and put in force with the approval;
//   • a DEPOSIT received or refunded; a forfeit only with a second person's approval (kind concession_deposit_forfeit);
//   • the PERIOD CHARGE (rent / revenue share / the higher of both, utilities) and the SETTLEMENT against what the tills
//     banked for them — a difference is a valued exception;
//   • the ALERTS put into the owner's inbox now (the worker does it on its own timer too).
// Nothing is read or written on open; every write is a person's click.

import { makeCaller, newId, type Outcome } from './r4-insight-call';

export type Lang = 'en' | 'ta';

export const CONCESSION_COPY = {
  en: {
    title: 'Concessions', lead: 'Counters inside the shop run by someone else: their contract, deposit, rent or revenue share, settlement, and the dates that stop a counter trading. The money the tills take for them is theirs, held for them — never the shop\'s sales.',
    off: 'Concessions are switched off for this shop (the owner\'s decision of 23 Oct 2026: SRE runs none today). The owner turns them on in Setup when a counter is signed.',
    countersH: 'Counters', countersNone: 'No concession counter is recorded.', mayTrade: 'may trade', cannotTrade: 'cannot take new sales', blocked_inactive: 'switched off', blocked_not_approved: 'not approved', blocked_contract_not_started: 'not started', blocked_contract_expired: 'agreement ended', blocked_insurance_lapsed: 'insurance lapsed or missing', blocked_licence_lapsed: 'licence lapsed',
    depositHeld: 'deposit held (owed back to them)', level_within_30_days: 'within 30 days', level_within_7_days: 'within 7 days', level_lapsed: 'lapsed', doc_agreement: 'Agreement', doc_insurance: 'Insurance', doc_licence: 'Licence', notOnRecord: 'not on record',
    raise: 'Tell the owner now', raised: 'alert(s) sent to the owner; already open:',
    contractH: 'Record a contract', contractId: 'Contract id (blank for a new one)', concessionaire: 'Concessionaire id', name: 'Counter name', branch: 'Branch', startsOn: 'Starts', endsOn: 'Ends', basis: 'Charge', basis_fixed_rent: 'Fixed rent', basis_revenue_share: 'Revenue share', basis_higher_of_both: 'Higher of rent and share', rent: 'Rent a month (₹)', share: 'Revenue share (%)', utilities: 'Utilities a month (₹)', deposit: 'Deposit (₹)', insurance: 'Insurance valid until', licence: 'Licence valid until',
    save: 'Save (not yet approved)', askApproval: 'Ask for approval', putInForce: 'Put in force', askedFor: 'Asked for approval', approvedBy: 'approved by', rejectedBy: 'rejected by',
    depositH: 'Deposit', movement: 'Movement', received: 'Received', refunded: 'Refunded', forfeited: 'Forfeited (needs a second person)', amount: 'Amount (₹)', recordDeposit: 'Record it', askForfeit: 'Ask for approval to forfeit',
    chargeH: 'Charge and settlement', contractPick: 'Contract', from: 'From', to: 'To', banked: 'What the tills banked for them (₹)', metered: 'Metered utilities (₹, optional)', readCharge: 'Work out the charge', readSettlement: 'Settle the period',
    gross: 'Their sales', charge: 'Our charge', totalDue: 'Due to us', collected: 'Held for them', payable: 'Payable to them', difference: 'Difference', reconciles: 'Reconciles', doesNot: 'Does NOT reconcile',
    saved: 'Saved.', nobody: 'Nobody is signed in on this screen — you can read nothing.', cannotRead: 'Your role cannot open the concessions.',
    needContract: 'Fill the concessionaire, counter name, branch, both dates, the charge and the deposit.', needMoney: 'Write the amount in rupees, like 5000 or 5000.50.', needWindow: 'Give both dates of the period.', needPick: 'Choose a contract first.',
    refused: 'Head office refused:', unreachable: 'Head office cannot be reached — nothing was read or saved.',
  },
  ta: {
    title: 'சலுகைக் கவுண்டர்கள்', lead: 'கடைக்குள் வேறொருவர் நடத்தும் கவுண்டர்கள்: அவர்களின் ஒப்பந்தம், வைப்புத் தொகை, வாடகை அல்லது வருவாய்ப் பங்கு, தீர்வு, மற்றும் கவுண்டரின் விற்பனையை நிறுத்தும் தேதிகள். அவர்களுக்காகக் கவுண்டர்கள் பெறும் பணம் அவர்களுடையது — கடையின் விற்பனை அல்ல.',
    off: 'இந்தக் கடைக்கு சலுகைக் கவுண்டர்கள் அணைக்கப்பட்டுள்ளன (உரிமையாளரின் 23 அக் 2026 முடிவு: SRE இன்று எதையும் நடத்தவில்லை). ஒரு கவுண்டர் ஒப்பந்தமானதும் உரிமையாளர் அமைப்பில் இயக்குவார்.',
    countersH: 'கவுண்டர்கள்', countersNone: 'எந்தச் சலுகைக் கவுண்டரும் பதிவில் இல்லை.', mayTrade: 'விற்கலாம்', cannotTrade: 'புதிய விற்பனை செய்ய முடியாது', blocked_inactive: 'அணைக்கப்பட்டது', blocked_not_approved: 'அனுமதிக்கப்படவில்லை', blocked_contract_not_started: 'தொடங்கவில்லை', blocked_contract_expired: 'ஒப்பந்தம் முடிந்தது', blocked_insurance_lapsed: 'காப்பீடு காலாவதி அல்லது இல்லை', blocked_licence_lapsed: 'உரிமம் காலாவதி',
    depositHeld: 'வைப்புத் தொகை (அவர்களுக்குத் திருப்பித் தர வேண்டியது)', level_within_30_days: '30 நாட்களுக்குள்', level_within_7_days: '7 நாட்களுக்குள்', level_lapsed: 'காலாவதி', doc_agreement: 'ஒப்பந்தம்', doc_insurance: 'காப்பீடு', doc_licence: 'உரிமம்', notOnRecord: 'பதிவில் இல்லை',
    raise: 'இப்போதே உரிமையாளருக்குத் தெரிவி', raised: 'எச்சரிக்கை(கள்) உரிமையாளருக்கு அனுப்பப்பட்டது; ஏற்கனவே திறந்தவை:',
    contractH: 'ஒப்பந்தம் பதிவு செய்', contractId: 'ஒப்பந்த எண் (புதியதற்குக் காலியாக)', concessionaire: 'சலுகையாளர் எண்', name: 'கவுண்டர் பெயர்', branch: 'கிளை', startsOn: 'தொடக்கம்', endsOn: 'முடிவு', basis: 'கட்டணம்', basis_fixed_rent: 'நிலையான வாடகை', basis_revenue_share: 'வருவாய்ப் பங்கு', basis_higher_of_both: 'வாடகை அல்லது பங்கில் அதிகம்', rent: 'மாத வாடகை (₹)', share: 'வருவாய்ப் பங்கு (%)', utilities: 'மாதப் பயன்பாட்டுக் கட்டணம் (₹)', deposit: 'வைப்புத் தொகை (₹)', insurance: 'காப்பீடு செல்லுபடி வரை', licence: 'உரிமம் செல்லுபடி வரை',
    save: 'சேமி (இன்னும் அனுமதிக்கப்படவில்லை)', askApproval: 'அனுமதி கேள்', putInForce: 'நடைமுறைப்படுத்து', askedFor: 'அனுமதி கேட்கப்பட்டது', approvedBy: 'அனுமதித்தவர்', rejectedBy: 'நிராகரித்தவர்',
    depositH: 'வைப்புத் தொகை', movement: 'நகர்வு', received: 'பெறப்பட்டது', refunded: 'திருப்பித் தரப்பட்டது', forfeited: 'பறிமுதல் (இரண்டாம் நபர் தேவை)', amount: 'தொகை (₹)', recordDeposit: 'பதிவு செய்', askForfeit: 'பறிமுதலுக்கு அனுமதி கேள்',
    chargeH: 'கட்டணமும் தீர்வும்', contractPick: 'ஒப்பந்தம்', from: 'இருந்து', to: 'வரை', banked: 'அவர்களுக்காகக் கவுண்டர்கள் வங்கியில் செலுத்தியது (₹)', metered: 'அளவிடப்பட்ட பயன்பாடு (₹, விருப்பம்)', readCharge: 'கட்டணத்தைக் கணக்கிடு', readSettlement: 'காலத்தைத் தீர்',
    gross: 'அவர்களின் விற்பனை', charge: 'எங்கள் கட்டணம்', totalDue: 'எங்களுக்கு வர வேண்டியது', collected: 'அவர்களுக்காக வைத்திருப்பது', payable: 'அவர்களுக்குச் செலுத்த வேண்டியது', difference: 'வேறுபாடு', reconciles: 'பொருந்துகிறது', doesNot: 'பொருந்தவில்லை',
    saved: 'சேமிக்கப்பட்டது.', nobody: 'இந்தத் திரையில் யாரும் உள்நுழையவில்லை — எதையும் படிக்க முடியாது.', cannotRead: 'உங்கள் பங்கு சலுகைக் கவுண்டர்களைத் திறக்க முடியாது.',
    needContract: 'சலுகையாளர், கவுண்டர் பெயர், கிளை, இரு தேதிகள், கட்டணம், வைப்புத் தொகையை நிரப்பவும்.', needMoney: 'தொகையை ரூபாயில் எழுதவும், உதா. 5000 அல்லது 5000.50.', needWindow: 'காலத்தின் இரு தேதிகளையும் தரவும்.', needPick: 'முதலில் ஒரு ஒப்பந்தத்தைத் தேர்ந்தெடுக்கவும்.',
    refused: 'தலைமை அலுவலகம் மறுத்தது:', unreachable: 'தலைமை அலுவலகத்தை அடைய முடியவில்லை — எதுவும் படிக்கவோ சேமிக்கவோ இல்லை.',
  },
} as const;

export const concessionWords = (lang: Lang, key: string): string =>
  (CONCESSION_COPY[lang] as Record<string, string>)[key] ?? (CONCESSION_COPY.en as Record<string, string>)[key] ?? key;

export function concessionOutcomeWords(lang: Lang, out: Outcome<unknown>): string {
  const w = (k: string) => concessionWords(lang, k);
  if (out.result === 'refused') return out.code === 'feature_not_entitled' ? w('off') : `${w('refused')} ${out.whatHappened}`;
  if (out.result === 'invalid') return w(out.why);
  if (out.result === 'lost_link') return w('unreachable');
  return w('saved');
}

/** "5,000.50" → paise; '' → undefined when optional; null when not readable. */
export function paiseOf(raw: string): number | null {
  const v = raw.replace(/[₹,\s]/g, '');
  if (!/^\d{1,9}(\.\d{1,2})?$/.test(v)) return null;
  const [whole, frac = ''] = v.split('.');
  return Number(whole) * 100 + Number(frac.padEnd(2, '0'));
}
export const rupees = (minor: number): string => `${minor < 0 ? '-' : ''}₹${(Math.abs(minor) / 100).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

const DATE = /^\d{4}-\d{2}-\d{2}$/;
const BASES = ['fixed_rent', 'revenue_share', 'higher_of_both'] as const;

export interface ContractForm {
  readonly contractId: string; readonly concessionaireId: string; readonly name: string; readonly branchId: string;
  readonly startsOn: string; readonly endsOn: string; readonly basis: string;
  readonly rentRupees: string; readonly sharePercent: string; readonly utilitiesRupees: string; readonly depositRupees: string;
  readonly insuranceUntil: string; readonly licenceUntil: string;
}
export interface AskedRequest { readonly requestId: string; readonly kind: string; readonly status: string; readonly subjectRef: string; readonly details: Record<string, unknown>; readonly decidedBy?: string; readonly decisionReason?: string }
export type Invalid = 'nobody' | 'needContract' | 'needMoney' | 'needWindow' | 'needPick';

/** The exact contract body head office takes (and the approval is asked for), or why the form is not readable. */
export function concessionContractOf(f: ContractForm, makeId: () => string = () => newId('CC')): { readonly contractId: string; readonly body: Record<string, unknown> } | Invalid {
  if (f.concessionaireId.trim() === '' || f.name.trim() === '' || f.branchId.trim() === '' || !DATE.test(f.startsOn) || !DATE.test(f.endsOn) || f.endsOn < f.startsOn
    || !(BASES as readonly string[]).includes(f.basis)) return 'needContract';
  const deposit = paiseOf(f.depositRupees);
  if (deposit === null) return 'needContract';
  const opt = (raw: string): number | undefined | null => (raw.trim() === '' ? undefined : paiseOf(raw));
  const rent = opt(f.rentRupees); const utilities = opt(f.utilitiesRupees);
  const share = f.sharePercent.trim() === '' ? undefined : (/^\d{1,2}(\.\d{1,2})?$/.test(f.sharePercent.trim()) ? Math.round(Number(f.sharePercent.trim()) * 100) : null);
  if (rent === null || utilities === null || share === null) return 'needMoney';
  if ((f.basis !== 'revenue_share' && rent === undefined) || (f.basis !== 'fixed_rent' && share === undefined)) return 'needContract';
  if ((f.insuranceUntil !== '' && !DATE.test(f.insuranceUntil)) || (f.licenceUntil !== '' && !DATE.test(f.licenceUntil))) return 'needContract';
  return {
    contractId: f.contractId.trim() === '' ? makeId() : f.contractId.trim(),
    body: {
      concessionaireId: f.concessionaireId.trim(), name: f.name.trim(), branchId: f.branchId.trim(), startsOn: f.startsOn, endsOn: f.endsOn, basis: f.basis, depositMinor: deposit,
      ...(rent === undefined ? {} : { fixedRentMinor: rent }), ...(share === undefined ? {} : { revenueShareBps: share }), ...(utilities === undefined ? {} : { utilitiesMinor: utilities }),
      ...(f.insuranceUntil === '' ? {} : { insuranceUntil: f.insuranceUntil }), ...(f.licenceUntil === '' ? {} : { licenceUntil: f.licenceUntil }),
    },
  };
}

export interface ConcessionSession {
  readonly may: { readonly named: boolean; readonly read: boolean; readonly manage: boolean };
  readCounters(): Promise<Outcome<{ readonly contracts: readonly Record<string, unknown>[]; readonly alerts: readonly Record<string, unknown>[] }>>;
  readMyRequests(): Promise<Outcome<readonly AskedRequest[]>>;
  saveContract(f: ContractForm): Promise<Outcome<{ readonly contractId: string }, Invalid>>;
  askContractApproval(f: ContractForm): Promise<Outcome<unknown, Invalid>>;
  putInForce(request: AskedRequest): Promise<Outcome<unknown, Invalid>>;
  recordDeposit(concessionaireId: string, kind: 'received' | 'refunded', rupeesAmount: string): Promise<Outcome<unknown, Invalid>>;
  askForfeit(concessionaireId: string, rupeesAmount: string): Promise<Outcome<unknown, Invalid>>;
  forfeitWithApproval(request: AskedRequest): Promise<Outcome<unknown, Invalid>>;
  readCharge(contractId: string, from: string, to: string, meteredRupees: string): Promise<Outcome<Record<string, unknown>, Invalid>>;
  readSettlement(contractId: string, from: string, to: string, bankedRupees: string): Promise<Outcome<Record<string, unknown>, Invalid>>;
  raiseAlerts(): Promise<Outcome<{ readonly alerts: number; readonly raised: number; readonly alreadyOpen: number }, Invalid>>;
}

export function createConcessionSession(input: { readonly viewer: { readonly userId?: string; readonly permissions: readonly string[] } | undefined; readonly fetch?: typeof globalThis.fetch; readonly newKey?: () => string; readonly makeId?: (prefix: string) => string }): ConcessionSession {
  const named = input.viewer?.userId !== undefined;
  const held = new Set(input.viewer?.permissions ?? []);
  const may = { named, read: named && held.has('concession.charge.read'), manage: named && held.has('concession.contract.manage') };
  const call = makeCaller({ keyPrefix: 'concessions', ...(input.fetch === undefined ? {} : { fetch: input.fetch }), ...(input.newKey === undefined ? {} : { newKey: input.newKey }) });
  const id = input.makeId ?? newId;
  const enc = encodeURIComponent;
  const contractOf = (f: ContractForm) => concessionContractOf(f, () => id('CC'));
  return {
    may,
    readCounters: () => call('GET', '/v1/concession/contracts'),
    readMyRequests: async () => {
      const r = await call<{ mine?: AskedRequest[] }>('GET', '/v1/approvals/requests');
      if (r.result !== 'ok') return r;
      return { result: 'ok', value: (r.value.mine ?? []).filter((q) => q.kind === 'concession_contract' || q.kind === 'concession_deposit_forfeit') };
    },
    saveContract: async (f) => {
      if (!named) return { result: 'invalid', why: 'nobody' };
      const c = contractOf(f);
      if (typeof c === 'string') return { result: 'invalid', why: c };
      const r = await call('POST', `/v1/concession/contracts/${enc(c.contractId)}`, c.body);
      return r.result === 'ok' ? { result: 'ok', value: { contractId: c.contractId } } : r;
    },
    askContractApproval: async (f) => {
      if (!named) return { result: 'invalid', why: 'nobody' };
      const c = contractOf(f);
      if (typeof c === 'string') return { result: 'invalid', why: c };
      return call('POST', '/v1/approvals/requests', {
        kind: 'concession_contract', subjectRef: c.contractId, details: { ...c.body, contractId: c.contractId }, valueMinor: null,
        summary: `Concession contract ${c.contractId} — ${String(c.body['name'])}, ${String(c.body['startsOn'])} to ${String(c.body['endsOn'])}`, reason: 'new or renewed concession terms',
      });
    },
    putInForce: async (request) => {
      if (!named) return { result: 'invalid', why: 'nobody' };
      const { contractId, ...body } = request.details as Record<string, unknown> & { contractId: string };
      return call('POST', `/v1/concession/contracts/${enc(contractId)}`, { ...body, approvalId: request.requestId });
    },
    recordDeposit: async (concessionaireId, kind, amount) => {
      if (!named) return { result: 'invalid', why: 'nobody' };
      const paise = paiseOf(amount);
      if (concessionaireId.trim() === '' || paise === null || paise === 0) return { result: 'invalid', why: 'needMoney' };
      return call('POST', `/v1/concession/concessionaires/${enc(concessionaireId.trim())}/deposit-movements/${enc(id('DEP'))}`, { kind, amountMinor: paise });
    },
    askForfeit: async (concessionaireId, amount) => {
      if (!named) return { result: 'invalid', why: 'nobody' };
      const paise = paiseOf(amount);
      if (concessionaireId.trim() === '' || paise === null || paise === 0) return { result: 'invalid', why: 'needMoney' };
      const movementId = id('DEP');
      return call('POST', '/v1/approvals/requests', {
        kind: 'concession_deposit_forfeit', subjectRef: `${concessionaireId.trim()}/${movementId}`, valueMinor: paise,
        details: { kind: 'forfeited', amountMinor: paise, concessionaireId: concessionaireId.trim(), movementId },
        summary: `Forfeit ${rupees(paise)} of ${concessionaireId.trim()}'s deposit`, reason: 'deposit forfeit',
      });
    },
    forfeitWithApproval: async (request) => {
      if (!named) return { result: 'invalid', why: 'nobody' };
      const d = request.details as { kind: string; amountMinor: number; concessionaireId: string; movementId: string };
      return call('POST', `/v1/concession/concessionaires/${enc(d.concessionaireId)}/deposit-movements/${enc(d.movementId)}`, { kind: d.kind, amountMinor: d.amountMinor, approvalId: request.requestId });
    },
    readCharge: async (contractId, from, to, metered) => {
      if (contractId === '') return { result: 'invalid', why: 'needPick' };
      if (!DATE.test(from) || !DATE.test(to)) return { result: 'invalid', why: 'needWindow' };
      const m = metered.trim() === '' ? undefined : paiseOf(metered);
      if (m === null) return { result: 'invalid', why: 'needMoney' };
      return call('GET', `/v1/concession/contracts/${enc(contractId)}/charge?from=${from}&to=${to}${m === undefined ? '' : `&meteredUtilitiesMinor=${m}`}`);
    },
    readSettlement: async (contractId, from, to, banked) => {
      if (contractId === '') return { result: 'invalid', why: 'needPick' };
      if (!DATE.test(from) || !DATE.test(to)) return { result: 'invalid', why: 'needWindow' };
      const b = paiseOf(banked);
      if (b === null) return { result: 'invalid', why: 'needMoney' };
      return call('GET', `/v1/concession/contracts/${enc(contractId)}/settlement?from=${from}&to=${to}&bankedForThemMinor=${b}`);
    },
    raiseAlerts: async () => (named ? call('POST', '/v1/concession/expiry-alerts/raise', {}) : { result: 'invalid', why: 'nobody' }),
  };
}
