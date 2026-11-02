// Recipes (Round 4d · M11-FR-01 · Screen D "production recipes") — a tested, DOM-free session over head office's recipe
// register, which no screen could feed: the Production page records runs against a recipe, and without a way to set one up
// the café, bakery and deli could not record a single run.
//   • the LIST — `GET /v1/production/recipes`: every recipe in force (its latest version) and the departments this store has
//     switched on.
//   • ADD or CHANGE — `POST /v1/production/recipes/:recipeId` { departmentId, outputProductId, outputQuantityMinor,
//     outputUom, inputs[{ productId, quantityMinor, uom }], shelfLifeHours, expectedYieldBp?, yieldToleranceBp? }. Head office
//     checks it with the production engine (a recipe that uses nothing, makes nothing or keeps no time is refused) and keeps
//     every version (the same recipe sent again is no new version). A run already recorded keeps the version it used.
// Quantities are typed in each product's own unit (OB-31: "2.5" kg is 2500 g, "10" pieces is 10) and sent as the unit's
// smallest step, never rounded. Reading needs `production.read`; saving `production.recipe.manage` (the owner, the store
// manager) — head office re-checks each. Every word here has a Tamil twin; head office's own sentences stay English.
//   • DEPARTMENTS (W3 · M11-FR-04) — `GET /v1/production/departments`: the departments this shop runs and every one the
//     product supports; `POST /v1/production/departments/:departmentId` switches one on (`production.recipe.manage`). Head
//     office refuses a department the shop's plan does not include, in its own words. Without this a new shop dead-ended:
//     the page said "switch one on first" and nothing on any screen could.

import { makeCaller, outcomeIn, type Outcome } from './r4-insight-call';
import { typedQuantityMinor, quantityLabel } from '../../../packages/contracts/src/quantity';

export type Lang = 'en' | 'ta';
export const RECIPE_UOMS = ['ea', 'kg', 'g', 'L', 'ml'] as const;

export interface RecipeInputRow { readonly productId: string; readonly quantityMinor: number; readonly uom: string }
export interface RecipeRow {
  readonly recipeId: string; readonly departmentId: string; readonly outputProductId: string; readonly outputQuantityMinor: number; readonly outputUom: string;
  readonly inputs: readonly RecipeInputRow[]; readonly shelfLifeHours: number; readonly expectedYieldBp: number | null; readonly yieldToleranceBp: number | null; readonly version: number | null;
}
export interface RecipesRead { readonly recipes: readonly RecipeRow[]; readonly departments: readonly string[] }
/** The departments this shop runs (on) and every one the product supports (available). */
export interface DepartmentsRead { readonly on: readonly string[]; readonly available: readonly string[] }

