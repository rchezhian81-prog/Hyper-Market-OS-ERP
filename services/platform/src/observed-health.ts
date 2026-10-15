// API-11 Platform — OBSERVED operational health (M35-FR-03 / FR-04 / FR-01).
//
// `POST /v1/platform/operational-health` judges health from evidence the caller SUPPLIES. That was the
// honest first rung: the engine was real, the telemetry was not. These routes make the cloud read its
// own signals instead of being told them — the newest sale any lane has synced (data freshness, the
// number the owner asks for), the connector queues' depth and dead letters (M32), the catalogue pack's
// age, the integration adapters' heartbeats, and the backups the operator has recorded — and judge them
// with the SAME `checkHealth`, so the status page can never disagree with the ledgers.
//
// Alerts need owners (§32). The rules that name who owns which component, and the thresholds, are
// stored per tenant (versioned, latest in force); the raise route reads the observed signals, judges
// them, and writes the alerts into the SAME durable lifecycle store the manual raise uses, so the ack
// and escalation sweep work on them unchanged. With no rules defined nothing is raised — and the route
// says so, rather than inventing an owner (P-05).
//
// PA-12 round 4 — the lane and the backup reach a named person without anyone pressing "raise":
//   • the STORE COMPUTERS' own sync reports (EA-01 watermarks) are lane signals here: the sync clock is the stalest
//     store's last complete sync (not the newest sale), and their unsent and refused (dead-lettered) items count in
//     the queue and dead-letter components;
//   • a backup whose LATEST record failed (did not complete, not encrypted, or no off-site copy) makes the backup
//     component degraded at once — not only when the last good one finally ages past the limit;
//   • `raiseObservedAlerts` is the raise this route runs, exported so the ops-alert worker runs the same on its timer.
//
// PA-12 round 6 — the backup job reports ITSELF, and silence is an alert:
//   • the real backup job (the pilot box's encrypted-backup.sh → scripts/report-backup.mjs) posts its own outcome —
//     success AND failure — under its own operator-provisioned machine identity (role `backup_job`, the one permission
//     `platform.backup.record`), with what it measured: when it started and ended, the encrypted file's size and
//     sha256, whether it is encrypted, and whether the operator's off-site copy step confirmed the copy;
//   • a backup that never reports by its expected time is MISSED by itself: once the alert rules are in force, a good
//     backup is due within `backupMaxAgeSeconds` of the last good one (or, if there has never been one, of when the
//     rules first came into force — `backupsExpectedSince`, carried across rule versions) — the backup component is
//     then `down`, named "MISSED", and the ops-alert worker raises it to its owner with nobody posting anything.
//
// What the cloud cannot see it says it cannot see (P-08): the lane's local disk is a lane-side signal
// and stays `unknown` here until the store computer itself reports it — it is never guessed `ok`.
//
// M35-FR-03 (Batch 1, round 12) — the store computers' own health reaches head office: each box relays its disk (can it
// still record a sale?), its queue depth and its tills' device reports (D04-FR-05) after each sync pass, store-locked
// (OB-54, `box-health.ts`). They are judged here as `box_disk:<store>`, `box_queue:<store>` and `till_devices:<store>`
// components; a report older than the sync-lag warning threshold is shown STALE (`unknown`, with its age), never `ok`.
// While every reporting box is fresh, `localStoreWritable` is the boxes' own answer; one that cannot record makes it false. A backup counts only when it was recorded as
// completed, encrypted AND off-site (FR-01); a failed or unprotected backup is on the record but does
// not move the clock.

import type { Route } from '../../kernel/src/index';
import { apiError } from '../../kernel/src/index';
import {
  checkHealth, raiseAlerts, DEFAULT_THRESHOLDS,
  type HealthSignals, type HealthThresholds, type AlertRule, type SystemHealth, type RaisedAlert,
} from '../../../packages/ops/src/index';
import { readRules, readThresholds } from './operational-health';
import { raiseKey, isReservedAlertId, reservedAlertIdRefusal, type AlertLifecycleDeps, type AlertLifecycleEvent } from './alert-lifecycle';
import { ConcurrencyConflictError } from '../../../packages/persistence/src/event-store';
import {
  judgeBoxes, boxHistoryComponents, doorRefusalComponents, STORE_COMPUTER_CHECKS_STUCK_COMPONENT, STORE_COMPUTER_CHECKS_STUCK_MINUTES, type DoorRefusalLine,
  type BoxHealthRecord, type BoxHealthView, type BillNumberFinding, type StoreComputerReplacement, type PrefixBinding, type UnusedNumbers, type BoxReportsView,
  type BoxHistoryState, type UnusedCheckCapped,
} from './box-health';
import type { ComponentHealth } from '../../../packages/ops/src/index';

export interface ConnectorQueueDepth {
  readonly connectorId: string;
  readonly queued: number;
  readonly deadLettered: number;
}

/** A backup the operator (or the backup script, through the operator's credential) recorded. */
export interface BackupRecord {
  readonly backupId: string;
  readonly at: string;
  readonly ok: boolean;
  readonly encrypted: boolean;
  readonly offsite: boolean;
  readonly sizeBytes?: number;
  /** PA-12 r6: when the job finished (it measured it), and the sha256 of the file it kept (`sha256:<hex>`). */
  readonly endedAt?: string;
  readonly checksum?: string;
  readonly detail?: string;
  readonly recordedBy: string;
  readonly recordedAt: string;
}

/** The alert rules in force for a tenant: who owns which component, at what status, plus the thresholds. */
export interface StoredAlertRules {
  readonly version: number;
  readonly rules: readonly AlertRule[];
  readonly thresholds: HealthThresholds;
  /** How old the newest good backup may be before the `backup` component is `down`. */
  readonly backupMaxAgeSeconds: number;
  /** PA-12 r6: when backups first became expected (the first rules version) — kept across versions, so redefining the
   *  rules never resets the clock a never-reporting backup is judged MISSED by. Absent on rules stored before r6. */
  readonly backupsExpectedSince?: string;
  /**
   * Round 31 · OB-114: the BUILT-IN rules (`BUILT_IN_ALERT_RULE_IDS`) the owner turned off — kept across versions until a
   * version names the list again (an empty list turns them all back on). Absent: every built-in rule is on.
   */
  readonly builtInOff?: readonly string[];
  /**
   * Round 32 · OB-115: who last CHANGED a built-in rule (turned it off or on, edited or un-edited it) and when — carried across
   * versions until the next such change, so GET alert-rules shows it whoever saved the rules last. Absent: never changed.
   */
  readonly builtInChangedBy?: string;
  readonly builtInChangedAt?: string;
  readonly definedBy: string;
  readonly definedAt: string;
}

/**
 * Round 31 · OB-114 "A" (owner, 14 Oct 2026, in writing, "Built-in alert to you") — THE BUILT-IN RULE (stated). Every shop
 * has one alert rule it did not have to write: when the store computer checks stay not ready ("being prepared", or the saved
 * history cannot be sealed) for more than an hour (`store_computer_checks_stuck` down), the alert goes to the shop's OWNER —
 * the person who holds the owner role at the moment of the check (never a name written in the code); with nobody holding
 * it, the rule cannot be in force and GET alert-rules says so. It is in force with or without rules of the owner's own, and
 * the ops-alert worker raises, delivers (inbox, and phone when a message provider is set) and clears it like any other.
 * The owner EDITS it by putting a rule with the same alertId in his rules (his version is then the one in force: another
 * person, another acknowledgement time, someone to escalate to), and TURNS IT OFF by naming it in `builtInOff` — both through
 * PUT /v1/platform/alert-rules, so each change is a new rules version with who changed it and when (kept, never deleted).
 */
