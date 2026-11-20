// API-02 Catalogue — products, barcodes, prices, tax classes, and the signed offline pack.
//
// The first domain service on the kernel. Its routes are declared here as data, so the surface can
// be read, tested and documented without starting anything — and so the kernel's registration
// rules (versioned path, declared permission, idempotent write) are applied to every one of them.

import { createHmac, timingSafeEqual } from 'node:crypto';
import type { Route } from '../../kernel/src/index';
import { apiError, notFound, requireStepUp } from '../../kernel/src/index';
import { publishStepUpNeeded, PUBLISH_STEP_UP } from './publish-step-up';
import type { CatalogueSnapshot } from '../../../packages/catalogue/src/catalogue';
import {
  publishPack, packFreshness, canonicalise,
  type PackSigner, type SignedPack, type PriceApproval,
} from './pack';

export {
  publishPack, acceptPack, packFreshness, canonicalise, blockedInPack,
  type PackSigner, type SignedPack, type PriceApproval, type PublishRefusal,
  type PublishResult, type PackRejection, type AcceptResult,
} from './pack';
export {
  publishStepUpNeeded, PUBLISH_STEP_UP, DEFAULT_BULK_PUBLISH_THRESHOLD,
  type PublishStepUpDecision, type PublishSensitivity,
} from './publish-step-up';

/**
 * HMAC-SHA256 signing.
 *
 * The secret arrives from the deployment environment and is never in code, config, an image or a
 * log (hard rule #4). `timingSafeEqual` rather than `===` because a signature check that leaks its
 * answer through how long it takes is a signature check somebody can walk.
 */
export function hmacSigner(secret: string): PackSigner {
  if (secret.trim().length < 32) {
    throw new Error('A pack signing secret must be at least 32 characters. A short one is a secret in name only.');
  }
  const mac = (payload: string): Buffer => createHmac('sha256', secret).update(payload).digest();
  return {
    sign: (payload) => mac(payload).toString('hex'),
    verify: (payload, signature) => {
      const expected = mac(payload);
      let given: Buffer;
      try { given = Buffer.from(signature, 'hex'); } catch { return false; }
      if (given.length !== expected.length) return false;
      return timingSafeEqual(expected, given);
    },
  };
}

/** What the service needs from its deployment. Ports, so the routes stay testable. */
export interface CatalogueDeps {
  readonly signer: PackSigner;
  readonly currentPack: (tenantId: string) => Promise<SignedPack | undefined> | SignedPack | undefined;
  readonly storePack: (tenantId: string, pack: SignedPack) => Promise<void> | void;
  /** Build the next snapshot to publish. `options.storeId` names the store the pack is for (prices resolve
   *  per store); `options.asOf` is the effective moment (defaults to now). A real adapter folds the product
   *  master + price lists + barcode register + tax-class rates; a test double may ignore the options. */
  readonly buildSnapshot: (
    tenantId: string,
    options: { readonly storeId?: string; readonly asOf?: string },
  ) => Promise<CatalogueSnapshot> | CatalogueSnapshot;
  readonly approvalsSince: (tenantId: string, version: number) => Promise<readonly PriceApproval[]> | readonly PriceApproval[];
  readonly now: () => string;
  /**
   * The tenant's bulk-publish threshold (the owner setting `catalogue.bulk_publish_threshold`): how many
   * products one publish may add, change or remove before it needs a fresh second-factor sign-in (ADR-0013
   * point 4). Absent, or resolving to nothing → the setting's default. Read at request time so a change is in
   * force on the next publish.
   */
  readonly bulkPublishThreshold?: (tenantId: string) => Promise<number | undefined> | number | undefined;
  /** OB-806 A · P-08: where an accepted price that did not reach the tills is recorded, and read back until a pack goes. */
  readonly notSent?: NotSentLog;
  /** D-021: before a pack is read, send every later-day price whose start day has come (`sendPricesNowInForce`, composed
   *  with the shop's clock and an audit entry by `services/api/src/till-delivery.ts`). Absent → no start-day check. */
  readonly startDaySend?: (tenantId: string) => Promise<unknown>;
}

