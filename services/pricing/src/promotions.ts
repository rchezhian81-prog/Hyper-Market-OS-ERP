// API-02 Promotions governance (M20 / M05-FR-04, §28, P-05) — a promotion is a decision to give away
// margin in exchange for volume, and shops make it on optimism and measure it months later. This puts
// the decision on the cloud where it can be governed: SIMULATE the margin impact before launching, and
// let a margin-LOSING offer launch only with a named approver and a written reason (§28) — a loss-leader
// is legitimate, but never by accident.
//
// The rule is the pure `simulatePromotion` / `approveForLaunch` in `packages/promotions` — another
// complete engine nothing fed on the cloud. This module is the HTTP skin and the launch record.

import type { Route } from '../../kernel/src/index';
import { apiError } from '../../kernel/src/index';
import {
  simulatePromotion, approveForLaunch, PromotionApprovalRequiredError,
  measureEffectiveness, reconcileVendorFunding,
  type SimulationInput, type SimulationResult, type SimulationVerdict,
  type EffectivenessInput, type VendorFundingClaim,
} from '../../../packages/promotions/src/simulation';
import type { Money } from '../../../packages/contracts/src/money';

/** A launch as it is persisted — the verdict it launched on and who approved a margin loss. */
export interface LaunchRecord {
  readonly promotionId: string;
  readonly verdict: SimulationVerdict;
  readonly incrementalMarginMinor: number;
  readonly currency: string;
  readonly proposedBy: string;
  readonly approvedBy: string | null;
  readonly launchedAt: string;
  readonly detail: string;
}

export interface PromotionDeps {
  readonly launchedPromotion: (tenantId: string, promotionId: string) => Promise<LaunchRecord | undefined> | LaunchRecord | undefined;
  readonly recordLaunch: (tenantId: string, record: LaunchRecord) => Promise<void> | void;
  readonly now: () => string;
}

const isMoney = (v: unknown): v is Money =>
  v !== null && typeof v === 'object' && Number.isInteger((v as Money).minor) && typeof (v as Money).currency === 'string';

/** Read the simulation inputs; the arithmetic and the verdict belong to `simulatePromotion`. */
function readSimInput(body: unknown, promotionId: string): SimulationInput | undefined {
  if (body === null || typeof body !== 'object') return undefined;
  const b = body as Record<string, unknown>;
  if (!isMoney(b['normalPrice']) || !isMoney(b['promoPrice']) || !isMoney(b['unitCost'])
    || !Number.isInteger(b['baselineUnits']) || !Number.isInteger(b['expectedUnits'])
    || (b['vendorFundingPerUnit'] !== undefined && !isMoney(b['vendorFundingPerUnit']))
    || (b['fixedCost'] !== undefined && !isMoney(b['fixedCost']))) {
    return undefined;
  }
  return {
    promotionId,
    description: typeof b['description'] === 'string' ? b['description'] : '',
    normalPrice: b['normalPrice'], promoPrice: b['promoPrice'], unitCost: b['unitCost'],
    baselineUnits: b['baselineUnits'] as number, expectedUnits: b['expectedUnits'] as number,
    ...(isMoney(b['vendorFundingPerUnit']) ? { vendorFundingPerUnit: b['vendorFundingPerUnit'] } : {}),
    ...(isMoney(b['fixedCost']) ? { fixedCost: b['fixedCost'] } : {}),
  };
}

const badInput = () => apiError(400, {
  code: 'not_readable_as_a_simulation',
  whatHappened: 'A promotion simulation needs normalPrice, promoPrice and unitCost as { minor, currency }, and whole baselineUnits and expectedUnits.',
  wasItSaved: 'not_saved',
  nextSafeAction: 'Nothing was changed. Send the prices, the cost and the expected volumes.',
});

/** Read a finished promotion's figures to measure. The arithmetic is `measureEffectiveness`'s. */
function readEffectiveness(body: unknown, promotionId: string): EffectivenessInput | undefined {
  if (body === null || typeof body !== 'object') return undefined;
  const b = body as Record<string, unknown>;
  if (!Number.isInteger(b['baselineUnits']) || !Number.isInteger(b['actualUnits'])
    || !isMoney(b['baselineMargin']) || !isMoney(b['actualMargin'])
    || (b['vendorFundingReceived'] !== undefined && !isMoney(b['vendorFundingReceived']))) {
    return undefined;
  }
  return {
    promotionId,
    baselineUnits: b['baselineUnits'] as number, actualUnits: b['actualUnits'] as number,
    baselineMargin: b['baselineMargin'], actualMargin: b['actualMargin'],
    ...(isMoney(b['vendorFundingReceived']) ? { vendorFundingReceived: b['vendorFundingReceived'] } : {}),
  };
}

/** Read a vendor's funding claim to reconcile against what finance actually received. */
function readFundingClaim(body: unknown, promotionId: string): VendorFundingClaim | undefined {
  if (body === null || typeof body !== 'object') return undefined;
  const b = body as Record<string, unknown>;
  if (typeof b['supplierId'] !== 'string' || b['supplierId'] === ''
    || !isMoney(b['agreedPerUnit']) || !Number.isInteger(b['unitsSold'])
    || (b['receivedAmount'] !== undefined && !isMoney(b['receivedAmount']))) {
    return undefined;
  }
  return {
    promotionId, supplierId: b['supplierId'],
    agreedPerUnit: b['agreedPerUnit'], unitsSold: b['unitsSold'] as number,
    ...(isMoney(b['receivedAmount']) ? { receivedAmount: b['receivedAmount'] } : {}),
    ...(typeof b['approvedBy'] === 'string' ? { approvedBy: b['approvedBy'] } : {}),
  };
}

