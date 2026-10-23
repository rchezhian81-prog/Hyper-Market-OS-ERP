// API-02 Barcode register (M03-FR-02) — the "one code, one item" rule the till depends on, made
// durable on the cloud. A scan is only ever unambiguous if a barcode belongs to exactly one product;
// the moment the same code names two items, every sale of it is a coin-toss and every stock figure it
// feeds is wrong. This is the write path that guards that rule and the read path the lane's pack build
// (and any maintenance screen) reads it back through.
//
// The rule is the tested `BarcodeRegistry` in `@sre/product` (the `services-run-on-their-tested-engine`
// guardrail): re-registering the SAME code to the SAME product is a harmless no-op (an import re-run must
// not fail), registering it to a DIFFERENT product is refused with the current owner named. This file is
// the persistence + HTTP skin around it — the register is event-sourced (`BarcodeAssigned`), so it survives
// a restart and reads as what happened.
//
// Authoring is gated `catalogue.pack.publish` — assigning a code is deciding what the shop can scan and
// sell; reads are `catalogue.pack.read`. Categories/products/prices live in their own stores; this store
// holds only the code↔product map.
//
// NOTE (slice boundary): the coverage report — which products have NO barcode and so cannot be scanned
// (`barcodeCoverageGaps`) — is a product-master↔barcode JOIN and belongs with the catalogue-pack build
// (slice 2), where both stores meet. This increment is the register itself.

import type { Route } from '../../kernel/src/index';
import { apiError, notFound } from '../../kernel/src/index';
import { ConcurrencyConflictError } from '../../../packages/persistence/src/event-store';
import {
  BarcodeRegistry, DuplicateBarcodeError,
  type BarcodeAssignment, type BarcodeKind,
} from '../../../packages/product/src/index';
import { hasValidCheckDigit } from '../../../packages/gs1/src/gs1';

export interface BarcodeRegistryDeps {
  /**
   * Append a barcode→product assignment (idempotent on the caller's key). With `version` (from `current`), the append lands
   * only while the code's write guard is still at that version — otherwise `ConcurrencyConflictError`, nothing written.
   */
  readonly assign: (tenantId: string, assignment: BarcodeAssignment, key: string, version?: number) => Promise<void> | void;
  /** Every assignment ever made, in occurrence order — the register's raw material (last per code wins). */
  readonly all: (tenantId: string) => Promise<readonly BarcodeAssignment[]> | readonly BarcodeAssignment[];
  /**
   * GT-05 store volume: the assignment standing for ONE code, read by key — not the whole register — with the version of the
   * code's write guard, read first. Absent (a bare fake): the route rebuilds the register from `all`.
   */
  readonly current?: (tenantId: string, code: string) => Promise<{ readonly assignment?: BarcodeAssignment; readonly version: number }>;
}

const KINDS: readonly BarcodeKind[] = ['gtin', 'ean', 'upc', 'internal', 'case', 'embedded'];

/** The lengths each GS1 kind is printed in: a GTIN any of 8/12/13/14 digits, an EAN 8 or 13, a UPC-A 12. */
const GS1_LENGTHS: Readonly<Partial<Record<BarcodeKind, readonly number[]>>> = Object.freeze({ gtin: [8, 12, 13, 14], ean: [8, 13], upc: [12] });

/** Why a GS1-kind code is not a valid GS1 number (the shape, then the mod-10 check digit), or undefined when it is. */
export function gs1Problem(kind: BarcodeKind, code: string): { readonly code: 'barcode_not_gs1_digits' | 'barcode_check_digit_wrong'; readonly detail: string } | undefined {
  const lengths = GS1_LENGTHS[kind];
  if (lengths === undefined) return undefined;
  if (!/^\d+$/.test(code) || !lengths.includes(code.length)) {
    return { code: 'barcode_not_gs1_digits', detail: `a ${kind.toUpperCase()} is ${lengths.join(', ')} digits and nothing else; this is ${code.length} characters${/^\d+$/.test(code) ? '' : ' and not all digits'}.` };
  }
  if (!hasValidCheckDigit(code)) {
    return { code: 'barcode_check_digit_wrong', detail: 'its last digit (the GS1 check digit) does not match the digits before it, so it is mistyped or not a real GS1 number.' };
  }
  return undefined;
}
const isKind = (v: unknown): v is BarcodeKind => typeof v === 'string' && (KINDS as readonly string[]).includes(v);

/** Build the tested register from what has been assigned before. Safe to replay: a different-product clash
 * is refused at the boundary below before it is ever appended, so the stream never holds two owners for one
 * code and the constructor never throws on replay. */
const registryOf = async (deps: BarcodeRegistryDeps, tenantId: string): Promise<BarcodeRegistry> =>
  new BarcodeRegistry([...(await deps.all(tenantId))]);

