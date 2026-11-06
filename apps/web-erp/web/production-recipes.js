// Recipes (Round 4d · M11-FR-01) — the page the café, bakery and deli recipes are set up on, so the Production page can
// record runs against them. The session (apps/web-erp/src/production-recipes-session.ts, in the bundle as
// window.productionRecipes) does every call and every rule; this page lays out what it is told in the shared office parts
// (window.sreOffice: summary cards, a register with a record drawer, form fields, states). Every word has a Tamil twin.

const $ = (id) => document.getElementById(id);
const api = window.productionRecipes ?? null;
const session = api?.session ?? null;
const may = session?.may ?? { named: false, read: false, manage: false };
let lang = 'en';
const t = (k) => (api === null ? k : api.words(lang, k));
const both = (k) => ({ en: api === null ? k : api.words('en', k), ta: api === null ? k : api.words('ta', k) });
const office = () => window.sreOffice ?? null;
function el(tag, text, cls) { const n = document.createElement(tag); if (text !== undefined) n.textContent = text; if (cls) n.className = cls; return n; }

let read = null; let readOut = null; let register = null;
let depts = null; // W3 · M11-FR-04: { on, available } as head office said
let ingredientRows = 1;
const deptWords = (d) => both(`d_${d}`);
const uomOptions = () => api.uoms.map((u) => ({ value: u, label: both(`u_${u}`) }));
const makes = (r) => `${api.amount(r.outputQuantityMinor, r.outputUom)} ${r.outputUom === 'ea' ? t('u_ea') : ''} ${r.outputProductId}`.replace(/\s+/g, ' ').trim();

function paintCards() {
  const o = office(); if (o === null) return;
  o.cards($('cards'), [
    { label: both('cardRecipes'), value: read === null ? null : read.recipes.length },
    { label: both('cardDepartments'), value: read === null ? null : read.departments.length, note: both('noteDepartments'), tone: read !== null && read.departments.length === 0 ? 'degraded' : undefined },
  ]);
}

function recipeDrawer(r) {
  const o = office(); const box = el('div');
  box.append(o.facts([
    [both('colDepartment'), t(`d_${r.departmentId}`)], [both('colMakes'), makes(r)], [both('colKeeps'), String(r.shelfLifeHours)],
    [both('expectedYield'), r.expectedYieldBp === null ? null : `${(r.expectedYieldBp / 100).toFixed(2)}%`], [both('tolerance'), r.yieldToleranceBp === null ? null : `${(r.yieldToleranceBp / 100).toFixed(2)}%`],
    [both('colVersion'), r.version === null ? null : String(r.version)],
  ]));
  box.append(el('h3', t('inputsH')));
  const ul = el('ul'); for (const i of r.inputs) ul.append(el('li', `${i.productId} — ${api.amount(i.quantityMinor, i.uom)}${i.uom === 'ea' ? ` ${t('u_ea')}` : ''}`)); box.append(ul);
  if (may.manage) {
    const b = el('button', t('editThis'), 'quiet'); b.type = 'button'; b.id = 'edit-this';
    b.addEventListener('click', () => { o.closeDrawer(); fillForm(r); });
    box.append(b);
  }
  return box;
}

function paintRegister() {
  const o = office(); if (o === null || api === null) return;
  if (register === null || !$('recipes-register').contains($('recipes-table'))) {
    register = o.table($('recipes-register'), {
      id: 'recipes', label: both('register'), bodyId: 'recipe-rows', pageSize: 10, rows: null, rowKey: (r) => r.recipeId,
      empty: { title: both('emptyTitle'), detail: both('emptyDetail') },
      columns: [
        { key: 'recipeId', label: both('colRecipe'), sort: 'text' }, { key: 'department', label: both('colDepartment'), filter: true, value: (r) => deptWords(r.departmentId) },
        { key: 'makes', label: both('colMakes'), value: makes }, { key: 'keeps', label: both('colKeeps'), sort: 'number', align: 'end', value: (r) => String(r.shelfLifeHours) },
        { key: 'inputs', label: both('colInputs'), value: (r) => r.inputs.map((i) => i.productId).join(', ') }, { key: 'version', label: both('colVersion'), align: 'end', value: (r) => (r.version === null ? null : String(r.version)) },
      ],
      drawer: { title: (r) => r.recipeId, body: recipeDrawer },
    });
  }
  if (read !== null) register.setRows(read.recipes);
  else if (readOut !== null) register.setState(readOut.result === 'invalid' ? 'denied' : o.stateOf(readOut), { detail: api.outcomeWords(lang, readOut) });
  else register.setRows(null);
}

