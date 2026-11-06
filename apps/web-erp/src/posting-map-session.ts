// Accounts and Tally names (Round 4d · M23-FR-01 · AVR-09 · Screen D "posting map and Tally ledger names") — a tested,
// DOM-free session over the two maps head office already keeps, which no screen reached: without them the Day book, the
// Tally files, the month-end adjustment and Supplier offer funding all stop at "the posting map is not defined".
//   • the POSTING MAP — `GET /v1/finance/posting-map`: the rules in force (which account each figure of each kind of posting
//     goes to), the suggested starting map, the kinds other engines post that wait for a rule with no account suggested,
//     and every version (who, when, why, what changed). `PUT` saves the whole map as the next version.
//   • the TALLY NAMES — `GET /v1/finance/tally/ledger-names`: the Tally company and, for each of our account codes, its
//     Tally ledger name; the voucher type per family; every version. `POST` saves the next version.
// Both are versioned and append-only (an earlier version stays on the record), audited by head office, and sent with the
// version they were edited from (`basedOn`): a version saved by somebody else meanwhile is refused by name (hard rule 10).
// Which account is the accountant's decision (P-05): nothing here fills an account the accountant did not choose; a kind
// with no suggestion starts blank. Reading needs `finance.period.read`; saving `finance.posting.configure` (the accountant,
// the owner) — head office re-checks each. Head office's own sentences stay in English (OB-553); every word here has Tamil.

import { makeCaller, outcomeIn, type Outcome } from './r4-insight-call';

export type Lang = 'en' | 'ta';
export type Side = 'debit' | 'credit';
export interface Leg { readonly account: string; readonly side: Side; readonly component: string }
export interface Rule { readonly kind: string; readonly legs: readonly Leg[] }

/** One kind of posting as the screen lists it. `state`: in force · only suggested · waiting for a rule with nothing suggested. */
export interface KindRow {
  readonly kind: string;
  readonly state: 'in_force' | 'suggested' | 'to_map';
  /** The legs the editor starts from: the rule in force, else the suggestion, else one debit and one credit with no account. */
  readonly legs: readonly Leg[];
  readonly inForce: readonly Leg[] | null;
  readonly suggested: readonly Leg[] | null;
}
export interface MapVersion { readonly version: number; readonly definedBy: string; readonly definedAt: string; readonly note?: string; readonly rules: number; readonly added: readonly string[]; readonly changed: readonly string[]; readonly dropped: readonly string[] }
export interface NamesVersion { readonly version: number; readonly setBy: string; readonly setAt: string; readonly note?: string; readonly companyName: string; readonly accounts: number; readonly added: readonly string[]; readonly renamed: readonly string[]; readonly dropped: readonly string[] }
export interface TallyNames { readonly companyName: string; readonly names: Readonly<Record<string, string>>; readonly voucherTypes: Readonly<Record<string, string>>; readonly version: number; readonly setBy: string; readonly setAt: string }
export interface AccountRow { readonly account: string; readonly tallyName: string | null; readonly kinds: readonly string[] }

export interface PostingSetup {
  /** The version in force (0 when none is defined yet), who defined it and when. */
  readonly mapVersion: number;
  readonly mapBy: string | null;
  readonly mapAt: string | null;
  readonly rows: readonly KindRow[];
  readonly mapHistory: readonly MapVersion[];
  readonly names: TallyNames | null;
  readonly namesHistory: readonly NamesVersion[];
  readonly families: readonly { readonly family: string; readonly words: { readonly en: string; readonly ta: string } }[];
  /** Every account the map IN FORCE posts to, with its Tally name (null: not named — the Tally file holds its vouchers back). */
  readonly accounts: readonly AccountRow[];
  readonly asAt: string;
}

const isObj = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === 'object' && !Array.isArray(v);
const str = (v: unknown): string => (typeof v === 'string' ? v : '');
const strs = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : []);

function legsOf(v: unknown): Leg[] {
  return Array.isArray(v) ? v.flatMap((l): Leg[] => (isObj(l) && (l['side'] === 'debit' || l['side'] === 'credit')
    ? [{ account: str(l['account']), side: l['side'], component: str(l['component']) }] : [])) : [];
}
function rulesOf(v: unknown): Rule[] {
  const rules = isObj(v) ? v['rules'] : undefined;
  return Array.isArray(rules) ? rules.flatMap((r): Rule[] => (isObj(r) && typeof r['kind'] === 'string' ? [{ kind: r['kind'], legs: legsOf(r['legs']) }] : [])) : [];
}

