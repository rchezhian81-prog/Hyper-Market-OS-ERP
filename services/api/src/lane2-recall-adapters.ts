// Lane 2 · P1 — recall and trace completion (OB-288; M10-FR-03, M10-FR-04, WF-09). Head office's wiring for:
//
//   1. ORDERING BLOCK — a product under open recall cannot be put on, issued on, or raised on a purchase order
//      (`services/purchase/src/recall-order-guard.ts`), 409 `product_under_recall`, sealed on the audit trail.
//   2. OWNER INFORMED — starting a recall raises a critical alert into every owner's alert inbox (`recall:<batch>`,
//      acknowledgement due in 15 minutes, roadmap §32 "critical alert acknowledgement ≤15 min"); the ops-alert worker
//      delivers it like every other alert. Closing the recall with evidence clears it (kept, never deleted).
//   3. PRIORITY PROPAGATION — starting a recall publishes the tills' pack ITSELF, at once: the pack the tills already
//      trust with the recalled products blocked, nothing else changed (`services/catalogue/src/recall-republish.ts`).
//      The store computer's next pull adopts it and the lane refuses the scan with the cable out.
//   4. BACKWARD TRACE — from a bill or a customer to the batches and the suppliers behind them
//      (`services/inventory/src/lot-trace-backward.ts`). And the FORWARD trace now names the customer the till keyed on
//      the bill (the sale's member), not only a stored-value link — so "who bought it" is the same answer both ways.
//   5. TRACE READS LOGGED — every lot-trace read that can name customers is sealed on the audit trail: who, when, what
//      (M10-FR-03 "trace queries logged"). If the seal cannot be written the trace is not handed out (fail closed).
//   6. RECALL CALL LIST and MESSAGE PORT (owner decision OB-297, D8: "call list now, SMS later") — the customers who
//      bought the recalled batch and whose own consent allows service messages, each with their name, the last four
//      digits of their phone and the lot and date they bought; and an SMS notice port, switched OFF (no provider is
//      connected in production, and the owner's switch is off until he sets it), sending only to SMS-consented customers
//      (`services/customer/src/recall-notices.ts`).
//
// Composition: `lane2RecallSurface(surface, …)` is the one line in `main.ts`. It adds the new routes and wraps four
// existing ones in place (recall start, recall close, the purchase-order steps, the lot-trace reads) — each wrapped
// route keeps its own path, permission and behaviour, and gains only the step above. A target route that is missing
// throws at start-up: a guard that silently guards nothing is the failure this lane exists to remove (P-08).

import type { EventStore } from '../../../packages/persistence/src/event-store';
import type { Route, RequestContext, HandlerResult } from '../../kernel/src/index';
import { apiError } from '../../kernel/src/index';
import type { AuditEntry } from '../../../packages/audit/src/index';
import type { RecallRecord } from '../../../packages/traceability/src/index';
import type { BackwardSale, BatchOrigin } from '../../../packages/quality/src/lot-trace-backward';
import type { OutboundLotRecord } from '../../../packages/quality/src/lot-trace';
import type { IncomingSale } from '../../pos/src/index';
import type { PackSigner } from '../../catalogue/src/pack';
import type { AlertLifecycleEvent } from '../../platform/src/alert-lifecycle';
import { republishWithBlocks } from '../../catalogue/src/recall-republish';
import { blockedProductIds } from '../../inventory/src/sale-blocks';
import { lotTraceBackwardRoutes, type LotTraceBackwardDeps } from '../../inventory/src/lot-trace-backward';
import { withRecallOrderGuard, type ProductUnderRecall, type RecallOrderGuardDeps } from '../../purchase/src/recall-order-guard';
import { recallNoticeRoutes, type RecallBuyer, type RecallNoticeDeps, type RecallNoticeSwitch, type RecallNoticeAttempt } from '../../customer/src/recall-notices';
import type { NotificationTransport } from '../../../packages/notifications/src/transport';
import { makeEvent } from '../../../packages/contracts/src/event';
import {
  STREAM, streamName, recallAdapter, saleBlocksAdapter, catalogueAdapter, productMasterAdapter, purchaseOrdersAdapter,
  lotTraceAdapter, customerAdapter, customer360Adapter, alertLifecycleAdapter, effectiveGrants, outsidePartyLoginAdapter,
} from './adapters';
import { lotTraceRoutes } from '../../inventory/src/lot-trace';
import { lotTraceChainRoutes, type LotTraceFacts } from '../../inventory/src/lot-trace-chain';
import { lotTraceFactsAdapter, lotTraceRequestsAdapter, productionUseOf } from './r3-till-trace-adapters';
import { productionInputsForOutputBatch } from './r3-ops-adapters';
import { OWNER_ROLE_ID } from './roles';

