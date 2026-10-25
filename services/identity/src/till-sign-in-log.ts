// API-01 The till sign-in log at head office (owner decision OB-365, 24–25 Oct 2026, in writing · M29-FR-03 · D13-FR-06 ·
// P-04 · P-08 · hard rules #2, #4, #6).
//
// "The store computer sends its till sign-in log to head office so after-hours and failed-sign-in alerts work." Before
// this, a sign-in at a till was checked by the store computer and kept only on its own disk, so the owner's after-hours
// alert said it could not fire and the security report said failed sign-ins were not known. Now:
//
//   • POST /v1/identity/till-sign-ins/:entryId/synced — the store computer relays each record of its log: a sign-in, a
//     refusal (a wrong staff ID or PIN, a locked staff ID, a locked lane, …) or a sign-out — who, where, when. Kept once
//     per record (idempotent on its id), append-only. A body that carries ANYTHING like a PIN, a token or a hash is refused
//     by name and nothing is kept (hard rule #4: a PIN or its hash never leaves the box; the box never sends one).
//   • GET /v1/identity/till-sign-ins?day=YYYY-MM-DD — the day's log, by the shop's own trading day, with what it counts.
//
// The owner's alerts (services/api/src/owner-reporting-adapters.ts) and the security report read the same register.
// Nothing here signs anybody in or out: the store computer decides that, offline (P-01).

import type { Route } from '../../kernel/src/index';
import { apiError } from '../../kernel/src/index';

export const TILL_SIGN_IN_KINDS = Object.freeze(['signed_in', 'signed_out', 'refused'] as const);
export type TillSignInKind = (typeof TILL_SIGN_IN_KINDS)[number];

/** The refusals the store computer gives (edge/store-edge/src/till-operators.ts `SignInRefusal`). */
export const TILL_SIGN_IN_REFUSALS = Object.freeze([
  'wrong_staff_id_or_pin', 'locked', 'no_till_authority', 'no_approval_authority', 'no_handheld_authority', 'no_people_register',
  'lane_locked', 'not_readable', 'no_lane',
] as const);
/** The refusals that are a FAILED attempt to prove who you are — a wrong PIN, or a try while locked out. */
export const FAILED_SIGN_IN_REASONS: readonly string[] = Object.freeze(['wrong_staff_id_or_pin', 'locked', 'lane_locked']);
/** The refusals that say the staff ID (or the whole lane) was LOCKED at the time. */
export const LOCKOUT_REASONS: readonly string[] = Object.freeze(['locked', 'lane_locked']);

/** One record of a till's sign-in log, as head office keeps it. */
export interface TillSignInRecord {
  readonly entryId: string;
  readonly kind: TillSignInKind;
  readonly at: string;
  readonly laneId: string | null;
  readonly person: string;
  readonly via?: 'pin' | 'verified_sign_in';
  readonly reason?: string;
  readonly why?: 'replaced';
  readonly authority?: string;
  /** The store the relaying computer is bound to (its grant's store), when it has one. */
  readonly storeId: string | null;
  readonly relayedBy: string;
  readonly receivedAt: string;
}

export interface TillSignInLogDeps {
  readonly entries: (tenantId: string) => Promise<readonly TillSignInRecord[]>;
  readonly entry: (tenantId: string, entryId: string) => Promise<TillSignInRecord | undefined>;
  readonly record: (tenantId: string, r: TillSignInRecord) => Promise<void>;
  /** The shop's trading day for an instant (its own calendar). */
  readonly dayOf: (tenantId: string, at: string) => Promise<string>;
  readonly now: () => string;
}

const isStr = (v: unknown): v is string => typeof v === 'string' && v.trim() !== '';
const isIso = (v: unknown): v is string => isStr(v) && !Number.isNaN(Date.parse(v));
/** Anything that names a secret: the box never sends one, and head office refuses to keep one (hard rule #4). */
const SECRET_KEY = /pin|token|hash|salt|verifier|secret|password|credential/i;

/** Every key in a body, at any depth. */
function keysOf(v: unknown, out: string[] = []): string[] {
  if (v !== null && typeof v === 'object') {
    for (const [k, x] of Object.entries(v as Record<string, unknown>)) { out.push(k); keysOf(x, out); }
  }
  return out;
}

