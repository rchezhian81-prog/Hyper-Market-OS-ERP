// The one place the store box's offline checklist/task COMPLETION and the cloud's synced-completion contract
// meet — M25-FR-02, §31, P-01, hard rules #1 #6. The mirror of `cloud-return.ts`, for an opening/closing
// checklist or a daily task completed with the cable out.
//
// A manager opens or closes the shop with no internet: the completion is committed to the box's own durable log
// and queued. The sync agent later relays it to `POST /v1/hr/workforce/checklists/:id/synced` or
// `POST /v1/hr/workforce/tasks/:id/complete/synced` (slice 1), which record it into the SAME durable stores the
// online routes use and trust the box-relayed signer.
//
// This maps the box's on-disk record onto EXACTLY the fields those routes read. Like `toCloudReturn` it is
// TOLERANT of a record already in the cloud shape (so it can never make a correct payload wrong) and INVENTS
// nothing: a field it cannot read is left empty/absent for the cloud to raise as an exception (P-08), never
// guessed. The `checklistId` / `taskId` rides in the payload because the sync-agent route template fills the
// `:checklistId` / `:taskId` path segment from it — an absent id yields no path and is dead-lettered by name.

type Rec = Record<string, unknown>;

const str = (v: unknown): string | undefined => (typeof v === 'string' && v !== '' ? v : undefined);
const bool = (v: unknown): boolean | undefined => (typeof v === 'boolean' ? v : undefined);

/** One checklist item as the cloud reads it: what it is, whether it is done, and whether it blocks. */
export interface CloudChecklistItem {
  readonly itemId: string;
  readonly description: string;
  readonly done: boolean;
  readonly blocking: boolean;
  readonly doneBy?: string;
  readonly doneAt?: string;
  readonly note?: string;
}

/** The synced-checklist payload: exactly the fields `POST /v1/hr/workforce/checklists/:checklistId/synced` reads,
 *  plus the `checklistId` the route template turns into the path. */
export interface CloudChecklistCompletion {
  readonly checklistId: string;
  readonly kind: string;
  readonly items: readonly CloudChecklistItem[];
  readonly signedBy?: string;
  readonly branchId?: string;
  readonly forDate?: string;
}

/** The synced task-completion payload: exactly the fields `POST …/tasks/:taskId/complete/synced` reads, plus the
 *  `taskId` the route template turns into the path. */
export interface CloudTaskCompletion {
  readonly taskId: string;
  readonly doneBy: string;
  readonly doneAt?: string;
}

function toCloudItem(i: unknown): CloudChecklistItem {
  const r = (i ?? {}) as Rec;
  return {
    itemId: str(r['itemId']) ?? '',
    description: str(r['description']) ?? '',
    done: bool(r['done']) ?? false,
    blocking: bool(r['blocking']) ?? false,
    ...(str(r['doneBy']) === undefined ? {} : { doneBy: str(r['doneBy'])! }),
    ...(str(r['doneAt']) === undefined ? {} : { doneAt: str(r['doneAt'])! }),
    ...(str(r['note']) === undefined ? {} : { note: str(r['note'])! }),
  };
}

/**
 * Translate the box's checklist record into the cloud synced-checklist contract. Pure; the record is untrusted
 * JSON off the disk, so every field is read defensively. Optional fields (`signedBy`/`branchId`/`forDate`) are
 * carried only when present, so the cloud can tell "unsigned" from "signed by this person" (an unsigned checklist
 * is not a record — the tested `assessChecklist` says so).
 */
export function toCloudChecklist(record: unknown): CloudChecklistCompletion {
  const r = (record !== null && typeof record === 'object' ? record : {}) as Rec;
  const signedBy = str(r['signedBy']);
  const branchId = str(r['branchId']);
  const forDate = str(r['forDate']);
  const items: readonly CloudChecklistItem[] = Array.isArray(r['items'])
    ? (r['items'] as unknown[]).map(toCloudItem)
    : [];
  return {
    checklistId: str(r['checklistId']) ?? str(r['id']) ?? '',
    kind: str(r['kind']) ?? '',
    items,
    ...(signedBy === undefined ? {} : { signedBy }),
    ...(branchId === undefined ? {} : { branchId }),
    ...(forDate === undefined ? {} : { forDate }),
  };
}

/** Translate the box's task-completion record into the cloud contract. Pure and defensive; `doneAt` is carried
 *  only when present (the cloud defaults it to its own now, as the online route does). */
export function toCloudTaskCompletion(record: unknown): CloudTaskCompletion {
  const r = (record !== null && typeof record === 'object' ? record : {}) as Rec;
  const doneAt = str(r['doneAt']);
  return {
    taskId: str(r['taskId']) ?? str(r['id']) ?? '',
    doneBy: str(r['doneBy']) ?? '',
    ...(doneAt === undefined ? {} : { doneAt }),
  };
}

/** The checklist's identity as written to the disk record — `checklistId`, tolerating a bare `id`. */
export function checklistIdOf(record: unknown): string | undefined {
  const r = (record !== null && typeof record === 'object' ? record : {}) as Rec;
  return str(r['checklistId']) ?? str(r['id']);
}

/** The completed task's identity as written to the disk record — `taskId`, tolerating a bare `id`. */
export function taskIdOf(record: unknown): string | undefined {
  const r = (record !== null && typeof record === 'object' ? record : {}) as Rec;
  return str(r['taskId']) ?? str(r['id']);
}