type Recorder = (tenantId: string, entry: AuditEntry) => Promise<unknown> | void;
type Input = { readonly store: EventStore; readonly now: () => string };

/** The id of the owner alert a recall raises — one per batch, a new occurrence after a closure. */
export const RECALL_ALERT_PREFIX = 'recall:';
/** Roadmap §32: a critical alert is acknowledged within 15 minutes. */
const RECALL_ACK_WITHIN_MS = 15 * 60_000;

// ── the stored facts ─────────────────────────────────────────────────────────────────────────────────────────────────

const saleById = async (store: EventStore, tenantId: string, saleId: string): Promise<IncomingSale | undefined> =>
  (await store.findByIdempotencyKey(tenantId, `sale-${tenantId}-${saleId}`))?.event.payload as IncomingSale | undefined;

const ref = (v: unknown): string | undefined => (typeof v === 'string' && v.trim() !== '' ? v.trim() : undefined);

/** Sale → customer from the stored-value ledger (a member who paid with, or earned on, a card on that bill). */
async function storedValueCustomers(store: EventStore, tenantId: string): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  const instruments = await store.readStream(tenantId, streamName(STREAM.loyalty, 'instruments'), { type: 'StoredValueIssued' });
  for (const i of instruments) {
    const instrumentId = (i.event.payload as { instrumentId?: string }).instrumentId;
    if (instrumentId === undefined) continue;
    for (const m of await store.readStream(tenantId, streamName(STREAM.loyalty, 'value', instrumentId), { type: 'StoredValueMovement' })) {
      const p = m.event.payload as { saleId?: unknown; customerRef?: unknown };
      const saleId = ref(p.saleId);
      const customer = ref(p.customerRef);
      if (saleId !== undefined && customer !== undefined && !out.has(saleId)) out.set(saleId, customer);
    }
  }
  return out;
}

/** The customer a banked sale names: the member keyed at the till, else the stored-value link. */
async function customerOfSale(store: EventStore, tenantId: string, saleId: string, linked?: string): Promise<string | undefined> {
  return ref((await saleById(store, tenantId, saleId))?.customerRef) ?? linked;
}

// ── 4. the backward trace ────────────────────────────────────────────────────────────────────────────────────────────

export function lotTraceBackwardAdapter(input: Input): LotTraceBackwardDeps {
  const { store, now } = input;
  const sold = lotTraceAdapter({ store });
  const facts = lotTraceFactsAdapter({ store, now });

  /** Each line's batch(es): the one the till recorded, else head office's FIFO estimate (the same engine every trace uses). */
  const toBackward = async (tenantId: string, sales: readonly IncomingSale[]): Promise<BackwardSale[]> => {
    const moves = (await store.readStream(tenantId, STREAM.inventory, { type: 'InventoryMoved' }))
      .map((e) => e.event.payload as { productId?: string; kind?: string; batchId?: string });
    const receivedBatchesOf = new Map<string, Set<string>>();
    for (const m of moves) {
      if (m.kind !== 'received' || ref(m.batchId) === undefined || ref(m.productId) === undefined) continue;
      const set = receivedBatchesOf.get(m.productId!) ?? new Set<string>();
      set.add(m.batchId!);
      receivedBatchesOf.set(m.productId!, set);
    }
    const soldOf = new Map<string, readonly OutboundLotRecord[]>();
    const estimatedFor = async (saleId: string, productId: string): Promise<string[]> => {
      const out: string[] = [];
      for (const batchId of [...(receivedBatchesOf.get(productId) ?? [])].sort()) {
        if (!soldOf.has(batchId)) soldOf.set(batchId, await sold.soldOfBatch(tenantId, batchId));
        if (soldOf.get(batchId)!.some((r) => r.saleId === saleId && r.source === 'fifo_receipt_estimate')) out.push(batchId);
      }
      return out;
    };
    const out: BackwardSale[] = [];
    for (const sale of sales) {
      const lines = [];
      for (const l of sale.lines ?? []) {
        const captured = ref(l.batchId);
        const batches = captured !== undefined
          ? [{ batchId: captured, knownBy: 'till_recorded' as const }]
          : (await estimatedFor(sale.saleId, l.productId)).map((batchId) => ({ batchId, knownBy: 'fifo_estimate' as const }));
        lines.push({ productId: l.productId, quantityMinor: l.quantityMinor, batches });
      }
      out.push({ saleId: sale.saleId, soldDate: sale.tradingDay, lines });
    }
    return out;
  };

  return {
    now,
    sale: async (tenantId, saleId) => {
      const sale = await saleById(store, tenantId, saleId);
      return sale === undefined ? undefined : (await toBackward(tenantId, [sale]))[0];
    },
    salesOfCustomer: async (tenantId, customerRef) => {
      const linked = await storedValueCustomers(store, tenantId);
      const mine = (await store.readStream(tenantId, STREAM.sales, { type: 'SaleCommitted' }))
        .map((e) => e.event.payload as IncomingSale)
        .filter((s) => (ref(s.customerRef) ?? linked.get(s.saleId)) === customerRef);
      return toBackward(tenantId, mine);
    },
    origins: async (tenantId, batchIds) => {
      const out = new Map<string, BatchOrigin>();
      for (const batchId of batchIds) {
        const f = await facts(tenantId, batchId);
        const madeBy = (await productionInputsForOutputBatch(input, tenantId, batchId)).map((r) => ({
          runId: r.runId, inputsRecorded: r.inputsRecorded,
          inputBatchIds: [...new Set(r.inputBatches.flatMap((i) => (i.batchId === null ? [] : [i.batchId])))].sort(),
          inputsWithoutBatch: r.inputBatches.filter((i) => i.batchId === null).length,
        }));
        // A run that released the batch onto the ledger but is not in the production register is still a run — said, with
        // its ingredients not known.
        for (const p of f.producedBy) if (!madeBy.some((m) => m.runId === p.runId)) madeBy.push({ runId: p.runId, inputsRecorded: false, inputBatchIds: [], inputsWithoutBatch: 0 });
        if (f.receipts.length === 0 && madeBy.length === 0) continue; // nothing on record: the engine says so
        out.set(batchId, { receipts: f.receipts, madeBy });
      }
      return out;
    },
    salesBankedUpTo: async (tenantId) => {
      const last = await store.latestOfType(tenantId, STREAM.sales, 'SaleCommitted');
      return ref((last?.event.payload as IncomingSale | undefined)?.committedAt) ?? null;
    },
  };
}

