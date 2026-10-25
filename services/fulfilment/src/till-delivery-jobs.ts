// OB-352 (owner, 24 Oct 2026, in writing — M12-FR-02 · OB-299): THE TILL DELIVERY'S ADDRESS AND SLOT.
//
//   "The customer app's saved address and slot when the customer has the app; otherwise the delivery desk enters them
//    against the till job (the till prints a delivery slip)."
//
// A bill the till marked for delivery is booked at head office as ONE delivery job (`till-<saleId>`, OB-299), paid in
// full at the till. It has goods and no address or slot yet, so the dispatch board cannot plan it. This module gives it
// both, by exactly one of the two paths the owner chose:
//
//   • THE CUSTOMER HAS THE APP — the bill named a loyalty member whose membership is tied to an app account now (the desk
//     linked it, seen on the phone). The job shows in that customer's app; they choose one of their own SAVED addresses and
//     an open slot (`POST /v1/me/till-deliveries/:orderId/delivery`). The delivery desk does not type it for them.
//   • OTHERWISE — no member on the bill, or a member with no app: the till printed a delivery slip, and the DELIVERY DESK
//     enters the address (a map point, kept to about 100 metres, and a landmark) and the slot against the job
//     (`POST /v1/delivery/till-jobs/:orderId/delivery`).
//
// Either way the slot is bound through head office's own delivery service (`bindDelivery`: inside the radius, a slot its
// policy offers, not too soon, with room — the last place taken once), which records the SAME slot booking an online
// order's placement records, with the location — so the dispatch board plans the job like any other delivery. Booked
// once: a second entry is refused by name (never a silent overwrite, hard rule #10). Every entry is sealed on the audit
// trail in the name of whoever made it. Nothing here moves money or stock (the till's sale already did both).

import type { Route, RequestContext } from '../../kernel/src/index';
import { apiError, notFound, scopeOf } from '../../kernel/src/index';
import type { AuditEntry } from '../../../packages/audit/src/index';
import type { SlotOffer } from '../../../packages/storefront/src/checkout';

/** The till delivery job as head office booked it from the till's bill (OB-299). */
export interface TillDeliveryJob {
  readonly orderId: string;
  readonly saleId: string;
  readonly receiptNumber: string;
  /** The store the bill was rung at — where the goods go out from. */
  readonly locationId: string;
  /** The loyalty member code the bill named, when one was keyed (never a phone number). */
  readonly memberRef?: string;
  readonly bookedAt: string;
}

/** Who gave a job its address and slot, and when (the booking itself is the delivery service's slot booking). */
export interface TillDeliveryGiven {
  readonly orderId: string;
  readonly by: 'customer_app' | 'delivery_desk';
  readonly personId: string;
  readonly slotStartsAt: string;
  readonly slotEndsAt: string;
  /** The customer's saved address chosen (app path). */
  readonly addressId?: string;
  /** A landmark to find the door by (at most 80 characters). */
  readonly landmark?: string;
  readonly at: string;
}

export interface TillDeliveryJobDeps {
  readonly jobs: (tenantId: string) => Promise<readonly TillDeliveryJob[]>;
  readonly given: (tenantId: string) => Promise<readonly TillDeliveryGiven[]>;
  readonly recordGiven: (tenantId: string, g: TillDeliveryGiven) => Promise<void>;
  /** The app account a membership is tied to now (OB-352 "has the app"), or undefined. */
  readonly appAccountOfMember: (tenantId: string, memberRef: string) => Promise<string | undefined>;
  /** The membership an app account is tied to now, or undefined. */
  readonly memberOfAppAccount: (tenantId: string, customerRef: string) => Promise<string | undefined>;
  /** The customer's own saved addresses now (removed ones left out): id, label, the location, the landmark. */
  readonly savedAddresses: (tenantId: string, customerRef: string) => Promise<readonly { readonly addressId: string; readonly label: string; readonly location: { readonly lat: number; readonly lon: number }; readonly landmark?: string }[]>;
  /** Bind the slot and the location through head office's own delivery service — throws its refusal. */
  readonly bind: (tenantId: string, orderId: string, bookedFor: string, slotStartsAt: string, location: { readonly lat: number; readonly lon: number }) => Promise<{ readonly slot: SlotOffer; readonly distanceMetres: number; readonly radiusMetres: number }>;
  /** The open slots of a day. */
  readonly openSlots: (tenantId: string, day: string) => Promise<readonly SlotOffer[]>;
  /** The order's state on the orders register now. */
  readonly orderState: (tenantId: string, orderId: string) => Promise<string | undefined>;
  /** The shop's calendar day for an instant. */
  readonly dayOf: (tenantId: string, iso: string) => Promise<string>;
  readonly now: () => string;
  readonly recordAudit?: (tenantId: string, entry: AuditEntry) => Promise<unknown> | void;
}

