// C10 (v2.1 addendum · M12 · MG-04 cleaning · hard rule #3) — the LEGACY-CARD-PURGE check.
//
// The old ERP and POS were not built under hard rule #3. Their exports can carry a full card number in a "remarks"
// column, a column that is plainly the card number, the code from the back of the card, or its expiry. If any of it is
// loaded, the new system stores card data on day one, by migration, whatever its own tender surface refuses.
//
// So before a legacy extract is loaded, it is read for card data and the check PASSES only when there is none. What it
// looks for:
//   • a VALUE anywhere that is structurally a full card number (length 15/16/19, issuer prefix, Luhn — the same quiet
//     test as the tender surface, so 13-digit barcodes and GST numbers do not trip it);
//   • a VALUE that is a masked card showing more than the last four digits (e.g. the first six as well) — the new
//     system keeps only the last four;
//   • a COLUMN that is, by its header, the card number, the security code, or the CARD's expiry. An "expiry" column on
//     its own is NOT flagged: in a grocery item master it is the batch's use-by date. It counts as card expiry only
//     when the header says card, or when the same record also holds card data.
//
// A finding names the source, the record, the column and the kind — never the value (it would put the card number into
// the report that exists to keep it out). `columnsToDrop` is what the cleaning step must remove before the load; the
// numbers found inside free text must be cut from that text by a person, since only they can see what else it says.
//
// Pure and deterministic. It reads; it changes nothing.

import { containsCardNumber } from './card-token';

/** One legacy record, as extracted: which source, which row, and its columns. */
export interface LegacyRecord {
  readonly source: string;
  readonly rowRef: string;
  readonly fields: Readonly<Record<string, unknown>>;
}

export type LegacyCardFindingKind =
  | 'card_number_value'
  | 'masked_card_beyond_last4'
  | 'card_number_column'
  | 'card_security_code_column'
  | 'card_expiry_column';

export interface LegacyCardFinding {
  readonly source: string;
  readonly rowRef: string;
  readonly column: string;
  readonly kind: LegacyCardFindingKind;
  /** Never the value. */
  readonly detail: string;
}

export interface LegacyCardPurgeResult {
  /** True only when nothing card-shaped was found anywhere. */
  readonly passed: boolean;
  readonly recordsScanned: number;
  readonly valuesScanned: number;
  readonly findings: readonly LegacyCardFinding[];
  /** "source:column" pairs the cleaning step must drop before the load. */
  readonly columnsToDrop: readonly string[];
  readonly detail: string;
}

/** A header reduced to lower-case letters and digits: "Card No." → "cardno", "CVV2" → "cvv2". */
const norm = (header: string): string => header.toLowerCase().replace(/[^a-z0-9]/g, '');

/** Headers that ARE a card number. "PAN" alone is deliberately absent: in an Indian ERP it is the income-tax number. */
const NUMBER_HEADERS = new Set(['cardno', 'cardnum', 'cardnumber', 'ccno', 'ccnum', 'ccnumber', 'creditcardno', 'creditcardnumber', 'debitcardno', 'debitcardnumber', 'cardpan', 'primaryaccountnumber']);
/** Headers that are the code on the back of the card. */
const SECURITY_CODE_HEADERS = new Set(['cvv', 'cvv2', 'cvc', 'cvc2', 'cid', 'csc', 'securitycode', 'cardsecuritycode', 'cardverificationvalue', 'cardverificationcode']);
/** Headers that are an expiry — of WHAT, the record decides (see the file note). */
const EXPIRY_HEADERS = /^(card|cc|creditcard|debitcard)?(exp|expiry|expirydate|expdate|expiration|expirationdate|validthru|validupto|validtill|expmonth|expyear|expmm|expyy)$/;
const CARD_QUALIFIED = /^(card|cc|creditcard|debitcard)/;
/** A masked card: 4–6 visible leading digits, masking characters, then visible trailing digits. */
const MASKED_CARD = /\b\d{4,6}[ -]?(?:[xX*#•]{2,}[ -]?){1,4}\d{2,4}\b/;

/** Read a legacy extract for card data. Passes only when there is none. */
export function checkLegacyCardPurge(records: readonly LegacyRecord[]): LegacyCardPurgeResult {
  const findings: LegacyCardFinding[] = [];
  const drop = new Set<string>();
  let valuesScanned = 0;

  for (const r of records) {
    const columns = Object.keys(r.fields).sort();
    const valueFindings: LegacyCardFinding[] = [];
    let recordHasCardData = false;

    for (const column of columns) {
      const raw = r.fields[column];
      if (raw === null || raw === undefined) continue;
      valuesScanned += 1;
      const text = typeof raw === 'string' ? raw : typeof raw === 'number' || typeof raw === 'bigint' ? String(raw) : JSON.stringify(raw);
      const h = norm(column);
      const at = { source: r.source, rowRef: r.rowRef, column };

      if (NUMBER_HEADERS.has(h)) {
        findings.push({ ...at, kind: 'card_number_column', detail: `column "${column}" is a card-number column — drop it before the load (hard rule #3)` });
        drop.add(`${r.source}:${column}`);
        recordHasCardData = true;
        continue;
      }
      if (SECURITY_CODE_HEADERS.has(h)) {
        findings.push({ ...at, kind: 'card_security_code_column', detail: `column "${column}" holds a card security code — it may never be kept, by anyone (hard rule #3); drop it before the load` });
        drop.add(`${r.source}:${column}`);
        recordHasCardData = true;
        continue;
      }
      if (containsCardNumber(text)) {
        valueFindings.push({ ...at, kind: 'card_number_value', detail: `column "${column}" holds a full card number — cut it out before the load; it is not repeated here (hard rule #3)` });
        recordHasCardData = true;
      } else if (MASKED_CARD.test(text)) {
        valueFindings.push({ ...at, kind: 'masked_card_beyond_last4', detail: `column "${column}" holds a masked card showing more than the last four digits — keep only the last four, or nothing` });
        recordHasCardData = true;
      }
    }

    // An expiry column is the CARD's expiry when the header says so, or when the record holds card data at all.
    for (const column of columns) {
      const h = norm(column);
      if (!EXPIRY_HEADERS.test(h) || r.fields[column] === null || r.fields[column] === undefined) continue;
      if (CARD_QUALIFIED.test(h) || recordHasCardData) {
        findings.push({ source: r.source, rowRef: r.rowRef, column, kind: 'card_expiry_column', detail: `column "${column}" is a card expiry — drop it before the load (hard rule #3)` });
        drop.add(`${r.source}:${column}`);
      }
    }
    findings.push(...valueFindings);
  }

  const passed = findings.length === 0;
  return {
    passed,
    recordsScanned: records.length,
    valuesScanned,
    findings,
    columnsToDrop: [...drop].sort(),
    detail: passed
      ? `${records.length} record(s), ${valuesScanned} value(s) read: no card number, security code or card expiry anywhere — the extract may go on to be loaded`
      : `${findings.length} card-data finding(s) in ${new Set(findings.map((f) => `${f.source}:${f.rowRef}`)).size} record(s): the extract may NOT be loaded until they are purged (hard rule #3)`,
  };
}
