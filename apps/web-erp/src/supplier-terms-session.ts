// Supplier terms (M06-FR-03 "contracts, schemes, rebates, lead times and supplier scorecards" · §28 · ADR-0024 · P-05). A
// tested, DOM-free THIN client that lets the person who keeps the supplier terms (`purchase.contract.manage`) put them on
// head office's record from a screen, with a DIFFERENT person's approval given in that person's own session:
//   • a SUPPLIER CONTRACT — its term and the AGREED LEAD TIME the scorecard measures on-time-in-full against
//     (`POST /v1/purchase/contracts/:contractId`, kind `purchase_contract`), on the Supplier scorecard page, with the contract
//     review (expiring / expired / unapproved, worst first — `GET /v1/purchase/contracts/alerts`);
//   • a REBATE SCHEME — supplier, basis, rate, threshold and term (`POST /v1/purchase/rebate-schemes/:schemeId`, kind
//     `rebate_scheme`), on the Supplier rebates page.
// The flow is the engine's own: ASK (exactly the terms that will be sent — supplier, dates, figures — fingerprinted by head
// office) → a different person with `purchase.supplier.approve` approves on the Approvals page → RECORD, naming that approval
// (found among the asker's own approved requests, never typed). Recording before anyone approved is allowed by head office
// and said plainly: the terms are kept, and they show as NOT APPROVED until approved terms are recorded. A typed "approved
// by" never leaves this screen. Nothing is read on open.

import { makeCaller, outcomeIn, type Outcome } from './r4-insight-call';
import { paiseOf } from './blanket-orders-session';

export type Lang = 'en' | 'ta';