/** The kinds in one list: in force first (in the map's order), then suggested-only, then those waiting with nothing suggested. */
export function kindRows(inForce: readonly Rule[], suggested: readonly Rule[], toMap: readonly { readonly kind: string; readonly components: readonly string[]; readonly legs?: readonly { readonly side: Side; readonly component: string }[] }[]): KindRow[] {
  const forced = new Map(inForce.map((r) => [r.kind, r.legs]));
  const sugg = new Map(suggested.map((r) => [r.kind, r.legs]));
  const out: KindRow[] = inForce.map((r) => ({ kind: r.kind, state: 'in_force', legs: r.legs, inForce: r.legs, suggested: sugg.get(r.kind) ?? null }));
  for (const r of suggested) if (!forced.has(r.kind)) out.push({ kind: r.kind, state: 'suggested', legs: r.legs, inForce: null, suggested: r.legs });
  for (const t of toMap) {
    if (forced.has(t.kind) || sugg.has(t.kind)) continue;
    const component = t.components[0] ?? 'amount';
    const legs: Leg[] = t.legs !== undefined && t.legs.length > 0 ? t.legs.map((l) => ({ account: '', side: l.side, component: l.component }))
      : [{ account: '', side: 'debit', component }, { account: '', side: 'credit', component }];
    out.push({ kind: t.kind, state: 'to_map', legs, inForce: null, suggested: null });
  }
  return out;
}

/** Every account the rules post to, in first-use order, with the kinds that use it and its Tally name. */
export function accountRows(rules: readonly Rule[], names: Readonly<Record<string, string>> | undefined): AccountRow[] {
  const kinds = new Map<string, string[]>();
  for (const r of rules) for (const l of r.legs) { const k = kinds.get(l.account) ?? []; if (!k.includes(r.kind)) k.push(r.kind); kinds.set(l.account, k); }
  return [...kinds.entries()].map(([account, ks]) => ({ account, tallyName: names?.[account] ?? null, kinds: ks }));
}

/**
 * The map to save: the rules in force with the screen's changes laid over them (`changes`: a kind → its legs, or `null` to
 * leave the kind out). A new kind is added at the end. What is missing is said by name, before anything is sent.
 */
export function mapToSave(inForce: readonly Rule[], changes: ReadonlyMap<string, readonly Leg[] | null>): { readonly ok: true; readonly rules: readonly Rule[] } | { readonly ok: false; readonly why: 'noChange' | 'blankAccount' | 'needBothSides' | 'empty'; readonly kind?: string } {
  if (changes.size === 0) return { ok: false, why: 'noChange' };
  const rules: Rule[] = [];
  for (const r of inForce) {
    if (!changes.has(r.kind)) { rules.push(r); continue; }
    const legs = changes.get(r.kind);
    if (legs !== null && legs !== undefined) rules.push({ kind: r.kind, legs });
  }
  for (const [kind, legs] of changes) if (legs !== null && !inForce.some((r) => r.kind === kind)) rules.push({ kind, legs });
  if (rules.length === 0) return { ok: false, why: 'empty' };
  for (const r of rules) {
    if (r.legs.some((l) => l.account.trim() === '')) return { ok: false, why: 'blankAccount', kind: r.kind };
    if (!r.legs.some((l) => l.side === 'debit') || !r.legs.some((l) => l.side === 'credit')) return { ok: false, why: 'needBothSides', kind: r.kind };
  }
  return { ok: true, rules: rules.map((r) => ({ kind: r.kind, legs: r.legs.map((l) => ({ account: l.account.trim(), side: l.side, component: l.component })) })) };
}

const TENDERS: Record<string, { en: string; ta: string }> = {
  cash: { en: 'cash', ta: 'ரொக்கம்' }, card: { en: 'card', ta: 'அட்டை' }, upi: { en: 'UPI', ta: 'UPI' }, store_credit: { en: 'store credit', ta: 'கடை வரவு' },
  exchange_credit: { en: 'exchange credit', ta: 'மாற்று வரவு' }, loyalty_points: { en: 'loyalty points', ta: 'விசுவாசப் புள்ளிகள்' },
  online_prepaid: { en: 'online prepayment', ta: 'இணைய முன்பணம்' }, cod_due: { en: 'cash on delivery still owed', ta: 'டெலிவரியில் செலுத்த வேண்டியது' },
  paid_on_old_erp: { en: 'paid on the old billing system', ta: 'பழைய பில்லிங் அமைப்பில் செலுத்தியது' },
};

