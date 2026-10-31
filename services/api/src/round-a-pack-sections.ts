// Round A (screen gap audit, 31 Oct 2026 — docs/audit/SCREEN-GAP-AUDIT-2026-10-31.md): the office pages that were empty
// forever because head office never sent them their data. Each section here is read from the register that already holds
// the truth at head office (P-02 — nothing typed twice) and rides the SIGNED store pack to the store computer, which
// serves its last copy with no network and says how old it is (P-01 · P-08). A section head office cannot honestly fill
// is LEFT OUT, so the page says it was not told — never an empty list that reads as "nothing to see".
//
//   • products and pricing — the category register and the product master, as head office holds them (M03-FR-01). The
//     price entries do NOT ride the pack: every product keeps its own price stream, so a pack built on every sync pass
//     would read one stream per product per pass, and the full history is the largest thing the shop keeps. The page reads
//     them through the store computer's relay to head office instead (`GET /v1/prices/list/:productId/history`).
//   • expiry and recalls — this store's batches on hand with their expiry (the stock ledger's batch balances, M10-FR-01),
//     and every recall head office holds (M10-FR-04), each in the shape the page reads.
//   • finance — whether this month is closed and who signed it (head office's period lifecycle) and the month's daily Tally
//     files in whatever state each reached (the Tally outbox, OB-293). NOT the ledger side: see `financeSections`.
//   • GST reconciliation — every e-invoice and e-way bill in the lifecycle, folded by head office's own engines into the
//     operator's queue categories (API-09 · A20/A23).
//
// Who may SEE each section is the screen's own permission (SEC-1): the store computer serves a page — and so its data —
// only to a person who holds that page's word (the product master to `catalogue.pack.read`, the batches to
// `quality.recall.read`, the month to `finance.period.read`, the GST queue to `finance.einvoice.read`).
// Nothing here writes anything.

import type { EventStore } from '../../../packages/persistence/src/event-store';
import { normaliseUom } from '../../../packages/contracts/src/quantity';
import { eInvoiceRowCategory } from '../../../packages/e-invoice/src/index';
import { ewbRowCategory } from '../../../packages/e-way-bill/src/index';
import { foldOutbox, type TallyOutboxFact } from '../../finance/src/tally-outbox';
import type { ProductRecord } from '../../../packages/product/src/product';
import {
  STREAM, categoryRegisterAdapter, inventoryAdapter, recallAdapter, saleBlocksAdapter, eInvoiceAdapter, eWayBillAdapter,
} from './adapters';
import { TALLY_OUTBOX_STREAM } from './finance-bridge-adapters';

type Base = { readonly store: EventStore; readonly now: () => string };

// ── products and pricing ────────────────────────────────────────────────────────────────────────────────────────────

/** A category as the product-and-pricing page reads it (`PackCategory`): who defined it is head office's, not the page's. */
export interface CategorySection {
  readonly categoryId: string;
  readonly name: string;
  readonly parentId: string | null;
  readonly attributes?: readonly unknown[];
  readonly regulated?: readonly string[];
}

/**
 * The category register (latest version of each) and the product master (latest publish of each), for the product and
 * pricing page. The master record is sent WHOLE, as head office holds it: the page republishes a product it edits, and a
 * record trimmed here would come back without the fields left out.
 */
export async function catalogueMasterSections(input: Base, tenantId: string, master: readonly ProductRecord[]): Promise<{ readonly categories: readonly CategorySection[]; readonly productMaster: readonly ProductRecord[] }> {
  const categories = (await categoryRegisterAdapter(input).categories(tenantId))
    .map((c) => ({
      categoryId: c.categoryId, name: c.name, parentId: c.parentId,
      ...(c.attributes === undefined ? {} : { attributes: c.attributes }),
      ...(c.regulated === undefined ? {} : { regulated: c.regulated }),
    }))
    .sort((a, b) => a.categoryId.localeCompare(b.categoryId));
  return { categories, productMaster: [...master].sort((a, b) => a.productId.localeCompare(b.productId)) };
}

// ── expiry and recalls ──────────────────────────────────────────────────────────────────────────────────────────────

/** One batch on hand at this store, as the expiry page reads it (`packages/fefo` `Batch`, plus its unit — OB-31). */
export interface BatchSection {
  readonly batchId: string;
  readonly productId: string;
  /** On hand across this store's places, in the product's SMALLEST STEP (the pack's one quantity rule). */
  readonly qty: number;
  readonly uom?: string;
  /** YYYY-MM-DD, from the batch's receipt. */
  readonly expiry: string;
  /** `on_hand`, or `quality_hold` while a quality hold stands on it (held stock is never marked down or sold). */
  readonly state: 'on_hand' | 'quality_hold';
  readonly recallBlocked?: true;
}

