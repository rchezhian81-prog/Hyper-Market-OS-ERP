// Alert lifecycle — raise, acknowledge, escalate over time (M35-FR-04 · API-11 · §32 · P-03 · P-08).
//
// `operational-health` computes the owned alerts a health check should raise, but it is STATELESS: every
// alert's acknowledgement deadline is, by construction, still in the future, so it cannot answer the other
// half of FR-04 — **an alert nobody acknowledges in time escalates to a named person.** That needs state
// held over time: an alert raised now, acknowledged (or not) later, and swept for escalation once its
// deadline has passed. This is that store, append-only (hard rule #2), folded latest-per-alert:
//
//   • RAISE — from the same health evidence the read takes ({signals, thresholds?, alertRules[]}), compute
//     the owned alerts (the tested `checkHealth`/`raiseAlerts`) and PERSIST each with its owner, its §32
//     acknowledgement deadline, and where it escalates to. A re-raise of an alert already open is the same
//     ongoing condition — it keeps the original deadline and acknowledgement, never resetting the clock.
//   • ACKNOWLEDGE — a NAMED person takes an open alert (P-04), which stops it escalating. Acknowledging an
//     alert nobody raised is refused (404).
//   • ESCALATE — the sweep: the tested `escalateUnacknowledged` finds every alert past its deadline that
//     nobody has acknowledged and routes it to the configured person; an alert with nobody above its owner
//     is reported as having nowhere to go (P-08), not silently dropped. Already-escalated alerts are left
//     alone, so the sweep is idempotent and re-running it never double-escalates.
//   • BOARD — every live alert with its state (open / acknowledged / escalated), the ones needing a look
//     first (control by exception, P-03).
//
//   • DELIVER (PA-12 round 4) — each raised alert reaches its NAMED owner, and an escalated one the person it was
//     escalated to: a `notified` fact per person and stage, into that person's own inbox (`GET …/alerts/inbox`) and,
//     when a message provider is configured, as a message to their phone. Recorded once; never deleted.
//   • CLEAR (PA-12 round 4) — when the condition is no longer observed, the alert is marked cleared (kept, with its
//     history); if it comes back it is a NEW occurrence — a fresh deadline, unacknowledged, delivered again — so an
//     alert acknowledged last week cannot swallow this week's failed backup.
//
//   • RESERVED NAMES (round 33 · owner decision OB-119 "A", 15 Oct 2026, in writing, "Reserve name, only you tick"; verifier
//     r32 NEW-1, NEW-2) — every alert id under `built-in:` (the built-in rules) and `notice:` (the notices the owner gets when
//     a built-in rule changes) is head office's own. Nobody raises one by hand: POST …/alerts/raise refuses a rule naming
//     one, by name (403 `built_in_alert_id_reserved`, on the audit trail); only the ops-alert worker raises a built-in alert
//     (and the alert-rules save raises its notice), each raise marked `origin: 'built-in-rule'`. Only the shop's OWNER may
//     acknowledge (tick as seen) one: the IT/platform administrator is refused by name
//     (`built_in_alert_acknowledge_refused_to_platform_administrator`, as OB-91), everyone else too
//     (`built_in_alert_acknowledge_owner_only`). An open alert under a reserved id that was NOT raised by the rule (one
//     planted before this rule) is FOREIGN: the rule's own raise never collapses into it — it opens a new occurrence, to
//     the owner, delivered again — and a foreign re-raise never re-points the rule's own alert.
//
// Writes gated `platform.alert.manage`; the board reads `platform.health.read`. No business transaction is
// posted here (§28); no AI acknowledges or escalates anything (hard rule #5). Nothing here deletes an alert (#6).

import type { Route } from '../../kernel/src/index';
import { apiError } from '../../kernel/src/index';
import {
  checkHealth, raiseAlerts, escalateUnacknowledged, type RaisedAlert, type AlertRule,
} from '../../../packages/ops/src/index';
import { readSignals, readThresholds, readRules } from './operational-health';
import { alertDisplay, type AlertText, type AlertDisplay } from '../../../packages/ops/src/index';

