import { describe, it, expect } from 'vitest';
import {
  intend, attempt, drain, read,
  type Intent, type IntentQueue, type Transport,
} from '../../packages/api-client/src/index';

// §30 · §31.1 · §27.1 · P-01 · P-08 — the client every screen uses.
// The one rule: the idempotency key belongs to the DECISION, not to the attempt.

const NOW = '2026-08-07T12:00:00Z';

class Queue implements IntentQueue {
  readonly items = new Map<string, Intent>();
  enqueue(i: Intent): void { this.items.set(i.intentId, i); }
  pending(): readonly Intent[] { return [...this.items.values()]; }
  remove(id: string): void { this.items.delete(id); }
  bump(id: string): void {
    const i = this.items.get(id);
    if (i !== undefined) this.items.set(id, { ...i, attempts: i.attempts + 1 });
  }
}

/** Records every request it saw, and can be told how to answer. */
class Spy implements Transport {
  readonly seen: { method: string; path: string; key?: string; body: unknown }[] = [];
  constructor(private readonly reply: () => { status: number; body: unknown } | 'throw') {}
  async send(r: { method: string; path: string; headers: Readonly<Record<string, string>>; body?: unknown }) {
    this.seen.push({ method: r.method, path: r.path, key: r.headers['idempotency-key'], body: r.body });
    const answer = this.reply();
    if (answer === 'throw') throw new Error('offline');
    return answer;
  }
}

let n = 0;
const newId = () => `intent-${(n += 1)}`;

const sale = () => intend({
  method: 'POST', path: '/v1/sales', body: { saleId: 'S-1', totalMinor: 25_000 },
  newId, now: NOW,
});

describe('the idempotency key is minted with the decision, not the attempt', () => {
  it('carries ONE key across every attempt', async () => {
    // Generate it per attempt and a resent sale becomes a second sale — the server, doing
    // everything right, sees two different requests and banks both. Every server-side guarantee
    // is undone by a client that gets this wrong, and it is wrong by default.
    const intent = sale();
    let calls = 0;
    const transport = new Spy(() => { calls += 1; return calls < 3 ? { status: 503, body: {} } : { status: 202, body: { ok: true } }; });
    const queue = new Queue();

    await attempt({ intent, transport, token: 't', queue });
    await attempt({ intent, transport, token: 't', queue });
    const third = await attempt({ intent, transport, token: 't', queue });

    expect(third.kind).toBe('done');
    const keys = new Set(transport.seen.map((s) => s.key));
    expect(keys.size).toBe(1);
    expect([...keys][0]).toBe(intent.idempotencyKey);
  });

  it('gives two separate decisions two different keys', () => {
    expect(sale().idempotencyKey).not.toBe(sale().idempotencyKey);
  });

  it('derives the key from the intent id, so the queue and the request cannot disagree', () => {
    const i = sale();
    expect(i.idempotencyKey).toBe(i.intentId);
  });

  it('survives a restart, because the key is stored with the intent', async () => {
    const queue = new Queue();
    const intent = sale();
    const offline = new Spy(() => 'throw');
    await attempt({ intent, transport: offline, token: 't', queue });

    // The application restarts; only the queue survives.
    const restored = queue.pending()[0]!;
    const online = new Spy(() => ({ status: 202, body: {} }));
    await attempt({ intent: restored, transport: online, token: 't', queue });

    expect(online.seen[0]?.key).toBe(intent.idempotencyKey);
  });
});

describe('offline is queued, not failed (P-01)', () => {
  it('queues a write when there is no line, and says nothing is lost', async () => {
    const queue = new Queue();
    const r = await attempt({ intent: sale(), transport: new Spy(() => 'throw'), token: 't', queue });
    expect(r.kind).toBe('queued');
    expect(queue.pending()).toHaveLength(1);
    expect(r.kind === 'queued' && r.message).toContain('nothing is lost');
  });

  it('treats a 5xx exactly like no line, because that is what it is to the person', async () => {
    const queue = new Queue();
    const r = await attempt({ intent: sale(), transport: new Spy(() => ({ status: 503, body: {} })), token: 't', queue });
    expect(r.kind).toBe('queued');
    expect(queue.pending()[0]?.attempts).toBe(1);
  });

  it('removes an intent the server accepted', async () => {
    const queue = new Queue();
    const intent = sale();
    queue.enqueue(intent);
    await attempt({ intent, transport: new Spy(() => ({ status: 202, body: {} })), token: 't', queue });
    expect(queue.pending()).toHaveLength(0);
  });
});

