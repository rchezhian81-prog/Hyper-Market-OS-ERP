// C10 on the real paths (NEW-3 · hard rule #3) — what a stored tender may keep. Its own file so it can read BOTH
// detectors: `containsCardNumber` (card-token.ts) and `containsGroupedCardNumber` (legacy-card-purge.ts — any short
// separator, a window inside a longer run), without the two modules importing each other.

import { readCardTokenReference, containsCardNumber } from './card-token';
import { containsGroupedCardNumber } from './legacy-card-purge';

/** Anything shaped like a card number, by either detector. */
export const holdsCardNumber = (text: string): boolean => containsCardNumber(text) || containsGroupedCardNumber(text);

//
// `readCardTokenReference` above is the rule; this applies it to a sale's tenders where they are about to be KEPT — the
// store computer before its disk, head office before its event store, the till before it hands the record over. A sale
// that reached any of these has happened (the money is in the drawer, the customer has the goods), so refusing it would
// lose a real sale (hard rule #1). Therefore the forbidden part is REMOVED and the removal is SAID, by field NAME only:
//
//   • a tender keeps only the fields a tender has (`TENDER_FIELDS`); any other field is removed;
//   • a tender's `card` keeps only `tokenRef`, `last4` and `network` — and only when they read cleanly; otherwise the card
//     object is removed whole (a "token" that is really a card number is not a token);
//   • any value shaped like a card number (`holdsCardNumber`) is removed wherever it is in the tender — a `ref`, a
//     `kind`, a nested field.
//
// The value removed is never repeated — not in the answer, not in the finding, not in a log (hard rules #3, #4).

/**
 * The fields a stored tender may carry, in the till's and head office's shapes. Anything else is removed. `cardDataRemoved`
 * is the store computer's own mark of what it removed (field names only); a till-sent one is dropped at the store computer.
 */
export const TENDER_FIELDS = ['kind', 'amount', 'amountMinor', 'status', 'ref', 'machineRef', 'points', 'card', 'cardDataRemoved'] as const;

/** One tender's removed fields, by NAME (e.g. `ref` or a field inside `card`) — never their values. */
export interface TenderCardDataRemoval {
  /** The tender's position in the sale's tender list. */
  readonly tender: number;
  readonly kind: string;
  readonly fields: readonly string[];
}

export interface TendersWithoutCardData {
  /** The tenders as they may be kept: the same objects when nothing was removed. */
  readonly tenders: readonly unknown[];
  readonly removed: readonly TenderCardDataRemoval[];
}

/** A field's NAME as it may be repeated: a name that is itself shaped like a card number is not repeated either. */
const nameOf = (key: string): string => (holdsCardNumber(key) ? '(a field named like a card number)' : key);

/**
 * Verifier r2final NEW-3: the smallest number with 13 digits — the shortest card number. No figure a tender carries
 * reaches it: an amount of ₹1,000 crore is 10^12 paise.
 */
export const CARD_LENGTH_NUMBER = 1e12;

/**
 * Whether a value holds a card number, wherever it is: in a string (either detector), in a NUMBER or bigint of 13 digits or
 * more (a card number sent as JSON `4111111111111111`, verifier r2final NEW-3), or nested in an array or an object.
 */
export const looksCardLike = (v: unknown): boolean => {
  if (typeof v === 'string') return holdsCardNumber(v);
  if (typeof v === 'number') return Number.isFinite(v) && (Math.abs(v) >= CARD_LENGTH_NUMBER || holdsCardNumber(String(v)));
  if (typeof v === 'bigint') return (v < 0n ? -v : v) >= BigInt(CARD_LENGTH_NUMBER) || holdsCardNumber(v.toString());
  if (Array.isArray(v)) return v.some(looksCardLike);
  if (v !== null && typeof v === 'object') return Object.values(v as Record<string, unknown>).some(looksCardLike);
  return false;
};

/**
 * NEW-3: `amountMinor` and `points` are read as what they are — a whole number (a safe integer) below 13 digits is a figure,
 * never card data, so a normal amount is never mistaken for a card number; a card number put in either field (13 digits or
 * more, a number or a string) is removed like any other.
 */
const isTenderFigure = (v: unknown): boolean => Number.isSafeInteger(v) && Math.abs(v as number) < CARD_LENGTH_NUMBER;

/**
 * The tenders with every card fact a tender may not keep REMOVED, and what was removed (by name). Pure and deterministic:
 * the same tenders always give the same answer, so a till re-sending the same sale is the same record.
 */
export function withoutCardData(tenders: readonly unknown[]): TendersWithoutCardData {
  const removed: TenderCardDataRemoval[] = [];
  const kept = tenders.map((t, index) => {
    // NEW-3: a "tender" that is itself a card number (a bare string or number in the list) is replaced by an empty tender.
    if (t === null || typeof t !== 'object' || Array.isArray(t)) {
      if (!looksCardLike(t)) return t;
      removed.push({ tender: index, kind: '', fields: ['(the tender itself)'] });
      return {};
    }
    const rec = t as Record<string, unknown>;
    const fields: string[] = [];
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(rec)) {
      const v = rec[key];
      if (!(TENDER_FIELDS as readonly string[]).includes(key)) { fields.push(nameOf(key)); continue; }
      if (key === 'card') {
        const reading = readCardTokenReference(v);
        if (reading.ok) { out[key] = reading.value; continue; }
        // Name every removed part: the fields not permitted, and the permitted ones that did not read cleanly.
        const inner = v !== null && typeof v === 'object' && !Array.isArray(v) ? Object.keys(v as Record<string, unknown>).sort() : [];
        fields.push(...(inner.length === 0 ? ['card'] : inner.map((k) => `card.${nameOf(k)}`)));
        continue;
      }
      // Amounts and points are kept only as whole numbers below 13 digits (NEW-3); every other field — numbers and nested
      // values included — is read for a card number's shape.
      if (key === 'amountMinor' || key === 'points') {
        // A figure (a safe integer below 13 digits) is never card data; anything else in the field is read like any value.
        if (!isTenderFigure(v) && looksCardLike(v)) { fields.push(key); continue; }
      } else if (looksCardLike(v)) { fields.push(key); continue; }
      out[key] = v;
    }
    if (fields.length === 0) return t;
    removed.push({ tender: index, kind: typeof rec['kind'] === 'string' && !holdsCardNumber(rec['kind']) ? rec['kind'] : '', fields: fields.sort() });
    return out;
  });
  return removed.length === 0 ? { tenders, removed } : { tenders: kept, removed };
}

/** Plain words for a removal — field names only, never a value (hard rule #3). */
export function cardDataRemovalWords(removed: readonly TenderCardDataRemoval[]): string {
  return removed.map((r) => `tender ${r.tender + 1}${r.kind === '' ? '' : ` (${r.kind})`}: ${r.fields.join(', ')}`).join('; ');
}
