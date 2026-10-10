// The partner counters' trading decisions on the store computer — PF-13 (M27-FR-01, M27-FR-04, §31, P-01, P-08).
//
// Head office's agreement terms as this box last pulled them (`GET /v1/concession/trading-feed`), written to disk
// atomically and restored at boot, so a counter whose agreement lapsed is stopped with the cable out too. A NEW sale
// line for a partner counter is decided here BEFORE it reaches the disk (the lane socket refuses it in the cashier's
// words). A return or a cancellation is something that already happened and is always kept. A box that has never
// received the terms cannot decide, says so, and keeps the line — head office then records it and raises a breach if
// the agreement did not allow trading that day (never dropped).

import { open, readFile, rename } from 'node:fs/promises';
import { join } from 'node:path';
import { counterDecision, readConcessionTradingFeed, type ConcessionTradingFeed, type CounterDecision } from '../../../packages/concession/src/trading-feed';

const FILE = 'concession-trading.json';
const TEMP = 'concession-trading.json.tmp';

export type CounterCheck =
  | { readonly ok: true; readonly decided: 'allowed' | 'not_a_new_sale' | 'terms_not_known_on_this_box'; readonly contractId?: string }
  | { readonly ok: false; readonly refusedBecause: 'counter_may_not_trade'; readonly blockedBy: readonly string[]; readonly laneMessage: string };

export class ConcessionTrading {
  private held: { readonly feed: ConcessionTradingFeed; readonly receivedAt: string } | undefined;

  private constructor(private readonly dataDir: string, readonly tenantId: string, held: { readonly feed: ConcessionTradingFeed; readonly receivedAt: string } | undefined) {
    this.held = held;
  }

  static async open(input: { readonly dataDir: string; readonly tenantId: string }): Promise<ConcessionTrading> {
    let held: { feed: ConcessionTradingFeed; receivedAt: string } | undefined;
    try {
      const raw = JSON.parse(await readFile(join(input.dataDir, FILE), 'utf8')) as { feed?: unknown; receivedAt?: unknown };
      const feed = readConcessionTradingFeed(raw.feed);
      if (feed !== undefined && feed.tenantId === input.tenantId && typeof raw.receivedAt === 'string') held = { feed, receivedAt: raw.receivedAt };
    } catch {
      held = undefined;
    }
    return new ConcessionTrading(input.dataDir, input.tenantId, held);
  }

  heldFeed(): ConcessionTradingFeed | undefined { return this.held?.feed; }

  async takeFeed(feed: ConcessionTradingFeed, receivedAt: string): Promise<void> {
    const tempPath = join(this.dataDir, TEMP);
    const handle = await open(tempPath, 'w');
    try {
      await handle.write(`${JSON.stringify({ feed, receivedAt })}\n`);
      await handle.sync();
    } finally {
      await handle.close();
    }
    await rename(tempPath, join(this.dataDir, FILE));
    this.held = { feed, receivedAt };
  }

  /** Decide a docket line before the disk. `today` is the box's trading day; `branchId` the store this box is. */
  check(record: Record<string, unknown>, today: string, branchId: string | undefined): CounterCheck {
    const kind = typeof record['kind'] === 'string' ? record['kind'] : 'sale';
    if (kind !== 'sale') return { ok: true, decided: 'not_a_new_sale' };
    const feed = this.held?.feed;
    if (feed === undefined) return { ok: true, decided: 'terms_not_known_on_this_box' };
    const concessionaireId = typeof record['concessionaireId'] === 'string' ? record['concessionaireId'] : '';
    const contractId = typeof record['contractId'] === 'string' && record['contractId'] !== '' ? record['contractId'] : undefined;
    const d: CounterDecision = counterDecision({ feed, concessionaireId, today, ...(contractId === undefined ? {} : { contractId }), ...(branchId === undefined ? {} : { branchId }) });
    if (d.mayTrade) return { ok: true, decided: 'allowed', contractId: d.contractId };
    return { ok: false, refusedBecause: 'counter_may_not_trade', blockedBy: d.blockedBy, laneMessage: d.laneMessage };
  }
}