// ── 6. the recall notice list ────────────────────────────────────────────────────────────────────────────────────────

export function recallNoticeAdapter(input: Input & { readonly transport?: NotificationTransport; readonly recordAudit?: Recorder }): RecallNoticeDeps {
  const { store, now } = input;
  const recalls = recallAdapter(input);
  const sold = lotTraceAdapter({ store });
  const customers = customerAdapter(input);
  const c360 = customer360Adapter(input);
  return {
    now,
    recall: async (tenantId, batchId) => {
      const r = (await recalls.records(tenantId)).find((x) => x.batchId === batchId);
      return r === undefined ? undefined : { batchId: r.batchId, status: r.status, reason: r.reason, initiatedAt: r.initiatedAt, closedAt: r.closedAt };
    },
    buyers: async (tenantId, batchId) => {
      const out: RecallBuyer[] = [];
      for (const s of await sold.soldOfBatch(tenantId, batchId)) {
        const customerRef = await customerOfSale(store, tenantId, s.saleId, s.customerId);
        out.push({ saleId: s.saleId, soldDate: s.soldDate, quantityMinor: s.quantityMinor, source: s.source ?? 'captured', ...(customerRef === undefined ? {} : { customerRef }), via: { kind: 'this_batch' } });
      }
      // D-25: what the kitchen made from this batch, and who bought that.
      const use = await productionUseOf(input)(tenantId, batchId);
      if (use.connected) {
        for (const run of use.runs) {
          for (const s of run.outputSales ?? []) {
            const customerRef = await customerOfSale(store, tenantId, s.saleId, s.customerId);
            out.push({
              saleId: s.saleId, soldDate: s.soldDate, quantityMinor: s.quantityMinor, source: s.source ?? 'captured',
              ...(customerRef === undefined ? {} : { customerRef }),
              via: { kind: 'made_from_it', productId: run.outputProductId, batchId: run.outputBatchId, runId: run.runId },
            });
          }
        }
      }
      return out;
    },
    consentRecords: (tenantId, customerRef) => customers.consentRecords(tenantId, customerRef),
    // The only customer names the shop holds are an app customer's login names (the login IS the customer record, M20).
    // A member enrolled at the desk has no name on record — the call list says so (null), never invents one.
    name: async (tenantId, customerRef) => {
      const logins = (await outsidePartyLoginAdapter(input).invites(tenantId)).filter((r) => r.role === 'customer' && r.partyId === customerRef && r.state !== 'rejected');
      return ref(logins[logins.length - 1]?.displayName);
    },
    phoneLast4: async (tenantId, customerRef) => (await c360.loyaltyOf(tenantId, customerRef)).member?.mobileLast4,
    switchState: async (tenantId) =>
      (await store.latestOfType(tenantId, RECALL_NOTICE_STREAM, 'RecallNoticeSwitchSet'))?.event.payload as RecallNoticeSwitch | undefined,
    recordSwitch: async (tenantId, s) => {
      await store.append(tenantId, RECALL_NOTICE_STREAM, makeEvent({
        id: `recall-notice-switch-${s.at}-${s.by}`, type: 'RecallNoticeSwitchSet', occurredAt: s.at,
        idempotencyKey: `recall-notice-switch-${tenantId}-${s.at}-${s.by}-${s.on}`, source: 'api/customer', payload: s,
      }));
    },
    attempts: async (tenantId, batchId) =>
      (await store.readStream(tenantId, RECALL_NOTICE_STREAM, { type: 'RecallNoticeAttempted' }))
        .map((e) => e.event.payload as RecallNoticeAttempt).filter((a) => a.batchId === batchId),
    recordAttempt: async (tenantId, a) => {
      await store.append(tenantId, RECALL_NOTICE_STREAM, makeEvent({
        id: `recall-notice-${a.messageId}-${a.at}`, type: 'RecallNoticeAttempted', occurredAt: a.at,
        // One sent message per customer and recall: a second "sent" for the same message id collapses onto the first.
        idempotencyKey: a.outcome === 'sent' ? `recall-notice-${tenantId}-${a.messageId}-sent` : `recall-notice-${tenantId}-${a.messageId}-failed-${a.at}`,
        source: 'api/customer', payload: a,
      }));
    },
    ...(input.transport === undefined ? {} : { transport: input.transport }),
    ...(input.recordAudit === undefined ? {} : { recordAudit: input.recordAudit }),
  };
}

