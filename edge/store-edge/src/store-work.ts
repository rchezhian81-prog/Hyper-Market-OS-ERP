// What the store's screens and handhelds work from with the line down — OB-288 lane 2 · P2 (§31 · P-01 · P-08).
//
// The box holds head office's last word on the store's production board and recipes, its food-safety checks and its
// transfers (`work-feeds-file.ts`), and the work its own screens have handed it since (the device-events queue). This file
// turns those into what each screen is told — always with HOW OLD head office's word is, and never inventing what the box
// was not told (an absent feed is `null`, said by the screen as "not known", never an empty list that reads as "nothing to
// do"). It also renders a COUNTER LABEL on the box (M11-FR-03 "labelling/packing works at the counter offline"):
//   • the batch and the use-by are the RUN's — head office's run on the board, or a run captured on this box, its use-by
//     worked out from the recipe's shelf life exactly as head office's engine works it out (made at + shelf life);
//   • the product name and the price are the CATALOGUE's, from the signed pack the till trades on — never typed at the
//     counter; a weighed item's price is its price per kilo × the weight, and its barcode carries the weight by the
//     shop's own embedded-barcode rule, so the till scans what the label says;
//   • the label must be lawful for the DEPARTMENT (Legal Metrology net quantity and packer, the allergen declaration, the
//     weight) — the same `buildPackLabel` head office runs — and the department must be one the shop operates.
// Pure: no clock (the moment is passed in), no I/O.

import type { ScreenInput } from './screen-data';
import type { HeldWorkFeed } from './work-feeds-file';
import { packTimeZone } from './shop-zone';
import type { FeedRecipe, FeedRun } from '../../sync-agent/src/store-work-feeds';
import { workFeedAgeMinutes } from '../../sync-agent/src/store-work-feeds';
import { buildPackLabel, renderLabel, IncompleteLabelError, LabelTooSmallError, readLabelTemplate, labelPrintFacts, type PackLabel, type LabelTemplate } from '../../../packages/production/src/packing';
import { requireDepartment, DepartmentNotOperatedError, UnknownDepartmentError } from '../../../packages/production/src/departments';
import { buildScaleBarcode, ScaleLabelError } from '../../../packages/production/src/scale-label';
import { normaliseUom } from '../../../packages/contracts/src/quantity';

/** A production run this box's screen captured (from the device-events queue) — known here before head office has it. */
export interface BoxCapturedRun {
  readonly runId: string;
  readonly recipeId: string;
  readonly outputBatchId: string;
  readonly actualOutputMinor: number;
  readonly producedBy: string;
  readonly at: string;
}

const isObj = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === 'object' && !Array.isArray(v);
const asOf = (held: HeldWorkFeed, now: string): { readonly asAt: string; readonly receivedAt: string; readonly ageMinutes: number } =>
  ({ asAt: held.feed.asAt, receivedAt: held.receivedAt, ageMinutes: workFeedAgeMinutes(held.feed.asAt, now) });

/** The use-by of a run made at `at` from a recipe with this shelf life — head office's own rule (`produceBatch`). */
export const useByOf = (at: string, shelfLifeHours: number): string => new Date(Date.parse(at) + shelfLifeHours * 3_600_000).toISOString();

// ── what each screen is told ─────────────────────────────────────────────────────────────────────────────────────────

/** The production screen's board, recipes and departments as head office last said — or null when the box was never told. */
export function productionWork(input: ScreenInput): Record<string, unknown> {
  const held = input.workFeeds?.production;
  const captured = input.boxCapturedRuns ?? [];
  if (held === undefined) return { board: null, capturedHere: captured };
  const b = held.feed.body;
  return { board: { ...asOf(held, input.now), runs: b['runs'], recipes: b['recipes'], enabledDepartments: b['enabledDepartments'] }, capturedHere: captured };
}

/** The food-safety checks in force for this store and the slots head office last knew — or null. */
export function foodSafetyWork(input: ScreenInput): Record<string, unknown> {
  const held = input.workFeeds?.['food-safety'];
  if (held === undefined) return { foodSafety: null };
  const b = held.feed.body;
  return { foodSafety: { ...asOf(held, input.now), checks: b['checks'], slots: b['slots'], receiving: b['receiving'] } };
}

/** OB-333: a quality-hold release this box's facilities screen took (the device-events queue) — known here first. */
export interface BoxQualityRelease {
  readonly batchId: string; readonly releasedBy: string; readonly at: string;
  /** The device queue's state — pending (waiting to send), posted, or refused by head office (then the batch stays held). */
  readonly state?: string;
  readonly reason?: string | null;
}

/**
 * M10-FR-02 offline (with OB-513): a quality sample this box's facilities screen recorded on a held batch (the device-events
 * queue) — known here before head office has it, with where it has got to (pending, posted, or refused by head office).
 */
