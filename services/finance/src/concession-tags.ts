// API-09 Finance — concession docket tags on the cloud (M27-FR-03; owner decision Item 3).
//
// The till's docket panel records WHICH concession sold WHAT, line by line, under the commission scheme as
// it stood. Until now that engine ran only in tests: nothing on the cloud kept the tags, and settlement
// could not see them. These routes are the durable home. Three rules from the engine are kept whole:
//
//  - A line is captured ONCE. The till's idempotency key makes a resend or a double scan return the
//    original, never a second charge. A tag id is used once; a correction is a NEW tag naming the old.
//  - Correcting is a supervisor's act (§28). The cashier's attempt is refused AND written onto the line's
//    history (P-08) — the route records the refusal before it says no.
//  - Nothing is rewritten. Every correction appends: the original gains a history event, the correction is
//    a new tag with negated or delta money (hard rule #2). "Current" is the longest history, a fold.
//
// What the tags mean for money is `tagsAsConcessionSales` in the package: the settlement and period-charge
// routes read them as concession sales tendered at the store's till, so a tagged line reconciles at
// settlement without anyone re-keying it.

import type { Route, RequestContext } from '../../kernel/src/index';
import { apiError, notFound } from '../../kernel/src/index';
import {
  captureConcessionTagIdempotent, reverseConcessionTag, adjustConcessionTag, markSettlementStatus,
  concessionTagTotals, mayConcessionTrade, termsOf,
  type ConcessionTag, type ConcessionActorRole, type CaptureInput, type CommissionSchemeSnapshot, type SettlementStatus,
} from '../../../packages/concession/src/index';
import type { ConcessionDeps } from './concession';
import type { ConcessionContract } from '../../../packages/concession/src/index';

export interface ConcessionTagDeps {
  readonly contract: ConcessionDeps['contract'];
  /** The one standing version of each tag on the contract (every correction appends a version). */
  readonly tags: (tenantId: string, contractId: string) => Promise<readonly ConcessionTag[]> | readonly ConcessionTag[];
  readonly appendTag: (tenantId: string, tag: ConcessionTag) => Promise<void> | void;
  readonly rolesOf: (tenantId: string, userId: string) => Promise<readonly string[]> | readonly string[];
  /** Every contract ever defined for a partner (latest terms of each) — how a SYNCED tag that names only the
   *  partner finds the contract it belongs to. */
  readonly contractsFor: (tenantId: string, concessionaireId: string) => Promise<readonly ConcessionContract[]> | readonly ConcessionContract[];
  /** Every contract in the tenant (latest terms of each) — the trading feed the store computers pull (PF-13). */
  readonly allContracts?: (tenantId: string) => Promise<readonly ConcessionContract[]>;
  /**
   * A line that arrived for a counter whose agreement did not allow trading that day (PF-13): it happened (the money was
   * taken before the store computer knew, or on a box that never pulled the decisions), so it is recorded AND kept as a
   * durable exception for a person. Idempotent on the tag.
   */
  readonly recordTradingBreach?: (tenantId: string, breach: ConcessionTradingBreach) => Promise<void>;
  readonly tradingBreaches?: (tenantId: string) => Promise<readonly ConcessionTradingBreach[]>;
  readonly now: () => string;
}

/** A concession line taken on a day its counter could not trade — kept, never dropped, for a person to settle (PF-13). */
export interface ConcessionTradingBreach {
  readonly tagId: string;
  readonly contractId: string;
  readonly concessionaireId: string;
  readonly saleId: string;
  readonly grossMinor: number;
  readonly day: string;
  readonly blockedBy: readonly string[];
  readonly recordedAt: string;
}

/** The engine's actor role from the caller's grants: a manager may correct, a cashier may not (§28). */
export function actorRoleOf(roles: readonly string[]): ConcessionActorRole {
  if (roles.includes('owner') || roles.includes('store_manager')) return 'store_manager';
  if (roles.some((r) => r !== 'cashier')) return 'supervisor';
  return 'cashier';
}

const KINDS: readonly CaptureInput['kind'][] = ['sale', 'return', 'cancellation'];
const STATUS_ORDER: readonly SettlementStatus[] = ['pending', 'included_in_charge', 'settled'];
const isStr = (v: unknown): v is string => typeof v === 'string' && v.trim() !== '';
const isInt = (v: unknown): v is number => Number.isInteger(v);
const isDate = (v: unknown): v is string => typeof v === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(v);
const isIso = (v: unknown): v is string => typeof v === 'string' && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/.test(v);
const inWindow = (at: string, from: string | undefined, to: string | undefined): boolean =>
  (from === undefined || at >= from) && (to === undefined || at <= `${to}T23:59:59.999Z`);