/** The tested rule: the same product is a no-op, a different product is refused with the owner named. */
function registerOrRefuse(registry: BarcodeRegistry, assignment: BarcodeAssignment): BarcodeAssignment {
  try {
    return registry.register(assignment);
  } catch (err) {
    if (err instanceof DuplicateBarcodeError) {
      throw apiError(409, {
        code: 'barcode_already_assigned',
        // The person fixing this is not a programmer — name the code and the product that holds it.
        whatHappened: `Barcode "${err.code}" already belongs to product "${err.ownedBy}", so it cannot also be given to "${err.attemptedBy}". One code names exactly one item.`,
        wasItSaved: 'not_saved',
        nextSafeAction: 'Use a different code for this product, or first release the code from the product that holds it. Nothing was changed.',
      });
    }
    throw err;
  }
}

export function barcodeRoutes(deps: BarcodeRegistryDeps): readonly Route[] {
  return [
    {
      // Assign a barcode to a product. Body: { kind: BarcodeKind, level?: string }.
      api: 'API-02', method: 'POST', path: '/v1/catalogue/products/:productId/barcodes/:code',
      permission: 'catalogue.pack.publish', idempotent: true,
      handler: async (ctx) => {
        const productId = (ctx.params['productId'] ?? '').trim();
        const code = (ctx.params['code'] ?? '').trim();
        const b = (ctx.body ?? {}) as Record<string, unknown>;
        if (productId === '' || code === '' || !isKind(b['kind'])) {
          throw apiError(400, {
            code: 'not_readable_as_a_barcode',
            whatHappened: 'Assigning a barcode needs a product id and a non-empty code in the path, and a barcode kind (gtin, ean, upc, internal, case or embedded) in the body.',
            wasItSaved: 'not_saved',
            nextSafeAction: 'Send { kind: "ean" } (optionally { level }) with the product id and code in the URL.',
          });
        }
        // OB-288 P2 (M03-FR-02 · WF-01 "duplicate/GS1 check"): a GS1 code is refused at registration when it is not a GS1
        // number at all, or its check digit is wrong — a mistyped EAN would otherwise be "assigned" and never scan.
        const gs1 = gs1Problem(b['kind'], code);
        if (gs1 !== undefined) {
          throw apiError(422, {
            code: gs1.code,
            whatHappened: `Barcode "${code}" cannot be registered as ${b['kind'].toUpperCase()}: ${gs1.detail}`,
            wasItSaved: 'not_saved',
            nextSafeAction: 'Copy the digits again from the pack (all of them, including the last one), or register a shop-made code as kind "internal". Nothing was changed.',
          });
        }
        const assignment: BarcodeAssignment = {
          code, productId, kind: b['kind'],
          ...(typeof b['level'] === 'string' && b['level'].trim() !== '' ? { level: b['level'] } : {}),
        };
        // GT-05: only this code's standing assignment is read (by key), with its guard's version; a writer that loses the
        // guard to a simultaneous one re-reads and is judged again — so two writers can never both take one code.
        const key = ctx.idempotencyKey ?? `${productId}:${code}`;
        for (let attempt = 0; ; attempt += 1) {
          const standing = deps.current === undefined ? undefined : await deps.current(ctx.tenantId, code);
          const registry = standing === undefined
            ? await registryOf(deps, ctx.tenantId)
            : new BarcodeRegistry(standing.assignment === undefined ? [] : [standing.assignment]);
          const stored = registerOrRefuse(registry, assignment);
          try {
            await deps.assign(ctx.tenantId, stored, key, standing?.version);
          } catch (err) {
            if (err instanceof ConcurrencyConflictError && attempt < 4) continue;
            if (err instanceof ConcurrencyConflictError) {
              throw apiError(409, { code: 'barcode_changed_meanwhile', whatHappened: `Barcode "${code}" kept changing while this was being saved.`, wasItSaved: 'not_saved', nextSafeAction: 'Look the code up and try again. Nothing was changed.' });
            }
            throw err;
          }
          return { status: 201, body: { barcode: stored } };
        }
      },
    },
    {
      // Look one code up → the product it names. 404 when the code was never assigned (an unknown scan).
      api: 'API-02', method: 'GET', path: '/v1/catalogue/barcodes/:code',
      permission: 'catalogue.pack.read',
      handler: async (ctx) => {
        const code = (ctx.params['code'] ?? '').trim();
        const registry = await registryOf(deps, ctx.tenantId);
        const assignment = registry.lookup(code);
        if (assignment === undefined) throw notFound(`barcode ${code}`);
        return { status: 200, body: { barcode: assignment } };
      },
    },
    {
      // Every code for one product — the codes a maintenance screen shows against a product.
      api: 'API-02', method: 'GET', path: '/v1/catalogue/products/:productId/barcodes',
      permission: 'catalogue.pack.read',
      handler: async (ctx) => {
        const productId = (ctx.params['productId'] ?? '').trim();
        const registry = await registryOf(deps, ctx.tenantId);
        const barcodes = registry.forProduct(productId);
        return { status: 200, body: { barcodes, count: barcodes.length } };
      },
    },
  ];
}
