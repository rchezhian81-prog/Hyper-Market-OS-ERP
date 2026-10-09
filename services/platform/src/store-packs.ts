// Head office builds and delivers each store's setup file — the store pack (Wave 4 · PA-06 = DF-3-a · OB-26 "A" ·
// M01-FR-03 · M02-FR-01/02 · §31 · P-01 · P-02 · P-08 · hard rules #2 #4).
//
// Before, a store computer read its store pack from a FILE someone carried to it (the demo builder wrote one); nothing
// checked who made it, for which shop, or how old it was (audit PA-06). Now:
//
//   • **Head office builds it, always current** (owner, 9 Oct 2026, OB-26 "A"): every time a store computer asks, head
//     office assembles the pack from its own records — the products it published, the people it granted at this store
//     and their roles, the store's settings, the approvals waiting, the orders and bills, the loss-prevention rules. No
//     button to press; each part was already approved where it was made.
//   • **Signed and bound**: the envelope names the shop (tenant), the store, a version that only goes forward, when it
//     was issued and when it stops being current, and carries head office's signature over all of it. A store computer
//     trusts it only if the signature verifies, the shop and the store are its own, the version is newer than what it
//     holds, and it has not already expired.
//   • **Only for that store**: the caller must hold `store.pack.read` AT that store (their grants' branch scope), and the
//     store must be one head office knows.
//   • **The store's settings** (tolerances, cut-off, back store, …) are head office's own record now — set by someone
//     with `platform.setup.write`, a new version each change — no longer typed into a demo file.
//
// Pure of storage: the builder and the settings register are ports; the API composes them from head office's adapters.

import { createHash } from 'node:crypto';
import type { Route } from '../../kernel/src/index';
import { apiError, notFound, stableStringify } from '../../kernel/src/index';
import type { PackSigner } from '../../catalogue/src/pack';

export const STORE_PACK_FORMAT = 'sre-store-pack/1';
/** How long a pack is current for. Past this the store keeps trading on it (P-01) and SAYS it is out of date (P-08). */
export const STORE_PACK_LIFETIME_HOURS = 7 * 24;

/** What head office signs: everything but the signature. */
export interface StorePackBody {
  readonly format: typeof STORE_PACK_FORMAT;
  readonly tenantId: string;
  readonly storeId: string;
  /** Only goes forward: head office's clock in milliseconds at issue. */
  readonly version: number;
  readonly issuedAt: string;
  readonly expiresAt: string;
  /** A fingerprint of the sections — two issues with the same content have the same hash. */
  readonly contentHash: string;
  /** The pack sections, in the shape the store computer reads (`edge/store-edge/src/store-pack.ts`). */
  readonly sections: Readonly<Record<string, unknown>>;
}
export interface StorePackEnvelope extends StorePackBody {
  readonly signature: string;
}

const signedPart = (b: StorePackBody): string => stableStringify({
  format: b.format, tenantId: b.tenantId, storeId: b.storeId, version: b.version, issuedAt: b.issuedAt, expiresAt: b.expiresAt,
  contentHash: b.contentHash, sections: b.sections,
});
export const contentHashOf = (sections: Readonly<Record<string, unknown>>): string =>
  createHash('sha256').update(stableStringify(sections)).digest('hex');

export function signStorePack(signer: PackSigner, input: { tenantId: string; storeId: string; issuedAt: string; sections: Readonly<Record<string, unknown>> }): StorePackEnvelope {
  const issued = Date.parse(input.issuedAt);
  const body: StorePackBody = {
    format: STORE_PACK_FORMAT, tenantId: input.tenantId, storeId: input.storeId, version: issued,
    issuedAt: input.issuedAt, expiresAt: new Date(issued + STORE_PACK_LIFETIME_HOURS * 3_600_000).toISOString(),
    contentHash: contentHashOf(input.sections), sections: input.sections,
  };
  return { ...body, signature: signer.sign(signedPart(body)) };
}

export type StorePackVerdict =
  | { readonly accepted: true }
  | { readonly accepted: false; readonly reason: 'not_a_store_pack' | 'bad_signature' | 'wrong_shop' | 'wrong_store' | 'not_newer' | 'expired_on_arrival' | 'contents_do_not_match'; readonly staffMessage: string };

