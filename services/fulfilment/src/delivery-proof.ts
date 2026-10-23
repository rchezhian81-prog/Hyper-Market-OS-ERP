// API-08 / API-07 — the proof a delivery happened, and what the customer is told while it is on its way (M19-FR-03 ·
// WF-15 · D08-FR-05 · D09-FR-05 · OB-294 · §31 · hard rules #3/#6/#10).
//
//   GET  /v1/storefront/orders/:orderId/delivery-code   the CUSTOMER's own 4-digit code, to read out to the driver (OB-294)
//   GET  /v1/storefront/orders/:orderId/delivery-eta    the CUSTOMER's own order: the driver's last stamped stop and an ETA
//   POST /v1/delivery/routes/:routeId/stops/:stopId/proof/synced
//                                                        a photo or signature captured on the driver's phone, relayed by the
//                                                        store computer — kept as a DOCUMENT with its SHA-256, never deleted
//   GET  /v1/delivery/orders/:orderId/proof              the dispatcher's view of one order's proof: code, location, images
//   GET  /v1/delivery/proof-images/:imageId              one kept image, with its bytes
//
// The code is issued ONCE per delivery order by head office (a cryptographic random number), the first time it is asked
// for — by the customer's app, or when the order is put on a route — and never changes. The phone never holds it. A
// customer asking for another customer's code is refused AND recorded, the same way the storefront refuses another
// customer's order (hard rule #6). The ETA gives counts and times only — nothing about any other customer's stop.

import { createHash } from 'node:crypto';
import type { Route } from '../../kernel/src/index';
import { apiError } from '../../kernel/src/index';
import type { AuditEntry } from '../../../packages/audit/src/index';
import { scopeOrderToCustomer, type StorefrontAccessRefusal } from '../../../packages/orders/src/storefront-scope';
import { checkProductImage } from '../../../packages/product/src/images';
import {
  customerEta, newDeliveryCode, IMAGE_PROOF_KINDS, PROOF_IMAGE_MAX_BASE64, type EtaStamp, type EtaStop,
} from '../../../packages/fulfilment/src/index';

/** The order as the scope decision and the code need it. */
export interface ProofOrder {
  readonly orderId: string;
  readonly customerRef?: string;
  readonly fulfilment?: 'delivery' | 'pickup';
  readonly locationId: string;
}

export interface IssuedCode {
  readonly orderId: string;
  readonly code: string;
  readonly issuedAt: string;
  /** Who asked first: the customer's app, or the dispatcher putting the order on a route. */
  readonly issuedFor: 'customer_app' | 'route';
}

/** Where an order sits on the route head office assigned — written when the route is handed to the driver. */
export interface OrderStop {
  readonly orderId: string;
  readonly routeId: string;
  readonly stopId: string;
  readonly runDate: string;
  readonly sequence: number;
  readonly plannedArrivalAt: string;
  readonly slotStartsAt: string;
  readonly slotEndsAt: string;
  readonly assignedAt: string;
}

/** A captured image kept as a document — the bytes beside it, content-addressed, never deleted (#6). */
export interface ProofImage {
  readonly imageId: string;
  readonly kind: 'photo' | 'signature';
  readonly routeId: string;
  readonly stopId: string;
  readonly orderRef: string;
  readonly driverId: string;
  readonly mediaType: string;
  readonly bytes: number;
  readonly sha256: string;
  readonly capturedAt: string;
  readonly relayedBy: string;
  readonly receivedAt: string;
  readonly governanceFlags: readonly string[];
}

