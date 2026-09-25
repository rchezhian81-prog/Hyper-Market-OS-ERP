// Pilot seed applier (Phase 4) — lays the dataset down by driving the REAL cloud API surface.
//
// The applier never writes to the event store directly for business data: it calls the same routes a
// human operator would, as an authorised demo user, so every record passes the real validation,
// permission and idempotency guards (a seed can only create states the live system accepts). The one
// exception is identity provisioning — the tenant's first owner (genesis) and the additional role
// logins — which are laid down through the injected `seedOwner`/`provisionRole` hooks exactly the way
// tenant onboarding seeds its initial admin set, because there is no one to authorise a grant on a
// brand-new tenant yet.
//
// No silent partial seed (P-08): every step is recorded, and the report's `ok` is false if any step
// did not land. A caller that wants fail-fast can pass `{ throwOnError: true }`.

import type { PilotFoundation, PilotCatalogue } from './dataset';

export interface SeedResponse {
  readonly status: number;
  readonly body: unknown;
}

/** The subset of the cloud API surface the applier needs. `tests/support/api-harness.ts`'s
 *  `ApiHarness` satisfies this directly; the operational script builds an equivalent over a real
 *  store. Keeping it an injected interface means the applier imports no service code. */
export interface SeedClient {
  request(input: {
    method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';
    path: string;
    userId: string;
    tenantId: string;
    branchId?: string;
    body?: unknown;
    idempotencyKey?: string;
    query?: Readonly<Record<string, string>>;
  }): Promise<SeedResponse>;
  seedOwner(tenantId: string, userId: string): Promise<void>;
  provisionRole(tenantId: string, userId: string, roleId: string): Promise<void>;
  enableFeature(tenantId: string, feature: string): Promise<void>;
}

export interface SeedStep {
  readonly what: string;
  readonly ok: boolean;
  readonly status?: number;
  readonly detail?: string;
}

export interface SeedReport {
  readonly tenantId: string;
  readonly steps: readonly SeedStep[];
  readonly ok: boolean;
}

export interface ApplyOptions {
  /** Throw on the first failed step instead of collecting it into the report. */
  readonly throwOnError?: boolean;
}

const OK_STATUS = new Set([200, 201]);

function detailOf(res: SeedResponse): string | undefined {
  const body = res.body as { error?: { code?: string; whatHappened?: string } } | undefined;
  const err = body?.error;
  if (err === undefined) return undefined;
  return [err.code, err.whatHappened].filter((x) => typeof x === 'string' && x !== '').join(': ') || undefined;
}

/** A step recorder + POST helper shared by every applier, so no applier silently drops a step. */
interface SeedRunner {
  readonly steps: SeedStep[];
  record(step: SeedStep): void;
  post(what: string, path: string, body: unknown, idempotencyKey: string): Promise<SeedResponse>;
}

function makeRunner(client: SeedClient, tenantId: string, actor: string, options: ApplyOptions): SeedRunner {
  const steps: SeedStep[] = [];
  const record = (step: SeedStep): void => {
    steps.push(step);
    if (!step.ok && options.throwOnError === true) {
      throw new Error(`pilot seed step failed — ${step.what}: ${step.detail ?? `status ${step.status ?? '?'}`}`);
    }
  };
  const post = async (what: string, path: string, body: unknown, idempotencyKey: string): Promise<SeedResponse> => {
    const res = await client.request({ method: 'POST', path, userId: actor, tenantId, body, idempotencyKey });
    record({ what, ok: OK_STATUS.has(res.status), status: res.status, ...(detailOf(res) === undefined ? {} : { detail: detailOf(res) }) });
    return res;
  };
  return { steps, record, post };
}

/**
 * Seed the pilot foundation: genesis owner, role logins, entitlements, and the org skeleton
 * (GST registration → company → branch → warehouse), each org node created as a draft and then
 * activated through the real activation guard. Returns a step-by-step report; `ok` is true only if
 * every step landed.
 */
