// Related parties (M15-FR-03 · OB-301, owner, 23 Oct 2026: "the owner keeps a list of related people and firms; a
// supplier matching that list by GSTIN, phone or bank account needs the owner's approval before a purchase order").
//
// A related party is a person or a firm close to the shop's owner or its staff — a brother's wholesale firm, the
// manager's cousin's transport company. Buying from them is not forbidden; buying from them WITHOUT THE OWNER KNOWING
// is the control's whole subject. So the rules here are about MATCHING, and three things are deliberate:
//
//   • **A MATCH IS ON A FACT, NEVER ON A NAME.** Names are spelt five ways and shared by thousands. A GSTIN, a phone
//     number or a bank account is the same thing written down twice, so only those three match — each compared in one
//     normal form (a GSTIN in capitals with no spaces, a phone as its last ten digits, an account reference as its
//     letters and digits in capitals), so "98400 12345" and "+91-9840012345" are the same phone.
//   • **EVERY MATCH NAMES WHAT MATCHED.** "This supplier is related" is an accusation; "this supplier's GSTIN is the
//     one written against Kumar Traders on the owner's list" is a fact a person can check. Bank accounts are shown
//     masked (last four only) — the list never prints an account in full.
//   • **THE MATCH HAS A FINGERPRINT.** The owner's approval is for THIS supplier matching THESE entries. If the
//     supplier's GSTIN, phone or account changes, or the list changes, the fingerprint changes and the approval no
//     longer covers it — an approval given for one set of facts is never silently carried over to another.
//
// Pure and deterministic. Nothing here blocks anything: the purchase-order guard reads `matchSupplier` and decides.

import { createHash } from 'node:crypto';
import { maskPii } from '../../ops/src/logging';

export type RelatedPartyKind = 'person' | 'firm';

/** One entry on the owner's related-party list. */
export interface RelatedParty {
  readonly partyId: string;
  readonly name: string;
  readonly kind: RelatedPartyKind;
  /** How they are related, in the owner's own words ("brother's firm", "manager's cousin"). */
  readonly relation: string;
  readonly gstins: readonly string[];
  readonly phones: readonly string[];
  /** Bank account references (masked or tokenised as the shop holds them — PRV). */
  readonly bankAccountRefs: readonly string[];
  /** Taken off the list — kept, never deleted (hard rule #6); an inactive entry matches nothing. */
  readonly active: boolean;
}

/** The facts of a supplier the match is run over. */
export interface SupplierFacts {
  readonly supplierId: string;
  readonly gstin: string | null;
  readonly phone: string | null;
  /** The supplier's CURRENT verified bank account reference, or null when none is held. */
  readonly bankAccountRef: string | null;
}

export type MatchedOn = 'gstin' | 'phone' | 'bank_account';

export interface RelatedPartyMatch {
  readonly partyId: string;
  readonly partyName: string;
  readonly relation: string;
  readonly on: MatchedOn;
  /** What matched, as a person may be shown it (a bank account masked to its last four). */
  readonly shown: string;
}

/** A GSTIN in its one written form: capitals, no spaces or punctuation. */
export const normalGstin = (v: string): string => v.toUpperCase().replace(/[^A-Z0-9]/g, '');
/** A phone in its one written form: its last ten digits (an Indian mobile with or without +91 / 0). */
export function normalPhone(v: string): string {
  const digits = v.replace(/\D/g, '');
  return digits.length > 10 ? digits.slice(-10) : digits;
}
/** A bank account reference in its one written form: letters and digits only, in capitals. */
export const normalAccount = (v: string): string => v.toUpperCase().replace(/[^A-Z0-9]/g, '');
/** A related person's phone as a person may see it — the shop's one masking (`maskPii`): `98****3210`. */
export const maskedPhone = (v: string): string => maskPii(normalPhone(v));
/** A bank account as a person may see it: every character but the last four hidden. */
export function maskedAccount(v: string): string {
  const n = normalAccount(v);
  return n.length <= 4 ? '••••' : `••••${n.slice(-4)}`;
}

/** Is this value usable as a matching fact at all (an empty or one-digit "phone" matches nothing)? */
const usable = (on: MatchedOn, n: string): boolean => (on === 'phone' ? n.length >= 8 : n.length >= 4);