export interface DeliveryProofDeps {
  readonly placedOrder: (tenantId: string, orderId: string) => Promise<ProofOrder | undefined>;
  readonly orderState: (tenantId: string, orderId: string) => Promise<string | undefined>;
  readonly recordAccessRefusal: (tenantId: string, r: StorefrontAccessRefusal) => Promise<void>;
  readonly issuedCode: (tenantId: string, orderId: string) => Promise<IssuedCode | undefined>;
  /** Append a code — idempotent on the order: whoever wrote first, that code stands. */
  readonly recordCode: (tenantId: string, code: IssuedCode) => Promise<void>;
  readonly orderStop: (tenantId: string, orderId: string) => Promise<OrderStop | undefined>;
  /** Every stop head office put on a route (from the same index), for the ETA. */
  readonly routeStops: (tenantId: string, routeId: string) => Promise<readonly OrderStop[]>;
  /** The stops the driver has FINISHED on a route (a door outcome), with the phone's stamp. */
  readonly finishedStops: (tenantId: string, routeId: string) => Promise<readonly EtaStamp[]>;
  /** What the driver's phone said at the door for one order — the latest door outcome's proof check. */
  readonly doorProof: (tenantId: string, orderId: string) => Promise<Record<string, unknown> | undefined>;
  readonly proofImages: (tenantId: string, orderRef: string) => Promise<readonly ProofImage[]>;
  readonly proofImage: (tenantId: string, imageId: string) => Promise<(ProofImage & { readonly contentBase64: string }) | undefined>;
  readonly recordProofImage: (tenantId: string, image: ProofImage, contentBase64: string) => Promise<void>;
  readonly permissionsOfUser: (tenantId: string, userId: string) => Promise<readonly string[] | undefined>;
  readonly randomInt: (max: number) => number;
  readonly now: () => string;
  readonly recordAudit?: (tenantId: string, entry: AuditEntry) => Promise<unknown> | void;
}

const isStr = (v: unknown): v is string => typeof v === 'string' && v.trim() !== '';
const isObj = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === 'object' && !Array.isArray(v);
const TERMINAL_ORDER = new Set(['delivered', 'collected', 'returned', 'cancelled']);

/** The order's code — issued now if it has none (once, whoever asks first). Only a delivery order has one. */
export async function codeFor(deps: Pick<DeliveryProofDeps, 'issuedCode' | 'recordCode' | 'randomInt' | 'now'>, tenantId: string, orderId: string, issuedFor: IssuedCode['issuedFor']): Promise<IssuedCode> {
  const held = await deps.issuedCode(tenantId, orderId);
  if (held !== undefined) return held;
  await deps.recordCode(tenantId, { orderId, code: newDeliveryCode(deps.randomInt), issuedAt: deps.now(), issuedFor });
  return (await deps.issuedCode(tenantId, orderId))!;
}

const CODE_WORDS = {
  en: 'Read these four numbers to the driver when your order arrives. Do not share them before then.',
  ta: 'உங்கள் ஆர்டர் வரும்போது இந்த நான்கு எண்களை டிரைவரிடம் படித்துச் சொல்லுங்கள். அதற்கு முன் யாரிடமும் பகிர வேண்டாம்.',
} as const;