export async function applyPilotFoundation(
  client: SeedClient,
  foundation: PilotFoundation,
  options: ApplyOptions = {},
): Promise<SeedReport> {
  const tenantId = foundation.tenantId;
  const owner = foundation.genesisOwner.userId;
  const { steps, record, post } = makeRunner(client, tenantId, owner, options);

  // 1. Genesis owner (once-only guarded path — a fresh tenant has no one who could authorise a grant).
  try {
    await client.seedOwner(tenantId, owner);
    record({ what: `genesis owner ${owner}`, ok: true });
  } catch (err) {
    record({ what: `genesis owner ${owner}`, ok: false, detail: err instanceof Error ? err.message : String(err) });
  }

  // 2. Additional role logins for the pilot/UAT cast.
  for (const user of foundation.users) {
    try {
      await client.provisionRole(tenantId, user.userId, user.role);
      record({ what: `role ${user.role} → ${user.userId}`, ok: true });
    } catch (err) {
      record({ what: `role ${user.role} → ${user.userId}`, ok: false, detail: err instanceof Error ? err.message : String(err) });
    }
  }

  // 3. Optional/paid features the pilot exercises.
  for (const feature of foundation.entitlements) {
    try {
      await client.enableFeature(tenantId, feature);
      record({ what: `entitlement ${feature}`, ok: true });
    } catch (err) {
      record({ what: `entitlement ${feature}`, ok: false, detail: err instanceof Error ? err.message : String(err) });
    }
  }

  // 4. GST registration(s) — must exist before a branch can reference the GSTIN.
  for (const reg of foundation.gstRegistrations) {
    await post(
      `gst registration ${reg.gstin}`,
      `/v1/org/gst-registrations/${encodeURIComponent(reg.gstin)}`,
      { companyId: reg.companyId, legalName: reg.legalName },
      `seed-gstreg-${reg.gstin}`,
    );
  }

  // 5. Org nodes — create each as a draft (dependency order: company, branch, warehouse) …
  for (const node of foundation.org) {
    await post(
      `org node ${node.nodeId} (${node.kind})`,
      `/v1/org/nodes/${encodeURIComponent(node.nodeId)}`,
      {
        kind: node.kind,
        name: node.name,
        parentId: node.parentId,
        ...(node.companyId === undefined ? {} : { companyId: node.companyId }),
        ...(node.gstin === undefined ? {} : { gstin: node.gstin }),
      },
      `seed-node-${node.nodeId}`,
    );
  }

  // 6. … then activate the ones that should be tradeable, through the real activation guard.
  for (const node of foundation.org) {
    if (!node.activate) continue;
    await post(
      `activate ${node.nodeId}`,
      `/v1/org/nodes/${encodeURIComponent(node.nodeId)}/activation`,
      {},
      `seed-activate-${node.nodeId}`,
    );
  }

  return { tenantId, steps, ok: steps.every((s) => s.ok) };
}

/**
 * Seed the pilot catalogue (Slice 4b) on top of an applied foundation: HSN tax-rate schedules,
 * products (published through the real compliance gate, with categories inline), barcodes, pack
 * hierarchies, and governed prices (below MRP, above cost — no approval needed). Driven as the owner,
 * who holds `catalogue.pack.publish` and `price.change.propose`. Returns a step-by-step report.
 */
export async function applyPilotCatalogue(
  client: SeedClient,
  catalogue: PilotCatalogue,
  actorUserId: string,
  options: ApplyOptions = {},
): Promise<SeedReport> {
  const tenantId = catalogue.tenantId;
  const { steps, post } = makeRunner(client, tenantId, actorUserId, options);

  // 1. Tax-rate schedules — a product's taxClass points at one of these HSN codes.
  for (const rate of catalogue.taxRates) {
    await post(
      `tax rate ${rate.hsnCode}@${rate.effectiveFrom}`,
      `/v1/catalogue/tax-classes/${encodeURIComponent(rate.hsnCode)}/rates/${encodeURIComponent(rate.effectiveFrom)}`,
      { rateBps: rate.rateBps },
      `seed-tax-${rate.hsnCode}-${rate.effectiveFrom}`,
    );
  }

  // 2. Products — published through the real compliance gate; every publish carries the full
  //    category set so the primary category (and its food-safety rules) can be validated.
  for (const product of catalogue.products) {
    await post(
      `product ${product.productId}`,
      `/v1/catalogue/products/${encodeURIComponent(product.productId)}/publish`,
      {
        product: {
          sku: product.sku, name: product.name, baseUom: product.baseUom,
          primaryCategoryId: product.primaryCategoryId, taxClass: product.taxClass, lifecycle: product.lifecycle,
          ...(product.brand === undefined ? {} : { brand: product.brand }),
          ...(product.safety === undefined ? {} : { safety: product.safety }),
        },
        categories: catalogue.categories,
      },
      `seed-product-${product.productId}`,
    );
  }

  // 3. Barcodes — one code names exactly one item.
  for (const product of catalogue.products) {
    if (product.barcode === undefined) continue;
    await post(
      `barcode ${product.barcode.code} → ${product.productId}`,
      `/v1/catalogue/products/${encodeURIComponent(product.productId)}/barcodes/${encodeURIComponent(product.barcode.code)}`,
      { kind: product.barcode.kind },
      `seed-barcode-${product.barcode.code}`,
    );
  }

  // 4. Pack hierarchies (where defined) — exact conversions enforced by the route.
  for (const product of catalogue.products) {
    if (product.pack === undefined) continue;
    await post(
      `pack ${product.productId}`,
      `/v1/catalogue/products/${encodeURIComponent(product.productId)}/pack`,
      { baseUom: product.pack.baseUom, levels: product.pack.levels },
      `seed-pack-${product.productId}`,
    );
  }

  // 5. Governed prices — below MRP and above cost, so no separate approval is needed.
  for (const product of catalogue.products) {
    await post(
      `price ${product.productId}`,
      '/v1/prices/changes',
      {
        productId: product.productId,
        priceMinor: product.price.priceMinor, mrpMinor: product.price.mrpMinor, costMinor: product.price.costMinor,
        currency: product.price.currency, marginFloorBps: product.price.marginFloorBps,
      },
      `seed-price-${product.productId}`,
    );
  }

  return { tenantId, steps, ok: steps.every((s) => s.ok) };
}