export const SUPPLIER_TERMS_COPY = {
  en: {
    contractH: 'Record a supplier contract', contractLead: 'The agreed term and lead time. The lead time is what "on time" is measured against on the scorecard. A different person approves the terms on the Approvals page.',
    contractId: 'Contract code', supplier: 'Supplier code', startsOn: 'Starts on', endsOn: 'Ends on', leadDays: 'Agreed lead time (days)',
    schemeH: 'Record a rebate scheme', schemeLead: 'What the supplier pays back, and on what. A different person (Finance) approves the scheme on the Approvals page before claims are sent.',
    schemeId: 'Scheme code', basis: 'Earned on', b_purchase_value: 'Value of matched bills', b_volume_units: 'Value received (volume)', b_growth_over_baseline: 'Growth over an earlier period',
    ratePct: 'Rate (%)', thresholdRs: 'Only above (₹, optional)',
    ask: 'Ask for approval', record: 'Record it', askedNow: 'Asked. A different person who approves suppliers approves exactly these terms on the Approvals page; then press "Record it".',
    recordedApproved: 'Recorded with its approval — head office kept the terms and who approved them.',
    recordedUnapproved: 'Recorded WITHOUT an approval — head office kept the terms, and they show as not approved until approved terms are recorded.',
    contractsH: 'Contracts to look at', contractsShow: 'Show the contracts', noContracts: 'No supplier contract is recorded yet.',
    f_active: 'In force', f_expiring_soon: 'Ending soon', f_expired: 'Ended — orders since are on no agreed terms', f_unapproved: 'Not approved — no second person signed the terms',
    daysLeft: 'days left',
    needContract: 'Fill in the contract code, the supplier, both dates (YYYY-MM-DD, the end on or after the start) and the lead time in whole days.',
    needScheme: 'Fill in the scheme code, the supplier, what it is earned on, the rate (up to 2 decimals), both dates (the end on or after the start); the threshold is rupees or blank.',
    nobody: 'Nobody is signed in on this screen.', cannotManage: 'Your role cannot record supplier terms.', cannotRead: 'Your role cannot read supplier contracts.',
    refused: 'Head office refused:', unreachable: 'Head office cannot be reached — nothing was read or saved.',
  },
  ta: {
    contractH: 'விநியோகஸ்தர் ஒப்பந்தத்தைப் பதிவு செய்', contractLead: 'ஒப்புக்கொண்ட காலமும் வழங்கும் நாட்களும். மதிப்பெண் அட்டையில் "நேரத்தில்" என்பது இந்த நாட்களுக்கு எதிராக அளக்கப்படும். நிபந்தனைகளை வேறொருவர் அனுமதிகள் பக்கத்தில் அனுமதிப்பார்.',
    contractId: 'ஒப்பந்தக் குறியீடு', supplier: 'விநியோகஸ்தர் குறியீடு', startsOn: 'தொடங்கும் நாள்', endsOn: 'முடியும் நாள்', leadDays: 'ஒப்புக்கொண்ட வழங்கும் காலம் (நாட்கள்)',
    schemeH: 'தள்ளுபடித் திட்டத்தைப் பதிவு செய்', schemeLead: 'விநியோகஸ்தர் எதன் மீது எவ்வளவு திருப்பித் தருகிறார். கோரிக்கைகள் அனுப்பப்படும் முன் வேறொருவர் (நிதித்துறை) அனுமதிகள் பக்கத்தில் திட்டத்தை அனுமதிப்பார்.',
    schemeId: 'திட்டக் குறியீடு', basis: 'எதன் மீது ஈட்டப்படுகிறது', b_purchase_value: 'பொருந்திய பில்களின் மதிப்பு', b_volume_units: 'பெற்ற மதிப்பு (அளவு)', b_growth_over_baseline: 'முந்தைய காலத்தை விட வளர்ச்சி',
    ratePct: 'விகிதம் (%)', thresholdRs: 'இதற்கு மேல் மட்டும் (₹, விருப்பம்)',
    ask: 'அனுமதி கேள்', record: 'பதிவு செய்', askedNow: 'கேட்கப்பட்டது. விநியோகஸ்தர்களை அனுமதிக்கும் வேறொருவர் இதே நிபந்தனைகளை அனுமதிகள் பக்கத்தில் அனுமதிப்பார்; பின்னர் "பதிவு செய்" அழுத்துங்கள்.',
    recordedApproved: 'அனுமதியுடன் பதிவானது — நிபந்தனைகளையும் அனுமதித்தவரையும் தலைமை அலுவலகம் வைத்தது.',
    recordedUnapproved: 'அனுமதி இல்லாமல் பதிவானது — நிபந்தனைகளைத் தலைமை அலுவலகம் வைத்தது; அனுமதித்த நிபந்தனைகள் பதிவாகும் வரை அவை அனுமதிக்கப்படாதவையாகக் காட்டப்படும்.',
    contractsH: 'கவனிக்க வேண்டிய ஒப்பந்தங்கள்', contractsShow: 'ஒப்பந்தங்களைக் காட்டு', noContracts: 'இன்னும் எந்த விநியோகஸ்தர் ஒப்பந்தமும் பதிவாகவில்லை.',
    f_active: 'நடைமுறையில்', f_expiring_soon: 'விரைவில் முடிகிறது', f_expired: 'முடிந்தது — அதன் பின் வந்த ஆணைகள் ஒப்புக்கொண்ட நிபந்தனைகள் இல்லாதவை', f_unapproved: 'அனுமதிக்கப்படவில்லை — நிபந்தனைகளில் இரண்டாமவர் கையெழுத்து இல்லை',
    daysLeft: 'நாட்கள் உள்ளன',
    needContract: 'ஒப்பந்தக் குறியீடு, விநியோகஸ்தர், இரு நாட்களும் (YYYY-MM-DD, முடிவு தொடக்கத்துக்குப் பின் அல்லது அதே நாள்), வழங்கும் காலம் முழு நாட்களில் — நிரப்புங்கள்.',
    needScheme: 'திட்டக் குறியீடு, விநியோகஸ்தர், எதன் மீது, விகிதம் (2 தசம இடங்கள் வரை), இரு நாட்களும் (முடிவு தொடக்கத்துக்குப் பின் அல்லது அதே நாள்) — நிரப்புங்கள்; வரம்பு ரூபாய் அல்லது வெறுமை.',
    nobody: 'இந்தத் திரையில் யாரும் உள்நுழையவில்லை.', cannotManage: 'உங்கள் பணி விநியோகஸ்தர் நிபந்தனைகளைப் பதிவு செய்ய முடியாது.', cannotRead: 'உங்கள் பணி விநியோகஸ்தர் ஒப்பந்தங்களைப் படிக்க முடியாது.',
    refused: 'தலைமை அலுவலகம் மறுத்தது:', unreachable: 'தலைமை அலுவலகத்தை அடைய முடியவில்லை — எதுவும் படிக்கவோ சேமிக்கவோ இல்லை.',
  },
} as const;

export const supplierTermsWords = (lang: Lang, key: string): string =>
  (SUPPLIER_TERMS_COPY[lang] as Record<string, string>)[key] ?? (SUPPLIER_TERMS_COPY.en as Record<string, string>)[key] ?? key;