/** OB-297: the owner's switch for recall messages and every message attempt, append-only. */
const RECALL_NOTICE_STREAM = streamName(STREAM.customer, 'recall-notices');

// ── 1. what is under recall, for the ordering guard ──────────────────────────────────────────────────────────────────

export function underRecallOf(input: Input): (tenantId: string, productIds: readonly string[]) => Promise<readonly ProductUnderRecall[]> {
  const blocks = saleBlocksAdapter(input);
  const master = productMasterAdapter(input);
  return async (tenantId, productIds) => {
    const recalls = (await blocks.blocks(tenantId)).filter((b) => b.kind === 'recall' && b.productId !== null);
    const out: ProductUnderRecall[] = [];
    for (const productId of productIds) {
      const mine = recalls.filter((b) => b.productId === productId);
      if (mine.length > 0) {
        out.push({
          productId, batchIds: [...new Set(mine.map((b) => b.batchId))].sort(), because: 'open_batch_recall',
          reason: [...new Set(mine.map((b) => b.reason))].join('; '), since: mine.map((b) => b.since).sort()[0] ?? null,
        });
        continue;
      }
      if ((await master.product(tenantId, productId))?.recallBlocked === true) {
        out.push({ productId, batchIds: [], because: 'product_recall_flag', reason: 'the product master is marked recall-blocked', since: null });
      }
    }
    return out;
  };
}

// ── 2 & 3. what starting (and closing) a recall does by itself ────────────────────────────────────────────────────────

export type TillPackOutcome =
  | { readonly published: true; readonly version: number; readonly newlyBlocked: readonly string[]; readonly notCarried: readonly string[]; readonly detail: string }
  | { readonly published: false; readonly onPack: boolean; readonly version: number | null; readonly why: string; readonly notCarried: readonly string[]; readonly detail: string };

/**
 * Publish the tills' pack with every product that must not be sold blocked — at once, prices untouched — and say, for
 * THIS recall's products, whether the tills now refuse them. A product no till carries (not on the pack at all) cannot be
 * sold at a till and is named as such; a batch head office cannot name to any product cannot be refused, and is said.
 */
