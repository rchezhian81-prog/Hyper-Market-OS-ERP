// C6 (v2.1 addendum · M16/M32 · DPDP Act 2023 s.8(2)) — the DATA-PROCESSOR CONTRACT REGISTER.
//
// The law lets the shop hand personal data to a processor (an SMS gateway, a payment aggregator, a delivery partner,
// an accountant's software) only under a valid contract. So every vendor that processes the shop's personal data has
// an entry in this register, and every entry carries the reference of the contract it processes under. A vendor seen
// processing personal data with no entry — or with an entry but no contract reference, an expired contract, or data
// the entry does not cover — is FLAGGED: a visible exception for a person, never a silent pass (P-03, P-08).
//
// This module is the rule, not the evidence of processing. What counts as "processing" is supplied by the caller from
// what the system really does: the integration adapters registered for categories that carry personal data, and the
// processors the shop has sent erasure notices to (`processor-erasure-notice.ts`). A register entry is a fact recorded
// by a person and kept append-only by the caller; a change is a new entry, the latest per vendor applies (hard rule #2).
//
// Pure and deterministic: the date is passed in.

/** One vendor's entry: who they are, what personal data they process, why, and under which contract. */
export interface ProcessorContractEntry {
  /** Stable id for the vendor. Matched against processing evidence by id, and by name (case- and space-insensitive). */
  readonly vendorId: string;
  readonly vendorName: string;
  /** The personal-data categories the contract covers (the same words the erasure plan uses). */
  readonly dataCategories: readonly string[];
  /** What the vendor processes the data FOR, in words. */
  readonly purpose: string;
  /** The contract's own reference — a document number or vault/document id. Required: no reference, no entry. */
  readonly contractRef: string;
  /** YYYY-MM-DD the contract took effect. */
  readonly contractFrom: string;
  /** YYYY-MM-DD the contract ends, when it has an end. */
  readonly contractUntil?: string;
  readonly recordedBy: string;
  readonly recordedAt: string;
}

export type ProcessorEntryRefusal =
  | 'vendor_missing'
  | 'contract_reference_missing'
  | 'categories_missing'
  | 'purpose_missing'
  | 'dates_unreadable'
  | 'contract_ends_before_it_starts';

const isDate = (s: unknown): s is string => typeof s === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(s) && !Number.isNaN(Date.parse(`${s}T00:00:00Z`));

/** Validate an entry before it is recorded. Every problem at once; an entry without a contract reference is refused. */
export function validateProcessorEntry(e: Omit<ProcessorContractEntry, 'recordedBy' | 'recordedAt'>): {
  readonly ok: boolean;
  readonly problems: readonly { readonly code: ProcessorEntryRefusal; readonly detail: string }[];
} {
  const problems: { code: ProcessorEntryRefusal; detail: string }[] = [];
  if (e.vendorId.trim() === '' || e.vendorName.trim() === '') problems.push({ code: 'vendor_missing', detail: 'an entry names the vendor: an id and a name' });
  if (e.contractRef.trim() === '') problems.push({ code: 'contract_reference_missing', detail: 'an entry needs the reference of the contract the vendor processes personal data under — without one there is nothing to register' });
  if (e.dataCategories.length === 0 || e.dataCategories.some((c) => c.trim() === '')) problems.push({ code: 'categories_missing', detail: 'an entry lists the personal-data categories the contract covers' });
  if (e.purpose.trim() === '') problems.push({ code: 'purpose_missing', detail: 'an entry says what the vendor processes the data for' });
  if (!isDate(e.contractFrom) || (e.contractUntil !== undefined && !isDate(e.contractUntil))) {
    problems.push({ code: 'dates_unreadable', detail: 'contract dates are YYYY-MM-DD' });
  } else if (e.contractUntil !== undefined && e.contractUntil < e.contractFrom) {
    problems.push({ code: 'contract_ends_before_it_starts', detail: `the contract ends ${e.contractUntil}, before it starts ${e.contractFrom}` });
  }
  return { ok: problems.length === 0, problems };
}

/** Evidence that a vendor processes the shop's personal data — where the system saw it, and which categories. */
export interface ProcessingActivity {
  /** The vendor, as the evidence names it (an adapter's vendor, a processor's name). */
  readonly vendorName: string;
  /** The vendor's id, when the evidence carries one (a processor id). */
  readonly vendorId?: string;
  /** Where it was seen: e.g. `integration-adapter:<adapterId>`, `erasure-notice:<processorId>`. */
  readonly seenIn: string;
  /** The personal-data categories it handles, when the evidence knows them. Empty = unknown, so not compared. */
  readonly dataCategories: readonly string[];
}

