// Refusals of callers nobody signed in as — COUNTED, not written one row each. Audit 27 Nov 2026 item 2 · hard rule 6 ·
// SEC-07 · NFR-15 · P-08.
//
// The kernel writes an audit row for every write and every refusal (pipeline.ts `writeAudit`). For a SIGNED-IN person that
// is exactly right: "who reached for a permission they do not hold" is the question the trail exists to answer. For a
// caller with no sign-in at all — a path that does not exist (404), a call that carried no token (401), a flood refused by
// the address limit (429) — one database write per request turns a flood of junk into a flood of writes, all serialised on
// the one 'unauthenticated' chain. So those are counted here instead:
//
//   • per (status, reason code, source network with its last part masked) per window (default 60 s);
//   • the FIRST refusal of each kind in each window is written AT ONCE, as an ordinary audit row — a crash can lose the
//     count of the rest, never the fact that it happened;
//   • the rest go as ONE row with the count when the window closes (or on `flush`, which the API calls on a timer and at
//     shutdown) — chained and append-only like every other audit row (hard rule 6: nothing is dropped; the count is the
//     evidence);
//   • the number of kinds held at once is capped: past the cap, refusals share one "other" count per status and reason, so
//     a flood from very many networks is still a handful of rows.
//
// What is NOT counted here (the pipeline still writes one row each): every refusal of a signed-in person, every refused
// sign-in (a credential presented and not believed — a failed login is evidence on its own: M02 "every login … audited",
// M34-FR-01; it is also kept per try on the shop's record, D13-FR-06, and bounded by the lockout), and every 5xx.
//
// The aggregate row uses the existing audit_log columns (no schema change): its `path` is a machine-readable line
// `/aggregate/unauthenticated-refusals?count=N&status=…&code=…&source=…&from=…&to=…&first=…` and its `permission` is
// `refusals.aggregate`; `parseRefusalTallyRow` reads it back.

import type { AuditSink } from './pipeline';
import type { Method } from './router';
import { sourceOf } from './sign-in-attempts';

/** One refusal of a caller who is not signed in, as the pipeline hands it over. */
export interface UnauthenticatedRefusal {
  readonly status: number;
  /** The machine code of the refusal (`not_found`, `unauthenticated`, `rate_limited`, `too_many_sign_in_attempts`, …). */
  readonly code: string;
  readonly method: Method;
  readonly path: string;
  readonly permission: string;
  readonly traceId: string;
  readonly clientIp: string;
}

/** Where the pipeline hands an anonymous refusal instead of writing an audit row for it. */
export interface RefusalTally {
  count(refusal: UnauthenticatedRefusal): Promise<void> | void;
}

export interface RefusalTallyConfig {
  /** How long one count runs before its row is written. */
  readonly windowSeconds: number;
  /** The most kinds (status · reason · network) counted separately at once; past it, one "other" count per status · reason. */
  readonly maxKeys: number;
}

export const REFUSAL_AGGREGATE_PERMISSION = 'refusals.aggregate';
const AGGREGATE_PATH = '/aggregate/unauthenticated-refusals';

interface Held {
  readonly status: number; readonly code: string; readonly source: string;
  readonly firstMethod: Method; readonly firstPath: string; readonly firstTraceId: string;
  /** Refusals seen this window, and how many of them are already on the record. */
  seen: number; written: number;
}

/** The in-process tally over the audit sink. Deterministic under an injected clock. */
export class AuditedRefusalTally implements RefusalTally {
  private held = new Map<string, Held>();
  private windowStartMs: number | undefined;
  private flushing: Promise<void> = Promise.resolve();

  constructor(
    private readonly sink: AuditSink,
    private readonly config: RefusalTallyConfig,
    private readonly now: () => number = () => Date.now(),
  ) {}

  async count(r: UnauthenticatedRefusal): Promise<void> {
    const nowMs = this.now();
    if (this.windowStartMs !== undefined && nowMs - this.windowStartMs >= this.config.windowSeconds * 1000) await this.flush();
    this.windowStartMs ??= nowMs;
    const source = sourceOf(r.clientIp).sourceNetwork;
    let key = `${r.status}|${r.code}|${source}`;
    let entry = this.held.get(key);
    if (entry === undefined && this.held.size >= this.config.maxKeys) {
      key = `${r.status}|${r.code}|other`;
      entry = this.held.get(key);
    }
    if (entry !== undefined) { entry.seen += 1; return; }
    const fresh: Held = {
      status: r.status, code: r.code, source: key.endsWith('|other') ? 'other' : source,
      firstMethod: r.method, firstPath: r.path.slice(0, 200), firstTraceId: r.traceId.slice(0, 80), seen: 1, written: 0,
    };
    this.held.set(key, fresh);
    // The first of each kind, at once — the ordinary row the pipeline would have written.
    fresh.written = 1;
    await this.sink.record({
      tenantId: 'unauthenticated', userId: 'unauthenticated', method: r.method, path: r.path, status: r.status,
      traceId: r.traceId, permission: r.permission,
    });
  }

  /** Write one row per kind for the refusals not yet on the record, and start a new window. Safe to call at any time. */
  flush(): Promise<void> {
    const run = this.flushing.then(async () => {
      const ended = this.held;
      const from = this.windowStartMs ?? this.now();
      const to = this.now();
      this.held = new Map();
      this.windowStartMs = undefined;
      for (const e of ended.values()) {
        const rest = e.seen - e.written;
        if (rest <= 0) continue;
        const q = new URLSearchParams({
          count: String(rest), status: String(e.status), code: e.code, source: e.source,
          from: new Date(from).toISOString(), to: new Date(to).toISOString(), first: `${e.firstMethod} ${e.firstPath}`,
        });
        await this.sink.record({
          tenantId: 'unauthenticated', userId: 'unauthenticated', method: e.firstMethod, path: `${AGGREGATE_PATH}?${q.toString()}`,
          status: e.status, traceId: `${e.firstTraceId}~agg`, permission: REFUSAL_AGGREGATE_PERMISSION,
        });
      }
    });
    this.flushing = run.catch(() => undefined);
    return run;
  }
}

/** What an aggregate row says, or undefined for an ordinary audit row (which stands for exactly one request). */
export interface RefusalTallyRow {
  readonly count: number; readonly status: number; readonly code: string; readonly source: string;
  readonly from: string; readonly to: string; readonly first: string;
}

export function parseRefusalTallyRow(row: { readonly path: string; readonly permission: string }): RefusalTallyRow | undefined {
  if (row.permission !== REFUSAL_AGGREGATE_PERMISSION || !row.path.startsWith(`${AGGREGATE_PATH}?`)) return undefined;
  const q = new URLSearchParams(row.path.slice(AGGREGATE_PATH.length + 1));
  const count = Number(q.get('count'));
  if (!Number.isInteger(count) || count < 1) return undefined;
  return {
    count, status: Number(q.get('status')), code: q.get('code') ?? '', source: q.get('source') ?? '',
    from: q.get('from') ?? '', to: q.get('to') ?? '', first: q.get('first') ?? '',
  };
}
