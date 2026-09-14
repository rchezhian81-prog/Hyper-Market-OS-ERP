// API-11 HR/Workforce — the DURABLE checklist-completion store (M25-FR-02 follow-on), on the tested
// `packages/workforce` `assessChecklist` engine, alongside the roster, certification, SOP and attendance stores.
// The `POST /v1/hr/workforce/checklist-assess` route is a stateless what-if (the caller supplies the whole
// checklist). This persists a SUBMITTED opening/closing/handover checklist (append-only, latest-per-checklistId,
// hard rule #2/#6) so "was the closing checklist actually done, and what is still outstanding?" reads STORED
// facts and survives a restart — the difference between a checklist a manager can be asked to produce weeks
// later and one that lived only in the moment it was ticked.
//
//   • `POST /v1/hr/workforce/checklists/:checklistId`         — record/replace a submitted checklist. Body:
//     { kind, items[], signedBy?, branchId?, forDate? }. manage.
//   • `GET  /v1/hr/workforce/checklists`                      — the stored checklists (optionally ?kind= / ?branchId=),
//     each with its live assessment. checklist.read.
//   • `GET  /v1/hr/workforce/checklists/:checklistId/status`  — the STATEFUL assessment: folds the stored
//     checklist and runs the tested `assessChecklist` (the stateful counterpart to the POST what-if).
//     checklist.read. 404 when the checklist is unknown.
//
// Writes gated `workforce.roster.manage`; reads `workforce.checklist.read`. Nothing is signed or completed
// automatically — it records what a shift submitted and reports, by exception, what blocks the shop and what is
// carried into the next handover (P-03, P-05). Blocking and non-blocking items stay separated, exactly as the
// engine separates them: a blocking item outstanding stops the shop; a signed checklist with only non-blocking
// items left is complete and carries them, visible, into the next shift (M25-FR-02).

import type { Route } from '../../kernel/src/index';
import { apiError, notFound } from '../../kernel/src/index';
import { assessChecklist, type ChecklistItem, type ChecklistResult } from '../../../packages/workforce/src/workforce';

const CHECKLIST_KINDS = ['opening', 'closing', 'handover'] as const;
type ChecklistKind = typeof CHECKLIST_KINDS[number];

/** A submitted checklist as stored: the id, its kind, the items as ticked, who signed, and where/when it was for. */
export interface StoredChecklist {
  readonly checklistId: string;
  readonly kind: ChecklistKind;
  readonly items: readonly ChecklistItem[];
  readonly signedBy?: string;
  readonly branchId?: string;
  /** The trading day this checklist belongs to (YYYY-MM-DD), for the review list. */
  readonly forDate?: string;
  readonly submittedAt: string;
}

export interface ChecklistStoreDeps {
  readonly putChecklist: (tenantId: string, checklist: StoredChecklist, key: string) => Promise<void> | void;
  readonly checklists: (tenantId: string) => Promise<readonly StoredChecklist[]> | readonly StoredChecklist[];
  readonly checklist: (tenantId: string, checklistId: string) => Promise<StoredChecklist | undefined> | StoredChecklist | undefined;
  readonly now: () => string;
}

const isStr = (v: unknown): v is string => typeof v === 'string' && v.trim() !== '';
const isArr = (v: unknown): v is unknown[] => Array.isArray(v);
const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const isBool = (v: unknown): v is boolean => typeof v === 'boolean';

/** A checklist item: what it is, whether it is done, and whether the shop cannot run without it. */
const isChecklistItem = (v: unknown): v is ChecklistItem =>
  isObj(v) && isStr(v['itemId']) && isStr(v['description']) && isBool(v['done']) && isBool(v['blocking'])
  && (v['doneBy'] === undefined || isStr(v['doneBy'])) && (v['doneAt'] === undefined || isStr(v['doneAt']))
  && (v['note'] === undefined || isStr(v['note']));

/** Run the tested engine over a stored checklist. Its own `signedBy` is honoured — an unsigned one is not a record. */
const assessStored = (c: StoredChecklist): ChecklistResult =>
  assessChecklist({
    checklistId: c.checklistId,
    kind: c.kind,
    items: c.items,
    ...(isStr(c.signedBy) ? { signedBy: c.signedBy } : {}),
  });

