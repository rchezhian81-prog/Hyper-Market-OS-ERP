// Domain event envelope for SRE Retail OS.
//
// Requirement: §30.2 (domain events are the integration backbone) and §31.1
// (idempotent, dedupe-able — conflicts become exceptions, never last-write-wins).
// Every state change publishes an event with this shape; consumers dedupe on
// `idempotencyKey`. The `id` and `occurredAt` are supplied by the caller
// (injected), so this module stays pure and deterministic and can be tested
// without a clock or a random source.

export interface DomainEvent<TType extends string = string, TPayload = unknown> {
  /** Globally unique event id (offline-safe). */
  readonly id: string;
  /** Event type, e.g. "SaleCommitted". */
  readonly type: TType;
  /** ISO-8601 UTC timestamp, e.g. "2026-08-02T09:30:00Z". */
  readonly occurredAt: string;
  /** Dedupe key — replay collapses to one effect (§31.1). */
  readonly idempotencyKey: string;
  /** Originating context/lane/service. */
  readonly source: string;
  /** Payload schema version (>= 1). */
  readonly version: number;
  /** Event payload. */
  readonly payload: TPayload;
}

/** §30.2 domain events confirmed in the Store-Core specs (grows per module). */
export const KNOWN_EVENT_TYPES = [
  'SaleCommitted',
  'ReturnAccepted',
  'RefundCompleted',
  'RefundFailed',
  'TenderAuthorized',
  'TenderUncertain',
  'TenderSettled',
  'GoodsReceived',
  'InventoryMoved',
  'InventoryAdjusted',
  'TillClosed',
  'ReconciliationExceptionRaised',
  'ReconciliationExceptionResolved',
  'PeriodClosed',
  'PeriodReopened',
] as const;
export type KnownEventType = (typeof KNOWN_EVENT_TYPES)[number];
export const isKnownEventType = (v: string): v is KnownEventType =>
  (KNOWN_EVENT_TYPES as readonly string[]).includes(v);

const ISO_UTC = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/;

/** True if `s` is an ISO-8601 UTC ("Z") timestamp this system accepts. */
export function isIsoUtcTimestamp(s: string): boolean {
  return ISO_UTC.test(s) && !Number.isNaN(Date.parse(s));
}

export interface DomainEventInput<TType extends string, TPayload> {
  readonly id: string;
  readonly type: TType;
  readonly occurredAt: string;
  readonly idempotencyKey: string;
  readonly source: string;
  readonly payload: TPayload;
  /** Defaults to 1. */
  readonly version?: number;
}

function requireNonEmpty(field: string, value: string): void {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new RangeError(`Event ${field} must be a non-empty string.`);
  }
}

/**
 * Build a validated, immutable DomainEvent from caller-supplied fields. Throws on
 * any missing or invalid field, so a malformed event can never be published.
 * `version` defaults to 1. The envelope is frozen (the payload is the caller's).
 */
export function makeEvent<TType extends string, TPayload>(
  input: DomainEventInput<TType, TPayload>,
): DomainEvent<TType, TPayload> {
  requireNonEmpty('id', input.id);
  requireNonEmpty('type', input.type);
  requireNonEmpty('idempotencyKey', input.idempotencyKey);
  requireNonEmpty('source', input.source);
  if (!isIsoUtcTimestamp(input.occurredAt)) {
    throw new RangeError(`occurredAt must be an ISO-8601 UTC timestamp, got "${input.occurredAt}".`);
  }
  const version = input.version ?? 1;
  if (!Number.isSafeInteger(version) || version < 1) {
    throw new RangeError(`version must be an integer >= 1, got ${version}.`);
  }
  return Object.freeze({
    id: input.id,
    type: input.type,
    occurredAt: input.occurredAt,
    idempotencyKey: input.idempotencyKey,
    source: input.source,
    version,
    payload: input.payload,
  });
}