/** The ONE trust decision — head office's tests and the store computer share it. */
export function verifyStorePack(signer: PackSigner, incoming: unknown, expect: { tenantId: string; storeId: string; heldVersion: number | null; now: string }): StorePackVerdict {
  const e = incoming as Partial<StorePackEnvelope> | null;
  if (e === null || typeof e !== 'object' || e.format !== STORE_PACK_FORMAT || typeof e.signature !== 'string' || typeof e.version !== 'number'
    || typeof e.issuedAt !== 'string' || typeof e.expiresAt !== 'string' || typeof e.contentHash !== 'string' || typeof e.sections !== 'object' || e.sections === null
    || typeof e.tenantId !== 'string' || typeof e.storeId !== 'string') {
    return { accepted: false, reason: 'not_a_store_pack', staffMessage: 'head office sent something that is not a store setup file — this computer keeps the one it has' };
  }
  const env = e as StorePackEnvelope;
  if (!signer.verify(signedPart(env), env.signature)) return { accepted: false, reason: 'bad_signature', staffMessage: 'a store setup file arrived whose signature does not check — it was not used; this computer keeps the one it has' };
  if (contentHashOf(env.sections) !== env.contentHash) return { accepted: false, reason: 'contents_do_not_match', staffMessage: 'a store setup file arrived whose contents do not match its fingerprint — it was not used' };
  if (env.tenantId !== expect.tenantId) return { accepted: false, reason: 'wrong_shop', staffMessage: 'a store setup file for another shop arrived — it was not used' };
  if (env.storeId !== expect.storeId) return { accepted: false, reason: 'wrong_store', staffMessage: `a store setup file for store ${env.storeId} arrived; this computer is store ${expect.storeId} — it was not used` };
  if (expect.heldVersion !== null && env.version <= expect.heldVersion) return { accepted: false, reason: 'not_newer', staffMessage: 'the store setup file head office sent is not newer than the one this computer has' };
  if (Date.parse(env.expiresAt) <= Date.parse(expect.now)) return { accepted: false, reason: 'expired_on_arrival', staffMessage: 'a store setup file arrived already out of date (check this computer\'s clock) — it was not used' };
  return { accepted: true };
}

/** A store's settings as head office holds them — what the store computer's `policies` section carries. */
export interface StoreSettings {
  readonly storeId: string;
  readonly warehouseId: string | null;
  /** "HH:MM" — when one trading day ends and the next begins. */
  readonly tradingDayCutoff: string;
  readonly staleAfterSeconds: number;
  readonly countApprovalThresholdMinor: number;
  readonly handoverToleranceMinor: number;
  readonly cashVarianceToleranceMinor: number;
  readonly privacySlaDays: number;
  readonly version: number;
  readonly setBy: string;
  readonly setAt: string;
}

/**
 * A store's working RULES as head office holds them (PA-06 = DF-3-b-1): the limits, windows and checklist the store's
 * screens judge by. Every value is SET by someone with `platform.setup.write` — none is defaulted here, because a limit
 * nobody chose is a limit nobody owns (docs/registers/owner-configuration.md names the documented starting values).
 * A new version each change (append-only).
 */
export interface StoreRules {
  readonly storeId: string;
  /** The largest refund/adjustment a manager approves alone (OC-10). */
  readonly approvalLimitMinor: number;
  /** A price below this margin needs the pricing approver (basis points). */
  readonly marginFloorBps: number;
  /** Days before expiry a batch counts as near expiry (OC-12). */
  readonly nearExpiryDays: number;
  readonly reporting: { readonly laggingAfterMinutes: number; readonly staleAfterMinutes: number };
  readonly service: {
    readonly returnWindowDays: number; readonly approvalThresholdMinor: number; readonly noReceiptCapMinor: number;
    readonly agentAuthorityMinor: number; readonly compensationCapMinor: number;
  };
  readonly journalPrefixes: { readonly takings: string; readonly tax: string; readonly refunds: string };
  /** A sign-in unused this long is flagged dormant on the admin screen. */
  readonly dormantAfterDays: number;
  /** The AI inbox's figures count as stale after this long. */
  readonly aiStaleAfterMinutes: number;
  /** OC-44 / OC-45 / OC-46. */
  readonly merchandising: { readonly refillAtBp: number; readonly countStaleAfterMinutes: number; readonly refillRole: string };
  /** A write-off at or above this value is material (needs the second person). */
  readonly writeOffMaterialThresholdMinor: number;
  /** The day-close checklist; a blocking item must be done before the day closes. */
  readonly checklist: readonly { readonly itemId: string; readonly description: string; readonly blocking: boolean }[];
  readonly version: number;
  readonly setBy: string;
  readonly setAt: string;
}

