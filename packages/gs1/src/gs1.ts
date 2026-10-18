// GS1 2D barcodes at the till (roadmap v2.1 D-20 · GS1 Sunrise 2027 · M03 · M10 · M12).
//
// A 2D code (DataMatrix, QR) carries more than the product: it carries the BATCH (AI 10) and the use-by date (AI 17)
// of the very pack in the customer's hand. That is what lets the till refuse an expired pack (B8), sell a marked-down
// batch at its markdown price, and refuse only the recalled batch of a product (SF-08 · OB-139 "A").
//
// Three ways the same facts arrive from a scanner, all read here:
//
//   • the raw ELEMENT STRING a DataMatrix or GS1 QR decodes to — optionally led by the scanner's symbology identifier
//     (`]d2`, `]Q3`, `]C1`, `]e0`, `]J1`), application identifiers back to back, a variable-length field ended by the
//     group separator (FNC1, ASCII 29) or by the end of the code;
//   • the HUMAN-READABLE form printed under the code — `(01)08901000000011(17)300615(10)B-1` — which a scanner set to
//     "transmit HRI" sends, and which a person can type;
//   • a GS1 DIGITAL LINK web address — `https://id.gs1.org/01/08901000000011/10/B-1?17=300615` — which a QR code on a
//     pack carries. It is read as TEXT here: nothing is fetched, ever (hard rule #1). The domain is ignored; only the
//     path keys and the query attributes count.
//
// Pure and deterministic: no clock, no network, no catalogue. A code that cannot be read with certainty is REFUSED with
// its reason (an unknown AI, a bad check digit, an impossible date) — never half-read, because a half-read batch is a
// recall that sells (P-08).

/** ASCII 29, the group separator a scanner sends for FNC1 inside a GS1 code. Written as an escape (plain-text-source). */
export const GROUP_SEPARATOR = '\u001d';

/** Symbology identifiers a scanner may put in front of a GS1 code (ISO/IEC 15424): DataMatrix, QR, GS1-128, DataBar, DotCode. */
const SYMBOLOGY_PREFIX = /^\](?:d2|Q3|C1|e0|J1)/;

/** How an application identifier's data is laid out. `fixed` = exactly n characters; `variable` = up to n, FNC1-ended. */
interface AiSpec {
  readonly kind: 'fixed' | 'variable';
  readonly length: number;
  readonly numeric: boolean;
  readonly title: string;
}

const fixed = (length: number, title: string, numeric = true): AiSpec => ({ kind: 'fixed', length, numeric, title });
const variable = (length: number, title: string, numeric = false): AiSpec => ({ kind: 'variable', length, numeric, title });

/**
 * The application identifiers this till reads (GS1 General Specifications §3). Anything else is refused by name rather
 * than skipped: an AI whose length we do not know cannot be stepped over safely, and guessing would misread the batch.
 */
const AI_TABLE: Readonly<Record<string, AiSpec>> = (() => {
  const t: Record<string, AiSpec> = {
    '00': fixed(18, 'SSCC'),
    '01': fixed(14, 'GTIN'),
    '02': fixed(14, 'GTIN of contained trade items'),
    '10': variable(20, 'batch or lot number'),
    '11': fixed(6, 'production date'),
    '12': fixed(6, 'due date'),
    '13': fixed(6, 'packaging date'),
    '15': fixed(6, 'best before date'),
    '16': fixed(6, 'sell by date'),
    '17': fixed(6, 'expiration date'),
    '20': fixed(2, 'internal product variant'),
    '21': variable(20, 'serial number'),
    '22': variable(20, 'consumer product variant'),
    '30': variable(8, 'variable count', true),
    '37': variable(8, 'count of trade items', true),
    '240': variable(30, 'additional product identification'),
    '241': variable(30, 'customer part number'),
    '250': variable(30, 'secondary serial number'),
    '251': variable(30, 'reference to source entity'),
    '253': variable(30, 'global document type identifier'),
    '254': variable(20, 'GLN extension component'),
    '400': variable(30, "customer's purchase order number"),
    '401': variable(30, 'global identification number for consignment'),
    '402': fixed(17, 'global shipment identification number'),
    '403': variable(30, 'routing code'),
    '420': variable(20, 'ship to postal code'),
    '421': variable(12, 'ship to postal code with ISO country code'),
    '422': fixed(3, 'country of origin'),
    '7003': fixed(10, 'expiration date and time'),
    '8005': fixed(6, 'price per unit of measure'),
    '8020': variable(25, 'payment slip reference number'),
  };
  for (let i = 410; i <= 417; i += 1) t[String(i)] = fixed(13, 'global location number');
  // 310n–369n: trade measures (net weight, length, volume …) — six digits, n = decimal places.
  for (let ai = 310; ai <= 369; ai += 1) for (let n = 0; n <= 9; n += 1) t[`${ai}${n}`] = fixed(6, 'trade measure');
  // 390n–395n: amounts and prices.
  for (const ai of ['390', '392']) for (let n = 0; n <= 9; n += 1) t[`${ai}${n}`] = variable(15, 'amount payable', true);
  for (const ai of ['391', '393']) for (let n = 0; n <= 9; n += 1) t[`${ai}${n}`] = variable(18, 'amount payable with ISO currency', true);
  for (let i = 90; i <= 99; i += 1) t[String(i)] = variable(i === 90 ? 30 : 90, 'company internal information');
  return Object.freeze(t);
})();

