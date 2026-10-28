// The ops-alert worker (audit PA-12 round 4 · M35-FR-01/03/04 · §32 · P-03 control by exception · P-08 · hard rule #6).
//
// The pieces were all there — alert rules naming who owns each component, the observed signals (sync, queues, dead
// letters, backups), a durable raise / acknowledge / escalate lifecycle — but every step waited for somebody to call
// a route. A failed backup at 02:00 reached nobody until a person thought to ask. This worker runs in the head-office
// process, on its own timer, for every shop that has alert rules:
//
//   1. RAISE — judge the shop's observed health (the SAME `raiseObservedAlerts` the raise route runs) and persist each
//      firing alert to its named owner; mark cleared (kept, never deleted) an alert whose condition has gone, so a
//      recurrence is a new occurrence that is delivered again;
//   2. ESCALATE — the SAME sweep the escalate route runs: an alert its owner has not acknowledged in time goes to the
//      person named above them;
//   3. DELIVER — every open alert to its owner, every escalated alert to the person it was escalated to: a `notified`
//      fact into that person's own inbox (`GET /v1/platform/alerts/inbox`) and, when a message provider is configured,
//      a message to them (idempotent on alert × occurrence × stage × person; a failed message is retried next pass).
//      OB-439: the message is in THAT person's language — the English/Tamil choice on their staff record
//      (`alertLanguageOf`), English when none is set — one language per message, never both. The idempotency key does not
//      change with the language: one delivery per alert × occurrence × revision × stage × person, exactly as before.
//
// Sequential and restart-safe like the notification worker: it holds nothing of its own — every step is an
// append-only fact, so after a restart it carries on from the ledger. A pass that throws for one shop is said and the
// loop carries on (a dead alert loop is exactly the silent failure P-08 forbids). No AI acts here (hard rule #5).

import type { NotificationTransport } from '../../../packages/notifications/src/index';
import { alertMessage, languageOrEnglish } from '../../../packages/ops/src/index';
import { escalateDueAlerts, type AlertLifecycleDeps, type LiveAlert } from './alert-lifecycle';
import { raiseObservedAlerts, type ObservedHealthDeps } from './observed-health';

export const OPS_ALERT_WORKER = 'system:ops-alert-worker';

export interface OpsAlertPass {
  readonly at: string;
  readonly tenants: number;
  readonly raised: number;
  /** §31.1 · OB-414: open alerts of head office's own rules whose subject changed — updated and sent again this pass. */
  readonly updated?: number;
  readonly cleared: number;
  readonly escalated: number;
  readonly delivered: number;
  readonly failed: readonly { readonly tenantId: string; readonly error: string }[];
  /** Round 29 · OB-106: shops whose store computer checks were being prepared — skipped this pass (their alerts kept), said. */
  readonly skipped: readonly { readonly tenantId: string; readonly why: string }[];
}

export interface OpsAlertWorker {
  runOnce(): Promise<OpsAlertPass>;
  readonly passes: readonly OpsAlertPass[];
  total(): number;
  stop(): Promise<void>;
}

/** Who must hear about an alert now, and at which stage. */
function recipientsOf(a: LiveAlert): readonly { readonly to: string; readonly stage: 'raised' | 'escalated' }[] {
  // Round 34 · OB-114 / OB-124 (2): a built-in rule's alert goes to EVERY owner — its owner and each other one named on it.
  const owners = [a.alert.ownerUserId, ...(a.alert.alsoToUserIds ?? []).filter((u) => u !== a.alert.ownerUserId)].map((to) => ({ to, stage: 'raised' as const }));
  if (a.state === 'open') return owners;
  if (a.state === 'escalated') {
    return [
      ...owners,
      ...(a.escalatedTo !== undefined && a.escalatedTo !== '' ? [{ to: a.escalatedTo, stage: 'escalated' as const }] : []),
    ];
  }
  return [];
}

/** Deliver every open / escalated alert to the person it is for — inbox always, a message when a provider is set. */
export async function deliverAlerts(deps: AlertLifecycleDeps, tenantId: string, by: string, at: string, transport?: NotificationTransport, say: (line: string) => void = () => {}): Promise<number> {
  let delivered = 0;
  for (const a of await deps.alerts(tenantId)) {
    for (const { to, stage } of recipientsOf(a)) {
      const had = (via: string): boolean => a.deliveries.some((d) => d.to === to && d.stage === stage && d.via === via);
      // §31.1 · OB-414: an UPDATED alert is delivered again — each revision its own delivery (never twice the same one).
      const base = `notify-${a.alert.alertId}-o${a.occurrence}${a.revision === undefined ? '' : `-r${a.revision}`}-${stage}-${to}`;
      if (!had('inbox')) {
        await deps.recordAlertEvent(tenantId, { alertId: a.alert.alertId, change: 'notified', by, at, notifiedTo: to, via: 'inbox', stage }, `${base}-inbox`);
        delivered += 1;
      }
      if (transport !== undefined && !had(transport.name)) {
        // OB-439: in the recipient's own language (English unless their staff record says Tamil).
        const lang = deps.alertLanguageOf === undefined ? 'en' : languageOrEnglish(await deps.alertLanguageOf(tenantId, to));
        const text = alertMessage(a.alert, stage, a.revision !== undefined, lang, { ackDueBy: a.alert.ackDueBy, ownerName: a.alert.ownerName });
        const sent = await transport.send({ messageId: `alert-${tenantId}-${base}`, channel: 'sms', customerId: to, text });
        if (sent.ok) {
          await deps.recordAlertEvent(tenantId, { alertId: a.alert.alertId, change: 'notified', by, at, notifiedTo: to, via: transport.name, stage, detail: sent.providerRef }, `${base}-${transport.name}`);
          delivered += 1;
        } else {
          say(`alerts: the message to ${to} about ${a.alert.alertId} did not go (${sent.reason}); it is in their inbox and the message is tried again next pass`);
        }
      }
    }
  }
  return delivered;
}

