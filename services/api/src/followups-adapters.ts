// OB-288 integration follow-ups — the seams between the five finished lanes (recall/trace, gates/scans, store-box offline
// queues, procure-to-pay, identity/authority), closed on the owner's decisions of 23 Oct 2026. Head-office wiring only:
// each rule is in its own tested engine; this file hands one lane's port to another. Registered from main.ts with one
// spread per seam.

import { InMemoryEventStore, type EventStore } from '../../../packages/persistence/src/event-store';
import type { Route } from '../../kernel/src/index';
import type { DurableTenantSettings } from '../../../packages/tenant/src/durable-settings';
import type { PurchaseOrderDeps } from '../../purchase/src/purchase-orders';
import { authorityOfAdapter } from './p1-identity-adapters';
import type { PackSigner } from '../../catalogue/src/pack';
import { republishWithExpired } from '../../catalogue/src/recall-republish';
import { catalogueAdapter, saleBlocksAdapter, qualityHoldAdapter, permissionsHeldBy } from './adapters';
import { syncedQualityHoldRoutes } from '../../inventory/src/quality-hold';
import type { AuditEntry } from '../../../packages/audit/src/index';
import { lane2ExpirySweep, shopDayOf } from './lane2-offline-adapters';

/**
 * OB-290 · M02-FR-02 — procure-to-pay's purchase-order limit IS identity's server-held rule: the raiser's limit decides
 * whether an order is theirs or goes to the owner, and the approver's limit decides whether they may issue it. Both read
 * the owner's versioned limits table through the one `authorityOf` port (never a figure in a request, never a default
 * kept in the purchasing code).
 */
export function poAuthorityHooks(input: { readonly store: EventStore; readonly now: () => string; readonly settings: DurableTenantSettings }): Pick<PurchaseOrderDeps, 'authorityOf'> {
  return { authorityOf: authorityOfAdapter(input) };
}

// ── M10-FR-01 · the expired-batch state into the till (integration follow-up) ──────────────────────────────────────────

export type ExpiredPackOutcome =
  | { readonly published: true; readonly version: number; readonly products: readonly string[]; readonly detail: string }
  | { readonly published: false; readonly why: 'no_pack_published_yet' | 'already_on_pack' | 'refused' | 'publish_raced'; readonly detail: string };

/**
 * Publish the tills' pack with every batch the expiry move put in the EXPIRED state carried on it (`expiredBatches`) — at
 * once, prices untouched, only ever adding — so a batch-bearing barcode of an expired batch is refused at every till,
 * offline. A plain barcode is not refused by this (OB-298: the cashier confirms a flagged perishable's printed date).
 */
export async function publishExpiredPack(input: { readonly store: EventStore; readonly now: () => string; readonly signer: PackSigner }, tenantId: string): Promise<ExpiredPackOutcome> {
  const catalogue = catalogueAdapter({ store: input.store, signer: input.signer, now: input.now });
  const expired = await saleBlocksAdapter(input).expiredBatches(tenantId);
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const previous = await catalogue.currentPack(tenantId);
    if (previous === undefined) return { published: false, why: 'no_pack_published_yet', detail: 'No catalogue has been published to the tills yet; the first publish will carry the expired batches.' };
    const r = republishWithExpired({ previous, expired, signer: input.signer, publishedBy: 'expiry-sweep', publishedAt: input.now() });
    if (r.outcome === 'already_on_pack') return { published: false, why: 'already_on_pack', detail: r.detail };
    if (r.outcome === 'refused') return { published: false, why: 'refused', detail: `The expired-batch pack was refused: ${r.detail}. Publish the catalogue by hand now.` };
    await catalogue.storePack(tenantId, r.pack);
    if ((await catalogue.currentPack(tenantId))?.signature === r.pack.signature) return { published: true, version: r.pack.snapshot.version, products: r.newlyBlocked, detail: r.detail };
  }
  return { published: false, why: 'publish_raced', detail: 'Three publishes landed while the expired-batch pack was being signed. Publish the catalogue by hand now.' };
}

/**
 * The ops-alert worker's daily expiry move (lane 2 · P2) followed by the expired-batch pack: whenever the move put a batch
 * in the expired state — and once per shop day in any case, so a restart catches up — the tills' pack is re-signed with
 * the expired batches on it. Answers how many batches moved.
 */
export function expirySweepThatPublishes(input: { readonly store: EventStore; readonly now: () => string; readonly signer: PackSigner }): (tenantId: string, at: string) => Promise<number> {
  const sweep = lane2ExpirySweep(input);
  const checkedOn = new Map<string, string>();
  return async (tenantId, at) => {
    const moved = await sweep(tenantId, at);
    const day = shopDayOf(at);
    if (moved > 0 || checkedOn.get(tenantId) !== day) {
      await publishExpiredPack(input, tenantId);
      checkedOn.set(tenantId, day);
    }
    return moved;
  };
}

// ── the surface ────────────────────────────────────────────────────────────────────────────────────────────────────

function wrapRoute(surface: Route[], method: string, path: string, around: (inner: Route['handler']) => Route['handler']): void {
  const at = surface.findIndex((r) => r.method === method && r.path === path);
  // A seam that silently wires nothing is the failure P-08 forbids: a missing target stops start-up.
  if (at < 0) throw new Error(`the integration follow-ups cannot find ${method} ${path} — the control they add would silently not happen`);
  surface[at] = { ...surface[at]!, handler: around(surface[at]!.handler) };
}

/** The follow-up wiring that changes routes already on the surface (one line in main.ts, after the lanes' own). */
export function followupsSurface(surface: Route[], input: {
  readonly store: EventStore | undefined; readonly now: () => string; readonly signer: PackSigner;
  readonly recordAudit?: (tenantId: string, entry: AuditEntry) => Promise<unknown> | void;
}): void {
  const store = input.store ?? new InMemoryEventStore();
  // OB-333: the store computer's release-only relay of a quality-hold release, and the held batches it may release.
  surface.push(...syncedQualityHoldRoutes({
    ...qualityHoldAdapter({ store, now: input.now }),
    permissionsOfUser: (tenantId, userId) => permissionsHeldBy(store, tenantId, userId),
    ...(input.recordAudit === undefined ? {} : { recordAudit: input.recordAudit }),
  }));
  const base = { store, now: input.now, signer: input.signer };
  // M10-FR-01: a person running the expiry move by hand puts the expired batches on the tills' pack too, and is told.
  wrapRoute(surface, 'POST', '/v1/inventory/expiry-sweep', (inner) => async (ctx) => {
    const res = await inner(ctx);
    if (res.status !== 200) return res;
    const tillsPack = await publishExpiredPack(base, ctx.tenantId);
    return { ...res, body: { ...(res.body as Record<string, unknown>), tillsPack } };
  });
}
