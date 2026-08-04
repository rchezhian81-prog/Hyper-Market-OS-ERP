// Field, code, UOM, tax, department and identity mapping — MG-03 (§34, hard rule #6).
//
// The step where a migration quietly acquires a tax bill.
//
// Legacy tax code `TX` appears on nine products. It meant something in 2014 to somebody who has
// left. The convenient line of code is `taxCode ?? 'T0'`, and it works: the load succeeds, no
// error appears, and nine products are now zero-rated. Nobody finds out until an assessment.
//
//   • **AN UNMAPPED VALUE IS AN EXCEPTION, NEVER A DEFAULT.** There is no fallback parameter on
//     `mapValue`, deliberately — a default is how an unmapped tax code becomes zero-rated, an
//     unmapped UOM becomes `EA` on a weighed product, and an unmapped department becomes
//     whichever one sorts first.
//   • **A MAPPING IS APPROVED BY A PERSON, WITH A DATE.** An unapproved mapping is drafted, not
//     usable. `resolveMappings` refuses to run against a draft, because a mapping table is a set
//     of accounting decisions wearing the costume of a configuration file.
//   • **TWO LEGACY CODES MAY MEAN THE SAME THING; ONE MAY NEVER MEAN TWO.** Many-to-one is
//     normal and expected. One-to-many is a contradiction, and it is refused at approval rather
//     than resolved arbitrarily at load.
//   • **COVERAGE IS REPORTED AGAINST THE SOURCE, NOT THE TABLE.** *"142 mappings approved"*
//     says nothing. *"9 products carry a code no mapping covers"* is the fact that matters, and
//     it can only be computed against the values actually present in the extract.
//
// Pure and deterministic: the clock is injected, no I/O.

export type MappingDomain =
  | 'tax_code'
  | 'uom'
  | 'department'
  | 'account'
  | 'branch'
  | 'identity'
  | 'document_kind';

export interface MappingEntry {
  readonly domain: MappingDomain;
  readonly legacyValue: string;
  readonly targetValue: string;
  /** Why this legacy value means this target value. Read at an assessment, years later. */
  readonly rationale: string;
}

export type MappingStatus = 'draft' | 'approved' | 'superseded';

export interface MappingTable {
  readonly mappingId: string;
  readonly tenantId: string;
  readonly version: number;
  readonly status: MappingStatus;
  readonly entries: readonly MappingEntry[];
  readonly approvedBy?: string;
  readonly approvedAt?: string;
  readonly supersededBy?: string;
}

export type ApprovalRefusal =
  | 'no_approver'
  | 'already_approved'
  | 'one_legacy_value_two_targets'
  | 'no_rationale'
  | 'empty_table';

export interface ApprovalResult {
  readonly ok: boolean;
  readonly table?: MappingTable;
  readonly refusedBecause?: ApprovalRefusal;
  /** Named, not counted — a conflict report saying "3 conflicts" cannot be acted on. */
  readonly conflicts: readonly string[];
  readonly detail: string;
}

const key = (e: Pick<MappingEntry, 'domain' | 'legacyValue'>): string => `${e.domain}:${e.legacyValue}`;

/**
 * Approve a mapping table, refusing the contradiction that cannot be resolved at load time.
 *
 * One legacy value mapping to two different targets is not a preference to settle with a
 * tie-break; it means two people disagree about what the code meant, and a load that picks one
 * silently makes that disagreement permanent and invisible.
 */
