// The offline pack — API-02, §31 ("full from a signed versioned local cache; retain last-known
// good"), M03/M05, §28, P-01, P-08.
//
// **This is the file the shop trades on when the internet is down.** Everything else in the
// catalogue service is a read; this is the one path that decides what a lane will believe for the
// next few days with nothing to check it against.
//
// Which inverts the usual direction of care. A bad *read* shows one person one wrong answer. A bad
// *pack* installs on every lane and is the only truth any of them has — and the lane cannot phone
// anybody about it, because the reason it is using the pack at all is that it cannot phone
// anybody.
//
// So the refusals here are all about what must never be published:
//
//   • **A PACK MUCH SMALLER THAN THE SHOP IS REFUSED.** This is the truncated-export failure
//     (`packages/migration/src/completeness.ts`) pointed the other way, and it is worse outbound:
//     a pack holding 4,000 of 41,200 products is internally consistent, signs correctly, installs
//     cleanly, and the first person to notice is a customer whose item will not scan. Products do
//     legitimately leave a catalogue — so a large drop is not forbidden, it is **acknowledged by
//     name and by count**, and an acknowledgement that does not match what actually left is
//     refused too.
//
//   • **A VERSION THAT DOES NOT MOVE FORWARD IS REFUSED**, and a lane never accepts one that goes
//     back. Otherwise yesterday's prices can be re-served over today's, which is a price rollback
//     nobody performed and nobody can see.
//
//   • **SELF-APPROVED PRICES DO NOT PUBLISH** (§28). The separation that governs a price change
//     has to survive the step that actually puts it on the shelf edge, or it was decoration.
//
//   • **A PRODUCT WITH NO TAX CLASS DOES NOT PUBLISH** (OC-21). A default rate would be applied
//     silently to everything nobody classified, and the error surfaces at the GST return.
//
// And on the lane's side, one rule that is the whole of P-01: **a pack that does not verify is
// rejected and the lane keeps trading on the last one it trusted.** Never a blank catalogue, never
// a stopped till — and never silently, either (P-08).

import type { CatalogueProduct, CatalogueSnapshot } from '../../../packages/catalogue/src/catalogue';

/** Signing is a port. The core stays pure and testable; deployment supplies the real key. */
export interface PackSigner {
  sign(payload: string): string;
  verify(payload: string, signature: string): boolean;
}

export interface SignedPack {
  readonly snapshot: CatalogueSnapshot;
  readonly signature: string;
  readonly publishedBy: string;
  readonly publishedAt: string;
  /** Products deliberately removed since the last pack, acknowledged by whoever published it. */
  readonly acknowledgedRemovals?: number;
}

export type PublishRefusal =
  | 'version_does_not_move_forward'
  | 'pack_is_much_smaller_than_the_shop'
  | 'removals_do_not_match_what_was_acknowledged'
  | 'prices_approved_by_whoever_drafted_them'
  | 'product_without_a_tax_class'
  | 'price_above_mrp'
  | 'empty_pack';

export interface PublishResult {
  readonly ok: boolean;
  readonly pack?: SignedPack;
  readonly refusedBecause?: PublishRefusal;
  readonly detail: string;
}

/** A price change and who touched it, so §28 can be checked at the moment it reaches the shelf. */
export interface PriceApproval {
  readonly productId: string;
  readonly draftedBy: string;
  readonly approvedBy: string;
}

/**
 * Field and record separators, written as escapes rather than as the bytes themselves.
 *
 * They have to be *something*: joining with an empty string makes `["ab","c"]` and `["a","bc"]`
 * the same text, so two different catalogues would sign identically and the signature would stop
 * meaning what it claims. ASCII 0x1f/0x1e are the separators that exist for exactly this and
 * cannot occur in a SKU or a barcode.
 *
 * Written `\u001f` because the raw byte makes the file's diff binary — the `plain-text-source`
 * guardrail caught the literal form here, which is the sixth time it has paid for itself.
 */
const FIELD = '\u001f';
const RECORD = '\u001e';

/** Stable, so the same catalogue signs to the same bytes on any machine. */
export function canonicalise(snapshot: CatalogueSnapshot): string {
  const products = [...snapshot.products]
    .sort((a, b) => (a.productId < b.productId ? -1 : 1))
    .map((p) => [p.productId, p.sku, p.unitPriceMinor, p.taxBps, p.mrpMinor ?? '', p.status,
      p.recallBlock === true ? 1 : 0].join(FIELD));
  const barcodes = [...snapshot.barcodes]
    .sort((a, b) => (a.code < b.code ? -1 : 1))
    .map((b) => [b.code, b.productId, b.kind].join(FIELD));
  return [snapshot.tenantId, snapshot.version, snapshot.builtAt, ...products, '--', ...barcodes]
    .join(RECORD);
}