export const PRODUCTION_RECIPES_COPY = {
  en: {
    title: 'Recipes',
    lead: 'What each fresh-food item is made from, how much one batch makes and how long it keeps. The Production page records runs against these recipes. A changed recipe is a new version; a run already recorded keeps the version it used.',
    cardRecipes: 'Recipes in force', cardDepartments: 'Departments switched on', noteDepartments: 'a recipe belongs to one of these',
    registerH: 'Recipes', register: 'Recipe register', colRecipe: 'Recipe', colDepartment: 'Department', colMakes: 'One batch makes', colKeeps: 'Keeps (hours)', colInputs: 'Ingredients', colVersion: 'Version',
    formH: 'Add or change a recipe', recipeId: 'Recipe code', recipeIdHint: 'A short code, e.g. idli-batter. Changing a recipe keeps its code.', department: 'Department', outputProduct: 'Product it makes (product code)', outputQty: 'One batch makes', outputUom: 'Counted in',
    shelfLife: 'Keeps for (hours)', expectedYield: 'Expected yield (%)', expectedYieldHint: '100 means nothing is lost; leave blank if not measured.', tolerance: 'Yield may drift by (%)',
    inputsH: 'Ingredients for one batch', ingredient: 'Ingredient (product code)', ingredientQty: 'How much', ingredientUom: 'Unit', addIngredient: 'Add another ingredient', removeIngredient: 'Remove',
    save: 'Save the recipe', saved: 'Recipe saved as version', unchanged: 'Nothing changed — the recipe in force is the same.', editThis: 'Change this recipe',
    u_ea: 'pieces', u_kg: 'kg', u_g: 'g', u_L: 'litres', u_ml: 'ml',
    d_cafe: 'Café', d_bakery: 'Bakery', d_deli: 'Deli counter', d_meat_fish: 'Meat and fish', d_kitchen: 'Central kitchen',
    noDepartments: 'No production department is switched on for this shop. Switch one on first; a recipe belongs to one.',
    deptH: 'Production departments', deptLead: 'A recipe belongs to a department this shop runs. Switch a department on here; head office checks that the shop\'s plan includes it.',
    deptIsOn: 'Switched on', deptIsOff: 'Not switched on', switchOn: 'Switch on', switchedOn: 'Switched on:', switching: 'Switching on…', needDepartmentId: 'Choose a department to switch on.',
    emptyTitle: 'No recipe set up yet', emptyDetail: 'Add a recipe for each item the café, bakery or deli makes. No recipe means no run can be recorded — not that nothing is made.',
    nobody: 'Nobody is signed in on this screen.', cannotRead: 'Your role cannot see the recipes.', cannotManage: 'You can see the recipes; changing them needs the store manager\'s permission.',
    needCode: 'Type a recipe code: letters, numbers and dashes.', needDepartment: 'Choose the department.', needProduct: 'Type the product it makes.', badQty: 'Type an amount the unit holds exactly, e.g. 10 pieces or 2.5 kg.', badHours: 'Type the hours it keeps, a whole number above 0.', badPercent: 'Type a percentage, e.g. 92.5.', needIngredient: 'Add at least one ingredient with its amount.',
    refused: 'Head office refused:', unreachable: 'Head office cannot be reached — nothing was read or saved.', reading: 'Reading from head office…', saving: 'Saving…',
  },
  ta: {
    title: 'சமையல் முறைகள்',
    lead: 'ஒவ்வொரு புதிய உணவுப் பொருளும் எதிலிருந்து செய்யப்படுகிறது, ஒரு தொகுதி எவ்வளவு தருகிறது, எவ்வளவு நேரம் கெடாமல் இருக்கும். உற்பத்திப் பக்கம் இந்த முறைகளுக்கு எதிராக ஓட்டங்களைப் பதிகிறது. மாற்றிய முறை புதிய பதிப்பு; ஏற்கனவே பதிந்த ஓட்டம் அது பயன்படுத்திய பதிப்பையே வைத்திருக்கும்.',
    cardRecipes: 'நடைமுறையில் உள்ள முறைகள்', cardDepartments: 'இயக்கத்தில் உள்ள பிரிவுகள்', noteDepartments: 'ஒரு முறை இவற்றில் ஒன்றைச் சேர்ந்தது',
    registerH: 'சமையல் முறைகள்', register: 'சமையல் முறைப் பதிவேடு', colRecipe: 'முறை', colDepartment: 'பிரிவு', colMakes: 'ஒரு தொகுதி தருவது', colKeeps: 'கெடாமல் (மணி நேரம்)', colInputs: 'பொருட்கள்', colVersion: 'பதிப்பு',
    formH: 'சமையல் முறையைச் சேர் அல்லது மாற்று', recipeId: 'முறைக் குறியீடு', recipeIdHint: 'ஒரு சிறு குறியீடு, எ.கா. idli-batter. மாற்றினாலும் குறியீடு அதுவே.', department: 'பிரிவு', outputProduct: 'செய்யும் பொருள் (பொருள் குறியீடு)', outputQty: 'ஒரு தொகுதி தருவது', outputUom: 'எண்ணும் அலகு',
    shelfLife: 'கெடாமல் இருக்கும் நேரம் (மணி)', expectedYield: 'எதிர்பார்க்கும் விளைச்சல் (%)', expectedYieldHint: '100 என்றால் எதுவும் வீணாகாது; அளக்கவில்லை என்றால் காலியாக விடுங்கள்.', tolerance: 'விளைச்சல் விலகக்கூடிய அளவு (%)',
    inputsH: 'ஒரு தொகுதிக்கான பொருட்கள்', ingredient: 'பொருள் (பொருள் குறியீடு)', ingredientQty: 'எவ்வளவு', ingredientUom: 'அலகு', addIngredient: 'இன்னொரு பொருளைச் சேர்', removeIngredient: 'நீக்கு',
    save: 'சமையல் முறையைச் சேமி', saved: 'சமையல் முறை சேமிக்கப்பட்ட பதிப்பு', unchanged: 'எதுவும் மாறவில்லை — நடைமுறை முறை அதுவே.', editThis: 'இந்த முறையை மாற்று',
    u_ea: 'எண்ணிக்கை', u_kg: 'கிலோ', u_g: 'கிராம்', u_L: 'லிட்டர்', u_ml: 'மி.லி',
    d_cafe: 'கஃபே', d_bakery: 'பேக்கரி', d_deli: 'டெலி கவுண்டர்', d_meat_fish: 'இறைச்சி மற்றும் மீன்', d_kitchen: 'மையச் சமையலறை',
    noDepartments: 'இந்தக் கடைக்கு எந்த உற்பத்திப் பிரிவும் இயக்கப்படவில்லை. முதலில் ஒன்றை இயக்குங்கள்; ஒரு முறை ஒரு பிரிவைச் சேர்ந்தது.',
    deptH: 'உற்பத்திப் பிரிவுகள்', deptLead: 'ஒரு சமையல் முறை இந்தக் கடை நடத்தும் ஒரு பிரிவைச் சேர்ந்தது. ஒரு பிரிவை இங்கே இயக்குங்கள்; கடையின் திட்டத்தில் அது உள்ளதா என்று தலைமை அலுவலகம் சரிபார்க்கும்.',
    deptIsOn: 'இயக்கத்தில் உள்ளது', deptIsOff: 'இயக்கப்படவில்லை', switchOn: 'இயக்கு', switchedOn: 'இயக்கப்பட்டது:', switching: 'இயக்குகிறது…', needDepartmentId: 'இயக்க ஒரு பிரிவைத் தேர்ந்தெடுங்கள்.',
    emptyTitle: 'இன்னும் சமையல் முறை அமைக்கப்படவில்லை', emptyDetail: 'கஃபே, பேக்கரி அல்லது டெலி செய்யும் ஒவ்வொன்றுக்கும் ஒரு முறையைச் சேருங்கள். முறை இல்லை என்றால் எந்த ஓட்டத்தையும் பதிய முடியாது — எதுவும் செய்யப்படவில்லை என்பதல்ல.',
    nobody: 'இந்தத் திரையில் யாரும் உள்நுழையவில்லை.', cannotRead: 'உங்கள் பங்கு சமையல் முறைகளைப் பார்க்க முடியாது.', cannotManage: 'முறைகளைப் பார்க்கலாம்; மாற்ற கடை மேலாளர் அனுமதி தேவை.',
    needCode: 'முறைக் குறியீட்டைத் தட்டச்சு செய்யுங்கள்: எழுத்துகள், எண்கள், கோடுகள்.', needDepartment: 'பிரிவைத் தேர்ந்தெடுங்கள்.', needProduct: 'செய்யும் பொருளைத் தட்டச்சு செய்யுங்கள்.', badQty: 'அலகு சரியாக வைத்திருக்கும் அளவைத் தட்டச்சு செய்யுங்கள், எ.கா. 10 எண்ணிக்கை அல்லது 2.5 கிலோ.', badHours: 'கெடாமல் இருக்கும் மணி நேரத்தைத் தட்டச்சு செய்யுங்கள், 0க்கு மேல் முழு எண்.', badPercent: 'சதவீதத்தைத் தட்டச்சு செய்யுங்கள், எ.கா. 92.5.', needIngredient: 'குறைந்தது ஒரு பொருளை அதன் அளவுடன் சேருங்கள்.',
    refused: 'தலைமை அலுவலகம் மறுத்தது:', unreachable: 'தலைமை அலுவலகத்தை அடைய முடியவில்லை — எதுவும் படிக்கப்படவில்லை, சேமிக்கப்படவில்லை.', reading: 'தலைமை அலுவலகத்திலிருந்து படிக்கிறது…', saving: 'சேமிக்கிறது…',
  },
} as const;

