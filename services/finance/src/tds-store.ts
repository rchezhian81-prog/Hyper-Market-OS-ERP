// API-09 Income-tax TDS on supplier payments (R3 · A24 · ss.194C/194I/194J · OB-143 "A": built switched off) — the
// durable register and its routes.
//
//   • GET  /v1/finance/tds                       — the CA's list, the owner's switch and its state IN WORDS (switched off
//                                                  is said, never a silent zero), every deduction open or deposited.
//   • POST /v1/finance/tds/config                — the CA sets the whole list (sections, rates, thresholds, payees). A new
//                                                  version each time; every earlier one stays (hard rule #2). Never the
//                                                  switch: that is the owner's.
//   • POST /v1/finance/tds/switch                — the owner switches TDS on or off, with a reason. On is refused while the
//                                                  list is empty.
//   • POST /v1/finance/tds/challans/:challanId   — the accountant records a challan: the bank's reference and the
//                                                  deductions it covers, to the paisa. A deduction stays a liability until
//                                                  one does.
//   • GET  /v1/finance/tds/26q/:fy/:quarter      — the quarter's 26Q summary.
//
// The deduction itself is made on the supplier payment route (`services/purchase/src/supplier-master.ts`) and carried on
// the payment record. The engine is `packages/withholding`.

import type { Route } from '../../kernel/src/index';
import { apiError } from '../../kernel/src/index';
import {
  validateTdsConfig, payeesWithoutSection, tdsLiabilities, checkChallan, form26qSummary, QUARTERS, ON_CROSSING, EMPTY_TDS_CONFIG,
  type TdsConfig, type TdsSwitch, type TdsChallan, type TdsSection, type TdsPayee, type PaymentWithTds, type Quarter, type OnCrossing,
} from '../../../packages/withholding/src/index';
import type { AuditEntry } from '../../../packages/audit/src/index';

export interface TdsStoreDeps {
  /** The latest version of the CA's list, or undefined when none has been set (the empty list applies). */
  readonly config: (tenantId: string) => Promise<TdsConfig | undefined> | TdsConfig | undefined;
  readonly recordConfig: (tenantId: string, config: TdsConfig) => Promise<void> | void;
  /** The latest switch, or undefined (off). */
  readonly switchState: (tenantId: string) => Promise<TdsSwitch | undefined> | TdsSwitch | undefined;
  readonly recordSwitch: (tenantId: string, s: TdsSwitch) => Promise<void> | void;
  /** Every supplier payment with the TDS it carried. */
  readonly payments: (tenantId: string) => Promise<readonly PaymentWithTds[]> | readonly PaymentWithTds[];
  readonly challans: (tenantId: string) => Promise<readonly TdsChallan[]> | readonly TdsChallan[];
  /** Record a challan once per id; returns the one that stands. */
  readonly recordChallan: (tenantId: string, c: TdsChallan) => Promise<TdsChallan> | TdsChallan;
  readonly recordAudit?: (tenantId: string, entry: AuditEntry) => Promise<unknown> | void;
  readonly now: () => string;
}

const isStr = (v: unknown): v is string => typeof v === 'string' && v.trim() !== '';
const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const isDate = (v: unknown): v is string => typeof v === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(v) && !Number.isNaN(Date.parse(`${v}T00:00:00.000Z`));
const optMinor = (v: unknown): number | null | undefined => (v === null || v === undefined ? null : Number.isSafeInteger(v) && (v as number) >= 0 ? (v as number) : undefined);

function readSections(v: unknown): TdsSection[] | undefined {
  if (!Array.isArray(v)) return undefined;
  const out: TdsSection[] = [];
  for (const raw of v) {
    if (!isObj(raw) || !isStr(raw['section']) || !isStr(raw['label']) || !Number.isSafeInteger(raw['rateBps'])) return undefined;
    const single = optMinor(raw['singleThresholdMinor']);
    const aggregate = optMinor(raw['aggregateThresholdMinor']);
    if (single === undefined || aggregate === undefined || !ON_CROSSING.includes(raw['onCrossing'] as OnCrossing)) return undefined;
    out.push({ section: raw['section'].trim().toUpperCase(), label: raw['label'].trim(), rateBps: raw['rateBps'] as number, singleThresholdMinor: single, aggregateThresholdMinor: aggregate, onCrossing: raw['onCrossing'] as OnCrossing });
  }
  return out;
}

