// The shops, and a shop's features — read and changed ON THE SERVER, by a named person (OB-15-d-3 · owner decision
// OB-21 "A" · M36-FR-01 · ADR-0003 hard isolation · db/migrations/0012).
//
// The wall between shops stays: head office's online system never reads or writes across shops. Only a person at the
// server may look across them — as the backup and the new-shop command do — and these two commands are that:
//   • the list: every shop, its name, sign-in area, address, who created it, its plan and the features it has on;
//   • a change of ONE shop's features: checked first, recorded in that shop's own history with the name of the person
//     who made it — the same record head office's own feature switch writes, so the shop's screens read it the same way.
// This module is the commands' tested logic; it reads and writes nothing itself.

import { OPTIONAL_FEATURES, isOptionalFeature } from '../../../packages/tenant/src/tenant';

/** A shop as the `tenants` table holds it. */
export interface TenantRow { readonly tenantId: string; readonly registeredAt: string; readonly registeredBy: string }

/** The events of a shop this list reads (its platform stream and its billing stream), oldest first. */
export interface ShopEvent { readonly type: string; readonly payload: Record<string, unknown>; readonly occurredAt: string }

export interface ShopLine {
  readonly tenantId: string;
  /** From the new-shop command's record; absent for a shop made before it (e.g. by `tenant:bootstrap`). */
  readonly name?: string;
  readonly realm?: string;
  readonly webOrigin?: string;
  readonly createdBy: string;
  readonly registeredAt: string;
  /** The current plan, or absent when the shop has none (or it was cancelled). */
  readonly plan?: string;
  /** The optional features switched on now, sorted. */
  readonly featuresOn: readonly string[];
}

/** Fold one shop's events into its line on the list. */
export function shopLine(row: TenantRow, events: readonly ShopEvent[]): ShopLine {
  let registered: Record<string, unknown> | undefined;
  let plan: string | undefined;
  const features = new Map<string, boolean>();
  for (const e of events) {
    if (e.type === 'ShopRegistered') registered = e.payload;
    else if (e.type === 'TenantEntitlementSet' && typeof e.payload['feature'] === 'string') features.set(e.payload['feature'], e.payload['enabled'] === true);
    else if (e.type === 'BillingSubscriptionStarted' && typeof e.payload['planId'] === 'string') plan = e.payload['planId'];
    else if (e.type === 'BillingSubscriptionCancelled') plan = undefined;
  }
  const str = (v: unknown): string | undefined => (typeof v === 'string' && v.trim() !== '' ? v : undefined);
  return {
    tenantId: row.tenantId,
    ...(str(registered?.['name']) === undefined ? {} : { name: str(registered?.['name'])! }),
    ...(str(registered?.['realm']) === undefined ? {} : { realm: str(registered?.['realm'])! }),
    ...(str(registered?.['webOrigin']) === undefined ? {} : { webOrigin: str(registered?.['webOrigin'])! }),
    createdBy: str(registered?.['createdBy']) ?? row.registeredBy,
    registeredAt: row.registeredAt,
    ...(plan === undefined ? {} : { plan }),
    featuresOn: [...features].filter(([, on]) => on).map(([f]) => f).sort(),
  };
}

/** The list, as the administrator reads it: one block per shop, in the order they joined. */
export function renderShopList(lines: readonly ShopLine[]): readonly string[] {
  if (lines.length === 0) return ['No shop is registered on this server.'];
  const out: string[] = [`${lines.length} shop(s), in the order they joined:`];
  for (const l of [...lines].sort((a, b) => a.registeredAt.localeCompare(b.registeredAt))) {
    out.push('');
    out.push(`${l.name ?? '(no name recorded)'} — ${l.tenantId}`);
    out.push(`  sign-in area: ${l.realm ?? 'not recorded'} · address: ${l.webOrigin ?? 'not recorded'}`);
    out.push(`  created ${l.registeredAt.slice(0, 10)} by ${l.createdBy}`);
    out.push(`  plan: ${l.plan ?? 'none'} · features on: ${l.featuresOn.length === 0 ? 'none' : l.featuresOn.join(', ')}`);
  }
  return out;
}

export interface FeatureChangeRequest {
  readonly tenantId: string;
  readonly on: readonly string[];
  readonly off: readonly string[];
  readonly operator: string;
  readonly targetKind: string | undefined;
  /** The shops registered on this server. */
  readonly knownShops: readonly string[];
  /** What the shop has on now. */
  readonly currentlyOn: readonly string[];
}

export type FeatureChangePlan =
  | { readonly ok: true; readonly changes: readonly { readonly feature: string; readonly enabled: boolean }[]; readonly unchanged: readonly string[] }
  | { readonly ok: false; readonly problems: readonly string[] };

/** Check a change of one shop's features; nothing is written by this. */
export function planFeatureChange(req: FeatureChangeRequest): FeatureChangePlan {
  const problems: string[] = [];
  const kind = req.targetKind ?? 'rehearsal';
  // Real shops' data waits for the owner's written GO (pilot hold); the server that holds them is not changed from here yet.
  if (kind === 'production') problems.push('This is a production box (MIGRATION_TARGET_KIND=production) — a shop\'s features are not changed here before the written GO for real data.');
  if (req.operator.trim() === '') problems.push('Name yourself with --operator: a change with nobody\'s name on it cannot be questioned later.');
  if (!req.knownShops.includes(req.tenantId)) problems.push(`There is no shop ${req.tenantId} on this server (shop:list shows them).`);
  if (req.on.length === 0 && req.off.length === 0) problems.push('Name at least one feature with --on or --off.');
  for (const f of new Set([...req.on, ...req.off])) {
    if (!isOptionalFeature(f)) problems.push(`"${f}" is not a feature. The features are: ${OPTIONAL_FEATURES.join(', ')}.`);
  }
  for (const f of req.on) if (req.off.includes(f)) problems.push(`"${f}" is asked to be both on and off.`);
  if (problems.length > 0) return { ok: false, problems };
  const changes: { feature: string; enabled: boolean }[] = [];
  const unchanged: string[] = [];
  for (const f of req.on) {
    if (req.currentlyOn.includes(f)) unchanged.push(f); else changes.push({ feature: f, enabled: true });
  }
  for (const f of req.off) {
    if (req.currentlyOn.includes(f)) changes.push({ feature: f, enabled: false }); else unchanged.push(f);
  }
  return { ok: true, changes, unchanged };
}