/** One recall, as the expiry page reads it (`RecallRecord` in apps/web-erp/src/expiry-session.ts). */
export interface RecallSection {
  readonly recallId: string;
  readonly batchId: string;
  /** Empty when head office cannot name the batch's product (no stock of it was ever recorded) — said, never guessed. */
  readonly productId: string;
  readonly reason: string;
  readonly startedBy: string;
  readonly startedAt: string;
  /** Head office keeps who closed it, when, and the evidence — not counts of stock recovered or disposed of. */
  readonly closure?: { readonly closedBy: string; readonly closedAt: string; readonly evidence: string };
  readonly withdrawal?: { readonly withdrawnBy: string; readonly withdrawnAt: string; readonly reason: string };
}

/**
 * The batches on hand at this store (every place `isHere` says is the store's) with an expiry on record, one row per
 * product and batch, and every recall head office holds. A batch whose receipt carried no expiry cannot be put on an
 * expiry list and is counted in `batchesWithoutExpiry` instead — never given a date.
 */
export async function expirySections(input: Base, tenantId: string, isHere: (locationId: string) => boolean, uomOf: (productId: string) => string | undefined): Promise<{
  readonly batches: readonly BatchSection[]; readonly recalls: readonly RecallSection[]; readonly batchesWithoutExpiry: number;
}> {
  const balances = await inventoryAdapter(input).batches!(tenantId);
  const blocks = await saleBlocksAdapter(input).blocks(tenantId);
  const held = new Set(blocks.filter((b) => b.kind === 'quality_hold').map((b) => `${b.productId ?? ''}\u001f${b.batchId}`));
  const records = await recallAdapter(input).records(tenantId);
  const openRecall = new Set(records.filter((r) => r.status === 'open').map((r) => r.batchId));

  const here = new Map<string, { productId: string; batchId: string; qty: number; expiry?: string }>();
  const productsOfBatch = new Map<string, Set<string>>();
  for (const b of balances) {
    if (b.batchId === null) continue;
    productsOfBatch.set(b.batchId, (productsOfBatch.get(b.batchId) ?? new Set<string>()).add(b.productId));
    if (!isHere(b.locationId)) continue;
    const key = `${b.productId}\u001f${b.batchId}`;
    const acc = here.get(key) ?? { productId: b.productId, batchId: b.batchId, qty: 0 };
    acc.qty += b.onHandMinor;
    if (acc.expiry === undefined && b.expiry !== undefined) acc.expiry = b.expiry;
    here.set(key, acc);
  }
  let batchesWithoutExpiry = 0;
  const batches: BatchSection[] = [];
  for (const [key, b] of here) {
    if (b.qty <= 0) continue;
    if (b.expiry === undefined) { batchesWithoutExpiry += 1; continue; }
    const uom = uomOf(b.productId);
    batches.push({
      batchId: b.batchId, productId: b.productId, qty: b.qty, ...(uom === undefined ? {} : { uom: normaliseUom(uom) ?? uom }),
      expiry: b.expiry, state: held.has(key) ? 'quality_hold' : 'on_hand', ...(openRecall.has(b.batchId) ? { recallBlocked: true as const } : {}),
    });
  }
  batches.sort((a, b) => a.expiry.localeCompare(b.expiry) || a.batchId.localeCompare(b.batchId) || a.productId.localeCompare(b.productId));

  const recalls: RecallSection[] = [];
  for (const r of records) {
    // A batch id two products share is a recall of both — the same safe reading head office's till block takes.
    const products = [...(productsOfBatch.get(r.batchId) ?? [])].sort();
    for (const productId of products.length === 0 ? [''] : products) {
      recalls.push({
        recallId: products.length > 1 ? `recall-${r.batchId}-${productId}` : `recall-${r.batchId}`,
        batchId: r.batchId, productId, reason: r.reason, startedBy: r.initiatedBy, startedAt: r.initiatedAt,
        ...(r.status === 'closed' && r.closedBy !== null && r.closedAt !== null && r.evidenceRef !== null
          ? { closure: { closedBy: r.closedBy, closedAt: r.closedAt, evidence: r.evidenceRef } } : {}),
        ...(r.withdrawal === undefined ? {} : { withdrawal: r.withdrawal }),
      });
    }
  }
  recalls.sort((a, b) => b.startedAt.localeCompare(a.startedAt) || a.recallId.localeCompare(b.recallId));
  return { batches, recalls, batchesWithoutExpiry };
}

// ── finance ─────────────────────────────────────────────────────────────────────────────────────────────────────────

/** Whether the month is closed at head office, who signed it and when (the latest close/reopen fact decides). */
export interface PeriodStateSection {
  readonly period: string;
  readonly closed: boolean;
  readonly signedBy?: string;
  readonly closedAt?: string;
}

/**
 * The month's state at head office and its daily Tally files (each a posting in the state it reached: queued, posted,
 * failed or dead-lettered — a dead letter is never dropped, hard rule #6). Company-wide: the books and the Tally files are
 * the company's, not one store's.
 *
 * The LEDGER side (`financeLedger`) is deliberately NOT sent. The finance page compares what the shop took against the
 * postings the accounts accepted, classified by each posting's journal reference against the shop's three headings — but
 * head office's Tally postings are whole DAYS (one file carries every journal of the day), so no posting can be split into
 * takings, tax and refunds by its reference. Sending a ledger side would make every month read as "the accounts received
 * nothing" beside one unclassifiable total. Which comparison the page should make is the owner's decision (reported).
 */