function ingredientRow(i, value) {
  const o = office();
  const row = el('div', undefined, 'ingredient'); row.dataset.row = String(i);
  row.append(o.field({ id: `in-product-${i}`, label: both('ingredient'), value: value?.productId ?? '' }), o.field({ id: `in-qty-${i}`, label: both('ingredientQty'), inputmode: 'decimal', value: value?.qty ?? '' }),
    o.field({ id: `in-uom-${i}`, label: both('ingredientUom'), type: 'select', options: uomOptions(), value: value?.uom ?? 'kg' }));
  return row;
}
function buildForm(fill) {
  const o = office(); if (o === null || api === null) return;
  const keep = fill ?? currentForm();
  const depts = read?.departments ?? [];
  $('recipe-fields').replaceChildren(
    o.field({ id: 'r-code', label: both('recipeId'), required: true, hint: both('recipeIdHint'), value: keep.recipeId }),
    o.field({ id: 'r-department', label: both('department'), type: 'select', required: true, options: depts.map((d) => ({ value: d, label: deptWords(d) })), value: depts.includes(keep.departmentId) ? keep.departmentId : depts[0] }),
    o.field({ id: 'r-product', label: both('outputProduct'), required: true, value: keep.outputProductId }),
    o.field({ id: 'r-qty', label: both('outputQty'), required: true, inputmode: 'decimal', value: keep.outputQty }),
    o.field({ id: 'r-uom', label: both('outputUom'), type: 'select', options: uomOptions(), value: keep.outputUom || 'ea' }),
    o.field({ id: 'r-hours', label: both('shelfLife'), required: true, inputmode: 'numeric', value: keep.shelfLifeHours }),
    o.field({ id: 'r-yield', label: both('expectedYield'), hint: both('expectedYieldHint'), inputmode: 'decimal', value: keep.expectedYield }),
    o.field({ id: 'r-tolerance', label: both('tolerance'), inputmode: 'decimal', value: keep.tolerance }),
  );
  ingredientRows = Math.max(1, keep.inputs.length);
  $('ingredients').replaceChildren(...Array.from({ length: ingredientRows }, (_, i) => ingredientRow(i, keep.inputs[i])));
  $('no-departments').hidden = depts.length > 0; $('no-departments').textContent = t('noDepartments');
}
const v = (id) => $(id)?.value ?? '';
function currentForm() {
  return {
    recipeId: v('r-code'), departmentId: v('r-department'), outputProductId: v('r-product'), outputQty: v('r-qty'), outputUom: v('r-uom'), shelfLifeHours: v('r-hours'), expectedYield: v('r-yield'), tolerance: v('r-tolerance'),
    inputs: Array.from({ length: ingredientRows }, (_, i) => ({ productId: v(`in-product-${i}`), qty: v(`in-qty-${i}`), uom: v(`in-uom-${i}`) || 'kg' })),
  };
}
function fillForm(r) {
  buildForm({
    recipeId: r.recipeId, departmentId: r.departmentId, outputProductId: r.outputProductId, outputQty: api.amount(r.outputQuantityMinor, r.outputUom).split(' ')[0], outputUom: r.outputUom,
    shelfLifeHours: String(r.shelfLifeHours), expectedYield: r.expectedYieldBp === null ? '' : String(r.expectedYieldBp / 100), tolerance: r.yieldToleranceBp === null ? '' : String(r.yieldToleranceBp / 100),
    inputs: r.inputs.map((i) => ({ productId: i.productId, qty: api.amount(i.quantityMinor, i.uom).split(' ')[0], uom: i.uom })),
  });
  $('r-code').readOnly = true; // a changed recipe keeps its code: it is the same recipe's next version
  $('r-product').focus();
}

