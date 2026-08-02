// Shared domain vocabularies and universal UI states for SRE Retail OS.
//
// Requirement: the fixed value sets from `db/data-dictionary/*` and the §27.1
// universal states. Each set is the single source of truth for its allowed
// values, with a runtime guard so external or parsed data can be validated
// before it enters the system.

/** True if `value` is one of `allowed`. */
export function isMember<T extends string>(allowed: readonly T[], value: string): value is T {
  return (allowed as readonly string[]).includes(value);
}

/** Tender kinds (`db/data-dictionary/pos-cash.md`, M12-FR-03). */
export const TENDER_KINDS = ['cash', 'card', 'upi', 'store_credit', 'split'] as const;
export type TenderKind = (typeof TENDER_KINDS)[number];
export const isTenderKind = (v: string): v is TenderKind => isMember(TENDER_KINDS, v);

/** Tender lifecycle — never a fake approval (M12-FR-03). */
export const TENDER_STATUSES = ['pending', 'authorized', 'uncertain', 'settled', 'declined'] as const;
export type TenderStatus = (typeof TENDER_STATUSES)[number];
export const isTenderStatus = (v: string): v is TenderStatus => isMember(TENDER_STATUSES, v);

/** Sale status (M12). */
export const SALE_STATUSES = ['completed', 'suspended', 'voided'] as const;
export type SaleStatus = (typeof SALE_STATUSES)[number];
export const isSaleStatus = (v: string): v is SaleStatus => isMember(SALE_STATUSES, v);

/** Stock states (M08-FR-02). Availability excludes all but on_hand per policy. */
export const STOCK_STATES = [
  'on_hand',
  'reserved',
  'quarantine',
  'damaged',
  'expired',
  'in_transit',
] as const;
export type StockState = (typeof STOCK_STATES)[number];
export const isStockState = (v: string): v is StockState => isMember(STOCK_STATES, v);

/** Maker-checker decision (M02). */
export const APPROVAL_DECISIONS = ['pending', 'approved', 'rejected'] as const;
export type ApprovalDecision = (typeof APPROVAL_DECISIONS)[number];
export const isApprovalDecision = (v: string): v is ApprovalDecision =>
  isMember(APPROVAL_DECISIONS, v);

/** Record lifecycle (§27.1). */
export const RECORD_LIFECYCLE = [
  'draft',
  'pending_approval',
  'approved',
  'rejected',
  'cancelled',
  'failed',
  'retrying',
  'completed',
  'archived',
] as const;
export type RecordLifecycle = (typeof RECORD_LIFECYCLE)[number];
export const isRecordLifecycle = (v: string): v is RecordLifecycle => isMember(RECORD_LIFECYCLE, v);

/** Connection state shown on every transactional surface (§27.1 / P-08). */
export const CONNECTION_STATES = ['online', 'degraded', 'offline', 'reconnecting'] as const;
export type ConnectionState = (typeof CONNECTION_STATES)[number];
export const isConnectionState = (v: string): v is ConnectionState => isMember(CONNECTION_STATES, v);