/** OB-806 A: one accepted price whose automatic sending to a store's tills did not go — and why, in words. */
export interface NotSentToTills {
  readonly storeId: string;
  readonly productId: string;
  readonly priceMinor: number;
  readonly reason: TillNotSentReason;
  readonly why: string;
  readonly by: string;
  readonly at: string;
  /** D-021: the shop's date the price starts (YYYY-MM-DD) — kept so a `starts_later` price is sent by itself on that day. */
  readonly startsOn?: string;
}

export type TillNotSentReason = 'starts_later' | 'needs_the_owner' | 'refused' | 'failed';

/** OB-806 A · P-08: the record of prices saved but not sent; a later pack that goes for the store settles them. */
export interface NotSentLog {
  readonly recordNotSent: (tenantId: string, entry: NotSentToTills) => Promise<void> | void;
  /** A pack went for this store at this version: everything not sent before it is on its way now. */
  readonly recordSent: (tenantId: string, storeId: string, version: number, at: string) => Promise<void> | void;
  /** The prices not sent for a store since the last pack that went for it (oldest first). */
  readonly since: (tenantId: string, storeId: string) => Promise<readonly NotSentToTills[]> | readonly NotSentToTills[];
  /** D-021: the stores that have anything on their not-sent list now (so the start-day check knows where to look). */
  readonly storesWaiting?: (tenantId: string) => Promise<readonly string[]> | readonly string[];
}

/** One pack, built and judged, ready to sign — the ONE path both "Send to the tills" and the automatic send use. */
export interface PreparedPublish {
  readonly storeId: string | undefined;
  readonly stepUp: ReturnType<typeof publishStepUpNeeded>;
  readonly sign: (publishedBy: string, acknowledgedRemovals?: number) => ReturnType<typeof publishPack>;
}

export async function preparePublish(deps: CatalogueDeps, tenantId: string, options: { readonly storeId?: string; readonly asOf?: string }): Promise<PreparedPublish> {
  const previous = await deps.currentPack(tenantId);
  // A real adapter folds the master data; a test double ignores the options. The adapter decides whether a missing
  // storeId is an error.
  const snapshot = await deps.buildSnapshot(tenantId, options);
  const approvals = await deps.approvalsSince(tenantId, previous?.snapshot.version ?? 0);
  const stepUp = publishStepUpNeeded({
    ...(previous === undefined ? {} : { previous: previous.snapshot }),
    next: snapshot,
    bulkThreshold: await deps.bulkPublishThreshold?.(tenantId),
  });
  return {
    storeId: options.storeId,
    stepUp,
    sign: (publishedBy, acknowledgedRemovals) => publishPack({
      snapshot,
      ...(previous === undefined ? {} : { previous }),
      approvals,
      signer: deps.signer,
      publishedBy,
      publishedAt: deps.now(),
      ...(acknowledgedRemovals === undefined ? {} : { acknowledgedRemovals }),
    }),
  };
}

/** What happened to an accepted price on its way to one store's tills (OB-806 A). */
export type TillDelivery =
  | { readonly storeId: string; readonly sent: true; readonly version: number; readonly withinMinutes: number }
  | { readonly storeId: string; readonly sent: false; readonly reason: TillNotSentReason; readonly why: string };

/**
 * OB-806 A (owner, 16 Nov 2026, in writing): a price head office has ACCEPTED — the MRP ceiling, the margin floor and any
 * second-person approval already passed; the caller calls this only after recording it — goes to the store's tills at once,
 * through the very same signed, versioned, append-only pack publish as "Send to the tills" (`preparePublish`). It never signs
 * past a check the button would ask for: a publish that needs the owner's fresh two-step sign-in (bulk or regulated), or that
 * the pack's own checks refuse (shrink), is NOT sent — it is recorded as not sent, with why, and the owner's page shows it
 * (P-08). A price that starts on a later day is not in today's pack: it is recorded as waiting for its day. No AI is involved.
 */