/** One append-only fact about an alert. `change` says which; the extra fields carry its detail. */
export interface AlertLifecycleEvent {
  readonly alertId: string;
  /**
   * §31.1 · OB-414: `updated` — head office's own rule changed what an OPEN alert covers (`alert.members`, e.g. the stores
   * whose clocks hold new prices): the alert's words are replaced, it asks to be ticked again, and it is sent again. The
   * same alert and occurrence; the earlier words and any earlier tick stay on the log (append-only).
   */
  readonly change: 'raised' | 'acknowledged' | 'escalated' | 'notified' | 'cleared' | 'updated';
  /** Who caused it — the raiser, the acknowledger, or the sweeper (P-04). */
  readonly by: string;
  readonly at: string;
  /** `raised` / `updated` — the owned alert with its owner and deadline. */
  readonly alert?: RaisedAlert;
  /** `raised` only — where this alert escalates to if it goes unacknowledged. */
  readonly escalatesToUserId?: string;
  /** `escalated` only — who it went to, and why. */
  readonly escalatedTo?: string;
  readonly detail?: string;
  /**
   * OB-435: `detail`, structured — rendered in English into `detail` (word for word what it always said) and in Tamil for
   * a Tamil reader. Absent on a fact recorded before OB-435: that one reads in English, as it was recorded.
   */
  readonly detailText?: AlertText;
  /** `notified` only — who was told, how (`inbox` or the message provider's name), and at which stage. */
  readonly notifiedTo?: string;
  readonly via?: string;
  readonly stage?: 'raised' | 'escalated';
  /**
   * Round 33 · OB-119: `raised` only — set when head office's own rule raised it (the ops-alert worker's built-in rule, or
   * the owner's notice of a built-in rule change). A raise under a reserved id without it is foreign (see the header).
   */
  readonly origin?: 'built-in-rule';
}

/** Round 33 · OB-119: the alert-id namespaces only head office's own rules raise under (built-in rules and their notices). */
export const RESERVED_ALERT_ID_PREFIXES: readonly string[] = ['built-in:', 'notice:'];
/** Round 33 · OB-119: is this alert id one only head office's own rules may raise (and only the owner may acknowledge)? */
export function isReservedAlertId(alertId: string): boolean {
  return RESERVED_ALERT_ID_PREFIXES.some((p) => alertId.startsWith(p));
}

export type AlertState = 'open' | 'acknowledged' | 'escalated' | 'cleared';

/** One delivery of an alert to a person (PA-12). */
export interface AlertDelivery {
  readonly to: string;
  readonly via: string;
  readonly stage: 'raised' | 'escalated';
  readonly at: string;
}

/** A live alert — the fold of its history to now. */
export interface LiveAlert {
  readonly alert: RaisedAlert;
  readonly state: AlertState;
  readonly escalatesToUserId?: string;
  readonly acknowledgedBy?: string;
  readonly acknowledgedAt?: string;
  readonly escalatedTo?: string;
  readonly escalatedAt?: string;
  readonly escalationDetail?: string;
  /** OB-435: the escalation's words, structured (absent: recorded before OB-435 — English only). */
  readonly escalationText?: AlertText;
  /** Every delivery of THIS occurrence to a person (PA-12). */
  readonly deliveries: readonly AlertDelivery[];
  /** When the condition was last seen to have cleared (this occurrence), if it has. */
  readonly clearedAt?: string;
  /** How many times this alert has opened (1 = first). */
  readonly occurrence: number;
  /**
   * Round 33 · OB-119: this occurrence is under a reserved id but was NOT raised by head office's own rule (planted before the
   * name was reserved). The rule's own raise opens a new occurrence over it rather than collapsing into it.
   */
  readonly foreign?: true;
  /**
   * §31.1 · OB-414: how many times this occurrence was UPDATED (what it covers changed while open) — each is sent again.
   * Absent: never updated.
   */
  readonly revision?: number;
  /** §31.1 · OB-414: when it was last updated (absent: never). */
  readonly updatedAt?: string;
}

