// The hallmark HUIDs this store computer has sold (roadmap v2.1 B13 · BIS IS 1417:2016 · OB-138 · hard rule #1).
//
// A hallmarked gold piece is sold ONCE: its HUID names that one piece. The till refuses a HUID already sold at the scan,
// with no network — so the box tells the served page which HUIDs it has sold — and the box refuses one again before its
// disk, whichever till sends it. Head office backstops at intake, for a HUID sold at another store.
//
// Built from this box's own sale log at start (the durable truth), and taught each sale as it commits. It only ever
// grows: a sale is never deleted (hard rule #2); a returned piece coming back into stock is a new decision for head
// office (a new product record), not an edit of this list.

const HUID = /^[A-Z0-9]{6}$/;

/** The HUIDs a sale record carries on its lines (`huid`), well-formed only. */
export function huidsOnRecord(record: string | Record<string, unknown>): readonly string[] {
  let parsed: unknown = record;
  if (typeof record === 'string') {
    try { parsed = JSON.parse(record); } catch { return []; }
  }
  const lines = parsed !== null && typeof parsed === 'object' && Array.isArray((parsed as { lines?: unknown }).lines)
    ? ((parsed as { lines: unknown[] }).lines) : [];
  return lines.flatMap((l) => {
    const huid = l !== null && typeof l === 'object' ? (l as { huid?: unknown }).huid : undefined;
    return typeof huid === 'string' && HUID.test(huid) ? [huid] : [];
  });
}

export class SoldHuids {
  private readonly sold = new Map<string, string>();

  /** From the sale records on this box's disk, oldest first. */
  constructor(records: readonly string[] = []) {
    for (const r of records) this.note(r);
  }

  /** A sale committed to the disk: its HUIDs are sold. Never throws — the sale stands whatever this makes of it. */
  note(record: string): void {
    let saleId = '';
    try { const id = (JSON.parse(record) as { id?: unknown }).id; saleId = typeof id === 'string' ? id : ''; } catch { /* unread: no HUIDs */ }
    for (const huid of huidsOnRecord(record)) if (!this.sold.has(huid)) this.sold.set(huid, saleId);
  }

  has(huid: string): boolean {
    return this.sold.has(huid);
  }

  /** Every HUID sold, sorted — what the served till is told. */
  list(): readonly string[] {
    return [...this.sold.keys()].sort();
  }

  asSet(): ReadonlySet<string> {
    return new Set(this.sold.keys());
  }
}
