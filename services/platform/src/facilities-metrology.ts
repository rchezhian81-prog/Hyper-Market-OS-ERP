// API-11 Facilities — weighing-instrument verification (roadmap v2.1 B6, Legal Metrology). A stateless
// gate over the tested `weighingScaleVerification` engine: given a scale's re-verification-due date and
// today, it says whether the scale's Legal Metrology verification is current and therefore whether the
// lane may trade on it. A DIFFERENT clock from the asset's maintenance (facilities-assets) — a serviced
// scale with a lapsed stamp is still illegal to weigh on. It folds no ledger, so it needs no deps.
// Gated `facilities.asset.read` — the permission that reads the asset register the scale belongs to.

import type { Route } from '../../kernel/src/index';
import { apiError } from '../../kernel/src/index';
import { weighingScaleVerification, InvalidScaleVerification } from '../../../packages/facilities/src/index';

const isIntString = (s: unknown): s is string => typeof s === 'string' && /^\d+$/.test(s);

export function weighingVerificationRoutes(): readonly Route[] {
  return [
    {
      // Is a weighing scale's Legal Metrology verification current, and may the lane trade on it? (B6)
      // ?reverificationDueOn=YYYY-MM-DD&asOf=YYYY-MM-DD&noticeDays=
      api: 'API-11', method: 'GET', path: '/v1/facilities/scale-verification',
      permission: 'facilities.asset.read',
      handler: async (ctx) => {
        const due = ctx.query['reverificationDueOn'];
        const asOf = ctx.query['asOf'];
        const noticeDays = ctx.query['noticeDays'];
        if (typeof due !== 'string' || typeof asOf !== 'string' || (noticeDays !== undefined && !isIntString(noticeDays))) {
          throw apiError(400, {
            code: 'scale_verification_needs_dates',
            whatHappened: 'A scale-verification check needs ?reverificationDueOn=YYYY-MM-DD and ?asOf=YYYY-MM-DD (optional ?noticeDays=).',
            wasItSaved: 'not_saved',
            nextSafeAction: 'Send the re-verification-due date and today’s date.',
          });
        }
        try {
          const status = weighingScaleVerification({ reverificationDueOn: due }, asOf, noticeDays === undefined ? undefined : Number(noticeDays));
          return { status: 200, body: status };
        } catch (err) {
          if (err instanceof InvalidScaleVerification) throw apiError(400, { code: 'scale_verification_invalid', whatHappened: err.message, wasItSaved: 'not_saved', nextSafeAction: 'Correct the dates (YYYY-MM-DD).' });
          throw err;
        }
      },
    },
  ];
}
