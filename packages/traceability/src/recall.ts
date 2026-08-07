// Recall (M10-FR-04) — initiate a recall on a batch, BLOCK its sale everywhere
// (including offline, honoured from the cached recall set), and close only with
// evidence. The recall block is immediate: once a batch is recalled, a sale of it is
// refused at the POS even with the network cable out (M10-FR-04 acceptance). Recall
// records and their evidence are NEVER deleted (hard rule #6): closing marks the
// recall closed but retains the full record. Storage-agnostic (in-memory here; a
// durable/cached store slots in later, like the ledger).

export interface RecallRecord {
  readonly batchId: string;
  readonly reason: string;
  readonly initiatedBy: string;
  readonly initiatedAt: string;
  readonly status: 'open' | 'closed';
  readonly closedBy: string | null;
  readonly closedAt: string | null;
  /** Closure evidence reference — required to close (P-04). */
  readonly evidenceRef: string | null;
}

export class RecalledBatchError extends Error {
  constructor(batchId: string) {
    super(`Batch "${batchId}" is under recall and cannot be sold (M10-FR-04) — even offline.`);
    this.name = 'RecalledBatchError';
  }
}

export class MissingRecallEvidenceError extends Error {
  constructor(batchId: string) {
    super(`Recall on batch "${batchId}" can only be closed with evidence (M10-FR-04 / hard rule #6).`);
    this.name = 'MissingRecallEvidenceError';
  }
}

export interface InitiateRecallInput {
  readonly batchId: string;
  readonly reason: string;
  readonly initiatedBy: string;
  readonly at: string;
}

export interface CloseRecallInput {
  readonly batchId: string;
  readonly closedBy: string;
  readonly evidenceRef: string;
  readonly at: string;
}

/** A registry of recalls. Recall records are retained forever; a close never deletes. */
export class RecallRegistry {
  private readonly records = new Map<string, RecallRecord>();

  /** Initiate (or re-affirm) a recall on a batch; the block is immediate. Idempotent. */
  initiate(input: InitiateRecallInput): RecallRecord {
    const existing = this.records.get(input.batchId);
    if (existing !== undefined && existing.status === 'open') {
      return existing; // already under recall — one effect
    }
    const record: RecallRecord = Object.freeze({
      batchId: input.batchId,
      reason: input.reason,
      initiatedBy: input.initiatedBy,
      initiatedAt: input.at,
      status: 'open',
      closedBy: null,
      closedAt: null,
      evidenceRef: null,
    });
    this.records.set(input.batchId, record);
    return record;
  }

  /** True while a batch has an OPEN recall (used to block sale, offline-safe). */
  isRecalled(batchId: string): boolean {
    return this.records.get(batchId)?.status === 'open';
  }

  /** Throw if the batch is under recall — the POS guard (M10-FR-04). */
  assertSellable(batchId: string): void {
    if (this.isRecalled(batchId)) {
      throw new RecalledBatchError(batchId);
    }
  }

  /** Close a recall — only with evidence; the record is retained, never deleted. */
  close(input: CloseRecallInput): RecallRecord {
    if (typeof input.evidenceRef !== 'string' || input.evidenceRef.trim() === '') {
      throw new MissingRecallEvidenceError(input.batchId);
    }
    const existing = this.records.get(input.batchId);
    if (existing === undefined || existing.status !== 'open') {
      throw new RecalledBatchError(input.batchId); // nothing open to close
    }
    const closed: RecallRecord = Object.freeze({
      ...existing,
      status: 'closed',
      closedBy: input.closedBy,
      closedAt: input.at,
      evidenceRef: input.evidenceRef,
    });
    this.records.set(input.batchId, closed);
    return closed;
  }

  /** All open recalls — the set a POS caches to enforce blocks offline. */
  openRecalls(): RecallRecord[] {
    return [...this.records.values()].filter((r) => r.status === 'open');
  }

  /** Look up any recall record (open or closed) — evidence is retained. */
  find(batchId: string): RecallRecord | undefined {
    return this.records.get(batchId);
  }
}
