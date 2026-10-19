// API-11 Compliance — the EPR registers (R4 · B20 · B21 · B22 · OB-212 · OB-227), on the tested `packages/epr` engine.
// Head-office routes; every register is append-only (hard rules #2, #6). Registers and yearly figures only — nothing is
// filed on the CPCB portal: that is the owner's or the EPR consultant's job (OB-212).
//
// B20 · plastic:
//   • POST /v1/compliance/epr/own-brand/:productId   — mark a product the shop's own brand, with its packaging (category
//     I–IV and plastic per unit in milligrams). A mark with no packaging is allowed and is an exception.
//   • GET  /v1/compliance/epr/own-brand              — the latest declaration per product.
//   • GET  /v1/compliance/epr/plastic/:financialYear — the year's plastic per category, to the gram, from units received
//     and produced; the exceptions; the CSV for the CPCB portal. Read-only.
// B21 · B22 · e-waste and batteries:
//   • POST /v1/compliance/epr/recyclers/:recyclerId  — a recycler and its registration number (none = not registered).
//   • POST /v1/compliance/epr/take-backs/:takeBackId  — a customer brings an item or a used battery back for disposal:
//     recorded as a take-back (never a sale return) in the take-back location; it never enters saleable stock.
//   • POST /v1/compliance/epr/take-back-stock/:handoverId/out — take-back stock leaves ONLY to a registered recycler:
//     to anything else it is refused "not saleable: take-back stock"; to an unregistered recycler "recycler not
//     registered"; more than is held, refused.
//   • POST /v1/compliance/epr/handovers/:handoverId  — the shop's own e-waste (old tills, scales, lights) to a registered
//     recycler, with the weight and any fixed asset it disposes of.
//   • POST /v1/compliance/epr/take-back-stock/counts/:countId — a count of the take-back bin; a difference is an exception.
//   • POST /v1/compliance/epr/assets/:assetId/not-e-waste — a person records, with a reason, that a disposed asset was
//     not electrical or electronic, so it needs no handover.
//   • GET  /v1/compliance/epr/take-back              — stock on hand (taken back less handed over), the records and the
//     exceptions. Read-only.
// Settings: GET/POST /v1/compliance/epr/settings[/:key] — the registration number, any exemption, and whether the shop is
// an e-waste or battery brand owner: each "not confirmed" until it names who confirmed it.
//
// Reads `epr.register.read`; records `epr.register.record`; settings `epr.settings.configure`.

import type { Route, RequestContext } from '../../kernel/src/index';
import { apiError } from '../../kernel/src/index';
import type { AuditEntry } from '../../../packages/audit/src/audit-trail';
import {
  plasticReturn, packagingLineIsValid, eprSettingStatuses, financialYearBounds, EPR_SETTING_KEYS, EPR_SETTINGS, PLASTIC_CATEGORIES, PLASTIC_CATEGORY_WORDS,
  recyclersById, registeredRecycler, assertTakeBackLeavesOnlyToARecycler, takeBackStock, assertWithinTakeBackStock,
  takeBackStockExceptions, disposedAssetExceptions, EprRefusal, InvalidEprInput, TAKE_BACK_KINDS, TAKE_BACK_LOCATION,
  type OwnBrandDeclaration, type UnitsMovement, type EprSettingChange, type EprSettingKey, type Recycler, type TakeBack,
  type Handover, type HandoverLine, type TakeBackCount, type AssetNotEWaste, type DisposedAsset, type TakeBackKind, type PackagingLine,
} from '../../../packages/epr/src/index';