export function checklistStoreRoutes(deps: ChecklistStoreDeps): readonly Route[] {
  return [
    {
      // Record/replace a submitted checklist. Body: { kind, items[], signedBy?, branchId?, forDate? }. A later
      // submission of the same checklistId supersedes (latest-wins); the prior events are kept (hard rule #6).
      api: 'API-11', method: 'POST', path: '/v1/hr/workforce/checklists/:checklistId',
      permission: 'workforce.roster.manage', idempotent: true,
      handler: async (ctx) => {
        const checklistId = (ctx.params['checklistId'] ?? '').trim();
        const b = (ctx.body ?? {}) as Record<string, unknown>;
        if (checklistId === '' || !CHECKLIST_KINDS.includes(b['kind'] as ChecklistKind)
          || !isArr(b['items']) || !b['items'].every(isChecklistItem)
          || (b['signedBy'] !== undefined && !isStr(b['signedBy']))
          || (b['branchId'] !== undefined && !isStr(b['branchId']))
          || (b['forDate'] !== undefined && !isStr(b['forDate']))) {
          throw apiError(400, {
            code: 'not_readable_as_a_checklist',
            whatHappened: 'A stored checklist needs a checklistId in the path and { kind (opening/closing/handover), items (each with itemId, description, done, blocking) } in the body (signedBy, branchId, forDate optional).',
            wasItSaved: 'not_saved',
            nextSafeAction: 'Send the checklist as it was ticked, and who signed it.',
          });
        }
        const checklist: StoredChecklist = {
          checklistId,
          kind: b['kind'] as ChecklistKind,
          items: b['items'] as ChecklistItem[],
          ...(isStr(b['signedBy']) ? { signedBy: b['signedBy'] } : {}),
          ...(isStr(b['branchId']) ? { branchId: b['branchId'] } : {}),
          ...(isStr(b['forDate']) ? { forDate: b['forDate'] } : {}),
          submittedAt: deps.now(),
        };
        await deps.putChecklist(ctx.tenantId, checklist, ctx.idempotencyKey ?? `checklist-${checklistId}-${deps.now()}`);
        return { status: 200, body: { checklist, assessment: assessStored(checklist) } };
      },
    },
    {
      // The stored checklists, each with its live assessment. Optionally narrowed ?kind= / ?branchId=. Read-only.
      api: 'API-11', method: 'GET', path: '/v1/hr/workforce/checklists',
      permission: 'workforce.checklist.read',
      handler: async (ctx) => {
        const kind = (ctx.query['kind'] ?? '').trim();
        const branchId = (ctx.query['branchId'] ?? '').trim();
        let stored = await deps.checklists(ctx.tenantId);
        if (kind !== '') stored = stored.filter((c) => c.kind === kind);
        if (branchId !== '') stored = stored.filter((c) => c.branchId === branchId);
        const checklists = stored.map((c) => ({ ...c, assessment: assessStored(c) }));
        // The shop cannot run past a blocking item outstanding — surface that count first (P-03).
        const blocked = checklists.filter((c) => c.assessment.outcome === 'blocked_item').length;
        return { status: 200, body: { checklists, count: checklists.length, blocked } };
      },
    },
    {
      // Was this stored checklist actually done, and what is outstanding? Read-only — the stateful counterpart to
      // POST /checklist-assess. 404 when the checklist is unknown.
      api: 'API-11', method: 'GET', path: '/v1/hr/workforce/checklists/:checklistId/status',
      permission: 'workforce.checklist.read',
      handler: async (ctx) => {
        const checklistId = (ctx.params['checklistId'] ?? '').trim();
        if (checklistId === '') throw notFound('checklist ');
        const stored = await deps.checklist(ctx.tenantId, checklistId);
        if (stored === undefined) throw notFound(`checklist ${checklistId}`);
        return { status: 200, body: { checklist: stored, assessment: assessStored(stored) } };
      },
    },
  ];
}
