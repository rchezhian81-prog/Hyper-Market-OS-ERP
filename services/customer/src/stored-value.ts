// API-06 Stored value — gift cards and store credit (M17-FR-03). A gift card is **the shop's money
// held on the customer's behalf**: every issued rupee is a liability, so the balance is PROJECTED
// from append-only movements (never stored and decremented — hard rule #2), a redemption can never
// overdraw it, an expired card cannot be spent, and an offline lane is capped rather than trusted.
//
// The rule is the pure `redeemValue` in `packages/loyalty`, so the till's own screen can run the
// identical one; this module is the HTTP skin and the persistence around it. `packages/loyalty` was
// another complete engine nothing fed on the cloud — this feeds it.

import type { Route } from '../../kernel/src/index';
import { apiError, notFound } from '../../kernel/src/index';
import {
  redeemValue, balanceOf, householdBalance, findDoubleSpends, reconcileLiability, flagVelocity,
  type Instrument, type ValueMovement, type ValueKind, type DoubleSpend,
} from '../../../packages/loyalty/src/stored-value';

export type { Instrument, ValueMovement } from '../../../packages/loyalty/src/stored-value';

type Channel = ValueMovement['channel'];
const KINDS: readonly ValueKind[] = ['gift_card', 'store_credit'];
const CHANNELS: readonly Channel[] = ['store', 'app', 'web', 'phone'];

export interface StoredValueDeps {
  /** The instrument, or `undefined` if this system never issued it. */
  readonly instrument: (tenantId: string, instrumentId: string) => Promise<Instrument | undefined> | Instrument | undefined;
  /** Every movement against one instrument (the balance is their sum). */
  readonly movements: (tenantId: string, instrumentId: string) => Promise<readonly ValueMovement[]> | readonly ValueMovement[];
  /** Issue an instrument and its opening value in one step. Idempotent on the instrument id. */
  readonly recordIssue: (tenantId: string, instrument: Instrument, opening: ValueMovement) => Promise<void> | void;
  /** Append a movement (a redemption). Idempotent on the movement id. */
  readonly recordMovement: (tenantId: string, instrumentId: string, m: ValueMovement) => Promise<void> | void;
  /** Every instrument a household/owner holds — the shared index filtered by ownerRef (M17-FR-04). */
  readonly instrumentsForOwner: (tenantId: string, ownerRef: string) => Promise<readonly Instrument[]> | readonly Instrument[];
  /** Every movement across all of that household's instruments (for the pooled balance + double-spend). */
  readonly movementsForOwner: (tenantId: string, ownerRef: string) => Promise<readonly ValueMovement[]> | readonly ValueMovement[];
  /** Every movement across EVERY instrument in the tenant — the tenant-wide fold behind the liability
   *  reconciliation and the redemption-velocity flag (M17-FR-03 / M23). */
  readonly allMovements: (tenantId: string) => Promise<readonly ValueMovement[]> | readonly ValueMovement[];
  readonly now: () => string;
}