export async function sendAcceptedPriceToTills(deps: CatalogueDeps, tenantId: string, input: {
  readonly storeId: string; readonly productId: string; readonly priceMinor: number; readonly by: string;
  /** The shop's date the price starts (YYYY-MM-DD) and the shop's date today. */
  readonly startsOn: string; readonly today: string;
  /** How long the store computer takes, at most, to take a new pack (`packages/sync/src/pull-timing.ts`). */
  readonly withinMinutes: number;
}): Promise<TillDelivery> {
  const notSent = async (reason: TillNotSentReason, why: string): Promise<TillDelivery> => {
    try {
      await deps.notSent?.recordNotSent(tenantId, { storeId: input.storeId, productId: input.productId, priceMinor: input.priceMinor, reason, why, by: input.by, at: deps.now(), startsOn: input.startsOn });
    } catch { /* the answer below still says it was not sent — never silent */ }
    return { storeId: input.storeId, sent: false, reason, why };
  };
  if (input.startsOn > input.today) {
    return notSent('starts_later', `The price starts on ${input.startsOn}; today's pack cannot carry it yet. It goes to the tills by itself on that day, when the store computer next takes its pack.`);
  }
  try {
    const prepared = await preparePublish(deps, tenantId, { storeId: input.storeId });
    if (prepared.stepUp.needed) {
      return notSent('needs_the_owner', `Sending now would also send other changes that need the owner's fresh two-step sign-in (${prepared.stepUp.because}), so it waits for the owner's "Send to the tills".`);
    }
    const result = prepared.sign(input.by);
    if (!result.ok) return notSent('refused', result.detail);
    await deps.storePack(tenantId, result.pack!);
    await deps.notSent?.recordSent(tenantId, input.storeId, result.pack!.snapshot.version, deps.now());
    return { storeId: input.storeId, sent: true, version: result.pack!.snapshot.version, withinMinutes: input.withinMinutes };
  } catch (e) {
    return notSent('failed', `The pack could not be built or stored (${e instanceof Error ? e.message : String(e)}).`);
  }
}

/**
 * D-021 (owner, 18 Nov 2026, under OB-801): a price accepted for a LATER day goes to the tills by itself on its start day —
 * no button. When a store computer asks for its pack, head office first looks at each store's not-sent list: every
 * `starts_later` price whose day has now come is sent through the SAME signed publish (`preparePublish`) as "Send to the
 * tills" and the automatic send. Never early (a price whose day has not come stays waiting); never twice (the pack that goes
 * settles it — `recordSent` — so the next ask finds nothing); never past a check the button would ask for (a send that needs
 * the owner's fresh two-step sign-in, or that the pack's checks refuse, is recorded ONCE as not sent with why, and the
 * owner's "Send to the tills" sends it — P-08). No AI anywhere on this path (hard rule #5).
 */