function ids(ctx: RequestContext): { readonly contractId: string; readonly tagId: string } {
  return { contractId: ctx.params['contractId'] ?? '', tagId: ctx.params['tagId'] ?? '' };
}

const usedTagId = (tagId: string, contractId: string) => apiError(409, {
  code: 'tag_already_recorded',
  whatHappened: `${tagId} is already on the record for ${contractId}. A tag id is used once.`,
  wasItSaved: 'not_saved',
  nextSafeAction: 'Send a new tag id. To correct a posted line, reverse or adjust it — never re-send it.',
});

/** The routes behind PF-13: the trading feed the store computers pull, and the breaches kept for a person. */
export function concessionTradingRoutes(deps: ConcessionTagDeps): readonly Route[] {
  return [
    {
      // Every agreement's TERMS (dates, approval, active) — the box decides each counter by its own calendar, offline.
      api: 'API-09', method: 'GET', path: '/v1/concession/trading-feed',
      permission: 'concession.tag.sync', entitlement: 'dept.concession',
      handler: async (ctx) => {
        const all = deps.allContracts === undefined ? [] : await deps.allContracts(ctx.tenantId);
        return { status: 200, body: { tenantId: ctx.tenantId, generatedAt: deps.now(), contracts: all.map(termsOf) } };
      },
    },
    {
      api: 'API-09', method: 'GET', path: '/v1/concession/trading-breaches',
      permission: 'concession.charge.read', entitlement: 'dept.concession',
      handler: async (ctx) => {
        const breaches = deps.tradingBreaches === undefined ? [] : await deps.tradingBreaches(ctx.tenantId);
        return { status: 200, body: { count: breaches.length, breaches, asAt: deps.now() } };
      },
    },
  ];
}

