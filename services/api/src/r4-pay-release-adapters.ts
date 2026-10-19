// R4 · OB-228 — the owner's hard pay-release switch, on head office's durable store. One append-only stream; the
// switch as it stands is the latest event (hard rule #2: every earlier setting stays). No event → OFF.

import { createHash } from 'node:crypto';
import { makeEvent } from '../../../packages/contracts/src/event';
import type { EventStore } from '../../../packages/persistence/src/event-store';
import type { PayReleaseSwitch, PayReleaseSwitchDeps, PayReleaseSwitchedOn } from '../../finance/src/pay-release-switch';
import { STREAM, streamName } from './adapters';

export const PAY_RELEASE_SWITCH_STREAM = streamName(STREAM.payroll, 'release-switch');
const TYPE = 'PayReleaseSwitched';
const digest = (s: string): string => createHash('sha256').update(s).digest('hex').slice(0, 24);

export function payReleaseSwitchAdapter(input: { readonly store: EventStore; readonly now: () => string }): Omit<PayReleaseSwitchDeps, 'recordAudit'> {
  const { store, now } = input;
  return {
    now,
    current: async (tenantId) => (await store.readStream(tenantId, PAY_RELEASE_SWITCH_STREAM, { type: TYPE })).map((e) => e.event.payload as PayReleaseSwitch).at(-1),
    record: async (tenantId, s) => {
      const key = digest(`${s.at}|${s.by}|${s.on}|${s.reason}`);
      await store.append(tenantId, PAY_RELEASE_SWITCH_STREAM, makeEvent({
        id: `pay-release-switch-${key}`, type: TYPE, occurredAt: s.at, idempotencyKey: `pay-release-switch-${tenantId}-${key}`, source: 'api/hr', payload: s,
      }));
    },
  };
}

/** What the release routes are handed: ON only when the latest recorded setting says on. */
export function payReleaseSwitchedOn(input: { readonly store: EventStore; readonly now: () => string }): PayReleaseSwitchedOn {
  const a = payReleaseSwitchAdapter(input);
  return async (tenantId) => (await a.current(tenantId))?.on === true;
}