export async function sendPricesNowInForce(deps: CatalogueDeps, tenantId: string, input: {
  /** The shop's date today (YYYY-MM-DD). */
  readonly today: string;
  readonly withinMinutes: number;
}): Promise<readonly (TillDelivery & { readonly productIds: readonly string[] })[]> {
  const log = deps.notSent;
  if (log === undefined || log.storesWaiting === undefined) return [];
  const out: (TillDelivery & { readonly productIds: readonly string[] })[] = [];
  for (const storeId of await log.storesWaiting(tenantId)) {
    const open = await log.since(tenantId, storeId);
    const same = (a: NotSentToTills, b: NotSentToTills) => a.productId === b.productId && a.priceMinor === b.priceMinor;
    const due = open.filter((e, i) => e.reason === 'starts_later' && e.startsOn !== undefined && e.startsOn <= input.today
      // Already tried on or after its day and stopped for the owner, refused or failed: the owner's button sends it now.
      && !open.slice(i + 1).some((later) => later.reason !== 'starts_later' && same(later, e)));
    if (due.length === 0) continue;
    const productIds = [...new Set(due.map((e) => e.productId))];
    const by = due[0]!.by; // the person whose accepted price this is
    const stop = async (reason: TillNotSentReason, why: string) => {
      for (const e of due) {
        try {
          await log.recordNotSent(tenantId, { storeId, productId: e.productId, priceMinor: e.priceMinor, reason, why, by: e.by, at: deps.now(), ...(e.startsOn === undefined ? {} : { startsOn: e.startsOn }) });
        } catch { /* the answer below still says it was not sent */ }
      }
      out.push({ storeId, sent: false, reason, why, productIds });
    };
    try {
      const prepared = await preparePublish(deps, tenantId, { storeId });
      if (prepared.stepUp.needed) {
        await stop('needs_the_owner', `Its start day has come, but sending now would also send other changes that need the owner's fresh two-step sign-in (${prepared.stepUp.because}), so it waits for the owner's "Send to the tills".`);
        continue;
      }
      const result = prepared.sign(by);
      if (!result.ok) { await stop('refused', result.detail); continue; }
      await deps.storePack(tenantId, result.pack!);
      await log.recordSent(tenantId, storeId, result.pack!.snapshot.version, deps.now());
      out.push({ storeId, sent: true, version: result.pack!.snapshot.version, withinMinutes: input.withinMinutes, productIds });
    } catch (e) {
      await stop('failed', `On its start day the pack could not be built or stored (${e instanceof Error ? e.message : String(e)}).`);
    }
  }
  return out;
}

/**
 * The API-02 surface.
 *
 * Note what is **not** here: no endpoint that edits a price. Prices are drafted and approved
 * through M05's own path with its own separation of duties, and this service publishes what was
 * approved. An endpoint here that could set a price would be a second door into the same room,
 * with a different lock.
 */
