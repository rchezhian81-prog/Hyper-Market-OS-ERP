// API-09 Finance — monthly budgets and the fixed-asset register (OB-57 "A", owner 11 Oct 2026 · D10-FR-05 "budgets,
// fixed-asset integration and period close" · M23 · P-08 · hard rules #2, #6).
//
// BUDGETS. The owner or finance sets a month's budget by account. Every change is a NEW VERSION (never an edit — hard rule
// #2): who set it, when, why, and the lines. Actual-vs-budget is read from the books — the journals posted to that month,
// each account read by the accountant's account classes (income, liability and equity as credits; expense and asset as
// debits) — so the "actual" is the same figure the period P&L shows. An account with actuals and no budget is listed as
// unbudgeted, never hidden; an account with no class is said to be read as a debit balance.
//
// FIXED ASSETS. A register of the shop's own equipment (freezers, shelving, billing PCs): added once at its cost, salvage
// value, useful life in months and the date it went into service; TRANSFERRED between stores (a dated fact — depreciation
// follows the asset); DISPOSED once with what it fetched. Straight-line depreciation: (cost − salvage) ÷ life per month,
// from the month it went into service, the last month taking the rounding remainder so the total is exact; no
// depreciation from the month of disposal on. The monthly run posts, through the accountant's posting map, the asset's
// acquisition once, each month's depreciation once (one journal per asset per month — a re-run posts nothing twice) and
// the disposal once (book value out, the gain or loss on it). A kind the map does not name is listed and stays unposted
// (P-08). A closed month takes nothing new: a month that was missed posts into the month being run, carrying its date.

import type { Route } from '../../kernel/src/index';
import { apiError } from '../../kernel/src/index';
import { postJournal as postMapped, UnmappedKindError, MissingComponentError, UnbalancedJournalError } from '../../../packages/finance/src/posting';
import { postJournal, type FinanceDeps, type JournalEntry } from './index';
import type { StoredPostingMap } from './day-book';
import type { AccountClass } from './period-books';

// ── Budgets ─────────────────────────────────────────────────────────────────────────────────────────────────────

export interface BudgetLine { readonly account: string; readonly amountMinor: number }
export interface BudgetVersion {
  readonly period: string;
  readonly version: number;
  readonly lines: readonly BudgetLine[];
  readonly setBy: string;
  readonly at: string;
  readonly reason: string;
}

/** The month's actual per account from its journals, read by the account classes. Pure. */
export function actualsFor(period: string, journals: readonly JournalEntry[], classes: Readonly<Record<string, AccountClass>>): Map<string, number> {
  const out = new Map<string, number>();
  for (const j of journals) {
    if (j.period !== period) continue;
    for (const l of j.lines) {
      const c = classes[l.accountCode];
      const creditNatured = c === 'income' || c === 'liability' || c === 'equity';
      out.set(l.accountCode, (out.get(l.accountCode) ?? 0) + (creditNatured ? l.creditMinor - l.debitMinor : l.debitMinor - l.creditMinor));
    }
  }
  return out;
}

/** Actual against the latest budget. Pure. */
export function budgetVsActual(budget: BudgetVersion | undefined, actuals: ReadonlyMap<string, number>, classes: Readonly<Record<string, AccountClass>>) {
  const budgeted = new Map((budget?.lines ?? []).map((l) => [l.account, l.amountMinor] as const));
  const rows = [...budgeted.entries()].map(([account, budgetMinor]) => {
    const actualMinor = actuals.get(account) ?? 0;
    return { account, accountClass: classes[account] ?? null, budgetMinor, actualMinor, varianceMinor: actualMinor - budgetMinor };
  });
  const unbudgeted = [...actuals.entries()].filter(([a, v]) => !budgeted.has(a) && v !== 0).map(([account, actualMinor]) => ({ account, accountClass: classes[account] ?? null, actualMinor }));
  return { rows, unbudgeted, unclassified: [...new Set([...rows.map((r) => r.account), ...unbudgeted.map((u) => u.account)])].filter((a) => classes[a] === undefined) };
}

