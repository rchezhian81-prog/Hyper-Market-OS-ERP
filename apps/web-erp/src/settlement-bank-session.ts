// Card, UPI and bank (W3 · M23-FR-03 "import bank/gateway statements → match to POS tenders and refunds → flag exceptions
// with value" · M14-FR-03 · C14 · P-03 · P-08 · hard rules #3, #6, #10) — a tested, DOM-free session over head office's own
// settlement, bank-statement, cash-deposit and payment-dispute routes, which no screen reached before:
//   • LOAD the card/UPI provider's settlement file (`POST /v1/settlement/batches`) and the bank's statement
//     (`POST /v1/finance/bank-statements`) — head office refuses a file that does not add up to its own figures, or that is
//     already in, in its own words;
//   • RECORD cash taken to the bank (`/v1/finance/cash-deposits*`), each matched to the bank credit naming its slip;
//   • REVIEW the tills' card and UPI takings against what the provider paid (`GET /v1/settlement/review`) — matched, not
//     due yet, and the exceptions with their value; OPEN a case on one with a named owner and a due day, add evidence,
//     and close it only with an outcome and a note (`/v1/settlement/investigations*`); writing money off is a second
//     person's (head office refuses the raiser by name);
//   • PAYMENT DISPUTES (`/v1/finance/payment-disputes*`): record the bank's notice, the answer sent, and won or lost.
// No card number is ever typed here (head office refuses one). The page reads as it opens; nothing is written until a click.

import { makeCaller, outcomeIn, newId, type Outcome } from './r4-insight-call';

export type Lang = 'en' | 'ta';

