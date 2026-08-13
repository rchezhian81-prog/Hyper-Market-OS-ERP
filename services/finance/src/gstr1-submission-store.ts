// API-09 GST return SUBMISSION — the durable, safe filing boundary (owner directive item 1), on the tested
// `packages/finance` submission-safety engine. Each filing period's GSTR-1 submission is an append-only
// event stream folded into its current state; every transition is checked against the STORED state before
// anything is written, so the safety controls (maker ≠ checker, duplicate prevention, digest match, period
// lock, reconcile-with-evidence) hold at the write boundary, not just in a preview.
//
//   • POST …/gstr1/submission/:period/preview          — a maker records the exact figures to file (a digest).
//   • POST …/gstr1/submission/:period/approve          — a DIFFERENT person approves them (maker ≠ checker).
//   • POST …/gstr1/submission/:period/submit           — file the approved return. LIVE is off by default and
//                                                        killable; the SANDBOX simulator runs otherwise.
//   • POST …/gstr1/submission/:period/record-response  — apply a portal answer (the async/webhook path).
//   • GET  …/gstr1/submission/:period                  — the current folded state.
//
// NO live submission occurs until CA/legal + production credentials + owner GO: the live path is gated by
// the portal kill-switch and, until a certified connector exists, refuses; the sandbox is non-fileable.

import type { Route } from '../../kernel/src/index';
import { apiError, notFound } from '../../kernel/src/index';
import {
  evaluateGstr1SubmissionTransition, sandboxGstnProvider,
  type Gstr1SubmissionAggregate, type Gstr1SubmissionEvent, type GstnSubmitStatus, type GstnSubmitResult,
} from '../../../packages/finance/src/index';
import { requireGstPortalLive, GstPortalDisabledError, type GstPortalControls } from '../../../packages/e-invoice/src/index';

const FP = /^\d{6}$/;
const GSTIN = /^[0-9]{2}[A-Z]{5}[0-9]{4}[A-Z][1-9A-Z]Z[0-9A-Z]$/;
const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null;
const OUTCOMES: readonly GstnSubmitStatus[] = ['acknowledged', 'failed', 'unknown'];

export interface Gstr1SubmissionStoreDeps {
  readonly load: (tenantId: string, period: string) => Promise<Gstr1SubmissionAggregate | undefined> | Gstr1SubmissionAggregate | undefined;
  readonly append: (tenantId: string, period: string, event: Gstr1SubmissionEvent) => Promise<void> | void;
  readonly now: () => string;
}

/** Map a refusal to an HTTP status: nothing-to-act-on is 404, everything else is a 422 conflict. */
const statusFor = (refusal: string | undefined): number => (refusal === 'no_submission' ? 404 : refusal === 'invalid_period' ? 400 : 422);

