// The Supplier rebates page (M06-FR-03 "rebate-accrual reports" · D03-FR-03 "accrue rebate/funding claims" · §28 "Finance
// approves rebate claims" · OB-404 · QG-02). A tested, DOM-free session over head office's own rebate record
// (services/purchase/src/rebate-claims.ts, services/finance/src/rebate-receipts.ts):
//   • THE REGISTER — per scheme what it EARNED (the accruals folded from the matched bills), what was RECEIVED (finance's
//     journals), what is OUTSTANDING and what may still be CLAIMED; every claim with its state, its due day and whether it
//     is OVERDUE ("not set" while the owner has not set the answer period); money received that answers no claim;
//   • RAISE a claim (never more than may be claimed) → ASK Finance to approve exactly it → RECORD it SENT once a different
//     person approved it (the approval is found in the asker's own requests — never typed) → PRINT its document;
//   • RECORD money received (finance) and MATCH it to a sent claim; WITHDRAW a claim with a reason; the owner SETS the
//     answer period.
// Head office re-checks every permission and approval; `may` only shapes what is offered. Nothing is read on open.

import { makeCaller, outcomeIn, newId, type Outcome } from './r4-insight-call';
import { paiseOf, rupees } from './blanket-orders-session';

export { rupees };
export type Lang = 'en' | 'ta';

