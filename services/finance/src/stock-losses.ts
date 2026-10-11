// API-09 Finance — the inventory-loss journal (M23-FR-01 · M08 · Batch 2's confirmed-lost shortfalls · P-08 · hard rule #2).
//
// When a floor indent's or a transfer's shortfall is RESOLVED, the units nobody found are confirmed lost: the warehouse
// records the resolution with its valued loss (`loss`, Batch 2's `ShortfallLoss` — only the lines with a loss; units that
// turned up are already back on the ledger as `adjusted` movements and are not a loss). Here each such loss becomes ONE
// balanced journal through the accountant's mapping (`stock_loss:floor_indent` / `stock_loss:transfer` — suggested as the
// loss expense against inventory), once per resolution: a re-run posts nothing twice. A kind the mapping does not name is
// said in the answer and stays on the unposted list until it does (P-08). A closed month takes nothing — the journal goes
// to the next open period carrying its real date.
//
// WF-08 · D05-FR-05 (round 8): a stock COUNT's correction that posted to the ledger is valued here too — missing stock as
// `stock_loss:count` (loss expense against inventory), found stock as `stock_gain:count` (inventory against a gain) —
// once per count, through the same mapping and the same period gate; an unvalued count stays visibly unposted.
//
// Finance does not read the stock ledger's other kinds: a production run (`consumed_in_production` / `produced`) moves value
// within inventory and posts no journal here.

import type { Route } from '../../kernel/src/index';
import { apiError } from '../../kernel/src/index';
import { postJournal as postMapped, UnmappedKindError, MissingComponentError, UnbalancedJournalError } from '../../../packages/finance/src/posting';
import type { ShortfallLoss } from '../../../packages/warehouse/src/transfers';
import { postJournal, type FinanceDeps, type JournalEntry } from './index';
import type { StoredPostingMap } from './day-book';

/** A stock-loss voucher: a finance journal that also names the resolution it posts. */
export interface StockLossJournal extends JournalEntry {
  readonly stockLoss: {
    readonly sourceId: string; readonly kind: string; readonly lostValueMinor: number; readonly belongsTo?: string;
    /** WF-08 (round 8): a count that FOUND stock posts a gain — its value here, `lostValueMinor` 0. */
    readonly gainedValueMinor?: number;
  };
}

/**
 * WF-08 · D05-FR-05 (round 8): a stock-count correction that POSTED to the stock ledger (`count:<countId>`) — the
 * financial impact of a count variance, valued at head office's own cost when it was counted. Stock missing is a loss
 * (`stock_loss:count`), stock found is a gain (`stock_gain:count`); one journal per count, through the mapping.
 */
export interface CountVarianceValue {
  readonly countId: string;
  readonly productId: string;
  readonly locationId: string;
  readonly uom: string;
  readonly varianceMinor: number;
  readonly valueMinor: number;
  /** False when head office had no cost for the product when it was counted — nothing can post until a person values it. */
  readonly valueKnown: boolean;
  /** When the correction posted to the stock ledger (the decision, or the count when it corrected at once). */
  readonly postedAt: string;
  readonly counterId: string;
  readonly approvedBy: string | null;
  readonly planId?: string;
  readonly causeCode?: string;
}
export const countSourceId = (c: CountVarianceValue): string => `count:${c.countId}`;
export const countKind = (c: CountVarianceValue): string => (c.varianceMinor < 0 ? 'stock_loss:count' : 'stock_gain:count');

export interface StockLossDeps extends Pick<FinanceDeps, 'periodStates' | 'nextOpenPeriod' | 'appendJournal' | 'now'> {
  readonly postingMap: (tenantId: string) => Promise<StoredPostingMap | undefined> | StoredPostingMap | undefined;
  /** Every resolved shortfall's valued loss, from the warehouse's indent and transfer streams. */
  readonly losses: (tenantId: string) => Promise<readonly ShortfallLoss[]> | readonly ShortfallLoss[];
  readonly stockLossJournals: (tenantId: string) => Promise<readonly StockLossJournal[]> | readonly StockLossJournal[];
  /** WF-08 (round 8): every count correction that posted to the stock ledger, valued. Optional on a bare stub. */
  readonly countVariances?: (tenantId: string) => Promise<readonly CountVarianceValue[]> | readonly CountVarianceValue[];
}

/** One resolution, one source id: a floor indent's issue, or a plain transfer. */
export const lossSourceId = (l: ShortfallLoss): string =>
  l.source === 'floor_indent' ? `floor_indent:${l.indentId ?? ''}:${l.issueId ?? l.transferId}` : `transfer:${l.transferId}`;
