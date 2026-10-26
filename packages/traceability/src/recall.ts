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
  /** `withdrawn` (OB-383): started by mistake and withdrawn before any customer was called or any stock disposed of. */
  readonly status: 'open' | 'closed' | 'withdrawn';
  readonly closedBy: string | null;
  readonly closedAt: string | null;
  /** Closure evidence reference — required to close (P-04). */
  readonly evidenceRef: string | null;
  /** OB-383: who withdrew a recall started by mistake, when and why. Absent unless withdrawn. */
  readonly withdrawal?: { readonly withdrawnBy: string; readonly withdrawnAt: string; readonly reason: string };
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

/** Why a recall cannot be withdrawn (OB-383) — each refused by name. */
export type RecallWithdrawRefusal =
  | 'no_open_recall'
  | 'needs_a_reason'
  | 'customers_already_contacted'
  | 'stock_already_disposed';

export class RecallWithdrawRefusedError extends Error {
  constructor(readonly batchId: string, readonly refusal: RecallWithdrawRefusal, detail: string) {
    super(`Recall on batch "${batchId}" cannot be withdrawn (${refusal}): ${detail}`);
    this.name = 'RecallWithdrawRefusedError';
  }
}

export interface WithdrawRecallInput {
  readonly batchId: string;
  readonly withdrawnBy: string;
  readonly reason: string;
  readonly at: string;
  /** How many customers the shop has already contacted about this recall (messages sent or attempted). */
  readonly customersContacted: number;
  /** How much of the batch has already been disposed of (written off / destroyed) since the recall started. */
  readonly stockDisposed: number;
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

  /**
   * OB-383 — withdraw a recall started by mistake. Allowed ONLY while it is open, with a reason, and before any customer
   * has been contacted or any stock disposed of; after that it must be closed with evidence (`close`). The record is
   * retained, marked withdrawn, never deleted (hard rule #6). The block on the batch lifts, as on a closure.
   */
  withdraw(input: WithdrawRecallInput): RecallRecord {
    const existing = this.records.get(input.batchId);
    if (existing === undefined || existing.status !== 'open') {
      throw new RecallWithdrawRefusedError(input.batchId, 'no_open_recall', 'there is no open recall on this batch to withdraw.');
    }
    if (typeof input.reason !== 'string' || input.reason.trim().length < 5) {
      throw new RecallWithdrawRefusedError(input.batchId, 'needs_a_reason', 'say in words why the recall was started by mistake.');
    }
    if (input.customersContacted > 0) {
      throw new RecallWithdrawRefusedError(input.batchId, 'customers_already_contacted',
        `${input.customersContacted} customer(s) have already been contacted about it, so it must be closed with evidence.`);
    }
    if (input.stockDisposed > 0) {
      throw new RecallWithdrawRefusedError(input.batchId, 'stock_already_disposed',
        `${input.stockDisposed} of the batch has already been disposed of, so it must be closed with evidence.`);
    }
    const withdrawn: RecallRecord = Object.freeze({
      ...existing,
      status: 'withdrawn',
      withdrawal: Object.freeze({ withdrawnBy: input.withdrawnBy, withdrawnAt: input.at, reason: input.reason.trim() }),
    });
    this.records.set(input.batchId, withdrawn);
    return withdrawn;
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
