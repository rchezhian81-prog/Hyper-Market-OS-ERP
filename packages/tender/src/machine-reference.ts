// OB-271 · OB-274 (owner, 21 Oct 2026) · audit A9 / A11 — the APPROVAL or REFERENCE number from the shop's OWN card machine
// or UPI. OB-274: any machine, any bank — ONE generic field, "Approval / Auth code / RRN", no machine model anywhere.
//
// With no payment provider connected, the cashier runs the card on the shop's standalone machine (or the customer pays
// the shop's UPI QR) and taps what the machine said. "Approved" alone is no evidence, and the box's own attempt id is a
// number the machine never saw, so nothing could be matched against the machine's settlement slip at the end of the day.
// In real trading the cashier now types the number the machine printed or showed — its approval / auth code or the RRN /
// UPI reference, whatever the machine calls it — and it is kept on the tender.
//
// The rules (pure — the till decides before its disk, the store computer again before ITS disk, with the same words):
//   • SHAPE (OB-274): 4 to 20 letters or digits once spaces and dashes are taken out, kept in capitals — an approval / auth
//     code, an RRN or a UPI reference from any machine or bank fits.
//   • NEVER CARD DATA (hard rule #3): anything holding a card number's shape, by either of the existing detectors
//     (`holdsCardNumber`), is refused — and the value typed is never repeated back, logged or kept. The words say what to
//     type instead.

import { holdsCardNumber } from './tender-card-data';

/** The shortest and longest approval / reference number this till keeps. */
export const MACHINE_REF_MIN = 4;
export const MACHINE_REF_MAX = 20;

/** What the till and the store computer say, in English. The till shows the same in Tamil from its own word list. */
export const MACHINE_REF_WORDS = {
  ask: 'Approval / Auth code / RRN',
  hint: 'Type the approval / auth code or the RRN / UPI reference printed on the machine\'s slip or shown on the UPI screen (4 to 20 letters or digits). Never the card number.',
  missing: 'Type the approval or reference number the machine printed for this payment. It is how the day is matched against the machine\'s own slip.',
  notValid: 'That is not an approval / auth code or RRN: it must be 4 to 20 letters or digits. Check the machine\'s slip and type it again.',
  cardLike: 'That looks like a CARD NUMBER. A card number is never typed or kept. Type the approval / auth code or the RRN from the machine\'s slip instead.',
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
  if (!SHAPE.test(value)) return { ok: false, refusedBecause: 'machine_ref_not_valid', laneMessage: MACHINE_REF_WORDS.notValid };
  return { ok: true, value };
}