export function deliveryProofRoutes(deps: DeliveryProofDeps): readonly Route[] {
  // Refuse-and-record, the storefront's own rule: a customer's request for what is not theirs is turned away and kept (#6).
  const ownOrRefused = async (tenantId: string, customerRef: string, orderId: string): Promise<ProofOrder> => {
    const order = await deps.placedOrder(tenantId, orderId);
    const decision = scopeOrderToCustomer({ order, customerRef });
    if (decision.securityEvent && decision.outcome !== 'own' && decision.outcome !== 'unknown') {
      await deps.recordAccessRefusal(tenantId, { customerRef, orderId, outcome: decision.outcome, action: 'read', at: deps.now() });
    }
    if (decision.outcome === 'unknown') throw apiError(404, { code: 'order_unknown', whatHappened: `No order "${orderId}" has been placed.`, wasItSaved: 'not_saved', nextSafeAction: 'Check the order reference. Nothing was changed.' });
    if (!decision.allowed) throw apiError(403, { code: decision.outcome, whatHappened: `${decision.detail}. You can only see your own orders. This attempt was recorded.`, wasItSaved: 'not_saved', nextSafeAction: 'Nothing was changed.' });
    return order!;
  };
  const deliveryOnly = (order: ProofOrder): void => {
    if (order.fulfilment !== 'delivery') {
      throw apiError(409, { code: 'not_a_delivery', whatHappened: `${order.orderId} is collected from the store, not delivered — it has no delivery code or route.`, wasItSaved: 'not_saved', nextSafeAction: 'Nothing to show. Collect it from the store.' });
    }
  };

  return [
    {
      api: 'API-07', method: 'GET', path: '/v1/storefront/orders/:orderId/delivery-code',
      permission: 'storefront.order.read', entitlement: 'customer_app',
      handler: async (ctx) => {
        const order = await ownOrRefused(ctx.tenantId, ctx.userId, ctx.params['orderId'] ?? '');
        deliveryOnly(order);
        const state = await deps.orderState(ctx.tenantId, order.orderId);
        if (state === 'cancelled') throw apiError(409, { code: 'order_cancelled', whatHappened: `${order.orderId} was cancelled, so it has no delivery code.`, wasItSaved: 'not_saved', nextSafeAction: 'Nothing to show.' });
        const issued = await codeFor(deps, ctx.tenantId, order.orderId, 'customer_app');
        const used = state !== undefined && TERMINAL_ORDER.has(state);
        return { status: 200, body: { orderId: order.orderId, code: issued.code, digits: issued.code.length, issuedAt: issued.issuedAt, used, tellTheCustomer: CODE_WORDS } };
      },
    },
    {
      api: 'API-07', method: 'GET', path: '/v1/storefront/orders/:orderId/delivery-eta',
      permission: 'storefront.order.read', entitlement: 'customer_app',
      handler: async (ctx) => {
        const order = await ownOrRefused(ctx.tenantId, ctx.userId, ctx.params['orderId'] ?? '');
        deliveryOnly(order);
        const stop = await deps.orderStop(ctx.tenantId, order.orderId);
        if (stop === undefined) {
          const eta = customerEta({ orderId: order.orderId, stops: [], stamps: [] });
          return { status: 200, body: { ...eta, slot: null, asAt: deps.now(), detail: 'Your order is not on a driver\'s route yet. You will see the driver\'s progress here once it is.' } };
        }
        const stops: EtaStop[] = (await deps.routeStops(ctx.tenantId, stop.routeId)).map((s) => ({ stopId: s.stopId, orderId: s.orderId, sequence: s.sequence, plannedArrivalAt: s.plannedArrivalAt }));
        const eta = customerEta({ orderId: order.orderId, stops, stamps: await deps.finishedStops(ctx.tenantId, stop.routeId) });
        // Counts and times only — never another customer's area, order or time.
        return {
          status: 200,
          body: {
            ...eta, slot: { startsAt: stop.slotStartsAt, endsAt: stop.slotEndsAt }, asAt: deps.now(),
            detail: eta.state === 'reached' ? 'The driver has been to your door.'
              : eta.state === 'not_started' ? 'Your order is on the driver\'s route. The driver has not finished a stop yet.'
                : `The driver has finished ${eta.stopsDone} of ${eta.stopsOnRun} stops; ${eta.stopsBeforeYou} before yours. The time is an estimate on straight-line distances, not a map.`,
          },
        };
      },
    },
    {
      // A photo or signature captured on the driver's phone (`DeliveryProofCaptured`), relayed by the box. Kept as a
      // document: the bytes are checked for type from the file itself and for size, the phone's SHA-256 must be the bytes'
      // own, and the same image re-sent is one record. The driver named is re-verified and a breach is FLAGGED on the
      // record — never a silent keep, never a silent drop. Nothing is ever deleted (#6).
      api: 'API-08', method: 'POST', path: '/v1/delivery/routes/:routeId/stops/:stopId/proof/synced',
      permission: 'delivery.stop.sync', entitlement: 'delivery', idempotent: true,
      handler: async (ctx) => {
        const routeId = (ctx.params['routeId'] ?? '').trim();
        const stopId = (ctx.params['stopId'] ?? '').trim();
        const b = ctx.body;
        const bad = (why: string) => apiError(400, {
          code: 'not_readable_as_a_proof_image',
          whatHappened: `This could not be kept as a proof image from a driver's phone: ${why}.`,
          wasItSaved: 'not_saved',
          nextSafeAction: 'Do not discard it at the store. Keep it in the queue and raise it — it is the evidence a delivery happened.',
        });
        if (!isObj(b) || routeId === '' || stopId === '' || (isStr(b['routeId']) && b['routeId'] !== routeId) || (isStr(b['stopId']) && b['stopId'] !== stopId)) throw bad('the route and stop must match the path');
        const kind = b['kind'];
        if (typeof kind !== 'string' || !IMAGE_PROOF_KINDS.has(kind)) throw bad('the kind must be photo or signature');
        if (!isStr(b['driverId']) || !isStr(b['orderRef']) || !isStr(b['sha256']) || !/^[0-9a-f]{64}$/.test(b['sha256']) || !isStr(b['mediaType']) || !isStr(b['contentBase64'])) throw bad('it needs driverId, orderRef, mediaType, sha256 and contentBase64');
        if (b['contentBase64'].length > PROOF_IMAGE_MAX_BASE64) throw bad(`the image is larger than the ${PROOF_IMAGE_MAX_BASE64} characters a proof image may be`);
        const bytes = Buffer.from(b['contentBase64'], 'base64');
        const checked = checkProductImage(b['mediaType'], new Uint8Array(bytes));
        if (!checked.ok) throw bad(checked.detail);
        const sha256 = createHash('sha256').update(bytes).digest('hex');
        if (sha256 !== b['sha256']) throw bad('the SHA-256 the phone sent is not the image\'s own — the file changed on the way');
        const imageId = `proof-${sha256.slice(0, 32)}`;
        const prior = await deps.proofImage(ctx.tenantId, imageId);
        if (prior !== undefined) {
          const { contentBase64: _c, ...meta } = prior; void _c;
          return { status: 200, body: { imageId, recorded: true, alreadyRecorded: true, image: meta } };
        }
        const permissions = await deps.permissionsOfUser(ctx.tenantId, b['driverId']);
        const flags = permissions === undefined ? ['driver_unknown'] : permissions.includes('delivery.attempt.record') ? [] : ['driver_lacks_authority'];
        const now = deps.now();
        const capturedAt = isStr(b['capturedAt']) && !Number.isNaN(Date.parse(b['capturedAt'])) ? b['capturedAt'] : now;
        const image: ProofImage = {
          imageId, kind: kind as 'photo' | 'signature', routeId, stopId, orderRef: b['orderRef'], driverId: b['driverId'],
          mediaType: checked.mediaType, bytes: bytes.length, sha256, capturedAt, relayedBy: ctx.userId, receivedAt: now, governanceFlags: flags,
        };
        await deps.recordProofImage(ctx.tenantId, image, b['contentBase64']);
        await deps.recordAudit?.(ctx.tenantId, {
          actorId: image.driverId, action: 'delivery.proof.image', objectType: 'delivery_route', objectId: routeId,
          at: now, origin: { tenantId: ctx.tenantId, branchId: ctx.branchId ?? null }, before: null,
          after: { stopId, orderRef: image.orderRef, kind: image.kind, sha256, bytes: String(image.bytes), relayedBy: ctx.userId, flags: flags.join(',') },
          correlationId: routeId,
        });
        return { status: 202, body: { imageId, recorded: true, flags } };
      },
    },
    {
      // One order's proof as the dispatcher reads it: whether a code was issued (never the code), what the phone said at
      // the door and how head office judged it, and the images kept — without their bytes.
      api: 'API-08', method: 'GET', path: '/v1/delivery/orders/:orderId/proof',
      permission: 'delivery.run.read', entitlement: 'delivery',
      handler: async (ctx) => {
        const orderId = (ctx.params['orderId'] ?? '').trim();
        const issued = await deps.issuedCode(ctx.tenantId, orderId);
        return {
          status: 200,
          body: {
            orderId, codeIssued: issued !== undefined, ...(issued === undefined ? {} : { codeIssuedAt: issued.issuedAt }),
            door: (await deps.doorProof(ctx.tenantId, orderId)) ?? null,
            images: await deps.proofImages(ctx.tenantId, orderId),
            asAt: deps.now(),
          },
        };
      },
    },
    {
      api: 'API-08', method: 'GET', path: '/v1/delivery/proof-images/:imageId',
      permission: 'delivery.run.read', entitlement: 'delivery',
      handler: async (ctx) => {
        const held = await deps.proofImage(ctx.tenantId, (ctx.params['imageId'] ?? '').trim());
        if (held === undefined) throw apiError(404, { code: 'no_such_proof_image', whatHappened: 'Head office holds no proof image with that id.', wasItSaved: 'not_saved', nextSafeAction: 'Check the id on the order\'s proof. Nothing was changed.' });
        return { status: 200, body: held };
      },
    },
  ];
}
