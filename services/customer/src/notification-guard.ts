// API-06 Notification send guard (M31-FR-03) — consent-safe BY CONSTRUCTION, on the live API, run on the
// tested `packages/notifications` engine (which reuses the M16 customer-consent engine).
//
// Before any notification goes out — a WhatsApp offer, an SMS receipt, a push — every gate must pass, in
// order: the template is APPROVED (§28), the contact is not on the do-not-contact SUPPRESSION list
// (absolute), CONSENT for this purpose+channel is granted, not withdrawn and within the frequency cap,
// and the messaging BUDGET is not exceeded. A breach BLOCKS the send — never warned-and-sent — and the
// decision names the first failing gate so the caller knows why. Pure and deterministic; a marketing run
// asks this before it sends, and a "no" is the shop staying on the right side of consent law.
//
// Stateless: the caller supplies the contact's consent state and this send's facts; this is the ruling,
// not a store of contacts or sends.

import type { Route } from '../../kernel/src/index';
import { apiError } from '../../kernel/src/index';
import { canNotify } from '../../../packages/notifications/src/index';
import type { ConsentState } from '../../../packages/customer/src/consent';
import { isSuppressed, type SuppressionFact } from './suppression-register';

export interface NotificationGuardDeps {
  /**
   * OB-288 P5 · M31-FR-04: the stored do-not-contact register. When the check names a `customerId`, suppression is READ
   * from it — a caller's `suppressed: false` can never clear a stored entry (a caller's `true` still blocks).
   */
  readonly suppressions?: (tenantId: string) => Promise<readonly SuppressionFact[]> | readonly SuppressionFact[];
}

export function notificationGuardRoutes(deps: NotificationGuardDeps = {}): readonly Route[] {
  return [
    {
      // A read/ruling modelled as POST (a consent object in the body) — idempotent, writes nothing.
      api: 'API-06', method: 'POST', path: '/v1/notifications/can-send',
      permission: 'notification.send.check', idempotent: true,
      handler: async (ctx) => {
        const b = (ctx.body ?? {}) as Record<string, unknown>;
        const consent = b['consent'] as ConsentState | undefined;
        if (typeof b['purpose'] !== 'string' || typeof b['channel'] !== 'string' || typeof b['templateApproved'] !== 'boolean' || consent === undefined || !Array.isArray(consent.grants)) {
          throw apiError(400, {
            code: 'notify_check_needs_purpose_channel_template_consent',
            whatHappened: 'A send check needs purpose, channel, templateApproved (boolean) and the contact’s consent { grants: [...] }.',
            wasItSaved: 'not_saved',
            nextSafeAction: 'Send the purpose, channel, whether the template is approved and the contact’s consent state.',
          });
        }
        const customerId = typeof b['customerId'] === 'string' && b['customerId'].trim() !== '' ? b['customerId'].trim() : undefined;
        const stored = customerId === undefined || deps.suppressions === undefined ? undefined : isSuppressed(await deps.suppressions(ctx.tenantId), customerId, b['channel']);
        const suppressed = stored?.suppressed === true || b['suppressed'] === true;
        const decision = canNotify({
          consent,
          purpose: b['purpose'],
          channel: b['channel'],
          templateApproved: b['templateApproved'],
          ...(stored !== undefined || typeof b['suppressed'] === 'boolean' ? { suppressed } : {}),
          ...(typeof b['sentInWindow'] === 'number' ? { sentInWindow: b['sentInWindow'] } : {}),
          ...(typeof b['frequencyCap'] === 'number' ? { frequencyCap: b['frequencyCap'] } : {}),
          ...(typeof b['costMinor'] === 'number' ? { costMinor: b['costMinor'] } : {}),
          ...(typeof b['budgetRemainingMinor'] === 'number' ? { budgetRemainingMinor: b['budgetRemainingMinor'] } : {}),
        });
        return {
          status: 200,
          body: {
            ...decision,
            suppressionFrom: stored !== undefined ? 'the do-not-contact register' : customerId === undefined ? 'not checked against the register: no customerId was named' : 'not checked: no register here',
          },
        };
      },
    },
  ];
}