export async function publishRecallPack(input: Input & { readonly signer: PackSigner }, tenantId: string, startedBy: string, products: readonly string[]): Promise<TillPackOutcome> {
  const catalogue = catalogueAdapter({ store: input.store, signer: input.signer, now: input.now });
  const blocks = saleBlocksAdapter(input);
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const previous = await catalogue.currentPack(tenantId);
    if (previous === undefined) {
      return { published: false, onPack: false, version: null, why: 'no_pack_published_yet', notCarried: [], detail: 'No catalogue has been published to the tills yet, so no till is selling anything from head office. The first publish will carry this block.' };
    }
    const version = previous.snapshot.version;
    const carried = new Set(previous.snapshot.products.map((p) => p.productId));
    const notCarried = products.filter((p) => !carried.has(p));
    if (products.length === 0) {
      return { published: false, onPack: false, version, why: 'product_unknown', notCarried, detail: 'Head office cannot name this batch to a product (no receipt or stock movement carried it), so no till can refuse it. Record the batch\'s receipt; the block follows.' };
    }
    if (notCarried.length === products.length) {
      return { published: false, onPack: false, version, why: 'not_carried_by_any_till', notCarried, detail: `No till carries ${notCarried.join(', ')} (it is not on catalogue v${version}), so none can sell it.` };
    }
    const blocked = blockedProductIds(await blocks.blocks(tenantId));
    const r = republishWithBlocks({
      previous, blocked, batchesOf: (p) => blocked.batchesOf(p), signer: input.signer,
      publishedBy: `recall-block:${startedBy}`, publishedAt: input.now(),
    });
    if (r.outcome === 'already_on_pack') return { published: false, onPack: true, version, why: 'already_on_pack', notCarried, detail: r.detail };
    if (r.outcome === 'refused') return { published: false, onPack: false, version, why: r.because, notCarried, detail: `The recall pack was refused: ${r.detail}. Publish the catalogue by hand now.` };
    await catalogue.storePack(tenantId, r.pack);
    const held = await catalogue.currentPack(tenantId);
    if (held?.signature === r.pack.signature) return { published: true, version: r.pack.snapshot.version, newlyBlocked: r.newlyBlocked, notCarried, detail: r.detail };
    // Somebody published the same version a moment earlier — read the pack again and block on top of theirs.
  }
  return { published: false, onPack: false, version: null, why: 'publish_raced', notCarried: [], detail: 'Three publishes landed while the recall pack was being signed. Publish the catalogue by hand now.' };
}

export type OwnerAlertOutcome =
  | { readonly raised: true; readonly alertId: string; readonly to: readonly string[]; readonly ackDueBy: string }
  | { readonly raised: false; readonly alertId: string; readonly why: 'already_open' | 'no_owner_on_record' };

async function ownersOf(store: EventStore, tenantId: string): Promise<string[]> {
  return [...new Set((await effectiveGrants(store, tenantId)).filter((g) => g.roleId === OWNER_ROLE_ID).map((g) => g.userId))].sort();
}

/** Raise the recall into every owner's alert inbox — critical, acknowledgement due in 15 minutes. */
export async function raiseRecallAlert(input: Input, tenantId: string, record: RecallRecord, detail: string): Promise<OwnerAlertOutcome> {
  const lifecycle = alertLifecycleAdapter(input);
  const alertId = `${RECALL_ALERT_PREFIX}${record.batchId}`;
  const owners = await ownersOf(input.store, tenantId);
  if (owners.length === 0) return { raised: false, alertId, why: 'no_owner_on_record' };
  const current = (await lifecycle.alerts(tenantId)).find((a) => a.alert.alertId === alertId);
  if (current !== undefined && current.state !== 'cleared') return { raised: false, alertId, why: 'already_open' };
  const at = input.now();
  const ackDueBy = new Date(Date.parse(at) + RECALL_ACK_WITHIN_MS).toISOString();
  const event: AlertLifecycleEvent = {
    alertId, change: 'raised', by: record.initiatedBy, at,
    alert: {
      alertId, component: `Recall of batch ${record.batchId}`, status: 'down',
      ownerUserId: owners[0]!, ownerName: owners[0]!, detail, raisedAt: at, ackDueBy,
      ...(owners.length > 1 ? { alsoToUserIds: owners.slice(1) } : {}),
    },
  };
  await lifecycle.recordAlertEvent(tenantId, event, `${alertId}|${record.initiatedAt}|${current?.clearedAt ?? 'first'}`);
  return { raised: true, alertId, to: owners, ackDueBy };
}

/** Clear the recall's owner alert when the recall closes with evidence (kept, with its history). */
async function clearRecallAlert(input: Input, tenantId: string, record: RecallRecord): Promise<boolean> {
  const lifecycle = alertLifecycleAdapter(input);
  const alertId = `${RECALL_ALERT_PREFIX}${record.batchId}`;
  const current = (await lifecycle.alerts(tenantId)).find((a) => a.alert.alertId === alertId);
  if (current === undefined || current.state === 'cleared') return false;
  await lifecycle.recordAlertEvent(tenantId, {
    alertId, change: 'cleared', by: record.closedBy ?? 'unknown', at: input.now(),
    detail: `the recall was closed with evidence ${record.evidenceRef ?? ''}`.trim(),
  }, `${alertId}|cleared|${record.closedAt ?? input.now()}`);
  return true;
}

