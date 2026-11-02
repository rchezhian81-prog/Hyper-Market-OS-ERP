// API-08 — the driver cash hand-over limit, as the OWNER confirms it (OB-676 "A", owner, 2 Nov 2026, in writing · M19-FR-04 ·
// P-05 · P-08 · hard rules #2 #6).
//
//   GET  /v1/delivery/handover-tolerance?storeId=     the limit in force at a store, the starting suggestion, and whether the
//                                                     owner has confirmed it (with every confirmation, oldest first)
//   POST /v1/delivery/handover-tolerance/:storeId     the owner confirms a limit { valueMinor, reason? } — the suggestion as it
//                                                     stands, or a new figure
//
// Before, the ₹100 a driver's counted cash may be out by was a figure written into the phone's code (its fallback) and typed
// into the store's settings by whoever set the store up — nobody had approved it. Now:
//   • **today's value is offered as the starting suggestion**: the limit in the store's settings (the one the signed store pack
//     carries to the store computer and the driver's phone), or ₹100 where a store has none yet;
//   • **it reads "not confirmed" until the owner confirms it** — the phone, the store computer and the Dispatch board all keep
//     working on the figure in force (nothing stops) and every screen that shows a cash difference says the limit is not
//     confirmed (P-08);
//   • **a confirmation is audited, and a change is a new version** — confirming another figure records a NEW version of the
//     store's settings (every older version kept) and a confirmation naming the figure, who and when; nothing is overwritten.
//     A later settings version that changes the figure without the owner reads "not confirmed" again, by itself.
//
// Gated `delivery.controls.set` — the owner's own numbers (the same right the Dispatch page's "owner's numbers" ask for).

import type { Route } from '../../kernel/src/index';
import { apiError, notFound } from '../../kernel/src/index';
import type { AuditEntry } from '../../../packages/audit/src/index';
import type { StoreSettings } from '../../platform/src/store-packs';

/** The figure the code carried before OB-676 (₹100) — offered as the starting suggestion where a store holds none. */
export const HANDOVER_TOLERANCE_STARTING_SUGGESTION_MINOR = 10_000;

/** One confirmation by the owner, as kept (append-only: a new version each time). */
export interface HandoverToleranceConfirmation {
  readonly storeId: string;
  readonly version: number;
  readonly valueMinor: number;
  /** The figure in force before this confirmation (null: the store had no settings figure). */
  readonly previousMinor: number | null;
  /** `as_suggested` — the figure in force, confirmed as it stood; `changed` — a new figure (a new settings version). */
  readonly kind: 'as_suggested' | 'changed';
  /** The store-settings version the figure is in. */
  readonly settingsVersion: number;
  readonly reason: string | null;
  readonly by: string;
  readonly at: string;
}

export type HandoverToleranceState = 'confirmed' | 'not_confirmed';

export interface HandoverToleranceStanding {
  readonly storeId: string;
  /** The limit in force at the store (the one the pack carries); null when the store has no settings yet. */
  readonly valueMinor: number | null;
  /** What the screen offers to confirm: the limit in force, else the starting suggestion. */
  readonly suggestedMinor: number;
  readonly state: HandoverToleranceState;
  /** The owner's latest confirmation, when it is of the figure in force. */
  readonly confirmed: { readonly version: number; readonly valueMinor: number; readonly by: string; readonly at: string } | null;
  /** True when the owner confirmed a figure once and the figure in force has since been changed by someone else. */
  readonly changedSinceConfirmed: boolean;
  readonly history: readonly HandoverToleranceConfirmation[];
}

/** Where the limit stands — pure. Confirmed only when the owner's LATEST confirmation is of the figure in force. */
export function handoverToleranceStanding(storeId: string, settings: StoreSettings | undefined, history: readonly HandoverToleranceConfirmation[]): HandoverToleranceStanding {
  const valueMinor = settings?.handoverToleranceMinor ?? null;
  const last = history.at(-1);
  const confirmedNow = last !== undefined && valueMinor !== null && last.valueMinor === valueMinor;
  return {
    storeId, valueMinor,
    suggestedMinor: valueMinor ?? HANDOVER_TOLERANCE_STARTING_SUGGESTION_MINOR,
    state: confirmedNow ? 'confirmed' : 'not_confirmed',
    confirmed: confirmedNow ? { version: last.version, valueMinor: last.valueMinor, by: last.by, at: last.at } : null,
    changedSinceConfirmed: last !== undefined && !confirmedNow,
    history,
  };
}

export interface HandoverToleranceDeps {
  /** The stores head office knows (its org register's branches). */
  readonly stores: (tenantId: string) => Promise<ReadonlyMap<string, string>>;
  readonly settings: (tenantId: string, storeId: string) => Promise<StoreSettings | undefined>;
  /** A new settings version (append-only) — the same register `POST /v1/stores/:storeId/settings` writes. */
  readonly recordSettings: (tenantId: string, s: StoreSettings) => Promise<void>;
  /** Every confirmation for a store, oldest first. */
  readonly confirmations: (tenantId: string, storeId: string) => Promise<readonly HandoverToleranceConfirmation[]>;
  /** Keep one confirmation — keyed on (store, version), so a replay lands once. */
  readonly recordConfirmation: (tenantId: string, c: HandoverToleranceConfirmation) => Promise<void>;
  readonly recordAudit?: (tenantId: string, entry: AuditEntry) => Promise<unknown> | void;
  readonly now: () => string;
}

