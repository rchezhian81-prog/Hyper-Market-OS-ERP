// The product-authoring WRITE PATH from the screen (M03-FR-01/03, §31, P-01) — turning the catalogue
// screen's "publish this product" decision into a durable, deduplicated command the sync agent drains to the
// cloud (`POST /v1/catalogue/products/:id/publish`). The screen already VALIDATES a product against the
// tested compliance rules (`createCatalogueSession.publish`); this is the missing half — the Save that
// actually reaches the shared product truth (P-02).
//
// Like every ERP write action (the GST-returns/write-off pattern), the button commits a deterministic
// command to the offline OUTBOX rather than calling the network inline: a click survives a reload and a lost
// connection (§31), and the drain is idempotent. The command carries the PUBLISHED record — the tested
// `publishProduct` runs here first, so a product that does not validate never even queues (every missing
// field named at once), and a draft is promoted to 'new' before it is sent, exactly as the cloud will store it.
//
// Dedupe identity is the CONTENT: publishing the same product+barcodes twice (a double-click, a reload)
// collapses to one command; an edit-then-publish is different content and so a distinct, legitimate command.

import { makeEvent, type DomainEvent } from '../../../packages/contracts/src/event';
import type { SyncOutbox, OutboxState } from '../../../packages/sync/src/outbox';
import {
  publishProduct, NotPublishableError, CategoryNotFoundError,
  type ProductRecord, type Category,
} from '../../../packages/product/src/index';

/** The event type the outbox command carries — the product-authoring write-path identity. */
export const PRODUCT_PUBLISH_EVENT = 'ProductPublishRequested';

/** The command the sync agent drains to the compliance-gated publish route. The categories travel with it
 *  so the cloud validates against the same hierarchy the screen did; the barcodes are assigned alongside. */
export interface ProductPublishPayload {
  readonly product: ProductRecord;
  readonly categories: readonly Category[];
  readonly barcodes: readonly string[];
  /** The authenticated operator who published — recorded for the audit trail. */
  readonly requestedBy: string;
}
export type ProductPublishCommand = DomainEvent<typeof PRODUCT_PUBLISH_EVENT, ProductPublishPayload>;

/** Stable, key-sorted JSON — so the same content always hashes the same, regardless of field insertion
 *  order (a record rebuilt from a form need not preserve key order). */
function canonical(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null';
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  const obj = value as Record<string, unknown>;
  return `{${Object.keys(obj).sort().map((k) => `${JSON.stringify(k)}:${canonical(obj[k])}`).join(',')}}`;
}

/** FNV-1a over the canonical content — a small, deterministic, dependency-free content signature. */
function signature(value: unknown): string {
  const s = canonical(value);
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i += 1) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(16).padStart(8, '0');
}

/** The dedupe identity of a publish command — the product AND its exact published content + barcodes. */
export function productPublishKey(record: ProductRecord, barcodes: readonly string[]): string {
  return `product-publish|${record.productId}|${signature({ record, barcodes: [...barcodes].sort() })}`;
}

/** Build the (deterministic) outbox command for a publish. `at` is the caller's clock. */
export function buildProductPublishCommand(input: {
  readonly record: ProductRecord;
  readonly categories: readonly Category[];
  readonly barcodes: readonly string[];
  readonly requestedBy: string;
  readonly at: string;
}): ProductPublishCommand {
  const key = productPublishKey(input.record, input.barcodes);
  return makeEvent({
    id: key, // one key ⇒ one command, so a duplicate collapses on the idempotency key
    type: PRODUCT_PUBLISH_EVENT,
    occurredAt: input.at,
    idempotencyKey: key,
    source: 'web-erp/catalogue',
    payload: {
      product: input.record,
      categories: input.categories,
      barcodes: [...input.barcodes],
      requestedBy: input.requestedBy,
    },
  });
}

/** Why a publish could not be queued — worded by the shell. `not_finished` carries the missing fields. */
export type PublishQueueRefusal = 'not_finished' | 'unknown_category' | 'already_queued';
export type PublishQueueResult =
  | { readonly ok: true; readonly key: string; readonly state: OutboxState }
  | { readonly ok: false; readonly refusal: PublishQueueRefusal; readonly detail: string; readonly missing: readonly string[] };

/**
 * Validate a product through the tested engine and, if it passes, queue a durable publish command.
 *
 * Nothing is queued unless it would publish: a product missing an HSN, a food item missing its allergen
 * declaration, an orphan category — all are refused here (every reason at once) so an invalid product never
 * sits in the outbox pretending it will file. A publish already queued for this exact content collapses
 * rather than doubling.
 */
export function queueProductPublish(
  outbox: SyncOutbox,
  input: {
    readonly product: ProductRecord;
    readonly categories: readonly Category[];
    readonly barcodes?: readonly string[];
    readonly requestedBy: string;
    readonly at: string;
  },
): PublishQueueResult {
  const barcodes = input.barcodes ?? [];
  let record: ProductRecord;
  try {
    // The tested compliance gate — the SAME rule the cloud enforces. draft → 'new' on publish.
    record = publishProduct(input.product, [...input.categories]);
  } catch (e) {
    if (e instanceof NotPublishableError) {
      const missing = e.issues.map((i) => i.message);
      return { ok: false, refusal: 'not_finished', detail: `${missing.length} thing(s) still needed before this can be sold.`, missing };
    }
    if (e instanceof CategoryNotFoundError) {
      return { ok: false, refusal: 'unknown_category', detail: `the category "${e.categoryId}" is not in the hierarchy — a product sits in exactly one place.`, missing: [e.categoryId] };
    }
    throw e;
  }
  const key = productPublishKey(record, barcodes);
  if (outbox.find(key) !== undefined) {
    return { ok: false, refusal: 'already_queued', detail: 'this exact product is already waiting to be published.', missing: [] };
  }
  const item = outbox.enqueue(buildProductPublishCommand({ record, categories: input.categories, barcodes, requestedBy: input.requestedBy, at: input.at }));
  return { ok: true, key: item.key, state: item.state };
}