export const SETTLEMENT_COPY = {
  en: {
    title: 'Card, UPI and bank', lead: 'Load the card and UPI provider\'s settlement file and the bank\'s statement, record cash taken to the bank, and check the tills\' card and UPI takings against what was actually paid. Every difference is shown with its value and stays open until a named person closes it with a reason.',
    loadH: 'Load a file', batchH: 'Card or UPI settlement file', batchFile: 'The provider\'s settlement file (.json)', batchLoad: 'Load the settlement file', batchDone: 'Loaded — head office checked it adds up and holds it.',
    statementH: 'Bank statement', stId: 'Statement number', stAccount: 'Account (the shop\'s name for it, never the number)', stFrom: 'From (YYYY-MM-DD)', stTo: 'To (YYYY-MM-DD)',
    stOpening: 'Opening balance (₹)', stClosing: 'Closing balance (₹)', stFile: 'The bank\'s statement export (.csv)', stLoad: 'Load the statement', stDone: 'Loaded — head office checked it adds up to its balances.',
    statementsH: 'Statements loaded', noStatements: 'No bank statement loaded yet.', lines: 'lines', loadedBy: 'loaded by',
    depositsH: 'Cash taken to the bank', depOn: 'Paid in on (YYYY-MM-DD)', depAmount: 'Amount (₹)', depSlip: 'Deposit slip number', depAccount: 'Account (the shop\'s name for it)', depNote: 'Note (optional)',
    depRecord: 'Record the deposit', depDone: 'Recorded.', depAlready: 'Already recorded — nothing changed.', noDeposits: 'No cash deposit recorded yet.',
    dep_in_bank: 'In the bank', dep_not_in_bank: 'Not in the bank yet — no statement credit names this slip for this amount', dep_cancelled: 'Cancelled',
    depCancel: 'Cancel this record', depCancelWhy: 'Why is it wrong?', depCancelled: 'Cancelled — the record stays on file with your reason.', depTotals: 'Recorded {recorded} · in the bank {inBank} · not in the bank {notInBank}',
    reviewH: 'Check card and UPI takings', asOf: 'Check up to (YYYY-MM-DD)', cycle: 'The provider pays after (days)', review: 'Check',
    matched: 'Matched', awaiting: 'Not due yet', atRisk: 'Late or wrong', windowSays: 'Takings from {from} to {to} were checked. Older ones are not part of this check.',
    noExceptions: 'Nothing late or wrong in this check.', exceptionsH: 'Differences',
    f_awaiting_settlement: 'Not paid yet — not due yet', f_overdue_settlement: 'Not paid — past the provider\'s days', f_short_settled: 'Paid short', f_over_settled: 'Paid more than taken',
    f_unknown_credit: 'Paid, but no till took it', f_ambiguous_reference: 'One reference, more than one payment', f_chargeback: 'Taken back by the customer\'s bank', f_refund_awaiting_settlement: 'Refund not taken by the provider yet — not due yet',
    owner: 'Who looks into it (their user id)', dueBy: 'Answer by (YYYY-MM-DD)', openCase: 'Open a case', caseOpened: 'Case opened.',
    casesH: 'Open cases', noCases: 'No open case.', evidence: 'Evidence reference (document or link)', addEvidence: 'Add evidence', evidenceAdded: 'Evidence added.',
    outcome: 'What was found', note: 'Note', resolve: 'Close the case', resolved: 'Case closed.', ageing: 'Open cases by age',
    o_provider_error_recovered: 'Provider\'s mistake — money recovered', o_provider_fee_not_an_exception: 'Provider\'s fee — not a difference', o_till_error: 'Till mistake', o_timing_only: 'Only late — now paid',
    o_written_off: 'Written off (a second person)', o_fraud_suspected: 'Fraud suspected',
    disputesH: 'Payment disputes', noDisputes: 'No payment dispute recorded.', dId: 'Dispute number', dInstrument: 'Paid by', dRef: 'The bank\'s case or transaction reference (never the card number)', dAmount: 'Amount disputed (₹)',
    dReceived: 'Notice received on (YYYY-MM-DD)', dRespondBy: 'Reply by (card only — from the bank\'s notice)', dReason: 'Reason given', dSale: 'Bill number (optional)', dRecord: 'Record the dispute', dRecorded: 'Dispute recorded.', dAlready: 'Already recorded — nothing changed.',
    i_upi: 'UPI', i_card: 'Card', ds_open: 'Open — not answered', ds_answered: 'Answered', ds_won: 'Won', ds_lost: 'Lost', overdueBy: 'NOT ANSWERED — {days} day(s) past the reply-by day', answeredLate: 'answered after the reply-by day',
    respondBy: 'Reply by', respondedOn: 'Answered on (YYYY-MM-DD)', evidenceRef: 'Evidence pack reference', answer: 'Record the answer sent', answered: 'Answer recorded.', decidedOn: 'Decided on (YYYY-MM-DD)', won: 'Won', lost: 'Lost', decide: 'Record the bank\'s decision', decided: 'Decision recorded.',
    disputeTotals: '{open} open · lost so far {lost}',
    needBatch: 'Choose the provider\'s settlement file first.', badBatch: 'This file is not a settlement file this page can read (it must be the provider\'s JSON file).', needStatement: 'Fill in every statement field and choose the bank\'s CSV file.',
    needDeposit: 'Fill in the day, the amount in rupees, the slip number and the account.', needReason: 'Write the reason first.', needReview: 'Write the day (YYYY-MM-DD) and the provider\'s days (a whole number).',
    needCase: 'Write who looks into it and the answer-by day (YYYY-MM-DD).', needEvidence: 'Write the evidence reference.', needResolve: 'Choose what was found and write a note.',
    needDispute: 'Fill in the number, how it was paid, the bank\'s reference, the amount, the day received and the reason (and the reply-by day for a card).', needAnswer: 'Write the day answered and the evidence reference.', needDecision: 'Write the day the bank decided.',
    nobody: 'Nobody is signed in on this screen.', cannotRead: 'Your role cannot see card, UPI and bank reconciliation.', cannotImport: 'Your role cannot load files or record deposits.', cannotInvestigate: 'Your role cannot open or close cases.',
    cannotDisputes: 'Your role cannot see payment disputes.', cannotRecordDispute: 'Your role cannot record payment disputes.',
    refused: 'Head office refused:', unreachable: 'Head office cannot be reached — nothing was read or saved.', reading: 'Reading from head office…',
  },
  ta: {
    title: 'அட்டை, UPI மற்றும் வங்கி', lead: 'அட்டை, UPI வழங்குநரின் தீர்வுக் கோப்பையும் வங்கி அறிக்கையையும் ஏற்றுங்கள், வங்கியில் செலுத்திய ரொக்கத்தைப் பதிவு செய்யுங்கள், கல்லாக்களின் அட்டை, UPI வசூலை உண்மையில் செலுத்தியதுடன் ஒப்பிடுங்கள். ஒவ்வொரு வேறுபாடும் அதன் மதிப்புடன் காட்டப்படும்; பெயரிடப்பட்ட ஒருவர் காரணத்துடன் மூடும் வரை திறந்தே இருக்கும்.',
    loadH: 'கோப்பை ஏற்று', batchH: 'அட்டை அல்லது UPI தீர்வுக் கோப்பு', batchFile: 'வழங்குநரின் தீர்வுக் கோப்பு (.json)', batchLoad: 'தீர்வுக் கோப்பை ஏற்று', batchDone: 'ஏற்றப்பட்டது — தலைமை அலுவலகம் கூட்டல் சரியா எனப் பார்த்து வைத்துள்ளது.',
    statementH: 'வங்கி அறிக்கை', stId: 'அறிக்கை எண்', stAccount: 'கணக்கு (கடையின் பெயர், எண் அல்ல)', stFrom: 'முதல் (YYYY-MM-DD)', stTo: 'வரை (YYYY-MM-DD)',
    stOpening: 'தொடக்க இருப்பு (₹)', stClosing: 'இறுதி இருப்பு (₹)', stFile: 'வங்கியின் அறிக்கை ஏற்றுமதி (.csv)', stLoad: 'அறிக்கையை ஏற்று', stDone: 'ஏற்றப்பட்டது — தலைமை அலுவலகம் இருப்புகளுடன் கூட்டல் சரி எனப் பார்த்தது.',
    statementsH: 'ஏற்றப்பட்ட அறிக்கைகள்', noStatements: 'இன்னும் வங்கி அறிக்கை ஏற்றப்படவில்லை.', lines: 'வரிகள்', loadedBy: 'ஏற்றியவர்',
    depositsH: 'வங்கியில் செலுத்திய ரொக்கம்', depOn: 'செலுத்திய நாள் (YYYY-MM-DD)', depAmount: 'தொகை (₹)', depSlip: 'செலுத்துச் சீட்டு எண்', depAccount: 'கணக்கு (கடையின் பெயர்)', depNote: 'குறிப்பு (விருப்பம்)',
    depRecord: 'செலுத்தலைப் பதிவு செய்', depDone: 'பதிவு செய்யப்பட்டது.', depAlready: 'ஏற்கனவே பதிவாகியுள்ளது — எதுவும் மாறவில்லை.', noDeposits: 'இன்னும் ரொக்கச் செலுத்தல் பதிவாகவில்லை.',
    dep_in_bank: 'வங்கியில் உள்ளது', dep_not_in_bank: 'இன்னும் வங்கியில் இல்லை — எந்த அறிக்கை வரவும் இந்தச் சீட்டை இந்தத் தொகைக்குக் குறிப்பிடவில்லை', dep_cancelled: 'ரத்து செய்யப்பட்டது',
    depCancel: 'இந்தப் பதிவை ரத்து செய்', depCancelWhy: 'ஏன் தவறு?', depCancelled: 'ரத்து செய்யப்பட்டது — உங்கள் காரணத்துடன் பதிவு கோப்பில் இருக்கும்.', depTotals: 'பதிவு {recorded} · வங்கியில் {inBank} · வங்கியில் இல்லாதவை {notInBank}',
    reviewH: 'அட்டை, UPI வசூலைச் சரிபார்', asOf: 'இந்த நாள் வரை (YYYY-MM-DD)', cycle: 'வழங்குநர் செலுத்தும் நாட்கள்', review: 'சரிபார்',
    matched: 'பொருந்தியவை', awaiting: 'இன்னும் உரிய நாள் வரவில்லை', atRisk: 'தாமதம் அல்லது தவறு', windowSays: '{from} முதல் {to} வரையிலான வசூல் சரிபார்க்கப்பட்டது. அதற்கு முந்தையவை இந்தச் சரிபார்ப்பில் இல்லை.',
    noExceptions: 'இந்தச் சரிபார்ப்பில் தாமதமோ தவறோ இல்லை.', exceptionsH: 'வேறுபாடுகள்',
    f_awaiting_settlement: 'இன்னும் செலுத்தவில்லை — உரிய நாள் வரவில்லை', f_overdue_settlement: 'செலுத்தவில்லை — வழங்குநரின் நாட்கள் கடந்தன', f_short_settled: 'குறைவாகச் செலுத்தப்பட்டது', f_over_settled: 'வசூலை விட அதிகம் செலுத்தப்பட்டது',
    f_unknown_credit: 'செலுத்தப்பட்டது, ஆனால் எந்தக் கல்லாவும் வசூலிக்கவில்லை', f_ambiguous_reference: 'ஒரு குறிப்பு, ஒன்றுக்கு மேற்பட்ட செலுத்தல்', f_chargeback: 'வாடிக்கையாளரின் வங்கி திரும்பப் பெற்றது', f_refund_awaiting_settlement: 'பணத்திருப்பத்தை வழங்குநர் இன்னும் எடுக்கவில்லை — உரிய நாள் வரவில்லை',
    owner: 'யார் விசாரிப்பார் (பயனர் அடையாளம்)', dueBy: 'பதில் நாள் (YYYY-MM-DD)', openCase: 'வழக்கைத் திற', caseOpened: 'வழக்கு திறக்கப்பட்டது.',
    casesH: 'திறந்த வழக்குகள்', noCases: 'திறந்த வழக்கு இல்லை.', evidence: 'சான்றுக் குறிப்பு (ஆவணம் அல்லது இணைப்பு)', addEvidence: 'சான்று சேர்', evidenceAdded: 'சான்று சேர்க்கப்பட்டது.',
    outcome: 'கண்டறிந்தது', note: 'குறிப்பு', resolve: 'வழக்கை மூடு', resolved: 'வழக்கு மூடப்பட்டது.', ageing: 'வயதுவாரியாகத் திறந்த வழக்குகள்',
    o_provider_error_recovered: 'வழங்குநரின் தவறு — பணம் மீட்கப்பட்டது', o_provider_fee_not_an_exception: 'வழங்குநரின் கட்டணம் — வேறுபாடு அல்ல', o_till_error: 'கல்லாத் தவறு', o_timing_only: 'தாமதம் மட்டும் — இப்போது செலுத்தப்பட்டது',
    o_written_off: 'தள்ளுபடி (இரண்டாவது நபர்)', o_fraud_suspected: 'மோசடி சந்தேகம்',
    disputesH: 'செலுத்தல் தகராறுகள்', noDisputes: 'செலுத்தல் தகராறு எதுவும் பதிவாகவில்லை.', dId: 'தகராறு எண்', dInstrument: 'செலுத்திய முறை', dRef: 'வங்கியின் வழக்கு அல்லது பரிவர்த்தனைக் குறிப்பு (அட்டை எண் அல்ல)', dAmount: 'தகராறுத் தொகை (₹)',
    dReceived: 'அறிவிப்பு வந்த நாள் (YYYY-MM-DD)', dRespondBy: 'பதில் நாள் (அட்டைக்கு மட்டும் — வங்கி அறிவிப்பிலிருந்து)', dReason: 'கூறப்பட்ட காரணம்', dSale: 'பில் எண் (விருப்பம்)', dRecord: 'தகராறைப் பதிவு செய்', dRecorded: 'தகராறு பதிவாகியது.', dAlready: 'ஏற்கனவே பதிவாகியுள்ளது — எதுவும் மாறவில்லை.',
    i_upi: 'UPI', i_card: 'அட்டை', ds_open: 'திறந்துள்ளது — பதில் அளிக்கவில்லை', ds_answered: 'பதில் அளிக்கப்பட்டது', ds_won: 'வென்றது', ds_lost: 'இழந்தது', overdueBy: 'பதில் அளிக்கவில்லை — பதில் நாளைக் கடந்து {days} நாள்', answeredLate: 'பதில் நாளுக்குப் பின் பதிலளிக்கப்பட்டது',
    respondBy: 'பதில் நாள்', respondedOn: 'பதிலளித்த நாள் (YYYY-MM-DD)', evidenceRef: 'சான்றுத் தொகுப்புக் குறிப்பு', answer: 'அனுப்பிய பதிலைப் பதிவு செய்', answered: 'பதில் பதிவாகியது.', decidedOn: 'முடிவு நாள் (YYYY-MM-DD)', won: 'வென்றது', lost: 'இழந்தது', decide: 'வங்கியின் முடிவைப் பதிவு செய்', decided: 'முடிவு பதிவாகியது.',
    disputeTotals: '{open} திறந்தவை · இதுவரை இழந்தது {lost}',
    needBatch: 'முதலில் வழங்குநரின் தீர்வுக் கோப்பைத் தேர்ந்தெடுங்கள்.', badBatch: 'இந்தக் கோப்பை இந்தப் பக்கம் தீர்வுக் கோப்பாகப் படிக்க முடியவில்லை (வழங்குநரின் JSON கோப்பாக இருக்க வேண்டும்).', needStatement: 'அறிக்கையின் எல்லா விவரங்களையும் நிரப்பி, வங்கியின் CSV கோப்பைத் தேர்ந்தெடுங்கள்.',
    needDeposit: 'நாள், ரூபாயில் தொகை, சீட்டு எண், கணக்கு ஆகியவற்றை நிரப்புங்கள்.', needReason: 'முதலில் காரணத்தை எழுதுங்கள்.', needReview: 'நாளையும் (YYYY-MM-DD) வழங்குநரின் நாட்களையும் (முழு எண்) எழுதுங்கள்.',
    needCase: 'யார் விசாரிப்பார், பதில் நாள் (YYYY-MM-DD) ஆகியவற்றை எழுதுங்கள்.', needEvidence: 'சான்றுக் குறிப்பை எழுதுங்கள்.', needResolve: 'கண்டறிந்ததைத் தேர்ந்தெடுத்து, குறிப்பு எழுதுங்கள்.',
    needDispute: 'எண், செலுத்திய முறை, வங்கியின் குறிப்பு, தொகை, வந்த நாள், காரணம் ஆகியவற்றை நிரப்புங்கள் (அட்டைக்குப் பதில் நாளும்).', needAnswer: 'பதிலளித்த நாளையும் சான்றுக் குறிப்பையும் எழுதுங்கள்.', needDecision: 'வங்கி முடிவு செய்த நாளை எழுதுங்கள்.',
    nobody: 'இந்தத் திரையில் யாரும் உள்நுழையவில்லை.', cannotRead: 'உங்கள் பங்கு அட்டை, UPI, வங்கிச் சரிபார்ப்பைப் பார்க்க முடியாது.', cannotImport: 'உங்கள் பங்கு கோப்புகளை ஏற்றவோ செலுத்தல்களைப் பதியவோ முடியாது.', cannotInvestigate: 'உங்கள் பங்கு வழக்குகளைத் திறக்கவோ மூடவோ முடியாது.',
    cannotDisputes: 'உங்கள் பங்கு செலுத்தல் தகராறுகளைப் பார்க்க முடியாது.', cannotRecordDispute: 'உங்கள் பங்கு செலுத்தல் தகராறுகளைப் பதிய முடியாது.',
    refused: 'தலைமை அலுவலகம் மறுத்தது:', unreachable: 'தலைமை அலுவலகத்தை அடைய முடியவில்லை — எதுவும் படிக்கப்படவில்லை, சேமிக்கப்படவில்லை.', reading: 'தலைமை அலுவலகத்திலிருந்து படிக்கிறது…',
  },
} as const;

