// A PRIVILEGE CHANGE MADE ON THE STORE PC IS A SEALED, PIN-CONFIRMED ACT — CR-01 step 4a · ADR-0033 · OB-731 "A" ·
// OB-732 "B" · §28 · hard rules #4, #5, #10.
//
// On a store PC with no identity server the box never mints a token (ADR-0029 §1). When a person signed in on the office
// screens adds a person, asks for a role or approves one, the box checks their PIN AGAIN (the till's PIN register, holding
// the route's own permission), then SEALS a decision record — which act, which shop, who, the exact request, a fresh
// request id and the moment the PIN was confirmed — with the dedicated privilege-seal key, and relays it under its store
// token. Head office checks the seal, the freshness and the one-use request id, then runs the person's own checks.
//
// One shape, shared by the box (which seals) and head office (which checks), so both digest the same record. The seal is
// the ADR-0023 decision seal (`sealDecision` / `checkDeciderStamp`, the whole record digested, the stamp field excluded),
// made with `privilegeSealKey` — never the till seal key. Pure apart from `node:crypto`.

import { DECIDER_STAMP_FIELD, checkDeciderStamp, sealDecision, type DeciderStamp } from './till-seal';

/**
 * CR-01 step 4b-1: `role_grant_rejection` — a second person turns a pending request down, by PIN (OB-735 · ADR-0033 amended).
 * CR-01 step 4b-2: `access_change_request` (ask to take a role back, or record a leaver), `access_change_decision` (the second
 * person approves — the change is then applied — or rejects it), `till_pin_change` (a till PIN set, changed or cancelled on
 * screen; the PIN itself never in the record) — OB-734, OB-735, OB-737, ADR-0033 amendment 2.
 */
export type PrivilegeKind = 'person_provision' | 'role_request' | 'role_grant_approval' | 'role_grant_rejection'
  | 'access_change_request' | 'access_change_decision' | 'till_pin_change';
export const PRIVILEGE_KINDS: readonly PrivilegeKind[] = Object.freeze(['person_provision', 'role_request', 'role_grant_approval', 'role_grant_rejection', 'access_change_request', 'access_change_decision', 'till_pin_change']);
/** How the acting person proved it was them: their own till PIN, typed again on the office screen (OB-731 "A"). */
export const PRIVILEGE_VIA = 'office_pin';
/** The "lane" a privilege seal names: the office screens' own (edge/store-edge/src/office-sign-in.ts `OFFICE_LANE`). */
export const PRIVILEGE_LANE = 'office-screens';
/** A seal is good for this long after the PIN was typed, by head office's own clock (ADR-0033 §3). */
export const PRIVILEGE_FRESH_SECONDS = 300;
/** A `confirmedAt` this far ahead of head office's clock is refused (two clocks on one PC, a little drift allowed). */
export const PRIVILEGE_FUTURE_SKEW_SECONDS = 60;

/** The record the box seals and relays. `body` is EXACTLY the request the person's own route would have been sent. */
export interface PrivilegeRecord {
  readonly kind: PrivilegeKind;
  readonly tenantId: string;
  /** The acting person — the one the box just verified by PIN. Never a name typed in the request. */
  readonly userId: string;
  /** A fresh id the box makes for this one act; head office accepts it once. */
  readonly requestId: string;
  /** When the PIN was confirmed (ISO, the box's clock). */
  readonly confirmedAt: string;
  readonly via: typeof PRIVILEGE_VIA;
  readonly body: Readonly<Record<string, unknown>>;
}

export type SealedPrivilegeRecord = PrivilegeRecord & { readonly [DECIDER_STAMP_FIELD]: DeciderStamp };

/** The box's seal on a privilege record: the ADR-0023 decision seal over the whole record, with the privilege key. */
export function sealPrivilegeRecord(key: Buffer, record: PrivilegeRecord): SealedPrivilegeRecord {
  const stamp = sealDecision(key, {
    tenantId: record.tenantId, kind: record.kind, recordId: record.requestId, record,
    laneId: PRIVILEGE_LANE, userId: record.userId, via: PRIVILEGE_VIA,
  });
  return { ...record, [DECIDER_STAMP_FIELD]: stamp };
}

/** Why head office refuses a relayed privilege record — a code each, never a flag (ADR-0033 §3). */
export type PrivilegeRefusal =
  | 'privilege_record_not_readable'
  | 'privilege_record_does_not_match'
  | 'privilege_seal_missing'
  | 'privilege_seal_does_not_match'
  | 'privilege_confirmation_stale'
  | 'privilege_confirmation_in_the_future';

