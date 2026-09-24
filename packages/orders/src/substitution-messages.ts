// Bilingual customer message for a substitution (M19-FR-01, P-07 / roadmap §19). The store is in Tamil
// Nadu and Tamil is a first language for its customers, not a translation afterthought — a substitution
// the customer only half-understands is exactly where trust is lost. The substitution engines already
// produce the ENGLISH `tellTheCustomer` sentence; this renders the same outcome in English OR Tamil, so
// the notification the customer receives (through the M31 queue) speaks their language.
//
// Pure and deterministic — a decision plus a language in, a sentence out. It prices nothing (the amount
// is already decided by the money engine) and sends nothing (the M31 queue is a separate wiring slice;
// the live SMS/push transport is a separate A01 gate). Money is shown as rupees from paise.

/** The two languages the product ships in (mirrors `packages/ui` `Lang`; kept local so the orders domain
 *  does not depend on the presentation layer). */
export type Lang = 'en' | 'ta';

export interface SubstitutionMessageInput {
  readonly orderedName: string;
  /** The substitute actually picked — present only when the line was substituted. */
  readonly substituteName?: string;
  readonly outcome: 'substituted' | 'short_picked' | 'not_confirmed';
  /** The tender-aware settlement, when the money engine produced one. */
  readonly settlementKind?: 'none' | 'prepaid_refund' | 'prepaid_additional_charge' | 'collect_less' | 'collect_more';
  readonly settlementMinor?: number;
  /** True when a dearer substitute was charged above the original price under explicit approval. */
  readonly aboveCap?: boolean;
}

/** The distinct customer situations a substitution can leave — the key a message is chosen by. */
export type SubstitutionMessageKind =
  | 'not_available' // not substituted: left out, not charged
  | 'swapped_refund' // cheaper, prepaid: refunded the difference
  | 'swapped_collect_less' // cheaper, COD/pay-at-store: pay less
  | 'swapped_dearer_approved' // dearer, explicitly approved: charged/collect more
  | 'swapped_same_price'; // same price, or dearer capped at the original

const rupees = (minor: number): string => `₹${(minor / 100).toFixed(2)}`;

/** The bilingual template for each situation. Both languages are required for every kind (a customer
 *  must never get a blank), which `substitutionMessageKinds` + the tests assert. */
const TEMPLATES: Readonly<Record<SubstitutionMessageKind, { readonly en: (i: SubstitutionMessageInput) => string; readonly ta: (i: SubstitutionMessageInput) => string }>> = {
  not_available: {
    en: (i) => `We could not supply ${i.orderedName}, so it has been left out of your order and you have not been charged for it.`,
    ta: (i) => `${i.orderedName} எங்களிடம் கிடைக்கவில்லை, எனவே அதை உங்கள் ஆர்டரில் இருந்து விட்டுவிட்டோம்; அதற்கு உங்களிடம் கட்டணம் வசூலிக்கப்படவில்லை.`,
  },
  swapped_refund: {
    en: (i) => `We swapped ${i.orderedName} for ${i.substituteName}. It is cheaper, so we have refunded ${rupees(i.settlementMinor ?? 0)}.`,
    ta: (i) => `${i.orderedName} க்குப் பதிலாக ${i.substituteName} கொடுத்துள்ளோம். இது மலிவானது, எனவே ${rupees(i.settlementMinor ?? 0)} திரும்பச் செலுத்திவிட்டோம்.`,
  },
  swapped_collect_less: {
    en: (i) => `We swapped ${i.orderedName} for ${i.substituteName}. It is cheaper, so you will pay ${rupees(i.settlementMinor ?? 0)} less.`,
    ta: (i) => `${i.orderedName} க்குப் பதிலாக ${i.substituteName} கொடுத்துள்ளோம். இது மலிவானது, எனவே நீங்கள் ${rupees(i.settlementMinor ?? 0)} குறைவாகச் செலுத்தினால் போதும்.`,
  },
  swapped_dearer_approved: {
    en: (i) => `As you approved, we swapped ${i.orderedName} for ${i.substituteName}. It costs ${rupees(i.settlementMinor ?? 0)} more.`,
    ta: (i) => `நீங்கள் ஒப்புக்கொண்டபடி, ${i.orderedName} க்குப் பதிலாக ${i.substituteName} கொடுத்துள்ளோம். இதற்கு ${rupees(i.settlementMinor ?? 0)} கூடுதலாகும்.`,
  },
  swapped_same_price: {
    en: (i) => `We swapped ${i.orderedName} for ${i.substituteName}. You pay no more than the original price.`,
    ta: (i) => `${i.orderedName} க்குப் பதிலாக ${i.substituteName} கொடுத்துள்ளோம். அசல் விலையை விட அதிகம் நீங்கள் செலுத்த மாட்டீர்கள்.`,
  },
};

/** Every message kind — for the completeness check and tests. */
export const substitutionMessageKinds: readonly SubstitutionMessageKind[] = Object.keys(TEMPLATES) as SubstitutionMessageKind[];

/** Choose the situation a substitution outcome leaves the customer in. */
export function substitutionMessageKind(i: SubstitutionMessageInput): SubstitutionMessageKind {
  if (i.outcome !== 'substituted') return 'not_available';
  if (i.aboveCap === true) return 'swapped_dearer_approved';
  if (i.settlementKind === 'prepaid_refund' && (i.settlementMinor ?? 0) > 0) return 'swapped_refund';
  if (i.settlementKind === 'collect_less' && (i.settlementMinor ?? 0) > 0) return 'swapped_collect_less';
  return 'swapped_same_price';
}

/**
 * Render the customer-facing message for a substitution outcome in the requested language.
 *
 * English is the fallback: if a Tamil template were ever missing it returns English rather than a blank,
 * the same rule `packages/ui`'s `translator` follows — but every kind ships both, by construction.
 */
export function substitutionMessage(input: SubstitutionMessageInput, lang: Lang): string {
  const t = TEMPLATES[substitutionMessageKind(input)];
  const inLang = lang === 'ta' ? t.ta(input) : t.en(input);
  return inLang.trim() !== '' ? inLang : t.en(input);
}
