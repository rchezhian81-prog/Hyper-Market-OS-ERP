// OB-271 (owner, 21 Oct 2026) · audit A9 / A11 — the APPROVAL or REFERENCE number from the shop's OWN card machine or UPI.
//
// With no payment provider connected, the cashier runs the card on the shop's standalone machine (or the customer pays
// the shop's UPI QR) and taps what the machine said. "Approved" alone is no evidence, and the box's own attempt id is a
// number the machine never saw, so nothing could be matched against the machine's settlement slip at the end of the day.
// In real trading the cashier now types the number the machine printed or showed — the card approval code (usually 6
// letters/digits) or the RRN / UPI reference (usually 12 digits) — and it is kept on the tender.
//
// The rules (pure — the till decides before its disk, the store computer again before ITS disk, with the same words):
//   • SHAPE: 4 to 12 letters or digits once spaces and dashes are taken out, kept in capitals — the approval code, the
//     RRN or the UPI reference all fit; a card number (13 to 19 digits) cannot.
//   • NEVER CARD DATA (hard rule #3): anything holding a card number's shape, by either detector, is refused — and the
//     value typed is never repeated back, logged or kept. The words say what to type instead.

import { holdsCardNumber } from './tender-card-data';

/** The shortest and longest approval / reference number this till keeps. */
export const MACHINE_REF_MIN = 4;
export const MACHINE_REF_MAX = 12;

/** What the till and the store computer say, in English. The till shows the same in Tamil from its own word list. */
export const MACHINE_REF_WORDS = {
  ask: 'Approval number from the machine',
  hint: 'Type the approval code (usually 6 letters or digits) or the RRN / UPI reference (usually 12 digits) printed on the machine\'s slip or shown on the UPI screen. Never the card number.',
  missing: 'Type the approval or reference number the machine printed for this payment. It is how the day is matched against the machine\'s own slip.',
  notValid: 'That is not an approval or reference number: it must be 4 to 12 letters or digits (the approval code, or the RRN / UPI reference). Check the machine\'s slip and type it again.',
  cardLike: 'That looks like a CARD NUMBER. A card number is never typed or kept. Type the approval code or the RRN from the machine\'s slip instead.',
  refundAsk: 'Refund reference from the machine',
  refundHint: 'Do the refund (or void) on the shop\'s card machine or UPI app first. Then type the reference it printed for the refund. Never the card number.',
} as const;

export type MachineRefReading =
  | { readonly ok: true; readonly value: string }
  | { readonly ok: false; readonly refusedBecause: 'machine_ref_missing' | 'machine_ref_not_valid' | 'machine_ref_looks_like_card'; readonly laneMessage: string };

const SHAPE = new RegExp(`^[A-Z0-9]{${MACHINE_REF_MIN},${MACHINE_REF_MAX}}$`);

/** Read what the cashier typed as the machine's approval / reference number: the kept form, or why not (never echoing it). */
export function readMachineReference(typed: unknown): MachineRefReading {
  if (typeof typed !== 'string' || typed.trim() === '') return { ok: false, refusedBecause: 'machine_ref_missing', laneMessage: MACHINE_REF_WORDS.missing };
  // Card data first: a card number typed with spaces or dashes is still a card number.
  if (holdsCardNumber(typed)) return { ok: false, refusedBecause: 'machine_ref_looks_like_card', laneMessage: MACHINE_REF_WORDS.cardLike };
  const value = typed.replace(/[\s-]/g, '').toUpperCase();
  if (/\d{13,}/.test(value)) return { ok: false, refusedBecause: 'machine_ref_looks_like_card', laneMessage: MACHINE_REF_WORDS.cardLike };
  if (!SHAPE.test(value)) return { ok: false, refusedBecause: 'machine_ref_not_valid', laneMessage: MACHINE_REF_WORDS.notValid };
  return { ok: true, value };
}
