// API-04 The ONLINE SAFETY-STOCK BUFFER (D05-FR-03 "online safety stock and reservation buffer" · M08-FR-01 · M18-FR-02 ·
// P-02 · P-08) — round 8.
//
// The app must not sell the last units on the shelf: by the time the picker gets there a walk-in shopper may have taken
// them. The buffer is how many units of a product, at a store, the app keeps back from what it promises:
//
//     the app may promise = on hand − already promised to other orders − the buffer   (never below zero)
//
// The till is never touched (hard rule #1): the buffer limits ONLINE promises only; a walk-in buys what is on the shelf.
// The figure is the store's to set — per product at a store, or one figure for every product at the store — by a person
// holding `inventory.online.buffer.set`, with a reason; a new figure supersedes (append-only, the history kept). No figure
// is invented: a store with none set keeps nothing back, and every read SAYS so (`buffer_not_set`), never silently.

import type { Route } from '../../kernel/src/index';
import { apiError } from '../../kernel/src/index';
import type { AuditEntry } from '../../../packages/audit/src/index';
import { assertLocationInScope, type LocationBranches } from './location-scope';

/** `productId: null` = the figure for every product at the store that has none of its own. */
export interface OnlineBuffer {
  readonly locationId: string;
  readonly productId: string | null;
  readonly bufferMinor: number;
  readonly reason: string;
  readonly setBy: string;
  readonly setAt: string;
}

/** The buffer in force per product at a location: its own figure, else the store-wide one, else none (undefined). */
export function buffersAt(all: readonly OnlineBuffer[], locationId: string): { readonly forProduct: (productId: string) => number | undefined } {
  const own = new Map<string, number>();
  let storeWide: number | undefined;
  for (const b of all) {
    if (b.locationId !== locationId) continue;
    if (b.productId === null) storeWide = b.bufferMinor; else own.set(b.productId, b.bufferMinor);
  }
  return { forProduct: (productId) => own.get(productId) ?? storeWide };
}

export interface OnlineBufferDeps {
  readonly buffers: (tenantId: string) => Promise<readonly OnlineBuffer[]> | readonly OnlineBuffer[];
  readonly recordBuffer: (tenantId: string, b: OnlineBuffer) => Promise<void> | void;
  /** On hand per product at the location (the stock ledger) and what online orders already hold there. */
  readonly onHand: (tenantId: string, locationId: string) => Promise<ReadonlyMap<string, number>> | ReadonlyMap<string, number>;
  readonly promised: (tenantId: string, locationId: string) => Promise<ReadonlyMap<string, number>> | ReadonlyMap<string, number>;
  readonly locationBranches?: LocationBranches;
  readonly recordAudit?: (tenantId: string, entry: AuditEntry) => Promise<unknown> | void;
  readonly now: () => string;
}

const isStr = (v: unknown): v is string => typeof v === 'string' && v.trim() !== '';

export function onlineBufferRoutes(deps: OnlineBufferDeps): readonly Route[] {
  return [
    {
      // Set the buffer for a product at a store (or for every product there, productId null) — the store's figure, with a reason.
      api: 'API-04', method: 'POST', path: '/v1/inventory/online-buffer',
      permission: 'inventory.online.buffer.set', idempotent: true,
      handler: async (ctx) => {
        const b = (ctx.body ?? {}) as Record<string, unknown>;
        if (!isStr(b['locationId']) || !(b['productId'] === null || b['productId'] === undefined || isStr(b['productId']))
          || !Number.isSafeInteger(b['bufferMinor']) || (b['bufferMinor'] as number) < 0 || !isStr(b['reason'])) {
          throw apiError(400, {
            code: 'not_readable_as_an_online_buffer',
            whatHappened: 'An online buffer needs { locationId, productId (or null for every product at the store), bufferMinor (whole, not negative), reason }.',
            wasItSaved: 'not_saved', nextSafeAction: 'Send the buffer. Nothing was recorded.',
          });
        }
        await assertLocationInScope(ctx, b['locationId'], deps.locationBranches);
        const buffer: OnlineBuffer = {
          locationId: b['locationId'].trim(), productId: isStr(b['productId']) ? b['productId'].trim() : null,
          bufferMinor: b['bufferMinor'] as number, reason: b['reason'].trim(), setBy: ctx.userId, setAt: deps.now(),
        };
        const before = (await deps.buffers(ctx.tenantId)).filter((x) => x.locationId === buffer.locationId && x.productId === buffer.productId).at(-1);
        await deps.recordBuffer(ctx.tenantId, buffer);
        await deps.recordAudit?.(ctx.tenantId, {
          actorId: ctx.userId, action: 'inventory.online_buffer.set', objectType: 'online_buffer', objectId: `${buffer.locationId}|${buffer.productId ?? '*'}`, at: buffer.setAt,
          origin: { tenantId: ctx.tenantId, branchId: ctx.branchId ?? null }, before: before === undefined ? null : { bufferMinor: String(before.bufferMinor) },
          after: { bufferMinor: String(buffer.bufferMinor) }, reason: buffer.reason, correlationId: `${buffer.locationId}|${buffer.productId ?? '*'}`,
        });
        return { status: 201, body: { buffer, supersedes: before ?? null } };
      },
    },
    {
      // What the app may promise at a store, per product: on hand, promised to orders, kept back, and what is left to sell online.
      api: 'API-04', method: 'GET', path: '/v1/inventory/online-availability',
      permission: 'inventory.availability.read',
      handler: async (ctx) => {
        const locationId = ctx.query['locationId'];
        if (!isStr(locationId)) {
          throw apiError(400, { code: 'not_readable_as_an_online_availability_query', whatHappened: 'Online availability is read for a store: ?locationId=…', wasItSaved: 'not_saved', nextSafeAction: 'Send the store. Nothing was changed.' });
        }
        await assertLocationInScope(ctx, locationId, deps.locationBranches);
        const [onHand, promised, all] = await Promise.all([deps.onHand(ctx.tenantId, locationId), deps.promised(ctx.tenantId, locationId), deps.buffers(ctx.tenantId)]);
        const at = buffersAt(all, locationId);
        const products = [...new Set([...onHand.keys(), ...promised.keys()])].sort();
        const rows = products.map((productId) => {
          const buffer = at.forProduct(productId);
          const free = (onHand.get(productId) ?? 0) - (promised.get(productId) ?? 0);
          return {
            productId, onHandMinor: onHand.get(productId) ?? 0, promisedMinor: promised.get(productId) ?? 0, bufferMinor: buffer ?? 0,
            appMayPromiseMinor: Math.max(0, free - (buffer ?? 0)), ...(buffer === undefined ? { flags: ['buffer_not_set'] } : {}),
          };
        });
        return { status: 200, body: { locationId, rows, buffers: all.filter((b) => b.locationId === locationId), asAt: deps.now() } };
      },
    },
  ];
}
