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
import {
  BarcodeRegistry, DuplicateBarcodeError,
  type BarcodeAssignment, type BarcodeKind,
} from '../../../packages/product/src/index';

export interface BarcodeRegistryDeps {
  /** Append a barcode→product assignment (idempotent on the caller's key). */
  readonly assign: (tenantId: string, assignment: BarcodeAssignment, key: string) => Promise<void> | void;
  /** Every assignment ever made, in occurrence order — the register's raw material (last per code wins). */
  readonly all: (tenantId: string) => Promise<readonly BarcodeAssignment[]> | readonly BarcodeAssignment[];
}

const KINDS: readonly BarcodeKind[] = ['gtin', 'ean', 'upc', 'internal', 'case', 'embedded'];
const isKind = (v: unknown): v is BarcodeKind => typeof v === 'string' && (KINDS as readonly string[]).includes(v);

/** Build the tested register from what has been assigned before. Safe to replay: a different-product clash
 * is refused at the boundary below before it is ever appended, so the stream never holds two owners for one
 * code and the constructor never throws on replay. */
const registryOf = async (deps: BarcodeRegistryDeps, tenantId: string): Promise<BarcodeRegistry> =>
  new BarcodeRegistry([...(await deps.all(tenantId))]);

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
        const assignment: BarcodeAssignment = {
          code, productId, kind: b['kind'],
          ...(typeof b['level'] === 'string' && b['level'].trim() !== '' ? { level: b['level'] } : {}),
        };
        const registry = await registryOf(deps, ctx.tenantId);
        let stored: BarcodeAssignment;
        try {
          // The tested rule: same product is a no-op, a different product is refused with the owner named.
          stored = registry.register(assignment);
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
        await deps.assign(ctx.tenantId, stored, ctx.idempotencyKey ?? `${productId}:${code}`);
        return { status: 201, body: { barcode: stored } };
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
