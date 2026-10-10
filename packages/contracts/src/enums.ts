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
/** How a bill is paid. `exchange_credit` is the value of goods coming back applied against a replacement sale on an
 *  EXCHANGE (M13-FR-03) — money that never changes hands, banked as a tender so the replacement's tenders sum to its
 *  total and the day book clears it against the return (`exchange_credit_clearing`). Minted by the cloud exchange
 *  route and, since SP-9b-ii, by the till. */
/** `loyalty_points` is a member's points spent at the till at the owner's point value (PF-09 step 3 · M17-FR-01) — value
 *  that is the shop's liability, never money, decided against the store computer's copy of the balances and the owner's
 *  till spend cap (`packages/loyalty/src/wallet.ts`). */
export const TENDER_KINDS = ['cash', 'card', 'upi', 'store_credit', 'split', 'exchange_credit', 'loyalty_points'] as const;
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
