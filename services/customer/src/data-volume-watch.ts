// The customer-data volume watch (C9 · OB-324 · DPDP Act 2023 s.10 · DPDP Rules 2025 Rules 12–13 · P-03 · P-08 ·
// hard rules #2 and #6).
//
// OB-324 (owner, 23 Oct 2026, in writing): build C9 — a customer-data volume watch that alerts the owner when volumes
// cross a threshold the CA sets. It shows "not set" until entered and NEVER fires while unset.
//
// Why a watch and not a rule: under s.10 the Central Government may notify a data fiduciary as SIGNIFICANT by the volume
// and sensitivity of the personal data it processes; a significant data fiduciary then owes a periodic data protection
// impact assessment, an independent audit and an India-based DPO (Rules 12–13). No volume is fixed in the Act or Rules
// for this, so the number is the CA's (on the lawyer's advice), entered on screen — never a number in the code.
//
//   • THE VOLUME is the number of distinct customers whose personal data the shop holds, from the registers that hold it:
//     the loyalty member register (members who have not left) and the online customers on the order record. The same
//     person under two references is counted twice — the watch errs towards telling the owner early, and says so.
//   • THE THRESHOLD is set by the CA (`privacy.volume.threshold.set`), with the basis for it; each setting a new version.
//   • THE ALERT goes into every owner's alert inbox once per threshold version when the volume reaches it — prompting
//     the owner to ask the CA and lawyer about a DPIA, an audit and a DPO — and is cleared (kept, never deleted) if the
//     volume falls back below. While the threshold is "not set", nothing is ever raised.

import type { Route } from '../../kernel/src/index';
import { apiError } from '../../kernel/src/index';

export interface VolumeThreshold {
  readonly principals: number;
  readonly basis: string;
  readonly version: number;
  readonly setBy: string;
  readonly setAt: string;
}

export interface VolumeSource { readonly source: string; readonly refs: readonly string[] }

export interface DataVolumeDeps {
  readonly thresholds: (tenantId: string) => Promise<readonly VolumeThreshold[]>;
  readonly recordThreshold: (tenantId: string, t: VolumeThreshold) => Promise<void>;
  /** The registers that hold customers' personal data, each with the customer references it holds. */
  readonly sources: (tenantId: string) => Promise<readonly VolumeSource[]>;
  /** Raise (or clear) the owner alert; answers whether something new was raised. */
  readonly raiseOwnerAlert: (tenantId: string, alert: { readonly alertId: string; readonly detail: string; readonly at: string }) => Promise<boolean>;
  readonly clearOwnerAlert: (tenantId: string, alertIdPrefix: string, at: string, detail: string) => Promise<number>;
  readonly now: () => string;
}

export const VOLUME_ALERT_PREFIX = 'dpdp-volume:';

export interface VolumeWatch {
  readonly threshold: { readonly set: false; readonly words: 'not set' } | ({ readonly set: true } & VolumeThreshold);
  readonly volume: { readonly principals: number; readonly bySource: readonly { readonly source: string; readonly principals: number }[]; readonly asOf: string; readonly note: string };
  /** null while the threshold is not set: the watch cannot judge, and never fires. */
  readonly crossed: boolean | null;
  readonly detail: string;
}