export const REBATES_COPY = {
  en: {
    title: 'Supplier rebates', lead: 'What each supplier\'s rebate scheme has earned, what was received, what is still owed — and the claims sent for it, with any that are overdue.',
    show: 'Show the rebates', registerH: 'Schemes and claims', none: 'No rebate scheme is recorded yet.', scheme: 'Scheme', supplier: 'Supplier', rate: 'Rate',
    earned: 'Earned', received: 'Received', outstanding: 'Outstanding', claimed: 'Asked for in open claims', claimable: 'May still be claimed', accrualsH: 'Earned by period', receiptsH: 'Money received',
    noAccruals: 'Nothing earned yet — post an accrual for a period on the supplier screen.', noReceipts: 'No money received yet.', matchedTo: 'matched to claims',
    claimsH: 'Claims', noClaims: 'No claim raised yet.', claim: 'Claim', amount: 'Amount', sentOn: 'Sent on', dueOn: 'Answer due', paid: 'Paid', left: 'Still owed',
    st_raised: 'Waiting for Finance to approve', st_sent: 'Sent — waiting for the supplier', st_partly_answered: 'Partly paid', st_answered: 'Paid in full', st_withdrawn: 'Withdrawn',
    overdue: 'OVERDUE — the supplier has not paid by the due day', dueNotSet: 'Due day not set — the owner has not set how many days a supplier has to answer',
    f_scheme_not_approved: 'The scheme is not approved by Finance', f_claims_exceed_outstanding: 'Open claims ask for more than is still owed — match the money received to them', f_earned_not_claimed: 'Money earned and not claimed yet',
    periodH: 'Days a supplier has to answer a claim', periodNotSet: 'Not set. No claim can show as overdue until the owner sets it.', periodIs: 'days after the claim is sent',
    days: 'Days', setPeriod: 'Set the days', clearPeriod: 'Clear', why: 'Why (to clear)',
    raiseH: 'Raise a claim', schemeId: 'Scheme code', amountRs: 'Amount to claim (₹)', note: 'Note (optional)', raise: 'Raise the claim',
    ask: 'Ask Finance to approve', send: 'Record as sent', sentDay: 'Sent on (YYYY-MM-DD)', withdraw: 'Withdraw', withdrawWhy: 'Why withdraw', print: 'Show the claim document', printNow: 'Print',
    docH: 'Claim document', docDraft: 'DRAFT — not approved by Finance. Do not send.', docTo: 'To supplier', docFrom: 'From', docNotOnRecord: 'not on record', docWords: 'Please pay',
    receiptH: 'Record money received', receivedOn: 'Received on (YYYY-MM-DD)', reference: 'Bank or cheque reference', forClaim: 'Answers claim (optional)', recordReceipt: 'Record the money',
    unmatchedH: 'Money received that answers no claim', match: 'Match to claim', matchClaim: 'Claim number',
    saved: 'Done — head office recorded it.', raisedNow: 'Claim raised. Next: ask Finance to approve it.', askedNow: 'Asked. A different person with Finance\'s authority approves it on the Approvals page.',
    sentNow: 'Recorded as sent. The supplier sees it on the supplier portal; print the document to post or hand it over.', already: 'Already recorded — nothing changed.',
    receiptMatched: 'Money recorded and matched to the claim.', receiptNotMatched: 'The money was recorded, but head office did not match it to the claim:',
    notApprovedYet: 'Finance has not approved this claim yet — ask, and wait for a different person to approve it.', needRaise: 'Fill in the scheme and an amount in rupees.', needSentOn: 'Write the day it was sent (YYYY-MM-DD).',
    needReason: 'Write why first.', needReceipt: 'Fill in the scheme, the amount, the day and the reference.', needDays: 'Write a whole number of days, more than 0.', needClaim: 'Write the claim number.',
    nobody: 'Nobody is signed in on this screen.', cannotRead: 'Your role cannot read the rebate register.', cannotClaim: 'Your role cannot raise or send rebate claims.', cannotReceipt: 'Your role cannot record rebate money.', cannotSetPeriod: 'Only the owner sets the answer days.',
    refused: 'Head office refused:', unreachable: 'Head office cannot be reached — nothing was read or saved.',
  },
  ta: {
    title: 'விநியோகஸ்தர் தள்ளுபடிகள்', lead: 'ஒவ்வொரு விநியோகஸ்தரின் தள்ளுபடித் திட்டமும் ஈட்டியது, பெறப்பட்டது, இன்னும் வர வேண்டியது — அதற்கு அனுப்பிய கோரிக்கைகள், தாமதமானவை உட்பட.',
    show: 'தள்ளுபடிகளைக் காட்டு', registerH: 'திட்டங்களும் கோரிக்கைகளும்', none: 'இன்னும் எந்தத் தள்ளுபடித் திட்டமும் பதிவாகவில்லை.', scheme: 'திட்டம்', supplier: 'விநியோகஸ்தர்', rate: 'விகிதம்',
    earned: 'ஈட்டியது', received: 'பெறப்பட்டது', outstanding: 'நிலுவை', claimed: 'திறந்த கோரிக்கைகளில் கேட்டது', claimable: 'இன்னும் கோரலாம்', accrualsH: 'காலவாரியாக ஈட்டியது', receiptsH: 'பெற்ற பணம்',
    noAccruals: 'இன்னும் எதுவும் ஈட்டவில்லை — விநியோகஸ்தர் திரையில் ஒரு காலத்துக்குக் கணக்கிடுங்கள்.', noReceipts: 'இன்னும் பணம் வரவில்லை.', matchedTo: 'கோரிக்கைகளுடன் பொருத்தியது',
    claimsH: 'கோரிக்கைகள்', noClaims: 'இன்னும் கோரிக்கை எழுப்பவில்லை.', claim: 'கோரிக்கை', amount: 'தொகை', sentOn: 'அனுப்பிய நாள்', dueOn: 'பதில் வர வேண்டிய நாள்', paid: 'செலுத்தியது', left: 'இன்னும் வர வேண்டியது',
    st_raised: 'நிதித்துறை அனுமதிக்காகக் காத்திருக்கிறது', st_sent: 'அனுப்பப்பட்டது — விநியோகஸ்தருக்காகக் காத்திருக்கிறது', st_partly_answered: 'பகுதி செலுத்தப்பட்டது', st_answered: 'முழுமையாகச் செலுத்தப்பட்டது', st_withdrawn: 'திரும்பப் பெறப்பட்டது',
    overdue: 'தாமதம் — உரிய நாளுக்குள் விநியோகஸ்தர் செலுத்தவில்லை', dueNotSet: 'உரிய நாள் அமைக்கப்படவில்லை — விநியோகஸ்தர் பதிலளிக்க எத்தனை நாள் என்பதை உரிமையாளர் அமைக்கவில்லை',
    f_scheme_not_approved: 'திட்டத்தை நிதித்துறை அனுமதிக்கவில்லை', f_claims_exceed_outstanding: 'திறந்த கோரிக்கைகள் நிலுவையை விட அதிகம் கேட்கின்றன — பெற்ற பணத்தை அவற்றுடன் பொருத்துங்கள்', f_earned_not_claimed: 'ஈட்டிய பணம் இன்னும் கோரப்படவில்லை',
    periodH: 'கோரிக்கைக்கு விநியோகஸ்தர் பதிலளிக்க வேண்டிய நாட்கள்', periodNotSet: 'அமைக்கப்படவில்லை. உரிமையாளர் அமைக்கும் வரை எந்தக் கோரிக்கையும் தாமதமாகக் காட்டப்படாது.', periodIs: 'நாட்கள், கோரிக்கை அனுப்பிய பின்',
    days: 'நாட்கள்', setPeriod: 'நாட்களை அமை', clearPeriod: 'நீக்கு', why: 'ஏன் (நீக்க)',
    raiseH: 'கோரிக்கை எழுப்பு', schemeId: 'திட்டக் குறியீடு', amountRs: 'கோர வேண்டிய தொகை (₹)', note: 'குறிப்பு (விருப்பம்)', raise: 'கோரிக்கையை எழுப்பு',
    ask: 'நிதித்துறை அனுமதி கேள்', send: 'அனுப்பியதாகப் பதிவு செய்', sentDay: 'அனுப்பிய நாள் (YYYY-MM-DD)', withdraw: 'திரும்பப் பெறு', withdrawWhy: 'ஏன் திரும்பப் பெறுகிறீர்கள்', print: 'கோரிக்கை ஆவணத்தைக் காட்டு', printNow: 'அச்சிடு',
    docH: 'கோரிக்கை ஆவணம்', docDraft: 'வரைவு — நிதித்துறை அனுமதிக்கவில்லை. அனுப்ப வேண்டாம்.', docTo: 'விநியோகஸ்தருக்கு', docFrom: 'அனுப்புநர்', docNotOnRecord: 'பதிவில் இல்லை', docWords: 'தயவுசெய்து செலுத்துங்கள்',
    receiptH: 'பெற்ற பணத்தைப் பதிவு செய்', receivedOn: 'பெற்ற நாள் (YYYY-MM-DD)', reference: 'வங்கி அல்லது காசோலைக் குறிப்பு', forClaim: 'இந்தக் கோரிக்கைக்கான பதில் (விருப்பம்)', recordReceipt: 'பணத்தைப் பதிவு செய்',
    unmatchedH: 'எந்தக் கோரிக்கைக்கும் பொருந்தாத பெற்ற பணம்', match: 'கோரிக்கையுடன் பொருத்து', matchClaim: 'கோரிக்கை எண்',
    saved: 'முடிந்தது — தலைமை அலுவலகம் பதிவு செய்தது.', raisedNow: 'கோரிக்கை எழுப்பப்பட்டது. அடுத்து: நிதித்துறையிடம் அனுமதி கேளுங்கள்.', askedNow: 'கேட்கப்பட்டது. நிதித்துறை அதிகாரம் உள்ள வேறொருவர் அனுமதிகள் பக்கத்தில் அனுமதிப்பார்.',
    sentNow: 'அனுப்பியதாகப் பதிவானது. விநியோகஸ்தர் தன் போர்ட்டலில் காண்பார்; அஞ்சலில் அனுப்ப அல்லது கையில் கொடுக்க ஆவணத்தை அச்சிடுங்கள்.', already: 'ஏற்கனவே பதிவானது — எதுவும் மாறவில்லை.',
    receiptMatched: 'பணம் பதிவாகி கோரிக்கையுடன் பொருத்தப்பட்டது.', receiptNotMatched: 'பணம் பதிவானது, ஆனால் தலைமை அலுவலகம் அதைக் கோரிக்கையுடன் பொருத்தவில்லை:',
    notApprovedYet: 'நிதித்துறை இந்தக் கோரிக்கையை இன்னும் அனுமதிக்கவில்லை — கேட்டு, வேறொருவர் அனுமதிக்கும் வரை காத்திருங்கள்.', needRaise: 'திட்டத்தையும் ரூபாயில் தொகையையும் நிரப்புங்கள்.', needSentOn: 'அனுப்பிய நாளை எழுதுங்கள் (YYYY-MM-DD).',
    needReason: 'முதலில் ஏன் என்று எழுதுங்கள்.', needReceipt: 'திட்டம், தொகை, நாள், குறிப்பு ஆகியவற்றை நிரப்புங்கள்.', needDays: '0-ஐ விட அதிகமான முழு எண் நாட்களை எழுதுங்கள்.', needClaim: 'கோரிக்கை எண்ணை எழுதுங்கள்.',
    nobody: 'இந்தத் திரையில் யாரும் உள்நுழையவில்லை.', cannotRead: 'உங்கள் பணி தள்ளுபடிப் பதிவேட்டைப் படிக்க முடியாது.', cannotClaim: 'உங்கள் பணி தள்ளுபடிக் கோரிக்கைகளை எழுப்பவோ அனுப்பவோ முடியாது.', cannotReceipt: 'உங்கள் பணி தள்ளுபடிப் பணத்தைப் பதிவு செய்ய முடியாது.', cannotSetPeriod: 'பதில் நாட்களை உரிமையாளர் மட்டுமே அமைப்பார்.',
    refused: 'தலைமை அலுவலகம் மறுத்தது:', unreachable: 'தலைமை அலுவலகத்தை அடைய முடியவில்லை — எதுவும் படிக்கவோ சேமிக்கவோ இல்லை.',
  },
} as const;

