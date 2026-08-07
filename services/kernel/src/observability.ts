// Observability implementations for the kernel's `observe` port (Phase 2, NFR §10).
//
// The pipeline produces a `RequestObservation` per request and knows nothing about where it goes.
// These are the sinks a deployment wires: a structured JSON logger, an in-memory metrics register
// (request count, latency, status class, per route), and a fan-out that lets one request feed both.
// Provider-neutral (P-06): swapping to a real log/metrics/trace backend is a change to the wiring in
// `main()`, not to any handler.

import type { RequestObservation } from './pipeline';

export type Observer = (o: RequestObservation) => void;

/**
 * A structured, one-line-per-request JSON logger. `write` receives a single JSON string (no trailing
 * newline) — hand it `(line) => process.stdout.write(line + '\n')`, or a real log shipper. Server
 * errors log at `error`, everything else at `info`; the correlation id is on every line.
 */
export function structuredLogger(write: (line: string) => void, clock: () => string = () => new Date().toISOString()): Observer {
  return (o) => write(JSON.stringify({
    at: clock(),
    level: o.outcome === 'server_error' ? 'error' : 'info',
    msg: 'request',
    traceId: o.traceId,
    correlationId: o.correlationId,
    method: o.method,
    route: o.route ?? o.path,
    status: o.status,
    outcome: o.outcome,
    tenantId: o.tenantId,
    userId: o.userId,
    permission: o.permission,
    durationMs: o.durationMs,
  }));
}

/** Fan one observation out to several sinks (logger + metrics + tracer). */
export function combineObservers(...observers: readonly Observer[]): Observer {
  return (o) => { for (const obs of observers) obs(o); };
}

export interface RouteMetric {
  readonly count: number;
  readonly errors: number;
  readonly totalMs: number;
  readonly maxMs: number;
}

export interface MetricsSnapshot {
  readonly totalRequests: number;
  /** Counts keyed '2xx' / '4xx' / '5xx' etc. */
  readonly byStatusClass: Readonly<Record<string, number>>;
  /** Per "METHOD route" — count, error count, summed and max latency (avg is totalMs/count). */
  readonly byRoute: Readonly<Record<string, RouteMetric>>;
}

/**
 * Process-local request metrics — the default sink, and a real one (not a test double): metrics are
 * ephemeral by design, scraped continuously from `/metricz` per instance, and reset on restart the
 * way any counter does. Counts every request by status class and by route, and tracks summed and max
 * latency so an average and a worst-case are both available. A Prometheus/OTel exporter is a drop-in
 * replacement for the same `observe` port.
 */
export class RequestMetrics {
  private total = 0;
  private readonly statusClass = new Map<string, number>();
  private readonly routes = new Map<string, { count: number; errors: number; totalMs: number; maxMs: number }>();

  /** Pass this straight to `observe` (bound). */
  readonly record: Observer = (o) => {
    this.total += 1;
    const cls = `${Math.floor(o.status / 100)}xx`;
    this.statusClass.set(cls, (this.statusClass.get(cls) ?? 0) + 1);
    const key = `${o.method} ${o.route ?? o.path}`;
    const r = this.routes.get(key) ?? { count: 0, errors: 0, totalMs: 0, maxMs: 0 };
    r.count += 1;
    if (o.status >= 400) r.errors += 1;
    r.totalMs += o.durationMs;
    r.maxMs = Math.max(r.maxMs, o.durationMs);
    this.routes.set(key, r);
  };

  snapshot(): MetricsSnapshot {
    return {
      totalRequests: this.total,
      byStatusClass: Object.fromEntries(this.statusClass),
      byRoute: Object.fromEntries(this.routes),
    };
  }
}
