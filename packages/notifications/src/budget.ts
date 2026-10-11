// The messaging budget (audit PA-08 · M31-FR-04 "cost tracked/capped … over-budget messaging halts per policy" ·
// decision D3 "the system fails SAFE when a budget is exhausted; no unexpected overage permitted").
//
// The owner sets a monthly cap and what one message costs on each channel (from the provider's price list). Every send
// is costed; head office checks the cap when a message is queued AND again immediately before it is handed to the
// provider, so a month that filled up after a message was queued still stops it. No budget set means nothing is sent —
// fail safe, the same "off until set" rule as the till's loyalty cap — and a channel with no cost set is not sent on.
// Pure and deterministic.

export interface MessagingBudget {
  /** The most the shop spends on messages in one calendar month, in paise. */
  readonly capMinor: number;
  /** What one message costs on each channel, in paise. A channel missing here is not sent on. */
  readonly costMinorByChannel: Readonly<Record<string, number>>;
  readonly version: number;
  readonly setBy: string;
  readonly setAt: string;
}

/** The budget period a moment falls in: its calendar month, `YYYY-MM` (UTC). */
export function budgetPeriodOf(at: string): string {
  return new Date(Date.parse(at)).toISOString().slice(0, 7);
}

export type BudgetDecision =
  | { readonly ok: true; readonly costMinor: number }
  | { readonly ok: false; readonly reason: 'no_budget_set' | 'channel_not_costed' | 'over_budget'; readonly detail: string };

/** May one more message on `channel` be sent, with `spentMinor` already spent this period? */
export function budgetDecision(input: {
  readonly budget: MessagingBudget | undefined;
  readonly spentMinor: number;
  readonly channel: string;
}): BudgetDecision {
  const b = input.budget;
  if (b === undefined) {
    return { ok: false, reason: 'no_budget_set', detail: 'no messaging budget has been set, so nothing is sent (it is off until the owner sets one)' };
  }
  const cost = b.costMinorByChannel[input.channel];
  if (cost === undefined || !Number.isInteger(cost) || cost < 0) {
    return { ok: false, reason: 'channel_not_costed', detail: `the budget sets no cost for a ${input.channel} message, so none is sent on it` };
  }
  if (input.spentMinor + cost > b.capMinor) {
    return { ok: false, reason: 'over_budget', detail: `this month's messaging budget is ${b.capMinor} paise and ${input.spentMinor} is already spent; one more ${input.channel} message costs ${cost}` };
  }
  return { ok: true, costMinor: cost };
}