/** What each kind of posting is, in plain words, and the page it comes from. A kind not listed is shown as its own name. */
const KIND_WORDS: Record<string, { en: string; ta: string }> = {
  sale: { en: 'A day\'s till sales (Day book)', ta: 'ஒரு நாளின் கல்லா விற்பனை (நாள் புத்தகம்)' },
  sale_return: { en: 'A day\'s sales returns (Day book)', ta: 'ஒரு நாளின் விற்பனைத் திருப்பம் (நாள் புத்தகம்)' },
  'loyalty:earn': { en: 'Loyalty points earned (Day book)', ta: 'பெற்ற விசுவாசப் புள்ளிகள் (நாள் புத்தகம்)' },
  'loyalty:takeback': { en: 'Loyalty points taken back on a return (Day book)', ta: 'திருப்பத்தில் திரும்பப் பெற்ற புள்ளிகள் (நாள் புத்தகம்)' },
  'b2b:invoice': { en: 'A business customer\'s tax invoice', ta: 'வணிக வாடிக்கையாளரின் வரி விலைப்பட்டியல்' },
  'b2b:receipt': { en: 'Money received from a business customer', ta: 'வணிக வாடிக்கையாளரிடமிருந்து பெற்ற பணம்' },
  // M23-FR-02 · OB-678: a GST credit note / debit note to a business customer — which accounts is the accountant's rule (C-01).
  'b2b:credit_note': { en: 'A credit note to a business customer', ta: 'வணிக வாடிக்கையாளருக்கான வரவுக் குறிப்பு' },
  'b2b:debit_note': { en: 'A debit note to a business customer', ta: 'வணிக வாடிக்கையாளருக்கான பற்றுக் குறிப்பு' },
  'stock_loss:floor_indent': { en: 'Stock lost on a shelf refill', ta: 'அலமாரி நிரப்புதலில் இழந்த சரக்கு' },
  'stock_loss:transfer': { en: 'Stock lost in a transfer', ta: 'இடமாற்றத்தில் இழந்த சரக்கு' },
  'stock_count:shortage': { en: 'A stock count shortage', ta: 'சரக்கு எண்ணிக்கையில் குறைவு' },
  'stock_count:surplus': { en: 'A stock count surplus', ta: 'சரக்கு எண்ணிக்கையில் அதிகம்' },
  stock_write_off: { en: 'A stock write-off', ta: 'சரக்கு தள்ளுபடி' },
  stock_period_adjustment: { en: 'The month-end stock adjustment (cost of goods sold)', ta: 'மாத இறுதி சரக்கு சரிசெய்தல் (விற்ற பொருளின் அடக்கவிலை)' },
  'fixed_asset:acquisition': { en: 'A fixed asset bought', ta: 'வாங்கிய நிலையான சொத்து' },
  'fixed_asset:depreciation': { en: 'A month\'s depreciation', ta: 'ஒரு மாதத் தேய்மானம்' },
  'fixed_asset:disposal': { en: 'A fixed asset sold or scrapped', ta: 'விற்ற அல்லது அகற்றிய நிலையான சொத்து' },
  supplier_invoice: { en: 'A matched supplier bill', ta: 'பொருந்திய சப்ளையர் பில்' },
  supplier_invoice_reversal: { en: 'A supplier bill taken back', ta: 'திரும்பப் பெற்ற சப்ளையர் பில்' },
  supplier_debit_note: { en: 'A debit note to a supplier', ta: 'சப்ளையருக்குப் பற்றுக் குறிப்பு' },
  supplier_payment: { en: 'A payment to a supplier', ta: 'சப்ளையருக்குச் செலுத்தியது' },
  display_funding: { en: 'Supplier display money received', ta: 'சப்ளையர் காட்சிப் பணம் பெற்றது' },
  promotion_funding: { en: 'Supplier offer funding received (Supplier offer funding)', ta: 'சப்ளையர் சலுகை நிதி பெற்றது (சப்ளையர் சலுகை நிதி)' },
  supplier_rebate: { en: 'A supplier rebate received', ta: 'பெற்ற சப்ளையர் தள்ளுபடி' },
  supplier_rebate_accrual: { en: 'A supplier rebate earned, not yet paid', ta: 'ஈட்டிய, இன்னும் பெறாத சப்ளையர் தள்ளுபடி' },
  supplier_advance: { en: 'Money paid to a supplier before the bill', ta: 'பில்லுக்கு முன் சப்ளையருக்குச் செலுத்திய பணம்' },
  supplier_advance_applied: { en: 'A supplier advance used against a bill', ta: 'பில்லுக்கு எதிராகப் பயன்படுத்திய முன்பணம்' },
  concession_settlement: { en: 'A concession counter\'s period settled (Concessions)', ta: 'சலுகைக் கவுண்டரின் காலத் தீர்வு (சலுகைகள்)' },
};