export interface BoxQualitySample {
  readonly batchId: string; readonly sampleId: string; readonly holdHeldAt: string; readonly test: string;
  readonly result: string; readonly takenAt: string; readonly recordedBy: string; readonly at: string;
  /** The device item's key, so a screen can tell its own sample from one another screen recorded. */
  readonly key?: string;
  readonly state?: string;
  readonly reason?: string | null;
}

/**
 * OB-333: the batches head office holds on quality hold, as it last said (with how old), each marked when a person
 * released it on this box since (`releasedOnThisBox` — those releases are also listed apart, with where they have got
 * to) — or null when the box was never told. A release head office refused leaves its batch held, unmarked.
 * M10-FR-02 offline: each hold also carries the samples recorded on it on THIS box (`samplesOnThisBox`) — only those taken
 * on the same hold head office last said (its `heldAt`), each with its state, a refusal said with its reason.
 */
export function qualityHoldWork(input: ScreenInput): Record<string, unknown> {
  const held = input.workFeeds?.['quality-holds'];
  const releasedHere = input.boxQualityReleases ?? [];
  const sampledHere = input.boxQualitySamples ?? [];
  if (held === undefined) return { qualityHolds: null, qualityReleasesHere: releasedHere };
  // A release refused by head office leaves its batch HELD (it is listed apart, with the refusal); any other is done here.
  const done = new Set(releasedHere.filter((r) => r.state === undefined || !/refused|dead/.test(r.state)).map((r) => r.batchId));
  const holds = (held.feed.body['holds'] as readonly Record<string, unknown>[]).filter(isObj)
    .map((h) => {
      const mine = sampledHere.filter((s) => s.batchId === String(h['batchId']) && s.holdHeldAt === String(h['heldAt']));
      return { ...h, ...(done.has(String(h['batchId'])) ? { releasedOnThisBox: true } : {}), ...(mine.length === 0 ? {} : { samplesOnThisBox: mine }) };
    });
  return { qualityHolds: { ...asOf(held, input.now), holds }, qualityReleasesHere: releasedHere };
}

/** M26-FR-02: the store's monitored rooms and cabinets and their ranges as head office last said — or null. */
export function equipmentWork(input: ScreenInput): Record<string, unknown> {
  const held = input.workFeeds?.equipment;
  if (held === undefined) return { equipment: null };
  return { equipment: { ...asOf(held, input.now), items: held.feed.body['equipment'] } };
}

/** M25-FR-04: the help library as head office last said — every SOP with its words, the store's people and their acks — or null. */
export function helpWork(input: ScreenInput): Record<string, unknown> {
  const held = input.workFeeds?.help;
  if (held === undefined) return { library: null };
  const b = held.feed.body;
  return { library: { ...asOf(held, input.now), sops: b['sops'], people: b['people'], acknowledgements: b['acknowledgements'], emergencyContacts: b['emergencyContacts'], contactsSet: b['contactsSet'] } };
}

/**
 * The transfers the warehouse handheld may work: waiting to be SENT from this store, and on the road to be COUNTED IN at
 * this store — only this store's own end (head office names the store at each end). Null when the box was never told.
 */
export function transferWork(input: ScreenInput): Record<string, unknown> {
  const held = input.workFeeds?.transfers;
  if (held === undefined) return { transfers: null };
  const store = input.pack.policies.known ? (input.pack.policies.value.storeId ?? input.pack.policies.value.branchId) : undefined;
  const rows = (held.feed.body['transfers'] as readonly Record<string, unknown>[]).filter(isObj);
  const lineOf = (l: Record<string, unknown>): Record<string, unknown> => ({ productId: l['productId'], batchId: l['batchId'] ?? null, quantityMinor: l['quantityMinor'], uom: l['uom'] ?? 'EA' });
  const brief = (row: Record<string, unknown>): Record<string, unknown> => {
    const t = row['transfer'] as Record<string, unknown>;
    return {
      transferId: t['transferId'], state: t['state'], fromLocationId: t['fromLocationId'], toLocationId: t['toLocationId'],
      requestedBy: t['requestedBy'] ?? null, approvedBy: t['approvedBy'] ?? null,
      lines: (Array.isArray(t['lines']) ? t['lines'] as unknown[] : []).filter(isObj).map(lineOf),
    };
  };
  const at = (row: Record<string, unknown>, end: 'fromStoreId' | 'toStoreId'): boolean => store !== undefined && row[end] === store;
  const toSend = rows.filter((r) => ['proposed', 'approved'].includes(String((r['transfer'] as Record<string, unknown>)['state'])) && at(r, 'fromStoreId')).map(brief);
  const toCountIn = rows.filter((r) => (r['transfer'] as Record<string, unknown>)['state'] === 'in_transit' && at(r, 'toStoreId')).map(brief);
  return { transfers: { ...asOf(held, input.now), storeId: store ?? null, toSend, toCountIn } };
}

