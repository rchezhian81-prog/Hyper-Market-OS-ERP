// API-02 Catalogue — products, barcodes, prices, tax classes, and the signed offline pack.
//
// The first domain service on the kernel. Its routes are declared here as data, so the surface can
// be read, tested and documented without starting anything — and so the kernel's registration
// rules (versioned path, declared permission, idempotent write) are applied to every one of them.

import { createHmac, timingSafeEqual } from 'node:crypto';
import type { Route } from '../../kernel/src/index';
import { notFound, requireStepUp } from '../../kernel/src/index';
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
  return [
    {
      api: 'API-02', method: 'GET', path: '/v1/catalogue/pack',
      permission: 'catalogue.pack.read',
      handler: async (ctx) => {
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
      api: 'API-02', method: 'POST', path: '/v1/catalogue/pack',
      permission: 'catalogue.pack.publish', idempotent: true,
      handler: async (ctx) => {
        const previous = await deps.currentPack(ctx.tenantId);
        const body = (ctx.body ?? {}) as { acknowledgedRemovals?: number; storeId?: string; asOf?: string };
        // The pack is built FOR a store (prices resolve per store) as of a moment. A real adapter folds the
        // master data; a test double ignores these. The adapter decides whether a missing storeId is an error.
        const snapshot = await deps.buildSnapshot(ctx.tenantId, {
          ...(typeof body.storeId === 'string' ? { storeId: body.storeId } : {}),
          ...(typeof body.asOf === 'string' ? { asOf: body.asOf } : {}),
        });
        const approvals = await deps.approvalsSince(ctx.tenantId, previous?.snapshot.version ?? 0);

        // STEP-UP (ADR-0013 point 4 · SEC-03 · §28 · Stage E slice 1): a BULK publish (at or above the owner's
        // threshold of products added / changed / removed) or a SENSITIVE one (a regulated product added or
        // changed) needs a RECENT, MFA-backed re-authentication from the SIGNED token — checked here, at the
        // API boundary, before anything is signed or stored, so a direct call cannot skip the web-erp prompt.
        // A routine publish (a few ordinary lines) is not asked. The refusal says exactly why this one was.
        const stepUp = publishStepUpNeeded({
          ...(previous === undefined ? {} : { previous: previous.snapshot }),
          next: snapshot,
          bulkThreshold: await deps.bulkPublishThreshold?.(ctx.tenantId),
        });
        if (stepUp.needed) requireStepUp(ctx, PUBLISH_STEP_UP, Date.parse(deps.now()), stepUp.because);

        const result = publishPack({
          snapshot,
          ...(previous === undefined ? {} : { previous }),
          approvals,
          signer: deps.signer,
          publishedBy: ctx.userId,
          publishedAt: deps.now(),
          ...(body.acknowledgedRemovals === undefined
            ? {} : { acknowledgedRemovals: body.acknowledgedRemovals }),
        });

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
        return { status: 201, body: { published: result.detail, version: result.pack!.snapshot.version } };
      },
    },
  ];
}

/** Verify a pack exactly as a lane would — exported so the edge and the tests share one path. */
export const verifyAsLane = (pack: SignedPack, signer: PackSigner): boolean =>
  signer.verify(canonicalise(pack.snapshot), pack.signature);
