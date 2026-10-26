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
// Every step is a new record on the run's own stream (append-only).
//
// D09-FR-06 · M23-FR-01 (OB-288 follow-up, 24 Oct 2026) — the settlement reaches the BOOKS through the accountant's posting
// map, by the existing posting gate, exactly as referral rewards do:
//
//   GET  /v1/finance/fleet-settlements         every settlement movement, posted or not, and anything the map cannot post
//   POST /v1/finance/fleet-settlements/post    the accountant posts the movements not yet posted
//
// Two movements per run: the APPROVED amount (`delivery_fleet:approved` — the accountant maps it, e.g. delivery cost debit,
// fleet payable credit) and each PAYMENT against it (`delivery_fleet:paid` — e.g. fleet payable debit, cash or bank
// credit). Each is ONE balanced journal, posted once (its id is the movement), never edited; a payment that differs from
// the approved amount posts what was paid and the difference stays on the payable, visible on the register — never
// balanced away (P-08). A kind the map does not name is an exception said by name, never silently unposted. A journal
// whose month is closed goes to the next open month with its real date (the posting gate's own rule).

import type { Route } from '../../kernel/src/index';
import { apiError } from '../../kernel/src/index';
import type { AuditEntry } from '../../../packages/audit/src/index';
import { fleetSettlementOf, type CourierPartnerLink, type FleetRate } from '../../../packages/fulfilment/src/index';
import { postJournal as postMapped, UnmappedKindError, MissingComponentError, UnbalancedJournalError, type PostingMap } from '../../../packages/finance/src/posting';
import { postJournal, type FinanceDeps, type JournalEntry } from '../../finance/src/index';
import { latestStops, type RouteStopUpdate } from './driver-runs';
import { shopClock, type ShopCalendarOf } from '../../../packages/calendar/src/shop-clock';

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
  /** D09-FR-06: the books. Absent (a bare composition) → the settlement reads "not posted" and nothing can post. */
  readonly books?: FleetBooksDeps;
}

/** What posting the fleet settlement needs from finance: the posting gate's own deps, the map and the journals kept. */
export interface FleetBooksDeps extends Pick<FinanceDeps, 'periodStates' | 'nextOpenPeriod' | 'appendJournal'> {
  /** Every route that has a settlement step, from the tenant-wide index. */
  readonly settledRoutes: (tenantId: string) => Promise<readonly string[]>;
  readonly postingMap: (tenantId: string) => Promise<PostingMap | undefined>;
  readonly fleetJournals: (tenantId: string) => Promise<readonly FleetJournal[]>;
  /** R1b (M01-FR-02): the shop's calendar — a movement's journal date and period are its shop trading day's. */
  readonly calendar?: ShopCalendarOf;
}

export interface FleetJournal extends JournalEntry {
  readonly fleet: { readonly movementId: string; readonly routeId: string; readonly kind: string; readonly belongsTo?: string };
}

export type FleetMovementKind = 'approved' | 'paid';
export interface FleetMovement {
  readonly movementId: string;
  readonly routeId: string;
  readonly kind: FleetMovementKind;
  readonly amountMinor: number;
  readonly at: string;
  readonly reference?: string;
}

/** The movements a run's settlement puts on the books: its approval once, and each payment by voucher. */
export function fleetMovements(routeId: string, steps: readonly FleetSettlementStep[]): FleetMovement[] {
  const out: FleetMovement[] = [];
  const approved = steps.find((s) => s.step === 'approved');
  if (approved !== undefined) out.push({ movementId: `fleet:approved:${routeId}`, routeId, kind: 'approved', amountMinor: approved.amountMinor, at: approved.at });
  const seen = new Set<string>();
  for (const p of steps) {
    if (p.step !== 'paid' || seen.has(p.voucherRef)) continue;
    seen.add(p.voucherRef);
    out.push({ movementId: `fleet:paid:${routeId}:${p.voucherRef}`, routeId, kind: 'paid', amountMinor: p.amountMinor, at: p.at, reference: p.voucherRef });
  }
  return out;
}

/** The posting-map kind of a movement. */
export const fleetKind = (k: FleetMovementKind): string => `delivery_fleet:${k}`;

const isStr = (v: unknown): v is string => typeof v === 'string' && v.trim() !== '';

/** The register folded: where the settlement stands and every difference said. */
export function presentSettlement(routeId: string, steps: readonly FleetSettlementStep[], posted?: ReadonlySet<string>): Record<string, unknown> {
  const proposed = steps.filter((s) => s.step === 'proposed').at(-1);
  const approved = steps.filter((s) => s.step === 'approved').at(-1);
  const paid = steps.filter((s) => s.step === 'paid');
  const paidMinor = paid.reduce((n, p) => n + p.amountMinor, 0);
  const stage = paid.length > 0 ? 'paid' : approved !== undefined ? 'approved' : proposed !== undefined ? 'proposed' : 'not_proposed';
  return {
    routeId, stage, proposed: proposed ?? null, approved: approved ?? null, payments: paid, paidMinor,
    differenceMinor: approved === undefined ? null : paidMinor - approved.amountMinor,
    books: booksOf(routeId, steps, posted),
  };
}