/** The orders still open for the recalled products — the buyer's list to cancel or hold (P-03). */
async function openOrdersFor(input: Input, tenantId: string, productIds: readonly string[]): Promise<readonly { readonly poId: string; readonly status: string; readonly productIds: readonly string[] }[]> {
  if (productIds.length === 0) return [];
  const wanted = new Set(productIds);
  return (await purchaseOrdersAdapter(input).all(tenantId)).flatMap((po) => {
    const named = [...new Set(po.lines.map((l) => l.productId).filter((p) => wanted.has(p)))].sort();
    const open = po.lines.some((l) => wanted.has(l.productId) && l.orderedQty - (po.receivedByProduct[l.productId] ?? 0) - (po.cancelledByProduct[l.productId] ?? 0) > 0);
    return named.length > 0 && open ? [{ poId: po.poId, status: po.status, productIds: named }] : [];
  }).sort((a, b) => (a.poId < b.poId ? -1 : 1));
}

/** Run a step that must not undo the recall already recorded; a failure is reported in the reply, never swallowed. */
async function reported<T>(step: () => Promise<T>): Promise<T | { readonly failed: true; readonly detail: string }> {
  try { return await step(); } catch (e) { return { failed: true, detail: e instanceof Error ? e.message : String(e) }; }
}

function onRecallStart(input: Input & { readonly signer: PackSigner }, inner: Route['handler']): Route['handler'] {
  return async (ctx: RequestContext): Promise<HandlerResult> => {
    const res = await inner(ctx);
    if (res.status !== 201) return res; // already open (one effect), or the route's own refusal
    const record = (res.body as { recall: RecallRecord }).recall;
    const products = (await saleBlocksAdapter(input).blocks(ctx.tenantId))
      .filter((b) => b.kind === 'recall' && b.batchId === record.batchId)
      .flatMap((b) => (b.productId === null ? [] : [b.productId])).sort();
    // 3 first: the tills are what stop the next sale.
    const tillPack = await reported(() => publishRecallPack(input, ctx.tenantId, ctx.userId, products));
    const openPurchaseOrders = await reported(() => openOrdersFor(input, ctx.tenantId, products));
    const tills = !('published' in tillPack) ? `it is NOT yet blocked at the tills (${tillPack.detail}) — publish the catalogue now`
      : tillPack.published ? `the tills' catalogue v${tillPack.version} now refuses it`
        : tillPack.onPack ? 'the tills already refuse it'
          : tillPack.why === 'not_carried_by_any_till' ? 'no till carries it'
            : `it is NOT yet blocked at the tills — ${tillPack.detail}`;
    const orders = Array.isArray(openPurchaseOrders) && openPurchaseOrders.length > 0
      ? ` Open purchase orders for it: ${openPurchaseOrders.map((o) => o.poId).join(', ')}.` : '';
    const detail = `Batch ${record.batchId} was recalled by ${record.initiatedBy}: ${record.reason}. `
      + `${products.length === 0 ? 'Head office cannot name its product yet, so no till can refuse it — record the batch\'s receipt.' : `Product(s) ${products.join(', ')}: ${tills}.`}${orders}`;
    const ownerAlert = await reported(() => raiseRecallAlert(input, ctx.tenantId, record, detail));
    return { status: 201, body: { ...(res.body as object), products, tillPack, ownerAlert, openPurchaseOrders } };
  };
}

function onRecallClose(input: Input, inner: Route['handler']): Route['handler'] {
  return async (ctx: RequestContext): Promise<HandlerResult> => {
    const res = await inner(ctx);
    if (res.status !== 200) return res;
    const record = (res.body as { recall: RecallRecord }).recall;
    const ownerAlertCleared = await reported(() => clearRecallAlert(input, ctx.tenantId, record));
    return { status: 200, body: { ...(res.body as object), ownerAlertCleared } };
  };
}

// ── 5. every trace read, sealed ──────────────────────────────────────────────────────────────────────────────────────