export const BUILT_IN_STORE_COMPUTER_CHECKS_RULE_ID = 'built-in:store-computer-checks-stuck';
export const BUILT_IN_ALERT_RULE_IDS: readonly string[] = [BUILT_IN_STORE_COMPUTER_CHECKS_RULE_ID];
/**
 * Round 32 · OB-115: the component each built-in rule watches — an edited built-in rule must keep it (an edit naming another
 * component, a misspelt one, could never fire for its purpose while still looking "edited, to the owner").
 */
export const BUILT_IN_RULE_COMPONENTS: Readonly<Record<string, string>> = { [BUILT_IN_STORE_COMPUTER_CHECKS_RULE_ID]: STORE_COMPUTER_CHECKS_STUCK_COMPONENT };
/** Round 32 · OB-115: the alert id prefix of the notice the owner gets for every change to a built-in rule. */
export const BUILT_IN_RULE_CHANGED_NOTICE = 'notice:built-in-alert-rule-changed';
/** How soon the owner is asked to acknowledge that notice (a day: it is a "for your information", not an emergency). */
export const BUILT_IN_RULE_CHANGED_NOTICE_ACK_MINUTES = 24 * 60;
/** How soon the owner is asked to acknowledge the built-in alert (he can change it by editing the rule). */
export const BUILT_IN_STORE_COMPUTER_CHECKS_ACK_MINUTES = 60;

/** The shop's owner, as the built-in rules address him (resolved when the rules are read). */
export interface ShopOwner { readonly userId: string; readonly name: string }

/** Round 31 · OB-114: each built-in rule and whether it is in force (`on`), replaced by the owner's own version (`edited`), turned off, or waiting for an owner. */
export interface BuiltInRuleState {
  readonly alertId: string;
  readonly state: 'on' | 'edited' | 'off' | 'no_owner';
  /** The rule in force for it (`on` / `edited`). */
  readonly rule?: AlertRule;
  readonly description: string;
  /** Round 32 · OB-115: who last changed a built-in rule, and when (absent: never changed — as it came). */
  readonly lastChangedBy?: string;
  readonly lastChangedAt?: string;
}

function builtInRules(owner: ShopOwner | undefined): readonly { readonly alertId: string; readonly rule?: AlertRule; readonly description: string }[] {
  return [{
    alertId: BUILT_IN_STORE_COMPUTER_CHECKS_RULE_ID,
    description: `tells the owner when the store computer checks stay "being prepared" (or the saved history cannot be sealed) for more than ${STORE_COMPUTER_CHECKS_STUCK_MINUTES} minutes (owner decision OB-114)`,
    ...(owner === undefined ? {} : { rule: {
      alertId: BUILT_IN_STORE_COMPUTER_CHECKS_RULE_ID, component: STORE_COMPUTER_CHECKS_STUCK_COMPONENT, firesAt: 'down' as const,
      ownerUserId: owner.userId, ownerName: owner.name, ackWithinMinutes: BUILT_IN_STORE_COMPUTER_CHECKS_ACK_MINUTES,
    } }),
  }];
}

/**
 * Round 32 · OB-115 "A" (owner, 14 Oct 2026, in writing, "Only you"; verifier r31 NEW-1) — ONLY THE OWNER CHANGES A BUILT-IN
 * RULE (stated). A save of the alert rules (PUT /v1/platform/alert-rules) that would turn a built-in rule off or back on, edit
 * it, change the owner's edit of it (another person, another acknowledgement time, another escalation) or remove that edit is
 * REFUSED by name (403, on the audit trail like every request) unless the person saving holds the owner role — the IT/platform
 * administrator in particular (`built_in_alert_rule_refused_to_platform_administrator`, as OB-91), and any other person
 * (`built_in_alert_rule_owner_only`). Anyone with alert rights may still save the shop's OTHER rules, as long as each built-in
 * rule is sent exactly as it stands (GET shows it) and builtInOff is left out (or named unchanged). Every change the owner makes
 * to a built-in rule is also SENT TO THE OWNER as a notice (his alert board, his inbox and, with a message provider, his phone),
 * saying who changed what and when. An edited built-in rule must keep its own component, fire at a status it reaches, and name
 * no branch (`built_in_alert_rule_cannot_fire`).
 *
 * builtInOff CARRIES INTO LATER VERSIONS (the rule chosen, stated): a version that leaves builtInOff out keeps the list as it
 * was — that is not a change, so anyone with alert rights may save other rules meanwhile — but it is never kept unseen: GET
 * alert-rules shows each built-in rule's state with who last changed it and when (`lastChangedBy`, `lastChangedAt`, carried
 * across versions whoever saves later), and EVERY save's reply states each built-in rule's state after the save (`builtIn`)
 * and, when one is still off, says so in words (`builtInStillOff`). Only the owner turns it back on (builtInOff: []).
 *
 * Returns what a save changes about the built-in rules, in words (empty: nothing).
 */
export function builtInRuleChanges(current: StoredAlertRules | undefined, rules: readonly AlertRule[], offAfter: readonly string[] | undefined): string[] {
  const out: string[] = [];
  const offBefore = new Set(current?.builtInOff ?? []);
  const offNow = new Set(offAfter ?? []);
  const key = (r: AlertRule): string => JSON.stringify([r.alertId, r.component, r.firesAt, r.ownerUserId, r.ownerName, r.ackWithinMinutes, r.escalatesToUserId ?? null, r.branchId ?? null]);
  const words = (r: AlertRule): string => `to ${r.ownerName} (${r.ownerUserId}), at ${r.firesAt}, answered within ${r.ackWithinMinutes} minutes${r.escalatesToUserId === undefined ? '' : `, escalating to ${r.escalatesToUserId}`}`;
  for (const id of BUILT_IN_ALERT_RULE_IDS) {
    if (!offBefore.has(id) && offNow.has(id)) out.push(`turned ${id} OFF`);
    if (offBefore.has(id) && !offNow.has(id)) out.push(`turned ${id} back on`);
    const before = current?.rules.filter((r) => r.alertId === id).map(key).join('|') ?? '';
    const after = rules.filter((r) => r.alertId === id);
    if (before === after.map(key).join('|')) continue;
    const was = current?.rules.find((r) => r.alertId === id);
    out.push(after.length === 0 ? `removed the owner's edit of ${id} (it goes back to the built-in rule, to the owner)`
      : was === undefined ? `edited ${id}: it would go ${words(after[0]!)}`
      : `changed the edit of ${id}: from ${words(was)} to ${words(after[0]!)}`);
  }
  return out;
}

/** Round 31 · OB-114: the rules in force — the owner's own, and every built-in rule he has not turned off or replaced. */
export function rulesInForce(stored: StoredAlertRules | undefined, owner: ShopOwner | undefined): { readonly rules: readonly AlertRule[]; readonly builtIn: readonly BuiltInRuleState[] } {
  const own = stored?.rules ?? [];
  const off = new Set(stored?.builtInOff ?? []);
  const rules: AlertRule[] = [...own];
  const builtIn: BuiltInRuleState[] = [];
  // Round 32 · OB-115: who last changed the built-in rules, shown with each (whoever saved the rules last).
  const changed = stored?.builtInChangedBy === undefined || stored.builtInChangedAt === undefined ? {}
    : { lastChangedBy: stored.builtInChangedBy, lastChangedAt: stored.builtInChangedAt };
  for (const b of builtInRules(owner)) {
    const edited = own.find((r) => r.alertId === b.alertId);
    if (off.has(b.alertId)) builtIn.push({ alertId: b.alertId, state: 'off', description: `${b.description} — TURNED OFF${stored?.builtInChangedBy === undefined ? '' : ` (last changed by ${stored.builtInChangedBy} at ${stored.builtInChangedAt})`}`, ...changed });
    else if (edited !== undefined) builtIn.push({ alertId: b.alertId, state: 'edited', rule: edited, description: b.description, ...changed });
    else if (b.rule === undefined) builtIn.push({ alertId: b.alertId, state: 'no_owner', description: `${b.description} — NOT in force: nobody holds the owner role`, ...changed });
    else { rules.push(b.rule); builtIn.push({ alertId: b.alertId, state: 'on', rule: b.rule, description: b.description, ...changed }); }
  }
  // An owner's version of a built-in rule he also turned off is not in force either.
  return { rules: rules.filter((r) => !off.has(r.alertId)), builtIn };
}

