// W6 · M32-FR-03 ("abnormal usage alerts") · owner decision OB-688 — the composition of the durable daily secret-use count.
//
//   • `secretUseCounter` is the kernel's `credentialUse` sink. It keeps MACHINE credentials only (a caller holding a
//     machine role: the store computer, the backup job, the message-provider relay, the CI scanner, the release script,
//     the floor-device gateway), adds each call to a small in-memory tally, and every few seconds APPENDS the tally to the
//     shop's ledger, one fact per (shop day, credential reference, caller, API) — never overwriting a count (hard rule #2).
//     A tally the ledger refused is kept and tried again on the next flush, and said on the operator's log (P-08); the
//     reply to the caller never waits for it or changes because of it (hard rule #1 for the till is untouched: a till's
//     sale never calls head office). On shutdown the tally is flushed.
//   • `secretUseRollupSweep` is the ops-alert worker's nightly pass: each finished shop day not yet rolled up is judged
//     ONCE with the usage-signals route's own rule (`rollUpSecretUseDay` → `usageSignalsOf`), the roll-up is kept keyed on
//     the day (a second pass never doubles it), a missed night is caught up, and each finding is raised as an operational
//     alert to the IT custodian (the named security reviewer, OB-405) and the owners — the reference, the caller and the
//     counts, never a value.
//
// Nothing here holds a token, a key or any secret value: the kernel hands over the caller id, the credential's reference
// id (the token's own `jti`), the API id, the status and the caller's role ids — and only the first four are kept.

import { randomUUID } from 'node:crypto';
import { makeEvent, type DomainEvent } from '../../../packages/contracts/src/event';
import type { EventStore } from '../../../packages/persistence/src/event-store';
import { shopClock, type ShopCalendarOf } from '../../../packages/calendar/src/shop-clock';
import type { CredentialUse } from '../../kernel/src/index';
import type { AlertLifecycleEvent } from '../../platform/src/alert-lifecycle';
import {
  UNNAMED_CREDENTIAL, addDays, daysToRollUp, rollUpSecretUseDay, secretUseAlertDetail, totalCounts,
  type SecretUseCount, type SecretUseDayRollup,
} from '../../platform/src/secret-use';
import { STREAM, streamName, alertLifecycleAdapter, effectiveGrants } from './adapters';
import { twoSignatureAdapter } from './gates-adapters';
import {
  OWNER_ROLE_ID, STORE_COMPUTER_ROLE_ID, PROVIDER_RELAY_ROLE_ID, BACKUP_JOB_ROLE_ID, FINDINGS_PUSH_ROLE_ID,
  QG10_EVIDENCE_PUSH_ROLE_ID, FLOOR_DEVICE_GATEWAY_ROLE_ID,
} from './roles';

/** The roles only a machine identity holds — a caller holding one of these signs in with a kept machine credential. */
export const MACHINE_CREDENTIAL_ROLES: readonly string[] = Object.freeze([
  STORE_COMPUTER_ROLE_ID, PROVIDER_RELAY_ROLE_ID, BACKUP_JOB_ROLE_ID, FINDINGS_PUSH_ROLE_ID, QG10_EVIDENCE_PUSH_ROLE_ID, FLOOR_DEVICE_GATEWAY_ROLE_ID,
]);

export const SECRET_USE_COUNTED = 'SecretUseCounted';
export const SECRET_USE_DAY_OPENED = 'SecretUseDayOpened';
export const SECRET_USE_ROLLED_UP = 'SecretUseDayRolledUp';
export const SECRET_USE_WORKER = 'system:secret-use-rollup';
export const SECRET_USE_ALERT_PREFIX = 'secret-use:';

/** One shop day's appended counts (one stream per day, so a read of 30 days reads 30 small streams, never all history). */
export const secretUseDayStream = (day: string): string => streamName(STREAM.integration, 'secret-use', day);
/** The days counting has happened on (one fact per day) — where "counting started" is read from. */
export const secretUseDaysStream = (): string => streamName(STREAM.integration, 'secret-use-days');
/** The nightly roll-ups, one per day. */
export const secretUseRollupStream = (): string => streamName(STREAM.integration, 'secret-use-rollups');

interface Base { readonly store: EventStore; readonly now: () => string; readonly calendar?: ShopCalendarOf }

export interface SecretUseCounter {
  /** The kernel's `credentialUse` sink. Synchronous and never throws. */
  readonly record: (use: CredentialUse) => void;
  /** Append everything tallied so far. Resolves once the ledger has it (or has refused it — then it is kept for the next try). */
  readonly flush: () => Promise<number>;
  /** Stop the timer and flush. */
  readonly stop: () => Promise<void>;
}

