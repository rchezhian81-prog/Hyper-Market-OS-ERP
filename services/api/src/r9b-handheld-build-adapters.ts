// R9-B · head office FLAGS handheld work done on a withdrawn or too-old build (Round 9 · OB-537 · M33-FR-02 · D12-FR-03 ·
// A-10 · P-03 · P-08 · hard rules #6, #10). Import and registration lines only in `main.ts`; permission codes in roles.ts's
// marked block.
//
// Round 7 made head office raise a till sale rung on a barred build (`sold_on_an_unsupported_app_version`, OB-501). OB-537
// does the same for the handhelds: every handheld record now carries the build that made it (`handheldBuild`, written by
// the store computer with its own mark), and head office judges that build against ITS OWN version policy:
//
//   • warehouse, picker and driver records reach head office on their own relay routes (each `…/synced`). This wraps the
//     store-computer binding (the kernel's guard on every store-computer request) so that, on any write that carries
//     `handheldBuild`, the field is TAKEN OFF before the route's handler reads the body — every handler, its checks and the
//     store's decision seal see exactly the record the person made — and, once the handler has ACCEPTED the record, a
//     finding is appended when the build is barred. The record is never refused for its build (the work happened; refusing
//     it after the fact would only lose it). A record the handler refuses for its own reasons stays a visible dead letter
//     on the store computer, as before;
//   • a queue till's basket stays on the store computer, so the box sends its build report
//     (`POST /v1/platform/handheld-work/queue-baskets/:basketId/build/synced`), judged the same way;
//   • `GET /v1/platform/handheld-work/version-exceptions` lists the findings (material listed, informational counted), from
//     head office's append-only register — the same readers as the store-computer refusal list.
//
// Nothing here changes a version, a record, stock or money (P-05).

import { createHash } from 'node:crypto';
import type { BoundStoreGuard, Route } from '../../kernel/src/index';
import { apiError } from '../../kernel/src/index';
import type { EventStore } from '../../../packages/persistence/src/event-store';
import { makeEvent } from '../../../packages/contracts/src/event';
import { judgeHandheldBuild, readHandheldBuild, withoutHandheldBuild, type HandheldBuild, type HandheldBuildFinding } from '../../../packages/platform-admin/src/handheld-build';
import { STREAM, streamName, versionPolicyAdapter } from './adapters';

export const HANDHELD_BUILD_EXCEPTIONS_PATH = '/v1/platform/handheld-work/version-exceptions';
export const QUEUE_BASKET_BUILD_PATH = '/v1/platform/handheld-work/queue-baskets/:basketId/build/synced';
/** The store computer's own narrow word for the queue basket build report. */
export const HANDHELD_BUILD_SYNC_PERMISSION = 'platform.handheldbuild.sync';
/** Who reads the findings: the same readers as the store-computer refusal list. */
export const HANDHELD_BUILD_READ_PERMISSION = 'platform.health.read';

/** One finding on head office's register: work a handheld did on a build that should not have started it. */
export interface HandheldBuildException extends HandheldBuildFinding {
  readonly exceptionId: string;
  readonly kind: 'handheld_work_on_an_unsupported_app_version';
  /** The route the record arrived on (its kind of work), and the record's own key on it. */
  readonly route: string;
  readonly recordRef: string;
  /** The store whose computer relayed it (its credential's store), when known. */
  readonly store: string | null;
  readonly relayedBy: string;
  readonly at: string;
}

export function handheldBuildExceptionsAdapter(input: { readonly store: EventStore }): {
  record: (tenantId: string, ex: HandheldBuildException) => Promise<void>;
  list: (tenantId: string) => Promise<readonly HandheldBuildException[]>;
} {
  const stream = streamName(STREAM.platform, 'handheld-build-exceptions');
  return {
    // Append-only, once per record: the same record relayed again collapses onto the first finding.
    record: async (tenantId, ex) => {
      await input.store.append(tenantId, stream, makeEvent({
        id: `handheld-build-${ex.exceptionId}`, type: 'HandheldBuildExceptionRaised', occurredAt: ex.at,
        idempotencyKey: `handheld-build-${tenantId}-${ex.exceptionId}`, source: 'api/platform', payload: ex,
      }));
    },
    list: async (tenantId) => (await input.store.readStream(tenantId, stream, { type: 'HandheldBuildExceptionRaised' }))
      .map((e) => e.event.payload as HandheldBuildException),
  };
}

const isObj = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === 'object' && !Array.isArray(v);
const isStr = (v: unknown): v is string => typeof v === 'string' && v.trim() !== '';

/** A short id for one record on one route (a resend of the same record is the same id). */
const exceptionIdOf = (route: string, recordRef: string): string => createHash('sha256').update(JSON.stringify([route, recordRef])).digest('hex').slice(0, 32);

/**
 * The record's own reference on its route: the route's path parameters (or the body's first `…Id`) and a short digest of the
 * record — so the same record relayed again is the same finding, and two different records on one line are two.
 */
function recordRefOf(params: Readonly<Record<string, string>>, body: unknown): string {
  const digest = createHash('sha256').update(JSON.stringify(body ?? null)).digest('hex').slice(0, 12);
  const fromParams = Object.entries(params).map(([k, v]) => `${k}=${v}`).join('&');
  if (fromParams !== '') return `${fromParams}#${digest}`;
  const idKey = isObj(body) ? Object.keys(body).find((k) => /Id$/.test(k) && isStr(body[k])) : undefined;
  return idKey !== undefined && isObj(body) ? `${idKey}=${String(body[idKey])}#${digest}` : `#${digest}`;
}

