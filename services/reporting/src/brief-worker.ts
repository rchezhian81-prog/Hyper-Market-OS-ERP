// The owner's daily brief WORKER (audit EA-07 · M29-FR-04 · A01 · D13) — the producer that was missing: nothing ever
// called the brief's run route. This is a small in-process loop the head-office API starts when an operator names the
// shops it should brief (`BRIEF_WORKER_TENANT_IDS`): every tick it runs ONE scheduler pass per named shop
// (`runBriefPass`) — due by that shop's own trading calendar and clock, composed from governed figures with no AI,
// put on the PA-08 queue (the outbox), acknowledged only when the queue delivered it. The queue's own sender delivers.
//
// Shops are NAMED by the operator, never discovered: head office does not look across shops (OB-21). A tick that fails
// for one shop is reported and the others still run; the next tick tries again. Nothing here mints a token — the pass is
// a server-internal job recorded as `system:brief-worker`.

import { runBriefPass, type ScheduledBriefDeps, type BriefRunLine } from './scheduled-brief';

export const BRIEF_WORKER_ACTOR = 'system:brief-worker';

export interface BriefWorkerTick {
  readonly tenantId: string;
  readonly ok: boolean;
  readonly ran: readonly BriefRunLine[];
  readonly detail: string;
}

/** One tick: a pass for every named shop. A shop with no schedule is skipped and said; a failure never stops the rest. */
export async function briefWorkerTick(deps: ScheduledBriefDeps, tenants: readonly string[]): Promise<readonly BriefWorkerTick[]> {
  const out: BriefWorkerTick[] = [];
  for (const tenantId of tenants) {
    try {
      const pass = await runBriefPass(deps, tenantId, BRIEF_WORKER_ACTOR);
      out.push({ tenantId, ok: true, ran: pass.ran, detail: `${pass.ran.length} brief(s) due at the shop's ${pass.shopClock}` });
    } catch (e) {
      const code = (e as { body?: { code?: string } }).body?.code;
      out.push({ tenantId, ok: code === 'no_brief_schedule', ran: [], detail: code === 'no_brief_schedule' ? 'no brief schedule set — nothing due' : `the pass failed: ${code ?? (e instanceof Error ? e.message : String(e))} — the next tick tries again` });
    }
  }
  return out;
}

/** Start the loop. Returns a stop function. `report` receives every tick (the API prints the non-empty ones). */
export function startBriefWorker(input: {
  readonly deps: ScheduledBriefDeps;
  readonly tenants: readonly string[];
  readonly everyMs: number;
  readonly report: (ticks: readonly BriefWorkerTick[]) => void;
}): () => void {
  let running = false;
  let stopped = false;
  const tick = async (): Promise<void> => {
    if (running || stopped) return; // never two passes at once
    running = true;
    try { input.report(await briefWorkerTick(input.deps, input.tenants)); } finally { running = false; }
  };
  const timer = setInterval(() => { void tick(); }, input.everyMs);
  timer.unref?.();
  void tick();
  return () => { stopped = true; clearInterval(timer); };
}