export const productionRecipesWords = (lang: Lang, key: string): string =>
  (PRODUCTION_RECIPES_COPY[lang] as Record<string, string>)[key] ?? (PRODUCTION_RECIPES_COPY.en as Record<string, string>)[key] ?? key;
export const productionRecipesOutcomeWords = (lang: Lang, out: Outcome<unknown>): string => outcomeIn((k) => productionRecipesWords(lang, k), out);

/** An amount in its unit's words ("2.5 kg", "10"), from the stored smallest step. */
export const amountWords = (quantityMinor: number, uom: string): string => quantityLabel(quantityMinor, uom);

/** A percentage typed ("92.5") as basis points (9250), or undefined. Blank is "not given" (null). */
export function basisPointsOf(typed: string): number | null | undefined {
  const t = typed.trim().replace(',', '.');
  if (t === '') return null;
  if (!/^\d{1,3}(\.\d{1,2})?$/.test(t)) return undefined;
  return Math.round(Number(t) * 100);
}

type Why = 'nobody' | 'cannotRead' | 'cannotManage' | 'needCode' | 'needDepartment' | 'needProduct' | 'badQty' | 'badHours' | 'badPercent' | 'needIngredient' | 'needDepartmentId';

export interface RecipeInput {
  readonly recipeId: string; readonly departmentId: string; readonly outputProductId: string; readonly outputQty: string; readonly outputUom: string;
  readonly shelfLifeHours: string; readonly expectedYield: string; readonly tolerance: string;
  readonly inputs: readonly { readonly productId: string; readonly qty: string; readonly uom: string }[];
}

