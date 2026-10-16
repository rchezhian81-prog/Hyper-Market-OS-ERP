// C10 (v2.1 addendum · MG-04 cleaning · hard rule #3) — the legacy-card-purge check, on the API.
//
//   POST /v1/migration/legacy-card-purge/check — read a legacy extract (its records, as extracted) for card data, and
//   answer passed / not passed. A failed check names each finding by source, record and column — never the value — and
//   the columns the cleaning step must drop. It reads and reports; it stores nothing, so it is safe on any target and
//   the card data it finds is never written anywhere by asking.
//
// The engine is `packages/tender/src/legacy-card-purge.ts`.

import type { Route } from '../../kernel/src/index';
import { apiError } from '../../kernel/src/index';
import { checkLegacyCardPurge, type LegacyRecord } from '../../../packages/tender/src/legacy-card-purge';

/** A bound on one request: an extract is checked in pages, so one call cannot hold the whole legacy database. */
export const LEGACY_PURGE_MAX_RECORDS = 5_000;

const isRecord = (v: unknown): v is LegacyRecord => {
  if (v === null || typeof v !== 'object') return false;
  const r = v as Record<string, unknown>;
  return typeof r['source'] === 'string' && r['source'].trim() !== '' && typeof r['rowRef'] === 'string'
    && r['fields'] !== null && typeof r['fields'] === 'object' && !Array.isArray(r['fields']);
};

export function legacyCardPurgeRoutes(): readonly Route[] {
  return [
    {
      api: 'API-12', method: 'POST', path: '/v1/migration/legacy-card-purge/check',
      permission: 'migration.cleaning.read', idempotent: true,
      handler: (ctx) => {
        const records = (ctx.body as { records?: unknown } | null)?.records;
        if (!Array.isArray(records) || records.length === 0 || records.length > LEGACY_PURGE_MAX_RECORDS || !records.every(isRecord)) {
          throw apiError(400, {
            code: 'not_readable_as_legacy_records',
            whatHappened: `The check needs { records: [{ source, rowRef, fields: { <column>: <value> } }] } — 1 to ${LEGACY_PURGE_MAX_RECORDS} records a call.`,
            wasItSaved: 'not_saved',
            nextSafeAction: 'Send the extract in pages. Nothing was stored; the check only reads.',
          });
        }
        return Promise.resolve({ status: 200, body: checkLegacyCardPurge(records) });
      },
    },
  ];
}