export function catalogueRoutes(deps: CatalogueDeps): readonly Route[] {
  // D-021: one start-day check at a time per tenant, so two store computers asking together never send the same price twice.
  const running = new Map<string, Promise<unknown>>();
  const dueCheck = async (tenantId: string): Promise<void> => {
    if (deps.startDaySend === undefined) return;
    const before = running.get(tenantId);
    if (before !== undefined) { await before; return; }
    const run = (async () => {
      try { await deps.startDaySend!(tenantId); } catch { /* never fail the pack read: what did not go is on the not-sent list */ }
    })();
    running.set(tenantId, run);
    try { await run; } finally { running.delete(tenantId); }
  };
  return [
    {
      // Batch 20b · A2 (M07-FR-04 · D-043): each item's GST rate as the published catalogue holds it, for the person typing
      // a supplier bill from paper — a STARTING value they check against the bill and may change. Only rates are said (no
      // price, no cost); an item with no rate held is named as such, never given a guessed one. Read-only.
      api: 'API-02', method: 'GET', path: '/v1/catalogue/item-gst-rates',
      permission: 'purchase.invoice.capture',
      handler: async (ctx) => {
        const asked = [...new Set((ctx.query['productIds'] ?? '').split(',').map((s) => s.trim()).filter((s) => s !== ''))];
        if (asked.length === 0 || asked.length > 500) {
          throw apiError(400, { code: 'not_readable_as_an_item_list', whatHappened: 'Name the items (?productIds=a,b,c — at most 500).', wasItSaved: 'not_saved', nextSafeAction: 'Nothing was changed.' });
        }
        const pack = await deps.currentPack(ctx.tenantId);
        const held = new Map((pack?.snapshot.products ?? []).map((p) => [p.productId, p.taxBps] as const));
        const rates: Record<string, number | null> = {};
        for (const id of asked) { const r = held.get(id); rates[id] = typeof r === 'number' && Number.isInteger(r) && r >= 0 ? r : null; }
        return { status: 200, body: { rates, source: 'published_catalogue', asAt: deps.now() } };
      },
    },
    {
      api: 'API-02', method: 'GET', path: '/v1/catalogue/pack',
      permission: 'catalogue.pack.read',
      handler: async (ctx) => {
        // D-021: a price whose start day has come goes into the pack first — the store computer takes it on this very ask.
        await dueCheck(ctx.tenantId);
        const pack = await deps.currentPack(ctx.tenantId);
        if (pack === undefined) throw notFound('published catalogue pack');
        return { status: 200, body: pack };
      },
    },
    {
      api: 'API-02', method: 'GET', path: '/v1/catalogue/pack/freshness',
      permission: 'catalogue.pack.read',
      handler: async (ctx) => {
        const pack = await deps.currentPack(ctx.tenantId);
        if (pack === undefined) throw notFound('published catalogue pack');
        return { status: 200, body: packFreshness(pack, deps.now()) };
      },
    },
    {
      // OB-806 A · P-08: the accepted prices whose automatic sending to a store's tills did not go — since the last pack that
      // went for that store. The owner's "Send to the tills" page shows them, so a price saved but not on the tills is never
      // silent; pressing "Send to the tills" there sends them.
      api: 'API-02', method: 'GET', path: '/v1/catalogue/pack/not-sent',
      permission: 'catalogue.pack.read',
      handler: async (ctx) => {
        const storeId = typeof ctx.query['storeId'] === 'string' ? ctx.query['storeId'].trim() : '';
        const notSent = deps.notSent === undefined || storeId === '' ? [] : await deps.notSent.since(ctx.tenantId, storeId);
        return { status: 200, body: { storeId, notSent, count: notSent.length } };
      },
    },
    {
      api: 'API-02', method: 'POST', path: '/v1/catalogue/pack',
      permission: 'catalogue.pack.publish', idempotent: true,
      handler: async (ctx) => {
        const body = (ctx.body ?? {}) as { acknowledgedRemovals?: number; storeId?: string; asOf?: string };
        // The pack is built FOR a store (prices resolve per store) as of a moment — the ONE path the automatic send
        // after an accepted price (OB-806 A) uses too.
        const prepared = await preparePublish(deps, ctx.tenantId, {
          ...(typeof body.storeId === 'string' ? { storeId: body.storeId } : {}),
          ...(typeof body.asOf === 'string' ? { asOf: body.asOf } : {}),
        });
        // STEP-UP (ADR-0013 point 4 · SEC-03 · §28 · Stage E slice 1): a BULK publish (at or above the owner's
        // threshold of products added / changed / removed) or a SENSITIVE one (a regulated product added or
        // changed) needs a RECENT, MFA-backed re-authentication from the SIGNED token — checked here, at the
        // API boundary, before anything is signed or stored, so a direct call cannot skip the web-erp prompt.
        // A routine publish (a few ordinary lines) is not asked. The refusal says exactly why this one was.
        if (prepared.stepUp.needed) requireStepUp(ctx, PUBLISH_STEP_UP, Date.parse(deps.now()), prepared.stepUp.because);
        const result = prepared.sign(ctx.userId, body.acknowledgedRemovals);

        if (!result.ok) {
          // A refusal here is not a server fault — it is the service declining to put something
          // on every lane in the shop, and the person needs to know exactly which thing.
          return {
            status: 422,
            body: {
              error: {
                code: result.refusedBecause,
                whatHappened: result.detail,
                wasItSaved: 'not_saved',
                nextSafeAction: 'Nothing was published and the lanes are unchanged. Fix what is named above and publish again.',
                traceId: ctx.traceId,
              },
            },
          };
        }

        await deps.storePack(ctx.tenantId, result.pack!);
        if (prepared.storeId !== undefined) await deps.notSent?.recordSent(ctx.tenantId, prepared.storeId, result.pack!.snapshot.version, deps.now());
        return { status: 201, body: { published: result.detail, version: result.pack!.snapshot.version } };
      },
    },
  ];
}

/** Verify a pack exactly as a lane would — exported so the edge and the tests share one path. */
export const verifyAsLane = (pack: SignedPack, signer: PackSigner): boolean =>
  signer.verify(canonicalise(pack.snapshot), pack.signature);
