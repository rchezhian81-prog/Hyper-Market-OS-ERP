// Customer duplicate detection (M16-FR-01) — one customer truth (P-02). Two records
// for the same person should be found, but an UNCERTAIN match is a REVIEW EXCEPTION,
// never an auto-merge (P-08 / §31.1): a merge is a governed, reversible, audited act
// (§28), so this engine only proposes. A shared VERIFIED phone/email is a
// high-confidence merge candidate; a shared unverified contact or just a matching
// name is low-confidence and goes to review. Pure and deterministic; PII is compared
// via normalized values only.

export interface CustomerRecord {
  readonly customerId: string;
  readonly phone?: string;
  readonly phoneVerified?: boolean;
  readonly email?: string;
  readonly emailVerified?: boolean;
  readonly name?: string;
}

export type MatchSignal = 'verified_phone' | 'verified_email' | 'unverified_contact' | 'name';
export type MatchConfidence = 'high' | 'low';

export interface DuplicateMatch {
  readonly customerIds: readonly [string, string];
  readonly matchedOn: MatchSignal;
  readonly confidence: MatchConfidence;
  /** High-confidence → a merge candidate (still governed); low → review only. Never auto-merge. */
  readonly disposition: 'merge_candidate' | 'review';
}

function normPhone(v: string | undefined): string | undefined {
  if (v === undefined) return undefined;
  const digits = v.replace(/\D/g, '');
  return digits === '' ? undefined : digits;
}

function normText(v: string | undefined): string | undefined {
  if (v === undefined) return undefined;
  const t = v.trim().toLowerCase().replace(/\s+/g, ' ');
  return t === '' ? undefined : t;
}

/** The strongest match signal between two records, or null if they don't match. */
function matchPair(a: CustomerRecord, b: CustomerRecord): { signal: MatchSignal; confidence: MatchConfidence } | null {
  const aPhone = normPhone(a.phone);
  const bPhone = normPhone(b.phone);
  const aEmail = normText(a.email);
  const bEmail = normText(b.email);

  if (aPhone !== undefined && aPhone === bPhone && a.phoneVerified && b.phoneVerified) {
    return { signal: 'verified_phone', confidence: 'high' };
  }
  if (aEmail !== undefined && aEmail === bEmail && a.emailVerified && b.emailVerified) {
    return { signal: 'verified_email', confidence: 'high' };
  }
  if ((aPhone !== undefined && aPhone === bPhone) || (aEmail !== undefined && aEmail === bEmail)) {
    return { signal: 'unverified_contact', confidence: 'low' };
  }
  const aName = normText(a.name);
  const bName = normText(b.name);
  if (aName !== undefined && aName === bName) {
    return { signal: 'name', confidence: 'low' };
  }
  return null;
}

/**
 * Detect duplicate customer pairs among a candidate set. High-confidence pairs are
 * `merge_candidate`s (still governed); low-confidence pairs are `review` exceptions.
 * Nothing is ever auto-merged. Deterministic: pairs ordered high-confidence first,
 * then by customer id.
 */
export function detectDuplicateCustomers(customers: readonly CustomerRecord[]): DuplicateMatch[] {
  const matches: DuplicateMatch[] = [];
  for (let i = 0; i < customers.length; i += 1) {
    for (let j = i + 1; j < customers.length; j += 1) {
      const a = customers[i]!;
      const b = customers[j]!;
      const m = matchPair(a, b);
      if (m === null) continue;
      const ids: [string, string] =
        a.customerId < b.customerId ? [a.customerId, b.customerId] : [b.customerId, a.customerId];
      matches.push({
        customerIds: ids,
        matchedOn: m.signal,
        confidence: m.confidence,
        disposition: m.confidence === 'high' ? 'merge_candidate' : 'review',
      });
    }
  }
  return matches.sort((x, y) => {
    if (x.confidence !== y.confidence) return x.confidence === 'high' ? -1 : 1;
    if (x.customerIds[0] !== y.customerIds[0]) return x.customerIds[0] < y.customerIds[0] ? -1 : 1;
    return x.customerIds[1] < y.customerIds[1] ? -1 : x.customerIds[1] > y.customerIds[1] ? 1 : 0;
  });
}