export function storedValueRoutes(deps: StoredValueDeps): readonly Route[] {
  return [
    {
      // Issue a gift card or store credit with an opening value. Refuses a duplicate id — issuing the
      // same card twice would create money the shop never took.
      api: 'API-06', method: 'POST', path: '/v1/stored-value/instruments',
      permission: 'loyalty.value.issue', idempotent: true,
      handler: async (ctx) => {
        const b = (ctx.body ?? {}) as { instrumentId?: unknown; kind?: unknown; ownerRef?: unknown; faceValueMinor?: unknown; expiresOn?: unknown; providerRef?: unknown; channel?: unknown };
        if (typeof b.instrumentId !== 'string' || b.instrumentId.trim() === ''
          || typeof b.kind !== 'string' || !KINDS.includes(b.kind as ValueKind)
          || typeof b.ownerRef !== 'string' || b.ownerRef.trim() === ''
          || !Number.isInteger(b.faceValueMinor) || (b.faceValueMinor as number) <= 0) {
          throw apiError(400, {
            code: 'not_readable_as_an_instrument',
            whatHappened: 'Issuing stored value needs an instrument id, a kind (gift_card or store_credit), an owner, and a positive opening value.',
            wasItSaved: 'not_saved',
            nextSafeAction: 'Nothing was issued. Send the id, kind, owner and opening value.',
          });
        }
        if (await deps.instrument(ctx.tenantId, b.instrumentId) !== undefined) {
          throw apiError(422, {
            code: 'already_issued',
            whatHappened: `instrument ${b.instrumentId} has already been issued — issuing it again would create value the shop never took payment for`,
            wasItSaved: 'not_saved',
            nextSafeAction: 'Use a new instrument id, or load more value onto the existing one.',
          });
        }

        const now = deps.now();
        const channel: Channel = typeof b.channel === 'string' && CHANNELS.includes(b.channel as Channel) ? b.channel as Channel : 'store';
        const instrument: Instrument = {
          instrumentId: b.instrumentId, kind: b.kind as ValueKind, ownerRef: b.ownerRef, issuedAt: now,
          ...(typeof b.expiresOn === 'string' ? { expiresOn: b.expiresOn } : {}),
          ...(typeof b.providerRef === 'string' ? { providerRef: b.providerRef } : {}),
        };
        const opening: ValueMovement = { movementId: `${b.instrumentId}:issue`, instrumentId: b.instrumentId, kind: 'issue', deltaMinor: b.faceValueMinor as number, at: now, channel };
        await deps.recordIssue(ctx.tenantId, instrument, opening);
        return { status: 201, body: { instrumentId: instrument.instrumentId, kind: instrument.kind, balanceMinor: opening.deltaMinor } };
      },
    },
    {
      // Redeem against a card. Guards: never overdrawn, not expired, an offline lane capped, and
      // idempotent on the movement id (a re-sent redemption is the same one, not a second spend).
      api: 'API-06', method: 'POST', path: '/v1/stored-value/instruments/:instrumentId/redeem',
      permission: 'loyalty.value.redeem', idempotent: true,
      handler: async (ctx) => {
        const instrumentId = ctx.params['instrumentId'] ?? '';
        const b = (ctx.body ?? {}) as { movementId?: unknown; amountMinor?: unknown; channel?: unknown; capturedOffline?: unknown; saleId?: unknown; customerRef?: unknown };
        if (typeof b.movementId !== 'string' || b.movementId.trim() === ''
          || !Number.isInteger(b.amountMinor) || (b.amountMinor as number) <= 0
          || typeof b.channel !== 'string' || !CHANNELS.includes(b.channel as Channel)) {
          throw apiError(400, {
            code: 'not_readable_as_a_redemption',
            whatHappened: 'A redemption needs a movement id, a positive amount, and a channel (store, app, web or phone).',
            wasItSaved: 'not_saved',
            nextSafeAction: 'Nothing was redeemed. Send the movement id, amount and channel.',
          });
        }

        const instrument = await deps.instrument(ctx.tenantId, instrumentId);
        if (instrument === undefined) throw notFound(`stored-value instrument ${instrumentId}`);

        const movement: ValueMovement = {
          movementId: b.movementId, instrumentId, kind: 'redeem', deltaMinor: -(b.amountMinor as number),
          at: deps.now(), channel: b.channel as Channel,
          ...(b.capturedOffline === true ? { capturedOffline: true } : {}),
          ...(typeof b.saleId === 'string' ? { saleId: b.saleId } : {}),
          ...(typeof b.customerRef === 'string' ? { customerRef: b.customerRef } : {}),
        };
        const result = redeemValue({ instrument, movements: await deps.movements(ctx.tenantId, instrumentId), movement });

        // A duplicate is not a failure — the money already moved once, correctly. Answer idempotently.
        if (!result.redeemed && result.outcome === 'duplicate_movement') {
          return { status: 200, body: { instrumentId, balanceMinor: result.balanceAfterMinor, alreadyApplied: true } };
        }
        if (!result.redeemed) {
          throw apiError(422, {
            code: result.outcome,
            whatHappened: result.detail,
            wasItSaved: 'not_saved',
            nextSafeAction: 'No value was taken off the card. A gift card cannot be overdrawn or spent after it expires.',
          });
        }

        await deps.recordMovement(ctx.tenantId, instrumentId, movement);
        return { status: 200, body: { instrumentId, amountMinor: result.amountMinor, balanceMinor: result.balanceAfterMinor } };
      },
    },
    {
      api: 'API-06', method: 'GET', path: '/v1/stored-value/instruments/:instrumentId',
      permission: 'loyalty.value.read',
      handler: async (ctx) => {
        const instrumentId = ctx.params['instrumentId'] ?? '';
        const instrument = await deps.instrument(ctx.tenantId, instrumentId);
        if (instrument === undefined) throw notFound(`stored-value instrument ${instrumentId}`);
        const balanceMinor = balanceOf(await deps.movements(ctx.tenantId, instrumentId), instrumentId);
        return {
          status: 200,
          body: {
            instrumentId, kind: instrument.kind, ownerRef: instrument.ownerRef, balanceMinor,
            ...(instrument.expiresOn === undefined ? {} : { expiresOn: instrument.expiresOn }),
            asAt: deps.now(),
          },
        };
      },
    },
    {
      // One pooled balance across every instrument a household holds (M17-FR-04). A family's gift
      // cards and store credit are one purse; showing them apart is how a customer is told they have
      // less than they do. Projected from the same movements the per-instrument balance folds, so the
      // pool and its parts can never disagree.
      api: 'API-06', method: 'GET', path: '/v1/stored-value/households/:ownerRef/balance',
      permission: 'loyalty.value.read',
      handler: async (ctx) => {
        const ownerRef = ctx.params['ownerRef'] ?? '';
        const instruments = await deps.instrumentsForOwner(ctx.tenantId, ownerRef);
        const balanceMinor = householdBalance(await deps.movementsForOwner(ctx.tenantId, ownerRef), instruments, ownerRef);
        return {
          status: 200,
          body: {
            ownerRef,
            balanceMinor,
            instrumentIds: instruments.map((i) => i.instrumentId).sort(),
            instrumentCount: instruments.length,
            asAt: deps.now(),
          },
        };
      },
    },
    {
      // The cross-channel double-spend (M17-FR-04, hard rule #10): an instrument that went negative
      // once every channel's movements arrived — spent in the store AND in the app while the two were
      // out of sync. BOTH redemptions are kept and both channels named; nothing is silently reversed,
      // because two people really did receive goods and the shop, not a last-write-wins, decides.
      //
      // This is a LOSS surface, not a customer-service one: it names money the shop gave away twice.
      // So it is gated one rung above the pooled balance — `lp.case.read` (owner / manager / the
      // accountant), NOT the cashier's `loyalty.value.read`. Least privilege (P-04): a cashier
      // checking a customer's balance at the till has no business pulling the shop's fraud report.
      api: 'API-06', method: 'GET', path: '/v1/stored-value/households/:ownerRef/double-spends',
      permission: 'lp.case.read',
      handler: async (ctx) => {
        const ownerRef = ctx.params['ownerRef'] ?? '';
        const instruments = await deps.instrumentsForOwner(ctx.tenantId, ownerRef);
        const doubleSpends: readonly DoubleSpend[] = findDoubleSpends(
          await deps.movementsForOwner(ctx.tenantId, ownerRef), instruments,
        );
        return {
          status: 200,
          body: { ownerRef, doubleSpends, anyFound: doubleSpends.length > 0, asAt: deps.now() },
        };
      },
    },
    {
      // The stored-value LIABILITY reconciliation (M17-FR-03 → M23). Every unspent rupee on a gift
      // card is money the shop OWES, so the movements' outstanding total (issued − redeemed − expired
      // + adjusted, folded tenant-wide) is compared EXACTLY against what the accounts have POSTED as
      // the liability (`?posted=<minor>`); any gap is named as unrecorded debt WITH ITS SIGN, the same
      // discipline as a period-close control total — never "about right".
      //
      // A books/liability oversight surface, not a till one: gated on `lp.case.read` (owner / manager /
      // accountant), one rung above the cashier's `loyalty.value.read` balance — the SAME gate as the
      // double-spend report above. A cashier reading a card's balance has no business pulling the
      // shop's liability reconciliation (P-04 least privilege).
      api: 'API-06', method: 'GET', path: '/v1/stored-value/liability',
      permission: 'lp.case.read',
      handler: async (ctx) => {
        const posted = ctx.query['posted'];
        if (posted === undefined || !/^\d+$/.test(posted)) {
          throw apiError(400, {
            code: 'liability_needs_a_posted_figure',
            whatHappened: 'The liability reconciliation needs ?posted=<whole minor units> — the liability the accounts currently carry — to compare the movements against.',
            wasItSaved: 'not_saved',
            nextSafeAction: 'Send the posted figure. A reconciliation reads, it never writes.',
          });
        }
        const reconciliation = reconcileLiability({
          movements: await deps.allMovements(ctx.tenantId),
          postedLiabilityMinor: Number(posted),
        });
        return { status: 200, body: { ...reconciliation, asAt: deps.now() } };
      },
    },
    {
      // The redemption-VELOCITY flag (M17-FR-03 fraud limits). Instruments redeemed unusually many
      // times inside a short window — worth a person's look. DETECT-ONLY: it blocks nothing, because a
      // genuine customer spending a large gift card across a big shop looks identical, and stopping
      // them at the counter over a heuristic is the worse outcome than a delayed investigation. Same
      // LOSS-oversight gate as the double-spend surface (`lp.case.read`). `?at=` sets the window end;
      // omitted, it is now.
      api: 'API-06', method: 'GET', path: '/v1/stored-value/velocity',
      permission: 'lp.case.read',
      handler: async (ctx) => {
        const at = ctx.query['at'];
        if (at !== undefined && (at.trim() === '' || Number.isNaN(Date.parse(at)))) {
          throw apiError(400, {
            code: 'velocity_needs_a_valid_time',
            whatHappened: '?at= must be an ISO timestamp for the window to be measured against; a malformed one would silently count nothing.',
            wasItSaved: 'not_saved',
            nextSafeAction: 'Send a valid ISO ?at=, or omit it to use now.',
          });
        }
        const flags = flagVelocity({
          movements: await deps.allMovements(ctx.tenantId),
          at: at ?? deps.now(),
        });
        return { status: 200, body: { flags, anyFound: flags.length > 0, asAt: deps.now() } };
      },
    },
  ];
}
