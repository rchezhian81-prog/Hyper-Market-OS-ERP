// C10 (v2.1 addendum · M12 · hard rule #3) — what a card tender may keep, and nothing else.
//
// A card payment leaves exactly three facts behind on the tender surface:
//   • `tokenRef` — the network-token (or provider-token) reference the payment was made under;
//   • `last4`    — the last four digits, so a cashier and a customer can recognise the card;
//   • `network`  — Visa, Mastercard, RuPay, …, so the cash office can match it to the provider file.
//
// That is an ALLOWLIST. Anything else offered with a card tender — whatever it is called — is refused, not stripped
// and kept quiet: a field nobody permitted is a field nobody reviewed. And because a refused NAME is not the only way
// card data travels, every value is also read for the SHAPE of a card number (a full number hidden inside a token, a
// "last four" that is really sixteen digits). A refusal never repeats the value it refused (#3, #4).
//
// Pure and deterministic. The detector below is the same three-signal test the kernel's outbound guard uses (length
// 15/16/19, an issuer prefix in use, Luhn) so it stays quiet on 13-digit barcodes and 14-digit carton codes.

/** The card networks a tender may name. Lower-case codes, the words a provider file uses. */
export const CARD_NETWORKS = ['visa', 'mastercard', 'rupay', 'amex', 'diners', 'discover', 'jcb', 'unionpay'] as const;
export type CardNetwork = (typeof CARD_NETWORKS)[number];

/** The ONLY fields a card tender may carry (C10). Closed, short, and checked by the guardrail. */
export const CARD_TENDER_PERMITTED_FIELDS = ['tokenRef', 'last4', 'network'] as const;

/** A card tender's stored identity: the token reference, the last four digits and the network. Nothing else. */
export interface CardTokenReference {
  readonly tokenRef: string;
  readonly last4: string;
  readonly network: CardNetwork;
}

export type CardTokenRefusal =
  | 'not_an_object'
  | 'field_not_permitted'
  | 'token_missing'
  | 'value_looks_like_a_card_number'
  | 'last4_not_four_digits'
  | 'network_unknown';

export interface CardTokenProblem {
  readonly code: CardTokenRefusal;
  /** The field the problem is on — its NAME only; the value is never repeated. */
  readonly field?: string;
  readonly detail: string;
}

export type CardTokenReading =
  | { readonly ok: true; readonly value: CardTokenReference }
  | { readonly ok: false; readonly problems: readonly CardTokenProblem[] };

const CARD_LENGTHS = new Set([15, 16, 19]);
const ISSUER = /^(4|5[1-5]|2(2[2-9]|[3-6]\d|7[01]|720)|3[47]|3(0[0-5]|[689])|6(011|5|0|[45])|8[12])/;

function luhn(digits: string): boolean {
  let sum = 0;
  let double = false;
  for (let i = digits.length - 1; i >= 0; i -= 1) {
    let d = digits.charCodeAt(i) - 48;
    if (double) { d *= 2; if (d > 9) d -= 9; }
    sum += d;
    double = !double;
  }
  return sum % 10 === 0;
}

/** True when the digits alone are structurally a card number: a used length, an issuer prefix in use, and Luhn. */
export function isCardNumberShape(digits: string): boolean {
  return /^\d+$/.test(digits) && CARD_LENGTHS.has(digits.length) && ISSUER.test(digits) && luhn(digits);
}

/**
 * True when the text CONTAINS something structurally a card number — on its own, with spaces or dashes between the
 * groups, or inside a longer string (`tok_4111…`). Each run of digits (single spaces/dashes allowed inside) is read as
 * a whole. Windows inside a LONGER digit run are deliberately not read: a 23-digit acquirer reference number would
 * then "contain" a card about one time in three, and a check that cries wolf on every refund is a check that gets
 * switched off (the kernel's outbound guard made the same choice for the same reason).
 */
export function containsCardNumber(text: string): boolean {
  for (const m of text.matchAll(/\d(?:[ -]?\d)+/g)) {
    if (isCardNumberShape(m[0].replace(/[ -]/g, ''))) return true;
  }
  return false;
}

/**
 * Read a card tender's stored identity. Returns the three permitted facts, or every problem at once. A field outside
 * `CARD_TENDER_PERMITTED_FIELDS` is refused by NAME (with no list of forbidden names to fall behind), and any value
 * that holds the shape of a card number is refused wherever it is.
 */
export function readCardTokenReference(input: unknown): CardTokenReading {
  if (input === null || typeof input !== 'object' || Array.isArray(input)) {
    return { ok: false, problems: [{ code: 'not_an_object', detail: 'a card tender is { tokenRef, last4, network } and nothing else' }] };
  }
  const rec = input as Record<string, unknown>;
  const problems: CardTokenProblem[] = [];
  const permitted = CARD_TENDER_PERMITTED_FIELDS as readonly string[];

  for (const key of Object.keys(rec).sort()) {
    if (!permitted.includes(key)) {
      problems.push({
        code: 'field_not_permitted', field: key,
        detail: `"${key}" is not one of ${permitted.join(', ')} — a card tender keeps only the token reference, the last four digits and the network (hard rule #3); nothing was kept`,
      });
    }
  }
  // Every value is read for the shape of a card number — permitted or not, nested or not.
  const walk = (v: unknown, at: string): void => {
    if (typeof v === 'string' || typeof v === 'number') {
      if (containsCardNumber(String(v))) {
        problems.push({ code: 'value_looks_like_a_card_number', field: at, detail: `${at} holds something structurally a card number; it is refused and not repeated here (hard rule #3)` });
      }
    } else if (Array.isArray(v)) v.forEach((x, i) => { walk(x, `${at}[${i}]`); });
    else if (v !== null && typeof v === 'object') for (const [k, x] of Object.entries(v as Record<string, unknown>)) walk(x, `${at}.${k}`);
  };
  for (const [k, v] of Object.entries(rec)) walk(v, k);

  const tokenRef = rec['tokenRef'];
  if (typeof tokenRef !== 'string' || tokenRef.trim() === '') {
    problems.push({ code: 'token_missing', field: 'tokenRef', detail: 'a card tender needs the network-token reference it was paid under' });
  }
  const last4 = rec['last4'];
  if (typeof last4 !== 'string' || !/^\d{4}$/.test(last4)) {
    problems.push({ code: 'last4_not_four_digits', field: 'last4', detail: 'last4 must be exactly four digits — never more of the card' });
  }
  const network = rec['network'];
  if (typeof network !== 'string' || !(CARD_NETWORKS as readonly string[]).includes(network)) {
    problems.push({ code: 'network_unknown', field: 'network', detail: `network must be one of ${CARD_NETWORKS.join(', ')}` });
  }

  if (problems.length > 0) return { ok: false, problems };
  return { ok: true, value: { tokenRef: tokenRef as string, last4: last4 as string, network: network as CardNetwork } };
}