export const DEFAULT_BACKUP_MAX_AGE_SECONDS = 86_400;

export interface ObservedHealthDeps extends Pick<AlertLifecycleDeps, 'alerts' | 'recordAlertEvent'> {
  readonly now: () => string;
  /** The newest sale the cloud has received from any lane — when it happened at the till. */
  readonly lastSaleSyncedAt: (tenantId: string) => Promise<string | undefined> | string | undefined;
  readonly catalogueBuiltAt: (tenantId: string) => Promise<string | undefined> | string | undefined;
  readonly connectorQueues: (tenantId: string) => Promise<readonly ConnectorQueueDepth[]> | readonly ConnectorQueueDepth[];
  /** Per registered, enabled adapter: is it healthy right now (judged from its heartbeats)? */
  readonly integrationHealth: (tenantId: string, at: string) => Promise<Readonly<Record<string, boolean>>> | Readonly<Record<string, boolean>>;
  readonly backups: (tenantId: string) => Promise<readonly BackupRecord[]> | readonly BackupRecord[];
  readonly recordBackup: (tenantId: string, record: BackupRecord) => Promise<void> | void;
  readonly alertRules: (tenantId: string) => Promise<StoredAlertRules | undefined> | StoredAlertRules | undefined;
  /**
   * Append one rules version. Round 33 · OB-120: with `expectedGuardVersion` (read by `alertRulesGuardVersion` BEFORE the rules
   * in force were read) the append is CONDITIONAL — refused by name (`ConcurrencyConflictError`) when another save landed in
   * between, never silently deduped onto it. `saveKey` names this save (a re-send of the same request is the same save).
   */
  readonly defineAlertRules: (tenantId: string, rules: StoredAlertRules, opts?: { readonly expectedGuardVersion?: number; readonly saveKey?: string }) => Promise<void> | void;
  /** Round 33 · OB-120: the alert rules' write-guard version (0 before any guarded save). Absent: saves are not guarded. */
  readonly alertRulesGuardVersion?: (tenantId: string) => Promise<number>;
  /**
   * PA-12: the store computers' own sync reports (EA-01) — the stalest store's last complete sync and what their queues
   * still hold or had refused. Absent, or no store has reported: the newest sale stands in, said so.
   */
  readonly storeLanes?: (tenantId: string) => Promise<StoreLaneSignals | undefined>;
  /**
   * PA-12 round 7: is the caller the BACKUP JOB's own machine identity — do they hold a grant of the `backup_job` role
   * itself? Holding `platform.backup.record` through any other role (owner, store manager, platform admin) does not
   * count: a backup outcome is the job's own measurement, never a person's say-so. Absent: nobody may record (fail closed).
   */
  /**
   * Whether this caller is the backup job's own machine identity. `evidence` is the SIGNED token's interactive sign-in
   * evidence (`ctx.reauth`): present means a person signed in, which is never the backup job (PA-12 round 12).
   */
  readonly isBackupJob?: (tenantId: string, userId: string, evidence?: { readonly authTime?: number; readonly amr?: readonly string[] }) => Promise<boolean> | boolean;
  /**
   * M35-FR-03: the store computers' own health reports (disk, queue, till devices — `box-health.ts`) and the stores head
   * office knows (so one that never reported is named, not left out). Absent: the lane-side signals stay not observed.
   */
  readonly storeComputers?: (tenantId: string, at?: string) => Promise<{
    readonly records: readonly BoxHealthRecord[]; readonly knownStores: readonly string[];
    /**
     * Round 28 · OB-104: the reports as the box history's saved running result keeps them — when given, `records` is not read
     * (it may be empty) and the stores are judged from this (`judgeBoxes` `view`), to the same answers.
     */
    readonly view?: BoxReportsView;
    /** Verifier r19: bills issued but never received, and box reports refused — per store, judged with the ledger. */
    readonly billNumberFindings?: ReadonlyMap<string, readonly BillNumberFinding[]>;
    /** Verifier r20 HW-2: the bill-number high-water's visibility fence, when it is waiting on an open transaction. */
    readonly billNumberHighWater?: { readonly since: string; readonly waitingSeconds: number; readonly streams: readonly string[] } | null;
    /** Round 33 · OB-121: the reports refused at the door (prefixes never issued nor registered), one line per computer per day. */
    readonly refusedAtDoor?: readonly DoorRefusalLine[];
    /** Round 26 · OB-97: owner-approved "store computer replaced" acts (a prefix's binding follows them). */
    readonly replacements?: readonly StoreComputerReplacement[];
    /** Round 27 · OB-101: the (store, prefix) bindings as the findings were judged on (the store's health comes from the bound computer). */
    readonly bindings?: readonly PrefixBinding[];
    /** Round 27 · OB-100: the numbers each store's computer said it gave and never used (from the same saved running result). */
    readonly unusedNumbers?: ReadonlyMap<string, readonly UnusedNumbers[]>;
    /** Round 29 · NEW-6: per store, what the "said unused, but head office has the bill" check did not look at. */
    readonly unusedCapped?: ReadonlyMap<string, readonly UnusedCheckCapped[]>;
    /**
     * Round 29 · OB-106: the store computers' saved history is being built in the background — nothing about the store
     * computers is judged until it is ready (said as `box_history: unknown`, and in `notObserved`; never read as healthy).
     */
    readonly preparing?: { readonly since: string; readonly why: string };
    /** Round 29 · OB-105/106: the saved history itself — its size, saving held back by an open transaction, a failed build. */
    readonly history?: BoxHistoryState;
  }>;
  /** OB-78: the owner's early-warning line for a store computer's disk, in hours of trading left (tenant setting, default 48). */
  readonly boxDiskWarnHours?: (tenantId: string) => Promise<number> | number;
  /** Verifier r21 UNSENT-CEILING: warn when bills have waited on a store computer this many hours (tenant setting, default 2). */
  readonly boxUnsentWarnHours?: (tenantId: string) => Promise<number> | number;
  /**
   * OB-95 (owner, 13 Oct 2026): the people who hold BOTH the IT/platform role and a business role — granted before the rule
   * refused it. Each is named on the health (`access_separation_of_duties`, degraded) until the mix is ended.
   */
  readonly separationOfDuties?: (tenantId: string) => Promise<readonly { readonly userId: string; readonly itRoles: readonly string[]; readonly businessRoles: readonly string[] }[]>;
  /** Round 31 · OB-114: who holds the owner role now (the built-in rules' addressee). Absent or nobody: the built-in rules are not in force (said). */
  readonly shopOwner?: (tenantId: string) => Promise<ShopOwner | undefined> | ShopOwner | undefined;
  /**
   * Round 32 · OB-115: may this person change a BUILT-IN rule — do they hold the owner role — and do they hold the IT/platform
   * administration function (said by name when refused, as OB-91). Absent: nobody may change a built-in rule (fail closed).
   */
  readonly builtInRuleAuthorityOf?: (tenantId: string, userId: string) => Promise<{ readonly owner: boolean; readonly platformAdministration: boolean }>;
}

