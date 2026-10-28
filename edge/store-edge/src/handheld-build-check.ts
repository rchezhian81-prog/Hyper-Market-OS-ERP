// THE STORE COMPUTER WRITES WHICH BUILD MADE EACH HANDHELD RECORD, AND MARKS A BARRED ONE (Round 9 · OB-537 · M33-FR-02 ·
// D12-FR-03 · P-01 · P-08 · hard rules #1, #6, #10).
//
// As round 7 did for till sales (OB-501, `stampVersionCheck`), the box judges the build a handheld record reports against the
// version policy in ITS signed pack — so it holds with the line down — and MARKS the record when that build should not have
// started new work (withdrawn, or below the minimum), or when it reported none while a policy is in force. It never refuses
// the record for it (the work was done; refusing it after the fact would only lose it), and it says so in its log.
//
//   • warehouse, picker, driver: the build rides on the record the box keeps on its disk and sends to head office
//     (`handheldBuild` on the payload, written AFTER the decision seal so the seal still covers exactly the record);
//   • queue till: its basket stays on the box, so the box keeps the build on the basket and queues a short build report for
//     head office (`QueueBasketBuildReported`, its build as `reportedBuild` — a report, not a record whose build head office
//     takes off) on the same device-events log, cursor, dedupe set and dead-letter queue.
//
// Nothing here is on the till's sale path.

import { makeEvent, type DomainEvent } from '../../../packages/contracts/src/event';
import type { SyncOutbox } from '../../../packages/sync/src/outbox';
import { isHandheldSource } from '../../../packages/sync/src/device-relay';
import { storeComputerBuildOf, withHandheldBuild, type HandheldBuild } from '../../../packages/platform-admin/src/handheld-build';
import type { QueueBasket } from '../../../packages/suspended-sales/src/queue-basket';
import { commitLocally, type DurableLog } from './durability';

/** The event type of a queue till basket's build report to head office. */
export const QUEUE_BASKET_BUILD_REPORTED = 'QueueBasketBuildReported';

const isObj = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === 'object' && !Array.isArray(v);

/** The words the box's log says for a flagged record — the event and the build, never a person's credential. */
export function flaggedBuildLine(build: HandheldBuild, what: string): string | undefined {
  const mark = build.storeComputerVersionCheck;
  if (mark === undefined) return undefined;
  return `${what} from the ${build.client.replace('_', ' ')} was made on app ${build.appVersion ?? '(no version reported)'} — ${mark.verdict.replace(/_/g, ' ')}; kept and marked for head office.`;
}

/**
 * A warehouse, picker or driver record as the box keeps and sends it: with the build it reported (or `null`) and the box's
 * mark. Any `handheldBuild` the device put in the payload itself is replaced — only the box writes it. Other sources, and a
 * payload that is not an object, are returned untouched.
 */
export function withBoxHandheldBuild(event: DomainEvent, source: string, appVersion: string | undefined, packPolicy: unknown, say: (line: string) => void): DomainEvent {
  if (!isHandheldSource(source) || !isObj(event.payload)) return event;
  const build = storeComputerBuildOf(source, appVersion ?? null, packPolicy);
  const line = flaggedBuildLine(build, `${event.type} ${event.idempotencyKey}`);
  if (line !== undefined) say(line);
  return Object.freeze({ ...event, payload: Object.freeze(withHandheldBuild(event.payload, build)) });
}

/**
 * OB-537: a queue till basket's build report — written to the device-events log (fsync'd) and only then queued for head
 * office, once per basket (a re-sent hand-over is the same basket and reports nothing again). A failed write is said in the
 * log and leaves the build on the basket's own record on the disk — never silently lost.
 */
export function queueBasketBuildReporter(deps: {
  readonly tenantId: string;
  readonly keys: Set<string>;
  readonly log: DurableLog;
  readonly outbox: SyncOutbox;
  readonly say: (line: string) => void;
}): (basket: QueueBasket) => Promise<void> {
  return async (basket) => {
    const build = basket.handheldBuild;
    if (build === undefined) return;
    const line = flaggedBuildLine(build, `queue basket ${basket.basketId}`);
    if (line !== undefined) deps.say(line);
    const key = `queue-basket-build-${deps.tenantId}-${basket.handheldLane}-${basket.basketId}`;
    if (deps.keys.has(key)) return;
    const event = makeEvent({
      id: `queue-basket-build-${basket.handheldLane}-${basket.basketId}`, type: QUEUE_BASKET_BUILD_REPORTED, occurredAt: basket.handedOverAt,
      idempotencyKey: key, source: 'edge/queue-pos',
      payload: { basketId: basket.basketId, handheldLane: basket.handheldLane, handedOverBy: basket.handedOverBy, handedOverAt: basket.handedOverAt, lineCount: basket.lines.length, reportedBuild: build },
    });
    deps.keys.add(key);
    const outcome = await commitLocally({ saleId: key, record: JSON.stringify(event), log: deps.log });
    if (!outcome.committed) {
      deps.keys.delete(key);
      deps.say(`queue basket ${basket.basketId}: its build report for head office could not be written (${outcome.detail}). The build is kept on the basket's own record on this computer — raise this.`);
      return;
    }
    deps.outbox.enqueue(event);
  };
}
