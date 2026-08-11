// API-10 Owner alerts inbox (M29-FR-03) — control by exception (P-03) on the live API, run on the tested
// `packages/owner-control` engine. The owner is the primary user of this whole system and cannot read a
// hundred notifications, so raw exception events (large discounts, voided bills, price overrides,
// after-hours logins, till shortfalls) are GROUPED by kind, branch and person into the small number of
// alerts a phone screen can hold — "six voids by one cashier" is one conversation, not six pings — each
// keeping every underlying transaction id for the drill-through (M29-FR-02), each severity-ranked, and
// every threshold the owner's own (an unset kind raises nothing).
//
// Stateless and read-only (hard rule #5: nothing here commits): the caller supplies the period's
// exception events and the owner's thresholds, and this returns the alerts. It is the grouping the owner
// reads, not a new store of exceptions.

import type { Route } from '../../kernel/src/index';
import { apiError } from '../../kernel/src/index';
import {
  raiseOwnerAlerts,
  type ExceptionEvent, type OwnerThresholds,
} from '../../../packages/owner-control/src/index';

export function ownerAlertsRoutes(): readonly Route[] {
  return [
    {
      // A read modelled as POST because the exception events are an array — idempotent, writes nothing.
      api: 'API-10', method: 'POST', path: '/v1/reporting/owner-alerts',
      permission: 'owner.alert.read', idempotent: true,
      handler: async (ctx) => {
        const b = (ctx.body ?? {}) as Record<string, unknown>;
        if (!Array.isArray(b['events'])) {
          throw apiError(400, {
            code: 'owner_alerts_need_events',
            whatHappened: 'Owner alerts are grouped from an events array (the period’s exceptions) plus the owner’s thresholds.',
            wasItSaved: 'not_saved',
            nextSafeAction: 'Send { events: [...], thresholds: {...} }. A grouping reads, it never writes.',
          });
        }
        const thresholds = (typeof b['thresholds'] === 'object' && b['thresholds'] !== null ? b['thresholds'] : {}) as OwnerThresholds;
        const alerts = raiseOwnerAlerts({ events: b['events'] as ExceptionEvent[], thresholds });
        return { status: 200, body: { count: alerts.length, alerts } };
      },
    },
  ];
}