function readPayees(v: unknown): TdsPayee[] | undefined {
  if (!Array.isArray(v)) return undefined;
  const out: TdsPayee[] = [];
  for (const raw of v) {
    if (!isObj(raw) || !isStr(raw['supplierId']) || typeof raw['tdsApplicable'] !== 'boolean') return undefined;
    if (raw['section'] !== undefined && raw['section'] !== null && !isStr(raw['section'])) return undefined;
    if (raw['pan'] !== undefined && raw['pan'] !== null && !isStr(raw['pan'])) return undefined;
    out.push({
      supplierId: raw['supplierId'].trim(), tdsApplicable: raw['tdsApplicable'],
      section: isStr(raw['section']) ? raw['section'].trim().toUpperCase() : null, pan: isStr(raw['pan']) ? raw['pan'].trim().toUpperCase() : null,
    });
  }
  return out;
}

/** The switch's state in words — what the page and the payment reply say. */
export function tdsStateWords(enabled: boolean, config: TdsConfig): string {
  if (!enabled) {
    return config.sections.length === 0
      ? 'TDS is switched off. The CA has not filled the payee, section and rate list yet; once the CA has, the owner switches it on (OB-143).'
      : 'TDS is switched off. The CA\'s list is filled; it takes effect when the owner switches it on (OB-143).';
  }
  return 'TDS is switched on: payments to the payees on the CA\'s list are made net of TDS.';
}