/** The plain name of a kind of posting in a language (a tender's takings and refunds by the tender's own name). */
export function kindWords(lang: Lang, kind: string): string {
  const known = KIND_WORDS[kind]; if (known) return known[lang];
  const [head, tail] = kind.split(':');
  const tender = tail === undefined ? undefined : TENDERS[tail];
  if (tender && head === 'tender') return lang === 'en' ? `Takings in ${tender.en} (Day book)` : `${tender.ta} வசூல் (நாள் புத்தகம்)`;
  if (tender && head === 'refund') return lang === 'en' ? `Refunds in ${tender.en} (Day book)` : `${tender.ta} பணத்திருப்பம் (நாள் புத்தகம்)`;
  return kind;
}

const COMPONENT_WORDS: Record<string, { en: string; ta: string }> = {
  total: { en: 'the bill total', ta: 'பில் மொத்தம்' }, net: { en: 'the value before GST', ta: 'ஜிஎஸ்டிக்கு முந்தைய மதிப்பு' },
  taxable: { en: 'the value before GST', ta: 'ஜிஎஸ்டிக்கு முந்தைய மதிப்பு' }, tax: { en: 'the GST', ta: 'ஜிஎஸ்டி' },
  cgst: { en: 'CGST', ta: 'CGST' }, sgst: { en: 'SGST', ta: 'SGST' }, igst: { en: 'IGST', ta: 'IGST' }, cess: { en: 'cess', ta: 'செஸ்' },
  amount: { en: 'the amount', ta: 'தொகை' }, payable: { en: 'what is owed to the supplier', ta: 'சப்ளையருக்குச் செலுத்த வேண்டியது' },
  round_off_up: { en: 'rounding up', ta: 'மேல் முழுமையாக்கல்' }, round_off_down: { en: 'rounding down', ta: 'கீழ் முழுமையாக்கல்' },
  cost: { en: 'the cost', ta: 'அடக்கவிலை' }, cost_of_sales: { en: 'the cost of goods sold', ta: 'விற்ற பொருளின் அடக்கவிலை' },
  increase: { en: 'stock value up', ta: 'சரக்கு மதிப்பு உயர்வு' }, decrease: { en: 'stock value down', ta: 'சரக்கு மதிப்பு குறைவு' },
  purchases: { en: 'the month\'s purchases', ta: 'மாதக் கொள்முதல்' }, accumulated: { en: 'depreciation so far', ta: 'இதுவரை தேய்மானம்' },
  proceeds: { en: 'what it fetched', ta: 'கிடைத்த தொகை' }, loss: { en: 'the loss', ta: 'நட்டம்' }, gain: { en: 'the gain', ta: 'லாபம்' },
  collected: { en: 'what the tills held for them', ta: 'கல்லாக்கள் அவர்களுக்காக வைத்திருந்தது' }, receivable: { en: 'what they owe the shop', ta: 'அவர்கள் கடைக்குச் செலுத்த வேண்டியது' },
  charge: { en: 'the rent or revenue share', ta: 'வாடகை அல்லது வருவாய்ப் பங்கு' }, utilities: { en: 'utilities recovered', ta: 'மீட்ட பயன்பாட்டுக் கட்டணம்' },
};
export const componentWords = (lang: Lang, c: string): string => COMPONENT_WORDS[c]?.[lang] ?? c;

