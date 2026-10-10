// The store computer's copy of the members' balances, and its record of what the till has spent — PF-09 step 3
// (M17-FR-01/03/04 · M12-FR-03 · §31 · hard rules #1 #2 #10 · P-01 · P-04 · P-08).
//
// The copy is head office's wallet feed as this box last pulled it, written to disk atomically (a reboot with the cable
// out still knows the balances, under head office's own clock) and checked to be this shop's. The spends are not kept
// separately: a spend IS a tender on a saved sale, so they are read back from the sale log at boot and noted as each new
// sale is saved — there is no hold that could be orphaned and nothing that could disagree with the sale log.
//
// A sale that spends is decided and saved one at a time on this box (`serialise`), so two tills on the same box cannot
// both spend the same last hundred points between the check and the disk.

import { open, readFile, rename } from 'node:fs/promises';
import { join } from 'node:path';
import {
  assessTillSpend, walletAvailable, readWalletFeed, spendsOfSaleRecord,
  type WalletFeed, type LocalSpend, type WalletAvailability, type TillSpendRefusal,
} from '../../../packages/loyalty/src/wallet';

const FILE = 'loyalty-wallets.json';
const TEMP = 'loyalty-wallets.json.tmp';

export interface HeldWalletFeed {
  readonly tenantId: string;
  readonly feed: WalletFeed;
  /** The box's clock when it took the copy. */
  readonly receivedAt: string;
}

export type SpendCheck =
  | { readonly ok: true; readonly record: Record<string, unknown>; readonly spends: readonly LocalSpend[] }
  | { readonly ok: false; readonly refusedBecause: TillSpendRefusal; readonly laneMessage: string };

export class LoyaltyWallets {
  private held: HeldWalletFeed | undefined;
  private readonly spends: LocalSpend[];
  private queue: Promise<unknown> = Promise.resolve();

  private constructor(private readonly dataDir: string, readonly tenantId: string, held: HeldWalletFeed | undefined, spends: readonly LocalSpend[]) {
    this.held = held;
    this.spends = [...spends];
  }

  /** Restore the copy from disk and the spends from the saved sales (each a raw sale-log record). */
  static async open(input: { readonly dataDir: string; readonly tenantId: string; readonly saleRecords: readonly string[] }): Promise<LoyaltyWallets> {
    let held: HeldWalletFeed | undefined;
    try {
      const raw = JSON.parse(await readFile(join(input.dataDir, FILE), 'utf8')) as { tenantId?: unknown; feed?: unknown; receivedAt?: unknown };
      const feed = readWalletFeed(raw.feed);
      if (raw.tenantId === input.tenantId && feed !== undefined && feed.tenantId === input.tenantId && typeof raw.receivedAt === 'string') {
        held = { tenantId: input.tenantId, feed, receivedAt: raw.receivedAt };
      }
    } catch {
      held = undefined; // missing or torn — nothing to restore, and the till says so
    }
    const spends = input.saleRecords.flatMap((rec) => {
      try { return [...spendsOfSaleRecord(JSON.parse(rec) as unknown)]; } catch { return []; }
    });
    return new LoyaltyWallets(input.dataDir, input.tenantId, held, dedupe(spends));
  }

  heldFeed(): WalletFeed | undefined { return this.held?.feed; }
  heldCopy(): HeldWalletFeed | undefined { return this.held; }

  /** Take a newer copy: on disk (temp, fsync, rename) before it is believed. */
  async takeFeed(feed: WalletFeed, receivedAt: string): Promise<void> {
    const held: HeldWalletFeed = { tenantId: this.tenantId, feed, receivedAt };
    const tempPath = join(this.dataDir, TEMP);
    const handle = await open(tempPath, 'w');
    try {
      await handle.write(`${JSON.stringify(held)}\n`);
      await handle.sync();
    } finally {
      await handle.close();
    }
    await rename(tempPath, join(this.dataDir, FILE));
    this.held = held;
  }

  availability(memberRef: string, tradingDay: string): WalletAvailability {
    return walletAvailable({ feed: this.held?.feed, memberRef, localSpends: this.spends, tradingDay });
  }

  /**
   * Decide the spend tenders on a sale record (the member code already swapped in) and stamp each points tender with
   * the whole points it takes, so head office burns exactly what the customer was told. A record with no spend tender
   * comes back untouched.
   */
  check(record: Record<string, unknown>): SpendCheck {
    const tenders = Array.isArray(record['tenders']) ? record['tenders'] as unknown[] : [];
    const read = tenders.map((t) => {
      const r = (t !== null && typeof t === 'object' ? t : {}) as Record<string, unknown>;
      const amountMinor = typeof r['amountMinor'] === 'number' ? r['amountMinor']
        : r['amount'] !== null && typeof r['amount'] === 'object' && typeof (r['amount'] as Record<string, unknown>)['minor'] === 'number'
          ? (r['amount'] as Record<string, number>)['minor']! : NaN;
      return { kind: typeof r['kind'] === 'string' ? r['kind'] : '', amountMinor };
    });
    const saleId = typeof record['id'] === 'string' ? record['id'] : '';
    const tradingDay = typeof record['tradingDay'] === 'string' ? record['tradingDay'] : '';
    const memberRef = typeof record['customerRef'] === 'string' ? record['customerRef'] : undefined;
    const decided = assessTillSpend({ feed: this.held?.feed, saleId, memberRef, tenders: read, localSpends: this.spends, tradingDay });
    if (!decided.ok) return decided;
    if (decided.spends.length === 0) return { ok: true, record, spends: [] };
    const value = this.held!.feed.rule.pointValuePaise;
    const stamped = tenders.map((t, i) => (read[i]!.kind === 'loyalty_points' && t !== null && typeof t === 'object'
      ? { ...(t as Record<string, unknown>), points: read[i]!.amountMinor / value }
      : t));
    return { ok: true, record: { ...record, tenders: stamped }, spends: decided.spends };
  }

  /** The spends of a sale now on the disk. A re-sent sale's spends are already here and are not added twice. */
  note(spends: readonly LocalSpend[]): void {
    for (const s of spends) if (!this.spends.some((x) => x.ref === s.ref)) this.spends.push(s);
  }

  /** Run a spend's decide-and-save alone on this box. */
  serialise<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.queue.then(fn, fn);
    this.queue = run.catch(() => undefined);
    return run;
  }
}

const dedupe = (spends: readonly LocalSpend[]): LocalSpend[] => {
  const seen = new Map<string, LocalSpend>();
  for (const s of spends) if (!seen.has(s.ref)) seen.set(s.ref, s);
  return [...seen.values()];
};