export function settlementWords(lang: Lang, key: string, fill?: Readonly<Record<string, string | number>>): string {
  const raw = (SETTLEMENT_COPY[lang] as Record<string, string>)[key] ?? (SETTLEMENT_COPY.en as Record<string, string>)[key] ?? key;
  return fill === undefined ? raw : raw.replace(/\{(\w+)\}/g, (_, k: string) => String(fill[k] ?? `{${k}}`));
}

export const rupees = (minor: number): string => `${minor < 0 ? '−' : ''}₹${(Math.abs(minor) / 100).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
/** "₹1,234.50" / "-500" → paise (a balance may be below zero); null when it is not an amount. */
export function signedPaiseOf(text: string): number | null {
  const t = text.replace(/[₹,\s]/g, '');
  const m = /^(-?)(\d+)(?:\.(\d{1,2}))?$/.exec(t);
  if (m === null) return null;
  const v = Number(m[2]) * 100 + Number((m[3] ?? '').padEnd(2, '0'));
  return m[1] === '-' ? -v : v;
}

const DAY = /^\d{4}-\d{2}-\d{2}$/;
const day = (s: string): boolean => DAY.test(s.trim()) && new Date(`${s.trim()}T00:00:00.000Z`).toISOString().slice(0, 10) === s.trim();
const seg = (s: string): string => encodeURIComponent(s.trim());

export interface SettlementException { readonly finding: string; readonly ref: string; readonly valueMinor: number; readonly needsInvestigation: boolean; readonly detail: string; readonly ageDays?: number; readonly tenderId?: string; readonly settlementId?: string }
export interface SettlementReview {
  readonly matchedCount: number; readonly matchedValueMinor: number; readonly exceptions: readonly SettlementException[];
  readonly awaitingValueMinor: number; readonly atRiskValueMinor: number; readonly detail: string;
  readonly window: { readonly from: string; readonly to: string; readonly windowDays: number };
}
export interface OpenCase { readonly investigationId: string; readonly ref: string; readonly finding: string; readonly valueMinor: number; readonly ownerId: string; readonly dueBy: string; readonly openedAt: string; readonly evidenceCount: number }
export interface CaseList { readonly open: readonly OpenCase[]; readonly ageing: readonly { readonly label: string; readonly count: number; readonly valueMinor: number }[] }
export interface DepositRow {
  readonly depositId: string; readonly depositedOn: string; readonly amountMinor: number; readonly slipRef: string; readonly accountRef: string; readonly note?: string; readonly recordedBy: string;
  readonly state: 'in_bank' | 'not_in_bank' | 'cancelled'; readonly bankLine: { readonly statementId: string; readonly lineId: string; readonly date: string } | null; readonly cancelled?: { readonly reason: string; readonly by: string };
}
export interface DepositList { readonly deposits: readonly DepositRow[]; readonly recordedMinor: number; readonly inBankMinor: number; readonly notInBank: number }
export interface StatementRow { readonly statementId: string; readonly accountRef: string; readonly fromDate: string; readonly toDate: string; readonly openingMinor: number; readonly closingMinor: number; readonly lines: number; readonly provenance: { readonly importedBy: string; readonly importedAt: string; readonly sourceName?: string } }
export interface DisputeRow {
  readonly disputeId: string; readonly instrument: 'upi' | 'card'; readonly saleId: string | null; readonly providerRef: string; readonly amountMinor: number; readonly receivedOn: string; readonly respondBy: string; readonly reason: string;
  readonly state: 'open' | 'answered' | 'won' | 'lost'; readonly overdue: boolean; readonly daysOverdue: number; readonly answeredLate: boolean;
  readonly response: { readonly respondedOn: string; readonly evidenceRef: string } | null; readonly outcome: { readonly outcome: 'won' | 'lost'; readonly decidedOn: string } | null;
}
export interface DisputeList { readonly asOf: string; readonly disputes: readonly DisputeRow[]; readonly open: number; readonly lostMinor: number }

export const INVESTIGATION_OUTCOMES = ['provider_error_recovered', 'provider_fee_not_an_exception', 'till_error', 'timing_only', 'written_off', 'fraud_suspected'] as const;

export interface StatementForm { readonly statementId: string; readonly accountRef: string; readonly fromDate: string; readonly toDate: string; readonly openingRupees: string; readonly closingRupees: string; readonly csv: string; readonly sourceName: string }
export interface DepositForm { readonly depositedOn: string; readonly amountRupees: string; readonly slipRef: string; readonly accountRef: string; readonly note: string }
export interface DisputeForm { readonly disputeId: string; readonly instrument: string; readonly providerRef: string; readonly amountRupees: string; readonly receivedOn: string; readonly respondBy: string; readonly reason: string; readonly saleId: string }

type Why = 'nobody' | 'cannotRead' | 'cannotImport' | 'cannotInvestigate' | 'cannotDisputes' | 'cannotRecordDispute' | 'needBatch' | 'badBatch' | 'needStatement' | 'needDeposit'
  | 'needReason' | 'needReview' | 'needCase' | 'needEvidence' | 'needResolve' | 'needDispute' | 'needAnswer' | 'needDecision';
type Done<T = Record<string, unknown>> = Promise<Outcome<T, Why>>;

export const settlementOutcomeWords = (lang: Lang, out: Outcome<unknown>): string => outcomeIn((k) => settlementWords(lang, k), out);

export interface SettlementSession {
  readonly may: { readonly named: boolean; readonly read: boolean; readonly import: boolean; readonly investigate: boolean; readonly disputes: boolean; readonly recordDispute: boolean };
  importBatch(fileText: string, sourceName: string): Done<{ readonly batchId: string }>;
  importStatement(f: StatementForm): Done<{ readonly statementId: string; readonly lines: number }>;
  statements(): Done<{ readonly statements: readonly StatementRow[] }>;
  deposits(): Done<DepositList>;
  recordDeposit(f: DepositForm): Done<{ readonly alreadyRecorded: boolean }>;
  cancelDeposit(depositId: string, reason: string): Done;
  review(asOf: string, cycleDays: string): Done<SettlementReview>;
  cases(asOf: string): Done<CaseList>;
  openCase(e: SettlementException, ownerId: string, dueBy: string): Done<{ readonly investigationId: string }>;
  addEvidence(investigationId: string, ref: string): Done;
  resolve(investigationId: string, outcome: string, note: string): Done;
  disputes(asOf: string): Done<DisputeList>;
  recordDispute(f: DisputeForm): Done<{ readonly alreadyRecorded: boolean }>;
  answer(disputeId: string, respondedOn: string, evidenceRef: string): Done;
  decide(disputeId: string, outcome: 'won' | 'lost', decidedOn: string): Done;
}

export function createSettlementSession(input: {
  readonly viewer: { readonly userId?: string; readonly permissions: readonly string[] } | undefined;
  readonly fetch?: typeof globalThis.fetch; readonly newKey?: () => string; readonly newCaseId?: () => string; readonly newDepositId?: () => string;
}): SettlementSession {
  const named = input.viewer?.userId !== undefined;
  const held = new Set(input.viewer?.permissions ?? []);
  const may = {
    named, read: named && held.has('settlement.review.read'), import: named && held.has('settlement.batch.import'), investigate: named && held.has('settlement.investigation.manage'),
    disputes: named && held.has('payment.dispute.read'), recordDispute: named && held.has('payment.dispute.record'),
  };
  const call = makeCaller({ keyPrefix: 'settlement', ...(input.fetch === undefined ? {} : { fetch: input.fetch }), ...(input.newKey === undefined ? {} : { newKey: input.newKey }) });
  const caseId = input.newCaseId ?? (() => newId('inv'));
  const depositId = input.newDepositId ?? (() => newId('dep'));
  const no = (why: Why): { result: 'invalid'; why: Why } => ({ result: 'invalid', why });
  const gate = (need: Exclude<keyof typeof may, 'named'>, why: Why) => (!named ? no('nobody') : !may[need] ? no(why) : undefined);
  return {
    may,
    importBatch: async (text, sourceName) => {
      const g = gate('import', 'cannotImport'); if (g) return g;
      if (text.trim() === '') return no('needBatch');
      let batch: unknown;
      try { batch = JSON.parse(text); } catch { return no('badBatch'); }
      if (batch === null || typeof batch !== 'object' || Array.isArray(batch)) return no('badBatch');
      return call('POST', '/v1/settlement/batches', { ...(batch as Record<string, unknown>), ...(sourceName.trim() === '' ? {} : { sourceName: sourceName.trim() }) });
    },
    importStatement: async (f) => {
      const g = gate('import', 'cannotImport'); if (g) return g;
      const opening = signedPaiseOf(f.openingRupees); const closing = signedPaiseOf(f.closingRupees);
      if (f.statementId.trim() === '' || f.accountRef.trim() === '' || !day(f.fromDate) || !day(f.toDate) || opening === null || closing === null || f.csv.trim() === '') return no('needStatement');
      return call('POST', '/v1/finance/bank-statements', {
        statementId: f.statementId.trim(), accountRef: f.accountRef.trim(), fromDate: f.fromDate.trim(), toDate: f.toDate.trim(), openingMinor: opening, closingMinor: closing, csv: f.csv,
        ...(f.sourceName.trim() === '' ? {} : { sourceName: f.sourceName.trim() }),
      });
    },
    statements: async () => gate('read', 'cannotRead') ?? call('GET', '/v1/finance/bank-statements'),
    deposits: async () => gate('read', 'cannotRead') ?? call('GET', '/v1/finance/cash-deposits'),
    recordDeposit: async (f) => {
      const g = gate('import', 'cannotImport'); if (g) return g;
      const amountMinor = signedPaiseOf(f.amountRupees);
      if (!day(f.depositedOn) || amountMinor === null || amountMinor <= 0 || f.slipRef.trim() === '' || f.accountRef.trim() === '') return no('needDeposit');
      return call('POST', `/v1/finance/cash-deposits/${encodeURIComponent(depositId())}`, {
        depositedOn: f.depositedOn.trim(), amountMinor, slipRef: f.slipRef.trim(), accountRef: f.accountRef.trim(), ...(f.note.trim() === '' ? {} : { note: f.note.trim() }),
      });
    },
    cancelDeposit: async (id, reason) => {
      const g = gate('import', 'cannotImport'); if (g) return g;
      if (reason.trim() === '') return no('needReason');
      return call('POST', `/v1/finance/cash-deposits/${seg(id)}/cancel`, { reason: reason.trim() });
    },
    review: async (asOf, cycleDays) => {
      const g = gate('read', 'cannotRead'); if (g) return g;
      if (!day(asOf) || !/^\d+$/.test(cycleDays.trim())) return no('needReview');
      return call('GET', `/v1/settlement/review?date=${asOf.trim()}&cycleDays=${cycleDays.trim()}`);
    },
    cases: async (asOf) => {
      const g = gate('read', 'cannotRead'); if (g) return g;
      if (!day(asOf)) return no('needReview');
      return call('GET', `/v1/settlement/investigations?date=${asOf.trim()}`);
    },
    // The exception is sent exactly as head office's review gave it — never rebuilt or retyped here.
    openCase: async (e, ownerId, dueBy) => {
      const g = gate('investigate', 'cannotInvestigate'); if (g) return g;
      if (ownerId.trim() === '' || !day(dueBy)) return no('needCase');
      return call('POST', '/v1/settlement/investigations', { investigationId: caseId(), exception: e, ownerId: ownerId.trim(), dueBy: dueBy.trim() });
    },
    addEvidence: async (id, ref) => {
      const g = gate('investigate', 'cannotInvestigate'); if (g) return g;
      if (ref.trim() === '') return no('needEvidence');
      return call('POST', `/v1/settlement/investigations/${seg(id)}/evidence`, { ref: ref.trim() });
    },
    resolve: async (id, outcome, note) => {
      const g = gate('investigate', 'cannotInvestigate'); if (g) return g;
      if (!(INVESTIGATION_OUTCOMES as readonly string[]).includes(outcome) || note.trim() === '') return no('needResolve');
      return call('POST', `/v1/settlement/investigations/${seg(id)}/resolve`, { outcome, note: note.trim() });
    },
    disputes: async (asOf) => {
      const g = gate('disputes', 'cannotDisputes'); if (g) return g;
      return call('GET', `/v1/finance/payment-disputes${day(asOf) ? `?asOf=${asOf.trim()}` : ''}`);
    },
    recordDispute: async (f) => {
      const g = gate('recordDispute', 'cannotRecordDispute'); if (g) return g;
      const amountMinor = signedPaiseOf(f.amountRupees);
      const card = f.instrument === 'card';
      if (f.disputeId.trim() === '' || (f.instrument !== 'upi' && !card) || f.providerRef.trim() === '' || amountMinor === null || amountMinor <= 0 || !day(f.receivedOn)
        || f.reason.trim() === '' || (card && !day(f.respondBy))) return no('needDispute');
      return call('POST', `/v1/finance/payment-disputes/${seg(f.disputeId)}`, {
        instrument: f.instrument, providerRef: f.providerRef.trim(), amountMinor, receivedOn: f.receivedOn.trim(), reason: f.reason.trim(),
        ...(card ? { respondBy: f.respondBy.trim() } : {}), ...(f.saleId.trim() === '' ? {} : { saleId: f.saleId.trim() }),
      });
    },
    answer: async (id, respondedOn, evidenceRef) => {
      const g = gate('recordDispute', 'cannotRecordDispute'); if (g) return g;
      if (!day(respondedOn) || evidenceRef.trim() === '') return no('needAnswer');
      return call('POST', `/v1/finance/payment-disputes/${seg(id)}/response`, { respondedOn: respondedOn.trim(), evidenceRef: evidenceRef.trim() });
    },
    decide: async (id, outcome, decidedOn) => {
      const g = gate('recordDispute', 'cannotRecordDispute'); if (g) return g;
      if (!day(decidedOn)) return no('needDecision');
      return call('POST', `/v1/finance/payment-disputes/${seg(id)}/outcome`, { outcome, decidedOn: decidedOn.trim() });
    },
  };
}