export interface EprDeps {
  readonly now: () => string;
  /** Today's store-local date (YYYY-MM-DD). */
  readonly today: (tenantId: string) => Promise<string>;
  readonly settingChanges: (tenantId: string) => Promise<readonly EprSettingChange[]>;
  readonly recordSetting: (tenantId: string, c: EprSettingChange, key: string) => Promise<void>;
  readonly declarations: (tenantId: string) => Promise<readonly OwnBrandDeclaration[]>;
  readonly recordDeclaration: (tenantId: string, d: OwnBrandDeclaration, key: string) => Promise<void>;
  /** Receipts and production outputs from the stock ledger, with their store-local date. */
  readonly unitsMovements: (tenantId: string) => Promise<readonly UnitsMovement[]>;
  readonly recyclers: (tenantId: string) => Promise<readonly Recycler[]>;
  readonly recordRecycler: (tenantId: string, r: Recycler, key: string) => Promise<void>;
  readonly takeBacks: (tenantId: string) => Promise<readonly TakeBack[]>;
  /** Answers the record as stored: the first under its id stands. */
  readonly recordTakeBack: (tenantId: string, t: TakeBack) => Promise<TakeBack>;
  readonly handovers: (tenantId: string) => Promise<readonly Handover[]>;
  readonly recordHandover: (tenantId: string, h: Handover) => Promise<Handover>;
  readonly counts: (tenantId: string) => Promise<readonly TakeBackCount[]>;
  readonly recordCount: (tenantId: string, c: TakeBackCount) => Promise<TakeBackCount>;
  readonly disposedAssets: (tenantId: string) => Promise<readonly DisposedAsset[]>;
  readonly notEWaste: (tenantId: string) => Promise<readonly AssetNotEWaste[]>;
  readonly recordNotEWaste: (tenantId: string, n: AssetNotEWaste) => Promise<AssetNotEWaste>;
  readonly recordAudit: (tenantId: string, entry: AuditEntry) => Promise<unknown> | void;
}

const isStr = (v: unknown): v is string => typeof v === 'string' && v.trim() !== '';
const isDate = (v: unknown): v is string => typeof v === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(v) && !Number.isNaN(Date.parse(v));
const isGrams = (v: unknown): v is number => Number.isInteger(v) && (v as number) > 0 && (v as number) <= 100_000_000;
const optText = (v: unknown): string | null => (isStr(v) ? v.trim() : null);
const bad = (code: string, whatHappened: string, nextSafeAction: string) => apiError(400, { code, whatHappened, wasItSaved: 'not_saved', nextSafeAction });
const SETTING_PATH: Readonly<Record<string, EprSettingKey>> = { 'plastic-registration': 'plasticRegistration', 'plastic-exemption': 'plasticExemption', 'e-waste-brand-owner': 'eWasteBrandOwner', 'battery-brand-owner': 'batteryBrandOwner' };

const audit = (ctx: RequestContext, deps: EprDeps, action: string, objectId: string, after: Record<string, string>): Promise<unknown> | void =>
  deps.recordAudit(ctx.tenantId, {
    actorId: ctx.userId, action, objectType: 'epr_register', objectId, at: deps.now(),
    origin: { tenantId: ctx.tenantId, branchId: null }, before: null, after, correlationId: ctx.traceId,
  });

function refusal(err: unknown): never {
  if (err instanceof EprRefusal) {
    const next = err.code === 'recycler_not_registered'
      ? 'Record the recycler\'s registration number first (POST /v1/compliance/epr/recyclers/:id), or hand over to a registered recycler. Nothing left the register.'
      : err.code === 'not_saleable_take_back_stock'
        ? 'Take-back stock goes only to a registered recycler. Nothing left the register.'
        : 'Hand over what the register holds — count the bin if it differs. Nothing left the register.';
    throw apiError(422, { code: err.code, whatHappened: err.message, wasItSaved: 'not_saved', nextSafeAction: next });
  }
  if (err instanceof InvalidEprInput) throw bad('epr_input_invalid', err.message, 'Correct it and send again. Nothing was saved.');
  throw err;
}

