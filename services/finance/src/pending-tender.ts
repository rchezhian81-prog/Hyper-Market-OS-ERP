// API-09 Pending-tender recovery — the card machine that never answered (D04-FR-02 / M12-FR-03 / §4.3).
//
// A card/UPI tender the lane committed as `uncertain` (the sale completed locally, hard rule #1) is
// reconciled here against the PROVIDER'S OWN authorisation record — the only place the two can be
// compared. The tested `@sre/tender` engine does the ruling; deliberately there is NO way to resolve an
// uncertain tender by hand (the moment one exists, somebody uses it to clear a 9pm queue). Both costly
// outcomes are surfaced, in opposite directions:
//   • NOT PAID — the shop is owed (and it is told whether the customer can even be contacted, so an
//     anonymous walk-in's debt is not mistaken for a collectable one);
//   • PAID TWICE / OVER-CAPTURED — the customer is owed, reported just as loudly (a shop that only
//     chases money owed TO it and quietly keeps money owed BY it is running a leak in its own favour).
//
// One call reconciles a batch of uncertain tenders against the provider records, then reports the day's
// exposure split four ways (recoverable / unrecoverable / owed-to-customers / still-unknown) and whether
// the day may close — blocked ONLY while the shop is holding a customer's money, never by an unknown
// (§4.3 / M14-FR-04). A pure compute over supplied evidence — it writes nothing. Gated
// `settlement.review.read`.
//
// `statementComplete` is load-bearing: no authorisation on an INCOMPLETE record is *not* a decline —
// treating it as one is how a shop chases a customer who already paid. And a `providerRef` that looks
// like a card number is refused outright (hard rule #3): only provider tokens ever enter the system.

import type { Route } from '../../kernel/src/index';
import { apiError } from '../../kernel/src/index';
import {
  recoverPendingTender, pendingExposure, dayCloseCheck,
  type UncertainTender, type ProviderAuthorisation,
} from '../../../packages/tender/src/pending-recovery';
import { looksLikeCardNumber } from '../../../packages/ops/src/index';

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const isStr = (v: unknown): v is string => typeof v === 'string' && v.trim() !== '';
const isInt = (v: unknown): v is number => typeof v === 'number' && Number.isInteger(v);
const TENDER_KINDS = ['card', 'upi', 'wallet', 'netbanking'] as const;
const AUTH_STATUSES = ['captured', 'declined', 'voided'] as const;

/** A `providerRef` that passes a Luhn/length check for raw card data is refused — only tokens enter (hard rule #3). */
class ProviderRefNotAToken extends Error {}

function readTender(v: unknown): UncertainTender | undefined {
  if (!isObj(v)) return undefined;
  if (!isStr(v['tenderId']) || !isStr(v['saleId']) || !isStr(v['laneId']) || !isStr(v['providerRef'])
    || !(TENDER_KINDS as readonly string[]).includes(v['kind'] as string)
    || !isInt(v['amountMinor']) || !isStr(v['currency']) || !isStr(v['capturedAt'])) {
    return undefined;
  }
  if (v['customerRef'] !== undefined && !isStr(v['customerRef'])) return undefined;
  if (v['attempts'] !== undefined && !isInt(v['attempts'])) return undefined;
  // A provider reference is a TOKEN. A value that looks like a real card number never belongs here.
  if (looksLikeCardNumber(v['providerRef'] as string)) throw new ProviderRefNotAToken();
  return {
    tenderId: v['tenderId'] as string, saleId: v['saleId'] as string, laneId: v['laneId'] as string,
    kind: v['kind'] as UncertainTender['kind'], providerRef: v['providerRef'] as string,
    amountMinor: v['amountMinor'] as number, currency: v['currency'] as string, capturedAt: v['capturedAt'] as string,
    ...(isStr(v['customerRef']) ? { customerRef: v['customerRef'] as string } : {}),
    ...(isInt(v['attempts']) ? { attempts: v['attempts'] as number } : {}),
  };
}

function readAuthorisation(v: unknown): ProviderAuthorisation | undefined {
  if (!isObj(v) || !isStr(v['ref']) || !isInt(v['amountMinor'])
    || !(AUTH_STATUSES as readonly string[]).includes(v['status'] as string) || !isStr(v['at'])) {
    return undefined;
  }
  if (looksLikeCardNumber(v['ref'] as string)) throw new ProviderRefNotAToken();
  return { ref: v['ref'] as string, amountMinor: v['amountMinor'] as number, status: v['status'] as ProviderAuthorisation['status'], at: v['at'] as string };
}

function readAll<T>(v: unknown, read: (x: unknown) => T | undefined): readonly T[] | undefined {
  if (!Array.isArray(v)) return undefined;
  const out: T[] = [];
  for (const item of v) {
    const one = read(item);
    if (one === undefined) return undefined;
    out.push(one);
  }
  return out;
}

export interface PendingTenderDeps {
  readonly now: () => string;
}

export function pendingTenderRoutes(deps: PendingTenderDeps): readonly Route[] {
  return [
    {
      // RECOVER — reconcile the supplied uncertain tenders against the provider's authorisations, then
      // report the exposure (four ways) and whether the day may close. POST because the evidence is a
      // body; it writes nothing (a reconciliation reads the provider's truth, it does not change it).
      api: 'API-09', method: 'POST', path: '/v1/settlement/pending-tenders/recover',
      permission: 'settlement.review.read', idempotent: true,
      handler: async (ctx) => {
        const b = (ctx.body ?? {}) as Record<string, unknown>;
        let tenders: readonly UncertainTender[] | undefined;
        let auths: readonly ProviderAuthorisation[] | undefined;
        try {
          tenders = readAll(b['tenders'], readTender);
          auths = readAll(b['authorisations'], readAuthorisation);
        } catch (e) {
          if (e instanceof ProviderRefNotAToken) {
            throw apiError(422, {
              code: 'provider_ref_not_a_token',
              whatHappened: 'A providerRef looked like raw card data rather than a provider token. Only provider tokens may enter the system (hard rule #3).',
              wasItSaved: 'not_saved',
              nextSafeAction: 'Send the provider’s token/reference for this tender, not the raw card details.',
            });
          }
          throw e;
        }
        const statementComplete = b['statementComplete'];
        if (tenders === undefined || auths === undefined || typeof statementComplete !== 'boolean') {
          throw apiError(400, {
            code: 'not_readable_as_pending_recovery',
            whatHappened: 'Recovery needs { tenders[] } (each with tenderId, saleId, laneId, kind, providerRef, amountMinor, currency, capturedAt), { authorisations[] } (ref, amountMinor, status, at), and a boolean { statementComplete }.',
            wasItSaved: 'not_saved',
            nextSafeAction: 'Send the uncertain tenders and the provider’s authorisation records for the period. A recovery reads, it never writes.',
          });
        }

        const at = isStr(b['at']) ? (b['at'] as string) : deps.now();
        const results = tenders.map((tender) => recoverPendingTender({ tender, authorisations: auths!, statementComplete, at }));
        const exposure = pendingExposure(results);
        const dayClose = dayCloseCheck(exposure);
        return { status: 200, body: { results, exposure, dayClose, at } };
      },
    },
  ];
}
