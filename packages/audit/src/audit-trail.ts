// Audit evidence (M34-FR-01 / NFR-15 / SEC-07 / hard rule #6) — the tamper-evident
// memory of the system. Every sensitive action is recorded as an immutable record of
// WHO did WHAT, WHEN, WHERE, and the BEFORE/AFTER state, so the action can be
// reconstructed from evidence alone — never from a screen anyone can change.
//
// Two design decisions carry the requirement:
//
//   1. THE API CANNOT EXPRESS AN EDIT OR A DELETE. There is no update, no remove,
//      no setter. Not for an administrator, not for the owner. The only operation
//      is `record`. A "correction" is a new record that refers to the earlier one.
//
//   2. EACH RECORD SEALS THE ONE BEFORE IT. Every record carries the hash of its
//      predecessor, so the trail is a chain. Change one byte of one record — even
//      directly in the database, behind this code — and `verify()` names the exact
//      record where the chain breaks. That is what "tamper-EVIDENT" means: we do
//      not claim tampering is impossible, we guarantee it is detectable (P-08: no
//      silent failure).
//
// Storage-agnostic (P-06): the caller supplies an append-only store. Pure and
// deterministic — the timestamp is supplied by the caller, this module has no clock.

/**
 * Hashes a record's canonical form. Injected as a port so the chain can be sealed
 * with a real cryptographic digest (SHA-256 from the platform's crypto library) in
 * a deployment, without this package importing one (P-06).
 */
export type Hasher = (input: string) => string;

/** What kind of thing was acted on — free-form so every module can write its own. */
export type AuditObjectType = string;

/** Where the action happened: the evidence must survive an "it wasn't me" argument. */
export interface AuditOrigin {
  readonly tenantId: string;
  readonly branchId: string | null;
  /** Till, device or service that originated the action. */
  readonly deviceId?: string;
  /** Set when the action was taken offline and synced later (§31). */
  readonly capturedOffline?: boolean;
}

/** A sensitive action, as submitted by the module that performed it. */
export interface AuditEntry {
  readonly actorId: string;
  /** What was done, e.g. 'price.change', 'refund.approve', 'role.grant'. */
  readonly action: string;
  readonly objectType: AuditObjectType;
  readonly objectId: string;
  /** ISO-8601 UTC. Supplied by the caller — this module has no clock. */
  readonly at: string;
  readonly origin: AuditOrigin;
  /** State before the change; null when the object is being created. */
  readonly before: Readonly<Record<string, string>> | null;
  /** State after the change; null when the object is being removed. */
  readonly after: Readonly<Record<string, string>> | null;
  /** Why — a reason code or free text, where the action demands one (§28). */
  readonly reason?: string;
  /** The approval that authorised it, where a maker-checker was required (§28). */
  readonly approvalId?: string;
  /** Correlates the action with its domain event / request (§30). */
  readonly correlationId?: string;
}

/** A sealed record: the entry, its position in the chain, and the seal itself. */
export interface AuditRecord extends AuditEntry {
  /** Monotonic position in the trail (1-based). */
  readonly sequence: number;
  /** Hash of the previous record — the empty-string genesis for the first. */
  readonly previousHash: string;
  /** Hash over this record's canonical form, including `previousHash`. */
  readonly hash: string;
}

/**
 * Append-only storage for audit records. Implementations MUST be append-only:
 * there is deliberately no operation here to change or drop a stored record
 * (hard rule #6 — audit evidence is never destroyed).
 */
export interface AuditStore {
  append(record: AuditRecord): void;
  all(): readonly AuditRecord[];
  last(): AuditRecord | undefined;
}

/** The reference in-memory store — used by tests and the store edge. */
export class InMemoryAuditStore implements AuditStore {
  private readonly records: AuditRecord[] = [];

  append(record: AuditRecord): void {
    this.records.push(record);
  }

  all(): readonly AuditRecord[] {
    return this.records.slice();
  }

  last(): AuditRecord | undefined {
    return this.records[this.records.length - 1];
  }
}

/** The seal on the first record: there is nothing before the beginning. */
export const GENESIS_HASH = '';

/**
 * Default integrity hash — a pure-TypeScript FNV-1a 64-bit digest, so the chain
 * works everywhere with no dependency.
 *
 * It detects tampering, accidental corruption and casual editing. It is NOT a
 * cryptographic seal: a determined attacker with write access to the store could
 * forge a matching digest. A deployment injects a real SHA-256 hasher through the
 * `Hasher` port. Saying this plainly is the point — an integrity claim we cannot
 * back would be worse than none (P-08).
 */
export function fnv1a64(input: string): string {
  const prime = 0x100000001b3n;
  const mask = 0xffffffffffffffffn;
  let hash = 0xcbf29ce484222325n;
  for (let i = 0; i < input.length; i += 1) {
    hash ^= BigInt(input.charCodeAt(i));
    hash = (hash * prime) & mask;
  }
  return hash.toString(16).padStart(16, '0');
}

/** Canonical text of a record — stable field order, so the hash is reproducible. */
function canonical(entry: AuditEntry, sequence: number, previousHash: string): string {
  const state = (s: Readonly<Record<string, string>> | null): string =>
    s === null
      ? 'null'
      : Object.keys(s)
          .sort()
          .map((k) => `${k}=${s[k] ?? ''}`)
          .join(';');
  return [
    String(sequence),
    previousHash,
    entry.at,
    entry.actorId,
    entry.action,
    entry.objectType,
    entry.objectId,
    entry.origin.tenantId,
    entry.origin.branchId ?? '',
    entry.origin.deviceId ?? '',
    entry.origin.capturedOffline === true ? 'offline' : 'online',
    entry.reason ?? '',
    entry.approvalId ?? '',
    entry.correlationId ?? '',
    state(entry.before),
    state(entry.after),
  ].join('|');
}

