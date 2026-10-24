// API-02 searches that found nothing (D02-FR-04 range gaps · OB-319 "no-result searches"). When a customer searches the
// app and nothing matches, that is demand the range does not meet — and until now it was seen by nobody. The app (or the
// storefront search) reports the WORDS searched and nothing else: no customer, no device, no location (P-04 — words typed
// by a customer could be anything, so only the normalised words are kept, cut to 60 characters, and nothing that looks
// like a phone number or an e-mail address is kept at all).
//
//   POST /v1/catalogue/search-misses   { words, at? } — one search that found nothing (customer app, `catalogue.search.miss.record`)
//
// Append-only. The range-gap report counts them by the words searched (`GET /v1/merchandising/range-gaps`).

import type { Route } from '../../kernel/src/index';
import { apiError } from '../../kernel/src/index';

export interface SearchMissRecord {
  readonly words: string;
  readonly at: string;
}

export interface SearchMissDeps {
  readonly recordMiss: (tenantId: string, miss: SearchMissRecord, key: string) => Promise<void>;
  readonly now: () => string;
}

/** The words kept, or undefined when nothing safe is left (a number or an address is never kept). */
export function normaliseSearchWords(raw: unknown): string | undefined {
  if (typeof raw !== 'string') return undefined;
  const words = raw.toLowerCase().replace(/\s+/g, ' ').trim().slice(0, 60).trim();
  if (words === '') return undefined;
  if (/@/.test(words) || /\d{6,}/.test(words.replace(/[\s-]/g, ''))) return undefined;
  return words;
}

export function searchMissRoutes(deps: SearchMissDeps): readonly Route[] {
  return [
    {
      api: 'API-02', method: 'POST', path: '/v1/catalogue/search-misses',
      permission: 'catalogue.search.miss.record', idempotent: true,
      handler: async (ctx) => {
        const b = (ctx.body ?? {}) as Record<string, unknown>;
        const words = normaliseSearchWords(b['words']);
        if (words === undefined) {
          throw apiError(400, {
            code: 'not_readable_as_a_search',
            whatHappened: 'A search that found nothing is sent as { words } — the words searched, at most 60 characters. A phone number or an e-mail address is never kept.',
            wasItSaved: 'not_saved',
            nextSafeAction: 'Send the words only. Nothing was saved.',
          });
        }
        const miss: SearchMissRecord = { words, at: deps.now() };
        await deps.recordMiss(ctx.tenantId, miss, ctx.idempotencyKey ?? `${words}:${miss.at}`);
        return { status: 201, body: { recorded: true, words } };
      },
    },
  ];
}