/** OB-95: one component naming each person who holds both the IT/platform role and a business role (none: no component). */
export function separationOfDutiesComponent(people: readonly { readonly userId: string; readonly itRoles: readonly string[]; readonly businessRoles: readonly string[] }[]): ComponentHealth[] {
  if (people.length === 0) return [];
  return [{
    name: 'access_separation_of_duties', status: 'degraded',
    detail: `separation of duties (owner decision OB-95): ${people.map((p) => `${p.userId} holds the IT/platform role (${p.itRoles.join(', ')}) AND business role(s) (${p.businessRoles.join(', ')})`).join('; ')} — given before head office refused it. Head office now refuses any grant that would do this; end the mix by removing one side (a joiner/mover change, or a leaver and a new sign-in for the other work), so the person who looks after the computers never also runs the shop`,
    evidence: { people: people.map((p) => p.userId).join(','), count: people.length },
  }];
}

/** What the store computers last reported about their queues (PA-12, from the EA-01 watermark reports). */
export interface StoreLaneSignals {
  /** The stalest reporting store's last complete sync (across its queues); null when one has never completed one. */
  readonly stalestCompleteAt: string | null;
  readonly stalestStore: string;
  readonly unsent: number;
  readonly deadLettered: number;
  readonly stores: number;
}

export interface ObservedSignals {
  readonly signals: HealthSignals;
  /** Where each signal came from — so a screen can say what "fresh" means. */
  readonly provenance: Readonly<Record<string, string>>;
  readonly freshness: { readonly lastSaleAt: string | null; readonly ageSeconds: number | null };
  readonly queues: readonly ConnectorQueueDepth[];
  readonly lastBackup: BackupRecord | null;
  /** Signals the cloud cannot observe from here, named rather than guessed. */
  readonly notObserved: readonly string[];
  /** M35-FR-03: each store computer's latest health report, judged (stale ones said to be stale). */
  readonly boxes: readonly BoxHealthView[];
  /** The per-store components those reports give (`box_disk:`, `box_queue:`, `till_devices:`). */
  readonly boxComponents: readonly ComponentHealth[];
  /** Round 29 · OB-106: the store computer checks are being prepared (not judged yet) — since when and why; null when ready. */
  readonly storeComputersPreparing: { readonly since: string; readonly why: string } | null;
}

/** A backup that counts (FR-01): completed, encrypted and off-site. */
export const goodBackup = (b: BackupRecord): boolean => b.ok && b.encrypted && b.offsite;

const byAt = (a: { readonly at: string }, b: { readonly at: string }): number => a.at.localeCompare(b.at);

/** Fold the cloud's own ledgers into the health engine's signal shape. Pure over the deps' answers. */
export async function observeSignals(deps: ObservedHealthDeps, tenantId: string, at: string, backupMaxAgeSeconds: number, thresholds: HealthThresholds = DEFAULT_THRESHOLDS): Promise<ObservedSignals> {
  const [lastSale, catalogue, queues, integrations, backups, lanes, boxReports, bothDuties] = await Promise.all([
    deps.lastSaleSyncedAt(tenantId), deps.catalogueBuiltAt(tenantId), deps.connectorQueues(tenantId),
    deps.integrationHealth(tenantId, at), deps.backups(tenantId),
    deps.storeLanes === undefined ? Promise.resolve(undefined) : deps.storeLanes(tenantId),
    deps.storeComputers === undefined ? Promise.resolve(undefined) : deps.storeComputers(tenantId, at),
    deps.separationOfDuties === undefined ? Promise.resolve([]) : deps.separationOfDuties(tenantId),
  ]);
  const judgedBoxes = boxReports === undefined || boxReports.preparing !== undefined || !(boxReports.view?.any ?? boxReports.records.length > 0)
    ? undefined : judgeBoxes({
      records: boxReports.records, knownStores: boxReports.knownStores, at, thresholds,
      ...(boxReports.view === undefined ? {} : { view: boxReports.view }),
      ...(boxReports.billNumberFindings === undefined ? {} : { billNumberFindings: boxReports.billNumberFindings }),
      ...(boxReports.replacements === undefined ? {} : { replacements: boxReports.replacements }),
      ...(boxReports.bindings === undefined ? {} : { bindings: boxReports.bindings }),
      ...(boxReports.unusedNumbers === undefined ? {} : { unusedNumbers: boxReports.unusedNumbers }),
      ...(boxReports.unusedCapped === undefined ? {} : { unusedCapped: boxReports.unusedCapped }),
      ...(deps.boxDiskWarnHours === undefined ? {} : { diskWarnHours: await deps.boxDiskWarnHours(tenantId) }),
      ...(deps.boxUnsentWarnHours === undefined ? {} : { unsentWarnHours: await deps.boxUnsentWarnHours(tenantId) }),
    });
  const writable = judgedBoxes?.localStoreWritable;
  const sortedBackups = [...backups].sort(byAt);
  const good = [...sortedBackups].reverse().find(goodBackup);
  const latest = sortedBackups[sortedBackups.length - 1];
  const fromLanes = lanes !== undefined && lanes.stores > 0;
  const queued = queues.reduce((s, q) => s + q.queued, 0) + (fromLanes ? lanes.unsent : 0);
  const deadLettered = queues.reduce((s, q) => s + q.deadLettered, 0) + (fromLanes ? lanes.deadLettered : 0);
  // The sync clock: the stalest store's last COMPLETE sync when the store computers report (EA-01/PA-12); a store that
  // has never completed one leaves it unset (the engine then says so, never "ok"). Else the newest sale stands in.
  const lastSyncAt = fromLanes ? (lanes.stalestCompleteAt ?? undefined) : lastSale;
  const signals: HealthSignals = {
    ...(lastSyncAt === undefined ? {} : { lastSyncAt }),
    queueDepth: queued,
    deadLetterCount: deadLettered,
    ...(catalogue === undefined ? {} : { catalogueBuiltAt: catalogue }),
    databaseReachable: true,
    ...(writable === undefined ? {} : { localStoreWritable: writable }),
    integrations,
    ...(good === undefined ? {} : { lastBackupAt: good.at }),
    backupMaxAgeSeconds,
  };
  const ageSeconds = lastSyncAt === undefined ? null : Math.max(0, Math.floor((Date.parse(at) - Date.parse(lastSyncAt)) / 1000));
  return {
    signals,
    provenance: {
      lastSyncAt: fromLanes
        ? `the stalest store computer's last complete sync, from its own report (${lanes.stalestStore}; ${lanes.stores} store(s) reporting)`
        : 'the newest sale the cloud has received from any lane, at the time it was rung up (SaleCommitted) — no store computer has reported its sync yet',
      queueDepth: `messages still queued across ${queues.length} connector queue(s)${fromLanes ? ` and the store computers' own queues (${lanes.unsent} waiting)` : ''}`,
      deadLetterCount: `messages dead-lettered across ${queues.length} connector queue(s)${fromLanes ? ` and the store computers' queues (${lanes.deadLettered} refused)` : ''} — each one still needs a person`,
      catalogueBuiltAt: 'when the latest published catalogue pack was built',
      databaseReachable: 'this very read came from the cloud database',
      integrations: 'each enabled adapter judged from its recorded heartbeats',
      lastBackupAt: 'the newest backup recorded as completed, encrypted and off-site; a failed or unprotected backup is kept but does not count',
      ...(writable === undefined ? {} : { localStoreWritable: 'each store computer\'s own latest report of its disk (can it record the next sale, by its own rule); only fresh reports count' }),
    },
    freshness: { lastSaleAt: lastSyncAt ?? null, ageSeconds },
    queues,
    lastBackup: latest ?? null,
    notObserved: writable !== undefined ? [] : boxReports?.preparing !== undefined
      ? [`localStoreWritable — being prepared: the store computers' saved history is being built (since ${boxReports.preparing.since}), so no store computer is judged yet; never guessed ok here`]
      : judgedBoxes === undefined
      ? ['localStoreWritable — a lane-side signal (the store box reports it through its own health check); never guessed ok here']
      : [`localStoreWritable — not every store computer has a fresh report (${judgedBoxes.boxes.filter((b) => b.stale).map((b) => `${b.storeId}: ${b.state === 'never_reported' ? 'never reported' : `stale, last ${b.lastReportAt}`}`).join('; ')}); never guessed ok here`],
    boxes: judgedBoxes?.boxes ?? [],
    boxComponents: [
      ...judgedBoxes?.components ?? [], ...highWaterComponent(boxReports?.billNumberHighWater ?? null),
      // Round 33 · OB-121: a store computer naming bill-number prefixes head office never issued or registered — said, never kept.
      ...doorRefusalComponents(boxReports?.refusedAtDoor ?? [], at),
      ...(boxReports === undefined ? [] : boxHistoryComponents({ at, ...(boxReports.preparing === undefined ? {} : { preparing: boxReports.preparing }), ...(boxReports.history === undefined ? {} : { history: boxReports.history }) })),
      ...separationOfDutiesComponent(bothDuties),
    ],
    storeComputersPreparing: boxReports?.preparing ?? null,
  };
}