/** Raised when an entry is missing the evidence that makes it evidence. */
export class IncompleteEvidenceError extends Error {
  constructor(public readonly field: string) {
    super(`Audit entry is missing ${field} — an unattributable record is not evidence`);
    this.name = 'IncompleteEvidenceError';
  }
}

/** Where the chain first fails to verify, and why. */
export interface TamperFinding {
  readonly sequence: number;
  readonly reason: 'hash_mismatch' | 'broken_link' | 'sequence_gap';
  readonly detail: string;
}

/** The result of checking the whole trail (M34-FR-01 acceptance). */
export interface VerifyResult {
  readonly intact: boolean;
  readonly recordsChecked: number;
  /** Empty when intact; otherwise every place the evidence does not hold up. */
  readonly findings: readonly TamperFinding[];
}

/** Narrow the trail down: by actor, object, action or period (M34-FR-02). */
export interface AuditQuery {
  readonly actorId?: string;
  readonly objectType?: AuditObjectType;
  readonly objectId?: string;
  readonly action?: string;
  readonly tenantId?: string;
  readonly branchId?: string;
  /** Inclusive ISO-8601 lower bound. */
  readonly from?: string;
  /** Exclusive ISO-8601 upper bound. */
  readonly until?: string;
}

/**
 * The append-only, tamper-evident audit trail.
 *
 * Deliberately absent: any method to change or drop a record. That omission is the
 * requirement (M34-FR-01: it must be impossible for any user, including the owner,
 * to edit the audit log).
 */
export class AuditTrail {
  constructor(
    private readonly store: AuditStore,
    private readonly hasher: Hasher = fnv1a64,
  ) {}

  /**
   * Seal a sensitive action into the trail and return the stored record.
   * Refuses an entry that could not later be relied on as evidence.
   */
  record(entry: AuditEntry): AuditRecord {
    if (entry.actorId.trim() === '') {
      throw new IncompleteEvidenceError('an actor');
    }
    if (entry.action.trim() === '') {
      throw new IncompleteEvidenceError('an action');
    }
    if (entry.objectId.trim() === '') {
      throw new IncompleteEvidenceError('the object it acted on');
    }
    if (entry.at.trim() === '') {
      throw new IncompleteEvidenceError('a timestamp');
    }
    if (entry.before === null && entry.after === null) {
      throw new IncompleteEvidenceError('a before or after state');
    }

    const previous = this.store.last();
    const sequence = (previous?.sequence ?? 0) + 1;
    const previousHash = previous?.hash ?? GENESIS_HASH;
    const record: AuditRecord = {
      ...entry,
      sequence,
      previousHash,
      hash: this.hasher(canonical(entry, sequence, previousHash)),
    };
    this.store.append(record);
    return record;
  }

  /** Every record, in the order they happened. */
  all(): readonly AuditRecord[] {
    return this.store.all();
  }

  /** Search the evidence — by actor, object, action, scope or period (M34-FR-02). */
  search(query: AuditQuery): readonly AuditRecord[] {
    return this.store.all().filter((r) => {
      if (query.actorId !== undefined && r.actorId !== query.actorId) return false;
      if (query.objectType !== undefined && r.objectType !== query.objectType) return false;
      if (query.objectId !== undefined && r.objectId !== query.objectId) return false;
      if (query.action !== undefined && r.action !== query.action) return false;
      if (query.tenantId !== undefined && r.origin.tenantId !== query.tenantId) return false;
      if (query.branchId !== undefined && r.origin.branchId !== query.branchId) return false;
      if (query.from !== undefined && r.at < query.from) return false;
      if (query.until !== undefined && r.at >= query.until) return false;
      return true;
    });
  }

  /**
   * Rebuild an object's state from the evidence alone (NFR-15) — replaying every
   * recorded before/after in order. Returns the reconstructed final state and the
   * chain of changes that produced it, so "how did this price get here?" is
   * answerable without trusting any screen.
   */
  reconstruct(
    objectType: AuditObjectType,
    objectId: string,
  ): {
    readonly state: Readonly<Record<string, string>> | null;
    readonly history: readonly AuditRecord[];
  } {
    const history = this.search({ objectType, objectId });
    let state: Record<string, string> | null = null;
    for (const record of history) {
      state = record.after === null ? null : { ...record.after };
    }
    return { state, history };
  }

  /**
   * Check the whole trail (M34-FR-01 acceptance). Reports every break rather than
   * the first, so an auditor sees the full extent of a problem, not a hint of one.
   */
  verify(): VerifyResult {
    const records = this.store.all();
    const findings: TamperFinding[] = [];
    let expectedPrevious = GENESIS_HASH;

    records.forEach((record, index) => {
      if (record.sequence !== index + 1) {
        findings.push({
          sequence: record.sequence,
          reason: 'sequence_gap',
          detail: `expected sequence ${index + 1}, found ${record.sequence} — a record is missing or out of order`,
        });
      }
      if (record.previousHash !== expectedPrevious) {
        findings.push({
          sequence: record.sequence,
          reason: 'broken_link',
          detail: 'this record does not follow on from the one before it',
        });
      }
      const recomputed = this.hasher(canonical(record, record.sequence, record.previousHash));
      if (recomputed !== record.hash) {
        findings.push({
          sequence: record.sequence,
          reason: 'hash_mismatch',
          detail: 'the contents of this record no longer match its seal',
        });
      }
      expectedPrevious = record.hash;
    });

    return { intact: findings.length === 0, recordsChecked: records.length, findings };
  }
}