/** Read a rules body, or name every field that is not readable. Pure. */
export function readStoreRules(b: Record<string, unknown>, roleIds: readonly string[]): { rules: Omit<StoreRules, 'storeId' | 'version' | 'setBy' | 'setAt'> } | { problems: string[] } {
  const problems: string[] = [];
  const obj = (v: unknown): Record<string, unknown> => (typeof v === 'object' && v !== null && !Array.isArray(v) ? v as Record<string, unknown> : {});
  const int = (path: string, v: unknown, max?: number): number => {
    if (!isNonNegInt(v) || (max !== undefined && v > max)) problems.push(`${path} must be a whole number${max === undefined ? '' : ` from 0 to ${max}`}`);
    return v as number;
  };
  const text = (path: string, v: unknown): string => {
    if (typeof v !== 'string' || v.trim() === '') problems.push(`${path} is required`);
    return typeof v === 'string' ? v.trim() : '';
  };
  const reporting = obj(b['reporting']); const service = obj(b['service']); const prefixes = obj(b['journalPrefixes']); const merch = obj(b['merchandising']);
  const rules = {
    approvalLimitMinor: int('approvalLimitMinor', b['approvalLimitMinor']),
    marginFloorBps: int('marginFloorBps', b['marginFloorBps'], 10_000),
    nearExpiryDays: int('nearExpiryDays', b['nearExpiryDays']),
    reporting: { laggingAfterMinutes: int('reporting.laggingAfterMinutes', reporting['laggingAfterMinutes']), staleAfterMinutes: int('reporting.staleAfterMinutes', reporting['staleAfterMinutes']) },
    service: {
      returnWindowDays: int('service.returnWindowDays', service['returnWindowDays']), approvalThresholdMinor: int('service.approvalThresholdMinor', service['approvalThresholdMinor']),
      noReceiptCapMinor: int('service.noReceiptCapMinor', service['noReceiptCapMinor']), agentAuthorityMinor: int('service.agentAuthorityMinor', service['agentAuthorityMinor']),
      compensationCapMinor: int('service.compensationCapMinor', service['compensationCapMinor']),
    },
    journalPrefixes: { takings: text('journalPrefixes.takings', prefixes['takings']), tax: text('journalPrefixes.tax', prefixes['tax']), refunds: text('journalPrefixes.refunds', prefixes['refunds']) },
    dormantAfterDays: int('dormantAfterDays', b['dormantAfterDays']),
    aiStaleAfterMinutes: int('aiStaleAfterMinutes', b['aiStaleAfterMinutes']),
    merchandising: {
      refillAtBp: int('merchandising.refillAtBp', merch['refillAtBp'], 10_000), countStaleAfterMinutes: int('merchandising.countStaleAfterMinutes', merch['countStaleAfterMinutes']),
      refillRole: text('merchandising.refillRole', merch['refillRole']),
    },
    writeOffMaterialThresholdMinor: int('writeOffMaterialThresholdMinor', b['writeOffMaterialThresholdMinor']),
    checklist: [] as { itemId: string; description: string; blocking: boolean }[],
  };
  if (rules.merchandising.refillRole !== '' && !roleIds.includes(rules.merchandising.refillRole)) problems.push(`merchandising.refillRole "${rules.merchandising.refillRole}" is not a role head office knows`);
  if (!Array.isArray(b['checklist'])) problems.push('checklist must be a list (it may be empty)');
  else {
    const seen = new Set<string>();
    (b['checklist'] as unknown[]).forEach((raw, i) => {
      const item = obj(raw);
      const itemId = text(`checklist[${i}].itemId`, item['itemId']);
      const description = text(`checklist[${i}].description`, item['description']);
      if (typeof item['blocking'] !== 'boolean') problems.push(`checklist[${i}].blocking must be true or false`);
      if (itemId !== '' && seen.has(itemId)) problems.push(`checklist item "${itemId}" is listed twice`);
      seen.add(itemId);
      rules.checklist.push({ itemId, description, blocking: item['blocking'] === true });
    });
  }
  return problems.length > 0 ? { problems } : { rules };
}

