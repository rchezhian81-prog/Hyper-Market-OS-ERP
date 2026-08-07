// API-04 Packaging back-office — items, movements & circulation (M28-FR-03). A shop that treats a
// reusable crate as a consumable buys the same 400 crates every year and never asks where they went.
// So packaging is projected from its movements like any other stock, but with one number that ordinary
// stock does not have: **inCirculation** — crates and cold boxes that went out with a delivery and never
// came back. And a negative position is **reported negative, not clamped to zero**, because bags going
// out with none recorded in is the evidence that a goods-in was never entered, and clamping destroys it.
//
// NOTE: the carry-bag CHARGE itself is NOT here. A charge is a priced line the lane computes from the
// price pack it already holds, so it works with the internet down (hard rule #1). This surface is the
// back-office half — the item master (which feeds that pack) and the stock movements behind it. The rule
// is the pure `projectPackaging` in `packages/waste/src/packaging.ts`.

import type { Route } from '../../kernel/src/index';
import { apiError, notFound } from '../../kernel/src/index';
import {
  projectPackaging,
  type PackagingItem, type PackagingKind, type PackagingMovement, type PackagingMovementKind,
} from '../../../packages/waste/src/index';

export type { PackagingItem, PackagingMovement } from '../../../packages/waste/src/index';

const KINDS: readonly PackagingKind[] = ['carry_bag', 'reusable_crate', 'delivery_bag', 'cold_box', 'wrapping'];
const MOVEMENT_KINDS: readonly PackagingMovementKind[] = ['received', 'issued_to_customer', 'issued_to_delivery', 'returned', 'written_off'];

const isStr = (s: unknown): s is string => typeof s === 'string' && s.trim() !== '';
const isDateTime = (s: unknown): s is string => typeof s === 'string' && s.trim() !== '' && !Number.isNaN(Date.parse(s));
const isNonNegInt = (n: unknown): n is number => typeof n === 'number' && Number.isInteger(n) && n >= 0;
const isPosInt = (n: unknown): n is number => typeof n === 'number' && Number.isInteger(n) && n > 0;

export interface PackagingDeps {
  readonly item: (tenantId: string, packagingId: string) => Promise<PackagingItem | undefined> | PackagingItem | undefined;
  readonly movements: (tenantId: string, packagingId: string) => Promise<readonly PackagingMovement[]> | readonly PackagingMovement[];
  readonly registerItem: (tenantId: string, item: PackagingItem) => Promise<void> | void;
  readonly recordMovement: (tenantId: string, movement: PackagingMovement) => Promise<void> | void;
  readonly now: () => string;
}

export function packagingRoutes(deps: PackagingDeps): readonly Route[] {
  return [
    {
      // Register (or restate) a packaging item. `returnable` is what makes a crate circulate rather than
      // be consumed. The charge/tax sit here because the item master feeds the price pack the lane holds.
      api: 'API-04', method: 'POST', path: '/v1/packaging/items/:packagingId',
      permission: 'inventory.movement.append', idempotent: true,
      handler: async (ctx) => {
        const packagingId = ctx.params['packagingId'] ?? '';
        const b = (ctx.body ?? {}) as Record<string, unknown>;
        if (!isStr(b['name']) || !KINDS.includes(b['kind'] as PackagingKind) || typeof b['returnable'] !== 'boolean'
          || (b['chargeMinor'] !== undefined && !isNonNegInt(b['chargeMinor']))
          || (b['taxRateBps'] !== undefined && !isNonNegInt(b['taxRateBps']))
          || (b['depositMinor'] !== undefined && !isNonNegInt(b['depositMinor']))) {
          throw apiError(400, {
            code: 'not_readable_as_a_packaging_item',
            whatHappened: 'A packaging item needs a name, a kind (carry_bag/reusable_crate/delivery_bag/cold_box/wrapping) and whether it is returnable; charge, tax and deposit are optional.',
            wasItSaved: 'not_saved',
            nextSafeAction: 'Send the item fields. Nothing was registered.',
          });
        }
        const item: PackagingItem = {
          packagingId, tenantId: ctx.tenantId, name: b['name'] as string, kind: b['kind'] as PackagingKind,
          returnable: b['returnable'] as boolean,
          ...(isNonNegInt(b['chargeMinor']) ? { chargeMinor: b['chargeMinor'] } : {}),
          ...(isNonNegInt(b['taxRateBps']) ? { taxRateBps: b['taxRateBps'] } : {}),
          ...(isNonNegInt(b['depositMinor']) ? { depositMinor: b['depositMinor'] } : {}),
        };
        await deps.registerItem(ctx.tenantId, item);
        return { status: 201, body: { packagingId, kind: item.kind, returnable: item.returnable } };
      },
    },
    {
      // Record a movement. The qty is always POSITIVE; the kind says which way it goes. A `written_off`
      // is a compensating movement, never a deletion (#2).
      api: 'API-04', method: 'POST', path: '/v1/packaging/items/:packagingId/movements/:movementId',
      permission: 'inventory.movement.append', idempotent: true,
      handler: async (ctx) => {
        const packagingId = ctx.params['packagingId'] ?? '';
        const movementId = ctx.params['movementId'] ?? '';
        const b = (ctx.body ?? {}) as Record<string, unknown>;
        if (!isStr(b['branchId']) || !MOVEMENT_KINDS.includes(b['kind'] as PackagingMovementKind) || !isPosInt(b['qty']) || !isDateTime(b['at'])
          || (b['reference'] !== undefined && !isStr(b['reference']))) {
          throw apiError(400, { code: 'not_readable_as_a_movement', whatHappened: 'A packaging movement needs a branch, a kind (received/issued_to_customer/issued_to_delivery/returned/written_off), a positive whole quantity and a timestamp.', wasItSaved: 'not_saved', nextSafeAction: 'Send the movement fields. Nothing was recorded.' });
        }
        if (await deps.item(ctx.tenantId, packagingId) === undefined) throw notFound(`packaging item ${packagingId}`);
        const movement: PackagingMovement = {
          movementId, packagingId, branchId: b['branchId'] as string,
          kind: b['kind'] as PackagingMovementKind, qty: b['qty'] as number, at: b['at'] as string,
          ...(isStr(b['reference']) ? { reference: b['reference'] } : {}),
        };
        await deps.recordMovement(ctx.tenantId, movement);
        return { status: 201, body: { movementId, packagingId, kind: movement.kind, qty: movement.qty } };
      },
    },
    {
      // The projected position for one item at one branch — on hand, and (for a returnable) how much is
      // still in circulation with a loss rate. A negative on-hand is shown negative, because the
      // negative IS the evidence that a goods-in was never entered.
      api: 'API-04', method: 'GET', path: '/v1/packaging/items/:packagingId/position',
      permission: 'inventory.availability.read',
      handler: async (ctx) => {
        const packagingId = ctx.params['packagingId'] ?? '';
        const branchId = ctx.query['branchId'];
        if (!isStr(branchId)) throw apiError(400, { code: 'position_needs_a_branch', whatHappened: 'A packaging position needs ?branchId= to project against.', wasItSaved: 'not_saved', nextSafeAction: 'Send the branch. A position reads, it never writes.' });
        const item = await deps.item(ctx.tenantId, packagingId);
        if (item === undefined) throw notFound(`packaging item ${packagingId}`);
        const position = projectPackaging({ item, branchId, movements: await deps.movements(ctx.tenantId, packagingId) });
        return { status: 200, body: position };
      },
    },
  ];
}
