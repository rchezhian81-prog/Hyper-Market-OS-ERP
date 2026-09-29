// When does a catalogue publish need a fresh, second-factor sign-in? (ADR-0013 point 4 · SEC-03 · §28 ·
// Stage E slice 1 — the GAP-SEC-06 follow-on for bulk / sensitive-category publish.)
//
// A pack publish puts prices on every lane in the shop, offline, with nobody able to stop it (P-01). One
// corrected line is routine work; a publish that changes hundreds of products, or one that touches a
// REGULATED product (age-gated, licensed), is the moment a stolen session or a mis-click does the most
// damage — so those two shapes need the publisher to have re-authenticated recently with a second factor,
// checked at the API boundary from the SIGNED token (`requireStepUp`), never from anything in the request.
//
//   • BULK — the number of products ADDED, CHANGED or REMOVED against the previously published pack is at or
//     above the tenant's threshold (an owner setting, `catalogue.bulk_publish_threshold`, default 50). A first
//     publish has no previous pack, so every product counts as added: the first big load is bulk by definition.
//   • SENSITIVE — a product added or changed in this publish carries `regulatedFlags` (the pack contract's
//     regulated marker, the field the till's age gate reads — M12-FR-04), on either its old or its new form.
//
// Pure and deterministic: the decision is a function of the two snapshots and the threshold. What counts as
// "changed" is any difference in what the LANE would see for that product (price, MRP, tax, status, recall
// block, batch tracking, regulated flags, name, SKU, unit) — a re-ordered field list is not a change.

import type { CatalogueProduct, CatalogueSnapshot } from '../../../packages/catalogue/src/catalogue';
import { SETTINGS } from '../../../packages/tenant/src/settings';
import type { ReauthRequirement } from '../../kernel/src/index';

/** The bar a bulk / sensitive publish must clear — the same as a privilege grant or a payroll release. */
export const PUBLISH_STEP_UP: ReauthRequirement = { withinSeconds: 300, amr: ['mfa'] };

/** The owner setting's default, read from the ONE place it is declared (packages/tenant). */
export const DEFAULT_BULK_PUBLISH_THRESHOLD: number = SETTINGS.CATALOGUE_BULK_PUBLISH_THRESHOLD.defaultValue;

export type PublishSensitivity = 'bulk' | 'sensitive';

export interface PublishStepUpDecision {
  /** True when this publish needs a fresh second-factor sign-in. */
  readonly needed: boolean;
  readonly reasons: readonly PublishSensitivity[];
  /** Products added + changed + removed against the previous pack. */
  readonly changedCount: number;
  readonly added: number;
  readonly changed: number;
  readonly removed: number;
  /** The threshold applied (the owner's, or the default). */
  readonly bulkThreshold: number;
  /** Regulated products added or changed — named, so the refusal can say which. */
  readonly regulated: readonly string[];
  /** One plain sentence for the refusal, or undefined when no step-up is needed. */
  readonly because?: string;
}

const hasFlags = (p: CatalogueProduct | undefined): boolean =>
  p !== undefined && p.regulatedFlags !== undefined && Object.keys(p.regulatedFlags).length > 0;

/** What the lane sees of a product, in a canonical form — two products with equal fingerprints sell identically. */
const fingerprint = (p: CatalogueProduct): string => JSON.stringify([
  p.sku, p.name, p.baseUom, p.unitPriceMinor, p.taxBps, p.hsnCode ?? null, p.mrpMinor ?? null, p.status,
  p.recallBlock ?? false, p.batchTracked ?? false, canonical(p.regulatedFlags ?? {}),
]);

const canonical = (v: unknown): string => {
  if (Array.isArray(v)) return `[${v.map(canonical).join(',')}]`;
  if (v !== null && typeof v === 'object') {
    return `{${Object.keys(v as Record<string, unknown>).sort().map((k) => `${JSON.stringify(k)}:${canonical((v as Record<string, unknown>)[k])}`).join(',')}}`;
  }
  return JSON.stringify(v);
};

/** Decide whether publishing `next` over `previous` (absent on a first publish) needs the step-up. */
export function publishStepUpNeeded(input: {
  readonly previous?: CatalogueSnapshot;
  readonly next: CatalogueSnapshot;
  readonly bulkThreshold?: number;
}): PublishStepUpDecision {
  const bulkThreshold = input.bulkThreshold !== undefined && Number.isInteger(input.bulkThreshold) && input.bulkThreshold >= 1
    ? input.bulkThreshold
    : DEFAULT_BULK_PUBLISH_THRESHOLD;
  const before = new Map((input.previous?.products ?? []).map((p) => [p.productId, p] as const));
  const after = new Map(input.next.products.map((p) => [p.productId, p] as const));

  let added = 0; let changed = 0; let removed = 0;
  const regulated: string[] = [];
  for (const [id, now] of after) {
    const was = before.get(id);
    if (was === undefined) {
      added += 1;
      if (hasFlags(now)) regulated.push(id);
    } else if (fingerprint(was) !== fingerprint(now)) {
      changed += 1;
      if (hasFlags(was) || hasFlags(now)) regulated.push(id);
    }
  }
  for (const id of before.keys()) if (!after.has(id)) removed += 1;

  const changedCount = added + changed + removed;
  const reasons: PublishSensitivity[] = [];
  if (changedCount >= bulkThreshold) reasons.push('bulk');
  if (regulated.length > 0) reasons.push('sensitive');

  const parts: string[] = [];
  if (reasons.includes('bulk')) parts.push(`This publish changes ${changedCount} product${changedCount === 1 ? '' : 's'} (${added} added, ${changed} changed, ${removed} removed), at or above the shop's bulk threshold of ${bulkThreshold}.`);
  if (reasons.includes('sensitive')) parts.push(`It touches ${regulated.length} regulated product${regulated.length === 1 ? '' : 's'} (${regulated.slice(0, 5).join(', ')}${regulated.length > 5 ? ', …' : ''}).`);

  return {
    needed: reasons.length > 0,
    reasons,
    changedCount, added, changed, removed,
    bulkThreshold,
    regulated,
    ...(parts.length === 0 ? {} : { because: parts.join(' ') }),
  };
}