export interface StorePackDeps {
  readonly signer: PackSigner;
  readonly now: () => string;
  /** The stores head office knows: id → name (its org register's branches). */
  readonly stores: (tenantId: string) => Promise<ReadonlyMap<string, string>>;
  /** Where a person holds a permission — their grants' branches, 'all', or undefined for a name head office does not know. */
  readonly branchScopeOf: (tenantId: string, userId: string, permission: string) => Promise<readonly string[] | 'all' | undefined>;
  /** Assemble the pack's sections for one store from head office's own records. */
  readonly buildSections: (tenantId: string, storeId: string) => Promise<Readonly<Record<string, unknown>>>;
  readonly settings: (tenantId: string, storeId: string) => Promise<StoreSettings | undefined>;
  readonly recordSettings: (tenantId: string, s: StoreSettings) => Promise<void>;
  /** DF-3-b-1: the store's working rules, and the role ids head office knows (a refill role must be one). */
  readonly rules?: (tenantId: string, storeId: string) => Promise<StoreRules | undefined>;
  readonly recordRules?: (tenantId: string, r: StoreRules) => Promise<void>;
  readonly roleIds?: readonly string[];
}

const isNonNegInt = (v: unknown): v is number => typeof v === 'number' && Number.isInteger(v) && v >= 0;
const CUTOFF = /^([01]\d|2[0-3]):[0-5]\d$/;