/** The AIs a Digital Link path may carry as its primary key or key qualifiers (GS1 Digital Link 1.2). */
const DIGITAL_LINK_PATH_KEYS = new Set(['01', '00', '414', '417', '8003', '8004', '10', '21', '22', '235', '254', '7040']);

export type Gs1Form = 'element_string' | 'human_readable' | 'digital_link';

export type Gs1Refusal =
  | 'empty'
  | 'unknown_application_identifier'
  | 'field_too_short'
  | 'field_too_long'
  | 'not_numeric'
  | 'gtin_check_digit_wrong'
  | 'no_gtin'
  | 'date_not_a_date'
  | 'repeated_application_identifier'
  | 'not_a_gs1_code';

/** A GS1 code that cannot be read with certainty. The till names the reason; it never sells from half a code. */
export class Gs1ParseError extends Error {
  constructor(public readonly reason: Gs1Refusal, detail: string) {
    super(`This 2D barcode cannot be read: ${detail}.`);
    this.name = 'Gs1ParseError';
  }
}

/** What a GS1 code said, in the till's words. */
export interface Gs1Read {
  readonly form: Gs1Form;
  /** The GTIN as 14 digits (AI 01), check digit verified. */
  readonly gtin: string;
  /** The batch / lot (AI 10), exactly as printed. */
  readonly batch?: string;
  /** The use-by / expiry date (AI 17) as YYYY-MM-DD — the LAST sellable day. */
  readonly expiry?: string;
  /** The serial (AI 21), where the pack carries one. */
  readonly serial?: string;
  /** Every element read, by AI, raw — for the record. */
  readonly elements: Readonly<Record<string, string>>;
}

/**
 * Parse a GS1-style 6-digit YYMMDD date into `YYYY-MM-DD`, or `undefined` when it is not a date. The year maps to 20YY
 * (retail use-by dates are near-future); a day of `00` means the last day of the month (GS1 AI 17 convention). Pure.
 */
