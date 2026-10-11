// The notification worker (audit PA-08 round 4 · M31-FR-03/04 · M32-FR-02 · P-08 · hard rule #6).
//
// The queue was durable and consent-checked, but nothing drained it unless a person called the drain route: a message
// to a customer went out only when somebody remembered to press a button. This is the sender that runs on its own, in
// the head-office process, for every shop: on a timer, one shop after another, it runs the SAME send pass the drain
// route runs (`drainNotificationQueue` — consent re-check, budget re-check, idempotent send, backoff, dead letter).
//
//   • SEQUENTIAL — the next pass is scheduled only after this one returns, so two passes never send the same message
//     twice in one process; the provider's idempotency key (the message id) covers a second instance.
//   • NEVER STOPS QUIETLY — a pass that throws for one shop is said (by shop, with the error) and the loop carries on
//     with the others and the next pass; a dead sender is a shop that silently stops telling its customers anything.
//   • RESTART-SAFE — it holds nothing of its own: every outcome is an append-only fact, so after a restart it picks up
//     exactly where the ledger says (pending items, attempt counts, backoff, budget spent).
//
// Started by `startApi` only when a message provider is configured; with none (today: the SMS provider is release R4,
// OB-29, and every provider is an external gate) it says so at boot and messages stay queued, visible.

import type { DrainOutcome } from './notification-queue';

export interface NotificationWorkerPass {
  readonly at: string;
  readonly tenants: number;
  readonly delivered: number;
  readonly retrying: number;
  readonly deadLettered: number;
  readonly withheld: number;
  readonly held: number;
  /** Shops whose pass threw — named, never swallowed. */
  readonly failed: readonly { readonly tenantId: string; readonly error: string }[];
}

export interface NotificationWorker {
  /** Run one pass over every shop now (also what the timer runs). */
  runOnce(): Promise<NotificationWorkerPass>;
  /** The passes run so far (most recent last, the last 50) — for the operator and the tests. */
  readonly passes: readonly NotificationWorkerPass[];
  /** How many passes have finished since start. */
  total(): number;
  stop(): Promise<void>;
}

export function startNotificationWorker(input: {
  /** Every shop to drain (the tenant register). */
  readonly tenants: () => Promise<readonly string[]>;
  /** One shop's send pass. */
  readonly drain: (tenantId: string) => Promise<DrainOutcome>;
  readonly intervalMs: number;
  readonly now: () => string;
  readonly say: (line: string) => void;
}): NotificationWorker {
  const passes: NotificationWorkerPass[] = [];
  let total = 0;
  let stopping = false;
  let timer: NodeJS.Timeout | undefined;
  let running: Promise<NotificationWorkerPass> | undefined;

  const pass = async (): Promise<NotificationWorkerPass> => {
    const at = input.now();
    const failed: { tenantId: string; error: string }[] = [];
    const count = { delivered: 0, retrying: 0, deadLettered: 0, withheld: 0, held: 0 };
    let tenants: readonly string[] = [];
    try {
      tenants = await input.tenants();
    } catch (e) {
      failed.push({ tenantId: '*', error: e instanceof Error ? e.message : String(e) });
    }
    for (const tenantId of tenants) {
      try {
        const out = await input.drain(tenantId);
        for (const o of out.outcome) {
          if (o.result === 'delivered') count.delivered += 1;
          else if (o.result === 'retry_later') count.retrying += 1;
          else if (o.result === 'dead_lettered') count.deadLettered += 1;
          else if (o.result === 'withheld') count.withheld += 1;
          else if (o.result === 'held') count.held += 1;
        }
      } catch (e) {
        failed.push({ tenantId, error: e instanceof Error ? e.message : String(e) });
      }
    }
    const done: NotificationWorkerPass = { at, tenants: tenants.length, ...count, failed };
    passes.push(done);
    total += 1;
    if (passes.length > 50) passes.shift();
    if (count.delivered + count.retrying + count.deadLettered + count.withheld + count.held > 0) {
      input.say(`notifications: ${count.delivered} sent, ${count.retrying} to retry, ${count.deadLettered} needing a person, ${count.withheld} withheld (consent), ${count.held} held (budget)`);
    }
    for (const f of failed) input.say(`notifications: the send pass failed for shop ${f.tenantId}: ${f.error}. Everything is still queued; the next pass tries again.`);
    return done;
  };

  const runOnce = async (): Promise<NotificationWorkerPass> => {
    // One pass at a time: a manual run during a timed one waits for it rather than sending alongside it.
    while (running !== undefined) await running.catch(() => undefined);
    running = pass();
    try { return await running; } finally { running = undefined; }
  };

  const tick = async (): Promise<void> => {
    try { await runOnce(); } catch (e) { input.say(`notifications: a send pass threw: ${e instanceof Error ? e.message : String(e)}`); }
    if (!stopping) timer = setTimeout(() => { void tick(); }, input.intervalMs);
  };
  timer = setTimeout(() => { void tick(); }, input.intervalMs);

  return {
    runOnce,
    passes,
    total: () => total,
    stop: async () => {
      stopping = true;
      if (timer !== undefined) clearTimeout(timer);
      if (running !== undefined) await running.catch(() => undefined);
    },
  };
}