export function concessionTagRoutes(deps: ConcessionTagDeps): readonly Route[] {
  const ACTOR_ROLES: readonly ConcessionActorRole[] = ['cashier', 'supervisor', 'store_manager'];
  const isActorRole = (v: unknown): v is ConcessionActorRole => typeof v === 'string' && (ACTOR_ROLES as readonly string[]).includes(v);
  /** The partner's ONE contract in force on a day — none or several is a question for a person, never a guess. */
  const contractInForce = async (tenantId: string, concessionaireId: string, day: string): Promise<{ readonly contract?: ConcessionContract; readonly candidates: number }> => {
    const all = await deps.contractsFor(tenantId, concessionaireId);
    const live = all.filter((c) => c.active && c.startsOn <= day && day <= c.endsOn);
    return { ...(live.length === 1 ? { contract: live[0] } : {}), candidates: live.length };
  };
  const load = async (tenantId: string, contractId: string) => {
    const contract = await deps.contract(tenantId, contractId);
    if (contract === undefined) throw notFound(`concession contract ${contractId}`);
    return { contract, tags: await deps.tags(tenantId, contractId) };
  };
  const role = async (tenantId: string, userId: string): Promise<ConcessionActorRole> => actorRoleOf(await deps.rolesOf(tenantId, userId));

  return [
    {
      // The till's docket line, relayed by the STORE BOX (M27-FR-03 · §31 · Item 3). A cashier records a
      // concession line offline; the box writes it durably, queues it, and the sync agent relays it here under
      // the store token — the SAME engine and stream the online record route uses. Two things differ from that
      // route, both because the till is offline when it records: (1) the till names the PARTNER (and may name the
      // contract); the contract in force on the day is resolved HERE, so the scheme snapshot is the cloud's, never
      // the till's; (2) who recorded it is the RELAYED cashier and their role (as the synced return relays
      // `processedBy`), recorded as such — the box's identity is the courier, not the author. Refusals a person
      // must look at (no contract in force, an ambiguous one) are 422 → the box dead-letters them by name; a tag
      // id already on the record is 409 → the box counts it delivered (hard rule #6: nothing is dropped).
      api: 'API-09', method: 'POST', path: '/v1/concession/tags/synced',
      permission: 'concession.tag.sync', entitlement: 'dept.concession', idempotent: true,
      handler: async (ctx) => {
        const b = (ctx.body ?? {}) as Record<string, unknown>;
        const kind = (b['kind'] ?? 'sale') as CaptureInput['kind'];
        const need = ['tagId', 'saleId', 'lineId', 'productId', 'concessionaireId', 'counterId', 'tillId', 'shiftId', 'source', 'capturedBy'] as const;
        if (!KINDS.includes(kind) || need.some((k) => !isStr(b[k])) || !isActorRole(b['byRole']) || !isInt(b['qty']) || (b['qty'] as number) <= 0
          || !isInt(b['grossMinor']) || !isInt(b['discountMinor']) || !isInt(b['taxMinor'])
          || (b['contractId'] !== undefined && !isStr(b['contractId']))
          || (b['correctsTagId'] !== undefined && !isStr(b['correctsTagId'])) || (b['at'] !== undefined && !isIso(b['at']))) {
          throw apiError(400, {
            code: 'not_readable_as_a_synced_concession_tag',
            whatHappened: 'A relayed docket line needs its tag id, the sale and line ids, the product, the partner, the counter, till and shift, a whole '
              + 'positive qty, whole gross/discount/tax in paise, the approved source, who captured it and their role (cashier, supervisor, store_manager); '
              + 'optionally the contract, a kind, the tag it corrects and an ISO time.',
            wasItSaved: 'not_saved', nextSafeAction: 'Keep it in the box\'s outbox and raise it — a line the till recorded must not be dropped.',
          });
        }
        const key = ctx.idempotencyKey ?? (isStr(b['idempotencyKey']) ? b['idempotencyKey'] : undefined);
        if (key === undefined) {
          throw apiError(400, {
            code: 'tag_needs_an_idempotency_key',
            whatHappened: 'A relayed docket line is recorded once: the box must send its idempotency key so a resend never charges twice.',
            wasItSaved: 'not_saved', nextSafeAction: 'Send the Idempotency-Key header and try again.',
          });
        }
        const at = isIso(b['at']) ? b['at'] : deps.now();
        const tagId = b['tagId'] as string;
        const concessionaireId = b['concessionaireId'] as string;
        // The contract: named by the till, or the partner's one contract in force on the day.
        let contract: ConcessionContract | undefined;
        if (isStr(b['contractId'])) {
          contract = await deps.contract(ctx.tenantId, b['contractId']);
          if (contract === undefined) throw notFound(`concession contract ${b['contractId']}`);
          if (contract.concessionaireId !== concessionaireId) {
            throw apiError(422, {
              code: 'contract_is_not_this_partners',
              whatHappened: `${contract.contractId} belongs to ${contract.concessionaireId}, not to ${concessionaireId} as the till said.`,
              wasItSaved: 'not_saved', nextSafeAction: 'A person checks the counter\'s contract; the line is kept in the box\'s dead letters.',
            });
          }
        } else {
          const found = await contractInForce(ctx.tenantId, concessionaireId, at.slice(0, 10));
          if (found.contract === undefined) {
            throw apiError(422, {
              code: found.candidates === 0 ? 'no_contract_in_force_for_partner' : 'contract_ambiguous_for_partner',
              whatHappened: found.candidates === 0
                ? `${concessionaireId} has no active concession contract covering ${at.slice(0, 10)}, so this line has no contract to sit on.`
                : `${concessionaireId} has ${found.candidates} contracts in force on ${at.slice(0, 10)}; the till must name which.`,
              wasItSaved: 'not_saved', nextSafeAction: 'A person decides: define or activate the contract, or name it from the till. The line is kept in the box\'s dead letters.',
            });
          }
          contract = found.contract;
        }
        const tags = await deps.tags(ctx.tenantId, contract.contractId);
        if (tags.some((t) => t.tagId === tagId)) throw usedTagId(tagId, contract.contractId);
        const scheme: CommissionSchemeSnapshot = {
          contractId: contract.contractId, basis: contract.basis, commissionOn: contract.commissionOn ?? 'net',
          ...(contract.revenueShareBps === undefined ? {} : { revenueShareBps: contract.revenueShareBps }),
        };
        const input: CaptureInput = {
          tenantId: ctx.tenantId, tagId, kind,
          saleId: b['saleId'] as string, lineId: b['lineId'] as string,
          concessionaireId: contract.concessionaireId, counterId: b['counterId'] as string, branchId: contract.branchId,
          tillId: b['tillId'] as string, shiftId: b['shiftId'] as string, productId: b['productId'] as string,
          qty: b['qty'] as number, grossMinor: b['grossMinor'] as number, discountMinor: b['discountMinor'] as number, taxMinor: b['taxMinor'] as number,
          // The RELAYED cashier and role — the box is the courier, never the author (§28 re-checked on correction).
          scheme, capturedBy: b['capturedBy'] as string, byRole: b['byRole'], source: b['source'] as string,
          idempotencyKey: key, at,
          ...(isStr(b['correctsTagId']) ? { correctsTagId: b['correctsTagId'] } : {}),
        };
        const result = captureConcessionTagIdempotent(input, tags);
        if (!result.captured || result.tag === undefined) {
          return { status: 200, body: { captured: false, refusal: result.refusal, existing: result.existing, synced: true } };
        }
        await deps.appendTag(ctx.tenantId, result.tag);
        const trading = mayConcessionTrade({ contract, today: at.slice(0, 10) });
        // PF-13: a SALE on a day the counter could not trade already happened — recorded above, and kept as a durable
        // exception for a person (never dropped, never a refusal of something that happened).
        let breach: ConcessionTradingBreach | undefined;
        if (!trading.mayTrade && kind === 'sale' && deps.recordTradingBreach !== undefined) {
          breach = {
            tagId, contractId: contract.contractId, concessionaireId: contract.concessionaireId, saleId: b['saleId'] as string,
            grossMinor: b['grossMinor'] as number, day: at.slice(0, 10), blockedBy: trading.blockedBy, recordedAt: deps.now(),
          };
          await deps.recordTradingBreach(ctx.tenantId, breach);
        }
        return { status: 201, body: { captured: true, tag: result.tag, trading, contractId: contract.contractId, synced: true, ...(breach === undefined ? {} : { breach }) } };
      },
    },
    {
      api: 'API-09', method: 'GET', path: '/v1/concession/contracts/:contractId/tags',
      permission: 'concession.tag.record', entitlement: 'dept.concession',
      handler: async (ctx) => {
        const { contractId } = ids(ctx);
        const from = ctx.query['from']; const to = ctx.query['to'];
        if ((from !== undefined && !isDate(from)) || (to !== undefined && !isDate(to))) {
          throw apiError(400, {
            code: 'tags_window_not_readable', whatHappened: 'A window is ?from=YYYY-MM-DD&to=YYYY-MM-DD (either may be omitted).',
            wasItSaved: 'not_saved', nextSafeAction: 'Correct the dates and ask again.',
          });
        }
        const { contract, tags } = await load(ctx.tenantId, contractId);
        const window = tags.filter((t) => inWindow(t.at, from, to));
        const totals = concessionTagTotals({
          tags, tenantId: ctx.tenantId, concessionaireId: contract.concessionaireId,
          ...(from === undefined ? {} : { from }), ...(to === undefined ? {} : { to }),
        });
        return { status: 200, body: { contractId, concessionaireId: contract.concessionaireId, tags: window, totals, asAt: deps.now() } };
      },
    },
    {
      api: 'API-09', method: 'POST', path: '/v1/concession/contracts/:contractId/tag-settlement',
      permission: 'concession.contract.manage', entitlement: 'dept.concession', idempotent: true,
      handler: async (ctx) => {
        const { contractId } = ids(ctx);
        const b = (ctx.body ?? {}) as Record<string, unknown>;
        const status = b['status'];
        if ((status !== 'included_in_charge' && status !== 'settled') || !isDate(b['from']) || !isDate(b['to'])) {
          throw apiError(400, {
            code: 'not_readable_as_a_settlement_mark',
            whatHappened: "Marking tags needs a status (included_in_charge or settled) and a window from/to (YYYY-MM-DD).",
            wasItSaved: 'not_saved', nextSafeAction: 'Send the status and the window. Nothing was marked.',
          });
        }
        const { tags } = await load(ctx.tenantId, contractId);
        const byRole = await role(ctx.tenantId, ctx.userId);
        const target = STATUS_ORDER.indexOf(status);
        const now = deps.now();
        const marked: string[] = [];
        for (const tag of tags) {
          if (!inWindow(tag.at, b['from'], b['to'])) continue;
          if (STATUS_ORDER.indexOf(tag.settlementStatus) >= target) continue; // forward only; never un-settle
          await deps.appendTag(ctx.tenantId, markSettlementStatus(tag, status, ctx.userId, byRole, now));
          marked.push(tag.tagId);
        }
        return { status: 200, body: { contractId, status, marked: marked.length, tagIds: marked, asAt: now } };
      },
    },
    {
      api: 'API-09', method: 'POST', path: '/v1/concession/contracts/:contractId/tags/:tagId',
      permission: 'concession.tag.record', entitlement: 'dept.concession', idempotent: true,
      handler: async (ctx) => {
        const { contractId, tagId } = ids(ctx);
        const b = (ctx.body ?? {}) as Record<string, unknown>;
        const kind = (b['kind'] ?? 'sale') as CaptureInput['kind'];
        const need = ['saleId', 'lineId', 'productId', 'counterId', 'tillId', 'shiftId', 'source'] as const;
        if (!KINDS.includes(kind) || need.some((k) => !isStr(b[k])) || !isInt(b['qty']) || (b['qty'] as number) <= 0
          || !isInt(b['grossMinor']) || !isInt(b['discountMinor']) || !isInt(b['taxMinor'])
          || (b['correctsTagId'] !== undefined && !isStr(b['correctsTagId'])) || (b['at'] !== undefined && !isIso(b['at']))) {
          throw apiError(400, {
            code: 'not_readable_as_a_concession_tag',
            whatHappened: 'A docket line needs the sale and line ids, the product and a whole positive qty, the counter, till and shift, '
              + 'whole gross/discount/tax in paise, the approved source (docket/app ref), and optionally a kind (sale, return, cancellation), '
              + 'the tag it corrects and an ISO time.',
            wasItSaved: 'not_saved', nextSafeAction: 'Send the docket fields and try again. Nothing was recorded.',
          });
        }
        const key = ctx.idempotencyKey ?? (isStr(b['idempotencyKey']) ? b['idempotencyKey'] : undefined);
        if (key === undefined) {
          throw apiError(400, {
            code: 'tag_needs_an_idempotency_key',
            whatHappened: 'A docket line is recorded once: the till must send its idempotency key so a resend never charges twice.',
            wasItSaved: 'not_saved', nextSafeAction: 'Send the Idempotency-Key header (or idempotencyKey in the body) and try again.',
          });
        }
        const { contract, tags } = await load(ctx.tenantId, contractId);
        if (tags.some((t) => t.tagId === tagId)) throw usedTagId(tagId, contractId);
        const at = isIso(b['at']) ? b['at'] : deps.now();
        const scheme: CommissionSchemeSnapshot = {
          contractId, basis: contract.basis, commissionOn: contract.commissionOn ?? 'net',
          ...(contract.revenueShareBps === undefined ? {} : { revenueShareBps: contract.revenueShareBps }),
        };
        const input: CaptureInput = {
          tenantId: ctx.tenantId, tagId, kind,
          saleId: b['saleId'] as string, lineId: b['lineId'] as string,
          concessionaireId: contract.concessionaireId, counterId: b['counterId'] as string, branchId: contract.branchId,
          tillId: b['tillId'] as string, shiftId: b['shiftId'] as string, productId: b['productId'] as string,
          qty: b['qty'] as number, grossMinor: b['grossMinor'] as number, discountMinor: b['discountMinor'] as number, taxMinor: b['taxMinor'] as number,
          scheme, capturedBy: ctx.userId, byRole: await role(ctx.tenantId, ctx.userId), source: b['source'] as string,
          idempotencyKey: key, at,
          ...(isStr(b['correctsTagId']) ? { correctsTagId: b['correctsTagId'] } : {}),
        };
        const result = captureConcessionTagIdempotent(input, tags);
        if (!result.captured || result.tag === undefined) {
          return { status: 200, body: { captured: false, refusal: result.refusal, existing: result.existing } };
        }
        await deps.appendTag(ctx.tenantId, result.tag);
        // FR-04 is a till-side gate; here it is a VISIBLE flag on a sale that already happened, never a hidden one.
        const trading = mayConcessionTrade({ contract, today: at.slice(0, 10) });
        return { status: 201, body: { captured: true, tag: result.tag, trading } };
      },
    },
    {
      api: 'API-09', method: 'POST', path: '/v1/concession/contracts/:contractId/tags/:tagId/reverse',
      permission: 'concession.tag.record', entitlement: 'dept.concession', idempotent: true,
      handler: async (ctx) => {
        const { contractId, tagId } = ids(ctx);
        const b = (ctx.body ?? {}) as Record<string, unknown>;
        if (!isStr(b['reasonCode']) || (b['newTagId'] !== undefined && !isStr(b['newTagId']))) {
          throw apiError(400, {
            code: 'reversal_needs_a_reason', whatHappened: 'Reversing a posted line needs a reasonCode (and optionally the new tag id).',
            wasItSaved: 'not_saved', nextSafeAction: 'Send the reason and try again. The line stands as posted.',
          });
        }
        const { tags } = await load(ctx.tenantId, contractId);
        const original = tags.find((t) => t.tagId === tagId);
        if (original === undefined) throw notFound(`concession tag ${tagId}`);
        const newTagId = isStr(b['newTagId']) ? b['newTagId'] : `${tagId}~rev`;
        if (tags.some((t) => t.tagId === newTagId)) throw usedTagId(newTagId, contractId);
        const byRole = await role(ctx.tenantId, ctx.userId);
        const result = reverseConcessionTag({
          original, newTagId, by: ctx.userId, byRole, reasonCode: b['reasonCode'], now: deps.now(),
          alreadyReversed: tags.some((t) => t.kind === 'reversal' && t.correctsTagId === tagId),
        });
        if (result.original.history.length > original.history.length) await deps.appendTag(ctx.tenantId, result.original);
        if (!result.corrected || result.correction === undefined) throw correctionRefused(result.refusal, byRole, tagId);
        await deps.appendTag(ctx.tenantId, result.correction);
        return { status: 201, body: { corrected: true, correction: result.correction, original: result.original } };
      },
    },
    {
      api: 'API-09', method: 'POST', path: '/v1/concession/contracts/:contractId/tags/:tagId/adjust',
      permission: 'concession.tag.record', entitlement: 'dept.concession', idempotent: true,
      handler: async (ctx) => {
        const { contractId, tagId } = ids(ctx);
        const b = (ctx.body ?? {}) as Record<string, unknown>;
        const deltas = ['grossDeltaMinor', 'discountDeltaMinor', 'taxDeltaMinor'] as const;
        if (!isStr(b['reasonCode']) || deltas.some((k) => !isInt(b[k])) || deltas.every((k) => b[k] === 0)
          || (b['newTagId'] !== undefined && !isStr(b['newTagId']))) {
          throw apiError(400, {
            code: 'adjustment_not_readable',
            whatHappened: 'Adjusting a posted line needs whole gross/discount/tax deltas in paise (not all zero) and a reasonCode.',
            wasItSaved: 'not_saved', nextSafeAction: 'Send the deltas and the reason. The line stands as posted.',
          });
        }
        const { tags } = await load(ctx.tenantId, contractId);
        const original = tags.find((t) => t.tagId === tagId);
        if (original === undefined) throw notFound(`concession tag ${tagId}`);
        const newTagId = isStr(b['newTagId']) ? b['newTagId'] : `${tagId}~adj${tags.filter((t) => t.kind === 'adjustment' && t.correctsTagId === tagId).length + 1}`;
        if (tags.some((t) => t.tagId === newTagId)) throw usedTagId(newTagId, contractId);
        const byRole = await role(ctx.tenantId, ctx.userId);
        const result = adjustConcessionTag({
          original, newTagId, by: ctx.userId, byRole, reasonCode: b['reasonCode'], now: deps.now(),
          grossDeltaMinor: b['grossDeltaMinor'] as number, discountDeltaMinor: b['discountDeltaMinor'] as number, taxDeltaMinor: b['taxDeltaMinor'] as number,
        });
        if (result.original.history.length > original.history.length) await deps.appendTag(ctx.tenantId, result.original);
        if (!result.corrected || result.correction === undefined) throw correctionRefused(result.refusal, byRole, tagId);
        await deps.appendTag(ctx.tenantId, result.correction);
        return { status: 201, body: { corrected: true, correction: result.correction, original: result.original } };
      },
    },
  ];
}

function correctionRefused(refusal: string | undefined, byRole: ConcessionActorRole, tagId: string) {
  if (refusal === 'not_permitted_for_role') {
    return apiError(403, {
      code: 'correction_not_permitted_for_role',
      whatHappened: `A ${byRole} may not correct a posted concession line (§28). The refusal was recorded on ${tagId}.`,
      wasItSaved: 'saved',
      nextSafeAction: 'Ask a supervisor or the store manager to reverse or adjust it. The line stands as posted.',
    });
  }
  return apiError(409, {
    code: 'already_reversed',
    whatHappened: `${tagId} was already reversed; a line is reversed once.`,
    wasItSaved: 'not_saved',
    nextSafeAction: 'Nothing to do — the reversal is on the record. If the money is still wrong, adjust the reversal.',
  });
}