export type PrivilegeCheck =
  | { readonly ok: true; readonly record: PrivilegeRecord }
  | { readonly ok: false; readonly refusedBecause: PrivilegeRefusal; readonly why: string };

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z$/;
const isObj = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === 'object' && !Array.isArray(v);
const isStr = (v: unknown): v is string => typeof v === 'string' && v.trim() !== '' && v === v.trim();

/** Read a relayed body as a privilege record (the stamp left aside), or undefined. */
export function readPrivilegeRecord(raw: unknown): PrivilegeRecord | undefined {
  if (!isObj(raw)) return undefined;
  const { kind, tenantId, userId, requestId, confirmedAt, via, body } = raw;
  if (typeof kind !== 'string' || !(PRIVILEGE_KINDS as readonly string[]).includes(kind)) return undefined;
  if (!isStr(tenantId) || !isStr(userId) || typeof requestId !== 'string' || !UUID.test(requestId)) return undefined;
  if (typeof confirmedAt !== 'string' || !ISO.test(confirmedAt) || Number.isNaN(Date.parse(confirmedAt))) return undefined;
  if (via !== PRIVILEGE_VIA || !isObj(body)) return undefined;
  const extra = Object.keys(raw).filter((k) => !['kind', 'tenantId', 'userId', 'requestId', 'confirmedAt', 'via', 'body', DECIDER_STAMP_FIELD].includes(k));
  if (extra.length > 0) return undefined;
  return { kind: kind as PrivilegeKind, tenantId, userId, requestId, confirmedAt, via: PRIVILEGE_VIA, body };
}

/**
 * Head office's check of one relayed privilege record, for the route it arrived on (`kind`) and the shop the store token
 * names (`tenantId`), at head office's own time `nowMs`. Refuses: an unreadable record; a record for another act or shop; no
 * seal; a seal that does not verify with the privilege key (another key, or any word changed since the box sealed it); a
 * `confirmedAt` older than 300 s or more than 60 s ahead. The one-use request id is head office's store's to judge.
 */
export function checkPrivilegeRecord(key: Buffer | undefined, input: { readonly kind: PrivilegeKind; readonly tenantId: string; readonly relayed: unknown; readonly nowMs: number }): PrivilegeCheck {
  const record = readPrivilegeRecord(input.relayed);
  if (record === undefined) {
    return { ok: false, refusedBecause: 'privilege_record_not_readable', why: 'This could not be read as a privilege change made on the store PC: it needs { kind, tenantId, userId, requestId (a uuid), confirmedAt, via "office_pin", body } and the store PC\'s seal, and nothing else.' };
  }
  if (record.kind !== input.kind || record.tenantId !== input.tenantId) {
    return { ok: false, refusedBecause: 'privilege_record_does_not_match', why: `This record is a ${record.kind} for shop ${record.tenantId}; this route takes a ${input.kind} for shop ${input.tenantId} only.` };
  }
  const stamp = (input.relayed as Record<string, unknown>)[DECIDER_STAMP_FIELD];
  if (stamp === undefined || stamp === null) {
    return { ok: false, refusedBecause: 'privilege_seal_missing', why: 'This privilege change carries no seal from the store PC, so nobody vouches that the person typed their PIN for it.' };
  }
  const verdict = key === undefined ? 'does_not_match' : checkDeciderStamp(key, { tenantId: record.tenantId, kind: record.kind, recordId: record.requestId, named: record.userId, record: input.relayed });
  if (verdict === 'missing') {
    return { ok: false, refusedBecause: 'privilege_seal_missing', why: 'This privilege change carries no complete seal from the store PC.' };
  }
  const s = stamp as Record<string, unknown>;
  if (verdict !== 'verified' || s['via'] !== PRIVILEGE_VIA || s['laneId'] !== PRIVILEGE_LANE) {
    return { ok: false, refusedBecause: 'privilege_seal_does_not_match', why: 'The store PC\'s seal on this privilege change does not match it: it was sealed with another key, or something in it changed after the PIN was confirmed.' };
  }
  const ageMs = input.nowMs - Date.parse(record.confirmedAt);
  if (ageMs > PRIVILEGE_FRESH_SECONDS * 1000) {
    return { ok: false, refusedBecause: 'privilege_confirmation_stale', why: `The PIN for this privilege change was confirmed more than ${PRIVILEGE_FRESH_SECONDS / 60} minutes ago.` };
  }
  if (-ageMs > PRIVILEGE_FUTURE_SKEW_SECONDS * 1000) {
    return { ok: false, refusedBecause: 'privilege_confirmation_in_the_future', why: 'This privilege change says its PIN was confirmed later than now by head office\'s clock.' };
  }
  return { ok: true, record };
}
