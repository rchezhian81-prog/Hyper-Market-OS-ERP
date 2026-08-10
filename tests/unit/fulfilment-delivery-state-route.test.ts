import { describe, it, expect } from 'vitest';
import { fulfilmentRoutes, type DeliveryAttempt, type FulfilmentDeps } from '../../services/fulfilment/src/index';
import type { DeliveryState } from '../../packages/fulfilment/src/index';
import type { RequestContext, Route } from '../../services/kernel/src/index';

// CORE-01 inc2: the running fulfilment service decides a recorded attempt's resulting delivery
// state with the tested `packages/fulfilment` state machine (transitionDelivery / isTerminalDelivery),
// not a second copy. The state machine's own transitions are pinned in tests/unit/delivery-route.test.ts;
// here we prove the running attempt route delegates to it.

const NOW = '2026-08-10T12:00:00Z';

const ctx = (body: unknown): RequestContext => ({
  tenantId: 'sre', userId: 'd-ravi', branchId: null, params: {}, query: {}, body, traceId: 't',
});

const post = (): Route => {
  const captured: DeliveryAttempt[] = [];
  const deps: FulfilmentDeps = {
    appendAttempt: (_t, a) => { captured.push(a); },
    attempts: () => [], assigned: () => [], now: () => NOW,
  };
  const r = fulfilmentRoutes(deps).find((x) => x.method === 'POST' && x.path === '/v1/delivery/attempts');
  if (r === undefined) throw new Error('no POST /v1/delivery/attempts');
  return r;
};

const attempt = (over: Partial<DeliveryAttempt> = {}): DeliveryAttempt => ({
  attemptId: 'A-1', orderId: 'O-1', driverId: 'd-ravi', attemptedAt: NOW,
  outcome: 'delivered', proofRef: 'sig-8891', ...over,
});

interface AttemptResponse { readonly deliveryState: DeliveryState; readonly final: boolean; readonly attemptId: string }

describe('POST /v1/delivery/attempts reports the delivery state from the tested engine', () => {
  it('a delivered attempt lands the order in a terminal `delivered` state', async () => {
    const res = await post().handler(ctx(attempt()));
    expect(res.status).toBe(201);
    const body = res.body as AttemptResponse;
    expect(body.deliveryState).toBe('delivered');
    expect(body.final).toBe(true); // delivered is terminal — nothing further to do
  });

  it('a failed attempt lands in a non-terminal `failed` state — reattemptable, not a silence', async () => {
    const res = await post().handler(ctx(attempt({ outcome: 'nobody_in', proofRef: undefined, notes: 'no answer at the door' })));
    const body = res.body as AttemptResponse;
    expect(body.deliveryState).toBe('failed');
    expect(body.final).toBe(false); // failed can still be reattempted or returned to origin
  });

  it('still refuses an invalid attempt before any state is computed (the existing guard holds)', async () => {
    // A delivered attempt with no proof is refused by checkAttempt — the engine wiring does not
    // paper over the refusal.
    await expect(post().handler(ctx(attempt({ proofRef: undefined })))).rejects.toMatchObject({ status: 422 });
  });
});