interface MutableAlert {
  alert: RaisedAlert; escalatesToUserId?: string; foreign?: true; revision?: number; updatedAt?: string;
  acknowledgedBy?: string; acknowledgedAt?: string;
  escalatedTo?: string; escalatedAt?: string; escalationDetail?: string; escalationText?: AlertText;
  deliveries: AlertDelivery[]; clearedAt?: string; occurrence: number;
}

/** OB-435: an event's words — the English `detail` and its structured `detailText` — from `told(...)`. */
export function eventWords(w: { readonly detail: string; readonly text: AlertText }): { readonly detail: string; readonly detailText: AlertText } {
  return { detail: w.detail, detailText: w.text };
}

/**
 * OB-435 · OB-439: an alert as a screen reads it — its own fields, and its words in BOTH languages (`words.en`,
 * `words.ta`: the component, the status, the detail and any escalation), so a screen shows it in the language its button
 * is on. An alert recorded before OB-435 reads in English in both (`words.englishOnly`), exactly as it was recorded.
 */
export function withWords<T extends LiveAlert>(a: T): T & { readonly words: AlertDisplay } {
  return { ...a, words: alertDisplay(a.alert, a.escalationDetail === undefined ? undefined : { detail: a.escalationDetail, ...(a.escalationText === undefined ? {} : { text: a.escalationText }) }) };
}

/**
 * Fold the append-only log to the CURRENT set of alerts — one per id. A re-raise of a known id is the same
 * ongoing condition, so its ORIGINAL deadline and acknowledgement survive (only the escalation target is
 * refreshed). An acknowledge/escalate for an id never raised is ignored — no phantom alert, the same way the
 * device registry ignores a stray status for an unregistered device.
 */
