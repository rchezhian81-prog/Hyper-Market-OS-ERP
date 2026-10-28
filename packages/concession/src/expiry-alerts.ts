// Concession expiry alerts (M27-FR-04 "track expiry dates → alert ahead of expiry → block new sales on lapse"). Pure.
//
// `mayConcessionTrade` already BLOCKS a lapsed counter, but its warning was worked out only when someone read the route —
// nobody was told. Here each date that matters (the agreement's end, the insurance, the licence) is judged on the day and
// turned into an alert at two steps — 30 days ahead, then 7 days ahead — and a LAPSED one. Each step has its own id, so the
// owner is told once per step (the alert lifecycle keeps an open alert from being raised twice) and a renewal (a new date)
// is a new alert, never an old one reopened. Only an approved, active contract is watched: an unapproved one cannot trade.

import type { ConcessionContract } from './concession';
import { told, type AlertText } from '../../ops/src/alert-words';

export type ExpiringDocument = 'agreement' | 'insurance' | 'licence';
export type ExpiryLevel = 'within_30_days' | 'within_7_days' | 'lapsed';

export interface ConcessionExpiryAlert {
  /** Stable per contract, document, date and step — the alert's id. */
  readonly alertId: string;
  readonly contractId: string;
  readonly name: string;
  readonly branchId: string;
  readonly document: ExpiringDocument;
  /** The date that ends it (inclusive last day). */
  readonly on: string;
  /** Days left (negative once lapsed). */
  readonly daysLeft: number;
  readonly level: ExpiryLevel;
  readonly detail: string;
  /** OB-435: `detail`, structured (rendered in English into `detail`, and in Tamil for a Tamil reader). */
  readonly text?: AlertText;
}

export const CONCESSION_WARN_DAYS = 30;
export const CONCESSION_URGENT_DAYS = 7;

const dayMs = 86_400_000;
const daysTo = (today: string, date: string): number => Math.floor((Date.parse(`${date}T00:00:00Z`) - Date.parse(`${today}T00:00:00Z`)) / dayMs);

const WORDS: Readonly<Record<ExpiringDocument, string>> = Object.freeze({ agreement: 'agreement', insurance: 'insurance', licence: 'licence' });

/** Every alert the shop's concession contracts call for today, most urgent first. */
export function concessionExpiryAlerts(contracts: readonly ConcessionContract[], today: string): readonly ConcessionExpiryAlert[] {
  const out: ConcessionExpiryAlert[] = [];
  for (const c of contracts) {
    if (!c.active || c.approvedBy === undefined) continue;
    const dates: [ExpiringDocument, string | undefined][] = [['agreement', c.endsOn], ['insurance', c.insuranceUntil], ['licence', c.licenceUntil]];
    for (const [document, on] of dates) {
      if (on === undefined) {
        // No insurance on record blocks trading (`mayConcessionTrade`) — said to the owner, never a quiet blank (P-08).
        if (document === 'insurance') {
          out.push({
            alertId: `concession-expiry:${c.contractId}:insurance:none:lapsed`, contractId: c.contractId, name: c.name, branchId: c.branchId,
            document, on: '', daysLeft: -1, level: 'lapsed',
            ...told('concession.noInsurance', { name: c.name }),
          });
        }
        continue;
      }
      const daysLeft = daysTo(today, on);
      const level: ExpiryLevel | undefined = daysLeft < 0 ? 'lapsed' : daysLeft <= CONCESSION_URGENT_DAYS ? 'within_7_days' : daysLeft <= CONCESSION_WARN_DAYS ? 'within_30_days' : undefined;
      if (level === undefined) continue;
      const what = WORDS[document];
      out.push({
        alertId: `concession-expiry:${c.contractId}:${document}:${on}:${level}`,
        contractId: c.contractId, name: c.name, branchId: c.branchId, document, on, daysLeft, level,
        ...(level === 'lapsed'
          ? told('concession.lapsed', { name: c.name, document: what, on })
          : told('concession.ending', { name: c.name, document: what, on, days: daysLeft })),
      });
    }
  }
  return out.sort((a, b) => a.daysLeft - b.daysLeft || (a.alertId < b.alertId ? -1 : 1));
}
