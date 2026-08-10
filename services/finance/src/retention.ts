// API-09 Finance — statutory retention (roadmap v2.1 A28, M34-FR-02). A stateless read over the tested
// `statutoryRetentionDecision` engine: given a record's date, the statutes that bind it and today, it
// says the governing (LONGEST) retention period, the date the record may be reviewed for deletion, and
// whether a legal hold blocks deletion regardless. It reads — it never deletes; deletion stays a
// separate, authorised, audited human act (hard rule #6). Gated `finance.period.read` — the accountant
// and owner are who answer "how long must we keep the books".

import type { Route } from '../../kernel/src/index';
import { apiError } from '../../kernel/src/index';
import { statutoryRetentionDecision, InvalidRetentionInput, type Statute } from '../../../packages/audit/src/index';

export function retentionRoutes(): readonly Route[] {
  return [
    {
      // The governing retention period and deletion-eligibility for a record (A28).
      // ?recordDate=YYYY-MM-DD&statutes=gst,income_tax,companies_act&asOf=YYYY-MM-DD&onLegalHold=true
      api: 'API-09', method: 'GET', path: '/v1/finance/retention',
      permission: 'finance.period.read',
      handler: async (ctx) => {
        const recordDate = ctx.query['recordDate'];
        const asOf = ctx.query['asOf'];
        const statutesRaw = ctx.query['statutes'];
        if (typeof recordDate !== 'string' || typeof asOf !== 'string' || typeof statutesRaw !== 'string' || statutesRaw === '') {
          throw apiError(400, {
            code: 'retention_needs_record_and_statutes',
            whatHappened: 'A retention check needs ?recordDate=YYYY-MM-DD, ?statutes=gst,income_tax,companies_act and ?asOf=YYYY-MM-DD.',
            wasItSaved: 'not_saved',
            nextSafeAction: 'Send the record date, the statutes that bind it, and today’s date (optional ?onLegalHold=true).',
          });
        }
        try {
          const decision = statutoryRetentionDecision({
            recordDate,
            statutes: statutesRaw.split(',') as Statute[],
            asOf,
            onLegalHold: ctx.query['onLegalHold'] === 'true',
          });
          return { status: 200, body: decision };
        } catch (err) {
          if (err instanceof InvalidRetentionInput) throw apiError(400, { code: 'retention_invalid', whatHappened: err.message, wasItSaved: 'not_saved', nextSafeAction: 'Use YYYY-MM-DD dates and statutes from: gst, income_tax, companies_act.' });
          throw err;
        }
      },
    },
  ];
}