export const rebatesWords = (lang: Lang, key: string): string =>
  (REBATES_COPY[lang] as Record<string, string>)[key] ?? (REBATES_COPY.en as Record<string, string>)[key] ?? key;

export interface ApprovalAsk { readonly kind: string; readonly subjectRef: string; readonly valueMinor: number; readonly details: Record<string, unknown>; readonly summary: string; readonly reason: string }
export interface ClaimRow {
  readonly claimId: string; readonly schemeId: string; readonly supplierId: string; readonly amountMinor: number; readonly raisedBy: string; readonly raisedAt: string;
  readonly state: 'raised' | 'sent' | 'partly_answered' | 'answered' | 'withdrawn'; readonly matchedMinor: number; readonly unansweredMinor: number;
  readonly dueOn: string | null; readonly overdue: boolean | 'not_set'; readonly findings: readonly string[]; readonly approvalAsk?: ApprovalAsk;
  readonly sent?: { readonly sentOn: string; readonly approvedBy: string }; readonly withdrawn?: { readonly reason: string }; readonly note?: string;
}
export interface SchemeLine {
  readonly schemeId: string; readonly supplierId: string; readonly rateBp: number; readonly startsOn: string; readonly endsOn: string; readonly approved: boolean;
  readonly accruedMinor: number; readonly receivedMinor: number; readonly outstandingMinor: number; readonly openClaimedMinor: number; readonly claimableMinor: number; readonly overClaimedMinor: number;
  readonly findings: readonly string[];
  readonly accruals: readonly { readonly accrualId: string | null; readonly periodFrom: string | null; readonly periodTo: string | null; readonly accruedMinor: number }[];
  readonly receipts: readonly { readonly receiptId: string; readonly amountMinor: number; readonly receivedOn: string; readonly reference: string; readonly matchedMinor: number }[];
}
export interface RebateRegister {
  readonly answerPeriod: { readonly state: 'set' | 'not_set'; readonly days: number | null };
  readonly schemes: readonly SchemeLine[]; readonly claims: readonly ClaimRow[];
  readonly unmatchedReceipts: readonly { readonly schemeId: string; readonly receiptId: string; readonly amountMinor: number; readonly leftToMatchMinor: number; readonly receivedOn: string }[];
  readonly counts: { readonly claims: number; readonly waitingForFinance: number; readonly overdue: number; readonly overdueNotKnown: number }; readonly today: string; readonly asAt: string;
}
export interface ClaimDocument { readonly document: Record<string, unknown> & { readonly status: string; readonly claimNumber: string; readonly amountClaimedMinor: number }; readonly printable: boolean }
export interface RaiseForm { readonly schemeId: string; readonly amountRupees: string; readonly note: string }
export interface ReceiptForm { readonly schemeId: string; readonly amountRupees: string; readonly receivedOn: string; readonly reference: string; readonly claimId: string }