export const lossKind = (l: ShortfallLoss): string => `stock_loss:${l.source}`;

export function stockLossRoutes(deps: StockLossDeps): readonly Route[] {
  const position = async (t: string) => {
    const [losses, journals, counted] = await Promise.all([deps.losses(t), deps.stockLossJournals(t), deps.countVariances?.(t) ?? []]);
    const posted = new Set(journals.map((j) => j.stockLoss.sourceId));
    const valued = losses.filter((l) => l.lostValueMinor > 0);
    const counts = counted.filter((c) => c.varianceMinor !== 0);
    return {
      losses: valued, journals, unposted: valued.filter((l) => !posted.has(lossSourceId(l))),
      counts, unpostedCounts: counts.filter((c) => !posted.has(countSourceId(c))),
    };
  };
  return [
    {
      // Post every confirmed loss the ledger does not yet hold. Nothing to send: the figures are the warehouse's.
      api: 'API-09', method: 'POST', path: '/v1/finance/stock-losses/post',
      permission: 'finance.journal.post', idempotent: true,
      handler: async (ctx) => {
        const t = ctx.tenantId;
        const map = await deps.postingMap(t);
        if (map === undefined) {
          throw apiError(409, {
            code: 'posting_map_not_defined',
            whatHappened: 'No ledger mapping has been defined for this shop, so no stock loss can post — which account a loss goes to is the accountant\'s decision.',
            wasItSaved: 'not_saved',
            nextSafeAction: 'The accountant defines the mapping first (PUT /v1/finance/posting-map; GET it for a suggested starting map with the stock-loss rules). Nothing was posted and nothing was lost.',
          });
        }
        const [{ unposted, unpostedCounts }, states] = await Promise.all([position(t), deps.periodStates(t)]);
        const appended: StockLossJournal[] = [];
        const exceptions: { readonly sourceId: string; readonly kind: string; readonly reason: string; readonly detail: string }[] = [];
        for (const loss of unposted) {
          const sourceId = lossSourceId(loss);
          const kind = lossKind(loss);
          let mapped;
          try {
            mapped = postMapped({ id: sourceId, kind, at: loss.resolvedAt, currency: 'INR', components: { amount: loss.lostValueMinor } }, map);
          } catch (err) {
            const reason = err instanceof UnmappedKindError ? 'unmapped_kind' : err instanceof MissingComponentError ? 'missing_component' : err instanceof UnbalancedJournalError ? 'unbalanced_journal' : 'not_posted';
            exceptions.push({ sourceId, kind, reason, detail: err instanceof Error ? err.message : String(err) });
            continue;
          }
          const belongsTo = loss.resolvedAt.slice(0, 7);
          const closed = states.get(belongsTo) === 'closed';
          const period = closed ? await deps.nextOpenPeriod(t) : belongsTo;
          const journal: StockLossJournal = {
            entryId: `stock-loss:${sourceId}`, period, documentDate: loss.resolvedAt.slice(0, 10),
            narrative: `Stock confirmed lost — ${loss.source === 'floor_indent' ? 'floor indent' : 'transfer'} ${loss.transferId} from ${loss.fromLocationId} to ${loss.toLocationId}: `
              + `${loss.lines.map((l) => `${l.productId} ${l.lostMinor} ${l.uom}`).join(', ')} worth ${loss.lostValueMinor} minor units, resolved by ${loss.resolvedBy} (${loss.reasonCode})`
              + (closed ? ` (posted to ${period}: ${belongsTo} is closed)` : ''),
            lines: mapped.lines.map((l) => ({ accountCode: l.account, debitMinor: l.side === 'debit' ? l.amount.minor : 0, creditMinor: l.side === 'credit' ? l.amount.minor : 0 })),
            postedBy: ctx.userId,
            stockLoss: { sourceId, kind, lostValueMinor: loss.lostValueMinor, ...(closed ? { belongsTo } : {}) },
          };
          const gate = postJournal({ entry: journal, periodStates: states, nextOpenPeriod: period });
          if (!gate.ok) { exceptions.push({ sourceId, kind, reason: gate.refusedBecause ?? 'not_posted', detail: gate.detail }); continue; }
          await deps.appendJournal(t, journal);
          appended.push(journal);
        }
        // WF-08 · D05-FR-05 (round 8): every count variance that posted to the stock ledger — a loss against inventory, or a
        // gain — once per count, through the same mapping, period gate and journal the shortfall losses use.
        for (const c of unpostedCounts) {
          const sourceId = countSourceId(c);
          const kind = countKind(c);
          if (!c.valueKnown || c.valueMinor <= 0) {
            exceptions.push({ sourceId, kind, reason: 'value_unknown', detail: `Count ${c.countId} of ${c.productId} at ${c.locationId} (${c.varianceMinor} ${c.uom}) has no value: head office held no cost for it when counted. It stays unposted until it is valued.` });
            continue;
          }
          let mapped;
          try {
            mapped = postMapped({ id: sourceId, kind, at: c.postedAt, currency: 'INR', components: { amount: c.valueMinor } }, map);
          } catch (err) {
            const reason = err instanceof UnmappedKindError ? 'unmapped_kind' : err instanceof MissingComponentError ? 'missing_component' : err instanceof UnbalancedJournalError ? 'unbalanced_journal' : 'not_posted';
            exceptions.push({ sourceId, kind, reason, detail: err instanceof Error ? err.message : String(err) });
            continue;
          }
          const belongsTo = c.postedAt.slice(0, 7);
          const closed = states.get(belongsTo) === 'closed';
          const period = closed ? await deps.nextOpenPeriod(t) : belongsTo;
          const loss = c.varianceMinor < 0;
          const journal: StockLossJournal = {
            entryId: `stock-count:${c.countId}`, period, documentDate: c.postedAt.slice(0, 10),
            narrative: `Stock count ${loss ? 'loss' : 'gain'} — count ${c.countId}${c.planId === undefined ? '' : ` (plan ${c.planId})`}: ${c.productId} at ${c.locationId} ${c.varianceMinor > 0 ? '+' : ''}${c.varianceMinor} ${c.uom} worth ${c.valueMinor} minor units`
              + `${c.causeCode === undefined ? '' : `, cause ${c.causeCode}`}; counted by ${c.counterId}${c.approvedBy === null ? ' (under the count-approval threshold)' : `, approved by ${c.approvedBy}`}`
              + (closed ? ` (posted to ${period}: ${belongsTo} is closed)` : ''),
            lines: mapped.lines.map((l) => ({ accountCode: l.account, debitMinor: l.side === 'debit' ? l.amount.minor : 0, creditMinor: l.side === 'credit' ? l.amount.minor : 0 })),
            postedBy: ctx.userId,
            stockLoss: { sourceId, kind, lostValueMinor: loss ? c.valueMinor : 0, ...(loss ? {} : { gainedValueMinor: c.valueMinor }), ...(closed ? { belongsTo } : {}) },
          };
          const gate = postJournal({ entry: journal, periodStates: states, nextOpenPeriod: period });
          if (!gate.ok) { exceptions.push({ sourceId, kind, reason: gate.refusedBecause ?? 'not_posted', detail: gate.detail }); continue; }
          await deps.appendJournal(t, journal);
          appended.push(journal);
        }
        return { status: appended.length > 0 ? 201 : 200, body: { posted: appended, exceptions, asAt: deps.now() } };
      },
    },
    {
      // Every confirmed loss: what posted, and what has not (visible until it does).
      api: 'API-09', method: 'GET', path: '/v1/finance/stock-losses',
      permission: 'finance.period.read',
      handler: async (ctx) => {
        const p = await position(ctx.tenantId);
        return {
          status: 200,
          body: {
            losses: p.losses.map((l) => ({ sourceId: lossSourceId(l), kind: lossKind(l), ...l })),
            journals: p.journals, unposted: [...p.unposted.map(lossSourceId), ...p.unpostedCounts.map(countSourceId)],
            lostValueMinor: p.losses.reduce((n, l) => n + l.lostValueMinor, 0) + p.counts.filter((c) => c.varianceMinor < 0).reduce((n, c) => n + c.valueMinor, 0),
            postedValueMinor: p.journals.reduce((n, j) => n + j.stockLoss.lostValueMinor, 0),
            // WF-08 (round 8): count variances — what they came to, gains apart from losses, and what has posted.
            countVariances: p.counts.map((c) => ({ sourceId: countSourceId(c), kind: countKind(c), ...c })),
            gainedValueMinor: p.counts.filter((c) => c.varianceMinor > 0).reduce((n, c) => n + c.valueMinor, 0),
            postedGainMinor: p.journals.reduce((n, j) => n + (j.stockLoss.gainedValueMinor ?? 0), 0),
            asAt: deps.now(),
          },
        };
      },
    },
  ];
}
