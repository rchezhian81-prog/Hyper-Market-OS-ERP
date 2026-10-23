// API-08 — settling the shop's own delivery fleet per run, and the courier-partner link built switched OFF (D09-FR-06 ·
// D14-FR-04 · OB-294 · §28 · hard rules #2/#6/#10).
//
//   POST /v1/delivery/fleet-settlements/:routeId           propose the run's settlement — computed from head office's own
//                                                          stop register at the owner's fleet rate, never a typed figure
//   POST /v1/delivery/fleet-settlements/:routeId/approve   a SECOND person approves it (never the one who proposed it)
//   POST /v1/delivery/fleet-settlements/:routeId/paid      the payment made against it, with its voucher; a difference from
//                                                          the approved amount is kept and said, never balanced away
//   GET  /v1/delivery/fleet-settlements/:routeId           the settlement's record: proposed → approved → paid, and differences
//   GET  /v1/delivery/courier-link                         the courier-partner link — OFF (own drivers only, OB-294)
//   POST /v1/delivery/courier/:orderId/hand-off            refused while the link is off; nothing leaves the shop
//
// Every step is a new record on the run's own stream (append-only). Posting the settlement to the books is the finance
// bridge's job and is not done here; the register says so on every read.

import type { Route } from '../../kernel/src/index';
import { apiError } from '../../kernel/src/index';
import type { AuditEntry } from '../../../packages/audit/src/index';
import { fleetSettlementOf, type CourierPartnerLink, type FleetRate } from '../../../packages/fulfilment/src/index';
import { latestStops, type RouteStopUpdate } from './driver-runs';

export type FleetSettlementStep =
  | { readonly step: 'proposed'; readonly routeId: string; readonly driverId: string; readonly drops: number; readonly rate: FleetRate; readonly amountMinor: number; readonly by: string; readonly at: string }
  | { readonly step: 'approved'; readonly routeId: string; readonly amountMinor: number; readonly by: string; readonly at: string }
  | { readonly step: 'paid'; readonly routeId: string; readonly amountMinor: number; readonly voucherRef: string; readonly by: string; readonly at: string };

export interface FleetSettlementDeps {
  readonly fleetRate: (tenantId: string) => Promise<FleetRate | undefined>;
  readonly routeDriver: (tenantId: string, routeId: string) => Promise<string | undefined>;
  readonly stopUpdates: (tenantId: string, routeId: string) => Promise<readonly RouteStopUpdate[]>;
  readonly steps: (tenantId: string, routeId: string) => Promise<readonly FleetSettlementStep[]>;
  readonly recordStep: (tenantId: string, s: FleetSettlementStep) => Promise<void>;
  readonly courier: CourierPartnerLink;
  readonly now: () => string;
  readonly recordAudit?: (tenantId: string, entry: AuditEntry) => Promise<unknown> | void;
}

const isStr = (v: unknown): v is string => typeof v === 'string' && v.trim() !== '';

/** The register folded: where the settlement stands and every difference said. */
export function presentSettlement(routeId: string, steps: readonly FleetSettlementStep[]): Record<string, unknown> {
  const proposed = steps.filter((s) => s.step === 'proposed').at(-1);
  const approved = steps.filter((s) => s.step === 'approved').at(-1);
  const paid = steps.filter((s) => s.step === 'paid');
  const paidMinor = paid.reduce((n, p) => n + p.amountMinor, 0);
  const stage = paid.length > 0 ? 'paid' : approved !== undefined ? 'approved' : proposed !== undefined ? 'proposed' : 'not_proposed';
  return {
    routeId, stage, proposed: proposed ?? null, approved: approved ?? null, payments: paid, paidMinor,
    differenceMinor: approved === undefined ? null : paidMinor - approved.amountMinor,
    books: 'not posted here — the finance bridge posts delivery costs to the books',
  };
}

const DROPS: ReadonlySet<string> = new Set(['delivered', 'partially_delivered']);