type Why = 'nobody' | 'cannotRead' | 'cannotClaim' | 'cannotReceipt' | 'cannotSetPeriod' | 'needRaise' | 'needSentOn' | 'needReason' | 'needReceipt' | 'needDays' | 'needClaim' | 'notApprovedYet';
type Done<T = Record<string, unknown>> = Promise<Outcome<T, Why>>;

export interface RebatesSession {
  readonly may: { readonly named: boolean; readonly read: boolean; readonly claim: boolean; readonly receipt: boolean; readonly setPeriod: boolean };
  register(): Done<RebateRegister>;
  raise(form: RaiseForm): Done<{ readonly claim: ClaimRow; readonly alreadyRaised: boolean }>;
  askApproval(claim: ClaimRow): Done<{ readonly requestId: string }>;
  send(claim: ClaimRow, sentOn: string): Done<{ readonly alreadySent: boolean }>;
  withdraw(claimId: string, reason: string): Done<{ readonly alreadyWithdrawn: boolean }>;
  document(claimId: string): Done<ClaimDocument>;
  receipt(form: ReceiptForm): Done<{ readonly matched: boolean | null; readonly matchRefusal?: string }>;
  match(claimId: string, receiptId: string): Done<{ readonly alreadyMatched: boolean }>;
  setPeriod(days: string): Done;
  clearPeriod(reason: string): Done;
}