export const POSTING_MAP_COPY = {
  en: {
    title: 'Accounts and Tally names',
    lead: 'Which account each kind of posting goes to, and what each account is called in Tally. The Day book, the Tally files, the month-end adjustment and Supplier offer funding post nothing until these are set. Which account is the accountant\'s decision: nothing is filled in for you. Every save is a new version; the earlier one stays on the record.',
    primary: 'Save the posting map',
    cardVersion: 'Posting map in force', cardKinds: 'Kinds with a rule', cardWaiting: 'Kinds waiting for a rule', cardUnnamed: 'Accounts with no Tally name', cardNames: 'Tally names in force',
    noteVersion: 'version', noteNone: 'none defined yet', noteWaiting: 'these post nothing until mapped', noteUnnamed: 'the Tally file holds their vouchers back',
    mapH: 'Posting map', mapRegister: 'Kinds of posting',
    colWhat: 'What it is', colKind: 'Kind', colState: 'State', colDebit: 'Debit account', colCredit: 'Credit account',
    in_force: 'in force', suggested: 'suggested only — not in force', to_map: 'waiting for a rule — nothing suggested', changed: 'changed — not saved yet', leftOut: 'to be left out — not saved yet',
    legsH: 'Accounts for each figure', suggestion: 'Suggested', debit: 'Debit', credit: 'Credit', account: 'Account', figure: 'Figure',
    keep: 'Keep these accounts in the change', useSuggested: 'Start from the suggestion', leaveOut: 'Leave this kind out of the map', undo: 'Undo my change to this kind',
    draftH: 'Your change', draftNone: 'Nothing changed yet. Open a kind, set its accounts and keep them.', draftCount: 'kinds changed', note: 'What the change is for', save: 'Save the posting map',
    adoptAll: 'Put every suggested rule in the change', adopted: 'suggested rules put in the change — look at each before you save.',
    saved: 'Saved as version', changedSince: 'Somebody saved a newer version. Read again, then make your change on it.',
    noChange: 'Nothing has changed yet.', blankAccount: 'Every figure needs an account. Missing in:', needBothSides: 'A rule needs at least one debit and one credit:', empty: 'A posting map needs at least one rule.',
    namesH: 'Tally names', namesRegister: 'Accounts the map posts to', colAccount: 'Account', colTally: 'Tally ledger name', colUsedBy: 'Used by',
    notNamed: 'not named', company: 'Tally company name', tallyName: 'Tally ledger name', voucherH: 'Voucher type in Tally for each family (leave blank for "Journal")',
    saveNames: 'Save the Tally names', namesSaved: 'Tally names saved as version', namesChangedSince: 'Somebody saved newer Tally names. Read again, then make your change on them.',
    needCompany: 'Type the Tally company name.', needName: 'Name at least one account.', namesNone: 'No account to name yet — the posting map in force posts to none.',
    historyH: 'Every version', mapHistoryH: 'Posting map versions', namesHistoryH: 'Tally names versions', historyNone: 'No version saved yet.',
    by: 'by', at: 'on', added: 'added', changedKinds: 'changed', dropped: 'left out', renamed: 'renamed', rules: 'rules', accounts: 'accounts',
    emptyTitle: 'No kind of posting to show', emptyDetail: 'Head office answered with no kind at all. This is not a sign the accounts are set.',
    nobody: 'Nobody is signed in on this screen.', cannotRead: 'Your role cannot see the accounts set-up.', cannotConfigure: 'You can see the accounts set-up; changing it needs the accountant\'s permission.',
    refused: 'Head office refused:', unreachable: 'Head office cannot be reached — nothing was read or saved.', reading: 'Reading from head office…', saving: 'Saving…',
  },
  ta: {
    title: 'கணக்குகளும் டேலி பெயர்களும்',
    lead: 'ஒவ்வொரு வகைப் பதிவும் எந்தக் கணக்கிற்குச் செல்கிறது, ஒவ்வொரு கணக்கும் டேலியில் என்ன பெயர். இவை அமைக்கப்படும் வரை நாள் புத்தகம், டேலி கோப்புகள், மாத இறுதி சரிசெய்தல், சப்ளையர் சலுகை நிதி எதையும் பதியாது. எந்தக் கணக்கு என்பது கணக்காளரின் முடிவு: உங்களுக்காக எதுவும் நிரப்பப்படாது. ஒவ்வொரு சேமிப்பும் புதிய பதிப்பு; முந்தையது பதிவில் இருக்கும்.',
    primary: 'பதிவு வரைபடத்தைச் சேமி',
    cardVersion: 'நடைமுறையில் உள்ள பதிவு வரைபடம்', cardKinds: 'விதியுள்ள வகைகள்', cardWaiting: 'விதிக்குக் காத்திருக்கும் வகைகள்', cardUnnamed: 'டேலி பெயர் இல்லாத கணக்குகள்', cardNames: 'நடைமுறையில் உள்ள டேலி பெயர்கள்',
    noteVersion: 'பதிப்பு', noteNone: 'இன்னும் வரையறுக்கப்படவில்லை', noteWaiting: 'வரைபடம் வரும் வரை இவை எதையும் பதியாது', noteUnnamed: 'டேலி கோப்பு இவற்றின் வவுச்சர்களை நிறுத்தி வைக்கும்',
    mapH: 'பதிவு வரைபடம்', mapRegister: 'பதிவு வகைகள்',
    colWhat: 'இது என்ன', colKind: 'வகை', colState: 'நிலை', colDebit: 'பற்றுக் கணக்கு', colCredit: 'வரவுக் கணக்கு',
    in_force: 'நடைமுறையில்', suggested: 'பரிந்துரை மட்டும் — நடைமுறையில் இல்லை', to_map: 'விதிக்குக் காத்திருக்கிறது — பரிந்துரை இல்லை', changed: 'மாற்றப்பட்டது — இன்னும் சேமிக்கவில்லை', leftOut: 'விலக்கப்படும் — இன்னும் சேமிக்கவில்லை',
    legsH: 'ஒவ்வொரு எண்ணுக்கும் கணக்கு', suggestion: 'பரிந்துரை', debit: 'பற்று', credit: 'வரவு', account: 'கணக்கு', figure: 'எண்',
    keep: 'இந்தக் கணக்குகளை மாற்றத்தில் வை', useSuggested: 'பரிந்துரையிலிருந்து தொடங்கு', leaveOut: 'இந்த வகையை வரைபடத்திலிருந்து விலக்கு', undo: 'இந்த வகையில் என் மாற்றத்தைத் திரும்பப் பெறு',
    draftH: 'உங்கள் மாற்றம்', draftNone: 'இன்னும் எதுவும் மாற்றப்படவில்லை. ஒரு வகையைத் திறந்து, கணக்குகளை அமைத்து வையுங்கள்.', draftCount: 'வகைகள் மாற்றப்பட்டன', note: 'மாற்றம் எதற்காக', save: 'பதிவு வரைபடத்தைச் சேமி',
    adoptAll: 'பரிந்துரைத்த எல்லா விதிகளையும் மாற்றத்தில் வை', adopted: 'பரிந்துரைத்த விதிகள் மாற்றத்தில் வைக்கப்பட்டன — சேமிக்கும் முன் ஒவ்வொன்றையும் பாருங்கள்.',
    saved: 'சேமிக்கப்பட்ட பதிப்பு', changedSince: 'வேறொருவர் புதிய பதிப்பைச் சேமித்துள்ளார். மீண்டும் படித்து, அதில் உங்கள் மாற்றத்தைச் செய்யுங்கள்.',
    noChange: 'இன்னும் எதுவும் மாறவில்லை.', blankAccount: 'ஒவ்வொரு எண்ணுக்கும் ஒரு கணக்கு தேவை. இல்லாதது:', needBothSides: 'ஒரு விதிக்குக் குறைந்தது ஒரு பற்றும் ஒரு வரவும் தேவை:', empty: 'பதிவு வரைபடத்திற்குக் குறைந்தது ஒரு விதி தேவை.',
    namesH: 'டேலி பெயர்கள்', namesRegister: 'வரைபடம் பதியும் கணக்குகள்', colAccount: 'கணக்கு', colTally: 'டேலி லெட்ஜர் பெயர்', colUsedBy: 'பயன்படுத்துவது',
    notNamed: 'பெயரிடப்படவில்லை', company: 'டேலி நிறுவனப் பெயர்', tallyName: 'டேலி லெட்ஜர் பெயர்', voucherH: 'ஒவ்வொரு குடும்பத்திற்கும் டேலியில் வவுச்சர் வகை ("Journal" என்றால் காலியாக விடுங்கள்)',
    saveNames: 'டேலி பெயர்களைச் சேமி', namesSaved: 'டேலி பெயர்கள் சேமிக்கப்பட்ட பதிப்பு', namesChangedSince: 'வேறொருவர் புதிய டேலி பெயர்களைச் சேமித்துள்ளார். மீண்டும் படித்து, அதில் உங்கள் மாற்றத்தைச் செய்யுங்கள்.',
    needCompany: 'டேலி நிறுவனப் பெயரைத் தட்டச்சு செய்யுங்கள்.', needName: 'குறைந்தது ஒரு கணக்கிற்குப் பெயரிடுங்கள்.', namesNone: 'பெயரிட இன்னும் கணக்கு இல்லை — நடைமுறை வரைபடம் எந்தக் கணக்கிலும் பதியவில்லை.',
    historyH: 'ஒவ்வொரு பதிப்பும்', mapHistoryH: 'பதிவு வரைபடப் பதிப்புகள்', namesHistoryH: 'டேலி பெயர்ப் பதிப்புகள்', historyNone: 'இன்னும் எந்தப் பதிப்பும் சேமிக்கப்படவில்லை.',
    by: 'செய்தவர்', at: 'அன்று', added: 'சேர்க்கப்பட்டது', changedKinds: 'மாற்றப்பட்டது', dropped: 'விலக்கப்பட்டது', renamed: 'பெயர் மாற்றப்பட்டது', rules: 'விதிகள்', accounts: 'கணக்குகள்',
    emptyTitle: 'காட்ட எந்தப் பதிவு வகையும் இல்லை', emptyDetail: 'தலைமை அலுவலகம் எந்த வகையும் இல்லாமல் பதிலளித்தது. கணக்குகள் அமைக்கப்பட்டன என்பதற்கு இது அடையாளம் அல்ல.',
    nobody: 'இந்தத் திரையில் யாரும் உள்நுழையவில்லை.', cannotRead: 'உங்கள் பங்கு கணக்கு அமைப்பைப் பார்க்க முடியாது.', cannotConfigure: 'கணக்கு அமைப்பைப் பார்க்கலாம்; மாற்ற கணக்காளர் அனுமதி தேவை.',
    refused: 'தலைமை அலுவலகம் மறுத்தது:', unreachable: 'தலைமை அலுவலகத்தை அடைய முடியவில்லை — எதுவும் படிக்கப்படவில்லை, சேமிக்கப்படவில்லை.', reading: 'தலைமை அலுவலகத்திலிருந்து படிக்கிறது…', saving: 'சேமிக்கிறது…',
  },
} as const;