// ── Fixed assets ────────────────────────────────────────────────────────────────────────────────────────────────

export type FixedAssetFact =
  | { readonly kind: 'added'; readonly assetId: string; readonly name: string; readonly category: string; readonly storeId: string; readonly costMinor: number; readonly salvageMinor: number; readonly usefulLifeMonths: number; readonly inServiceDate: string; readonly by: string; readonly at: string }
  | { readonly kind: 'transferred'; readonly assetId: string; readonly fromStoreId: string; readonly toStoreId: string; readonly on: string; readonly reason: string; readonly by: string; readonly at: string }
  | { readonly kind: 'disposed'; readonly assetId: string; readonly on: string; readonly proceedsMinor: number; readonly reason: string; readonly by: string; readonly at: string };

export interface FixedAsset {
  readonly assetId: string; readonly name: string; readonly category: string; readonly costMinor: number; readonly salvageMinor: number;
  readonly usefulLifeMonths: number; readonly inServiceDate: string; readonly storeId: string;
  readonly transfers: readonly Extract<FixedAssetFact, { kind: 'transferred' }>[];
  readonly disposal: Extract<FixedAssetFact, { kind: 'disposed' }> | null;
}

export function foldAssets(facts: readonly FixedAssetFact[]): readonly FixedAsset[] {
  const out = new Map<string, FixedAsset>();
  for (const f of facts) {
    const a = out.get(f.assetId);
    if (f.kind === 'added') { if (a === undefined) out.set(f.assetId, { assetId: f.assetId, name: f.name, category: f.category, costMinor: f.costMinor, salvageMinor: f.salvageMinor, usefulLifeMonths: f.usefulLifeMonths, inServiceDate: f.inServiceDate, storeId: f.storeId, transfers: [], disposal: null }); continue; }
    if (a === undefined) continue;
    if (f.kind === 'transferred') out.set(f.assetId, { ...a, storeId: f.toStoreId, transfers: [...a.transfers, f] });
    else if (a.disposal === null) out.set(f.assetId, { ...a, disposal: f });
  }
  return [...out.values()].sort((x, y) => x.assetId.localeCompare(y.assetId));
}

const addMonths = (month: string, n: number): string => {
  const d = new Date(Date.UTC(Number(month.slice(0, 4)), Number(month.slice(5, 7)) - 1 + n, 1));
  return d.toISOString().slice(0, 7);
};

/** The straight-line schedule: one row per month from the in-service month, until the life ends or the asset is disposed. Pure. */
export function depreciationSchedule(a: Pick<FixedAsset, 'costMinor' | 'salvageMinor' | 'usefulLifeMonths' | 'inServiceDate' | 'disposal'>): readonly { readonly month: string; readonly amountMinor: number }[] {
  const depreciable = a.costMinor - a.salvageMinor;
  const base = Math.floor(depreciable / a.usefulLifeMonths);
  const start = a.inServiceDate.slice(0, 7);
  const stop = a.disposal?.on.slice(0, 7);
  const rows: { month: string; amountMinor: number }[] = [];
  for (let k = 0; k < a.usefulLifeMonths; k += 1) {
    const month = addMonths(start, k);
    if (stop !== undefined && month >= stop) break;
    rows.push({ month, amountMinor: k === a.usefulLifeMonths - 1 ? depreciable - base * (a.usefulLifeMonths - 1) : base });
  }
  return rows.filter((r) => r.amountMinor > 0);
}

/** Where the asset stood in a month: its last transfer dated in or before that month. Pure. */
export const storeInMonth = (a: FixedAsset, month: string): string => {
  let store = a.transfers.length > 0 ? a.transfers[0]!.fromStoreId : a.storeId;
  for (const t of a.transfers) if (t.on.slice(0, 7) <= month) store = t.toStoreId;
  return store;
};