export async function readVolumeWatch(deps: Pick<DataVolumeDeps, 'thresholds' | 'sources' | 'now'>, tenantId: string): Promise<VolumeWatch> {
  const [ts, sources] = await Promise.all([deps.thresholds(tenantId), deps.sources(tenantId)]);
  const t = ts.at(-1);
  const all = new Set(sources.flatMap((s) => s.refs));
  const volume = {
    principals: all.size, bySource: sources.map((s) => ({ source: s.source, principals: new Set(s.refs).size })), asOf: deps.now(),
    note: 'distinct customer references across the registers that hold personal data; one person under two references counts twice, so the watch errs early',
  };
  if (t === undefined) {
    return { threshold: { set: false, words: 'not set' }, volume, crossed: null, detail: 'The CA has not set a threshold (not set) — the watch never alerts until one is entered.' };
  }
  const crossed = all.size >= t.principals;
  return {
    threshold: { set: true, ...t }, volume, crossed,
    detail: crossed
      ? `${all.size} customers' personal data on record — at or above the ${t.principals} the CA set (version ${t.version}). Ask the CA and lawyer whether the shop may be notified as a Significant Data Fiduciary (DPDP Act s.10) and whether a data protection impact assessment, an audit and a DPO are needed (Rules 12–13).`
      : `${all.size} customers' personal data on record — below the ${t.principals} the CA set (version ${t.version}).`,
  };
}

/** The watch's pass (the ops-alert worker, and "check now"): raise once per threshold version when crossed; clear when below. */
export async function runVolumeWatch(deps: DataVolumeDeps, tenantId: string, at: string): Promise<{ readonly raised: boolean; readonly cleared: number; readonly watch: VolumeWatch }> {
  const watch = await readVolumeWatch(deps, tenantId);
  if (watch.crossed === null) return { raised: false, cleared: 0, watch };
  if (watch.crossed && watch.threshold.set) {
    const raised = await deps.raiseOwnerAlert(tenantId, { alertId: `${VOLUME_ALERT_PREFIX}v${watch.threshold.version}`, detail: watch.detail, at });
    return { raised, cleared: 0, watch };
  }
  return { raised: false, cleared: await deps.clearOwnerAlert(tenantId, VOLUME_ALERT_PREFIX, at, watch.detail), watch };
}

export function dataVolumeWatchRoutes(deps: DataVolumeDeps): readonly Route[] {
  return [
    {
      api: 'API-06', method: 'GET', path: '/v1/privacy/data-volume-watch',
      permission: 'privacy.volume.read',
      handler: async (ctx) => ({ status: 200, body: await readVolumeWatch(deps, ctx.tenantId) }),
    },
    {
      // The CA sets (or changes) the threshold. Body: { principals: whole number ≥ 1, basis: why this number }.
      api: 'API-06', method: 'PUT', path: '/v1/privacy/data-volume-watch/threshold',
      permission: 'privacy.volume.threshold.set', idempotent: true,
      handler: async (ctx) => {
        const b = (ctx.body ?? {}) as { principals?: unknown; basis?: unknown };
        if (typeof b.principals !== 'number' || !Number.isInteger(b.principals) || b.principals < 1 || b.principals > 1_000_000_000
          || typeof b.basis !== 'string' || b.basis.trim().length < 5) {
          throw apiError(400, {
            code: 'not_readable_as_a_threshold', whatHappened: 'A threshold is a whole number of customers (1 or more) and the basis for it (the CA\'s or lawyer\'s reason, in words).',
            wasItSaved: 'not_saved', nextSafeAction: 'Send { principals, basis }. Nothing changed.',
          });
        }
        const version = (await deps.thresholds(ctx.tenantId)).length + 1;
        const t: VolumeThreshold = { principals: b.principals, basis: b.basis.trim().slice(0, 500), version, setBy: ctx.userId, setAt: deps.now() };
        await deps.recordThreshold(ctx.tenantId, t);
        return { status: 200, body: { threshold: t, watch: await readVolumeWatch(deps, ctx.tenantId) } };
      },
    },
    {
      // Run the watch now (the same pass the worker runs). Raises nothing while the threshold is not set.
      api: 'API-06', method: 'POST', path: '/v1/privacy/data-volume-watch/check',
      permission: 'privacy.volume.read', idempotent: true,
      handler: async (ctx) => {
        const out = await runVolumeWatch(deps, ctx.tenantId, deps.now());
        return { status: 200, body: { raised: out.raised, cleared: out.cleared, ...out.watch } };
      },
    },
  ];
}