/** The work, in words, from the route it arrived on (e.g. `/v1/fulfilment/waves/:waveId/lines/:lineId/synced`). */
const workOf = (route: string, recordRef: string): string => `The record ${recordRef.split('#')[0] || '(no id)'} sent to ${route}`;

/**
 * Wrap the store-computer binding: on a WRITE whose body carries `handheldBuild`, take it off before the handler, and after the
 * handler accepted the record, keep a finding when the build is barred by head office's own policy or the store computer's
 * mark. The binding's own verdict (refusal, stamped body, its own after-accept record) is kept exactly.
 */
export function withHandheldBuildCheck(inner: BoundStoreGuard, input: { readonly store: EventStore; readonly now: () => string }): BoundStoreGuard {
  const findings = handheldBuildExceptionsAdapter(input);
  const policies = versionPolicyAdapter({ store: input.store, now: input.now });
  return async (principal, access, request) => {
    const verdict = await inner(principal, access, request);
    if (!verdict.ok || request.method === 'GET') return verdict;
    const base = verdict.stampedBody !== undefined ? verdict.stampedBody : request.body;
    const taken = withoutHandheldBuild(base);
    if (!taken.carried) return verdict;
    const build = taken.build;
    const onAccepted = async (): Promise<void> => {
      if (verdict.onAccepted !== undefined) await verdict.onAccepted();
      if (build === undefined) return;
      const recordRef = recordRefOf(request.params, taken.payload);
      const finding = judgeHandheldBuild(build, await policies.policy(principal.tenantId), workOf(request.routePath, recordRef));
      if (finding === undefined) return;
      await findings.record(principal.tenantId, {
        ...finding, exceptionId: exceptionIdOf(request.routePath, recordRef), kind: 'handheld_work_on_an_unsupported_app_version',
        route: request.routePath, recordRef, store: principal.branchId ?? null, relayedBy: principal.userId, at: input.now(),
      });
    };
    return { ...verdict, stampedBody: taken.payload, onAccepted };
  };
}

/** The register's read and the queue till's build report. */
export function handheldBuildRoutes(input: { readonly store: EventStore | undefined; readonly now: () => string }): readonly Route[] {
  const findings = input.store === undefined ? undefined : handheldBuildExceptionsAdapter({ store: input.store });
  const policies = input.store === undefined ? undefined : versionPolicyAdapter({ store: input.store, now: input.now });
  return [
    {
      api: 'API-10', method: 'GET', path: HANDHELD_BUILD_EXCEPTIONS_PATH,
      permission: HANDHELD_BUILD_READ_PERMISSION,
      handler: async (ctx) => {
        const all = findings === undefined ? [] : await findings.list(ctx.tenantId);
        const material = all.filter((e) => e.severity === 'material');
        return {
          status: 200,
          body: {
            // Control by exception (P-03): the barred-build work is listed; "no build reported" is counted (a device older
            // than the rule cannot report one), with the records behind the count kept on the register.
            material, informational: all.length - material.length, informationalExceptions: all.filter((e) => e.severity === 'informational'),
            asAt: input.now(),
          },
        };
      },
    },
    {
      // A queue till's basket stays on the store computer; its build report is relayed (queued on the box's disk, sent once).
      api: 'API-10', method: 'POST', path: QUEUE_BASKET_BUILD_PATH,
      permission: HANDHELD_BUILD_SYNC_PERMISSION, idempotent: true,
      handler: async (ctx) => {
        const basketId = ctx.params['basketId'] ?? '';
        const b = isObj(ctx.body) ? ctx.body : {};
        const build: HandheldBuild | undefined = readHandheldBuild(b['reportedBuild']);
        if (b['basketId'] !== basketId || !isStr(b['handheldLane']) || !isStr(b['handedOverBy']) || !isStr(b['handedOverAt'])
          || Number.isNaN(Date.parse(String(b['handedOverAt']))) || build === undefined || build.client !== 'queue_till') {
          throw apiError(400, {
            code: 'not_readable_as_a_queue_basket_build',
            whatHappened: 'A queue basket\'s build report needs { basketId (matching the address), handheldLane, handedOverBy, handedOverAt, reportedBuild: { client: "queue_till", appVersion } }.',
            wasItSaved: 'not_saved',
            nextSafeAction: 'Keep it in the store computer\'s queue and raise it. The basket and its build stay on the store computer\'s disk.',
          });
        }
        const recordRef = `${String(b['handheldLane'])}/${basketId}`;
        const finding = policies === undefined ? undefined
          : judgeHandheldBuild(build, await policies.policy(ctx.tenantId), `queue basket ${basketId} (handed over by ${String(b['handedOverBy'])})`);
        if (finding !== undefined && findings !== undefined) {
          await findings.record(ctx.tenantId, {
            ...finding, exceptionId: exceptionIdOf(QUEUE_BASKET_BUILD_PATH, recordRef), kind: 'handheld_work_on_an_unsupported_app_version',
            route: QUEUE_BASKET_BUILD_PATH, recordRef, store: ctx.branchId ?? null, relayedBy: ctx.userId, at: input.now(),
          });
        }
        return { status: 200, body: { basketId, flagged: finding !== undefined, ...(finding === undefined ? {} : { severity: finding.severity, verdict: finding.verdict }) } };
      },
    },
  ];
}