export function storePackRoutes(deps: StorePackDeps): readonly Route[] {
  const knownStore = async (tenantId: string, storeId: string): Promise<string> => {
    const name = (await deps.stores(tenantId)).get(storeId);
    if (name === undefined) throw notFound(`store ${storeId}`);
    return name;
  };
  return [
    {
      // The store computer asks for its setup file. Built now, from head office's current records, signed, for THIS store.
      api: 'API-01', method: 'GET', path: '/v1/store-packs/:storeId',
      permission: 'store.pack.read',
      handler: async (ctx) => {
        const storeId = ctx.params['storeId'] ?? '';
        await knownStore(ctx.tenantId, storeId);
        const scope = await deps.branchScopeOf(ctx.tenantId, ctx.userId, 'store.pack.read');
        if (scope === undefined || (scope !== 'all' && !scope.includes(storeId))) {
          throw apiError(403, { code: 'not_this_stores_computer', whatHappened: `You may read the setup of the stores you work at; store ${storeId} is not one of them.`, wasItSaved: 'not_saved', nextSafeAction: 'Ask for the setup of your own store.' });
        }
        // A store with no settings is not set up: head office has nothing honest to send (no tolerances, no cut-off), and
        // says so rather than sending a setup that would leave the store computer guessing.
        if (await deps.settings(ctx.tenantId, storeId) === undefined) {
          throw apiError(404, { code: 'store_not_set_up', whatHappened: `Head office has no settings for store ${storeId} yet, so there is no setup to send.`, wasItSaved: 'not_saved', nextSafeAction: 'Set the store\'s settings (POST /v1/stores/:storeId/settings); the store computer picks its setup up on its next pull.' });
        }
        const sections = await deps.buildSections(ctx.tenantId, storeId);
        return { status: 200, body: signStorePack(deps.signer, { tenantId: ctx.tenantId, storeId, issuedAt: deps.now(), sections }) };
      },
    },
    {
      // Set a store's settings — a new version each time (append-only).
      api: 'API-01', method: 'POST', path: '/v1/stores/:storeId/settings',
      permission: 'platform.setup.write', idempotent: true,
      handler: async (ctx) => {
        const storeId = ctx.params['storeId'] ?? '';
        await knownStore(ctx.tenantId, storeId);
        const b = (ctx.body ?? {}) as Record<string, unknown>;
        const ints = ['staleAfterSeconds', 'countApprovalThresholdMinor', 'handoverToleranceMinor', 'cashVarianceToleranceMinor', 'privacySlaDays'] as const;
        const bad = ints.filter((k) => !isNonNegInt(b[k]));
        if (bad.length > 0 || typeof b['tradingDayCutoff'] !== 'string' || !CUTOFF.test(b['tradingDayCutoff'])
          || !(b['warehouseId'] === undefined || b['warehouseId'] === null || typeof b['warehouseId'] === 'string')) {
          throw apiError(400, {
            code: 'not_readable_as_store_settings',
            whatHappened: `Store settings need tradingDayCutoff as "HH:MM" and whole, non-negative ${ints.join(', ')}${bad.length > 0 ? ` (not readable: ${bad.join(', ')})` : ''}.`,
            wasItSaved: 'not_saved', nextSafeAction: 'Send every setting. Nothing was saved.',
          });
        }
        const before = await deps.settings(ctx.tenantId, storeId);
        const s: StoreSettings = {
          storeId, warehouseId: typeof b['warehouseId'] === 'string' && b['warehouseId'] !== '' ? b['warehouseId'] : null,
          tradingDayCutoff: b['tradingDayCutoff'], staleAfterSeconds: b['staleAfterSeconds'] as number,
          countApprovalThresholdMinor: b['countApprovalThresholdMinor'] as number, handoverToleranceMinor: b['handoverToleranceMinor'] as number,
          cashVarianceToleranceMinor: b['cashVarianceToleranceMinor'] as number, privacySlaDays: b['privacySlaDays'] as number,
          version: (before?.version ?? 0) + 1, setBy: ctx.userId, setAt: deps.now(),
        };
        await deps.recordSettings(ctx.tenantId, s);
        return { status: before === undefined ? 201 : 200, body: { settings: s } };
      },
    },
    {
      // DF-3-b-1: set a store's working rules — every value, a new version each time.
      api: 'API-01', method: 'POST', path: '/v1/stores/:storeId/rules',
      permission: 'platform.setup.write', idempotent: true,
      handler: async (ctx) => {
        const storeId = ctx.params['storeId'] ?? '';
        await knownStore(ctx.tenantId, storeId);
        if (deps.rules === undefined || deps.recordRules === undefined) throw notFound('store rules');
        const read = readStoreRules((ctx.body ?? {}) as Record<string, unknown>, deps.roleIds ?? []);
        if ('problems' in read) {
          throw apiError(400, { code: 'not_readable_as_store_rules', whatHappened: `Store rules need every value set: ${read.problems.join('; ')}.`, wasItSaved: 'not_saved', nextSafeAction: 'Send every rule (docs/registers/owner-configuration.md has the documented starting values). Nothing was saved.' });
        }
        const before = await deps.rules(ctx.tenantId, storeId);
        const r: StoreRules = { storeId, ...read.rules, version: (before?.version ?? 0) + 1, setBy: ctx.userId, setAt: deps.now() };
        await deps.recordRules(ctx.tenantId, r);
        return { status: before === undefined ? 201 : 200, body: { rules: r } };
      },
    },
    {
      api: 'API-01', method: 'GET', path: '/v1/stores/:storeId/rules',
      permission: 'org.branch.read',
      handler: async (ctx) => {
        const storeId = ctx.params['storeId'] ?? '';
        await knownStore(ctx.tenantId, storeId);
        const r = deps.rules === undefined ? undefined : await deps.rules(ctx.tenantId, storeId);
        if (r === undefined) throw notFound(`rules for store ${storeId}`);
        return { status: 200, body: { rules: r } };
      },
    },
    {
      api: 'API-01', method: 'GET', path: '/v1/stores/:storeId/settings',
      permission: 'org.branch.read',
      handler: async (ctx) => {
        const storeId = ctx.params['storeId'] ?? '';
        await knownStore(ctx.tenantId, storeId);
        const s = await deps.settings(ctx.tenantId, storeId);
        if (s === undefined) throw notFound(`settings for store ${storeId}`);
        return { status: 200, body: { settings: s } };
      },
    },
  ];
}
