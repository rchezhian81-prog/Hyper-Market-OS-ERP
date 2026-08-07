// Duplicate bank-account detection (M15-FR-03) — a mandatory fraud control. If two
// or more distinct holders (suppliers and/or employees) share a bank account, that
// is flagged and payment is BLOCKED pending review (ties D03-FR-06 bank-change
// verification and M06-FR-01). Pure and deterministic — evaluated over the current
// holder→account references (masked/tokenised; PRV: no raw account numbers).

export type HolderType = 'supplier' | 'employee';

export interface BankAccountHolder {
  readonly holderId: string;
  readonly holderType: HolderType;
  /** Masked/tokenised bank account reference — the shared key. */
  readonly accountRef: string;
}

export interface DuplicateBankFlag {
  readonly accountRef: string;
  /** The distinct holders sharing this account (>= 2). */
  readonly holders: readonly { readonly holderId: string; readonly holderType: HolderType }[];
}

/**
 * Detect accounts shared by two or more DISTINCT holders. The same holder listing an
 * account twice is not a duplicate; only cross-holder sharing is. Deterministic:
 * flags ordered by accountRef, holders by holderId.
 */
export function detectDuplicateBankAccounts(
  holders: readonly BankAccountHolder[],
): DuplicateBankFlag[] {
  const byAccount = new Map<string, Map<string, HolderType>>();
  for (const h of holders) {
    let holderMap = byAccount.get(h.accountRef);
    if (holderMap === undefined) {
      holderMap = new Map();
      byAccount.set(h.accountRef, holderMap);
    }
    holderMap.set(h.holderId, h.holderType); // dedupe by holderId
  }

  const flags: DuplicateBankFlag[] = [];
  for (const [accountRef, holderMap] of byAccount) {
    if (holderMap.size >= 2) {
      const list = [...holderMap.entries()]
        .map(([holderId, holderType]) => ({ holderId, holderType }))
        .sort((a, b) => (a.holderId < b.holderId ? -1 : a.holderId > b.holderId ? 1 : 0));
      flags.push({ accountRef, holders: list });
    }
  }
  return flags.sort((a, b) => (a.accountRef < b.accountRef ? -1 : a.accountRef > b.accountRef ? 1 : 0));
}

/** The set of holder ids whose payment must be blocked pending review (M15-FR-03). */
export function holdersBlockedForDuplicate(flags: readonly DuplicateBankFlag[]): Set<string> {
  const blocked = new Set<string>();
  for (const flag of flags) {
    for (const holder of flag.holders) blocked.add(holder.holderId);
  }
  return blocked;
}