/** A fixed-asset voucher: a finance journal that names the asset and what it posts. */
export interface FixedAssetJournal extends JournalEntry {
  readonly fixedAsset: { readonly assetId: string; readonly kind: 'acquisition' | 'depreciation' | 'disposal'; readonly month?: string; readonly storeId: string; readonly amountMinor: number };
}

export interface BudgetAssetDeps extends Pick<FinanceDeps, 'periodStates' | 'appendJournal' | 'now'> {
  readonly budgets: (tenantId: string) => Promise<readonly BudgetVersion[]>;
  /** Append a version; false when that version number is already taken (somebody set the budget meanwhile). */
  readonly recordBudget: (tenantId: string, v: BudgetVersion) => Promise<boolean>;
  readonly assetFacts: (tenantId: string) => Promise<readonly FixedAssetFact[]>;
  readonly recordAssetFact: (tenantId: string, f: FixedAssetFact, key: string) => Promise<void>;
  readonly journals: (tenantId: string) => Promise<readonly JournalEntry[]>;
  readonly accountClasses: (tenantId: string) => Promise<Readonly<Record<string, AccountClass>> | undefined>;
  readonly postingMap: (tenantId: string) => Promise<StoredPostingMap | undefined> | StoredPostingMap | undefined;
}

const PERIOD = /^\d{4}-(0[1-9]|1[0-2])$/;
const DATE = /^\d{4}-(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])$/;
const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const isStr = (v: unknown): v is string => typeof v === 'string' && v.trim() !== '';
const isInt = (v: unknown): v is number => typeof v === 'number' && Number.isSafeInteger(v);
const refuse = (status: number, code: string, whatHappened: string, nextSafeAction: string) => apiError(status, { code, whatHappened, wasItSaved: 'not_saved', nextSafeAction });