/**
 * Publish a pack, or refuse to.
 *
 * Every refusal is checked before anything is signed. A signature on a pack that should not exist
 * is worse than no signature, because the lane's only defence is that the signature means
 * something.
 */
export function publishPack(input: {
  readonly snapshot: CatalogueSnapshot;
  readonly previous?: SignedPack;
  readonly approvals: readonly PriceApproval[];
  readonly signer: PackSigner;
  readonly publishedBy: string;
  readonly publishedAt: string;
  readonly acknowledgedRemovals?: number;
  /**
   * How much of the catalogue may vanish without being acknowledged, in basis points.
   * Per-tenant. Default 500 = 5%.
   */
  readonly unacknowledgedShrinkLimitBps?: number;
}): PublishResult {
  const { snapshot, previous } = input;

  if (snapshot.products.length === 0) {
    return {
      ok: false, refusedBecause: 'empty_pack',
      detail: 'a pack with no products would install cleanly and leave every lane unable to scan anything. If the catalogue is genuinely empty, that is a different conversation',
    };
  }

  if (previous !== undefined && snapshot.version <= previous.snapshot.version) {
    return {
      ok: false, refusedBecause: 'version_does_not_move_forward',
      detail: `version ${snapshot.version} is not ahead of the published ${previous.snapshot.version}. Re-serving an older pack is a price rollback nobody performed and nobody can see`,
    };
  }

  // The truncated-export failure, pointed outward. Worse in this direction: the lane has nothing
  // to check the pack against, because not being able to check things is why it holds a pack.
  if (previous !== undefined) {
    const before = previous.snapshot.products.length;
    const now = snapshot.products.length;
    const removed = before - now;
    const acknowledged = input.acknowledgedRemovals ?? 0;
    const limit = input.unacknowledgedShrinkLimitBps ?? 500;

    if (removed > 0 && acknowledged === 0 && (removed * 10_000) / before > limit) {
      return {
        ok: false, refusedBecause: 'pack_is_much_smaller_than_the_shop',
        detail: `this pack holds ${now} products where the last held ${before} — ${removed} gone, unacknowledged. It is internally consistent, it will sign, it will install, and the first person to notice is a customer whose item does not scan. If ${removed} lines really were discontinued, publish again acknowledging that number`,
      };
    }
    if (acknowledged > 0 && acknowledged !== removed) {
      return {
        ok: false, refusedBecause: 'removals_do_not_match_what_was_acknowledged',
        detail: `${acknowledged} removals were acknowledged and ${removed} actually left. An acknowledgement that does not match is a rubber stamp — it would let the next accidental truncation through under a number somebody typed once`,
      };
    }
  }

  const selfApproved = input.approvals.find((a) => a.draftedBy === a.approvedBy);
  if (selfApproved !== undefined) {
    return {
      ok: false, refusedBecause: 'prices_approved_by_whoever_drafted_them',
      detail: `the price for ${selfApproved.productId} was drafted and approved by ${selfApproved.draftedBy}. The separation that governs a price change has to survive the step that puts it on the shelf edge, or it was decoration (§28)`,
    };
  }

  const untaxed = snapshot.products.find((p) => !Number.isFinite(p.taxBps) || p.taxBps < 0);
  if (untaxed !== undefined) {
    return {
      ok: false, refusedBecause: 'product_without_a_tax_class',
      detail: `${untaxed.sku} carries no usable tax rate. A default applied here is applied silently to everything nobody classified, and it surfaces at the GST return months later (OC-21)`,
    };
  }

  const overMrp = snapshot.products.find((p) => p.mrpMinor !== undefined && p.unitPriceMinor > p.mrpMinor);
  if (overMrp !== undefined) {
    return {
      ok: false, refusedBecause: 'price_above_mrp',
      detail: `${overMrp.sku} is priced at ${overMrp.unitPriceMinor} against an MRP of ${overMrp.mrpMinor}. Charging above MRP is an offence, and a lane holding this pack would do it every time the item scanned, offline, with nobody able to stop it`,
    };
  }

  return {
    ok: true,
    pack: {
      snapshot,
      signature: input.signer.sign(canonicalise(snapshot)),
      publishedBy: input.publishedBy,
      publishedAt: input.publishedAt,
      ...(input.acknowledgedRemovals === undefined ? {} : { acknowledgedRemovals: input.acknowledgedRemovals }),
    },
    detail: `catalogue v${snapshot.version}: ${snapshot.products.length} products, ${snapshot.barcodes.length} barcodes, signed by ${input.publishedBy}`,
  };
}