/** Verifier r20 HW-2: a fence still waiting after this long is shown (the API's own idle-in-transaction limit is 1 minute). */
export const HIGH_WATER_WAIT_WARN_SECONDS = 300;

/**
 * Verifier r20 HW-2 (P-08, P-03): the bill-number high-water waiting on an open database transaction — shown only once it
 * has waited HIGH_WATER_WAIT_WARN_SECONDS (a fence normally settles within milliseconds). The count stays right meanwhile;
 * it only gets slower until that transaction ends, so it is `degraded`, never `down`.
 */
export function highWaterComponent(w: { readonly since: string; readonly waitingSeconds: number; readonly streams: readonly string[] } | null): ComponentHealth[] {
  if (w === null || w.waitingSeconds < HIGH_WATER_WAIT_WARN_SECONDS) return [];
  const mins = Math.floor(w.waitingSeconds / 60);
  return [{
    name: 'bill_number_high_water', status: 'degraded',
    detail: `bill-number high-water is waiting on an open database transaction since ${w.since} (${mins} min): head office still counts every bill number correctly, but each count re-reads every bill since then and gets slower until that transaction ends. Ask the database administrator to find it — a session "idle in transaction" or a prepared transaction anywhere on the database server (pg_stat_activity, pg_prepared_xacts) — and end it`,
    evidence: { waitingSince: w.since, waitingSeconds: w.waitingSeconds, streams: w.streams.join(','), warnAfterSeconds: HIGH_WATER_WAIT_WARN_SECONDS },
  }];
}

const isStr = (v: unknown): v is string => typeof v === 'string' && v.trim() !== '';
const isBool = (v: unknown): v is boolean => typeof v === 'boolean';
const isIso = (v: unknown): v is string => typeof v === 'string' && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/.test(v) && !Number.isNaN(Date.parse(v));

const RANK: Readonly<Record<string, number>> = { ok: 0, unknown: 1, degraded: 2, down: 3 };

/**
 * A backup whose LATEST record failed is an exception now (PA-12): the backup component is at least degraded, naming
 * why — even while the last good backup is still inside its age limit. A missed backup (no good one inside the limit)
 * is already `down` from the engine.
 */
export function withFailedBackup(health: SystemHealth, latest: BackupRecord | null): SystemHealth {
  if (latest === null || goodBackup(latest)) return health;
  const why = [...(latest.ok ? [] : ['did not complete']), ...(latest.encrypted ? [] : ['is not encrypted']), ...(latest.offsite ? [] : ['has no off-site copy'])].join(', ');
  const components = health.components.map((c) => (c.name !== 'backup' || (RANK[c.status] ?? 0) >= RANK['degraded']!
    ? c
    : { ...c, status: 'degraded' as const, detail: `the latest backup (${latest.backupId}, ${latest.at}) ${why}; ${c.detail}` }));
  const status = components.reduce<SystemHealth['status']>((w, c) => ((RANK[c.status] ?? 0) > (RANK[w] ?? 0) ? c.status : w), health.status);
  return { ...health, components, status };
}

/**
 * PA-12 r6 — a backup that has not reported by its expected time is MISSED, by itself. With rules in force, a good
 * backup is due `backupMaxAgeSeconds` after the last good one — or after `backupsExpectedSince` when there has never
 * been one (the engine alone would only say `unknown` then, which no rule fires on). Past that, the backup component
 * is `down` and says MISSED and when it was due. Without rules nothing is expected of anyone, and nothing changes.
 */
export function withMissedBackup(health: SystemHealth, backups: readonly BackupRecord[], stored: StoredAlertRules | undefined, at: string): SystemHealth {
  if (stored === undefined) return health;
  const maxMs = stored.backupMaxAgeSeconds * 1000;
  const good = [...backups].filter(goodBackup).sort(byAt).pop();
  const since = good?.at ?? stored.backupsExpectedSince ?? stored.definedAt;
  const dueMs = Date.parse(since) + maxMs;
  if (!(Date.parse(at) > dueMs)) return health;
  const due = new Date(dueMs).toISOString();
  const detail = good === undefined
    ? `MISSED — no good backup has reported since backups became expected (${since}); one was due by ${due}. A backup that does not report is treated as not taken`
    : `MISSED — the next good backup was due by ${due} (the last good one was ${good.backupId} at ${good.at})`;
  const components = health.components.map((c) => (c.name !== 'backup' ? c
    : { ...c, status: 'down' as const, detail: c.status === 'down' ? `${detail}; ${c.detail}` : detail }));
  const status = components.reduce<SystemHealth['status']>((w, c) => ((RANK[c.status] ?? 0) > (RANK[w] ?? 0) ? c.status : w), health.status);
  return { ...health, components, status };
}

/**
 * M35-FR-03: the store computers' components join the shop's health; the overall status is the worst of all. A box that
 * is down or degraded is named in the summary, so the one line a person reads says which store and why.
 */
export function withBoxes(health: SystemHealth, boxComponents: readonly ComponentHealth[]): SystemHealth {
  if (boxComponents.length === 0) return health;
  const components = [...health.components, ...boxComponents];
  const status = components.reduce<SystemHealth['status']>((w, c) => ((RANK[c.status] ?? 0) > (RANK[w] ?? 0) ? c.status : w), health.status);
  const bad = boxComponents.filter((c) => c.status === 'down' || c.status === 'degraded').map((c) => c.detail);
  const summary = bad.length === 0 ? health.summary
    : health.summary === 'Everything is up to date' || health.summary.startsWith('Nothing is reporting yet') ? bad.join('; ') : `${health.summary}; ${bad.join('; ')}`;
  return { ...health, components, status, summary };
}

/** Judge a shop's observed health with its stored rules (the read and the raise share it). */
export async function judgeObserved(deps: ObservedHealthDeps, tenantId: string, at: string) {
  const stored = await deps.alertRules(tenantId);
  const thresholds = stored?.thresholds ?? DEFAULT_THRESHOLDS;
  const observed = await observeSignals(deps, tenantId, at, stored?.backupMaxAgeSeconds ?? DEFAULT_BACKUP_MAX_AGE_SECONDS, thresholds);
  const health: SystemHealth = withBoxes(withMissedBackup(
    withFailedBackup(checkHealth(observed.signals, at, thresholds), observed.lastBackup),
    await deps.backups(tenantId), stored, at), observed.boxComponents);
  // Round 31 · OB-114: the owner's rules and the built-in ones in force (addressed to whoever holds the owner role now).
  const { rules, builtIn } = rulesInForce(stored, deps.shopOwner === undefined ? undefined : await deps.shopOwner(tenantId));
  const alerts: readonly RaisedAlert[] = raiseAlerts(health, rules);
  return { stored, rules, builtIn, observed, health, alerts };
}

