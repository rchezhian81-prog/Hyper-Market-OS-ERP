// API-02 Catalogue master-data guards — commit-time checks on the product master that a pack must pass
// before it can carry a value. First guard: the dual-MRP rule (roadmap v2.1 B2) — a pack may carry only
// one active MRP, so a second, different MRP taking effect on the same date is rejected. Stateless over
// the tested `checkDualMrp` engine; validates a PROPOSED change, so it reads (it never commits the
// master record). Gated `catalogue.pack.read` — the same permission the catalogue is read under.

import type { Route } from '../../kernel/src/index';
import { apiError } from '../../kernel/src/index';
import { checkDualMrp, InvalidMrpEntry, type MrpEntry } from '../../../packages/product/src/index';

const isIntString = (s: unknown): s is string => typeof s === 'string' && /^\d+$/.test(s);

/** Parse `existing=2026-01-01~10000,2026-06-01~12000` into MRP entries. Empty → no history. */
function parseExisting(raw: string | undefined): MrpEntry[] {
  if (typeof raw !== 'string' || raw === '') return [];
  return raw.split(',').map((pair) => {
    const [effectiveFrom, minor] = pair.split('~');
    return { effectiveFrom: effectiveFrom ?? '', valueMinor: Number(minor) };
  });
}

export function masterDataRoutes(): readonly Route[] {
  return [
    {
      // Would a proposed MRP make the pack carry two different active MRPs on the same date? (B2)
      // ?effectiveFrom=YYYY-MM-DD&valueMinor=&existing=DATE~MINOR,DATE~MINOR
      api: 'API-02', method: 'GET', path: '/v1/catalogue/dual-mrp-check',
      permission: 'catalogue.pack.read',
      handler: async (ctx) => {
        const effectiveFrom = ctx.query['effectiveFrom'];
        const valueMinor = ctx.query['valueMinor'];
        if (typeof effectiveFrom !== 'string' || effectiveFrom === '' || !isIntString(valueMinor)) {
          throw apiError(400, {
            code: 'dual_mrp_needs_proposed',
            whatHappened: 'The dual-MRP check needs the proposed ?effectiveFrom=YYYY-MM-DD and ?valueMinor=<whole paisa>.',
            wasItSaved: 'not_saved',
            nextSafeAction: 'Send the proposed MRP and its effective date; optionally ?existing=DATE~MINOR,… for the current history.',
          });
        }
        try {
          const result = checkDualMrp(parseExisting(ctx.query['existing']), { effectiveFrom, valueMinor: Number(valueMinor) });
          return { status: 200, body: result };
        } catch (err) {
          if (err instanceof InvalidMrpEntry) throw apiError(400, { code: 'dual_mrp_invalid', whatHappened: err.message, wasItSaved: 'not_saved', nextSafeAction: 'Correct the dates (YYYY-MM-DD) and amounts (positive whole paisa).' });
          throw err;
        }
      },
    },
  ];
}