export function projectAlerts(events: readonly AlertLifecycleEvent[]): readonly LiveAlert[] {
  const byId = new Map<string, MutableAlert>();
  for (const e of events) {
    if (e.change === 'raised') {
      if (e.alert === undefined) continue;
      const existing = byId.get(e.alertId);
      // Round 33 · OB-119: under a reserved id, a raise not made by head office's own rule is foreign.
      const foreign = isReservedAlertId(e.alertId) && e.origin !== 'built-in-rule';
      if (existing === undefined || existing.clearedAt !== undefined || (existing.foreign === true && !foreign)) {
        // First raise, or the condition came BACK after it cleared: a new occurrence — fresh deadline, nobody has
        // acknowledged it yet, and it is delivered again. The earlier occurrence stays on the ledger. Round 33 · OB-119: the
        // rule's own raise over a FOREIGN occurrence is a new occurrence too (to the rule's addressee, delivered again).
        byId.set(e.alertId, {
          alert: e.alert, deliveries: [], occurrence: (existing?.occurrence ?? 0) + 1,
          ...(e.escalatesToUserId !== undefined ? { escalatesToUserId: e.escalatesToUserId } : {}),
          ...(foreign ? { foreign: true as const } : {}),
        });
      } else if (foreign && existing.foreign !== true) {
        // Round 33 · OB-119: a foreign re-raise never re-points the rule's own open alert.
        continue;
      } else {
        // Ongoing condition: keep the first deadline and any acknowledgement; refresh only the escalation target.
        existing.escalatesToUserId = e.escalatesToUserId;
      }
      continue;
    }
    const a = byId.get(e.alertId);
    if (a === undefined) continue; // no phantom alert
    if (e.change === 'updated') {
      // §31.1 · OB-414: only head office's own rule updates, only an occurrence still open, and only one it raised itself.
      if (e.alert === undefined || e.origin !== 'built-in-rule' || a.clearedAt !== undefined || a.foreign === true) continue;
      // The new words and deadline (the first raise time kept); asked to be ticked again; delivered again to everyone.
      a.alert = { ...e.alert, raisedAt: a.alert.raisedAt };
      delete a.acknowledgedBy; delete a.acknowledgedAt;
      a.deliveries = [];
      a.revision = (a.revision ?? 0) + 1;
      a.updatedAt = e.at;
      continue;
    }
    if (e.change === 'acknowledged') {
      a.acknowledgedBy = e.by;
      a.acknowledgedAt = e.at;
    } else if (e.change === 'notified') {
      if (e.notifiedTo !== undefined) a.deliveries.push({ to: e.notifiedTo, via: e.via ?? 'inbox', stage: e.stage ?? 'raised', at: e.at });
    } else if (e.change === 'cleared') {
      a.clearedAt = e.at;
    } else { // escalated
      a.escalatedTo = e.escalatedTo ?? '';
      a.escalatedAt = e.at;
      a.escalationDetail = e.detail;
      if (e.detailText !== undefined) a.escalationText = e.detailText;
    }
  }
  return [...byId.values()].map((a) => ({
    alert: a.alert,
    // Acknowledged wins over escalated: once a named person has taken it, it is theirs and stops asking (PA-12).
    state: a.clearedAt !== undefined ? 'cleared' as const : a.acknowledgedAt !== undefined ? 'acknowledged' as const : a.escalatedAt !== undefined ? 'escalated' as const : 'open' as const,
    deliveries: a.deliveries, occurrence: a.occurrence,
    ...(a.foreign === true ? { foreign: true as const } : {}),
    ...(a.revision !== undefined ? { revision: a.revision } : {}),
    ...(a.updatedAt !== undefined ? { updatedAt: a.updatedAt } : {}),
    ...(a.clearedAt !== undefined ? { clearedAt: a.clearedAt } : {}),
    ...(a.escalatesToUserId !== undefined ? { escalatesToUserId: a.escalatesToUserId } : {}),
    ...(a.acknowledgedBy !== undefined ? { acknowledgedBy: a.acknowledgedBy } : {}),
    ...(a.acknowledgedAt !== undefined ? { acknowledgedAt: a.acknowledgedAt } : {}),
    ...(a.escalatedTo !== undefined ? { escalatedTo: a.escalatedTo } : {}),
    ...(a.escalatedAt !== undefined ? { escalatedAt: a.escalatedAt } : {}),
    ...(a.escalationDetail !== undefined ? { escalationDetail: a.escalationDetail } : {}),
    ...(a.escalationText !== undefined ? { escalationText: a.escalationText } : {}),
  }));
}

export interface AlertLifecycleDeps {
  /** The current set of live alerts, folded from the append-only log (survives restart). */
  readonly alerts: (tenantId: string) => Promise<readonly LiveAlert[]> | readonly LiveAlert[];
  /** Append one alert fact. Idempotent on the key. */
  readonly recordAlertEvent: (tenantId: string, event: AlertLifecycleEvent, key: string) => Promise<void> | void;
  readonly now: () => string;
  /**
   * Round 33 · OB-119: may this person acknowledge an alert under a reserved id — do they hold the owner role — and do they
   * hold the IT/platform administration function (said by name when refused, as OB-91). Absent: nobody may (fail closed).
   */
  readonly builtInAlertAuthorityOf?: (tenantId: string, userId: string) => Promise<{ readonly owner: boolean; readonly platformAdministration: boolean }>;
  /**
   * OB-439: the language a person's alert text messages go in — the English/Tamil choice on their staff record. A person
   * with no choice recorded (or not on the staff list) is English. Absent: every message is English.
   */
  readonly alertLanguageOf?: (tenantId: string, userId: string) => Promise<'en' | 'ta'> | 'en' | 'ta';
}