/** Whether this run's movements are on the books — never "posted" for a movement no journal carries (P-08). */
function booksOf(routeId: string, steps: readonly FleetSettlementStep[], posted: ReadonlySet<string> | undefined): Record<string, unknown> {
  const movements = fleetMovements(routeId, steps);
  if (posted === undefined) return { state: 'not_connected', posted: [], unposted: movements.map((m) => m.movementId), detail: 'This composition has no books connected, so nothing about this settlement is posted.' };
  const unposted = movements.filter((m) => !posted.has(m.movementId)).map((m) => m.movementId);
  const state = movements.length === 0 ? 'nothing_to_post' : unposted.length === 0 ? 'posted' : 'not_yet_posted';
  return {
    state, posted: movements.filter((m) => posted.has(m.movementId)).map((m) => m.movementId), unposted,
    detail: state === 'nothing_to_post' ? 'Nothing reaches the books until the settlement is approved.'
      : state === 'posted' ? 'Every approved amount and payment of this run is on the books.'
        : `${unposted.length} movement(s) not yet on the books — the accountant posts them (POST /v1/finance/fleet-settlements/post).`,
  };
}

const DROPS: ReadonlySet<string> = new Set(['delivered', 'partially_delivered']);

export function fleetSettlementRoutes(deps: FleetSettlementDeps): readonly Route[] {
  const audit = async (tenantId: string, branchId: string | null, actorId: string, action: string, routeId: string, after: Record<string, string>) => deps.recordAudit?.(tenantId, {
    actorId, action, objectType: 'delivery_route', objectId: routeId, at: deps.now(), origin: { tenantId, branchId }, before: null, after, correlationId: routeId,
  });
  const postedIds = async (tenantId: string): Promise<ReadonlySet<string> | undefined> =>
    deps.books === undefined ? undefined : new Set((await deps.books.fleetJournals(tenantId)).map((j) => j.fleet.movementId));
  const present = async (tenantId: string, routeId: string, steps: readonly FleetSettlementStep[]) => presentSettlement(routeId, steps, await postedIds(tenantId));
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
          return { status: 200, body: { ...await present(ctx.tenantId, routeId, steps), alreadyProposed: true } };
        }
        const step: FleetSettlementStep = { step: 'proposed', routeId, driverId, drops, rate: rate!, amountMinor: due.amountMinor, by: ctx.userId, at: deps.now() };
        await deps.recordStep(ctx.tenantId, step);
        await audit(ctx.tenantId, ctx.branchId ?? null, ctx.userId, 'delivery.fleet.settle.propose', routeId, { driverId, drops: String(drops), amountMinor: String(due.amountMinor), basis: rate!.basis });
        return { status: 201, body: await present(ctx.tenantId, routeId, [...steps, step]) };
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
        if (steps.some((s) => s.step === 'approved')) return { status: 200, body: { ...await present(ctx.tenantId, routeId, steps), alreadyApproved: true } };
        const step: FleetSettlementStep = { step: 'approved', routeId, amountMinor: proposed.amountMinor, by: ctx.userId, at: deps.now() };
        await deps.recordStep(ctx.tenantId, step);
        await audit(ctx.tenantId, ctx.branchId ?? null, ctx.userId, 'delivery.fleet.settle.approve', routeId, { amountMinor: String(step.amountMinor), proposedBy: proposed.by });
        return { status: 201, body: await present(ctx.tenantId, routeId, [...steps, step]) };
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
        if (steps.some((s) => s.step === 'paid' && s.voucherRef === voucherRef)) return { status: 200, body: { ...await present(ctx.tenantId, routeId, steps), alreadyRecorded: true } };
        const step: FleetSettlementStep = { step: 'paid', routeId, amountMinor: b['amountMinor'] as number, voucherRef, by: ctx.userId, at: deps.now() };
        await deps.recordStep(ctx.tenantId, step);
        await audit(ctx.tenantId, ctx.branchId ?? null, ctx.userId, 'delivery.fleet.settle.paid', routeId, { amountMinor: String(step.amountMinor), voucherRef });
        return { status: 201, body: await present(ctx.tenantId, routeId, [...steps, step]) };
      },
    },
    {
      api: 'API-08', method: 'GET', path: '/v1/delivery/fleet-settlements/:routeId',
      permission: 'delivery.run.read', entitlement: 'delivery',
      handler: async (ctx) => {
        const routeId = routeOf(ctx.params);
        return { status: 200, body: { ...await present(ctx.tenantId, routeId, await deps.steps(ctx.tenantId, routeId)), rate: (await deps.fleetRate(ctx.tenantId)) ?? null, asAt: deps.now() } };
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
    {
      // D09-FR-06: every settlement movement against the books — posted, not yet posted, and what the map cannot post.
      api: 'API-09', method: 'GET', path: '/v1/finance/fleet-settlements',
      permission: 'finance.period.read',
      handler: async (ctx) => {
        if (deps.books === undefined) return { status: 200, body: { connected: false, movements: [], unposted: [], detail: 'No books are connected in this composition — nothing is posted.', asAt: deps.now() } };
        const b = deps.books;
        const [map, journals] = await Promise.all([b.postingMap(ctx.tenantId), b.fleetJournals(ctx.tenantId)]);
        const posted = new Map(journals.map((j) => [j.fleet.movementId, j] as const));
        const movements: (FleetMovement & { readonly posted: boolean; readonly period?: string })[] = [];
        for (const routeId of await b.settledRoutes(ctx.tenantId)) {
          for (const m of fleetMovements(routeId, await deps.steps(ctx.tenantId, routeId))) {
            const j = posted.get(m.movementId);
            movements.push({ ...m, posted: j !== undefined, ...(j === undefined ? {} : { period: j.period }) });
          }
        }
        const unmapped = (['approved', 'paid'] as const).filter((k) => map?.rules.some((r) => r.kind === fleetKind(k)) !== true).map(fleetKind);
        return {
          status: 200,
          body: {
            connected: true, movements, unposted: movements.filter((m) => !m.posted).map((m) => m.movementId), unmappedKinds: unmapped,
            detail: unmapped.length > 0 ? `The posting map has no rule for ${unmapped.join(' and ')} — those movements cannot reach the books until the accountant maps them. Not posted, not zero.` : 'Every settlement kind is mapped.',
            asAt: deps.now(),
          },
        };
      },
    },
    {
      // The accountant posts every settlement movement not yet on the books, each ONE balanced journal through the map.
      api: 'API-09', method: 'POST', path: '/v1/finance/fleet-settlements/post',
      permission: 'finance.journal.post', idempotent: true,
      handler: async (ctx) => {
        const t = ctx.tenantId;
        if (deps.books === undefined) throw apiError(409, { code: 'books_not_connected', whatHappened: 'No books are connected in this composition, so no settlement can post.', wasItSaved: 'not_saved', nextSafeAction: 'Nothing was posted.' });
        const b = deps.books;
        const map = await b.postingMap(t);
        if (map === undefined) {
          throw apiError(409, { code: 'posting_map_not_defined', whatHappened: 'No ledger mapping is defined, so no fleet settlement can post — which accounts it goes to is the accountant\'s decision.', wasItSaved: 'not_saved', nextSafeAction: 'Define the mapping (PUT /v1/finance/posting-map) with rules for delivery_fleet:approved and delivery_fleet:paid. Nothing was posted.' });
        }
        const [journals, states] = await Promise.all([b.fleetJournals(t), b.periodStates(t)]);
        const posted = new Set(journals.map((j) => j.fleet.movementId));
        const appended: FleetJournal[] = [];
        const exceptions: { movementId: string; kind: string; reason: string; detail: string }[] = [];
        for (const routeId of await b.settledRoutes(t)) {
          for (const m of fleetMovements(routeId, await deps.steps(t, routeId)).filter((x) => !posted.has(x.movementId))) {
            const kind = fleetKind(m.kind);
            let mapped;
            try {
              mapped = postMapped({ id: m.movementId, kind, at: m.at, currency: 'INR', components: { amount: m.amountMinor } }, map);
            } catch (err) {
              const reason = err instanceof UnmappedKindError ? 'unmapped_kind' : err instanceof MissingComponentError ? 'missing_component' : err instanceof UnbalancedJournalError ? 'unbalanced_journal' : 'not_posted';
              exceptions.push({ movementId: m.movementId, kind, reason, detail: err instanceof Error ? err.message : String(err) });
              continue;
            }
            const documentDate = await shopClock(b.calendar).tradingDayOf(t, m.at);
            const belongsTo = documentDate.slice(0, 7);
            const closed = states.get(belongsTo) === 'closed';
            const period = closed ? await b.nextOpenPeriod(t) : belongsTo;
            const journal: FleetJournal = {
              entryId: `fleet:${m.movementId}`, period, documentDate,
              narrative: `Own-fleet settlement ${m.kind} — route ${m.routeId}${m.reference === undefined ? '' : `, voucher ${m.reference}`}${closed ? ` (posted to ${period}: ${belongsTo} is closed)` : ''}`,
              lines: mapped.lines.map((l) => ({ accountCode: l.account, debitMinor: l.side === 'debit' ? l.amount.minor : 0, creditMinor: l.side === 'credit' ? l.amount.minor : 0 })),
              postedBy: ctx.userId,
              fleet: { movementId: m.movementId, routeId: m.routeId, kind, ...(closed ? { belongsTo } : {}) },
            };
            const gate = postJournal({ entry: journal, periodStates: states, nextOpenPeriod: period });
            if (!gate.ok) { exceptions.push({ movementId: m.movementId, kind, reason: gate.refusedBecause ?? 'not_posted', detail: gate.detail }); continue; }
            await b.appendJournal(t, journal);
            appended.push(journal);
            await audit(t, ctx.branchId ?? null, ctx.userId, 'delivery.fleet.settle.post', m.routeId, { movementId: m.movementId, kind, amountMinor: String(m.amountMinor), period });
          }
        }
        return { status: appended.length > 0 ? 201 : 200, body: { posted: appended, exceptions, asAt: deps.now() } };
      },
    },
  ];
}
