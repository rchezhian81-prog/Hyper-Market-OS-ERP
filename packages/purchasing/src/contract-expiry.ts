// Contract-expiry alerts (M04-FR-04 acceptance "an expired display contract raises an alert" · M06-FR-03 acceptance "an
// expiring contract raises an alert" · P-03 control by exception · P-08 no silent failure).
//
// Two registers hold contracts with an end date: the supplier display-space contracts (M04-FR-04, `DisplayContract`) and
// the supplier buying contracts (M06-FR-03, `SupplierContract`). Both already had a READ that ranks them; nothing raised
// one to the owner. This engine says which contracts need the owner told today, and with which alert id:
//
//   • an APPROVED contract whose last day has passed raises `expired` — always: the roadmap's own acceptance, and needs no
//     number anybody has to choose;
//   • an approved contract ending within the owner's warning window raises `expiring` — ONLY when the owner has entered that
//     window. Until then the window is "not set" and nothing is raised early (no invented number, OB-288 owner inputs);
//   • an unapproved contract raises nothing here: it carries no agreed terms to expire (the reads already list it as
//     unapproved, worst-first).
//
// The alert id carries the contract's end date, so a RENEWAL (the same contract id recorded again with a later end date —
// both registers keep the latest record per contract id) makes every earlier alert of that contract stale: the caller
// clears exactly those (`staleAlertIds`). An expired contract raises once while its alert is open; it is not raised again
// after the owner acknowledges it.
//
// Pure and deterministic: dates are YYYY-MM-DD, the day is given.

export type ContractRegister = 'display' | 'supplier';

/** The one shape both registers are read into. */
export interface ExpiringContract {
  readonly register: ContractRegister;
  readonly contractId: string;
  readonly supplierId: string;
  /** Inclusive last day, YYYY-MM-DD. */
  readonly endsOn: string;
  readonly approved: boolean;
  /** Words for the owner (the space a display contract buys; nothing for a buying contract). */
  readonly what?: string;
}

export type ExpiryStep = 'expired' | 'expiring';

import { told, type AlertText } from '../../ops/src/alert-words';

export interface ContractExpiryAlert {
  readonly alertId: string;
  readonly register: ContractRegister;
  readonly contractId: string;
  readonly supplierId: string;
  readonly endsOn: string;
  /** Negative once the contract has ended (−1 = ended yesterday). */
  readonly daysLeft: number;
  readonly step: ExpiryStep;
  readonly detail: string;
  /** OB-435: `detail`, structured (rendered in English into `detail`, and in Tamil for a Tamil reader). */
  readonly text?: AlertText;
}

const DAY_MS = 86_400_000;
const isDate = (s: string): boolean => /^\d{4}-\d{2}-\d{2}$/.test(s) && !Number.isNaN(Date.parse(`${s}T00:00:00Z`));

export const daysBetweenDates = (from: string, to: string): number =>
  Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / DAY_MS);

/** The prefix every alert of one contract carries — whatever its end date or step. */
export const contractAlertPrefix = (register: ContractRegister, contractId: string): string =>
  `${register === 'display' ? 'display-contract-expiry' : 'supplier-contract-expiry'}:${contractId}:`;

export const contractAlertId = (c: Pick<ExpiringContract, 'register' | 'contractId' | 'endsOn'>, step: ExpiryStep): string =>
  `${contractAlertPrefix(c.register, c.contractId)}${c.endsOn}:${step}`;

/** Read a warning window the owner typed: a whole number of days, 1 to 365. */
export function readWarningDays(raw: unknown): { readonly ok: true; readonly days: number } | { readonly ok: false; readonly why: string } {
  if (!Number.isInteger(raw)) return { ok: false, why: 'the warning window is a whole number of days' };
  const days = raw as number;
  if (days < 1 || days > 365) return { ok: false, why: 'the warning window is between 1 and 365 days' };
  return { ok: true, days };
}

/**
 * The alerts due today. `warnDays` null ⇒ the owner has not set the window: only expired contracts are raised.
 * A contract with an unreadable end date is skipped here (the register refuses such a record on the way in).
 */
export function contractExpiryAlerts(input: {
  readonly contracts: readonly ExpiringContract[];
  readonly today: string;
  readonly warnDays: number | null;
}): readonly ContractExpiryAlert[] {
  const out: ContractExpiryAlert[] = [];
  for (const c of input.contracts) {
    if (!c.approved || !isDate(c.endsOn)) continue;
    const daysLeft = daysBetweenDates(input.today, c.endsOn);
    const what = c.what === undefined || c.what.trim() === '' ? null : c.what.trim();
    if (daysLeft < 0) {
      out.push({
        alertId: contractAlertId(c, 'expired'), register: c.register, contractId: c.contractId, supplierId: c.supplierId, endsOn: c.endsOn, daysLeft, step: 'expired',
        ...told('contract.expired', { register: c.register, contractId: c.contractId, what, supplier: c.supplierId, endsOn: c.endsOn, daysAgo: -daysLeft }),
      });
    } else if (input.warnDays !== null && daysLeft <= input.warnDays) {
      out.push({
        alertId: contractAlertId(c, 'expiring'), register: c.register, contractId: c.contractId, supplierId: c.supplierId, endsOn: c.endsOn, daysLeft, step: 'expiring',
        ...told('contract.expiring', { register: c.register, contractId: c.contractId, what, supplier: c.supplierId, endsOn: c.endsOn, daysLeft, warnDays: input.warnDays }),
      });
    }
  }
  return out.sort((a, b) => a.daysLeft - b.daysLeft || a.alertId.localeCompare(b.alertId));
}

/**
 * The open alert ids of these registers that no longer describe a contract as it stands: its record now ends on a later
 * date (renewed), or it is no longer due at all. These are cleared, never deleted (the lifecycle keeps them).
 */
export function staleAlertIds(input: {
  readonly openAlertIds: readonly string[];
  readonly due: readonly ContractExpiryAlert[];
}): readonly string[] {
  const dueIds = new Set(input.due.map((a) => a.alertId));
  return input.openAlertIds
    .filter((id) => (id.startsWith('display-contract-expiry:') || id.startsWith('supplier-contract-expiry:')) && !dueIds.has(id))
    .sort();
}