/** The kernel's credential-use sink: tallies machine credentials' calls and appends them to the ledger every `flushEveryMs`. */
export function secretUseCounter(input: Base & { readonly flushEveryMs?: number; readonly say?: (line: string) => void }): SecretUseCounter {
  const clock = shopClock(input.calendar);
  // tenant ␀ minute ␀ credential ␀ caller ␀ api → counts. The minute is turned into the shop's day at flush (the shop's clock).
  let tally = new Map<string, { calls: number; errors: number }>();
  const knownDays = new Set<string>();
  let flushing: Promise<number> | undefined;

  const record = (use: CredentialUse): void => {
    if (!use.roleIds.some((r) => MACHINE_CREDENTIAL_ROLES.includes(r))) return;
    const ref = use.credentialRef === undefined || use.credentialRef.trim() === '' ? UNNAMED_CREDENTIAL : use.credentialRef;
    const k = [use.tenantId, use.at.slice(0, 16), ref, use.callerId, use.api].join('\u0000');
    const n = tally.get(k) ?? { calls: 0, errors: 0 };
    n.calls += 1;
    if (use.status >= 400) n.errors += 1;
    tally.set(k, n);
  };

  const flushOnce = async (): Promise<number> => {
    if (tally.size === 0) return 0;
    const taken = tally;
    tally = new Map();
    // tenant → (day ␀ credential ␀ caller ␀ api) → counts
    const byTenant = new Map<string, Map<string, { calls: number; errors: number; first: string; last: string }>>();
    for (const [k, n] of taken) {
      const [tenantId = '', minute = '', ref = '', callerId = '', api = ''] = k.split('\u0000');
      const day = await clock.dateOf(tenantId, `${minute}:00.000Z`);
      const groups = byTenant.get(tenantId) ?? new Map();
      const gk = [day, ref, callerId, api].join('\u0000');
      const g = groups.get(gk) ?? { calls: 0, errors: 0, first: minute, last: minute };
      g.calls += n.calls; g.errors += n.errors;
      if (minute < g.first) g.first = minute;
      if (minute > g.last) g.last = minute;
      groups.set(gk, g);
      byTenant.set(tenantId, groups);
    }
    let kept = 0;
    for (const [tenantId, groups] of byTenant) {
      const at = input.now();
      const entries = [...groups].flatMap(([gk, g]) => {
        const [day = '', credentialRef = '', callerId = '', api = ''] = gk.split('\u0000');
        const id = `secret-use-${randomUUID()}`;
        const payload: SecretUseCount & { readonly firstMinute: string; readonly lastMinute: string } = { day, credentialRef, callerId, api, calls: g.calls, errors: g.errors, firstMinute: g.first, lastMinute: g.last };
        const out: { stream: string; event: DomainEvent }[] = [{ stream: secretUseDayStream(day), event: makeEvent({ id, type: SECRET_USE_COUNTED, occurredAt: at, idempotencyKey: id, source: 'api/secret-use', payload }) as DomainEvent }];
        if (!knownDays.has(`${tenantId}\u0000${day}`)) {
          out.push({ stream: secretUseDaysStream(), event: makeEvent({ id: `secret-use-day-${day}`, type: SECRET_USE_DAY_OPENED, occurredAt: at, idempotencyKey: `secret-use-day-${tenantId}-${day}`, source: 'api/secret-use', payload: { day } }) as DomainEvent });
        }
        return out;
      });
      try {
        await input.store.appendBatch(tenantId, entries);
        for (const [gk] of groups) knownDays.add(`${tenantId}\u0000${gk.split('\u0000')[0]}`);
        kept += groups.size;
      } catch (e) {
        // Kept for the next flush — a count is never dropped without a word (P-08).
        for (const [k, n] of taken) {
          if (!k.startsWith(`${tenantId}\u0000`)) continue;
          const now = tally.get(k) ?? { calls: 0, errors: 0 };
          tally.set(k, { calls: now.calls + n.calls, errors: now.errors + n.errors });
        }
        input.say?.(`secret use: the count for shop ${tenantId} was not kept this time (${(e as Error | undefined)?.message ?? 'unknown'}); it is kept in memory and tried again`);
      }
    }
    return kept;
  };

  const flush = async (): Promise<number> => {
    while (flushing !== undefined) await flushing;
    flushing = flushOnce();
    try { return await flushing; } finally { flushing = undefined; }
  };

  const timer = input.flushEveryMs === undefined || input.flushEveryMs <= 0 ? undefined : setInterval(() => { void flush(); }, input.flushEveryMs);
  timer?.unref?.();
  return {
    record,
    flush,
    stop: async () => { if (timer !== undefined) clearInterval(timer); await flush(); },
  };
}

/** Every appended count of the days `from`..`to` (inclusive), as kept. */
export async function secretUseCounts(store: EventStore, tenantId: string, from: string, to: string): Promise<readonly SecretUseCount[]> {
  const out: SecretUseCount[] = [];
  for (let d = from; d <= to; d = addDays(d, 1)) {
    for (const e of await store.readStream(tenantId, secretUseDayStream(d), { type: SECRET_USE_COUNTED })) {
      const p = e.event.payload as unknown as SecretUseCount;
      out.push({ day: p.day, credentialRef: p.credentialRef, callerId: p.callerId, api: p.api, calls: p.calls, errors: p.errors });
    }
  }
  return out;
}