export function budgetAssetRoutes(deps: BudgetAssetDeps): readonly Route[] {
  const periodOf = (raw: string | undefined): string => {
    const p = raw ?? '';
    if (!PERIOD.test(p)) throw refuse(400, 'bad_period', `'${p}' is not a month (YYYY-MM).`, 'Send the month as YYYY-MM.');
    return p;
  };
  const assetOr404 = async (t: string, assetId: string): Promise<FixedAsset> => {
    const a = foldAssets(await deps.assetFacts(t)).find((x) => x.assetId === assetId);
    if (a === undefined) throw refuse(404, 'no_such_asset', `There is no fixed asset ${assetId} on the register.`, 'Add it first (POST /v1/finance/fixed-assets/:assetId).');
    return a;
  };
  const assetJournals = async (t: string): Promise<readonly FixedAssetJournal[]> => (await deps.journals(t)).filter((j): j is FixedAssetJournal => 'fixedAsset' in j);

  return [
    // ── Budgets ──
    {
      api: 'API-09', method: 'PUT', path: '/v1/finance/budgets/:period',
      permission: 'finance.posting.configure', idempotent: true,
      handler: async (ctx) => {
        const period = periodOf(ctx.params['period']);
        const b = isObj(ctx.body) ? ctx.body : {};
        const lines = Array.isArray(b['lines']) ? b['lines'] : [];
        const readable = lines.length > 0 && lines.every((l) => isObj(l) && isStr(l['account']) && isInt(l['amountMinor']) && (l['amountMinor'] as number) >= 0)
          && new Set(lines.map((l) => (l as { account: string }).account)).size === lines.length;
        if (!readable) throw refuse(400, 'not_readable_as_a_budget', 'A budget is { lines: [{ account, amountMinor (paise, 0 or more) }], reason? } — each account once.', 'Send the month\'s budget lines. Nothing was changed.');
        const versions = (await deps.budgets(ctx.tenantId)).filter((v) => v.period === period);
        const version = versions.reduce((n, v) => Math.max(n, v.version), 0) + 1;
        const v: BudgetVersion = {
          period, version, setBy: ctx.userId, at: deps.now(), reason: isStr(b['reason']) ? (b['reason'] as string).slice(0, 300) : '',
          lines: (lines as { account: string; amountMinor: number }[]).map((l) => ({ account: l.account.trim(), amountMinor: l.amountMinor })),
        };
        if (!(await deps.recordBudget(ctx.tenantId, v))) {
          throw refuse(409, 'budget_changed_meanwhile', `Somebody set ${period}'s budget at the same moment (version ${version}).`, 'Read the budget again, then set it. Nothing was changed.');
        }
        return { status: 201, body: { budget: v } };
      },
    },
    {
      api: 'API-09', method: 'GET', path: '/v1/finance/budgets/:period',
      permission: 'finance.period.read',
      handler: async (ctx) => {
        const period = periodOf(ctx.params['period']);
        const [all, journals, classes] = await Promise.all([deps.budgets(ctx.tenantId), deps.journals(ctx.tenantId), deps.accountClasses(ctx.tenantId)]);
        const versions = all.filter((v) => v.period === period).sort((a, b) => a.version - b.version);
        const latest = versions[versions.length - 1];
        const cls = classes ?? {};
        const vs = budgetVsActual(latest, actualsFor(period, journals, cls), cls);
        return {
          status: 200,
          body: {
            period, budget: latest ?? null,
            versions: versions.map((v) => ({ version: v.version, setBy: v.setBy, at: v.at, reason: v.reason, totalMinor: v.lines.reduce((n, l) => n + l.amountMinor, 0) })),
            ...vs, classesDefined: classes !== undefined, asAt: deps.now(),
          },
        };
      },
    },

    // ── Fixed assets ──
    {
      api: 'API-09', method: 'GET', path: '/v1/finance/fixed-assets',
      permission: 'finance.period.read',
      handler: async (ctx) => {
        const [assets, journals] = await Promise.all([deps.assetFacts(ctx.tenantId).then(foldAssets), assetJournals(ctx.tenantId)]);
        return {
          status: 200,
          body: {
            assets: assets.map((a) => {
              const mine = journals.filter((j) => j.fixedAsset.assetId === a.assetId);
              const depreciationPostedMinor = mine.filter((j) => j.fixedAsset.kind === 'depreciation').reduce((n, j) => n + j.fixedAsset.amountMinor, 0);
              return {
                ...a, state: a.disposal === null ? 'in_use' : 'disposed',
                depreciationPostedMinor, bookValueMinor: a.disposal !== null && mine.some((j) => j.fixedAsset.kind === 'disposal') ? 0 : a.costMinor - depreciationPostedMinor,
                monthlyMinor: Math.floor((a.costMinor - a.salvageMinor) / a.usefulLifeMonths),
                acquisitionPosted: mine.some((j) => j.fixedAsset.kind === 'acquisition'),
                disposalPosted: mine.some((j) => j.fixedAsset.kind === 'disposal'),
              };
            }),
            asAt: deps.now(),
          },
        };
      },
    },
    {
      api: 'API-09', method: 'POST', path: '/v1/finance/fixed-assets/:assetId',
      permission: 'finance.journal.post', idempotent: true,
      handler: async (ctx) => {
        const assetId = ctx.params['assetId'] ?? '';
        const b = isObj(ctx.body) ? ctx.body : {};
        const ok = isStr(b['name']) && isStr(b['category']) && isStr(b['storeId']) && isInt(b['costMinor']) && (b['costMinor'] as number) > 0
          && isInt(b['salvageMinor']) && (b['salvageMinor'] as number) >= 0 && (b['salvageMinor'] as number) <= (b['costMinor'] as number)
          && isInt(b['usefulLifeMonths']) && (b['usefulLifeMonths'] as number) >= 1 && (b['usefulLifeMonths'] as number) <= 600
          && typeof b['inServiceDate'] === 'string' && DATE.test(b['inServiceDate']);
        if (!ok) throw refuse(400, 'not_readable_as_a_fixed_asset', 'A fixed asset is { name, category, storeId, costMinor (>0), salvageMinor (0..cost), usefulLifeMonths (1..600), inServiceDate (YYYY-MM-DD) }.', 'Send the asset. Nothing was saved.');
        const f: FixedAssetFact = {
          kind: 'added', assetId, name: (b['name'] as string).trim(), category: (b['category'] as string).trim(), storeId: (b['storeId'] as string).trim(),
          costMinor: b['costMinor'] as number, salvageMinor: b['salvageMinor'] as number, usefulLifeMonths: b['usefulLifeMonths'] as number,
          inServiceDate: b['inServiceDate'] as string, by: ctx.userId, at: deps.now(),
        };
        const existing = foldAssets(await deps.assetFacts(ctx.tenantId)).find((a) => a.assetId === assetId);
        if (existing !== undefined) {
          const same = existing.name === f.name && existing.costMinor === f.costMinor && existing.salvageMinor === f.salvageMinor && existing.usefulLifeMonths === f.usefulLifeMonths && existing.inServiceDate === f.inServiceDate;
          if (same) return { status: 200, body: { asset: existing, alreadyAdded: true } };
          throw refuse(409, 'asset_exists', `${assetId} is already on the register with other figures. A register entry is never edited.`, 'Use another asset id, or dispose of this one and add the right one. Nothing was changed.');
        }
        await deps.recordAssetFact(ctx.tenantId, f, `added:${assetId}`);
        return { status: 201, body: { asset: foldAssets([f])[0] } };
      },
    },
    {
      api: 'API-09', method: 'POST', path: '/v1/finance/fixed-assets/:assetId/transfer',
      permission: 'finance.journal.post', idempotent: true,
      handler: async (ctx) => {
        const a = await assetOr404(ctx.tenantId, ctx.params['assetId'] ?? '');
        const b = isObj(ctx.body) ? ctx.body : {};
        if (!isStr(b['toStoreId']) || typeof b['on'] !== 'string' || !DATE.test(b['on']) || !isStr(b['reason'])) throw refuse(400, 'not_readable_as_a_transfer', 'A transfer is { toStoreId, on (YYYY-MM-DD), reason }.', 'Send where it went, when and why. Nothing was changed.');
        if (a.disposal !== null) throw refuse(409, 'asset_disposed', `${a.assetId} was disposed of on ${a.disposal.on}.`, 'A disposed asset does not move. Nothing was changed.');
        if (b['toStoreId'] === a.storeId) throw refuse(409, 'already_there', `${a.assetId} is already at ${a.storeId}.`, 'Nothing was changed.');
        const last = a.transfers[a.transfers.length - 1]?.on ?? a.inServiceDate;
        if ((b['on'] as string) < last) throw refuse(409, 'transfer_before_last_move', `${a.assetId} cannot move on ${b['on'] as string}: its last move or service date is ${last}.`, 'Send the real date. Nothing was changed.');
        const f: FixedAssetFact = { kind: 'transferred', assetId: a.assetId, fromStoreId: a.storeId, toStoreId: (b['toStoreId'] as string).trim(), on: b['on'] as string, reason: (b['reason'] as string).slice(0, 300), by: ctx.userId, at: deps.now() };
        await deps.recordAssetFact(ctx.tenantId, f, `transferred:${a.assetId}:${f.on}:${f.fromStoreId}:${f.toStoreId}`);
        return { status: 201, body: { transfer: f } };
      },
    },
    {
      api: 'API-09', method: 'POST', path: '/v1/finance/fixed-assets/:assetId/dispose',
      permission: 'finance.journal.post', idempotent: true,
      handler: async (ctx) => {
        const a = await assetOr404(ctx.tenantId, ctx.params['assetId'] ?? '');
        const b = isObj(ctx.body) ? ctx.body : {};
        if (typeof b['on'] !== 'string' || !DATE.test(b['on']) || !isInt(b['proceedsMinor']) || (b['proceedsMinor'] as number) < 0 || !isStr(b['reason'])) {
          throw refuse(400, 'not_readable_as_a_disposal', 'A disposal is { on (YYYY-MM-DD), proceedsMinor (what it fetched, 0 or more), reason }.', 'Send when, for how much and why. Nothing was changed.');
        }
        if (a.disposal !== null) {
          if (a.disposal.on === b['on'] && a.disposal.proceedsMinor === b['proceedsMinor']) return { status: 200, body: { disposal: a.disposal, alreadyDisposed: true } };
          throw refuse(409, 'already_disposed', `${a.assetId} was already disposed of on ${a.disposal.on} for ${a.disposal.proceedsMinor}.`, 'A disposal is recorded once. Nothing was changed.');
        }
        if ((b['on'] as string) < a.inServiceDate) throw refuse(409, 'disposed_before_service', `${a.assetId} went into service on ${a.inServiceDate}.`, 'Send the real date. Nothing was changed.');
        const month = (b['on'] as string).slice(0, 7);
        const postedLater = (await assetJournals(ctx.tenantId)).filter((j) => j.fixedAsset.assetId === a.assetId && j.fixedAsset.kind === 'depreciation' && (j.fixedAsset.month ?? '') >= month);
        if (postedLater.length > 0) throw refuse(409, 'depreciation_already_posted', `Depreciation of ${a.assetId} is already posted for ${postedLater.map((j) => j.fixedAsset.month).join(', ')} — on or after ${month}.`, 'Dispose of it on a date after the last month posted, or have the accountant post a correction first. Nothing was changed.');
        const f: FixedAssetFact = { kind: 'disposed', assetId: a.assetId, on: b['on'] as string, proceedsMinor: b['proceedsMinor'] as number, reason: (b['reason'] as string).slice(0, 300), by: ctx.userId, at: deps.now() };
        await deps.recordAssetFact(ctx.tenantId, f, `disposed:${a.assetId}`);
        return { status: 201, body: { disposal: f } };
      },
    },
    {
      // The monthly run: each asset's acquisition once, each month's depreciation once, the disposal once.
      api: 'API-09', method: 'POST', path: '/v1/finance/fixed-assets/depreciation/:period',
      permission: 'finance.journal.post', idempotent: true,
      handler: async (ctx) => {
        const period = periodOf(ctx.params['period']);
        const t = ctx.tenantId;
        const states = await deps.periodStates(t);
        if (states.get(period) === 'closed') throw refuse(409, 'period_is_closed', `${period} is closed and signed.`, 'Run depreciation for the open month; a missed month posts into it carrying its date. Nothing was posted.');
        const map = await deps.postingMap(t);
        if (map === undefined) throw refuse(409, 'posting_map_not_defined', 'No ledger mapping is defined, so no depreciation can post — which accounts carry assets is the accountant\'s decision.', 'The accountant defines the mapping (GET /v1/finance/posting-map for the suggested fixed-asset rules). Nothing was posted.');
        const [assets, done] = await Promise.all([deps.assetFacts(t).then(foldAssets), assetJournals(t)]);
        const posted = new Set(done.map((j) => j.entryId));
        const appended: FixedAssetJournal[] = [];
        const exceptions: { readonly entryId: string; readonly reason: string; readonly detail: string }[] = [];
        const post = async (entryId: string, kind: string, components: Record<string, number>, belongsTo: string, documentDate: string, fa: FixedAssetJournal['fixedAsset'], narrative: string): Promise<boolean> => {
          if (posted.has(entryId)) return true;
          let mapped;
          try {
            mapped = postMapped({ id: entryId, kind, at: `${documentDate}T00:00:00.000Z`, currency: 'INR', components }, map);
          } catch (err) {
            const reason = err instanceof UnmappedKindError ? 'unmapped_kind' : err instanceof MissingComponentError ? 'missing_component' : err instanceof UnbalancedJournalError ? 'unbalanced_journal' : 'not_posted';
            exceptions.push({ entryId, reason, detail: err instanceof Error ? err.message : String(err) });
            return false;
          }
          const into = states.get(belongsTo) === 'closed' ? period : belongsTo;
          const journal: FixedAssetJournal = {
            entryId, period: into, documentDate, narrative: `${narrative}${into !== belongsTo ? ` (posted to ${into}: ${belongsTo} is closed)` : ''}`,
            lines: mapped.lines.map((l) => ({ accountCode: l.account, debitMinor: l.side === 'debit' ? l.amount.minor : 0, creditMinor: l.side === 'credit' ? l.amount.minor : 0 })),
            postedBy: ctx.userId, fixedAsset: fa,
          };
          const gate = postJournal({ entry: journal, periodStates: states, nextOpenPeriod: period });
          if (!gate.ok) { exceptions.push({ entryId, reason: gate.refusedBecause ?? 'not_posted', detail: gate.detail }); return false; }
          await deps.appendJournal(t, journal);
          posted.add(entryId);
          appended.push(journal);
          return true;
        };
        for (const a of assets) {
          const start = a.inServiceDate.slice(0, 7);
          if (start > period) continue;
          if (!(await post(`fa-acq:${a.assetId}`, 'fixed_asset:acquisition', { cost: a.costMinor }, start, a.inServiceDate,
            { assetId: a.assetId, kind: 'acquisition', storeId: storeInMonth(a, start), amountMinor: a.costMinor },
            `Fixed asset ${a.assetId} (${a.name}, ${a.category}) into service at ${storeInMonth(a, start)} on ${a.inServiceDate}, cost ${a.costMinor}`))) continue;
          const schedule = depreciationSchedule(a);
          let allDepreciated = true;
          for (const row of schedule.filter((r) => r.month <= period)) {
            const lastDay = new Date(Date.UTC(Number(row.month.slice(0, 4)), Number(row.month.slice(5, 7)), 0)).toISOString().slice(0, 10);
            const ok = await post(`fa-dep:${a.assetId}:${row.month}`, 'fixed_asset:depreciation', { amount: row.amountMinor }, row.month, lastDay,
              { assetId: a.assetId, kind: 'depreciation', month: row.month, storeId: storeInMonth(a, row.month), amountMinor: row.amountMinor },
              `Depreciation of ${a.assetId} (${a.name}) for ${row.month} at ${storeInMonth(a, row.month)}: straight line, (${a.costMinor} − ${a.salvageMinor}) over ${a.usefulLifeMonths} months`);
            if (!ok) allDepreciated = false;
          }
          if (a.disposal !== null && a.disposal.on.slice(0, 7) <= period && allDepreciated) {
            const accumulated = schedule.reduce((n, r) => n + r.amountMinor, 0);
            const bookValue = a.costMinor - accumulated;
            const proceeds = a.disposal.proceedsMinor;
            await post(`fa-disp:${a.assetId}`, 'fixed_asset:disposal',
              { cost: a.costMinor, accumulated, proceeds, loss: Math.max(0, bookValue - proceeds), gain: Math.max(0, proceeds - bookValue) },
              a.disposal.on.slice(0, 7), a.disposal.on,
              { assetId: a.assetId, kind: 'disposal', storeId: storeInMonth(a, a.disposal.on.slice(0, 7)), amountMinor: bookValue },
              `Disposal of ${a.assetId} (${a.name}) on ${a.disposal.on}: cost ${a.costMinor}, depreciated ${accumulated}, book value ${bookValue}, fetched ${proceeds} (${a.disposal.reason})`);
          }
        }
        return { status: appended.length > 0 ? 201 : 200, body: { posted: appended, exceptions, asAt: deps.now() } };
      },
    },
  ];
}