describe('a decided refusal reaches the person, with whether it saved', () => {
  const refusal = (wasItSaved: 'saved' | 'not_saved' | 'unknown') => ({
    status: 422,
    body: {
      error: {
        code: 'price_above_mrp', whatHappened: 'This price is above the MRP.',
        wasItSaved, nextSafeAction: 'Fix the price and publish again.',
      },
    },
  });

  it('says plainly whether the data was saved', async () => {
    const queue = new Queue();
    for (const [state, words] of [
      ['not_saved', 'Nothing was saved.'],
      ['saved', 'Your data WAS saved.'],
      ['unknown', 'We do not know whether it saved.'],
    ] as const) {
      const r = await attempt({
        intent: sale(), transport: new Spy(() => refusal(state)), token: 't', queue,
      });
      expect(r.kind).toBe('refused');
      expect(r.kind === 'refused' && r.message).toContain(words);
      expect(r.kind === 'refused' && r.message).toContain('Fix the price and publish again.');
    }
  });

  it('does NOT keep retrying a decided refusal', async () => {
    // Resending it forever produces the same answer and buries everything behind it.
    const queue = new Queue();
    const intent = sale();
    queue.enqueue(intent);
    await attempt({ intent, transport: new Spy(() => refusal('not_saved')), token: 't', queue });
    expect(queue.pending()).toHaveLength(0);
  });

  it('still says something useful when the server sends no structured error', async () => {
    const queue = new Queue();
    const r = await attempt({
      intent: sale(), transport: new Spy(() => ({ status: 400, body: 'oops' })), token: 't', queue,
    });
    expect(r.kind === 'refused' && r.message).toContain('We do not know whether it saved.');
  });
});

describe('draining the queue', () => {
  it('sends oldest first, because a refund before its sale arrives at nothing', async () => {
    const queue = new Queue();
    queue.enqueue({ ...sale(), createdAt: '2026-08-07T10:00:00Z', path: '/v1/second' });
    queue.enqueue({ ...sale(), createdAt: '2026-08-07T09:00:00Z', path: '/v1/first' });

    const transport = new Spy(() => ({ status: 202, body: {} }));
    const r = await drain({ transport, token: 't', queue });

    expect(r.sent).toBe(2);
    expect(transport.seen.map((s) => s.path)).toEqual(['/v1/first', '/v1/second']);
  });

  it('stops at the first sign the line is still down rather than hammering it', async () => {
    const queue = new Queue();
    for (let i = 0; i < 5; i += 1) queue.enqueue(sale());
    const transport = new Spy(() => 'throw');
    const r = await drain({ transport, token: 't', queue });
    expect(transport.seen).toHaveLength(1);
    expect(r.stillQueued).toBe(5);
  });

  it('carries on past a refusal and reports it for a person', async () => {
    const queue = new Queue();
    queue.enqueue({ ...sale(), createdAt: '2026-08-07T09:00:00Z' });
    queue.enqueue({ ...sale(), createdAt: '2026-08-07T10:00:00Z' });
    let call = 0;
    const transport = new Spy(() => {
      call += 1;
      return call === 1
        ? { status: 422, body: { error: { code: 'x', whatHappened: 'Refused for a reason.', wasItSaved: 'not_saved', nextSafeAction: 'Look at it.' } } }
        : { status: 202, body: {} };
    });
    const r = await drain({ transport, token: 't', queue });
    expect(r.refused).toHaveLength(1);
    expect(r.sent).toBe(1);
  });
});

describe('reads fall back to the cache with their age shown', () => {
  const cacheOf = (seed?: { value: unknown; asAt: string }) => {
    const store = new Map<string, { value: unknown; asAt: string }>();
    if (seed !== undefined) store.set('/v1/reports/dashboard', seed);
    return {
      get: (p: string) => store.get(p) as { value: unknown; asAt: string } | undefined,
      put: (p: string, value: unknown, asAt: string) => { store.set(p, { value, asAt }); },
    };
  };

  it('returns live data and caches it', async () => {
    const cache = cacheOf();
    const r = await read({
      path: '/v1/reports/dashboard', transport: new Spy(() => ({ status: 200, body: { total: 1 } })),
      token: 't', cache, now: NOW,
    });
    expect(r?.fromCache).toBe(false);
    expect(r?.freshnessMessage).toBe('Up to date.');
    expect(cache.get('/v1/reports/dashboard')).toBeDefined();
  });

  it('shows the cache WITH ITS AGE when there is no line', async () => {
    // A screen that silently renders cached data is a screen somebody decides on an hour after
    // the line went down.
    const r = await read({
      path: '/v1/reports/dashboard', transport: new Spy(() => 'throw'), token: 't',
      cache: cacheOf({ value: { total: 1 }, asAt: '2026-08-07T11:30:00Z' }), now: NOW,
    });
    expect(r?.fromCache).toBe(true);
    expect(r?.freshnessMessage).toContain('30 minute(s) ago');
  });

  it('tells the reader to stop deciding on it once it is hours old', async () => {
    const r = await read({
      path: '/v1/reports/dashboard', transport: new Spy(() => 'throw'), token: 't',
      cache: cacheOf({ value: { total: 1 }, asAt: '2026-08-07T06:00:00Z' }), now: NOW,
    });
    expect(r?.freshnessMessage).toContain('6 hour(s) ago');
    expect(r?.freshnessMessage).toContain('Do not make a decision on these figures');
  });

  it('returns nothing rather than an empty shape when there is no cache either', async () => {
    const r = await read({
      path: '/v1/reports/dashboard', transport: new Spy(() => 'throw'), token: 't',
      cache: cacheOf(), now: NOW,
    });
    expect(r).toBeUndefined();
  });
});