export const postingMapWords = (lang: Lang, key: string): string =>
  (POSTING_MAP_COPY[lang] as Record<string, string>)[key] ?? (POSTING_MAP_COPY.en as Record<string, string>)[key] ?? key;

type Why = 'nobody' | 'cannotRead' | 'cannotConfigure' | 'noChange' | 'blankAccount' | 'needBothSides' | 'empty' | 'needCompany' | 'needName' | 'changedSince' | 'namesChangedSince';
export type PostingOutcome<T> = Outcome<T, Why> & { readonly kind?: string };

/** An outcome in words; a refusal because somebody saved meanwhile is said plainly, and a rule's problem names the kind. */
export function postingMapOutcomeWords(lang: Lang, out: PostingOutcome<unknown>): string {
  const base = outcomeIn((k) => postingMapWords(lang, k), out);
  return out.result === 'invalid' && out.kind !== undefined ? `${base} ${kindWords(lang, out.kind)}` : base;
}

export interface PostingMapSession {
  readonly may: { readonly named: boolean; readonly read: boolean; readonly configure: boolean };
  read(): Promise<PostingOutcome<PostingSetup>>;
  /** Save the map: the rules in force with `changes` laid over them, as the version after `basedOn`. */
  saveMap(input: { readonly basedOn: number; readonly inForce: readonly Rule[]; readonly changes: ReadonlyMap<string, readonly Leg[] | null>; readonly note: string }): Promise<PostingOutcome<{ readonly version: number }>>;
  /** Save the Tally names as the version after `basedOn` (blank names are left out; blank voucher types mean "Journal"). */
  saveNames(input: { readonly basedOn: number; readonly companyName: string; readonly names: Readonly<Record<string, string>>; readonly voucherTypes: Readonly<Record<string, string>>; readonly note: string }): Promise<PostingOutcome<{ readonly version: number }>>;
}

