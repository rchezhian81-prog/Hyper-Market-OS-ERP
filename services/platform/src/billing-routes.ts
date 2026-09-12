// API-11 Platform — subscription & recurring billing (WP5, ADR-0014).
//
// This is the vendor's own money surface: what plans exist, a tenant's current subscription and
// dunning state, subscribing (which sets up the auto-debit mandate through the provider), giving
// notice, and the provider's webhook telling us a monthly debit went through or failed.
//
// It stays under **API-11** (the surface is fixed at 13 ids) and the `platform.*` namespace. The
// paying action — `platform.subscription.manage` — is the tenant OWNER's, never the platform
// administrator's, because setting up a debit against a tenant's bank is a decision for the person
// whose money it is, not for whoever runs the platform (separation of duties, §28). Every rule that
// has to be right lives in the tested `packages/platform` engine; these handlers only map HTTP to it.

import type { Route } from '../../kernel/src/index';
import { apiError } from '../../kernel/src/index';
import type { BillingRail, BillingSnapshot, DunningStatus } from '../../../packages/platform/src/billing';
import type { Plan } from '../../../packages/platform/src/plans';

const RAILS: readonly BillingRail[] = ['upi_autopay', 'card_emandate', 'enach'];

export interface SubscribeOutcome {
  readonly snapshot: BillingSnapshot;
  /** Where the payer completes mandate authorisation. Sandbox returns a non-live placeholder. */
  readonly authorisationUrl: string;
  readonly providerMode: 'sandbox' | 'live';
}

export interface WebhookOutcome {
  readonly verified: boolean;
  readonly applied: boolean;
  readonly detail: string;
  readonly dunning?: DunningStatus;
}

export interface BillingDeps {
  readonly plans: () => Promise<readonly Plan[]> | readonly Plan[];
  readonly subscription: (tenantId: string) => Promise<BillingSnapshot | undefined> | BillingSnapshot | undefined;
  readonly subscribe: (
    tenantId: string,
    input: { readonly planId: string; readonly rail: BillingRail; readonly by: string },
  ) => Promise<SubscribeOutcome>;
  readonly cancel: (tenantId: string, by: string) => Promise<BillingSnapshot | undefined>;
  readonly handleWebhook: (input: { readonly rawBody: string; readonly signature: string }) => Promise<WebhookOutcome>;
  readonly now: () => string;
}

export function billingRoutes(deps: BillingDeps): readonly Route[] {
  return [
    {
      // The plans on offer, so the signup screen and the owner can see what can be subscribed to.
      api: 'API-11', method: 'GET', path: '/v1/platform/plans',
      permission: 'platform.plan.read',
      handler: async () => ({ status: 200, body: { plans: await deps.plans() } }),
    },
    {
      // This tenant's current subscription, dunning state and next debit — or a clear "not a
      // subscriber yet", which is a real answer, not an error.
      api: 'API-11', method: 'GET', path: '/v1/platform/subscription',
      permission: 'platform.subscription.read',
      handler: async (ctx) => {
        const snapshot = await deps.subscription(ctx.tenantId);
        return snapshot === undefined
          ? { status: 200, body: { subscribed: false, detail: 'no subscription yet' } }
          : { status: 200, body: { subscribed: true, subscription: snapshot } };
      },
    },
    {
      // Subscribe: choose a plan and a rail, and set up the monthly auto-debit mandate. The tenant is
      // ALWAYS the caller's — never a field in the body — so one tenant can never subscribe another
      // (§35). The plan must be one actually offered, and the rail one RBI's framework covers.
      api: 'API-11', method: 'POST', path: '/v1/platform/subscription',
      permission: 'platform.subscription.manage', idempotent: true,
      handler: async (ctx) => {
        const body = (ctx.body ?? {}) as { planId?: unknown; rail?: unknown };
        const planId = typeof body.planId === 'string' ? body.planId : '';
        const rail = body.rail;
        const plans = await deps.plans();
        if (plans.find((p) => p.planId === planId) === undefined) {
          throw apiError(404, {
            code: 'unknown_plan',
            whatHappened: `There is no plan "${planId}".`,
            wasItSaved: 'not_saved',
            nextSafeAction: `Choose one of: ${plans.map((p) => p.planId).join(', ') || '(none configured)'}. Nothing was set up.`,
          });
        }
        if (typeof rail !== 'string' || !RAILS.includes(rail as BillingRail)) {
          throw apiError(400, {
            code: 'unknown_rail',
            whatHappened: 'A subscription must name a valid auto-debit rail.',
            wasItSaved: 'not_saved',
            nextSafeAction: `Choose one of: ${RAILS.join(', ')}. Nothing was set up.`,
          });
        }
        const outcome = await deps.subscribe(ctx.tenantId, { planId, rail: rail as BillingRail, by: ctx.userId });
        return {
          status: 201,
          body: {
            subscription: outcome.snapshot,
            authorisationUrl: outcome.authorisationUrl,
            providerMode: outcome.providerMode,
            // Say plainly that no real money can move yet when the provider is in sandbox.
            note: outcome.providerMode === 'sandbox'
              ? 'Sandbox: the mandate is simulated and NO real money can be debited until a live merchant account is configured.'
              : 'Live: the payer must complete authorisation at authorisationUrl before the first debit.',
          },
        };
      },
    },
    {
      // Give notice. Service continues until the end of the paid period (endsOn); no data is deleted
      // (a downgrade/cancel never removes history — packages/platform/plans.ts).
      api: 'API-11', method: 'POST', path: '/v1/platform/subscription/cancellation',
      permission: 'platform.subscription.manage', idempotent: true,
      handler: async (ctx) => {
        const snapshot = await deps.cancel(ctx.tenantId, ctx.userId);
        if (snapshot === undefined) {
          throw apiError(404, {
            code: 'no_subscription',
            whatHappened: 'There is no subscription on this account to cancel.',
            wasItSaved: 'not_saved',
            nextSafeAction: 'Nothing changed. Subscribe first, then a cancellation has something to act on.',
          });
        }
        return { status: 200, body: { subscription: snapshot } };
      },
    },
    {
      // The provider's webhook: a monthly debit succeeded or failed. Verified first (a webhook we
      // cannot verify is refused, not applied), then folded into dunning — which can suspend optional
      // features but never stop the shop trading (P-01). Idempotent: a re-delivered webhook collapses.
      api: 'API-11', method: 'POST', path: '/v1/platform/billing/webhook',
      permission: 'platform.billing.webhook', idempotent: true,
      handler: async (ctx) => {
        const body = (ctx.body ?? {}) as { event?: unknown; signature?: unknown };
        if (typeof body.signature !== 'string' || body.event === undefined) {
          throw apiError(400, {
            code: 'malformed_webhook',
            whatHappened: 'A billing webhook must carry an event and a signature.',
            wasItSaved: 'not_saved',
            nextSafeAction: 'Send { event, signature }. Nothing was applied.',
          });
        }
        const rawBody = JSON.stringify(body.event);
        const outcome = await deps.handleWebhook({ rawBody, signature: body.signature });
        if (!outcome.verified) {
          throw apiError(400, {
            code: 'webhook_signature_invalid',
            whatHappened: 'The billing webhook signature did not verify — it was not applied.',
            wasItSaved: 'not_saved',
            nextSafeAction: 'A genuine provider webhook carries a valid signature. Nothing was changed.',
          });
        }
        return { status: 200, body: { applied: outcome.applied, detail: outcome.detail, dunning: outcome.dunning } };
      },
    },
  ];
}