// ── the counter label ────────────────────────────────────────────────────────────────────────────────────────────────

export interface CounterLabelRequest {
  readonly runId: string;
  /** For a weighed department: the weight on the scale, in whole grams. */
  readonly weightGrams?: number;
  readonly netQuantity?: string;
  readonly packerDetails?: string;
  /** The allergen declaration: the groups present (the eight FSSAI groups, B9), or [] for "none" (silence is not a declaration). */
  readonly allergens?: readonly string[];
  /** B9: the veg / non-veg mark. */
  readonly vegClass?: 'veg' | 'non_veg';
  /** B24: the counter printer's own label stock, when it is not the standard counter label. */
  readonly template?: LabelTemplate;
}

export type CounterLabel =
  | ({ readonly ok: true; readonly runId: string; readonly batchId: string; readonly useBy: string; readonly productName: string; readonly priceMinor: number; readonly barcode?: string; readonly lines: readonly string[]; readonly from: 'head_office_board' | 'captured_here'; readonly asAt: string | null } & ReturnType<typeof labelPrintFacts>)
  | { readonly ok: false; readonly refusedBecause: string; readonly detail: string };

/** Read the counter's request strictly; anything else is not a label request. */
export function readCounterLabelRequest(v: unknown): CounterLabelRequest | undefined {
  if (!isObj(v) || typeof v['runId'] !== 'string' || v['runId'].trim() === '') return undefined;
  if (v['weightGrams'] !== undefined && (!Number.isSafeInteger(v['weightGrams']) || (v['weightGrams'] as number) <= 0)) return undefined;
  for (const k of ['netQuantity', 'packerDetails'] as const) if (v[k] !== undefined && typeof v[k] !== 'string') return undefined;
  if (v['allergens'] !== undefined && !(Array.isArray(v['allergens']) && (v['allergens'] as unknown[]).every((a) => typeof a === 'string'))) return undefined;
  if (v['vegClass'] !== undefined && v['vegClass'] !== 'veg' && v['vegClass'] !== 'non_veg') return undefined;
  const template = v['template'] === undefined ? undefined : readLabelTemplate(v['template']);
  if (v['template'] !== undefined && template === undefined) return undefined;
  return {
    runId: (v['runId'] as string).trim(),
    ...(v['weightGrams'] === undefined ? {} : { weightGrams: v['weightGrams'] as number }),
    ...(typeof v['netQuantity'] === 'string' ? { netQuantity: v['netQuantity'] } : {}),
    ...(typeof v['packerDetails'] === 'string' ? { packerDetails: v['packerDetails'] } : {}),
    ...(Array.isArray(v['allergens']) ? { allergens: v['allergens'] as string[] } : {}),
    ...(v['vegClass'] === undefined ? {} : { vegClass: v['vegClass'] as 'veg' | 'non_veg' }),
    ...(template === undefined ? {} : { template }),
  };
}

const refuse = (refusedBecause: string, detail: string): CounterLabel => ({ ok: false, refusedBecause, detail });