export function fleetSettlementRoutes(deps: FleetSettlementDeps): readonly Route[] {
  const audit = async (tenantId: string, branchId: string | null, actorId: string, action: string, routeId: string, after: Record<string, string>) => deps.recordAudit?.(tenantId, {
    actorId, action, objectType: 'delivery_route', objectId: routeId, at: deps.now(), origin: { tenantId, branchId }, before: null, after, correlationId: routeId,
  });
  const routeOf = (p: Readonly<Record<string, string>>): string => {
    const routeId = (p['routeId'] ?? '').trim();
    if (routeId === '') throw apiError(400, { code: 'route_needed', whatHappened: 'Say which route.', wasItSaved: 'not_saved', nextSafeAction: 'Send the route id. Nothing was changed.' });
    return routeId;
  };
  return [
    {
      api: 'API-08', method: 'POST', path: '/v1/delivery/fleet-settlements/:routeId',
      permission: 'delivery.dispatch.manage', entitlement: 'delivery', idempotent: true,
      handler: async (ctx) => {
        const routeId = routeOf(ctx.params);
        const driverId = await deps.routeDriver(ctx.tenantId, routeId);
        if (driverId === undefined) throw apiError(404, { code: 'route_unknown', whatHappened: `No route ${routeId} was handed to a driver.`, wasItSaved: 'not_saved', nextSafeAction: 'Check the route. Nothing was changed.' });
        const steps = await deps.steps(ctx.tenantId, routeId);
        if (steps.some((s) => s.step === 'approved')) throw apiError(409, { code: 'already_approved', whatHappened: `${routeId}'s settlement is already approved; it is not proposed again.`, wasItSaved: 'not_saved', nextSafeAction: 'Record the payment against it. Nothing was changed.' });
        const drops = latestStops(await deps.stopUpdates(ctx.tenantId, routeId)).filter((u) => DROPS.has(u.state)).length;
        const rate = await deps.fleetRate(ctx.tenantId);
        const due = fleetSettlementOf(rate, drops);
        if (due === 'rate_not_set') throw apiError(409, { code: 'fleet_rate_not_set', whatHappened: 'The owner has not set the own-fleet settlement rate, so no run can be settled at it.', wasItSaved: 'not_saved', nextSafeAction: 'Ask the owner to enter the rate on the Dispatch page. Nothing was proposed.' });
        if (due === 'no_drops') throw apiError(409, { code: 'no_drops', whatHappened: `Head office holds no delivered door on ${routeId}, so there is nothing to settle.`, wasItSaved: 'not_saved', nextSafeAction: 'Wait for the driver\'s phone to reach the store computer. Nothing was proposed.' });
        const proposed = steps.filter((s) => s.step === 'proposed').at(-1);
        if (proposed !== undefined && proposed.step === 'proposed' && proposed.amountMinor === due.amountMinor && proposed.drops === drops) {
          return { status: 200, body: { ...presentSettlement(routeId, steps), alreadyProposed: true } };
        }
        const step: FleetSettlementStep = { step: 'proposed', routeId, driverId, drops, rate: rate!, amountMinor: due.amountMinor, by: ctx.userId, at: deps.now() };
        await deps.recordStep(ctx.tenantId, step);
        await audit(ctx.tenantId, ctx.branchId ?? null, ctx.userId, 'delivery.fleet.settle.propose', routeId, { driverId, drops: String(drops), amountMinor: String(due.amountMinor), basis: rate!.basis });
        return { status: 201, body: presentSettlement(routeId, [...steps, step]) };
      },
    },
    {
      api: 'API-08', method: 'POST', path: '/v1/delivery/fleet-settlements/:routeId/approve',
      permission: 'delivery.settlement.approve', entitlement: 'delivery', idempotent: true,
      handler: async (ctx) => {
        const routeId = routeOf(ctx.params);
        const steps = await deps.steps(ctx.tenantId, routeId);
        const proposed = steps.filter((s) => s.step === 'proposed').at(-1);
        if (proposed === undefined) throw apiError(409, { code: 'not_proposed', whatHappened: `${routeId} has no settlement proposed.`, wasItSaved: 'not_saved', nextSafeAction: 'Propose it first. Nothing was approved.' });
        if (proposed.by === ctx.userId) throw apiError(403, { code: 'cannot_approve_own_proposal', whatHappened: 'You proposed this settlement; a second person approves it (§28).', wasItSaved: 'not_saved', nextSafeAction: 'Ask another manager to approve. Nothing was approved.' });
        if (steps.some((s) => s.step === 'approved')) return { status: 200, body: { ...presentSettlement(routeId, steps), alreadyApproved: true } };
        const step: FleetSettlementStep = { step: 'approved', routeId, amountMinor: proposed.amountMinor, by: ctx.userId, at: deps.now() };
        await deps.recordStep(ctx.tenantId, step);
        await audit(ctx.tenantId, ctx.branchId ?? null, ctx.userId, 'delivery.fleet.settle.approve', routeId, { amountMinor: String(step.amountMinor), proposedBy: proposed.by });
        return { status: 201, body: presentSettlement(routeId, [...steps, step]) };
      },
    },
    {
      // Body: { amountMinor, voucherRef }.
      api: 'API-08', method: 'POST', path: '/v1/delivery/fleet-settlements/:routeId/paid',
      permission: 'delivery.settlement.approve', entitlement: 'delivery', idempotent: true,
      handler: async (ctx) => {
        const routeId = routeOf(ctx.params);
        const b = (ctx.body ?? {}) as Record<string, unknown>;
        if (!Number.isInteger(b['amountMinor']) || (b['amountMinor'] as number) <= 0 || !isStr(b['voucherRef'])) {
          throw apiError(400, { code: 'not_readable_as_a_payment', whatHappened: 'A payment needs { amountMinor (whole paise above zero), voucherRef }.', wasItSaved: 'not_saved', nextSafeAction: 'Send it again. Nothing was recorded.' });
        }
        const steps = await deps.steps(ctx.tenantId, routeId);
        if (!steps.some((s) => s.step === 'approved')) throw apiError(409, { code: 'not_approved', whatHappened: `${routeId}'s settlement is not approved, so nothing is paid against it.`, wasItSaved: 'not_saved', nextSafeAction: 'Have it approved first. Nothing was recorded.' });
        const voucherRef = (b['voucherRef'] as string).trim();
        if (steps.some((s) => s.step === 'paid' && s.voucherRef === voucherRef)) return { status: 200, body: { ...presentSettlement(routeId, steps), alreadyRecorded: true } };
        const step: FleetSettlementStep = { step: 'paid', routeId, amountMinor: b['amountMinor'] as number, voucherRef, by: ctx.userId, at: deps.now() };
        await deps.recordStep(ctx.tenantId, step);
        await audit(ctx.tenantId, ctx.branchId ?? null, ctx.userId, 'delivery.fleet.settle.paid', routeId, { amountMinor: String(step.amountMinor), voucherRef });
        return { status: 201, body: presentSettlement(routeId, [...steps, step]) };
      },
    },
    {
      api: 'API-08', method: 'GET', path: '/v1/delivery/fleet-settlements/:routeId',
      permission: 'delivery.run.read', entitlement: 'delivery',
      handler: async (ctx) => {
        const routeId = routeOf(ctx.params);
        return { status: 200, body: { ...presentSettlement(routeId, await deps.steps(ctx.tenantId, routeId)), rate: (await deps.fleetRate(ctx.tenantId)) ?? null, asAt: deps.now() } };
      },
    },
    {
      api: 'API-08', method: 'GET', path: '/v1/delivery/courier-link',
      permission: 'delivery.run.read', entitlement: 'delivery',
      handler: async () => ({
        status: 200,
        body: { on: deps.courier.on, partner: deps.courier.name, detail: deps.courier.on ? `Courier link to ${deps.courier.name} is on.` : 'Off — own drivers only (OB-294). Nothing is sent to any courier.' },
      }),
    },
    {
      // Body: { area, codMinor }. Refused while the link is off — nothing leaves the shop.
      api: 'API-08', method: 'POST', path: '/v1/delivery/courier/:orderId/hand-off',
      permission: 'delivery.dispatch.manage', entitlement: 'delivery', idempotent: true,
      handler: async (ctx) => {
        const orderId = (ctx.params['orderId'] ?? '').trim();
        const b = (ctx.body ?? {}) as Record<string, unknown>;
        if (!deps.courier.on) {
          throw apiError(409, { code: 'courier_link_off', whatHappened: 'The courier-partner link is switched off — own drivers only (OB-294). Nothing was sent.', wasItSaved: 'not_saved', nextSafeAction: 'Put the order on one of the shop\'s own routes.' });
        }
        if (orderId === '' || !isStr(b['area']) || !Number.isInteger(b['codMinor']) || (b['codMinor'] as number) < 0) {
          throw apiError(400, { code: 'not_readable_as_a_hand_off', whatHappened: 'A hand-off needs { area, codMinor } — a coarse area, never the customer\'s details.', wasItSaved: 'not_saved', nextSafeAction: 'Send it again. Nothing was sent.' });
        }
        const answer = await deps.courier.handOff({ orderId, area: (b['area'] as string).trim(), codMinor: b['codMinor'] as number });
        await audit(ctx.tenantId, ctx.branchId ?? null, ctx.userId, 'delivery.courier.hand_off', orderId, { partner: deps.courier.name, sent: String(answer.sent) });
        return { status: answer.sent ? 202 : 409, body: { orderId, ...answer } };
      },
    },
  ];
}