// W3 · M11-FR-04: the departments this shop runs, and a "Switch on" for each it does not (the store manager only).
function paintDepartments() {
  $('departments').hidden = depts === null;
  if (depts === null || api === null) return;
  $('dept-rows').replaceChildren(...depts.available.map((d) => {
    const li = el('li'); li.dataset.department = d;
    const on = depts.on.includes(d);
    const name = el('strong', t(`d_${d}`)); const state = el('span', t(on ? 'deptIsOn' : 'deptIsOff'), 'state');
    li.append(name, state);
    if (!on && may.manage) {
      const b = el('button', t('switchOn'), 'quiet'); b.type = 'button'; b.id = `dept-on-${d}`;
      b.addEventListener('click', () => { void switchOn(d); });
      li.append(b);
    }
    return li;
  }));
}
async function switchOn(d) {
  $('dept-status').textContent = t('switching');
  const out = await session.switchOn(d);
  $('dept-status').textContent = out.result === 'ok' ? `${t('switchedOn')} ${t(`d_${out.value.departmentId}`)}.` : api.outcomeWords(lang, out);
  if (out.result === 'ok') await load();
}

function paintWords() {
  $('title-text').textContent = t('title'); $('page-h').textContent = t('title'); $('lead').textContent = t('lead');
  document.title = `SRE ${t('title')}`;
  $('lang').textContent = lang === 'en' ? 'தமிழ்' : 'English';
  for (const [id, key] of [['dept-h', 'deptH'], ['dept-lead', 'deptLead'], ['register-h', 'registerH'], ['form-h', 'formH'], ['inputs-h', 'inputsH'], ['add-ingredient-text', 'addIngredient'], ['save-recipe-text', 'save']]) $(id).textContent = t(key);
}
function paintAll() { paintCards(); paintRegister(); paintDepartments(); if (may.manage && office() !== null && read !== null) buildForm(); }

async function load() {
  $('page-status').textContent = t('reading');
  const [out, d] = await Promise.all([session.read(), session.departments()]);
  depts = d.result === 'ok' ? d.value : null;
  if (out.result === 'ok') { read = out.value; readOut = null; $('page-status').textContent = may.manage ? '' : t('cannotManage'); } else { read = null; readOut = out; $('page-status').textContent = api.outcomeWords(lang, out); }
  $('editor').hidden = !(may.manage && read !== null);
  paintAll();
}

$('add-ingredient').addEventListener('click', () => { const f = currentForm(); f.inputs.push({ productId: '', qty: '', uom: 'kg' }); const code = $('r-code').readOnly; buildForm(f); $('r-code').readOnly = code; $(`in-product-${ingredientRows - 1}`).focus(); });
$('recipe-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const o = office(); if (o !== null && !o.check($('recipe-form'))) return;
  $('recipe-status').textContent = t('saving');
  const out = await session.save(currentForm());
  $('recipe-status').textContent = out.result === 'ok' ? (out.value.changed ? `${t('saved')} ${out.value.version ?? ''}.`.replace(' .', '.') : t('unchanged')) : api.outcomeWords(lang, out);
  if (out.result === 'ok') { buildForm({ recipeId: '', departmentId: '', outputProductId: '', outputQty: '', outputUom: 'ea', shelfLifeHours: '', expectedYield: '', tolerance: '', inputs: [] }); await load(); }
});
$('lang').addEventListener('click', () => { lang = lang === 'en' ? 'ta' : 'en'; document.documentElement.lang = lang; paintWords(); const code = $('r-code')?.readOnly; paintAll(); if ($('r-code')) $('r-code').readOnly = code === true; });
document.addEventListener('sre:chrome', () => paintAll());

paintWords();
if (!may.named) $('page-status').textContent = t('nobody');
else if (!may.read) $('page-status').textContent = t('cannotRead');
else { paintAll(); void load(); }