const isPositiveWhole = (v: unknown): v is number => typeof v === 'number' && Number.isInteger(v) && v > 0 && v <= 100_000_000;

export function handoverToleranceRoutes(deps: HandoverToleranceDeps): readonly Route[] {
  const knownStore = async (tenantId: string, storeId: string): Promise<void> => {
    if (!(await deps.stores(tenantId)).has(storeId)) throw notFound(`store ${storeId}`);
  };
  const standing = async (tenantId: string, storeId: string): Promise<HandoverToleranceStanding> =>
    handoverToleranceStanding(storeId, await deps.settings(tenantId, storeId), await deps.confirmations(tenantId, storeId));
  return [
    {
      api: 'API-08', method: 'GET', path: '/v1/delivery/handover-tolerance',
      permission: 'delivery.run.read', entitlement: 'delivery',
      handler: async (ctx) => {
        const storeId = (ctx.query['storeId'] ?? '').trim();
        if (storeId === '') throw apiError(400, { code: 'store_needed', whatHappened: 'Say which store: ?storeId=.', wasItSaved: 'not_saved', nextSafeAction: 'Send the store. Nothing was changed.' });
        await knownStore(ctx.tenantId, storeId);
        return { status: 200, body: { ...(await standing(ctx.tenantId, storeId)), asAt: deps.now() } };
      },
    },
    {
      // The owner confirms the limit: { valueMinor (whole paise above zero), reason? }. The figure in force, confirmed as it
      // stands, is a confirmation only; another figure is a new settings version AND its confirmation. Re-sending the
      // confirmation of the figure already confirmed records nothing new.
      api: 'API-08', method: 'POST', path: '/v1/delivery/handover-tolerance/:storeId',
      permission: 'delivery.controls.set', entitlement: 'delivery', idempotent: true,
      handler: async (ctx) => {
        const storeId = (ctx.params['storeId'] ?? '').trim();
        await knownStore(ctx.tenantId, storeId);
        const b = (ctx.body ?? {}) as Record<string, unknown>;
        if (!isPositiveWhole(b['valueMinor']) || (b['reason'] !== undefined && b['reason'] !== null && typeof b['reason'] !== 'string')) {
          throw apiError(400, {
            code: 'not_readable_as_a_handover_tolerance',
            whatHappened: 'Send { valueMinor, reason? } — the limit in whole paise, above zero (a limit of nothing would send every driver whose cash balances to the cash office).',
            wasItSaved: 'not_saved', nextSafeAction: 'Enter the limit again. Nothing was changed.',
          });
        }
        const valueMinor = b['valueMinor'];
        const settings = await deps.settings(ctx.tenantId, storeId);
        if (settings === undefined) {
          throw apiError(409, {
            code: 'store_not_set_up',
            whatHappened: `Store ${storeId} has no settings yet, so there is no setup to carry the limit to the store computer and the drivers' phones.`,
            wasItSaved: 'not_saved', nextSafeAction: 'Set the store\'s settings first (owner setup on the store PC), then confirm the limit. Nothing was changed.',
          });
        }
        const before = await standing(ctx.tenantId, storeId);
        if (before.state === 'confirmed' && before.valueMinor === valueMinor) {
          return { status: 200, body: { ...before, alreadyConfirmed: true, asAt: deps.now() } };
        }
        const at = deps.now();
        const changed = settings.handoverToleranceMinor !== valueMinor;
        let settingsVersion = settings.version;
        if (changed) {
          // A change is a new settings version — every other figure carried over as it stands, the older version kept.
          const next: StoreSettings = { ...settings, handoverToleranceMinor: valueMinor, version: settings.version + 1, setBy: ctx.userId, setAt: at };
          await deps.recordSettings(ctx.tenantId, next);
          settingsVersion = next.version;
        }
        const reason = typeof b['reason'] === 'string' && b['reason'].trim() !== '' ? b['reason'].trim() : null;
        const c: HandoverToleranceConfirmation = {
          storeId, version: before.history.length + 1, valueMinor, previousMinor: settings.handoverToleranceMinor,
          kind: changed ? 'changed' : 'as_suggested', settingsVersion, reason, by: ctx.userId, at,
        };
        await deps.recordConfirmation(ctx.tenantId, c);
        await deps.recordAudit?.(ctx.tenantId, {
          actorId: ctx.userId, action: 'delivery.handover_tolerance.confirm', objectType: 'store_settings', objectId: storeId,
          at, origin: { tenantId: ctx.tenantId, branchId: ctx.branchId ?? null },
          before: { handoverToleranceMinor: String(settings.handoverToleranceMinor), state: before.state },
          after: { handoverToleranceMinor: String(valueMinor), state: 'confirmed', kind: c.kind, version: String(c.version), settingsVersion: String(settingsVersion) },
          ...(reason === null ? {} : { reason }), correlationId: `handover-tolerance-${storeId}`,
        });
        return { status: before.history.length === 0 ? 201 : 200, body: { ...(await standing(ctx.tenantId, storeId)), alreadyConfirmed: false, asAt: deps.now() } };
      },
    },
  ];
}