export type PackRejection =
  | 'signature_does_not_verify'
  | 'older_than_the_pack_the_lane_holds'
  | 'not_this_tenant';

export interface AcceptResult {
  readonly accepted: boolean;
  readonly rejectedBecause?: PackRejection;
  /** What the lane will trade on from here — the new pack, or the one it already trusted. */
  readonly tradingOn?: SignedPack;
  /**
   * Typed as the literal `true`. Whatever happens to a pack, the shop keeps selling — a rejected
   * pack must never mean a blank catalogue or a stopped till (P-01).
   */
  readonly shopKeepsTrading: true;
  readonly detail: string;
  readonly staffMessage: string;
}

/**
 * What a lane does when a pack arrives.
 *
 * The rule that matters is what happens when the pack is bad: **the lane keeps trading on the last
 * pack it trusted.** Not a blank catalogue, not a stopped till — and not silently either, because
 * a lane quietly running week-old prices is how a promotion runs for a fortnight (P-08).
 */
export function acceptPack(input: {
  readonly incoming: SignedPack;
  readonly held?: SignedPack;
  readonly signer: PackSigner;
  readonly tenantId: string;
}): AcceptResult {
  const { incoming, held } = input;

  const keepTrading = (rejectedBecause: PackRejection, detail: string): AcceptResult => ({
    accepted: false,
    rejectedBecause,
    ...(held === undefined ? {} : { tradingOn: held }),
    shopKeepsTrading: true,
    detail,
    staffMessage: held === undefined
      ? 'This lane has no catalogue it trusts yet. Tell the manager before opening — do not sell from a pack that failed its check.'
      : `Keep selling. This lane is on catalogue v${held.snapshot.version} from ${held.snapshot.builtAt}, which is the last one it trusted. Tell the manager, because prices newer than that are not on this lane.`,
  });

  if (incoming.snapshot.tenantId !== input.tenantId) {
    return keepTrading('not_this_tenant',
      `this pack is built for ${incoming.snapshot.tenantId} and this lane belongs to ${input.tenantId}`);
  }

  if (!input.signer.verify(canonicalise(incoming.snapshot), incoming.signature)) {
    return keepTrading('signature_does_not_verify',
      'the pack does not match its signature. Either it was altered on the way here or it was built by something that is not us — and a lane cannot tell those apart, so it trusts neither');
  }

  if (held !== undefined && incoming.snapshot.version <= held.snapshot.version) {
    return keepTrading('older_than_the_pack_the_lane_holds',
      `v${incoming.snapshot.version} is not newer than the v${held.snapshot.version} this lane holds. Accepting it would put yesterday's prices back with nobody having asked for that`);
  }

  return {
    accepted: true,
    tradingOn: incoming,
    shopKeepsTrading: true,
    detail: `lane now on catalogue v${incoming.snapshot.version} (${incoming.snapshot.products.length} products), built ${incoming.snapshot.builtAt}`,
    staffMessage: `Catalogue updated to v${incoming.snapshot.version}.`,
  };
}

/** How stale the pack a lane is trading on has become — visible, never inferred (P-08). */
export function packFreshness(pack: SignedPack, now: string): {
  readonly ageHours: number;
  readonly visibleToStaff: string;
} {
  const ageHours = Math.max(0, Math.floor(
    (Date.parse(now) - Date.parse(pack.snapshot.builtAt)) / 3_600_000,
  ));
  return {
    ageHours,
    visibleToStaff: ageHours < 24
      ? `Catalogue v${pack.snapshot.version}, ${ageHours} hour(s) old.`
      : `Catalogue v${pack.snapshot.version} is ${Math.floor(ageHours / 24)} day(s) old. Prices changed since then are not on this lane.`,
  };
}

/** Products a pack will refuse to sell even with no network at all (M10-FR-04). */
export const blockedInPack = (pack: SignedPack): readonly CatalogueProduct[] =>
  pack.snapshot.products.filter((p) => p.recallBlock === true);