/** Read one relayed record — or say why it is not one. */
export function readTillSignIn(entryId: string, b: Record<string, unknown>): { ok: true; value: Omit<TillSignInRecord, 'storeId' | 'relayedBy' | 'receivedAt'> } | { ok: false; why: string; secret?: true } {
  const secret = keysOf(b).find((k) => SECRET_KEY.test(k));
  if (secret !== undefined) return { ok: false, secret: true, why: `the record carries "${secret}" — a PIN, a token or a hash never leaves the store computer, and head office keeps none` };
  if (!isStr(entryId) || b['entryId'] !== entryId) return { ok: false, why: 'the record names its entryId, the same as the path' };
  const kind = b['kind'];
  if (typeof kind !== 'string' || !(TILL_SIGN_IN_KINDS as readonly string[]).includes(kind)) return { ok: false, why: 'kind is signed_in, signed_out or refused' };
  if (!isIso(b['at'])) return { ok: false, why: 'at is when it happened (an ISO time)' };
  if (!isStr(b['person']) || (b['person'] as string).length > 64) return { ok: false, why: 'person is the staff ID (up to 64 characters)' };
  if (b['laneId'] !== null && !(isStr(b['laneId']) && (b['laneId'] as string).length <= 80)) return { ok: false, why: 'laneId is the till lane (or null for a sign-out the box no longer places)' };
  if (kind === 'signed_in' && b['via'] !== 'pin' && b['via'] !== 'verified_sign_in') return { ok: false, why: 'a sign-in says how: via pin or verified_sign_in' };
  if (kind === 'refused' && !(typeof b['reason'] === 'string' && (TILL_SIGN_IN_REFUSALS as readonly string[]).includes(b['reason']))) return { ok: false, why: 'a refusal says why (one of the store computer\'s refusals)' };
  if (b['why'] !== undefined && b['why'] !== 'replaced') return { ok: false, why: 'a sign-out\'s why is "replaced", or absent' };
  if (b['authority'] !== undefined && !isStr(b['authority'])) return { ok: false, why: 'authority, when given, is the job the sign-in was for' };
  const known = new Set(['entryId', 'kind', 'at', 'laneId', 'person', 'via', 'reason', 'why', 'authority']);
  const extra = Object.keys(b).find((k) => !known.has(k));
  if (extra !== undefined) return { ok: false, why: `"${extra}" is not part of a sign-in record` };
  return {
    ok: true,
    value: {
      entryId, kind: kind as TillSignInKind, at: b['at'] as string, laneId: (b['laneId'] as string | null) ?? null, person: (b['person'] as string).trim(),
      ...(b['via'] === undefined ? {} : { via: b['via'] as 'pin' | 'verified_sign_in' }),
      ...(b['reason'] === undefined ? {} : { reason: b['reason'] as string }),
      ...(b['why'] === undefined ? {} : { why: 'replaced' as const }),
      ...(b['authority'] === undefined ? {} : { authority: b['authority'] as string }),
    },
  };
}

/**
 * Lockout EPISODES among refusals: one per staff ID (or lane) for each run of "locked" refusals no more than fifteen minutes
 * apart (the store computer's own lock window) — so ten tries during one lockout are one lockout, not ten.
 */
export function lockoutEpisodes(records: readonly Pick<TillSignInRecord, 'kind' | 'reason' | 'person' | 'laneId' | 'at' | 'entryId'>[]): readonly { readonly who: string; readonly firstAt: string; readonly entryIds: readonly string[] }[] {
  const WINDOW = 15 * 60_000;
  const by = new Map<string, { at: string; entryId: string }[]>();
  for (const r of records) {
    if (r.kind !== 'refused' || r.reason === undefined || !LOCKOUT_REASONS.includes(r.reason)) continue;
    const who = r.reason === 'lane_locked' ? `lane:${r.laneId ?? ''}` : r.person;
    by.set(who, [...(by.get(who) ?? []), { at: r.at, entryId: r.entryId }]);
  }
  const out: { who: string; firstAt: string; entryIds: string[] }[] = [];
  for (const [who, list] of [...by].sort(([a], [b]) => a.localeCompare(b))) {
    let current: { who: string; firstAt: string; entryIds: string[]; last: number } | undefined;
    for (const x of [...list].sort((a, b) => a.at.localeCompare(b.at))) {
      const t = Date.parse(x.at);
      if (current === undefined || t - current.last > WINDOW) {
        if (current !== undefined) out.push({ who: current.who, firstAt: current.firstAt, entryIds: current.entryIds });
        current = { who, firstAt: x.at, entryIds: [x.entryId], last: t };
      } else { current.entryIds.push(x.entryId); current.last = t; }
    }
    if (current !== undefined) out.push({ who: current.who, firstAt: current.firstAt, entryIds: current.entryIds });
  }
  return out;
}