export function parseGs1Date(yymmdd: string): string | undefined {
  if (!/^\d{6}$/.test(yymmdd)) return undefined;
  const year = 2000 + Number(yymmdd.slice(0, 2));
  const month = Number(yymmdd.slice(2, 4));
  let day = Number(yymmdd.slice(4, 6));
  if (month < 1 || month > 12) return undefined;
  if (day === 0) day = new Date(Date.UTC(year, month, 0)).getUTCDate(); // "00" → last day of the month
  const iso = `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
  // Reject an impossible day (e.g. 31 April) by checking the date round-trips.
  const parsed = new Date(`${iso}T00:00:00.000Z`);
  if (Number.isNaN(parsed.getTime()) || parsed.getUTCDate() !== day) return undefined;
  return iso;
}

/** True when the digits end in a correct GS1 mod-10 check digit (GTIN-8/12/13/14, SSCC). */
export function hasValidCheckDigit(digits: string): boolean {
  if (!/^\d{2,}$/.test(digits)) return false;
  const body = digits.slice(0, -1);
  let sum = 0;
  for (let i = 0; i < body.length; i += 1) {
    // From the right of the body, weights alternate 3, 1, 3 …
    const weight = (body.length - i) % 2 === 1 ? 3 : 1;
    sum += Number(body[i]) * weight;
  }
  return (10 - (sum % 10)) % 10 === Number(digits[digits.length - 1]);
}

/**
 * The plain barcodes a 14-digit GTIN is printed as on a 1D label — the GTIN itself, then EAN-13, UPC-A and EAN-8 (the
 * same number without its leading zeros). The catalogue knows a product by the code on its 1D label, so a 2D scan finds
 * it by these, in this order.
 */
export function gtinCandidates(gtin14: string): readonly string[] {
  const out = [gtin14];
  for (const width of [13, 12, 8]) {
    const lead = gtin14.length - width;
    if (lead > 0 && /^0+$/.test(gtin14.slice(0, lead))) out.push(gtin14.slice(lead));
  }
  return out;
}

/**
 * Is this scan a GS1 2D code rather than a plain 1D barcode? Decided by its SHAPE alone — a symbology identifier, a group
 * separator, the printed `(01)` form, a web address, or `01` + 14 digits followed by more AIs. A plain EAN-13 or UPC is
 * never one, so a 1D scan behaves exactly as before.
 */
export function looksLikeGs1(code: string): boolean {
  const c = code.trim();
  if (c === '') return false;
  if (SYMBOLOGY_PREFIX.test(c) || c.includes(GROUP_SEPARATOR)) return true;
  if (/^\(\d{2,4}\)/.test(c)) return true;
  if (/^https?:\/\//i.test(c)) return /\/01\/\d{14}(?:[/?#]|$)/.test(c);
  return /^01\d{14}\d{2}/.test(c);
}

const checkField = (ai: string, value: string, spec: AiSpec): void => {
  if (value === '') throw new Gs1ParseError('field_too_short', `AI (${ai}) ${spec.title} is empty`);
  if (spec.kind === 'fixed' && value.length !== spec.length) {
    throw new Gs1ParseError('field_too_short', `AI (${ai}) ${spec.title} must be ${spec.length} characters, got ${value.length}`);
  }
  if (spec.kind === 'variable' && value.length > spec.length) {
    throw new Gs1ParseError('field_too_long', `AI (${ai}) ${spec.title} may be at most ${spec.length} characters, got ${value.length}`);
  }
  if (spec.numeric && !/^\d+$/.test(value)) throw new Gs1ParseError('not_numeric', `AI (${ai}) ${spec.title} must be digits`);
};

const specOf = (ai: string): AiSpec => {
  const spec = AI_TABLE[ai];
  if (spec === undefined) throw new Gs1ParseError('unknown_application_identifier', `application identifier (${ai}) is not one this till reads`);
  return spec;
};

/** The AI at the start of `rest`: the shortest known prefix of 2, 3 or 4 digits. */
function aiAt(rest: string): string {
  for (const width of [2, 3, 4]) {
    const ai = rest.slice(0, width);
    if (/^\d+$/.test(ai) && ai.length === width && AI_TABLE[ai] !== undefined) return ai;
  }
  throw new Gs1ParseError('unknown_application_identifier', `application identifier at "${rest.slice(0, 4)}" is not one this till reads`);
}

function readElementString(raw: string): Record<string, string> {
  const elements: Record<string, string> = {};
  let rest = raw.replace(SYMBOLOGY_PREFIX, '');
  // A leading FNC1 is the GS1 flag itself, not a separator.
  while (rest.startsWith(GROUP_SEPARATOR)) rest = rest.slice(1);
  while (rest !== '') {
    const ai = aiAt(rest);
    const spec = specOf(ai);
    rest = rest.slice(ai.length);
    let value: string;
    if (spec.kind === 'fixed') {
      value = rest.slice(0, spec.length);
      rest = rest.slice(spec.length);
      if (rest.startsWith(GROUP_SEPARATOR)) rest = rest.slice(1); // a separator after a fixed field is allowed
    } else {
      const end = rest.indexOf(GROUP_SEPARATOR);
      value = end === -1 ? rest : rest.slice(0, end);
      rest = end === -1 ? '' : rest.slice(end + 1);
    }
    put(elements, ai, value, spec);
  }
  return elements;
}

function readHumanReadable(raw: string): Record<string, string> {
  const elements: Record<string, string> = {};
  const re = /\((\d{2,4})\)([^(]*)/gy;
  let consumed = 0;
  for (let m = re.exec(raw); m !== null; m = re.exec(raw)) {
    consumed = re.lastIndex;
    const ai = m[1]!;
    put(elements, ai, m[2]!.replace(new RegExp(GROUP_SEPARATOR, 'g'), ''), specOf(ai));
  }
  if (consumed !== raw.length) throw new Gs1ParseError('not_a_gs1_code', 'the printed form must be (AI)value pairs from start to end');
  return elements;
}

function readDigitalLink(raw: string): Record<string, string> {
  const elements: Record<string, string> = {};
  const noFragment = raw.split('#')[0]!;
  const [beforeQuery, query = ''] = noFragment.split('?', 2) as [string, string?];
  const path = beforeQuery.replace(/^https?:\/\/[^/]+/i, '');
  const parts = path.split('/').filter((p) => p !== '');
  // The keys sit at the END of the path (anything before them is the resolver's own prefix): find where 01 starts.
  const start = parts.findIndex((p, i) => p === '01' && i + 1 < parts.length);
  if (start === -1) throw new Gs1ParseError('no_gtin', 'the web address carries no /01/ GTIN');
  for (let i = start; i < parts.length; i += 2) {
    const ai = parts[i]!;
    const value = parts[i + 1];
    if (!DIGITAL_LINK_PATH_KEYS.has(ai) || value === undefined) {
      throw new Gs1ParseError('not_a_gs1_code', `the web address path "/${ai}" is not a GS1 key with a value`);
    }
    put(elements, ai, safeDecode(value), specOf(ai));
  }
  for (const pair of query.split('&').filter((q) => q !== '')) {
    const [key = '', value = ''] = pair.split('=', 2);
    // Only numeric keys are GS1 attributes; anything else (a campaign tag on the address) is the web page's business.
    if (!/^\d{2,4}$/.test(key)) continue;
    put(elements, key, safeDecode(value), specOf(key));
  }
  return elements;
}

function safeDecode(v: string): string {
  try {
    return decodeURIComponent(v);
  } catch {
    throw new Gs1ParseError('not_a_gs1_code', `"${v}" is not a readable web-address value`);
  }
}

function put(elements: Record<string, string>, ai: string, value: string, spec: AiSpec): void {
  checkField(ai, value, spec);
  if (elements[ai] !== undefined && elements[ai] !== value) {
    throw new Gs1ParseError('repeated_application_identifier', `AI (${ai}) appears twice with different values`);
  }
  elements[ai] = value;
}

/**
 * Read a GS1 2D code into its GTIN, batch and expiry. Offline and clockless. Throws `Gs1ParseError` with the reason for
 * any code that cannot be read with certainty: an unknown AI, a field of the wrong length, a GTIN whose check digit is
 * wrong, an expiry that is not a date, or no GTIN at all.
 */
export function parseGs1(code: string): Gs1Read {
  const raw = code.trim();
  if (raw === '') throw new Gs1ParseError('empty', 'nothing was scanned');
  let form: Gs1Form;
  let elements: Record<string, string>;
  if (/^https?:\/\//i.test(raw)) {
    form = 'digital_link';
    elements = readDigitalLink(raw);
  } else if (raw.startsWith('(')) {
    form = 'human_readable';
    elements = readHumanReadable(raw);
  } else {
    form = 'element_string';
    elements = readElementString(raw);
  }
  const gtin = elements['01'];
  if (gtin === undefined) throw new Gs1ParseError('no_gtin', 'it carries no GTIN (AI 01), so it names no product');
  if (!hasValidCheckDigit(gtin)) throw new Gs1ParseError('gtin_check_digit_wrong', `the GTIN ${gtin} has a wrong check digit — a misread`);
  let expiry: string | undefined;
  if (elements['17'] !== undefined) {
    expiry = parseGs1Date(elements['17']);
    if (expiry === undefined) throw new Gs1ParseError('date_not_a_date', `the expiry (17) ${elements['17']} is not a date`);
  }
  return Object.freeze({
    form,
    gtin,
    ...(elements['10'] === undefined ? {} : { batch: elements['10'] }),
    ...(expiry === undefined ? {} : { expiry }),
    ...(elements['21'] === undefined ? {} : { serial: elements['21'] }),
    elements: Object.freeze({ ...elements }),
  });
}