/** Round 33 · OB-119: the refusal of a hand-raised alert (or a hand-made rule) under a reserved id (403, on the audit trail). */
export function reservedAlertIdRefusal(alertIds: readonly string[]) {
  return apiError(403, {
    code: 'built_in_alert_id_reserved',
    whatHappened: `The alert id${alertIds.length === 1 ? '' : 's'} ${alertIds.join(', ')} ${alertIds.length === 1 ? 'is' : 'are'} reserved for head office's own built-in rules and the owner's notices (owner decision OB-119): ids starting ${RESERVED_ALERT_ID_PREFIXES.map((p) => `"${p}"`).join(' or ')} are raised only by head office's alert worker, to the shop's owner — never by hand, by anyone.`,
    wasItSaved: 'not_saved',
    nextSafeAction: 'Give your own rule an id of your own (not starting "built-in:" or "notice:"). Nothing was raised or saved.',
  });
}

// SEVERITY order for the board: worse first, then the soonest deadline. `unknown` sits above `ok`.
const SEVERITY: Record<string, number> = { down: 0, unknown: 1, degraded: 2, ok: 3 };

export function alertLifecycleRoutes(deps: AlertLifecycleDeps): readonly Route[] {
  return [
    {
      // RAISE — compute the owned alerts from the evidence, then persist each. Same body as the stateless
      // read (`/operational-health`), parsed by the same reader so the two can never disagree.
      api: 'API-11', method: 'POST', path: '/v1/platform/alerts/raise',
      permission: 'platform.alert.manage', idempotent: true,
      handler: async (ctx) => {
        const b = (ctx.body ?? {}) as Record<string, unknown>;
        const signals = readSignals(b['signals'] ?? {});
        const thresholds = readThresholds(b['thresholds']);
        const rules = readRules(b['alertRules']);
        if (signals === undefined || thresholds === undefined || rules === undefined) {
          throw apiError(400, {
            code: 'not_readable_as_health_evidence',
            whatHappened: 'Raising alerts needs { signals } and optional { thresholds, alertRules[] }, each of the right type.',
            wasItSaved: 'not_saved',
            nextSafeAction: 'Send the evidence the edge reports, with the alert rules that own each component.',
          });
        }
        // Round 33 · OB-119: a reserved id (a built-in rule's, or an owner's notice's) is never raised by hand.
        const reserved = [...new Set(rules.map((r) => r.alertId).filter(isReservedAlertId))];
        if (reserved.length > 0) throw reservedAlertIdRefusal(reserved);
        const at = deps.now();
        const alerts = raiseAlerts(checkHealth(signals, at, thresholds), rules);
        const known = new Set((await deps.alerts(ctx.tenantId)).map((a) => a.alert.alertId));
        let persisted = 0;
        for (const alert of alerts) {
          const rule = rules.find((r) => r.alertId === alert.alertId);
          const event: AlertLifecycleEvent = {
            alertId: alert.alertId, change: 'raised', by: ctx.userId, at, alert,
            ...(rule?.escalatesToUserId !== undefined ? { escalatesToUserId: rule.escalatesToUserId } : {}),
          };
          // Key on the alertId and its occurrence (no time): a re-raise of the same ongoing condition collapses to one.
          await deps.recordAlertEvent(ctx.tenantId, event, raiseKey(alert.alertId, (await deps.alerts(ctx.tenantId)).find((a) => a.alert.alertId === alert.alertId)));
          if (!known.has(alert.alertId)) persisted += 1;
        }
        return { status: 200, body: { raised: alerts.length, newlyOpened: persisted, alerts, at } };
      },
    },
    {
      // ACKNOWLEDGE — a named person takes an open alert, stopping its escalation. 404 for an unknown alert.
      api: 'API-11', method: 'POST', path: '/v1/platform/alerts/:alertId/acknowledge',
      permission: 'platform.alert.manage', idempotent: true,
      handler: async (ctx) => {
        const alertId = ctx.params['alertId'] ?? '';
        const live = (await deps.alerts(ctx.tenantId)).find((a) => a.alert.alertId === alertId);
        if (live === undefined) {
          throw apiError(404, {
            code: 'unknown_alert',
            whatHappened: `There is no alert called '${alertId}' to acknowledge.`,
            wasItSaved: 'not_saved',
            nextSafeAction: 'Check the id against GET /v1/platform/alerts.',
          });
        }
        // Round 33 · OB-119: only the shop's owner ticks a built-in alert (or an owner's notice) as seen.
        if (isReservedAlertId(alertId)) {
          const who = deps.builtInAlertAuthorityOf === undefined ? { owner: false, platformAdministration: false } : await deps.builtInAlertAuthorityOf(ctx.tenantId, ctx.userId);
          if (!who.owner) {
            throw apiError(403, who.platformAdministration ? {
              code: 'built_in_alert_acknowledge_refused_to_platform_administrator',
              whatHappened: `Only the shop's owner may acknowledge (tick as seen) ${alertId} (owner decision OB-119) — a built-in alert exists to reach HIM, and an acknowledged alert stops escalating and leaves his inbox. The platform (IT) administrator looks after the computers it watches, so may never acknowledge it (as OB-91), whatever stores the account covers. Nothing was acknowledged; the alert stays open.`,
              wasItSaved: 'not_saved',
              nextSafeAction: 'Tell the owner about it; he acknowledges it himself. Nothing was recorded except this refusal.',
            } : {
              code: 'built_in_alert_acknowledge_owner_only',
              whatHappened: `Only the shop's owner may acknowledge (tick as seen) ${alertId} (owner decision OB-119) — a built-in alert exists to reach him. This account does not hold the owner role. Nothing was acknowledged; the alert stays open.`,
              wasItSaved: 'not_saved',
              nextSafeAction: 'Tell the owner about it; he acknowledges it himself. Nothing was recorded except this refusal.',
            });
          }
        }
        const at = deps.now();
        // Key on the alertId and occurrence (no time): a re-acknowledge of the same alert collapses to one. §31.1 · OB-414: and on
        // its revision — an UPDATED alert asks to be ticked again, so that tick is its own.
        const ackKey = live.occurrence > 1 ? `ack-${alertId}-o${live.occurrence}` : `ack-${alertId}`;
        await deps.recordAlertEvent(ctx.tenantId, { alertId, change: 'acknowledged', by: ctx.userId, at }, live.revision === undefined ? ackKey : `${ackKey}-r${live.revision}`);
        return { status: 200, body: { alertId, acknowledgedBy: ctx.userId, at } };
      },
    },
    {
      // ESCALATE — the sweep. Every open, unacknowledged alert past its deadline is routed to the configured
      // person (the tested `escalateUnacknowledged`); already-escalated alerts are skipped, so it is idempotent.
      api: 'API-11', method: 'POST', path: '/v1/platform/alerts/escalate',
      permission: 'platform.alert.manage', idempotent: true,
      handler: async (ctx) => {
        const at = deps.now();
        const due = await escalateDueAlerts(deps, ctx.tenantId, ctx.userId, at);
        return {
          status: 200,
          body: {
            escalated: due.map((e) => ({ alertId: e.alert.alertId, escalatedTo: e.escalatedTo, detail: e.detail })),
            count: due.length,
            at,
          },
        };
      },
    },
    {
      // BOARD — every live alert with its state; worst first, then soonest deadline (control by exception).
      api: 'API-11', method: 'GET', path: '/v1/platform/alerts',
      permission: 'platform.health.read',
      handler: async (ctx) => {
        const live = await deps.alerts(ctx.tenantId);
        const ordered = [...live].sort((a, b) =>
          (SEVERITY[a.alert.status] ?? 9) - (SEVERITY[b.alert.status] ?? 9) || a.alert.ackDueBy.localeCompare(b.alert.ackDueBy));
        const needAttention = live.filter((a) => a.state === 'open' || a.state === 'escalated').length;
        // OB-435 · OB-439: every alert carries its words in both languages, for the screen's language button.
        return { status: 200, body: { alerts: ordered.map(withWords), open: live.filter((a) => a.state === 'open').length, needAttention, asAt: deps.now() } };
      },
    },
    {
      // INBOX (PA-12) — the alerts that are THIS person's to answer: the ones they own that nobody has acknowledged, and
      // the ones escalated to them. Everything delivered to them, with when and how. Worst first.
      api: 'API-11', method: 'GET', path: '/v1/platform/alerts/inbox',
      permission: 'platform.health.read',
      handler: async (ctx) => {
        const me = ctx.userId;
        // Round 34 · OB-124 (2): an alert also delivered to this person (a built-in rule's other owners) is theirs to answer too.
        const owns = (a: LiveAlert): boolean => a.alert.ownerUserId === me || (a.alert.alsoToUserIds ?? []).includes(me);
        const mine = (await deps.alerts(ctx.tenantId)).filter((a) =>
          (a.state === 'open' && owns(a)) || (a.state === 'escalated' && (a.escalatedTo === me || owns(a))));
        const ordered = [...mine].sort((a, b) =>
          (SEVERITY[a.alert.status] ?? 9) - (SEVERITY[b.alert.status] ?? 9) || a.alert.ackDueBy.localeCompare(b.alert.ackDueBy));
        return {
          status: 200,
          body: {
            userId: me,
            alerts: ordered.map((a) => ({ ...withWords(a), deliveredToMe: a.deliveries.filter((d) => d.to === me) })),
            count: ordered.length, asAt: deps.now(),
          },
        };
      },
    },
  ];
}