/** The supplier's matches against the active entries of the list — every fact that matches, named, in a stable order. */
export function matchSupplier(supplier: SupplierFacts, parties: readonly RelatedParty[]): readonly RelatedPartyMatch[] {
  const out: RelatedPartyMatch[] = [];
  const facts: readonly [MatchedOn, string | null, (v: string) => string][] = [
    ['gstin', supplier.gstin, normalGstin], ['phone', supplier.phone, normalPhone], ['bank_account', supplier.bankAccountRef, normalAccount],
  ];
  for (const party of [...parties].filter((p) => p.active).sort((a, b) => a.partyId.localeCompare(b.partyId))) {
    for (const [on, raw, norm] of facts) {
      if (raw === null || raw.trim() === '') continue;
      const mine = norm(raw);
      if (!usable(on, mine)) continue;
      const theirs = on === 'gstin' ? party.gstins : on === 'phone' ? party.phones : party.bankAccountRefs;
      if (theirs.some((t) => norm(t) === mine)) {
        out.push({ partyId: party.partyId, partyName: party.name, relation: party.relation, on, shown: on === 'bank_account' ? maskedAccount(raw) : on === 'phone' ? maskedPhone(raw) : normalGstin(raw) });
      }
    }
  }
  return out;
}

/**
 * The fingerprint of a supplier's matches: which entries matched on which normalised facts — as a SHA-256, so an
 * approval record never carries the phone or the bank account itself. The owner's approval is given for exactly this;
 * any change to the supplier's facts or to the list's matching entries gives another one.
 */
export function matchFingerprint(supplier: SupplierFacts, matches: readonly RelatedPartyMatch[]): string {
  const facts = [
    `gstin=${supplier.gstin === null ? '' : normalGstin(supplier.gstin)}`,
    `phone=${supplier.phone === null ? '' : normalPhone(supplier.phone)}`,
    `bank=${supplier.bankAccountRef === null ? '' : normalAccount(supplier.bankAccountRef)}`,
  ];
  const named = matches.map((m) => `${m.partyId}:${m.on}`).sort();
  return createHash('sha256').update(`${supplier.supplierId}|${facts.join('|')}|${named.join(',')}`).digest('hex');
}

/** Read a related-party entry from a request body; `undefined` with the reason when it cannot be read. */
export function readRelatedParty(partyId: string, raw: unknown): { readonly ok: true; readonly party: RelatedParty } | { readonly ok: false; readonly why: string } {
  const b = raw !== null && typeof raw === 'object' && !Array.isArray(raw) ? raw as Record<string, unknown> : {};
  const str = (v: unknown): v is string => typeof v === 'string' && v.trim() !== '';
  const list = (v: unknown): string[] | null => (v === undefined ? [] : Array.isArray(v) && v.every((x) => typeof x === 'string') ? (v as string[]).map((x) => x.trim()).filter((x) => x !== '') : null);
  if (partyId.trim() === '') return { ok: false, why: 'An entry needs an id in the address.' };
  if (!str(b['name'])) return { ok: false, why: 'Write the person\'s or the firm\'s name.' };
  if (b['kind'] !== 'person' && b['kind'] !== 'firm') return { ok: false, why: 'Say whether it is a person or a firm.' };
  if (!str(b['relation'])) return { ok: false, why: 'Say how they are related, in your own words.' };
  const gstins = list(b['gstins']); const phones = list(b['phones']); const accounts = list(b['bankAccountRefs']);
  if (gstins === null || phones === null || accounts === null) return { ok: false, why: 'GSTINs, phones and bank accounts are each a list of words.' };
  if (gstins.length + phones.length + accounts.length === 0) return { ok: false, why: 'Give at least one GSTIN, phone or bank account — a name alone matches nothing.' };
  if (gstins.some((g) => normalGstin(g).length !== 15)) return { ok: false, why: 'A GSTIN is 15 letters and digits.' };
  if (phones.some((p) => normalPhone(p).length < 8)) return { ok: false, why: 'A phone number needs at least 8 digits.' };
  if (accounts.some((a) => normalAccount(a).length < 4)) return { ok: false, why: 'A bank account reference needs at least 4 letters or digits.' };
  return {
    ok: true,
    party: {
      partyId: partyId.trim(), name: (b['name'] as string).trim(), kind: b['kind'], relation: (b['relation'] as string).trim(),
      gstins: gstins.map(normalGstin), phones: phones.map(normalPhone), bankAccountRefs: accounts.map(normalAccount),
      active: b['active'] !== false,
    },
  };
}

/** An entry as a person may see it on a screen: the phones and bank accounts masked (a relative's number is personal data). */
export function shownParty(p: RelatedParty): RelatedParty {
  return { ...p, phones: p.phones.map(maskedPhone), bankAccountRefs: p.bankAccountRefs.map(maskedAccount) };
}
