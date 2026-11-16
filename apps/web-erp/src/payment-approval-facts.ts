// A SUPPLIER PAYMENT ON THE APPROVALS PAGE, AS THE APPROVER NEEDS IT — fix batch 5 · daily-work defect D-049 · M23-FR-01 ·
// M06-FR-01 · §28 · P-03 · P-07.
//
// The walkthrough found the payment read "Payment to supplier sup-demo-foods … by bank_transfer … Payment: pay-ae456e6e5c09":
// no supplier name and no word on whether the bills it pays were matched. The approver now sees the supplier by name, and
// each bill the payment names with head office's own match result — matched (and what may be paid on it), matched but held
// back, or not matched yet — read live from head office's account of the supplier (`GET /v1/purchase/suppliers/:supplierId`,
// the same statement Supplier bills reads). Read only: nothing is decided or changed here, and the payment route still
// refuses on record whatever this page shows. Pure apart from the one injected read; DOM-free and tested.

import { makeCaller, type Outcome } from './r4-insight-call';
import { rupees } from './settlement-bank-session';

type Lang = 'en' | 'ta';

export const PAYMENT_FACTS_WORDS = Object.freeze({
  en: Object.freeze({
    supplier: 'Supplier', bills: 'Bills it pays', reading: 'Reading the supplier and the bills from head office…',
    unreachable: 'Head office could not be reached, so the supplier\'s name and the bills\' match results are not known.',
    notReadable: 'The supplier\'s account could not be read, so the bills\' match results are not shown.',
    noBills: 'No bill is named — it is paid against the supplier\'s matched balance.',
    matched: '{bill} — matched; {amount} may be paid', heldBack: '{bill} — matched, but {amount} is held back',
    notMatched: '{bill} — not matched yet; nothing may be paid on it', notTheirs: '{bill} — not a bill of this supplier',
    bankNotChecked: 'This supplier has no checked bank account on record — head office will refuse to record a bank, cheque or UPI payment.',
    onHold: 'This supplier is on hold — head office will refuse to record any payment.',
  }),
  ta: Object.freeze({
    supplier: 'சப்ளையர்', bills: 'இது செலுத்தும் பில்கள்', reading: 'சப்ளையரையும் பில்களையும் தலைமை அலுவலகத்திலிருந்து படிக்கிறது…',
    unreachable: 'தலைமை அலுவலகத்தை அடைய முடியவில்லை, எனவே சப்ளையரின் பெயரும் பில்களின் பொருத்த முடிவுகளும் தெரியவில்லை.',
    notReadable: 'சப்ளையரின் கணக்கைப் படிக்க முடியவில்லை, எனவே பில்களின் பொருத்த முடிவுகள் காட்டப்படவில்லை.',
    noBills: 'எந்த பில்லும் குறிப்பிடப்படவில்லை — சப்ளையரின் பொருத்தப்பட்ட நிலுவைக்கு எதிராகச் செலுத்தப்படுகிறது.',
    matched: '{bill} — பொருத்தப்பட்டது; {amount} செலுத்தலாம்', heldBack: '{bill} — பொருத்தப்பட்டது, ஆனால் {amount} நிறுத்திவைக்கப்பட்டுள்ளது',
    notMatched: '{bill} — இன்னும் பொருத்தப்படவில்லை; இதில் எதுவும் செலுத்த முடியாது', notTheirs: '{bill} — இந்தச் சப்ளையரின் பில் அல்ல',
    bankNotChecked: 'இந்தச் சப்ளையருக்குச் சரிபார்க்கப்பட்ட வங்கிக் கணக்கு பதிவில் இல்லை — வங்கி, காசோலை அல்லது UPI செலுத்தலைப் பதிய தலைமை அலுவலகம் மறுக்கும்.',
    onHold: 'இந்தச் சப்ளையர் நிறுத்திவைப்பில் உள்ளார் — எந்தச் செலுத்தலையும் பதிய தலைமை அலுவலகம் மறுக்கும்.',
  }),
});
type WordKey = keyof typeof PAYMENT_FACTS_WORDS.en;