/**
 * Raise the shop's observed alerts into the durable lifecycle store (each to its named owner), and — when `clear` —
 * mark cleared every open alert whose condition is no longer observed (kept, never deleted; a recurrence is a new
 * occurrence). Returns undefined when the shop has no alert rules in force — none of the owner's and no built-in one (nothing
 * can be owned, so nothing is raised). Round 31 · OB-114: the built-in rules are in force without rules of the owner's own.
 */
export async function raiseObservedAlerts(deps: ObservedHealthDeps, tenantId: string, by: string, at: string, opts: { readonly clear?: boolean; readonly builtIn?: boolean } = {}) {
  const judged = await judgeObserved(deps, tenantId, at);
  if (judged.stored === undefined && judged.rules.length === 0) return undefined;
  const before = await deps.alerts(tenantId);
  const known = new Set(before.map((a) => a.alert.alertId));
  let newlyOpened = 0;
  // Round 33 · OB-119: only the ops-alert worker raises a built-in rule's alert (`builtIn`, the default for it); a person's
  // raise leaves them to the worker, and says so.
  const builtIn = opts.builtIn ?? true;
  let builtInLeftToWorker = 0;
  for (const alert of judged.alerts) {
    const reserved = isReservedAlertId(alert.alertId);
    if (reserved && !builtIn) { builtInLeftToWorker += 1; continue; }
    const rule = judged.rules.find((r) => r.alertId === alert.alertId);
    const event: AlertLifecycleEvent = {
      alertId: alert.alertId, change: 'raised', by, at, alert,
      ...(rule?.escalatesToUserId !== undefined ? { escalatesToUserId: rule.escalatesToUserId } : {}),
      // Round 33 · OB-119: the built-in rule's own raise — never collapsed into an alert someone else planted under its id.
      ...(reserved ? { origin: 'built-in-rule' as const } : {}),
    };
    const live = before.find((a) => a.alert.alertId === alert.alertId);
    await deps.recordAlertEvent(tenantId, event, raiseKey(alert.alertId, live, reserved));
    if (!known.has(alert.alertId) || live?.state === 'cleared' || (reserved && live?.foreign === true)) newlyOpened += 1;
  }
  let cleared = 0;
  let keptWhilePreparing = 0;
  if (opts.clear === true) {
    const firing = new Set(judged.alerts.map((a) => a.alertId));
    // A rule no longer in force (a built-in one turned off, say) leaves its open alert as it is — as before for a removed rule.
    const ruled = new Set(judged.rules.map((r) => r.alertId));
    const preparing = judged.observed.storeComputersPreparing;
    for (const a of before) {
      if (a.state === 'cleared' || firing.has(a.alert.alertId) || !ruled.has(a.alert.alertId)) continue;
      // Round 29 · OB-106: while the store computer checks are being prepared nothing about them is known — an alert on a
      // store computer stays as it is (never cleared on no news); the worker says it skipped them. Round 31 · OB-114: the
      // "checks not ready" alert (`store_computer_checks_stuck`) is NOT one of them — it is about the preparing itself,
      // judged on every pass (raised while preparing, cleared when ready).
      if (preparing !== null && STORE_COMPUTER_COMPONENT.test(a.alert.component)) { keptWhilePreparing += 1; continue; }
      await deps.recordAlertEvent(tenantId, { alertId: a.alert.alertId, change: 'cleared', by, at, detail: `${a.alert.component} is no longer at ${a.alert.status} or worse` }, `clear-${a.alert.alertId}-o${a.occurrence}`);
      cleared += 1;
    }
  }
  return { ...judged, newlyOpened, cleared, keptWhilePreparing, builtInLeftToWorker };
}

/** Round 29 · OB-106: the components the store computers' reports give (kept, never cleared, while their checks are being prepared). */
const STORE_COMPUTER_COMPONENT = /^(box_|till_devices:|bill_number_high_water)/;

/**
 * Round 33 · OB-120 "A" (owner, 15 Oct 2026, in writing, "Refuse the second save"; verifier r32 NEW-3): a save of the alert
 * rules based on a version that is no longer the one in force is refused by name — 409, nothing saved, nothing lost.
 */
function rulesChangedSinceRead(basedOnVersion: number, current: StoredAlertRules | undefined) {
  return apiError(409, {
    code: 'alert_rules_changed_since_you_looked',
    whatHappened: `Someone else just changed these rules — look again and resend. This save was based on version ${basedOnVersion}, but the rules in force are now version ${current?.version ?? 0}${current === undefined ? '' : `, saved by ${current.definedBy} at ${current.definedAt}`}. Saving yours on top would silently undo their change (owner decision OB-120), so it was refused.`,
    wasItSaved: 'not_saved',
    nextSafeAction: `Read the rules again (GET /v1/platform/alert-rules), make your change on what they show now, and resend with basedOnVersion ${current?.version ?? 0}. Nothing of yours was saved.`,
  });
}