export interface ContractForm { readonly contractId: string; readonly supplierId: string; readonly startsOn: string; readonly endsOn: string; readonly leadDays: string }
export interface SchemeForm { readonly schemeId: string; readonly supplierId: string; readonly basis: string; readonly ratePct: string; readonly thresholdRupees: string; readonly startsOn: string; readonly endsOn: string }
export interface ContractAlert { readonly contractId: string; readonly supplierId: string; readonly daysRemaining: number; readonly finding: 'active' | 'expiring_soon' | 'expired' | 'unapproved'; readonly detail: string }

type Why = 'nobody' | 'cannotManage' | 'cannotRead' | 'needContract' | 'needScheme';
type Done<T = Record<string, unknown>> = Promise<Outcome<T, Why>>;
const DAY = /^\d{4}-\d{2}-\d{2}$/;
const ID = /^[A-Za-z0-9_-]{1,60}$/;
const seg = (s: string): string => encodeURIComponent(s);
const BASES = ['purchase_value', 'volume_units', 'growth_over_baseline'] as const;

/** A percentage typed with up to two decimals ("3", "2.5", "1.25") → basis points; null when it is not one. */
export function basisPointsOf(typed: string): number | null {
  const v = typed.trim().replace(/%$/, '').trim();
  if (!/^\d+(\.\d{1,2})?$/.test(v)) return null;
  const [whole, frac = ''] = v.split('.');
  return Number(whole) * 100 + Number(frac.padEnd(2, '0'));
}

/** The contract body head office reads (the same body is asked for and recorded), or null when the form is not complete. */
export function contractBody(f: ContractForm): { readonly contractId: string; readonly body: Record<string, unknown> } | null {
  const id = f.contractId.trim(); const supplierId = f.supplierId.trim(); const s = f.startsOn.trim(); const e = f.endsOn.trim(); const lead = f.leadDays.trim();
  if (!ID.test(id) || supplierId === '' || !DAY.test(s) || !DAY.test(e) || e < s || !/^\d{1,4}$/.test(lead)) return null;
  return { contractId: id, body: { supplierId, startsOn: s, endsOn: e, agreedLeadTimeDays: Number(lead) } };
}

/** The scheme body head office reads, or null when the form is not complete. */
export function schemeBody(f: SchemeForm): { readonly schemeId: string; readonly body: Record<string, unknown> } | null {
  const id = f.schemeId.trim(); const supplierId = f.supplierId.trim(); const s = f.startsOn.trim(); const e = f.endsOn.trim();
  const rateBp = basisPointsOf(f.ratePct);
  const threshold = f.thresholdRupees.trim() === '' ? undefined : paiseOf(f.thresholdRupees);
  if (!ID.test(id) || supplierId === '' || !(BASES as readonly string[]).includes(f.basis) || rateBp === null || threshold === null || !DAY.test(s) || !DAY.test(e) || e < s) return null;
  return { schemeId: id, body: { supplierId, basis: f.basis, rateBp, ...(threshold === undefined ? {} : { thresholdMinor: threshold }), startsOn: s, endsOn: e } };
}

export const supplierTermsOutcomeWords = (lang: Lang, out: Outcome<unknown>): string => {
  if (out.result !== 'ok') return outcomeIn((k) => supplierTermsWords(lang, k), out);
  const v = (out.value ?? {}) as Record<string, unknown>;
  if (typeof v['requestId'] === 'string') return supplierTermsWords(lang, 'askedNow');
  return supplierTermsWords(lang, v['approved'] === true ? 'recordedApproved' : 'recordedUnapproved');
};

export interface SupplierTermsSession {
  readonly may: { readonly named: boolean; readonly read: boolean; readonly manage: boolean };
  contracts(): Done<{ readonly alerts: readonly ContractAlert[]; readonly actionNeededCount: number; readonly onDate: string }>;
  askContract(f: ContractForm): Done<{ readonly requestId: string }>;
  recordContract(f: ContractForm): Done<{ readonly approved: boolean; readonly contract: Record<string, unknown> }>;
  askScheme(f: SchemeForm): Done<{ readonly requestId: string }>;
  recordScheme(f: SchemeForm): Done<{ readonly approved: boolean; readonly scheme: Record<string, unknown> }>;
}