const seg = (s: string): string => encodeURIComponent(s.trim());
const DAY = /^\d{4}-\d{2}-\d{2}$/;

export const rebatesOutcomeWords = (lang: Lang, out: Outcome<unknown>): string => {
  if (out.result !== 'ok') return outcomeIn((k) => rebatesWords(lang, k), out);
  const v = (out.value ?? {}) as Record<string, unknown>;
  if (v['alreadyRaised'] === true || v['alreadySent'] === true || v['alreadyWithdrawn'] === true || v['alreadyMatched'] === true) return rebatesWords(lang, 'already');
  if (v['matched'] === false) return `${rebatesWords(lang, 'receiptNotMatched')} ${String(v['matchRefusal'] ?? '')}`.trim();
  if (v['matched'] === true) return rebatesWords(lang, 'receiptMatched');
  if (v['alreadyRaised'] === false) return rebatesWords(lang, 'raisedNow');
  if (v['alreadySent'] === false) return rebatesWords(lang, 'sentNow');
  if (typeof v['requestId'] === 'string') return rebatesWords(lang, 'askedNow');
  return rebatesWords(lang, 'saved');
};

export function createRebatesSession(input: {
  readonly viewer: { readonly userId?: string; readonly permissions: readonly string[] } | undefined;
  readonly fetch?: typeof globalThis.fetch; readonly newKey?: () => string; readonly newClaimId?: () => string; readonly newReceiptId?: () => string;
}): RebatesSession {
  const named = input.viewer?.userId !== undefined;
  const held = new Set(input.viewer?.permissions ?? []);
  const may = {
    named, read: named && held.has('purchase.commitment.read'), claim: named && held.has('purchase.contract.manage'),
    receipt: named && held.has('finance.journal.post'), setPeriod: named && held.has('purchase.rebate.terms.set'),
  };
  const call = makeCaller({ keyPrefix: 'rebates', ...(input.fetch === undefined ? {} : { fetch: input.fetch }), ...(input.newKey === undefined ? {} : { newKey: input.newKey }) });
  const claimIdOf = input.newClaimId ?? (() => newId('RC'));
  const receiptIdOf = input.newReceiptId ?? (() => newId('rcpt'));
  const gate = (need: keyof typeof may, why: Why): { result: 'invalid'; why: Why } | undefined =>
    !named ? { result: 'invalid', why: 'nobody' } : !may[need] ? { result: 'invalid', why } : undefined;
  return {
    may,
    register: async () => gate('read', 'cannotRead') ?? call('GET', '/v1/purchase/rebate-claims'),
    raise: async (f) => {
      const no = gate('claim', 'cannotClaim'); if (no !== undefined) return no;
      const amountMinor = paiseOf(f.amountRupees);
      if (f.schemeId.trim() === '' || amountMinor === null || amountMinor <= 0 || f.note.length > 300) return { result: 'invalid', why: 'needRaise' };
      return call('POST', `/v1/purchase/rebate-schemes/${seg(f.schemeId)}/claims/${encodeURIComponent(claimIdOf())}`, { amountMinor, ...(f.note.trim() === '' ? {} : { note: f.note.trim() }) });
    },
    // The ask is exactly what head office said Finance approves for this claim — never rebuilt here.
    askApproval: async (c) => {
      const no = gate('claim', 'cannotClaim'); if (no !== undefined) return no;
      if (c.approvalAsk === undefined) return { result: 'invalid', why: 'notApprovedYet' };
      return call('POST', '/v1/approvals/requests', c.approvalAsk);
    },
    // The approval is the asker's own approved request for this claim — found, never typed.
    send: async (c, sentOn) => {
      const no = gate('claim', 'cannotClaim'); if (no !== undefined) return no;
      if (!DAY.test(sentOn.trim())) return { result: 'invalid', why: 'needSentOn' };
      const mine = await call<{ mine?: readonly { requestId: string; kind: string; subjectRef: string; status: string }[] }>('GET', '/v1/approvals/requests');
      if (mine.result !== 'ok') return mine;
      const approved = (mine.value.mine ?? []).find((q) => q.kind === 'rebate_claim' && q.subjectRef === c.claimId && q.status === 'approved');
      if (approved === undefined) return { result: 'invalid', why: 'notApprovedYet' };
      return call('POST', `/v1/purchase/rebate-claims/${seg(c.claimId)}/send`, { approvalId: approved.requestId, sentOn: sentOn.trim() });
    },
    withdraw: async (claimId, reason) => {
      const no = gate('claim', 'cannotClaim'); if (no !== undefined) return no;
      if (reason.trim() === '') return { result: 'invalid', why: 'needReason' };
      return call('POST', `/v1/purchase/rebate-claims/${seg(claimId)}/withdraw`, { reason: reason.trim() });
    },
    document: async (claimId) => gate('read', 'cannotRead') ?? call('GET', `/v1/purchase/rebate-claims/${seg(claimId)}/document`),
    // Finance records the money (one journal); when it names a claim, head office then matches it. A refused match is said
    // with the money still recorded — never a half-done step shown as done.
    receipt: async (f) => {
      const no = gate('receipt', 'cannotReceipt'); if (no !== undefined) return no;
      const amountMinor = paiseOf(f.amountRupees);
      if (f.schemeId.trim() === '' || amountMinor === null || amountMinor <= 0 || !DAY.test(f.receivedOn.trim()) || f.reference.trim() === '') return { result: 'invalid', why: 'needReceipt' };
      const receiptId = receiptIdOf();
      const r = await call('POST', `/v1/finance/rebate-receipts/${seg(f.schemeId)}/receipts/${encodeURIComponent(receiptId)}`, { amountMinor, receivedOn: f.receivedOn.trim(), reference: f.reference.trim() });
      if (r.result !== 'ok') return r;
      if (f.claimId.trim() === '') return { result: 'ok', value: { matched: null } };
      const m = await call('POST', `/v1/purchase/rebate-claims/${seg(f.claimId)}/matches/${encodeURIComponent(receiptId)}`, {});
      if (m.result === 'ok') return { result: 'ok', value: { matched: true } };
      return { result: 'ok', value: { matched: false, matchRefusal: m.result === 'refused' ? m.whatHappened : rebatesWords('en', 'unreachable') } };
    },
    match: async (claimId, receiptId) => {
      const no = gate('receipt', 'cannotReceipt'); if (no !== undefined) return no;
      if (claimId.trim() === '') return { result: 'invalid', why: 'needClaim' };
      return call('POST', `/v1/purchase/rebate-claims/${seg(claimId)}/matches/${seg(receiptId)}`, {});
    },
    setPeriod: async (days) => {
      const no = gate('setPeriod', 'cannotSetPeriod'); if (no !== undefined) return no;
      if (!/^\d+$/.test(days.trim()) || Number(days.trim()) <= 0) return { result: 'invalid', why: 'needDays' };
      return call('POST', '/v1/purchase/rebate-claims/answer-period', { days: Number(days.trim()) });
    },
    clearPeriod: async (reason) => {
      const no = gate('setPeriod', 'cannotSetPeriod'); if (no !== undefined) return no;
      if (reason.trim() === '') return { result: 'invalid', why: 'needReason' };
      return call('POST', '/v1/purchase/rebate-claims/answer-period', { clear: true, reason: reason.trim() });
    },
  };
}