/** Read handover lines from a body; each needs a description and a weight in whole grams. */
function readLines(raw: unknown, kind: TakeBackKind): HandoverLine[] {
  if (!Array.isArray(raw) || raw.length === 0) throw bad('handover_needs_lines', 'A handover needs lines: [{ description, weightGrams, assetId?, batteryType? }] — at least one.', 'Send what is handed over and its weight. Nothing was saved.');
  return raw.map((l) => {
    const o = (l ?? {}) as Record<string, unknown>;
    if (!isStr(o['description']) || !isGrams(o['weightGrams']) || (kind === 'battery' && !isStr(o['batteryType']))) {
      throw bad('handover_line_unreadable', `Each line needs a description and weightGrams (a whole number of grams above 0)${kind === 'battery' ? ', and the batteryType' : ''}.`, 'Correct the line. Nothing was saved.');
    }
    return {
      description: (o['description'] as string).trim(), weightGrams: o['weightGrams'] as number,
      ...(isStr(o['assetId']) ? { assetId: (o['assetId'] as string).trim() } : {}),
      ...(isStr(o['batteryType']) ? { batteryType: (o['batteryType'] as string).trim().toLowerCase() } : {}),
    };
  });
}

const sameRecord = (a: object, b: object, ignore: readonly string[]): boolean => {
  const strip = (o: object) => JSON.stringify(Object.fromEntries(Object.entries(o).filter(([k]) => !ignore.includes(k)).sort(([x], [y]) => x.localeCompare(y))));
  return strip(a) === strip(b);
};

async function takeBackView(deps: EprDeps, tenantId: string) {
  const [takeBacks, handovers, counts, assets, notEWaste, settings, recyclers] = await Promise.all([
    deps.takeBacks(tenantId), deps.handovers(tenantId), deps.counts(tenantId), deps.disposedAssets(tenantId), deps.notEWaste(tenantId), deps.settingChanges(tenantId), deps.recyclers(tenantId),
  ]);
  const stock = takeBackStock(takeBacks, handovers);
  const stockExceptions = takeBackStockExceptions(stock, counts);
  const assetExceptions = disposedAssetExceptions(assets, handovers, notEWaste);
  return {
    location: TAKE_BACK_LOCATION, saleable: false,
    words: 'Take-back stock is never saleable. It leaves only on a handover to a recycler with a recorded registration number.',
    stock, takeBacks, handovers, counts, notEWaste,
    recyclers: [...recyclersById(recyclers).values()].map((r) => ({ ...r, registered: r.registrationNumber !== null && r.registrationNumber.trim() !== '' })),
    exceptions: { stock: stockExceptions, assets: assetExceptions, count: stockExceptions.length + assetExceptions.length },
    brandOwner: eprSettingStatuses(settings).filter((s) => s.key === 'eWasteBrandOwner' || s.key === 'batteryBrandOwner'),
  };
}