export function observedHealthRoutes(deps: ObservedHealthDeps): readonly Route[] {
  const judge = (tenantId: string, at: string) => judgeObserved(deps, tenantId, at);

  return [
    {
      api: 'API-11', method: 'GET', path: '/v1/platform/alert-rules',
      permission: 'platform.health.read',
      handler: async (ctx) => {
        const stored = await deps.alertRules(ctx.tenantId);
        return {
          status: 200,
          body: {
            rules: stored ?? null,
            // Round 31 · OB-114: the built-in rules — in force, replaced by the owner's version, turned off, or waiting for an owner.
            builtIn: rulesInForce(stored, deps.shopOwner === undefined ? undefined : await deps.shopOwner(ctx.tenantId)).builtIn,
            defaults: { thresholds: DEFAULT_THRESHOLDS, backupMaxAgeSeconds: DEFAULT_BACKUP_MAX_AGE_SECONDS },
            asAt: deps.now(),
          },
        };
      },
    },
    {
      api: 'API-11', method: 'PUT', path: '/v1/platform/alert-rules',
      permission: 'platform.alert.manage', idempotent: true,
      handler: async (ctx) => {
        const b = (ctx.body ?? {}) as Record<string, unknown>;
        const rules = Array.isArray(b['rules']) ? readRules(b['rules']) : undefined;
        const thresholds = readThresholds(b['thresholds']);
        const maxAge = b['backupMaxAgeSeconds'] === undefined ? DEFAULT_BACKUP_MAX_AGE_SECONDS : b['backupMaxAgeSeconds'];
        // Round 31 · OB-114: the built-in rules to turn off (each must be one); absent = as the rules in force had it.
        const offRaw = b['builtInOff'];
        const builtInOff = offRaw === undefined ? undefined
          : Array.isArray(offRaw) && offRaw.every((x) => typeof x === 'string' && BUILT_IN_ALERT_RULE_IDS.includes(x)) ? [...new Set(offRaw as string[])].sort() : null;
        if (builtInOff === null) {
          throw apiError(400, {
            code: 'alert_rules_not_readable',
            whatHappened: `builtInOff must be a list of built-in rule ids (${BUILT_IN_ALERT_RULE_IDS.join(', ')}) — the built-in rules that are turned off.`,
            wasItSaved: 'not_saved',
            nextSafeAction: 'Correct the list and send the whole set again. The rules in force are unchanged.',
          });
        }
        // Only turning a built-in rule off may come with no rules of the owner's own.
        if (rules === undefined || (rules.length === 0 && (builtInOff === undefined || builtInOff.length === 0)) || thresholds === undefined || !Number.isInteger(maxAge) || (maxAge as number) <= 0) {
          throw apiError(400, {
            code: 'alert_rules_not_readable',
            whatHappened: 'Alert rules need a non-empty rules[] (alertId, component, firesAt, ownerUserId, ownerName, ackWithinMinutes, optional escalatesToUserId), '
              + 'optional thresholds of the right type and an optional positive whole backupMaxAgeSeconds. Every alert needs a named owner (§32).',
            wasItSaved: 'not_saved',
            nextSafeAction: 'Correct the rules and send the whole set again. The rules in force are unchanged.',
          });
        }
        // Round 33 · OB-119: a rule under a reserved id must BE a built-in rule (the owner's edit of it, judged below) — no
        // hand-made rule may name an id under "built-in:" or "notice:".
        const reservedIds = [...new Set(rules.map((r) => r.alertId).filter((id) => isReservedAlertId(id) && !BUILT_IN_ALERT_RULE_IDS.includes(id)))];
        if (reservedIds.length > 0) throw reservedAlertIdRefusal(reservedIds);
        // Round 33 · OB-120: the save names the rules version it was based on (GET shows it: rules.version, 0 when none yet).
        const basedOnVersion = b['basedOnVersion'];
        if (basedOnVersion === undefined) {
          throw apiError(428, {
            code: 'alert_rules_save_needs_based_on_version',
            whatHappened: 'A save of the alert rules must say which version of the rules it was based on (basedOnVersion — rules.version from GET /v1/platform/alert-rules, 0 when no rules are saved yet), so a change someone else made in between is never silently overwritten or lost (owner decision OB-120).',
            wasItSaved: 'not_saved',
            nextSafeAction: 'Read the rules (GET /v1/platform/alert-rules), make your change on what it shows, and send it with basedOnVersion set to the version you read. The rules in force are unchanged.',
          });
        }
        if (typeof basedOnVersion !== 'number' || !Number.isSafeInteger(basedOnVersion) || basedOnVersion < 0) {
          throw apiError(400, {
            code: 'alert_rules_not_readable',
            whatHappened: 'basedOnVersion must be a whole number of 0 or more — the rules version you read (0 when no rules are saved yet).',
            wasItSaved: 'not_saved',
            nextSafeAction: 'Correct basedOnVersion and send the whole set again. The rules in force are unchanged.',
          });
        }
        // Round 32 · OB-115: an edited built-in rule must still be able to fire for its purpose — its own component, at a
        // status that component reaches when the checks are stuck, shop-wide.
        for (const r of rules) {
          const component = BUILT_IN_RULE_COMPONENTS[r.alertId];
          if (component === undefined) continue;
          if (r.component !== component || r.firesAt === 'ok' || r.branchId !== undefined) {
            throw apiError(400, {
              code: 'built_in_alert_rule_cannot_fire',
              whatHappened: `The built-in rule ${r.alertId} watches "${component}" (shop-wide) and fires when it is down. An edit must keep that component, fire at "down", "degraded" or "unknown" (never "ok", which fires when all is well), and name no branch — this one ${r.component !== component ? `names "${r.component}", which can never tell the owner the store computer checks are stuck` : r.firesAt === 'ok' ? 'fires at "ok"' : `names branch ${r.branchId}`}.`,
              wasItSaved: 'not_saved',
              nextSafeAction: `Keep component "${component}" in the edited rule (change only who gets it, how soon they answer, and who it escalates to), or turn the rule off by name in builtInOff. The rules in force are unchanged.`,
            });
          }
        }
        // Round 33 · OB-120: the guard's version is read BEFORE the rules in force, so a save landing in between is caught.
        const guardAt = deps.alertRulesGuardVersion === undefined ? undefined : await deps.alertRulesGuardVersion(ctx.tenantId);
        const current = await deps.alertRules(ctx.tenantId);
        if ((current?.version ?? 0) !== basedOnVersion) throw rulesChangedSinceRead(basedOnVersion, current);
        const definedAt = deps.now();
        // OB-114: a built-in rule turned off stays off until a version names the list again (round 32: said in every reply).
        const offAfter = builtInOff ?? current?.builtInOff;
        // Round 32 · OB-115: what this save changes about the BUILT-IN rules — turned off / on, or edited / un-edited.
        const builtInChanges = builtInRuleChanges(current, rules, offAfter);
        if (builtInChanges.length > 0) {
          const who = deps.builtInRuleAuthorityOf === undefined ? { owner: false, platformAdministration: false } : await deps.builtInRuleAuthorityOf(ctx.tenantId, ctx.userId);
          if (!who.owner) {
            throw apiError(403, who.platformAdministration ? {
              code: 'built_in_alert_rule_refused_to_platform_administrator',
              whatHappened: `Only the shop's owner may turn off, edit or re-point a built-in alert rule (owner decision OB-115) — it exists to reach HIM. The platform (IT) administrator looks after the computers the rule watches, so may never change it (as OB-91 / OB-95), whatever stores the account covers. This save would have ${builtInChanges.join('; ')}.`,
              wasItSaved: 'not_saved',
              nextSafeAction: 'Save your rules with every built-in rule exactly as GET /v1/platform/alert-rules shows it (and builtInOff left out), or ask the owner to make this change himself. Nothing was changed.',
            } : {
              code: 'built_in_alert_rule_owner_only',
              whatHappened: `Only the shop's owner may turn off, edit or re-point a built-in alert rule (owner decision OB-115) — it exists to reach him. This account does not hold the owner role. This save would have ${builtInChanges.join('; ')}.`,
              wasItSaved: 'not_saved',
              nextSafeAction: 'Save your rules with every built-in rule exactly as GET /v1/platform/alert-rules shows it (and builtInOff left out), or ask the owner to make this change himself. Nothing was changed.',
            });
          }
        }
        const stored: StoredAlertRules = {
          version: (current?.version ?? 0) + 1, rules, thresholds, backupMaxAgeSeconds: maxAge as number,
          // PA-12 r6: the clock a never-reporting backup is judged MISSED by starts with the FIRST rules, and stays.
          backupsExpectedSince: current === undefined ? definedAt : (current.backupsExpectedSince ?? current.definedAt),
          ...(offAfter === undefined ? {} : { builtInOff: offAfter }),
          // Round 32 · OB-115: who last changed a built-in rule, carried until the next such change.
          ...(builtInChanges.length > 0 ? { builtInChangedBy: ctx.userId, builtInChangedAt: definedAt }
            : current?.builtInChangedBy === undefined || current.builtInChangedAt === undefined ? {}
            : { builtInChangedBy: current.builtInChangedBy, builtInChangedAt: current.builtInChangedAt }),
          definedBy: ctx.userId, definedAt,
        };
        try {
          await deps.defineAlertRules(ctx.tenantId, stored, {
            ...(guardAt === undefined ? {} : { expectedGuardVersion: guardAt }),
            ...(ctx.idempotencyKey === undefined ? {} : { saveKey: ctx.idempotencyKey }),
          });
        } catch (e) {
          // Round 33 · OB-120: another save landed between this one's read and its write — refused by name, never dropped.
          if (e instanceof ConcurrencyConflictError) throw rulesChangedSinceRead(basedOnVersion, await deps.alertRules(ctx.tenantId));
          throw e;
        }
        const owner = deps.shopOwner === undefined ? undefined : await deps.shopOwner(ctx.tenantId);
        const { builtIn } = rulesInForce(stored, owner);
        // Round 32 · OB-115: every change to a built-in rule is also sent to the owner — a notice on his alert board, which the
        // ops-alert worker delivers to his inbox (and phone, when a message provider is set) on its next pass. Kept, never deleted.
        let noticeTo: string | undefined;
        if (builtInChanges.length > 0 && owner !== undefined) {
          const alertId = `${BUILT_IN_RULE_CHANGED_NOTICE}:v${stored.version}`;
          const alert: RaisedAlert = {
            alertId, component: 'alert_rules_built_in', status: 'degraded', ownerUserId: owner.userId, ownerName: owner.name,
            detail: `a built-in alert rule was changed by ${ctx.userId} at ${definedAt} (rules version ${stored.version}): ${builtInChanges.join('; ')}. Now: ${builtIn.map((b) => `${b.alertId} is ${b.state}${b.rule === undefined ? '' : `, to ${b.rule.ownerName}`}`).join('; ')}. If you did not make this change, check GET /v1/platform/alert-rules and ask who did (owner decision OB-115)`,
            raisedAt: definedAt,
            ackDueBy: new Date(Date.parse(definedAt) + BUILT_IN_RULE_CHANGED_NOTICE_ACK_MINUTES * 60_000).toISOString().replace(/\.\d{3}Z$/, 'Z'),
          };
          // Round 33 · OB-119: head office's own notice — never collapsed into an alert someone else planted under its id.
          const live = (await deps.alerts(ctx.tenantId)).find((a) => a.alert.alertId === alertId);
          await deps.recordAlertEvent(ctx.tenantId, { alertId, change: 'raised', by: ctx.userId, at: definedAt, alert, origin: 'built-in-rule' }, raiseKey(alertId, live, true));
          noticeTo = owner.userId;
        }
        // The reply says, every time, the state of each built-in rule after this save — so a rule left OFF by an earlier
        // version is never kept off unseen by whoever saves next (round 32 · OB-115).
        const stillOff = builtIn.filter((b) => b.state === 'off').map((b) => b.alertId);
        return {
          status: 200,
          body: {
            version: stored.version, rules: rules.length, components: [...new Set(rules.map((r) => r.component))],
            ...(stored.builtInOff === undefined ? {} : { builtInOff: stored.builtInOff }),
            builtIn, builtInChanged: builtInChanges,
            ...(noticeTo === undefined ? {} : { ownerNotified: noticeTo }),
            ...(stillOff.length === 0 || builtInChanges.length > 0 ? {} : {
              builtInStillOff: `${stillOff.join(', ')} ${stillOff.length === 1 ? 'is' : 'are'} still TURNED OFF (by ${stored.builtInChangedBy ?? 'an earlier version'}${stored.builtInChangedAt === undefined ? '' : ` at ${stored.builtInChangedAt}`}) — only the owner can turn ${stillOff.length === 1 ? 'it' : 'them'} back on (builtInOff: [])`,
            }),
          },
        };
      },
    },
    {
      api: 'API-11', method: 'GET', path: '/v1/platform/operational-health/observed',
      permission: 'platform.health.read',
      handler: async (ctx) => {
        const at = deps.now();
        const { stored, observed, health, alerts } = await judge(ctx.tenantId, at);
        return {
          status: 200,
          body: { observed, health, wouldRaise: alerts, rulesVersion: stored?.version ?? null, asAt: at },
        };
      },
    },
    {
      api: 'API-11', method: 'POST', path: '/v1/platform/operational-health/observed/raise',
      permission: 'platform.alert.manage', idempotent: true,
      handler: async (ctx) => {
        const at = deps.now();
        // Round 31 · OB-114: a person's raise needs rules of the owner's own (the built-in ones are raised by the alert worker).
        // Round 33 · OB-119: and it never raises a built-in rule's alert — only the worker does (said in the reply).
        const done = (await deps.alertRules(ctx.tenantId)) === undefined ? undefined : await raiseObservedAlerts(deps, ctx.tenantId, ctx.userId, at, { builtIn: false });
        if (done === undefined || done.stored === undefined) {
          throw apiError(409, {
            code: 'alert_rules_not_defined',
            whatHappened: 'No alert rules are defined for this shop, so nothing can be raised — an alert without a named owner is noise nobody answers (§32).',
            wasItSaved: 'not_saved',
            nextSafeAction: 'Define the rules first (PUT /v1/platform/alert-rules: who owns which component, at what status, how soon they must acknowledge). Nothing was raised.',
          });
        }
        const { stored, observed, health, newlyOpened, builtInLeftToWorker } = done;
        const alerts = done.alerts.filter((a) => !isReservedAlertId(a.alertId));
        return {
          status: 200,
          body: {
            raised: alerts.length, newlyOpened, alerts, health, observed, rulesVersion: stored.version, at,
            ...(builtInLeftToWorker === 0 ? {} : { builtInLeftToWorker: `${builtInLeftToWorker} built-in alert(s) firing now are raised only by head office's alert worker, to the owner (owner decision OB-119) — not by this request` }),
          },
        };
      },
    },
    {
      api: 'API-11', method: 'POST', path: '/v1/platform/backups/:backupId/taken',
      permission: 'platform.backup.record', idempotent: true,
      handler: async (ctx) => {
        const backupId = ctx.params['backupId'] ?? '';
        // PA-12 round 7: only the backup job's own machine identity reports a backup — every PERSON is refused, the
        // owner included, so nobody can hand-post a "good, encrypted, off-site" night and silence the missed-backup
        // alarm. (M35-FR-01 names no human path for recording a backup; drills are recorded separately, `backup.drill.record`.)
        if (deps.isBackupJob === undefined || !(await deps.isBackupJob(ctx.tenantId, ctx.userId, ctx.reauth))) {
          throw apiError(403, {
            code: 'not_the_backup_job',
            whatHappened: 'A backup is recorded only by the backup job itself, signed in as its own machine identity — never from a person\'s sign-in, whoever they are. '
              + 'A backup somebody typed in is not evidence that a backup ran.',
            wasItSaved: 'not_saved',
            nextSafeAction: 'Nothing was recorded. Let the backup job report its own outcome; if it has not, the missed-backup alert is the true picture.',
          });
        }
        const b = (ctx.body ?? {}) as Record<string, unknown>;
        if (!isIso(b['at']) || !isBool(b['ok']) || !isBool(b['encrypted']) || !isBool(b['offsite'])
          || (b['sizeBytes'] !== undefined && (!Number.isInteger(b['sizeBytes']) || (b['sizeBytes'] as number) < 0))
          || (b['detail'] !== undefined && !isStr(b['detail']))
          || (b['endedAt'] !== undefined && (!isIso(b['endedAt']) || Date.parse(b['endedAt']) < Date.parse(b['at'] as string)))
          || (b['checksum'] !== undefined && !(typeof b['checksum'] === 'string' && /^sha256:[0-9a-f]{64}$/.test(b['checksum'])))) {
          throw apiError(400, {
            code: 'not_readable_as_a_backup_record',
            whatHappened: 'A backup record needs when it ran (ISO time) and whether it completed (ok), was encrypted and was copied off-site; optionally its size in bytes, when it ended (not before it ran), its checksum (sha256:<64 hex>) and a detail.',
            wasItSaved: 'not_saved',
            nextSafeAction: 'Send the four facts about the backup. Nothing was recorded.',
          });
        }
        if ((await deps.backups(ctx.tenantId)).some((x) => x.backupId === backupId)) {
          throw apiError(409, {
            code: 'backup_already_recorded',
            whatHappened: `${backupId} is already on the record. A backup is recorded once.`,
            wasItSaved: 'not_saved',
            nextSafeAction: 'Record the next backup under its own id. Nothing was changed.',
          });
        }
        const record: BackupRecord = {
          backupId, at: b['at'], ok: b['ok'], encrypted: b['encrypted'], offsite: b['offsite'],
          ...(Number.isInteger(b['sizeBytes']) ? { sizeBytes: b['sizeBytes'] as number } : {}),
          ...(isIso(b['endedAt']) ? { endedAt: b['endedAt'] } : {}),
          ...(typeof b['checksum'] === 'string' ? { checksum: b['checksum'] } : {}),
          ...(isStr(b['detail']) ? { detail: b['detail'] } : {}),
          recordedBy: ctx.userId, recordedAt: deps.now(),
        };
        await deps.recordBackup(ctx.tenantId, record);
        return {
          status: 201,
          body: {
            backupId, counts: goodBackup(record),
            ...(goodBackup(record) ? {} : { why: [
              ...(record.ok ? [] : ['it did not complete']),
              ...(record.encrypted ? [] : ['it is not encrypted']),
              ...(record.offsite ? [] : ['it has no off-site copy']),
            ] }),
          },
        };
      },
    },
  ];
}