const isDay = (v: unknown): v is string => typeof v === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(v) && !Number.isNaN(Date.parse(`${v}T00:00:00Z`));

export function tillSignInLogRoutes(deps: TillSignInLogDeps): readonly Route[] {
  return [
    {
      // The store computer relays one record of its till sign-in log. Kept once per entryId; nothing secret is ever kept.
      api: 'API-01', method: 'POST', path: '/v1/identity/till-sign-ins/:entryId/synced',
      permission: 'identity.tillsignin.sync', idempotent: true,
      handler: async (ctx) => {
        const entryId = (ctx.params['entryId'] ?? '').trim();
        const read = readTillSignIn(entryId, (ctx.body ?? {}) as Record<string, unknown>);
        if (!read.ok) {
          throw apiError(400, {
            code: read.secret === true ? 'secret_in_sign_in_record' : 'not_readable_as_a_till_sign_in',
            whatHappened: `This could not be kept as a till sign-in record: ${read.why}.`,
            wasItSaved: 'not_saved',
            nextSafeAction: read.secret === true ? 'Send the record without it. Nothing was kept.' : 'Send the record as the store computer logged it. Nothing was kept.',
          });
        }
        const prior = await deps.entry(ctx.tenantId, entryId);
        if (prior !== undefined) return { status: 200, body: { entryId, recorded: true, alreadyRecorded: true } };
        const r: TillSignInRecord = { ...read.value, storeId: ctx.branchId ?? null, relayedBy: ctx.userId, receivedAt: deps.now() };
        await deps.record(ctx.tenantId, r);
        return { status: 201, body: { entryId, recorded: true } };
      },
    },
    {
      // The day's till sign-in log (?day=YYYY-MM-DD, default today, by the shop's trading day): every record, and what it
      // counts — sign-ins, failed attempts, lockouts (episodes) — with the newest record's time (P-08: freshness said).
      api: 'API-01', method: 'GET', path: '/v1/identity/till-sign-ins',
      permission: 'lp.case.read',
      handler: async (ctx) => {
        const asked = ctx.query['day'];
        if (asked !== undefined && !isDay(asked)) {
          throw apiError(400, { code: 'not_readable_as_a_day', whatHappened: `"${asked}" is not a day (YYYY-MM-DD).`, wasItSaved: 'not_saved', nextSafeAction: 'Send ?day=YYYY-MM-DD, or leave it off for today.' });
        }
        const day = asked ?? await deps.dayOf(ctx.tenantId, deps.now());
        const all = await deps.entries(ctx.tenantId);
        const mine: TillSignInRecord[] = [];
        for (const r of all) if (await deps.dayOf(ctx.tenantId, r.at) === day) mine.push(r);
        mine.sort((a, b) => a.at.localeCompare(b.at) || a.entryId.localeCompare(b.entryId));
        const newest = all.reduce<string | null>((n, r) => (n === null || r.at > n ? r.at : n), null);
        return {
          status: 200,
          body: {
            day, entries: mine,
            counts: {
              signIns: mine.filter((r) => r.kind === 'signed_in').length,
              failed: mine.filter((r) => r.kind === 'refused' && r.reason !== undefined && FAILED_SIGN_IN_REASONS.includes(r.reason)).length,
              lockouts: lockoutEpisodes(mine).length,
            },
            newestRecordAt: newest, received: all.length > 0, asAt: deps.now(),
          },
        };
      },
    },
  ];
}