export type ProcessorFlag =
  /** Processing seen, and no register entry for the vendor at all. */
  | 'processing_without_a_register_entry'
  /** An entry exists, but its contract has not started or has ended on the date checked. */
  | 'contract_not_in_force'
  /** The vendor handles a category the contract does not cover. */
  | 'category_not_covered_by_the_contract';

export interface ProcessorRegisterFinding {
  readonly flag: ProcessorFlag;
  readonly vendorName: string;
  readonly vendorId?: string;
  readonly seenIn: string;
  readonly categories?: readonly string[];
  readonly detail: string;
}

export interface ProcessorRegisterCheck {
  /** True only when every vendor seen processing personal data has an entry, with a contract in force covering it. */
  readonly compliant: boolean;
  readonly asOf: string;
  readonly entries: number;
  readonly vendorsSeen: number;
  readonly findings: readonly ProcessorRegisterFinding[];
  readonly detail: string;
}

const key = (name: string): string => name.toLowerCase().replace(/\s+/g, ' ').trim();

/** The latest entry per vendor — the register is append-only, a change is a newer entry. */
export function latestProcessorEntries(entries: readonly ProcessorContractEntry[]): readonly ProcessorContractEntry[] {
  const byId = new Map<string, ProcessorContractEntry>();
  for (const e of [...entries].sort((a, b) => a.recordedAt.localeCompare(b.recordedAt))) byId.set(e.vendorId, e);
  return [...byId.values()].sort((a, b) => a.vendorId.localeCompare(b.vendorId));
}

/**
 * Check the register against what the system really does. Every vendor seen processing personal data must have an
 * entry (matched by id, else by name), whose contract is in force on `asOf` and covers every category it handles.
 * Each gap is a named finding; nothing is fixed here — the fix is a person recording the contract.
 */
export function checkProcessorRegister(input: {
  readonly entries: readonly ProcessorContractEntry[];
  readonly activities: readonly ProcessingActivity[];
  /** YYYY-MM-DD. */
  readonly asOf: string;
}): ProcessorRegisterCheck {
  const latest = latestProcessorEntries(input.entries);
  const byId = new Map(latest.map((e) => [e.vendorId, e]));
  const byName = new Map(latest.map((e) => [key(e.vendorName), e]));
  const findings: ProcessorRegisterFinding[] = [];
  const seen = new Set<string>();

  const activities = [...input.activities].sort((a, b) => key(a.vendorName).localeCompare(key(b.vendorName)) || a.seenIn.localeCompare(b.seenIn));
  for (const a of activities) {
    const entry = (a.vendorId === undefined ? undefined : byId.get(a.vendorId)) ?? byName.get(key(a.vendorName));
    seen.add(entry?.vendorId ?? `name:${key(a.vendorName)}`);
    const who = { vendorName: a.vendorName, ...(a.vendorId === undefined ? {} : { vendorId: a.vendorId }), seenIn: a.seenIn };
    if (entry === undefined) {
      findings.push({
        ...who, flag: 'processing_without_a_register_entry',
        detail: `${a.vendorName} processes the shop's personal data (${a.seenIn}) with no entry in the processor register — record its contract reference, or stop the processing`,
      });
      continue;
    }
    if (input.asOf < entry.contractFrom || (entry.contractUntil !== undefined && input.asOf > entry.contractUntil)) {
      findings.push({
        ...who, flag: 'contract_not_in_force',
        detail: `${a.vendorName}'s contract ${entry.contractRef} runs ${entry.contractFrom} to ${entry.contractUntil ?? 'open-ended'}, and is not in force on ${input.asOf} — renew it or stop the processing`,
      });
      continue;
    }
    const uncovered = a.dataCategories.filter((c) => !entry.dataCategories.includes(c)).sort();
    if (uncovered.length > 0) {
      findings.push({
        ...who, flag: 'category_not_covered_by_the_contract', categories: uncovered,
        detail: `${a.vendorName} handles ${uncovered.join(', ')}, which contract ${entry.contractRef} does not cover`,
      });
    }
  }

  const compliant = findings.length === 0;
  return {
    compliant,
    asOf: input.asOf,
    entries: latest.length,
    vendorsSeen: seen.size,
    findings,
    detail: compliant
      ? `${seen.size} vendor(s) seen processing personal data; each has a register entry with a contract in force covering what it handles`
      : `${findings.length} processor finding(s): personal data is being processed outside a registered, in-force contract`,
  };
}