export function startOpsAlertWorker(input: {
  /** The shops with alert rules. */
  readonly tenants: () => Promise<readonly string[]>;
  readonly deps: ObservedHealthDeps & AlertLifecycleDeps;
  readonly transport?: NotificationTransport;
  readonly intervalMs: number;
  readonly now: () => string;
  readonly say: (line: string) => void;
  /**
   * Round 8 (M19-FR-04 · PA-08): further exception sweeps run on the same timer for each shop — e.g. delivery exceptions
   * past their time limit put on the message queue. Answers how many alerts it newly queued.
   */
  readonly alsoEachPass?: (tenantId: string, at: string) => Promise<number>;
}): OpsAlertWorker {
  const passes: OpsAlertPass[] = [];
  let total = 0;
  let stopping = false;
  let timer: NodeJS.Timeout | undefined;
  let running: Promise<OpsAlertPass> | undefined;

  const pass = async (): Promise<OpsAlertPass> => {
    const at = input.now();
    const failed: { tenantId: string; error: string }[] = [];
    const skipped: { tenantId: string; why: string }[] = [];
    let raised = 0; let updated = 0; let cleared = 0; let escalated = 0; let delivered = 0;
    let tenants: readonly string[] = [];
    try { tenants = await input.tenants(); } catch (e) { failed.push({ tenantId: '*', error: e instanceof Error ? e.message : String(e) }); }
    for (const tenantId of tenants) {
      try {
        const r = await raiseObservedAlerts(input.deps, tenantId, OPS_ALERT_WORKER, at, { clear: true });
        if (r !== undefined) { raised += r.newlyOpened; updated += r.updated; cleared += r.cleared; }
        // Round 29 · OB-106 (P-08): the store computer checks are being prepared — not frozen, not silent: said, and skipped.
        const preparing = r?.observed.storeComputersPreparing ?? null;
        if (preparing !== null) skipped.push({ tenantId, why: `the store computer checks are being prepared (since ${preparing.since}: ${preparing.why}); this pass skipped them and kept their open alerts as they were` });
        escalated += (await escalateDueAlerts(input.deps, tenantId, OPS_ALERT_WORKER, at)).length;
        delivered += await deliverAlerts(input.deps, tenantId, OPS_ALERT_WORKER, at, input.transport, input.say);
        if (input.alsoEachPass !== undefined) {
          const queued = await input.alsoEachPass(tenantId, at);
          if (queued > 0) input.say(`alerts: ${queued} delivery-exception alert(s) put on the message queue for shop ${tenantId}`);
        }
      } catch (e) {
        failed.push({ tenantId, error: e instanceof Error ? e.message : String(e) });
      }
    }
    const done: OpsAlertPass = { at, tenants: tenants.length, raised, ...(updated === 0 ? {} : { updated }), cleared, escalated, delivered, failed, skipped };
    passes.push(done);
    total += 1;
    if (passes.length > 50) passes.shift();
    if (raised + updated + cleared + escalated + delivered > 0) input.say(`alerts: ${raised} raised, ${updated === 0 ? '' : `${updated} updated, `}${escalated} escalated, ${delivered} delivered, ${cleared} cleared`);
    for (const f of failed) input.say(`alerts: the alert pass failed for shop ${f.tenantId}: ${f.error}. The next pass tries again.`);
    for (const k of skipped) input.say(`alerts: shop ${k.tenantId}: ${k.why}. The next pass tries again.`);
    return done;
  };

  const runOnce = async (): Promise<OpsAlertPass> => {
    while (running !== undefined) await running.catch(() => undefined);
    running = pass();
    try { return await running; } finally { running = undefined; }
  };
  const tick = async (): Promise<void> => {
    try { await runOnce(); } catch (e) { input.say(`alerts: an alert pass threw: ${e instanceof Error ? e.message : String(e)}`); }
    if (!stopping) timer = setTimeout(() => { void tick(); }, input.intervalMs);
  };
  timer = setTimeout(() => { void tick(); }, input.intervalMs);

  return {
    runOnce, passes, total: () => total,
    stop: async () => {
      stopping = true;
      if (timer !== undefined) clearTimeout(timer);
      if (running !== undefined) await running.catch(() => undefined);
    },
  };
}