export function createSupplierTermsSession(input: {
  readonly viewer: { readonly userId?: string; readonly permissions: readonly string[] } | undefined;
  readonly fetch?: typeof globalThis.fetch; readonly newKey?: () => string;
}): SupplierTermsSession {
  const named = input.viewer?.userId !== undefined;
  const held = new Set(input.viewer?.permissions ?? []);
  const may = { named, read: named && held.has('purchase.commitment.read'), manage: named && held.has('purchase.contract.manage') };
  const call = makeCaller({ keyPrefix: 'supplier-terms', ...(input.fetch === undefined ? {} : { fetch: input.fetch }), ...(input.newKey === undefined ? {} : { newKey: input.newKey }) });
  const gate = (need: 'read' | 'manage'): { result: 'invalid'; why: Why } | undefined =>
    !named ? { result: 'invalid', why: 'nobody' } : !may[need] ? { result: 'invalid', why: need === 'read' ? 'cannotRead' : 'cannotManage' } : undefined;

  // The engine fingerprints the action's details: the body as it will be sent, plus the route's path id (`actionDetails`).
  const ask = (kind: string, subjectRef: string, details: Record<string, unknown>, summary: string) =>
    call<{ requestId: string }>('POST', '/v1/approvals/requests', { kind, subjectRef, details, valueMinor: null, summary, reason: summary });
  // The asker's own approved request for exactly this subject — found, never typed. The newest one wins.
  const approvalFor = async (kind: string, subjectRef: string): Promise<Outcome<string | null, never>> => {
    const mine = await call<{ mine?: readonly { requestId: string; kind: string; subjectRef: string; status: string; requestedAt?: string }[] }>('GET', '/v1/approvals/requests');
    if (mine.result !== 'ok') return mine;
    const found = (mine.value.mine ?? []).filter((q) => q.kind === kind && q.subjectRef === subjectRef && q.status === 'approved');
    return { result: 'ok', value: found.length === 0 ? null : found[found.length - 1]!.requestId };
  };
  const record = async <K extends string>(kind: string, subjectRef: string, path: string, body: Record<string, unknown>, key: K): Done<{ approved: boolean } & Record<K, Record<string, unknown>>> => {
    const approval = await approvalFor(kind, subjectRef);
    if (approval.result !== 'ok') return approval;
    const out = await call<Record<K, Record<string, unknown>>>('POST', path, approval.value === null ? body : { ...body, approvalId: approval.value });
    if (out.result !== 'ok') return out;
    const kept = out.value[key] ?? {};
    return { result: 'ok', value: { ...out.value, approved: typeof kept['approvedBy'] === 'string' } as { approved: boolean } & Record<K, Record<string, unknown>> };
  };
  return {
    may,
    contracts: async () => gate('read') ?? call('GET', '/v1/purchase/contracts/alerts'),
    askContract: async (f) => {
      const no = gate('manage'); if (no !== undefined) return no;
      const made = contractBody(f); if (made === null) return { result: 'invalid', why: 'needContract' };
      return ask('purchase_contract', made.contractId, { ...made.body, contractId: made.contractId }, `Supplier contract ${made.contractId} with ${String(made.body['supplierId'])}: ${String(made.body['startsOn'])} to ${String(made.body['endsOn'])}, lead time ${String(made.body['agreedLeadTimeDays'])} days`);
    },
    recordContract: async (f) => {
      const no = gate('manage'); if (no !== undefined) return no;
      const made = contractBody(f); if (made === null) return { result: 'invalid', why: 'needContract' };
      return record('purchase_contract', made.contractId, `/v1/purchase/contracts/${seg(made.contractId)}`, made.body, 'contract');
    },
    askScheme: async (f) => {
      const no = gate('manage'); if (no !== undefined) return no;
      const made = schemeBody(f); if (made === null) return { result: 'invalid', why: 'needScheme' };
      return ask('rebate_scheme', made.schemeId, { ...made.body, schemeId: made.schemeId }, `Rebate scheme ${made.schemeId} with ${String(made.body['supplierId'])}: ${(Number(made.body['rateBp']) / 100).toFixed(2)}% on ${String(made.body['basis'])}, ${String(made.body['startsOn'])} to ${String(made.body['endsOn'])}`);
    },
    recordScheme: async (f) => {
      const no = gate('manage'); if (no !== undefined) return no;
      const made = schemeBody(f); if (made === null) return { result: 'invalid', why: 'needScheme' };
      return record('rebate_scheme', made.schemeId, `/v1/purchase/rebate-schemes/${seg(made.schemeId)}`, made.body, 'scheme');
    },
  };
}
