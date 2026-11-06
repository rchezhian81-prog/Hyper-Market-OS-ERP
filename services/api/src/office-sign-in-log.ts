// D13-FR-06 (W3): head office KEEPS each failed office sign-in and each lockout (`services/kernel/src/sign-in-attempts.ts`)
// on its append-only event ledger, on the stream of the shop the refused token claimed — so the security report reads real
// figures that survive a restart and are the same on every instance (P-08). The lockout itself stays in the API's memory.
//
// A try whose token names no shop that head office keeps (unreadable, or a shop never registered) cannot be put on any
// shop's record: it is said on the operator's log by its outcome, source class and path — never dropped without a word,
// and never with the token. It is still on the audit trail as the refused request it was.

import { randomUUID } from 'node:crypto';
import { makeEvent } from '../../../packages/contracts/src/event';
import type { EventStore } from '../../../packages/persistence/src/event-store';
import type { OfficeSignInAttempt, SignInAttemptLog } from '../../kernel/src/sign-in-attempts';
import { STREAM, streamName } from './adapters';

/** The stream (a function: `adapters` and the report producers import each other, so nothing is read at load time). */
export const officeSignInStream = (): string => streamName(STREAM.identity, 'office-sign-in-attempts');
export const OFFICE_SIGN_IN_TYPE = 'OfficeSignInAttemptRecorded';

export function officeSignInLogAdapter(input: { readonly store: EventStore; readonly log?: (line: string) => void }): SignInAttemptLog {
  const say = (a: OfficeSignInAttempt, why: string): void => {
    input.log?.(`office sign-in ${a.outcome} from a ${a.sourceClass} address (${a.sourceNetwork}) on ${a.path} at ${a.at} was not kept on a shop's record: ${why}\n`);
  };
  return {
    record: async (a) => {
      if (a.claimedTenantId === null) { say(a, 'the token names no shop'); return; }
      const id = randomUUID();
      try {
        await input.store.append(a.claimedTenantId, officeSignInStream(), makeEvent({
          id: `office-sign-in-${id}`, type: OFFICE_SIGN_IN_TYPE, occurredAt: a.at,
          idempotencyKey: `office-sign-in-${a.claimedTenantId}-${id}`, source: 'api/identity',
          payload: a as unknown as Record<string, unknown>,
        }));
      } catch (e) {
        say(a, (e as Error | undefined)?.name === 'TenantNotRegisteredError' ? 'the shop it names is not one head office keeps' : `the ledger refused it (${(e as Error | undefined)?.message ?? 'unknown'})`);
      }
    },
  };
}

/** Every kept office sign-in attempt of one shop, with the time it was made. */
export async function officeSignInRecords(store: EventStore, tenantId: string): Promise<readonly { readonly p: OfficeSignInAttempt; readonly at: string }[]> {
  return (await store.readStream(tenantId, officeSignInStream(), { type: OFFICE_SIGN_IN_TYPE })).map((e) => ({ p: e.event.payload as unknown as OfficeSignInAttempt, at: e.event.occurredAt }));
}