/** Render a counter label on the box from what it holds — or refuse, by name, with nothing printed. */
export function counterLabelFor(input: ScreenInput, req: CounterLabelRequest): CounterLabel {
  const held = input.workFeeds?.production;
  const runs = held === undefined ? [] : (held.feed.body['runs'] as readonly FeedRun[]);
  const recipes = held === undefined ? [] : (held.feed.body['recipes'] as readonly FeedRecipe[]);
  const enabled = held === undefined ? [] : (held.feed.body['enabledDepartments'] as readonly string[]);
  // The run: head office's on the board first; else one this box's screen captured, its use-by from the recipe's shelf life.
  const onBoard = runs.find((r) => r.runId === req.runId);
  const capturedRun = onBoard === undefined ? (input.boxCapturedRuns ?? []).find((r) => r.runId === req.runId) : undefined;
  let run: { departmentId: string; outputProductId: string; outputBatchId: string; expiresAt: string; at: string } | undefined;
  if (onBoard !== undefined) {
    run = { departmentId: onBoard.departmentId, outputProductId: onBoard.outputProductId, outputBatchId: onBoard.outputBatchId, expiresAt: onBoard.expiresAt, at: onBoard.at ?? input.now };
  } else if (capturedRun !== undefined) {
    const recipe = recipes.find((r) => r.recipeId === capturedRun.recipeId);
    if (recipe === undefined) return refuse('recipe_not_known_here', `This store computer does not hold recipe ${capturedRun.recipeId}, so it cannot work out the use-by date. Nothing was printed.`);
    run = { departmentId: recipe.departmentId, outputProductId: recipe.outputProductId, outputBatchId: capturedRun.outputBatchId, expiresAt: useByOf(capturedRun.at, recipe.shelfLifeHours), at: capturedRun.at };
  }
  if (run === undefined) {
    return refuse(held === undefined ? 'production_not_known_here' : 'run_not_known_here', held === undefined
      ? 'This store computer has not been told the production board yet, so it cannot label a run. Nothing was printed.'
      : `This store computer holds no run ${req.runId} — on head office's board as of ${held.feed.asAt}, or captured on this screen. Nothing was printed.`);
  }
  // The department must be one the shop operates (M11-FR-04) — and its label rules decide what is mandatory.
  let department;
  try {
    department = requireDepartment(run.departmentId, enabled);
  } catch (e) {
    if (e instanceof DepartmentNotOperatedError || e instanceof UnknownDepartmentError) return refuse('department_not_operated', `${e.message} Nothing was printed.`);
    throw e;
  }
  // The product's name and price are the catalogue's — the pack the till trades on — never typed at the counter.
  const snapshot = input.cataloguePack?.snapshot;
  const product = snapshot?.products.find((p) => p.productId === run!.outputProductId);
  if (snapshot === undefined || product === undefined) {
    return refuse('product_not_on_the_pack', `${run.outputProductId} is not on the catalogue this store computer holds, so it has no name or price to print. Nothing was printed.`);
  }
  const perKilo = normaliseUom(product.baseUom) === 'kg';
  if (department.weighedOutput && req.weightGrams === undefined) return refuse('weight_needed', 'This counter sells by weight: put the pack on the scale and send its weight. Nothing was printed.');
  const priceMinor = perKilo && req.weightGrams !== undefined ? Math.round((product.unitPriceMinor * req.weightGrams) / 1000) : product.unitPriceMinor;
  // The barcode the till will scan: a weighed pack carries its weight by the shop's own rule; anything else, its own code.
  let barcode: string | undefined;
  if (req.weightGrams !== undefined && perKilo) {
    const rule = (snapshot.embeddedRules ?? []).find((r) => r.valueKind === 'weight');
    const itemCode = rule === undefined ? undefined
      : snapshot.barcodes.find((b) => b.productId === product.productId && b.code.length === rule.itemLength)?.code ?? (product.sku.length === rule.itemLength ? product.sku : undefined);
    if (rule === undefined || itemCode === undefined) return refuse('no_scale_barcode_rule', `The catalogue on this store computer has no weighed-barcode rule and item code for ${product.name}, so the till could not scan this label. Nothing was printed.`);
    try {
      barcode = buildScaleBarcode({ rule, itemCode, value: req.weightGrams });
    } catch (e) {
      if (e instanceof ScaleLabelError) return refuse('scale_barcode_refused', `${e.message}. Nothing was printed.`);
      throw e;
    }
  } else {
    barcode = snapshot.barcodes.find((b) => b.productId === product.productId && b.kind === 'standard')?.code;
  }
  const label: PackLabel = {
    productId: product.productId, productName: product.name, batchId: run.outputBatchId,
    netQuantity: req.netQuantity ?? (req.weightGrams === undefined ? '' : `${req.weightGrams} g`),
    packerDetails: req.packerDetails ?? '', useBy: run.expiresAt, price: { minor: priceMinor, currency: 'INR' },
    ...(req.weightGrams === undefined ? {} : { weightMinor: req.weightGrams }),
    ...(barcode === undefined ? {} : { barcode }),
    ...(req.allergens === undefined ? {} : { allergens: req.allergens }),
    ...(req.vegClass === undefined ? {} : { vegClass: req.vegClass }),
    ...(req.template === undefined ? {} : { template: req.template }),
    producedAt: run.at,
  };
  let prepared: ReturnType<typeof buildPackLabel>;
  try {
    prepared = buildPackLabel(label, department);
  } catch (e) {
    if (e instanceof IncompleteLabelError) return refuse('incomplete_label', `${e.message}. Nothing was printed.`);
    if (e instanceof LabelTooSmallError) return refuse('label_print_too_small', `${e.message}. Nothing was printed.`);
    throw e;
  }
  if (Date.parse(run.expiresAt) <= Date.parse(input.now)) return refuse('already_expired', `Batch ${run.outputBatchId} was good until ${run.expiresAt}; a label is never printed for food past its use-by. Nothing was printed.`);
  return {
    ok: true, runId: req.runId, batchId: run.outputBatchId, useBy: run.expiresAt, productName: product.name, priceMinor,
    // OB-607: the USE BY is printed on the shop's clock, in the zone of the signed store pack (offline — no network call).
    ...(barcode === undefined ? {} : { barcode }), lines: renderLabel(prepared, packTimeZone(input.pack)), ...labelPrintFacts(prepared),
    from: onBoard !== undefined ? 'head_office_board' : 'captured_here', asAt: held?.feed.asAt ?? null,
  };
}