export function createPostingMapSession(input: { readonly viewer: { readonly userId?: string; readonly permissions: readonly string[] } | undefined; readonly fetch?: typeof globalThis.fetch }): PostingMapSession {
  const named = input.viewer?.userId !== undefined;
  const held = new Set(input.viewer?.permissions ?? []);
  const may = { named, read: named && held.has('finance.period.read'), configure: named && held.has('finance.posting.configure') };
  const call = makeCaller({ keyPrefix: 'posting-map', ...(input.fetch === undefined ? {} : { fetch: input.fetch }) });
  const no = (why: Why, kind?: string): PostingOutcome<never> => ({ result: 'invalid', why, ...(kind === undefined ? {} : { kind }) });
  const gate = (need: 'read' | 'configure') => (!named ? no('nobody') : !may[need] ? no(need === 'read' ? 'cannotRead' : 'cannotConfigure') : undefined);
  return {
    may,
    read: async () => {
      const g = gate('read'); if (g) return g;
      const [m, n] = await Promise.all([call<Record<string, unknown>>('GET', '/v1/finance/posting-map'), call<Record<string, unknown>>('GET', '/v1/finance/tally/ledger-names')]);
      if (m.result !== 'ok') return m;
      if (n.result !== 'ok') return n;
      const map = isObj(m.value['map']) ? m.value['map'] : null;
      const inForce = map === null ? [] : rulesOf(map);
      const toMap = (Array.isArray(m.value['toMap']) ? m.value['toMap'] : []).flatMap((t) => (isObj(t) && typeof t['kind'] === 'string' ? [{
        kind: t['kind'], components: strs(t['components']),
        ...(Array.isArray(t['legs']) ? { legs: (t['legs'] as unknown[]).flatMap((l) => (isObj(l) && (l['side'] === 'debit' || l['side'] === 'credit') && typeof l['component'] === 'string' ? [{ side: l['side'] as Side, component: l['component'] }] : [])) } : {}),
      }] : []));
      const rawNames = isObj(n.value['ledgerNames']) ? n.value['ledgerNames'] : null;
      const names: TallyNames | null = rawNames === null ? null : {
        companyName: str(rawNames['companyName']), version: typeof rawNames['version'] === 'number' ? rawNames['version'] : 0, setBy: str(rawNames['setBy']), setAt: str(rawNames['setAt']),
        names: Object.fromEntries(Object.entries(isObj(rawNames['names']) ? rawNames['names'] : {}).filter((e): e is [string, string] => typeof e[1] === 'string')),
        voucherTypes: Object.fromEntries(Object.entries(isObj(rawNames['voucherTypes']) ? rawNames['voucherTypes'] : {}).filter((e): e is [string, string] => typeof e[1] === 'string')),
      };
      const mapHistory = (Array.isArray(m.value['history']) ? m.value['history'] : []).flatMap((h): MapVersion[] => (isObj(h) && typeof h['version'] === 'number' ? [{
        version: h['version'], definedBy: str(h['definedBy']), definedAt: str(h['definedAt']), rules: typeof h['rules'] === 'number' ? h['rules'] : 0,
        added: strs(h['added']), changed: strs(h['changed']), dropped: strs(h['dropped']), ...(typeof h['note'] === 'string' ? { note: h['note'] } : {}),
      }] : []));
      const namesHistory = (Array.isArray(n.value['history']) ? n.value['history'] : []).flatMap((h): NamesVersion[] => (isObj(h) && typeof h['version'] === 'number' ? [{
        version: h['version'], setBy: str(h['setBy']), setAt: str(h['setAt']), companyName: str(h['companyName']), accounts: typeof h['accounts'] === 'number' ? h['accounts'] : 0,
        added: strs(h['added']), renamed: strs(h['renamed']), dropped: strs(h['dropped']), ...(typeof h['note'] === 'string' ? { note: h['note'] } : {}),
      }] : []));
      const families = (Array.isArray(n.value['families']) ? n.value['families'] : []).flatMap((f) => (isObj(f) && typeof f['family'] === 'string' && isObj(f['words'])
        ? [{ family: f['family'], words: { en: str(f['words']['en']), ta: str(f['words']['ta']) } }] : []));
      return {
        result: 'ok',
        value: {
          mapVersion: map === null || typeof map['version'] !== 'number' ? 0 : map['version'],
          mapBy: map === null ? null : str(map['definedBy']), mapAt: map === null ? null : str(map['definedAt']),
          rows: kindRows(inForce, rulesOf(m.value['suggested']), toMap), mapHistory,
          names, namesHistory, families, accounts: accountRows(inForce, names?.names), asAt: str(m.value['asAt']),
        },
      };
    },
    saveMap: async (a) => {
      const g = gate('configure'); if (g) return g;
      const built = mapToSave(a.inForce, a.changes);
      if (!built.ok) return no(built.why, built.kind);
      const out = await call<{ version?: unknown }>('PUT', '/v1/finance/posting-map', { rules: built.rules, basedOn: a.basedOn, ...(a.note.trim() === '' ? {} : { note: a.note.trim() }) });
      if (out.result === 'refused' && out.code === 'posting_map_changed_since') return no('changedSince');
      return out.result === 'ok' ? { result: 'ok', value: { version: typeof out.value.version === 'number' ? out.value.version : a.basedOn + 1 } } : out;
    },
    saveNames: async (a) => {
      const g = gate('configure'); if (g) return g;
      if (a.companyName.trim() === '') return no('needCompany');
      const names = Object.fromEntries(Object.entries(a.names).map(([c, n]) => [c, n.trim()]).filter(([, n]) => n !== ''));
      if (Object.keys(names).length === 0) return no('needName');
      const voucherTypes = Object.fromEntries(Object.entries(a.voucherTypes).map(([f, v]) => [f, v.trim()]).filter(([, v]) => v !== ''));
      const out = await call<{ ledgerNames?: { version?: unknown } }>('POST', '/v1/finance/tally/ledger-names', {
        companyName: a.companyName.trim(), names, basedOn: a.basedOn,
        ...(Object.keys(voucherTypes).length === 0 ? {} : { voucherTypes }), ...(a.note.trim() === '' ? {} : { note: a.note.trim() }),
      });
      if (out.result === 'refused' && out.code === 'tally_names_changed_since') return no('namesChangedSince');
      return out.result === 'ok' ? { result: 'ok', value: { version: typeof out.value.ledgerNames?.version === 'number' ? out.value.ledgerNames.version : a.basedOn + 1 } } : out;
    },
  };
}