export function gstr1SubmissionRoutes(deps: Gstr1SubmissionStoreDeps): readonly Route[] {
  return [
    {
      // A maker previews the exact figures to file and records their digest. Idempotent per period.
      api: 'API-09', method: 'POST', path: '/v1/finance/gstr1/submission/:period/preview',
      permission: 'finance.gstr.generate', idempotent: true,
      handler: async (ctx) => {
        const period = ctx.params['period'] ?? '';
        const b = (ctx.body ?? {}) as Record<string, unknown>;
        if (!FP.test(period)) throw apiError(400, { code: 'submission_needs_period', whatHappened: 'The filing period in the path must be MMYYYY.', wasItSaved: 'not_saved', nextSafeAction: 'Call the route with the filing month as MMYYYY.' });
        if (typeof b['returnDigest'] !== 'string' || b['returnDigest'].trim() === '') {
          throw apiError(400, { code: 'preview_needs_digest', whatHappened: 'A preview needs returnDigest — a stable digest of the exact figures to file.', wasItSaved: 'not_saved', nextSafeAction: 'Compute a digest of the return JSON and send it as returnDigest.' });
        }
        const current = await deps.load(ctx.tenantId, period);
        const decision = evaluateGstr1SubmissionTransition({ ...(current !== undefined ? { current } : {}), action: 'preview', actor: ctx.userId, period });
        if (!decision.allowed) throw apiError(statusFor(decision.refusal), { code: `submission_${decision.refusal}`, whatHappened: decision.reason, wasItSaved: 'not_saved', nextSafeAction: 'A filed or in-flight period cannot be re-previewed — reconcile it, or amend in a later period.' });
        await deps.append(ctx.tenantId, period, {
          kind: 'previewed', period, returnDigest: b['returnDigest'], by: ctx.userId, at: deps.now(),
          ...(typeof b['summary'] === 'string' ? { summary: b['summary'] } : {}),
        });
        return { status: 201, body: { period, current: await deps.load(ctx.tenantId, period) } };
      },
    },
    {
      // A DIFFERENT person than the maker approves the previewed figures (maker ≠ checker, §28).
      api: 'API-09', method: 'POST', path: '/v1/finance/gstr1/submission/:period/approve',
      permission: 'finance.gstr.approve', idempotent: true,
      handler: async (ctx) => {
        const period = ctx.params['period'] ?? '';
        const current = await deps.load(ctx.tenantId, period);
        const decision = evaluateGstr1SubmissionTransition({ ...(current !== undefined ? { current } : {}), action: 'approve', actor: ctx.userId });
        if (!decision.allowed) throw apiError(statusFor(decision.refusal), { code: `submission_${decision.refusal}`, whatHappened: decision.reason, wasItSaved: 'not_saved', nextSafeAction: 'The approver must be a different person than the maker, and the return must be previewed.' });
        await deps.append(ctx.tenantId, period, { kind: 'approved', by: ctx.userId, at: deps.now() });
        return { status: 200, body: { period, current: await deps.load(ctx.tenantId, period) } };
      },
    },
    {
      // File the approved return. Body: { digest, gstin, live?, controls?, sandbox? }. The digest must match
      // the approved figures. LIVE is refused unless the portal is enabled AND not killed (default: off); the
      // deterministic SANDBOX simulator runs otherwise and returns a non-fileable reference.
      api: 'API-09', method: 'POST', path: '/v1/finance/gstr1/submission/:period/submit',
      permission: 'finance.gstr.submit', idempotent: true,
      handler: async (ctx) => {
        const period = ctx.params['period'] ?? '';
        const b = (ctx.body ?? {}) as Record<string, unknown>;
        if (typeof b['gstin'] !== 'string' || !GSTIN.test(b['gstin'])) {
          throw apiError(400, { code: 'submit_needs_gstin', whatHappened: 'Submitting needs the supplier gstin.', wasItSaved: 'not_saved', nextSafeAction: 'Send the supplier’s own GSTIN.' });
        }
        const digest = typeof b['digest'] === 'string' ? (b['digest'] as string) : undefined;
        const current = await deps.load(ctx.tenantId, period);
        const decision = evaluateGstr1SubmissionTransition({ ...(current !== undefined ? { current } : {}), action: 'submit', actor: ctx.userId, ...(digest !== undefined ? { digest } : {}) });
        if (!decision.allowed) throw apiError(statusFor(decision.refusal), { code: `submission_${decision.refusal}`, whatHappened: decision.reason, wasItSaved: 'not_saved', nextSafeAction: 'Only an approved return whose figures still match the approved digest can be filed, and never twice.' });
        // The gate: a LIVE filing is refused unless enabled and not killed — off by default, and no certified
        // connector exists yet, so live is blocked. The sandbox never consults the gate (non-fileable output).
        if (b['live'] === true) {
          const controls = (isObj(b['controls']) ? b['controls'] : {}) as GstPortalControls;
          try {
            requireGstPortalLive(controls, 'gst_return');
          } catch (err) {
            if (err instanceof GstPortalDisabledError) throw apiError(403, { code: 'gst_return_live_disabled', whatHappened: err.gate.detail, wasItSaved: 'not_saved', nextSafeAction: 'Live GST-return filing is off — use the sandbox, or enable it once credentials and CA/legal sign-off are in place.' });
            throw err;
          }
          // Even with the gate open, there is no certified connector wired — a live filing cannot proceed yet.
          throw apiError(503, { code: 'gst_return_live_not_wired', whatHappened: 'the live GSTN connector is not wired — live filing is externally blocked pending production credentials', wasItSaved: 'not_saved', nextSafeAction: 'Use the sandbox until the certified-GSP connector and credentials are deployed.' });
        }
        // Record the submission (state → submitting). An `async: true` submission hands off to a portal that
        // answers later (the webhook/poller path) and stops here; the answer arrives via /record-response.
        await deps.append(ctx.tenantId, period, { kind: 'submitted', by: ctx.userId, at: deps.now() });
        if (b['async'] === true) {
          return { status: 202, body: { period, sandbox: true, awaitingResponse: true, current: await deps.load(ctx.tenantId, period) } };
        }
        // Synchronous sandbox: run the deterministic portal and record its answer in the same call.
        const sandbox = isObj(b['sandbox']) ? b['sandbox'] : {};
        const provider = sandboxGstnProvider({
          ...(typeof sandbox['forceOutcome'] === 'string' && OUTCOMES.includes(sandbox['forceOutcome'] as GstnSubmitStatus) ? { forceOutcome: sandbox['forceOutcome'] as GstnSubmitStatus } : {}),
          ...(typeof sandbox['failCode'] === 'string' ? { failCode: sandbox['failCode'] as string } : {}),
          ...(typeof sandbox['unknownReason'] === 'string' ? { unknownReason: sandbox['unknownReason'] as string } : {}),
        });
        const result = provider.submit({ gstin: b['gstin'], period, returnType: 'GSTR1', returnDigest: (current as Gstr1SubmissionAggregate).returnDigest });
        await deps.append(ctx.tenantId, period, eventForResult(result, deps.now()));
        return { status: 200, body: { period, sandbox: true, result, current: await deps.load(ctx.tenantId, period) } };
      },
    },
    {
      // Apply a portal answer to an in-flight submission — the async / webhook / poller path. Body:
      // { status: acknowledged|failed|unknown, arn?, errorCode? }.
      api: 'API-09', method: 'POST', path: '/v1/finance/gstr1/submission/:period/record-response',
      permission: 'finance.gstr.submit', idempotent: true,
      handler: async (ctx) => {
        const period = ctx.params['period'] ?? '';
        const b = (ctx.body ?? {}) as Record<string, unknown>;
        const status = b['status'];
        if (typeof status !== 'string' || !OUTCOMES.includes(status as GstnSubmitStatus)) {
          throw apiError(400, { code: 'response_needs_status', whatHappened: 'Recording a response needs status (acknowledged/failed/unknown).', wasItSaved: 'not_saved', nextSafeAction: 'Send the portal’s answer under status, with arn (acknowledged) or errorCode (failed).' });
        }
        if (status === 'acknowledged' && (typeof b['arn'] !== 'string' || b['arn'].trim() === '')) {
          throw apiError(400, { code: 'ack_needs_arn', whatHappened: 'An acknowledged response needs the portal reference (arn).', wasItSaved: 'not_saved', nextSafeAction: 'Send the ARN the portal returned.' });
        }
        const action = status === 'acknowledged' ? 'acknowledge' : status === 'failed' ? 'markFailed' : 'markUnknown';
        const current = await deps.load(ctx.tenantId, period);
        const decision = evaluateGstr1SubmissionTransition({ ...(current !== undefined ? { current } : {}), action, actor: ctx.userId });
        if (!decision.allowed) throw apiError(statusFor(decision.refusal), { code: `submission_${decision.refusal}`, whatHappened: decision.reason, wasItSaved: 'not_saved', nextSafeAction: 'A response can only be recorded against an in-flight submission.' });
        const errorCode = typeof b['errorCode'] === 'string' ? (b['errorCode'] as string) : 'RET_ERROR';
        const result: GstnSubmitResult =
          status === 'acknowledged' ? { status: 'acknowledged', arn: b['arn'] as string, detail: 'portal acknowledged' }
            : status === 'failed' ? { status: 'failed', errorCode, detail: `portal rejected: ${errorCode}` }
              : { status: 'unknown', detail: typeof b['detail'] === 'string' ? (b['detail'] as string) : 'no clear answer from the portal' };
        await deps.append(ctx.tenantId, period, eventForResult(result, deps.now()));
        return { status: 200, body: { period, current: await deps.load(ctx.tenantId, period) } };
      },
    },
    {
      // The current, durable submission state — folded from the stored events.
      api: 'API-09', method: 'GET', path: '/v1/finance/gstr1/submission/:period',
      permission: 'finance.gstr.read',
      handler: async (ctx) => {
        const period = ctx.params['period'] ?? '';
        const agg = await deps.load(ctx.tenantId, period);
        if (agg === undefined) throw notFound(`a GSTR-1 submission for ${period}`);
        return { status: 200, body: agg };
      },
    },
  ];
}

/** Turn a portal result into the lifecycle event that records it. `classifyGstnError` fills a missing class. */
function eventForResult(result: GstnSubmitResult, at: string): Gstr1SubmissionEvent {
  if (result.status === 'acknowledged') return { kind: 'acknowledged', arn: result.arn ?? '', at };
  if (result.status === 'failed') {
    return { kind: 'failed', errorCode: result.errorCode ?? 'RET_ERROR', errorClass: result.errorClass ?? 'unknown', at };
  }
  return { kind: 'unknownResponse', detail: result.detail, at };
}