export async function secretUseRollups(store: EventStore, tenantId: string): Promise<readonly SecretUseDayRollup[]> {
  return (await store.readStream(tenantId, secretUseRollupStream(), { type: SECRET_USE_ROLLED_UP })).map((e) => e.event.payload as unknown as SecretUseDayRollup);
}

async function firstCountedDay(store: EventStore, tenantId: string): Promise<string | undefined> {
  const days = (await store.readStream(tenantId, secretUseDaysStream(), { type: SECRET_USE_DAY_OPENED })).map((e) => (e.event.payload as { day: string }).day).sort();
  return days[0];
}

/** The deps the secrets routes read the use list through. */
export function secretUseReads(input: { readonly store: EventStore }): { readonly counts: (t: string, from: string, to: string) => Promise<readonly SecretUseCount[]>; readonly rollups: (t: string) => Promise<readonly SecretUseDayRollup[]> } {
  return { counts: (t, from, to) => secretUseCounts(input.store, t, from, to), rollups: (t) => secretUseRollups(input.store, t) };
}

/** Who hears of abnormal secret use: the named IT custodian (the security reviewer, OB-405) first, and every owner. */
async function recipients(store: EventStore, now: () => string, tenantId: string): Promise<{ readonly owner: string; readonly ownerName: string; readonly also: readonly string[]; readonly custodianNamed: boolean } | undefined> {
  const custodian = await twoSignatureAdapter({ store, now }).twoSignature.reviewer(tenantId);
  const owners = [...new Set((await effectiveGrants(store, tenantId)).filter((g) => g.roleId === OWNER_ROLE_ID).map((g) => g.userId))].sort();
  const people = [...new Set([...(custodian === undefined ? [] : [custodian.userId]), ...owners])];
  if (people.length === 0) return undefined;
  return { owner: people[0]!, ownerName: custodian?.displayName ?? people[0]!, also: people.slice(1), custodianNamed: custodian !== undefined };
}

export const secretUseAlertId = (day: string, callerId: string, api: string, signal: string): string => `${SECRET_USE_ALERT_PREFIX}${day}:${callerId}:${api}:${signal}`;

/**
 * The ops-alert worker's nightly pass: judge each finished shop day not yet rolled up (catching up missed nights, at most
 * the last 31), keep the roll-up once per day, and raise each finding to the IT custodian. Answers the alerts raised.
 */
export function secretUseRollupSweep(input: Base & { readonly maxDays?: number }): (tenantId: string, at: string) => Promise<number> {
  const clock = shopClock(input.calendar);
  return async (tenantId, at) => {
    const today = await clock.dateOf(tenantId, at);
    const yesterday = addDays(today, -1);
    const first = await firstCountedDay(input.store, tenantId);
    const rolledUp = new Set((await secretUseRollups(input.store, tenantId)).map((r) => r.day));
    const days = daysToRollUp({ firstCountedDay: first, yesterday, rolledUp, ...(input.maxDays === undefined ? {} : { maxDays: input.maxDays }) });
    if (days.length === 0 || first === undefined) return 0;
    const lifecycle = alertLifecycleAdapter({ store: input.store, now: input.now });
    let raised = 0;
    for (const day of days) {
      const counts = totalCounts(await secretUseCounts(input.store, tenantId, addDays(day, -7), day));
      const rollup = rollUpSecretUseDay({ day, counts, firstCountedDay: first, at });
      // Alerts first, each idempotent on its own id; then the roll-up, keyed on the day. A crash in between re-judges the
      // same closed day next pass, finds the alerts already open, and keeps the roll-up — never a double.
      const to = rollup.findings.length === 0 ? undefined : await recipients(input.store, input.now, tenantId);
      for (const f of rollup.findings) {
        if (to === undefined) break;
        const alertId = secretUseAlertId(day, f.identityId, f.api, f.signal);
        const live = (await lifecycle.alerts(tenantId)).find((a) => a.alert.alertId === alertId);
        if (live !== undefined) continue;
        const detail = `${secretUseAlertDetail(f, rollup, counts)}${to.custodianNamed ? '' : ' Nobody is named as the IT custodian (the security reviewer), so this went to the owners.'}`;
        const event: AlertLifecycleEvent = {
          alertId, change: 'raised', by: SECRET_USE_WORKER, at,
          alert: {
            alertId, component: `Secret use · ${f.identityId} · ${f.api}`, status: 'degraded', ownerUserId: to.owner, ownerName: to.ownerName,
            detail, raisedAt: at, ackDueBy: at, ...(to.also.length === 0 ? {} : { alsoToUserIds: to.also }),
          },
        };
        await lifecycle.recordAlertEvent(tenantId, event, `${alertId}|raised`);
        raised += 1;
      }
      await input.store.append(tenantId, secretUseRollupStream(), makeEvent({
        id: `secret-use-rollup-${day}`, type: SECRET_USE_ROLLED_UP, occurredAt: at,
        idempotencyKey: `secret-use-rollup-${tenantId}-${day}`, source: 'api/secret-use', payload: rollup as never,
      }));
    }
    return raised;
  };
}