/** The lot-trace reads that can name customers, and how each names the thing it traced. */
export const AUDITED_TRACE_READS: readonly { readonly method: 'GET' | 'POST'; readonly path: string; readonly object: (ctx: RequestContext) => string }[] = [
  { method: 'GET', path: '/v1/quality/lot-trace/:batchId/sold', object: (c) => `batch:${c.params['batchId'] ?? ''}` },
  { method: 'POST', path: '/v1/quality/lot-trace/export', object: (c) => `batch:${String((c.body as { batchId?: unknown } | null)?.batchId ?? '')}` },
  { method: 'GET', path: '/v1/quality/lot-trace/:batchId/chain', object: (c) => `batch:${c.params['batchId'] ?? ''}` },
  { method: 'POST', path: '/v1/quality/lot-trace/requests/:requestId/answer', object: (c) => `trace-request:${c.params['requestId'] ?? ''}` },
  { method: 'GET', path: '/v1/quality/lot-trace/backward/sales/:saleId', object: (c) => `sale:${c.params['saleId'] ?? ''}` },
  { method: 'GET', path: '/v1/quality/lot-trace/backward/customers/:customerRef', object: (c) => `customer:${c.params['customerRef'] ?? ''}` },
  { method: 'GET', path: '/v1/quality/recalls/:batchId/notice-list', object: (c) => `recall-notice:${c.params['batchId'] ?? ''}` },
];

/**
 * How many distinct customers a reply names: any `customerId` / `customerRef` string anywhere in it, and the recipient
 * of a sale row on a D-26 chain (`hop: 'sale'`, `to` other than "walk-in").
 */
export function customersNamedIn(body: unknown): number {
  const seen = new Set<string>();
  const walk = (v: unknown): void => {
    if (Array.isArray(v)) { for (const x of v) walk(x); return; }
    if (v === null || typeof v !== 'object') return;
    const row = v as { hop?: unknown; to?: unknown };
    if (row.hop === 'sale' && typeof row.to === 'string' && row.to.trim() !== '' && row.to !== 'walk-in') seen.add(row.to.trim());
    for (const [k, x] of Object.entries(v as Record<string, unknown>)) {
      if ((k === 'customerId' || k === 'customerRef') && typeof x === 'string' && x.trim() !== '') seen.add(x.trim());
      else walk(x);
    }
  };
  walk(body);
  return seen.size;
}

function auditedRead(route: Route, object: (ctx: RequestContext) => string, recordAudit: Recorder, now: () => string): Route['handler'] {
  const inner = route.handler;
  return async (ctx: RequestContext): Promise<HandlerResult> => {
    const res = await inner(ctx);
    if (res.status >= 300) return res;
    const asked = route.path.replace(/:([A-Za-z]+)/g, (_m, k: string) => ctx.params[k] ?? `:${k}`);
    try {
      await recordAudit(ctx.tenantId, {
        actorId: ctx.userId, action: 'quality.lottrace.read', objectType: 'lot-trace', objectId: object(ctx),
        at: now(), origin: { tenantId: ctx.tenantId, branchId: ctx.branchId ?? null },
        before: null,
        after: { query: `${route.method} ${asked}`, customersNamed: String(customersNamedIn(res.body)), permission: route.permission },
        correlationId: ctx.traceId,
      });
    } catch (e) {
      // Fail closed: a trace that names customers is not handed out unless the read is on the record.
      throw apiError(503, {
        code: 'trace_read_not_recorded',
        whatHappened: `The trace was built but could not be recorded on the audit trail (${e instanceof Error ? e.message : String(e)}), so it was not shown — every trace read is logged (M10-FR-03).`,
        wasItSaved: 'not_saved',
        nextSafeAction: 'Try again in a moment. If it keeps failing, tell support: the audit trail is not taking records.',
      });
    }
    return res;
  };
}

// ── the forward trace names the customer the till keyed ─────────────────────────────────────────────────────────────

/**
 * Each sold record with the customer its bill names: the loyalty member the cashier keyed at the till (the sale's own
 * `customerRef`), else the stored-value link the trace already used. Before this the forward trace knew only the second,
 * so a member who bought a recalled batch and paid cash read as a walk-in.
 */
export function withSaleCustomers(store: EventStore): <T extends OutboundLotRecord>(tenantId: string, records: readonly T[]) => Promise<T[]> {
  return async (tenantId, records) => Promise.all(records.map(async (r) => {
    const customerId = await customerOfSale(store, tenantId, r.saleId, r.customerId);
    return customerId === undefined || customerId === r.customerId ? r : { ...r, customerId };
  }));
}

/** The forward-trace routes (B11 export, "who bought it", D-26 chain and its answer) on facts that name the till's customer. */
function forwardTraceRoutes(input: Input): readonly Route[] {
  const { store, now } = input;
  const named = withSaleCustomers(store);
  const sold = lotTraceAdapter({ store });
  const facts = lotTraceFactsAdapter(input);
  return [
    ...lotTraceRoutes({ soldOfBatch: async (t, b) => named(t, await sold.soldOfBatch(t, b)) }),
    ...lotTraceChainRoutes({
      now, ...lotTraceRequestsAdapter(input),
      facts: async (t, b): Promise<LotTraceFacts> => {
        const f = await facts(t, b);
        const usedIn = !f.usedIn.connected ? f.usedIn : {
          ...f.usedIn,
          runs: await Promise.all(f.usedIn.runs.map(async (u) => (u.outputSales === undefined ? u : { ...u, outputSales: await named(t, u.outputSales) }))),
        };
        return { ...f, sales: await named(t, f.sales), usedIn };
      },
    }),
  ];
}