export function promotionRoutes(deps: PromotionDeps): readonly Route[] {
  return [
    {
      // What-if only: compute the margin impact and the verdict without committing anything.
      api: 'API-02', method: 'POST', path: '/v1/promotions/:promotionId/simulate',
      permission: 'promotion.simulate', idempotent: true,
      handler: async (ctx) => {
        const input = readSimInput(ctx.body, ctx.params['promotionId'] ?? '');
        if (input === undefined) throw badInput();
        return { status: 200, body: simulatePromotion(input) };
      },
    },
    {
      // Launch the promotion. It launches freely when it improves or only mildly reduces margin;
      // a margin-LOSING offer (below cost, or worse than doing nothing) launches only with a named
      // approver who is not the proposer and a written reason (§28). Idempotent per promotion.
      api: 'API-02', method: 'POST', path: '/v1/promotions/:promotionId/launch',
      permission: 'promotion.launch', idempotent: true,
      handler: async (ctx) => {
        const promotionId = ctx.params['promotionId'] ?? '';
        const already = await deps.launchedPromotion(ctx.tenantId, promotionId);
        if (already !== undefined) {
          return { status: 200, body: { promotionId, launched: true, verdict: already.verdict, approvedBy: already.approvedBy, alreadyLaunched: true } };
        }

        const b = (ctx.body ?? {}) as { approvedBy?: unknown; rationale?: unknown };
        const input = readSimInput(ctx.body, promotionId);
        if (input === undefined) throw badInput();

        const simulation: SimulationResult = simulatePromotion(input);
        const approval = typeof b.approvedBy === 'string'
          ? { subjectRef: promotionId, status: 'approved' as const, decidedBy: b.approvedBy, ...(typeof b.rationale === 'string' ? { rationale: b.rationale } : {}) }
          : undefined;

        let approvedBy: string | null = null;
        try {
          approvedBy = approveForLaunch(simulation, approval, ctx.userId).approvedBy ?? null;
        } catch (e) {
          if (e instanceof PromotionApprovalRequiredError) {
            throw apiError(422, {
              code: 'launch_needs_approval',
              whatHappened: e.message,
              wasItSaved: 'not_saved',
              nextSafeAction: 'A margin-losing offer can still launch, but a second person must approve it with a written reason. Nothing was launched.',
            });
          }
          throw e;
        }

        const record: LaunchRecord = {
          promotionId, verdict: simulation.verdict, incrementalMarginMinor: simulation.incrementalMargin.minor,
          currency: simulation.incrementalMargin.currency, proposedBy: ctx.userId, approvedBy,
          launchedAt: deps.now(), detail: simulation.detail,
        };
        await deps.recordLaunch(ctx.tenantId, record);
        return { status: 201, body: { promotionId, launched: true, verdict: simulation.verdict, incrementalMargin: simulation.incrementalMargin, approvedBy } };
      },
    },
    {
      api: 'API-02', method: 'GET', path: '/v1/promotions/:promotionId',
      permission: 'promotion.read',
      handler: async (ctx) => {
        const promotionId = ctx.params['promotionId'] ?? '';
        const rec = await deps.launchedPromotion(ctx.tenantId, promotionId);
        return {
          status: 200,
          body: rec === undefined
            ? { promotionId, launched: false, asAt: deps.now() }
            : { promotionId, launched: true, verdict: rec.verdict, incrementalMarginMinor: rec.incrementalMarginMinor, currency: rec.currency, approvedBy: rec.approvedBy, launchedAt: rec.launchedAt },
        };
      },
    },
    {
      // The measurement the shop makes months late and on optimism — put on the cloud so the
      // verdict is a number: **was the promotion worth doing?** Judged on incremental MARGIN, not
      // units (M05-FR-04, D06) — a promotion can sell 40% more and leave the shop poorer. The caller
      // supplies the finished figures; the arithmetic and the verdict are the pure engine's.
      api: 'API-02', method: 'POST', path: '/v1/promotions/:promotionId/effectiveness',
      permission: 'promotion.read', idempotent: true,
      handler: async (ctx) => {
        const input = readEffectiveness(ctx.body, ctx.params['promotionId'] ?? '');
        if (input === undefined) {
          throw apiError(400, {
            code: 'not_readable_as_an_effectiveness_measure',
            whatHappened: 'Measuring a promotion needs whole baselineUnits and actualUnits, and baselineMargin and actualMargin as { minor, currency }.',
            wasItSaved: 'not_saved',
            nextSafeAction: 'Nothing was changed. Send the baseline and actual units and margins for the finished promotion.',
          });
        }
        return { status: 200, body: { ...measureEffectiveness(input), asAt: deps.now() } };
      },
    },
    {
      // "The supplier is covering it" becomes a number, not a memory (D02): claimed vs actually
      // received on the display/funding agreement, so a discount given with the contribution never
      // received is visible rather than lost. A pure reconciliation over the figures supplied.
      api: 'API-02', method: 'POST', path: '/v1/promotions/:promotionId/vendor-funding',
      permission: 'promotion.read', idempotent: true,
      handler: async (ctx) => {
        const claim = readFundingClaim(ctx.body, ctx.params['promotionId'] ?? '');
        if (claim === undefined) {
          throw apiError(400, {
            code: 'not_readable_as_a_funding_claim',
            whatHappened: 'A vendor funding claim needs a supplierId, agreedPerUnit as { minor, currency } and whole unitsSold.',
            wasItSaved: 'not_saved',
            nextSafeAction: 'Nothing was changed. Send the supplier, the agreed per-unit contribution and the units sold.',
          });
        }
        return { status: 200, body: { ...reconcileVendorFunding(claim, claim.agreedPerUnit.currency), asAt: deps.now() } };
      },
    },
  ];
}