export function approveMapping(input: {
  readonly table: MappingTable;
  readonly approvedBy: string;
  readonly now: string;
}): ApprovalResult {
  const t = input.table;

  if (t.status === 'approved') {
    return {
      ok: false, refusedBecause: 'already_approved', conflicts: [],
      detail: `mapping ${t.mappingId} v${t.version} is already approved — a change is a new version, so the version that was loaded stays readable`,
    };
  }
  if (input.approvedBy.trim() === '') {
    return {
      ok: false, refusedBecause: 'no_approver', conflicts: [],
      detail: 'a mapping table is a set of accounting decisions — it is approved by a person, or it is not approved',
    };
  }
  if (t.entries.length === 0) {
    return {
      ok: false, refusedBecause: 'empty_table', conflicts: [],
      detail: 'an empty mapping table approves nothing and maps everything to an exception',
    };
  }

  const missingRationale = t.entries
    .filter((e) => e.rationale.trim() === '')
    .map((e) => key(e));
  if (missingRationale.length > 0) {
    return {
      ok: false, refusedBecause: 'no_rationale', conflicts: missingRationale,
      detail: `${missingRationale.length} entries carry no rationale — the question at an assessment is not what the mapping was, it is why`,
    };
  }

  const targetsByLegacy = new Map<string, Set<string>>();
  for (const e of t.entries) {
    const set = targetsByLegacy.get(key(e)) ?? new Set<string>();
    set.add(e.targetValue);
    targetsByLegacy.set(key(e), set);
  }
  const conflicts = [...targetsByLegacy.entries()]
    .filter(([, targets]) => targets.size > 1)
    .map(([k, targets]) => `${k} → ${[...targets].sort().join(' / ')}`)
    .sort();

  if (conflicts.length > 0) {
    return {
      ok: false, refusedBecause: 'one_legacy_value_two_targets', conflicts,
      detail: 'one legacy value cannot mean two things — two people disagree about what the code meant, and a load that picks one silently makes that disagreement permanent',
    };
  }

  return {
    ok: true,
    table: { ...t, status: 'approved', approvedBy: input.approvedBy, approvedAt: input.now },
    conflicts: [],
    detail: `mapping ${t.mappingId} v${t.version} approved with ${t.entries.length} entries by ${input.approvedBy}`,
  };
}

export interface MapValueResult {
  readonly mapped: boolean;
  readonly targetValue?: string;
  readonly detail: string;
}

/**
 * Map one legacy value.
 *
 * **There is no fallback parameter, and that is the whole design.** A caller who wants a default
 * has to write it themselves, in the open, where a reviewer can see it — rather than passing
 * `'T0'` as a third argument that reads like a convenience.
 */
export function mapValue(input: {
  readonly table: MappingTable;
  readonly domain: MappingDomain;
  readonly legacyValue: string;
}): MapValueResult {
  if (input.table.status !== 'approved') {
    return { mapped: false, detail: `mapping ${input.table.mappingId} is ${input.table.status}, not approved — a draft mapping is a proposal` };
  }
  const hit = input.table.entries.find(
    (e) => e.domain === input.domain && e.legacyValue === input.legacyValue,
  );
  if (hit === undefined) {
    return {
      mapped: false,
      detail: `no approved mapping for ${input.domain} "${input.legacyValue}" — this is an exception, and defaulting it is how nine products become zero-rated`,
    };
  }
  return { mapped: true, targetValue: hit.targetValue, detail: `${input.legacyValue} → ${hit.targetValue}` };
}

export interface MappingCoverage {
  readonly domain: MappingDomain;
  readonly distinctValues: number;
  readonly covered: number;
  readonly uncovered: readonly string[];
  /** How many source ROWS carry an uncovered value — the size of the problem, not its variety. */
  readonly affectedRows: number;
}

export interface CoverageReport {
  readonly tenantId: string;
  readonly byDomain: readonly MappingCoverage[];
  readonly fullyCovered: boolean;
  readonly totalAffectedRows: number;
  readonly detail: string;
}

/**
 * Coverage measured against the values **actually present in the extract**.
 *
 * A mapping table is complete relative to a source or it is not complete at all. Counting the
 * table's own entries answers a question nobody asked.
 */
export function assessCoverage(input: {
  readonly tenantId: string;
  readonly table: MappingTable;
  /** Every value observed in the source, with how many rows carry it. */
  readonly observed: readonly { readonly domain: MappingDomain; readonly value: string; readonly rows: number }[];
}): CoverageReport {
  const domains = [...new Set(input.observed.map((o) => o.domain))].sort();
  const byDomain: MappingCoverage[] = [];

  for (const domain of domains) {
    const values = input.observed.filter((o) => o.domain === domain);
    const uncoveredEntries = values.filter(
      (o) => !mapValue({ table: input.table, domain, legacyValue: o.value }).mapped,
    );
    byDomain.push({
      domain,
      distinctValues: values.length,
      covered: values.length - uncoveredEntries.length,
      uncovered: uncoveredEntries.map((o) => o.value).sort(),
      affectedRows: uncoveredEntries.reduce((t, o) => t + o.rows, 0),
    });
  }

  const totalAffectedRows = byDomain.reduce((t, d) => t + d.affectedRows, 0);
  const fullyCovered = byDomain.every((d) => d.uncovered.length === 0);

  return {
    tenantId: input.tenantId,
    byDomain,
    fullyCovered,
    totalAffectedRows,
    detail: fullyCovered
      ? `every observed value in ${domains.length} domains has an approved mapping`
      : `${totalAffectedRows} source rows carry a value no approved mapping covers — each one is an exception, not a default`,
  };
}