export interface ProductionRecipesSession {
  readonly may: { readonly named: boolean; readonly read: boolean; readonly manage: boolean };
  read(): Promise<Outcome<RecipesRead, Why>>;
  save(r: RecipeInput): Promise<Outcome<{ readonly recipeId: string; readonly version: number | null; readonly changed: boolean }, Why>>;
  /** W3 · M11-FR-04: the departments this shop runs, and every one the product supports. */
  departments(): Promise<Outcome<DepartmentsRead, Why>>;
  /** W3 · M11-FR-04: switch one department on — head office checks the shop's plan includes it. */
  switchOn(departmentId: string): Promise<Outcome<{ readonly departmentId: string }, Why>>;
}

const isObj = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === 'object' && !Array.isArray(v);
const str = (v: unknown): string => (typeof v === 'string' ? v : '');

export function createProductionRecipesSession(input: { readonly viewer: { readonly userId?: string; readonly permissions: readonly string[] } | undefined; readonly fetch?: typeof globalThis.fetch }): ProductionRecipesSession {
  const named = input.viewer?.userId !== undefined;
  const held = new Set(input.viewer?.permissions ?? []);
  const may = { named, read: named && held.has('production.read'), manage: named && held.has('production.recipe.manage') };
  const call = makeCaller({ keyPrefix: 'recipes', ...(input.fetch === undefined ? {} : { fetch: input.fetch }) });
  const no = (why: Why): Outcome<never, Why> => ({ result: 'invalid', why });
  return {
    may,
    read: async () => {
      if (!named) return no('nobody');
      if (!may.read) return no('cannotRead');
      const out = await call<{ recipes?: unknown; enabledDepartments?: unknown }>('GET', '/v1/production/recipes');
      if (out.result !== 'ok') return out;
      const recipes = (Array.isArray(out.value.recipes) ? out.value.recipes : []).filter(isObj).map((r): RecipeRow => ({
        recipeId: str(r['recipeId']), departmentId: str(r['departmentId']), outputProductId: str(r['outputProductId']), outputQuantityMinor: Number(r['outputQuantityMinor'] ?? 0), outputUom: str(r['outputUom']),
        inputs: (Array.isArray(r['inputs']) ? r['inputs'] : []).filter(isObj).map((i) => ({ productId: str(i['productId']), quantityMinor: Number(i['quantityMinor'] ?? 0), uom: str(i['uom']) })),
        shelfLifeHours: Number(r['shelfLifeHours'] ?? 0), expectedYieldBp: typeof r['expectedYieldBp'] === 'number' ? r['expectedYieldBp'] : null,
        yieldToleranceBp: typeof r['yieldToleranceBp'] === 'number' ? r['yieldToleranceBp'] : null, version: typeof r['version'] === 'number' ? r['version'] : null,
      })).sort((a, b) => a.recipeId.localeCompare(b.recipeId));
      const departments = (Array.isArray(out.value.enabledDepartments) ? out.value.enabledDepartments : []).filter((d): d is string => typeof d === 'string');
      return { result: 'ok', value: { recipes, departments } };
    },
    save: async (r) => {
      if (!named) return no('nobody');
      if (!may.manage) return no('cannotManage');
      const recipeId = r.recipeId.trim();
      if (!/^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/.test(recipeId)) return no('needCode');
      if (r.departmentId.trim() === '') return no('needDepartment');
      if (r.outputProductId.trim() === '') return no('needProduct');
      const outputQuantityMinor = typedQuantityMinor(r.outputQty, r.outputUom);
      if (outputQuantityMinor === undefined) return no('badQty');
      const hours = r.shelfLifeHours.trim();
      if (!/^\d+$/.test(hours) || Number(hours) <= 0) return no('badHours');
      const yieldBp = basisPointsOf(r.expectedYield); const toleranceBp = basisPointsOf(r.tolerance);
      if (yieldBp === undefined || toleranceBp === undefined) return no('badPercent');
      const typed = r.inputs.filter((i) => i.productId.trim() !== '' || i.qty.trim() !== '');
      if (typed.length === 0) return no('needIngredient');
      const inputs: RecipeInputRow[] = [];
      for (const i of typed) {
        if (i.productId.trim() === '') return no('needIngredient');
        const q = typedQuantityMinor(i.qty, i.uom);
        if (q === undefined) return no('badQty');
        inputs.push({ productId: i.productId.trim(), quantityMinor: q, uom: i.uom });
      }
      const out = await call<{ version?: unknown; changed?: unknown }>('POST', `/v1/production/recipes/${encodeURIComponent(recipeId)}`, {
        departmentId: r.departmentId.trim(), outputProductId: r.outputProductId.trim(), outputQuantityMinor, outputUom: r.outputUom, inputs, shelfLifeHours: Number(hours),
        ...(yieldBp === null ? {} : { expectedYieldBp: yieldBp }), ...(toleranceBp === null ? {} : { yieldToleranceBp: toleranceBp }),
      });
      return out.result === 'ok' ? { result: 'ok', value: { recipeId, version: typeof out.value.version === 'number' ? out.value.version : null, changed: out.value.changed !== false } } : out;
    },
    departments: async () => {
      if (!named) return no('nobody');
      if (!may.read) return no('cannotRead');
      const out = await call<{ operated?: unknown; available?: unknown }>('GET', '/v1/production/departments');
      if (out.result !== 'ok') return out;
      const on = (Array.isArray(out.value.operated) ? out.value.operated : []).filter(isObj).map((d) => str(d['departmentId'])).filter((d) => d !== '');
      const available = (Array.isArray(out.value.available) ? out.value.available : []).filter((d): d is string => typeof d === 'string');
      return { result: 'ok', value: { on, available } };
    },
    switchOn: async (departmentId) => {
      if (!named) return no('nobody');
      if (!may.manage) return no('cannotManage');
      const id = departmentId.trim();
      if (!/^[a-z][a-z_]{0,31}$/.test(id)) return no('needDepartmentId');
      const out = await call<{ departmentId?: unknown }>('POST', `/v1/production/departments/${encodeURIComponent(id)}`, {});
      return out.result === 'ok' ? { result: 'ok', value: { departmentId: typeof out.value.departmentId === 'string' ? out.value.departmentId : id } } : out;
    },
  };
}