export type BillMatch = 'matched' | 'held_back' | 'not_matched' | 'not_theirs';
export interface BillFact { readonly invoiceId: string; readonly match: BillMatch; readonly amountMinor: number }
export interface PaymentFacts {
  readonly supplierName: string | null;
  readonly bills: readonly BillFact[];
  readonly onHold: boolean;
  readonly bankChecked: boolean;
}

/** Head office's supplier answer and the bills a payment names → what the approver reads. Pure. */
export function paymentFactsOf(body: unknown, settles: readonly string[]): PaymentFacts {
  const b = (body ?? {}) as Record<string, unknown>;
  const rec = (b['supplier'] ?? null) as Record<string, unknown> | null;
  const supplierName = rec !== null && typeof rec['name'] === 'string' && rec['name'].trim() !== '' ? rec['name'].trim() : null;
  const account = (b['account'] ?? {}) as Record<string, unknown>;
  const invoices = Array.isArray(account['invoices']) ? account['invoices'] as Record<string, unknown>[] : [];
  const byId = new Map(invoices.map((i) => [String(i['invoiceId']), i] as const));
  const num = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) ? v : 0);
  const bills = settles.map((invoiceId): BillFact => {
    const i = byId.get(invoiceId);
    if (i === undefined) return { invoiceId, match: 'not_theirs', amountMinor: 0 };
    if (i['matched'] !== true) return { invoiceId, match: 'not_matched', amountMinor: 0 };
    if (i['blocked'] === true || num(i['withheldMinor']) > 0) return { invoiceId, match: 'held_back', amountMinor: num(i['withheldMinor']) };
    return { invoiceId, match: 'matched', amountMinor: num(i['payableMinor']) };
  });
  return { supplierName, bills, onHold: b['blocked'] === true, bankChecked: b['bank'] !== null && b['bank'] !== undefined };
}

const fill = (s: string, f: Readonly<Record<string, string>>): string => s.replace(/\{(\w+)\}/g, (_, k: string) => f[k] ?? `{${k}}`);
const BILL_WORD: Readonly<Record<BillMatch, WordKey>> = { matched: 'matched', held_back: 'heldBack', not_matched: 'notMatched', not_theirs: 'notTheirs' };

/** The facts as lines, in the reader's language; `method` decides whether a missing bank check matters (cash needs none). Pure. */
export function paymentFactLines(lang: Lang, facts: PaymentFacts, supplierId: string, method: string): readonly { readonly text: string; readonly warn: boolean }[] {
  const w = PAYMENT_FACTS_WORDS[lang];
  const lines: { text: string; warn: boolean }[] = [{ text: `${w.supplier}: ${facts.supplierName === null ? supplierId : `${facts.supplierName} (${supplierId})`}`, warn: false }];
  if (facts.onHold) lines.push({ text: w.onHold, warn: true });
  else if (method !== 'cash' && !facts.bankChecked) lines.push({ text: w.bankNotChecked, warn: true });
  if (facts.bills.length === 0) lines.push({ text: `${w.bills}: ${w.noBills}`, warn: false });
  for (const b of facts.bills) lines.push({ text: fill(w[BILL_WORD[b.match]], { bill: b.invoiceId, amount: rupees(b.amountMinor) }), warn: b.match !== 'matched' });
  return lines;
}

export interface PaymentFactsReader {
  /** Read the supplier's account once and return the facts for a payment naming these bills. */
  read(supplierId: string, settles: readonly string[]): Promise<Outcome<PaymentFacts>>;
  readonly words: typeof PAYMENT_FACTS_WORDS;
  readonly lines: typeof paymentFactLines;
}

export function createPaymentFactsReader(input: { readonly fetch?: typeof globalThis.fetch } = {}): PaymentFactsReader {
  const call = makeCaller({ keyPrefix: 'payment-facts', ...(input.fetch === undefined ? {} : { fetch: input.fetch }) });
  return {
    read: async (supplierId, settles) => {
      const out = await call<unknown>('GET', `/v1/purchase/suppliers/${encodeURIComponent(supplierId.trim())}`);
      return out.result === 'ok' ? { result: 'ok', value: paymentFactsOf(out.value, settles) } : out;
    },
    words: PAYMENT_FACTS_WORDS,
    lines: paymentFactLines,
  };
}