export type TillJobStatus = 'waiting_for_customer_app' | 'waiting_for_delivery_desk' | 'booked';

/** One job as a screen reads it. */
export interface TillJobView {
  readonly orderId: string;
  readonly receiptNumber: string;
  readonly saleId: string;
  readonly locationId: string;
  readonly bookedAt: string;
  readonly orderState: string | null;
  /** Which path the owner's rule puts this job on. */
  readonly path: 'customer_app' | 'delivery_desk';
  readonly status: TillJobStatus;
  readonly given: TillDeliveryGiven | null;
}

const isStr = (v: unknown): v is string => typeof v === 'string' && v.trim() !== '';
const isObj = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === 'object' && !Array.isArray(v);
const isLatLon = (v: unknown): v is { lat: number; lon: number } => isObj(v) && typeof v['lat'] === 'number' && typeof v['lon'] === 'number'
  && Number.isFinite(v['lat']) && Number.isFinite(v['lon']) && Math.abs(v['lat']) <= 90 && Math.abs(v['lon']) <= 180;
const DAY = /^\d{4}-\d{2}-\d{2}$/;

/** The latest job record per order, and the first address given per order (a booking is made once). */
function fold(jobs: readonly TillDeliveryJob[], given: readonly TillDeliveryGiven[]): { readonly jobs: ReadonlyMap<string, TillDeliveryJob>; readonly given: ReadonlyMap<string, TillDeliveryGiven> } {
  const j = new Map<string, TillDeliveryJob>();
  for (const x of jobs) if (!j.has(x.orderId)) j.set(x.orderId, x);
  const g = new Map<string, TillDeliveryGiven>();
  for (const x of given) if (!g.has(x.orderId)) g.set(x.orderId, x);
  return { jobs: j, given: g };
}

async function viewOf(deps: TillDeliveryJobDeps, tenantId: string, job: TillDeliveryJob, given: TillDeliveryGiven | undefined): Promise<TillJobView> {
  const app = job.memberRef === undefined ? undefined : await deps.appAccountOfMember(tenantId, job.memberRef);
  const path = app === undefined ? 'delivery_desk' : 'customer_app';
  return {
    orderId: job.orderId, receiptNumber: job.receiptNumber, saleId: job.saleId, locationId: job.locationId, bookedAt: job.bookedAt,
    orderState: (await deps.orderState(tenantId, job.orderId)) ?? null,
    path, status: given !== undefined ? 'booked' : path === 'customer_app' ? 'waiting_for_customer_app' : 'waiting_for_delivery_desk',
    given: given ?? null,
  };
}

const refuse = (status: number, code: string, whatHappened: string, nextSafeAction: string): never => {
  throw apiError(status, { code, whatHappened, wasItSaved: 'not_saved', nextSafeAction });
};

/** Today and the next day, in the shop's calendar — the days a job's slots are offered for (or one asked for). */
async function offerDays(deps: TillDeliveryJobDeps, tenantId: string, asked: string | undefined): Promise<readonly string[]> {
  if (asked !== undefined && DAY.test(asked)) return [asked];
  const today = await deps.dayOf(tenantId, deps.now());
  const tomorrow = await deps.dayOf(tenantId, new Date(Date.parse(deps.now()) + 86_400_000).toISOString());
  return today === tomorrow ? [today] : [today, tomorrow];
}

async function slotsFor(deps: TillDeliveryJobDeps, tenantId: string, days: readonly string[]): Promise<readonly SlotOffer[]> {
  const out: SlotOffer[] = [];
  for (const d of days) out.push(...await deps.openSlots(tenantId, d));
  return out;
}