/**
 * The idempotency key of a raise: the alert and its occurrence (a new occurrence after it cleared gets its own). Round 33 ·
 * OB-119: head office's own rule raising over a FOREIGN occurrence (`ownRule`) gets its own too — never a dropped duplicate.
 */
export function raiseKey(alertId: string, live: LiveAlert | undefined, ownRule = false): string {
  const occurrence = live === undefined ? 1 : live.state === 'cleared' || (ownRule && live.foreign === true) ? live.occurrence + 1 : live.occurrence;
  return occurrence > 1 ? `raise-${alertId}-o${occurrence}` : `raise-${alertId}`;
}

/**
 * The escalation sweep (M35-FR-04): every open, unacknowledged alert past its deadline goes to the configured person
 * (the tested `escalateUnacknowledged`); an escalated, cleared or acknowledged alert is left alone, so re-running it
 * never double-escalates. What the route runs on demand and the ops-alert worker runs on its timer.
 */
export async function escalateDueAlerts(deps: AlertLifecycleDeps, tenantId: string, by: string, at: string): Promise<readonly { readonly alert: RaisedAlert; readonly escalatedTo: string; readonly detail: string; readonly text: AlertText }[]> {
  const live = (await deps.alerts(tenantId)).filter((a) => a.state !== 'cleared');
  const openAlerts = live.map((a) => a.alert);
  const rules = live.map((a): AlertRule => ({
    alertId: a.alert.alertId, component: a.alert.component, firesAt: a.alert.status,
    ownerUserId: a.alert.ownerUserId, ownerName: a.alert.ownerName, ackWithinMinutes: 1,
    ...(a.escalatesToUserId !== undefined ? { escalatesToUserId: a.escalatesToUserId } : {}),
  }));
  const acknowledgedIds = live.filter((a) => a.acknowledgedAt !== undefined).map((a) => a.alert.alertId);
  const alreadyEscalated = new Set(live.filter((a) => a.escalatedAt !== undefined).map((a) => a.alert.alertId));
  const due = escalateUnacknowledged(openAlerts, rules, acknowledgedIds, at).filter((e) => !alreadyEscalated.has(e.alert.alertId));
  for (const e of due) {
    await deps.recordAlertEvent(tenantId, {
      alertId: e.alert.alertId, change: 'escalated', by, at,
      escalatedTo: e.escalatedTo, detail: e.detail, detailText: e.text,
    }, `escalate-${e.alert.alertId}-${at}`);
  }
  return due;
}