const FORWARD_TRACE_PATHS: readonly (readonly [string, string])[] = [
  ['POST', '/v1/quality/lot-trace/export'],
  ['GET', '/v1/quality/lot-trace/:batchId/sold'],
  ['GET', '/v1/quality/lot-trace/:batchId/chain'],
  ['POST', '/v1/quality/lot-trace/requests/:requestId/answer'],
];

// ── the composition ─────────────────────────────────────────────────────────────────────────────────────────────────

function replace(surface: Route[], method: string, path: string, change: (r: Route) => Route): void {
  const at = surface.findIndex((r) => r.method === method && r.path === path);
  if (at < 0) throw new Error(`lane 2 recall wiring cannot find ${method} ${path} — the step it adds would silently not happen`);
  surface[at] = change(surface[at]!);
}

/**
 * Lane 2 · P1 on the head-office surface: the new routes added, and the recall, ordering and trace routes wrapped in
 * place. Called once by `buildSurface` before the API manifest is taken.
 */
export function lane2RecallSurface(surface: Route[], input: {
  readonly store: EventStore | undefined;
  readonly now: () => string;
  readonly signer: PackSigner;
  readonly recordAudit?: Recorder;
  /** OB-297 "SMS later": the message provider for recall notices. NEVER set by `startApi` — tests hand in a stand-in. */
  readonly messageTransport?: NotificationTransport;
}): void {
  const { store, now } = input;
  const none = async <T>(): Promise<T[]> => [];

  // 1. The ordering block, in front of propose / approve / amend.
  const guardDeps: RecallOrderGuardDeps = store === undefined
    ? { underRecall: none, order: () => undefined, now }
    : { underRecall: underRecallOf({ store, now }), order: (t, poId) => purchaseOrdersAdapter({ store, now }).order(t, poId), now, ...(input.recordAudit === undefined ? {} : { recordAudit: input.recordAudit }) };
  surface.splice(0, surface.length, ...withRecallOrderGuard(surface, guardDeps));

  // 2 & 3. Starting a recall publishes the tills' pack and tells the owners; closing it clears the alert.
  if (store !== undefined) {
    replace(surface, 'POST', '/v1/quality/recalls/:batchId', (r) => ({ ...r, handler: onRecallStart({ store, now, signer: input.signer }, r.handler) }));
    replace(surface, 'POST', '/v1/quality/recalls/:batchId/closure', (r) => ({ ...r, handler: onRecallClose({ store, now }, r.handler) }));
    // The forward trace (supplier → customer) names the customer the till keyed, as the backward trace and the notice
    // list do — the same routes, paths and permissions, on facts that know the member.
    const forward = forwardTraceRoutes({ store, now });
    for (const [method, path] of FORWARD_TRACE_PATHS) {
      const fresh = forward.find((r) => r.method === method && r.path === path);
      if (fresh === undefined) throw new Error(`lane 2 recall wiring has no forward-trace route for ${method} ${path}`);
      replace(surface, method, path, (r) => ({ ...fresh, permission: r.permission }));
    }
  }

  // 4 & 6. The new reads.
  surface.push(
    ...lotTraceBackwardRoutes(store === undefined
      ? { now, sale: async () => undefined, salesOfCustomer: none, origins: async () => new Map(), salesBankedUpTo: async () => null }
      : lotTraceBackwardAdapter({ store, now })),
    ...recallNoticeRoutes(store === undefined
      ? {
          now, recall: async () => undefined, buyers: none, consentRecords: () => [], name: async () => undefined, phoneLast4: async () => undefined,
          switchState: async () => undefined, recordSwitch: async () => {}, attempts: none, recordAttempt: async () => {},
        }
      : recallNoticeAdapter({
          store, now,
          ...(input.messageTransport === undefined ? {} : { transport: input.messageTransport }),
          ...(input.recordAudit === undefined ? {} : { recordAudit: input.recordAudit }),
        })),
  );

  // 5. Every trace read that can name customers, sealed — the new ones and the ones already served.
  const recordAudit = input.recordAudit;
  for (const t of AUDITED_TRACE_READS) {
    replace(surface, t.method, t.path, (r) => (recordAudit === undefined ? r : { ...r, handler: auditedRead(r, t.object, recordAudit, now) }));
  }
}