export function tillDeliveryJobRoutes(deps: TillDeliveryJobDeps): readonly Route[] {
  const seal = async (ctx: RequestContext, g: TillDeliveryGiven, job: TillDeliveryJob): Promise<void> => {
    await deps.recordAudit?.(ctx.tenantId, {
      actorId: ctx.userId, action: 'delivery.till_job.address_given', objectType: 'delivery_order', objectId: g.orderId, at: g.at,
      origin: { tenantId: ctx.tenantId, branchId: job.locationId }, before: null,
      after: { by: g.by, slotStartsAt: g.slotStartsAt, ...(g.addressId === undefined ? {} : { addressId: g.addressId }), receiptNumber: job.receiptNumber },
      correlationId: g.orderId,
    } as AuditEntry);
  };
  const jobOrRefuse = async (tenantId: string, orderId: string): Promise<{ job: TillDeliveryJob; given: TillDeliveryGiven | undefined }> => {
    const f = fold(await deps.jobs(tenantId), await deps.given(tenantId));
    const job = f.jobs.get(orderId);
    if (job === undefined) throw notFound(`till delivery job ${orderId}`);
    return { job, given: f.given.get(orderId) };
  };
  const alreadyBooked = (g: TillDeliveryGiven): never => refuse(409, 'till_job_already_has_its_address',
    `This delivery already has its address and slot (${g.slotStartsAt}, given ${g.by === 'customer_app' ? 'in the customer app' : 'at the delivery desk'} by ${g.personId}).`,
    'Nothing was changed. To change a booked delivery, the dispatch desk handles it with the customer.');

  return [
    {
      // The delivery desk's list: every till delivery job at the stores the reader holds — which path it is on, whether it
      // still waits for its address and slot, and the open slots of the day (?day=YYYY-MM-DD; default today and tomorrow).
      api: 'API-08', method: 'GET', path: '/v1/delivery/till-jobs',
      permission: 'delivery.run.read', entitlement: 'delivery',
      handler: async (ctx) => {
        const scope = scopeOf(ctx);
        const storeId = isStr(ctx.query['storeId']) ? ctx.query['storeId'].trim() : undefined;
        const f = fold(await deps.jobs(ctx.tenantId), await deps.given(ctx.tenantId));
        const rows: TillJobView[] = [];
        for (const job of f.jobs.values()) {
          if ((scope !== 'all' && !scope.includes(job.locationId)) || (storeId !== undefined && job.locationId !== storeId)) continue;
          rows.push(await viewOf(deps, ctx.tenantId, job, f.given.get(job.orderId)));
        }
        const rank: Record<TillJobStatus, number> = { waiting_for_delivery_desk: 0, waiting_for_customer_app: 1, booked: 2 };
        rows.sort((a, b) => rank[a.status] - rank[b.status] || a.bookedAt.localeCompare(b.bookedAt) || a.orderId.localeCompare(b.orderId));
        const days = await offerDays(deps, ctx.tenantId, typeof ctx.query['day'] === 'string' ? ctx.query['day'] : undefined);
        return {
          status: 200,
          body: {
            jobs: rows, waitingForDesk: rows.filter((r) => r.status === 'waiting_for_delivery_desk').length,
            waitingForCustomer: rows.filter((r) => r.status === 'waiting_for_customer_app').length,
            days, openSlots: await slotsFor(deps, ctx.tenantId, days), asAt: deps.now(),
          },
        };
      },
    },
    {
      // The delivery desk enters the address and slot from the till's delivery slip. Body: { slotStartsAt, deliveryLocation:
      // { lat, lon }, landmark? }. Only for a job whose customer has no app — an app customer chooses in their own app.
      api: 'API-08', method: 'POST', path: '/v1/delivery/till-jobs/:orderId/delivery',
      permission: 'delivery.dispatch.manage', entitlement: 'delivery', idempotent: true,
      handler: async (ctx) => {
        const orderId = (ctx.params['orderId'] ?? '').trim();
        const b = (ctx.body ?? {}) as Record<string, unknown>;
        const landmark = typeof b['landmark'] === 'string' ? b['landmark'].trim() : '';
        if (!isStr(b['slotStartsAt']) || Number.isNaN(Date.parse(b['slotStartsAt'])) || !isLatLon(b['deliveryLocation']) || landmark.length > 80) {
          refuse(400, 'not_readable_as_a_till_delivery', 'A till delivery needs { slotStartsAt, deliveryLocation: { lat, lon }, landmark? (up to 80) } — the slot and the door, from the delivery slip.', 'Send it again. Nothing was saved.');
        }
        const { job, given } = await jobOrRefuse(ctx.tenantId, orderId);
        const scope = scopeOf(ctx);
        if (scope !== 'all' && !scope.includes(job.locationId)) {
          throw apiError(403, { code: 'outside_your_branches', whatHappened: `This delivery goes out from ${job.locationId}, which your sign-in does not reach.`, wasItSaved: 'not_saved', nextSafeAction: 'The delivery desk for that store enters it. Nothing was saved.' });
        }
        if (given !== undefined) alreadyBooked(given);
        const app = job.memberRef === undefined ? undefined : await deps.appAccountOfMember(ctx.tenantId, job.memberRef);
        if (app !== undefined) {
          refuse(409, 'customer_chooses_in_the_app', 'This customer has the SRE app: they choose one of their saved addresses and a slot there (OB-352). The delivery desk does not enter it for them.', 'Ask the customer to open the app and choose. Nothing was saved.');
        }
        const loc = b['deliveryLocation'] as { lat: number; lon: number };
        const location = { lat: Math.round(loc.lat * 1000) / 1000, lon: Math.round(loc.lon * 1000) / 1000 }; // about 100 metres (P-04)
        const bound = await deps.bind(ctx.tenantId, orderId, `till-desk:${job.receiptNumber}`, new Date(Date.parse(b['slotStartsAt'] as string)).toISOString(), location);
        const g: TillDeliveryGiven = { orderId, by: 'delivery_desk', personId: ctx.userId, slotStartsAt: bound.slot.startsAt, slotEndsAt: bound.slot.endsAt, ...(landmark === '' ? {} : { landmark }), at: deps.now() };
        await deps.recordGiven(ctx.tenantId, g);
        await seal(ctx, g, job);
        return { status: 201, body: { job: await viewOf(deps, ctx.tenantId, job, g), slot: bound.slot, distanceMetres: bound.distanceMetres, radiusMetres: bound.radiusMetres } };
      },
    },
    {
      // The customer's own till deliveries (the bills that named their membership): each one waiting for its address and
      // slot, with their saved addresses and the open slots to choose from.
      api: 'API-07', method: 'GET', path: '/v1/me/till-deliveries',
      permission: 'storefront.order.read', entitlement: 'customer_app',
      handler: async (ctx) => {
        const member = await deps.memberOfAppAccount(ctx.tenantId, ctx.userId);
        const f = fold(await deps.jobs(ctx.tenantId), await deps.given(ctx.tenantId));
        const rows = member === undefined ? [] : await Promise.all([...f.jobs.values()].filter((j) => j.memberRef === member)
          .sort((a, b) => b.bookedAt.localeCompare(a.bookedAt)).map((j) => viewOf(deps, ctx.tenantId, j, f.given.get(j.orderId))));
        const days = await offerDays(deps, ctx.tenantId, undefined);
        return {
          status: 200,
          body: {
            linked: member !== undefined,
            deliveries: rows.map((r) => ({ orderId: r.orderId, receiptNumber: r.receiptNumber, bookedAt: r.bookedAt, status: r.status, given: r.given === null ? null : { slotStartsAt: r.given.slotStartsAt, slotEndsAt: r.given.slotEndsAt, addressId: r.given.addressId ?? null } })),
            addresses: (await deps.savedAddresses(ctx.tenantId, ctx.userId)).map((a) => ({ addressId: a.addressId, label: a.label, ...(a.landmark === undefined ? {} : { landmark: a.landmark }) })),
            openSlots: rows.some((r) => r.status === 'waiting_for_customer_app') ? await slotsFor(deps, ctx.tenantId, days) : [],
          },
        };
      },
    },
    {
      // The customer chooses: { addressId (one of MY saved addresses), slotStartsAt }.
      api: 'API-07', method: 'POST', path: '/v1/me/till-deliveries/:orderId/delivery',
      permission: 'storefront.order.place', entitlement: 'customer_app', idempotent: true,
      handler: async (ctx) => {
        const orderId = (ctx.params['orderId'] ?? '').trim();
        const b = (ctx.body ?? {}) as Record<string, unknown>;
        if (!isStr(b['addressId']) || !isStr(b['slotStartsAt']) || Number.isNaN(Date.parse(b['slotStartsAt']))) {
          refuse(400, 'not_readable_as_a_till_delivery_choice', 'Choose one of your saved addresses { addressId } and a slot { slotStartsAt }.', 'Nothing was saved.');
        }
        const { job, given } = await jobOrRefuse(ctx.tenantId, orderId);
        const member = await deps.memberOfAppAccount(ctx.tenantId, ctx.userId);
        if (member === undefined || job.memberRef !== member) {
          throw apiError(403, { code: 'not_your_delivery', whatHappened: 'This delivery is not on a bill in your name.', wasItSaved: 'not_saved', nextSafeAction: 'Nothing was saved.' });
        }
        if (given !== undefined) alreadyBooked(given);
        const address = (await deps.savedAddresses(ctx.tenantId, ctx.userId)).find((a) => a.addressId === (b['addressId'] as string).trim());
        if (address === undefined) {
          refuse(422, 'address_not_saved', 'That is not one of your saved addresses.', 'Save the address in your account first, then choose it. Nothing was saved.');
        }
        const bound = await deps.bind(ctx.tenantId, orderId, ctx.userId, new Date(Date.parse(b['slotStartsAt'] as string)).toISOString(), address!.location);
        const g: TillDeliveryGiven = { orderId, by: 'customer_app', personId: ctx.userId, slotStartsAt: bound.slot.startsAt, slotEndsAt: bound.slot.endsAt, addressId: address!.addressId, ...(address!.landmark === undefined ? {} : { landmark: address!.landmark }), at: deps.now() };
        await deps.recordGiven(ctx.tenantId, g);
        await seal(ctx, g, job);
        return { status: 201, body: { orderId, slot: bound.slot, addressId: address!.addressId, status: 'booked' } };
      },
    },
  ];
}