export async function financeSections(input: Base, tenantId: string, period: string): Promise<{ readonly periodState: PeriodStateSection; readonly tallyPostings: readonly unknown[] }> {
  // The month's lifecycle facts only (close / reopen), the latest by its transition number deciding — the same rule head
  // office's own period state follows (`financeAdapter.periodStates`), without reading every journal on every sync pass.
  // A month with no close is open.
  const facts: { kind: 'closed' | 'open'; seq: number; signedBy?: string; closedAt?: string }[] = [];
  for (const e of await input.store.readStream(tenantId, STREAM.periods)) {
    if (e.event.type !== 'PeriodClosed' && e.event.type !== 'PeriodReopened') continue;
    const p = e.event.payload as { period?: string; seq?: number; signedBy?: string; closedAt?: string };
    if (p.period !== period) continue;
    facts.push({ kind: e.event.type === 'PeriodClosed' ? 'closed' : 'open', seq: p.seq ?? 0, ...(p.signedBy === undefined ? {} : { signedBy: p.signedBy }), ...(p.closedAt === undefined ? {} : { closedAt: p.closedAt }) });
  }
  const latest = facts.reduce<(typeof facts)[number] | undefined>((best, f) => (best === undefined || f.seq > best.seq ? f : best), undefined);
  const periodState: PeriodStateSection = latest?.kind === 'closed'
    ? { period, closed: true, ...(latest.signedBy === undefined ? {} : { signedBy: latest.signedBy }), ...(latest.closedAt === undefined ? {} : { closedAt: latest.closedAt }) }
    : { period, closed: false };
  const outbox = (await input.store.readStream(tenantId, TALLY_OUTBOX_STREAM, { type: 'TallyOutboxFact' })).map((e) => e.event.payload as TallyOutboxFact);
  const tallyPostings = foldOutbox(outbox).filter((p) => p.period === period);
  return { periodState, tallyPostings };
}

// ── GST reconciliation ──────────────────────────────────────────────────────────────────────────────────────────────

/** One queue row as the GST reconciliation page reads it (`QueueRow` in apps/web-erp/src/gst-reconciliation-session.ts). */
export interface GstQueueRowSection {
  readonly documentType: 'e_invoice' | 'e_way_bill';
  readonly id: string;
  readonly category: string;
  readonly number?: string;
  readonly detail?: string;
  readonly mismatch?: { readonly observedState: string; readonly observedNumber?: string; readonly note: string };
}

/**
 * Every e-invoice and e-way bill in the lifecycle, each folded by head office's own engine and categorised exactly as its
 * register routes do (`GET /v1/finance/e-invoice/register`, `GET /v1/finance/e-way-bill/register`). A disagreement with
 * the portal rides as it was observed — surfaced, never applied (hard rule #10).
 */
export async function gstReconciliationQueueSection(input: Base, tenantId: string): Promise<readonly GstQueueRowSection[]> {
  const rows: GstQueueRowSection[] = [];
  const einv = eInvoiceAdapter(input);
  for (const id of await einv.listInvoiceIds(tenantId)) {
    const agg = await einv.load(tenantId, id);
    if (agg === undefined) continue;
    rows.push({
      documentType: 'e_invoice', id, category: eInvoiceRowCategory(agg), detail: agg.detail,
      ...(agg.irn === undefined ? {} : { number: agg.irn }),
      ...(agg.mismatch === undefined ? {} : { mismatch: { observedState: agg.mismatch.observedState, note: agg.mismatch.note, ...(agg.mismatch.observedIrn === undefined ? {} : { observedNumber: agg.mismatch.observedIrn }) } }),
    });
  }
  const ewb = eWayBillAdapter(input);
  for (const id of await ewb.listMovementIds(tenantId)) {
    const agg = await ewb.load(tenantId, id);
    if (agg === undefined) continue;
    rows.push({
      documentType: 'e_way_bill', id, category: ewbRowCategory(agg), detail: agg.detail,
      ...(agg.ewbNo === undefined ? {} : { number: agg.ewbNo }),
      ...(agg.mismatch === undefined ? {} : { mismatch: { observedState: agg.mismatch.observedState, note: agg.mismatch.note, ...(agg.mismatch.observedEwbNo === undefined ? {} : { observedNumber: agg.mismatch.observedEwbNo }) } }),
    });
  }
  return rows.sort((a, b) => a.documentType.localeCompare(b.documentType) || a.id.localeCompare(b.id));
}

/** The store-pack sections Round A added (the reporting list rides from the composition root's own declaration). */
export const ROUND_A_SECTIONS = Object.freeze(['categories', 'productMaster', 'batches', 'recalls', 'batchesWithoutExpiry', 'periodState', 'tallyPostings', 'gstReconciliationQueue', 'reportingRecords'] as const);