export function eprRoutes(deps: EprDeps): readonly Route[] {
  /** Record handover lines out of take-back stock or from the shop, after the recycler and stock checks. */
  const handOver = async (ctx: RequestContext, handoverId: string, source: 'take_back' | 'shop', b: Record<string, unknown>) => {
    const kind = b['kind'];
    if (!(TAKE_BACK_KINDS as readonly unknown[]).includes(kind) || !isStr(b['recyclerId']) || !isStr(b['note']) || (b['on'] !== undefined && !isDate(b['on']))) {
      throw bad('not_readable_as_a_handover', 'A handover needs kind (e_waste or battery), recyclerId, lines and a handover note (its reference); on (YYYY-MM-DD) is optional.', 'Send the handover. Nothing was saved.');
    }
    const lines = readLines(b['lines'], kind as TakeBackKind);
    try {
      const recycler = registeredRecycler(recyclersById(await deps.recyclers(ctx.tenantId)), (b['recyclerId'] as string).trim());
      if (source === 'take_back') assertWithinTakeBackStock(takeBackStock(await deps.takeBacks(ctx.tenantId), await deps.handovers(ctx.tenantId)), kind as TakeBackKind, lines);
      const h: Handover = {
        handoverId, kind: kind as TakeBackKind, source, recyclerId: recycler.recyclerId, registrationNumber: recycler.registrationNumber,
        lines, note: (b['note'] as string).trim(), on: isDate(b['on']) ? b['on'] : await deps.today(ctx.tenantId), by: ctx.userId, at: deps.now(),
      };
      const stored = await deps.recordHandover(ctx.tenantId, h);
      if (!sameRecord(stored, h, ['at', 'on', 'by'])) {
        throw apiError(409, { code: 'handover_exists', whatHappened: `Handover ${handoverId} is already recorded with other lines.`, wasItSaved: 'not_saved', nextSafeAction: 'Use a new handover id. A record is never edited.' });
      }
      await audit(ctx, deps, 'epr.handover.record', handoverId, { kind: h.kind, source, recyclerId: h.recyclerId, registrationNumber: h.registrationNumber, grams: String(lines.reduce((s, l) => s + l.weightGrams, 0)) });
      return { status: 201, body: { handover: stored } };
    } catch (err) { return refusal(err); }
  };

  return [
    {
      api: 'API-11', method: 'GET', path: '/v1/compliance/epr/settings',
      permission: 'epr.register.read',
      handler: async (ctx) => ({ status: 200, body: { settings: eprSettingStatuses(await deps.settingChanges(ctx.tenantId)), filing: 'The system files nothing on the CPCB portal; the CA or EPR consultant does.' } }),
    },
    {
      // Body: { value, confirmation? } — the answer (a registration number, an exemption and its basis, "yes"/"no" for
      // brand owner) and who confirmed it with their reference. Not confirmed until both are present.
      api: 'API-11', method: 'POST', path: '/v1/compliance/epr/settings/:key',
      permission: 'epr.settings.configure', idempotent: true,
      handler: async (ctx) => {
        const key = SETTING_PATH[ctx.params['key'] ?? ''];
        if (key === undefined) throw apiError(404, { code: 'no_such_epr_setting', whatHappened: `"${ctx.params['key']}" is not an EPR setting.`, wasItSaved: 'not_saved', nextSafeAction: `Use one of: ${Object.keys(SETTING_PATH).join(', ')}.` });
        const b = (ctx.body ?? {}) as Record<string, unknown>;
        if (!isStr(b['value'])) throw bad('epr_setting_needs_a_value', `${EPR_SETTINGS[key].label} needs a value.`, 'Send { value, confirmation } — confirmation names the CA or EPR consultant and their reference. Nothing was changed.');
        const c: EprSettingChange = { key, setting: { value: (b['value'] as string).trim(), confirmation: optText(b['confirmation']) }, by: ctx.userId, at: deps.now() };
        await deps.recordSetting(ctx.tenantId, c, ctx.idempotencyKey ?? `${key}-${c.at}`);
        await audit(ctx, deps, 'epr.setting.change', key, { key, value: c.setting.value ?? '', confirmation: c.setting.confirmation ?? '' });
        return { status: 200, body: { changed: key, settings: eprSettingStatuses(await deps.settingChanges(ctx.tenantId)) } };
      },
    },
    {
      // Body: { ownBrand: boolean, packaging?: [{ category: I|II|III|IV, weightPerUnitMg, description? }] }.
      api: 'API-11', method: 'POST', path: '/v1/compliance/epr/own-brand/:productId',
      permission: 'epr.register.record', idempotent: true,
      handler: async (ctx) => {
        const productId = (ctx.params['productId'] ?? '').trim();
        const b = (ctx.body ?? {}) as Record<string, unknown>;
        const packaging = b['packaging'] ?? [];
        if (productId === '' || typeof b['ownBrand'] !== 'boolean' || !Array.isArray(packaging) || !packaging.every(packagingLineIsValid)) {
          throw bad('not_readable_as_an_own_brand_declaration', `An own-brand declaration is { ownBrand: true|false, packaging: [{ category (${PLASTIC_CATEGORIES.join(', ')}), weightPerUnitMg (whole milligrams of plastic in one unit, above 0), description? }] }.`, 'Send the declaration. A mark with no packaging is recorded and listed as "packaging declaration missing". Nothing was saved.');
        }
        const d: OwnBrandDeclaration = {
          productId, ownBrand: b['ownBrand'],
          packaging: (packaging as PackagingLine[]).map((l) => ({ category: l.category, weightPerUnitMg: l.weightPerUnitMg, ...(isStr(l.description) ? { description: l.description.trim() } : {}) })),
          by: ctx.userId, at: deps.now(),
        };
        await deps.recordDeclaration(ctx.tenantId, d, ctx.idempotencyKey ?? `own-brand-${productId}-${d.at}`);
        await audit(ctx, deps, 'epr.own_brand.declare', productId, { ownBrand: String(d.ownBrand), packaging: JSON.stringify(d.packaging) });
        return { status: 200, body: { declaration: d, packagingDeclared: d.packaging.length > 0 } };
      },
    },
    {
      api: 'API-11', method: 'GET', path: '/v1/compliance/epr/own-brand',
      permission: 'epr.register.read',
      handler: async (ctx) => {
        const latest = new Map<string, OwnBrandDeclaration>();
        for (const d of await deps.declarations(ctx.tenantId)) latest.set(d.productId, d);
        const declarations = [...latest.values()].sort((a, b) => a.productId.localeCompare(b.productId));
        return { status: 200, body: { declarations, categories: PLASTIC_CATEGORIES.map((c) => ({ category: c, label: PLASTIC_CATEGORY_WORDS[c] })) } };
      },
    },
    {
      api: 'API-11', method: 'GET', path: '/v1/compliance/epr/plastic/:financialYear',
      permission: 'epr.register.read',
      handler: async (ctx) => {
        const fy = (ctx.params['financialYear'] ?? '').trim();
        try { financialYearBounds(fy); } catch (err) { return refusal(err); }
        const [declarations, movements, settings] = await Promise.all([deps.declarations(ctx.tenantId), deps.unitsMovements(ctx.tenantId), deps.settingChanges(ctx.tenantId)]);
        const r = plasticReturn({ financialYear: fy, declarations, movements });
        return {
          status: 200,
          body: {
            ...r,
            settings: eprSettingStatuses(settings).filter((s) => s.item === 'B20'),
            words: 'Nothing is filed automatically. The CA or EPR consultant uploads this file on the CPCB portal if the shop must file.',
          },
        };
      },
    },
    {
      // Body: { name, registrationNumber? }. Without a registration number the recycler is on the list but nothing may be
      // handed to it ("recycler not registered").
      api: 'API-11', method: 'POST', path: '/v1/compliance/epr/recyclers/:recyclerId',
      permission: 'epr.register.record', idempotent: true,
      handler: async (ctx) => {
        const recyclerId = (ctx.params['recyclerId'] ?? '').trim();
        const b = (ctx.body ?? {}) as Record<string, unknown>;
        if (recyclerId === '' || !isStr(b['name']) || (b['registrationNumber'] !== undefined && b['registrationNumber'] !== null && typeof b['registrationNumber'] !== 'string')) {
          throw bad('not_readable_as_a_recycler', 'A recycler is { name, registrationNumber? } — the number it is registered under with the pollution control board.', 'Send the recycler. Nothing was saved.');
        }
        const r: Recycler = { recyclerId, name: (b['name'] as string).trim(), registrationNumber: optText(b['registrationNumber']), by: ctx.userId, at: deps.now() };
        await deps.recordRecycler(ctx.tenantId, r, ctx.idempotencyKey ?? `recycler-${recyclerId}-${r.at}`);
        await audit(ctx, deps, 'epr.recycler.record', recyclerId, { name: r.name, registrationNumber: r.registrationNumber ?? '' });
        return { status: 200, body: { recycler: r, registered: r.registrationNumber !== null } };
      },
    },
    {
      api: 'API-11', method: 'GET', path: '/v1/compliance/epr/recyclers',
      permission: 'epr.register.read',
      handler: async (ctx) => ({ status: 200, body: { recyclers: [...recyclersById(await deps.recyclers(ctx.tenantId)).values()].map((r) => ({ ...r, registered: r.registrationNumber !== null })) } }),
    },
    {
      // A customer brings an item (e-waste) or a used battery back for disposal. Body: { kind, description, weightGrams,
      // batteryType? (a battery), customerRef?, on? }. A take-back — never a sale return; never saleable stock.
      api: 'API-11', method: 'POST', path: '/v1/compliance/epr/take-backs/:takeBackId',
      permission: 'epr.register.record', idempotent: true,
      handler: async (ctx) => {
        const takeBackId = (ctx.params['takeBackId'] ?? '').trim();
        const b = (ctx.body ?? {}) as Record<string, unknown>;
        const kind = b['kind'];
        if (takeBackId === '' || !(TAKE_BACK_KINDS as readonly unknown[]).includes(kind) || !isStr(b['description']) || !isGrams(b['weightGrams'])
          || (kind === 'battery' && !isStr(b['batteryType'])) || (b['on'] !== undefined && !isDate(b['on']))) {
          throw bad('not_readable_as_a_take_back', 'A take-back is { kind (e_waste or battery), description, weightGrams (whole grams above 0), batteryType (for a battery: lead-acid, lithium-ion, …), customerRef?, on? }.', 'Send what was brought back, its weight and — for a battery — its type. Nothing was saved.');
        }
        if (b['saleId'] !== undefined || b['refundMinor'] !== undefined) {
          throw bad('a_take_back_is_not_a_sale_return', 'A take-back for disposal is not a sale return: it carries no bill and no refund.', 'Record a return on the returns desk if the customer is returning a purchase. Nothing was saved.');
        }
        const t: TakeBack = {
          takeBackId, kind: kind as TakeBackKind, description: (b['description'] as string).trim(), weightGrams: b['weightGrams'] as number,
          ...(kind === 'battery' ? { batteryType: (b['batteryType'] as string).trim().toLowerCase() } : {}),
          ...(isStr(b['customerRef']) ? { customerRef: (b['customerRef'] as string).trim() } : {}),
          on: isDate(b['on']) ? b['on'] : await deps.today(ctx.tenantId), location: TAKE_BACK_LOCATION, by: ctx.userId, at: deps.now(),
        };
        const stored = await deps.recordTakeBack(ctx.tenantId, t);
        if (!sameRecord(stored, t, ['at', 'on', 'by'])) {
          throw apiError(409, { code: 'take_back_exists', whatHappened: `Take-back ${takeBackId} is already recorded with other details.`, wasItSaved: 'not_saved', nextSafeAction: 'Use a new id. A record is never edited.' });
        }
        await audit(ctx, deps, 'epr.take_back.record', takeBackId, { kind: t.kind, grams: String(t.weightGrams), batteryType: t.batteryType ?? '' });
        return { status: 201, body: { takeBack: stored, location: TAKE_BACK_LOCATION, saleable: false } };
      },
    },
    {
      // Take-back stock out. Body: { to: { kind: 'recycler', recyclerId } , kind, lines, note, on? }. To anything but a
      // registered recycler it is refused — "not saleable: take-back stock" / "recycler not registered".
      api: 'API-11', method: 'POST', path: '/v1/compliance/epr/take-back-stock/:handoverId/out',
      permission: 'epr.register.record', idempotent: true,
      handler: async (ctx) => {
        const b = (ctx.body ?? {}) as Record<string, unknown>;
        const to = b['to'];
        if (typeof to !== 'object' || to === null || !isStr((to as Record<string, unknown>)['kind'])) {
          throw bad('take_back_out_needs_a_destination', 'Take-back stock out needs to: { kind: "recycler", recyclerId }.', 'Send where it goes. Nothing left the register.');
        }
        try { assertTakeBackLeavesOnlyToARecycler(to as { kind: string }); } catch (err) { return refusal(err); }
        return handOver(ctx, (ctx.params['handoverId'] ?? '').trim(), 'take_back', { ...b, recyclerId: (to as Record<string, unknown>)['recyclerId'] });
      },
    },
    {
      // The shop's own e-waste to a registered recycler. Body: { kind, recyclerId, lines: [{ description, weightGrams,
      // assetId?, batteryType? }], note, on? }.
      api: 'API-11', method: 'POST', path: '/v1/compliance/epr/handovers/:handoverId',
      permission: 'epr.register.record', idempotent: true,
      handler: async (ctx) => handOver(ctx, (ctx.params['handoverId'] ?? '').trim(), 'shop', (ctx.body ?? {}) as Record<string, unknown>),
    },
    {
      // A count of the take-back bin. Body: { kind, batteryType? (a battery), countedGrams, on? }.
      api: 'API-11', method: 'POST', path: '/v1/compliance/epr/take-back-stock/counts/:countId',
      permission: 'epr.register.record', idempotent: true,
      handler: async (ctx) => {
        const countId = (ctx.params['countId'] ?? '').trim();
        const b = (ctx.body ?? {}) as Record<string, unknown>;
        const kind = b['kind'];
        if (countId === '' || !(TAKE_BACK_KINDS as readonly unknown[]).includes(kind) || !(Number.isInteger(b['countedGrams']) && (b['countedGrams'] as number) >= 0) || (kind === 'battery' && !isStr(b['batteryType']))) {
          throw bad('not_readable_as_a_take_back_count', 'A take-back count is { kind, batteryType (for batteries), countedGrams (whole grams, 0 or more), on? }.', 'Send the count. Nothing was saved.');
        }
        const c: TakeBackCount = {
          countId, kind: kind as TakeBackKind, ...(kind === 'battery' ? { batteryType: (b['batteryType'] as string).trim().toLowerCase() } : {}),
          countedGrams: b['countedGrams'] as number, on: isDate(b['on']) ? b['on'] : await deps.today(ctx.tenantId), by: ctx.userId, at: deps.now(),
        };
        const stored = await deps.recordCount(ctx.tenantId, c);
        return { status: 201, body: { count: stored, exceptions: (await takeBackView(deps, ctx.tenantId)).exceptions } };
      },
    },
    {
      api: 'API-11', method: 'POST', path: '/v1/compliance/epr/assets/:assetId/not-e-waste',
      permission: 'epr.register.record', idempotent: true,
      handler: async (ctx) => {
        const assetId = (ctx.params['assetId'] ?? '').trim();
        const b = (ctx.body ?? {}) as Record<string, unknown>;
        if (assetId === '' || !isStr(b['reason'])) throw bad('not_e_waste_needs_a_reason', 'Saying a disposed asset was not electrical or electronic needs a reason.', 'Send { reason }. Nothing was saved.');
        if (!(await deps.disposedAssets(ctx.tenantId)).some((a) => a.assetId === assetId)) {
          throw apiError(404, { code: 'no_such_disposed_asset', whatHappened: `${assetId} is not a disposed fixed asset.`, wasItSaved: 'not_saved', nextSafeAction: 'Only a disposed fixed asset needs this. Nothing was saved.' });
        }
        const stored = await deps.recordNotEWaste(ctx.tenantId, { assetId, reason: (b['reason'] as string).trim(), by: ctx.userId, at: deps.now() });
        await audit(ctx, deps, 'epr.asset.not_e_waste', assetId, { reason: stored.reason });
        return { status: 201, body: { notEWaste: stored } };
      },
    },
    {
      api: 'API-11', method: 'GET', path: '/v1/compliance/epr/take-back',
      permission: 'epr.register.read',
      handler: async (ctx) => ({ status: 200, body: await takeBackView(deps, ctx.tenantId) }),
    },
  ];
}
