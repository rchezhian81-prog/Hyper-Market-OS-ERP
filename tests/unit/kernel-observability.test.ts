import { describe, it, expect } from 'vitest';
import {
  structuredLogger, combineObservers, RequestMetrics, type RequestObservation,
} from '../../services/kernel/src/index';
import { apiHarness } from '../support/api-harness';

// Observability (Phase 2, NFR §10): the kernel emits one RequestObservation per request into the
// `observe` port; structured logs, metrics and traces are all fed from it. Provider-neutral — these
// prove the default sinks and the pipeline wiring (correlation id honoured, one observation per
// request, status/outcome/duration correct).

const A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';

const OBS = (over: Partial<RequestObservation> = {}): RequestObservation => ({
  traceId: 't1', correlationId: 't1', method: 'GET', path: '/v1/x', route: '/v1/x',
  permission: 'x.read', status: 200, tenantId: A, userId: 'u', durationMs: 3, outcome: 'ok', ...over,
});

describe('structuredLogger', () => {
  it('emits one JSON line per observation with the correlation id and request facts', () => {
    const lines: string[] = [];
    const log = structuredLogger((l) => lines.push(l), () => '2026-01-01T00:00:00.000Z');
    log(OBS({ status: 403, outcome: 'client_error', durationMs: 7 }));
    expect(lines).toHaveLength(1);
    const parsed = JSON.parse(lines[0]!);
    expect(parsed).toMatchObject({
      at: '2026-01-01T00:00:00.000Z', level: 'info', msg: 'request',
      correlationId: 't1', method: 'GET', route: '/v1/x', status: 403, outcome: 'client_error',
      tenantId: A, userId: 'u', permission: 'x.read', durationMs: 7,
    });
  });

  it('logs a server error at error level', () => {
    const lines: string[] = [];
    structuredLogger((l) => lines.push(l))(OBS({ status: 500, outcome: 'server_error' }));
    expect(JSON.parse(lines[0]!).level).toBe('error');
  });
});

describe('combineObservers', () => {
  it('fans one observation out to every sink', () => {
    const a: RequestObservation[] = [];
    const b: RequestObservation[] = [];
    combineObservers((o) => a.push(o), (o) => b.push(o))(OBS());
    expect(a).toHaveLength(1);
    expect(b).toHaveLength(1);
  });
});

describe('RequestMetrics', () => {
  it('counts by status class and by route, and tracks summed and max latency', () => {
    const m = new RequestMetrics();
    m.record(OBS({ method: 'GET', route: '/v1/a', status: 200, durationMs: 10 }));
    m.record(OBS({ method: 'GET', route: '/v1/a', status: 200, durationMs: 30 }));
    m.record(OBS({ method: 'POST', route: '/v1/b', status: 403, durationMs: 5 }));
    const s = m.snapshot();
    expect(s.totalRequests).toBe(3);
    expect(s.byStatusClass).toEqual({ '2xx': 2, '4xx': 1 });
    expect(s.byRoute['GET /v1/a']).toEqual({ count: 2, errors: 0, totalMs: 40, maxMs: 30 });
    expect(s.byRoute['POST /v1/b']).toEqual({ count: 1, errors: 1, totalMs: 5, maxMs: 5 });
  });
});

describe('the pipeline feeds the observe port', () => {
  it('emits exactly one observation per request, with the route, status and outcome', async () => {
    const seen: RequestObservation[] = [];
    const h = apiHarness({ observe: (o) => seen.push(o) });
    await h.seedOwner(A, 'u-owner');

    await h.request({ method: 'GET', path: '/v1/identity/me', userId: 'u-owner', tenantId: A });
    expect(seen).toHaveLength(1);
    expect(seen[0]).toMatchObject({
      method: 'GET', route: '/v1/identity/me', permission: 'identity.self.read',
      status: 200, outcome: 'ok', tenantId: A, userId: 'u-owner',
    });
    expect(typeof seen[0]!.durationMs).toBe('number');
  });

  it('records a 404 as not_found with no route', async () => {
    const seen: RequestObservation[] = [];
    const h = apiHarness({ observe: (o) => seen.push(o) });
    await h.raw({ method: 'GET', path: '/v1/does-not-exist' });
    expect(seen[0]).toMatchObject({ status: 404, outcome: 'not_found' });
    expect(seen[0]!.route).toBeUndefined();
  });

  it('honours an inbound correlation id as the trace id and echoes it back', async () => {
    const seen: RequestObservation[] = [];
    const h = apiHarness({ observe: (o) => seen.push(o) });
    await h.seedOwner(A, 'u-owner');

    const res = await h.raw({
      method: 'GET', path: '/v1/identity/me',
      token: h.idp.issue({ sub: 'u-owner', tenantId: A }),
      headers: { 'x-correlation-id': 'corr-123' },
    });
    expect(res.status).toBe(200);
    expect(res.headers['x-correlation-id']).toBe('corr-123');
    expect(res.headers['x-trace-id']).toBe('corr-123');
    expect(seen[0]!.correlationId).toBe('corr-123');
    expect(seen[0]!.traceId).toBe('corr-123');
  });
});