export function tdsStoreRoutes(deps: TdsStoreDeps): readonly Route[] {
  const configOf = async (t: string): Promise<TdsConfig> => (await deps.config(t)) ?? EMPTY_TDS_CONFIG;
  const enabledOf = async (t: string): Promise<boolean> => (await deps.switchState(t))?.enabled === true;
  const audit = async (t: string, e: AuditEntry) => { await deps.recordAudit?.(t, e); };
  return [
    {
      api: 'API-09', method: 'GET', path: '/v1/finance/tds',
      permission: 'finance.tds.read',
      handler: async (ctx) => {
        const [config, sw, payments, challans] = await Promise.all([configOf(ctx.tenantId), deps.switchState(ctx.tenantId), deps.payments(ctx.tenantId), deps.challans(ctx.tenantId)]);
        const enabled = sw?.enabled === true;
        const liabilities = tdsLiabilities(payments, challans);
        return {
          status: 200,
          body: {
            enabled, state: tdsStateWords(enabled, config), switchedBy: sw?.by ?? null, switchedAt: sw?.at ?? null,
            config, payeesWithoutSection: payeesWithoutSection(config),
            liabilities, openLiabilityMinor: liabilities.filter((l) => l.state === 'liability').reduce((s, l) => s + l.tdsMinor, 0),
            challans, asAt: deps.now(),
          },
        };
      },
    },
    {
      api: 'API-09', method: 'POST', path: '/v1/finance/tds/config',
      permission: 'finance.tds.configure', idempotent: true,
      handler: async (ctx) => {
        const b = (ctx.body ?? {}) as Record<string, unknown>;
        if (b['enabled'] !== undefined) {
          throw apiError(400, { code: 'tds_config_cannot_switch', whatHappened: 'The list cannot switch TDS on or off — that is the owner\'s act (OB-143).', wasItSaved: 'not_saved', nextSafeAction: 'Send { sections, payees } only; the owner switches it on. Nothing was saved.' });
        }
        const sections = readSections(b['sections']);
        const payees = readPayees(b['payees']);
        if (sections === undefined || payees === undefined) {
          throw apiError(400, {
            code: 'not_readable_as_a_tds_list',
            whatHappened: `The TDS list is { sections: [ { section, label, rateBps, singleThresholdMinor (or null), aggregateThresholdMinor (or null), onCrossing (${ON_CROSSING.join(' / ')}) } ], payees: [ { supplierId, tdsApplicable, section?, pan? } ] }.`,
            wasItSaved: 'not_saved', nextSafeAction: 'Send the whole list. Nothing was saved.',
          });
        }
        const problems = validateTdsConfig({ sections, payees });
        if (problems.length > 0) {
          throw apiError(422, { code: 'tds_list_not_valid', whatHappened: `The TDS list was not saved: ${problems.join('; ')}.`, wasItSaved: 'not_saved', nextSafeAction: 'Correct the list and send it again. The list in force is unchanged.' });
        }
        const prior = await configOf(ctx.tenantId);
        const config: TdsConfig = { sections, payees, version: prior.version + 1, setBy: ctx.userId, setAt: deps.now() };
        await deps.recordConfig(ctx.tenantId, config);
        await audit(ctx.tenantId, {
          actorId: ctx.userId, action: 'finance.tds.config.set', objectType: 'tds_config', objectId: `v${config.version}`, at: config.setAt,
          origin: { tenantId: ctx.tenantId, branchId: ctx.branchId ?? null }, before: { version: String(prior.version), sections: String(prior.sections.length), payees: String(prior.payees.length) },
          after: { version: String(config.version), sections: sections.map((s) => `${s.section}@${s.rateBps}`).join(','), payees: String(payees.length) }, correlationId: `tds-config-v${config.version}`,
        });
        return { status: 201, body: { config, payeesWithoutSection: payeesWithoutSection(config), enabled: await enabledOf(ctx.tenantId) } };
      },
    },
    {
      api: 'API-09', method: 'POST', path: '/v1/finance/tds/switch',
      permission: 'finance.tds.switch', idempotent: true,
      handler: async (ctx) => {
        const b = (ctx.body ?? {}) as Record<string, unknown>;
        if (typeof b['enabled'] !== 'boolean' || !isStr(b['reason'])) {
          throw apiError(400, { code: 'not_readable_as_a_tds_switch', whatHappened: 'The switch is { enabled: true / false, reason }.', wasItSaved: 'not_saved', nextSafeAction: 'Send it with the reason. Nothing changed.' });
        }
        const config = await configOf(ctx.tenantId);
        if (b['enabled'] && config.sections.length === 0) {
          throw apiError(409, { code: 'tds_list_empty', whatHappened: 'TDS cannot be switched on while the CA\'s payee, section and rate list is empty — every payment would go out gross while the screen said TDS was on.', wasItSaved: 'not_saved', nextSafeAction: 'Ask the CA to fill the list first. TDS stays switched off.' });
        }
        const before = await enabledOf(ctx.tenantId);
        const s: TdsSwitch = { enabled: b['enabled'], by: ctx.userId, at: deps.now(), reason: b['reason'].trim().slice(0, 300) };
        await deps.recordSwitch(ctx.tenantId, s);
        await audit(ctx.tenantId, {
          actorId: ctx.userId, action: 'finance.tds.switch', objectType: 'tds_switch', objectId: 'tds', at: s.at,
          origin: { tenantId: ctx.tenantId, branchId: ctx.branchId ?? null }, before: { enabled: String(before) }, after: { enabled: String(s.enabled), configVersion: String(config.version) },
          reason: s.reason, correlationId: 'tds-switch',
        });
        return { status: 201, body: { enabled: s.enabled, state: tdsStateWords(s.enabled, config), by: s.by, at: s.at } };
      },
    },
    {
      api: 'API-09', method: 'POST', path: '/v1/finance/tds/challans/:challanId',
      permission: 'finance.tds.challan.record', idempotent: true,
      handler: async (ctx) => {
        const challanId = (ctx.params['challanId'] ?? '').trim();
        const b = (ctx.body ?? {}) as Record<string, unknown>;
        if (challanId === '' || !isStr(b['challanRef']) || !isDate(b['depositedOn']) || !Array.isArray(b['paymentIds']) || !b['paymentIds'].every(isStr)
          || !Number.isSafeInteger(b['amountMinor']) || (b['amountMinor'] as number) <= 0) {
          throw apiError(400, { code: 'not_readable_as_a_tds_challan', whatHappened: 'A challan is { challanRef (the bank\'s BSR code, date and serial), depositedOn (YYYY-MM-DD), paymentIds[] (the payments whose TDS it deposits), amountMinor }.', wasItSaved: 'not_saved', nextSafeAction: 'Send the challan as the bank gave it. Nothing was recorded.' });
        }
        const challans = await deps.challans(ctx.tenantId);
        const prior = challans.find((c) => c.challanId === challanId);
        if (prior !== undefined) return { status: 200, body: { challan: prior, alreadyRecorded: true } };
        const liabilities = tdsLiabilities(await deps.payments(ctx.tenantId), challans);
        const paymentIds = (b['paymentIds'] as string[]).map((x) => x.trim());
        const problems = checkChallan({ challan: { paymentIds, amountMinor: b['amountMinor'] as number }, liabilities });
        if (problems.length > 0) {
          throw apiError(422, { code: 'tds_challan_does_not_match', whatHappened: `The challan was not recorded: ${problems.join('; ')}.`, wasItSaved: 'not_saved', nextSafeAction: 'Name exactly the deductions this challan deposited. Nothing was recorded.' });
        }
        const challan: TdsChallan = { challanId, challanRef: b['challanRef'].trim(), depositedOn: b['depositedOn'], paymentIds, amountMinor: b['amountMinor'] as number, by: ctx.userId, at: deps.now() };
        const standing = await deps.recordChallan(ctx.tenantId, challan);
        await audit(ctx.tenantId, {
          actorId: ctx.userId, action: 'finance.tds.challan.record', objectType: 'tds_challan', objectId: challanId, at: challan.at,
          origin: { tenantId: ctx.tenantId, branchId: ctx.branchId ?? null }, before: null,
          after: { challanRef: challan.challanRef, depositedOn: challan.depositedOn, amountMinor: String(challan.amountMinor), paymentIds: paymentIds.join(',') }, correlationId: challanId,
        });
        return { status: 201, body: { challan: standing, alreadyRecorded: standing.at !== challan.at } };
      },
    },
    {
      api: 'API-09', method: 'GET', path: '/v1/finance/tds/26q/:fy/:quarter',
      permission: 'finance.tds.read',
      handler: async (ctx) => {
        const fy = (ctx.params['fy'] ?? '').trim();
        const quarter = (ctx.params['quarter'] ?? '').trim().toUpperCase() as Quarter;
        const ok = /^(\d{4})-(\d{2})$/.exec(fy);
        if (ok === null || (Number(ok[1]) + 1) % 100 !== Number(ok[2]) || !QUARTERS.includes(quarter)) {
          throw apiError(400, { code: 'not_a_26q_quarter', whatHappened: 'The 26Q is by financial year and quarter: /v1/finance/tds/26q/2026-27/Q3.', wasItSaved: 'not_saved', nextSafeAction: 'Send the year as YYYY-YY and the quarter as Q1–Q4. A read never writes.' });
        }
        const [config, payments, challans, enabled] = await Promise.all([configOf(ctx.tenantId), deps.payments(ctx.tenantId), deps.challans(ctx.tenantId), enabledOf(ctx.tenantId)]);
        return { status: 200, body: { ...form26qSummary({ financialYear: fy, quarter, liabilities: tdsLiabilities(payments, challans), config }), enabled, state: tdsStateWords(enabled, config), asAt: deps.now() } };
      },
    },
  ];
}
