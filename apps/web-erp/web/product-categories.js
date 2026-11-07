// Categories (Round 4a · M03-FR-01 · OB-24 "A" · re-audit G-1): a THIN CLIENT over head office's one category list and its
// report by category with variants rolled up. The owner (catalogue.category.approve) adds or changes a category directly;
// a store manager (catalogue.category.propose) proposes one and asks the owner's approval (kind category_define) for
// EXACTLY that definition, then saves it naming the approval once the owner has given it on his own Approvals page. A
// change is a new version; nothing is deleted. Head office makes every refusal; the page shows its words. Every word has
// a Tamil twin; nothing is written on open.

const $ = (id) => document.getElementById(id);
const who = window.productCategoriesData && typeof window.productCategoriesData === 'object' ? window.productCategoriesData : null;
const perms = new Set(Array.isArray(who?.permissions) ? who.permissions : []);
const named = typeof who?.userId === 'string' && who.userId !== '';
const mayRead = perms.has('catalogue.pack.read');
const mayPropose = perms.has('catalogue.category.propose');
const mayDefine = perms.has('catalogue.category.approve');
let lang = document.documentElement.lang === 'ta' ? 'ta' : 'en';

// U2 · G10 (UI/UX gap audit): a refusal says what happened, that nothing was changed, and the next safe action — the
// chrome's shared words (apps/web-erp/src/refusal-words.ts), never a raw code or HTTP status. The page's own prefix with
// head office's sentence stands in only until the chrome has loaded.
const refusalLine = (status, err) => {
  const office = window.sreOffice;
  if (office && typeof office.refusalWords === 'function') return office.refusalWords({ status, code: err?.code, whatHappened: err?.whatHappened, nextSafeAction: err?.nextSafeAction });
  const said = `${err?.whatHappened ?? ''} ${err?.nextSafeAction ?? ''}`.trim();
  return said === '' ? t('refused') : `${t('refused')} ${said}`;
};

const KINDS = ['food', 'packed', 'weighed', 'age_restricted', 'drug', 'hazardous', 'bis_controlled', 'liquor'];
const TYPES = ['text', 'number', 'boolean', 'enum', 'date'];

const WORDS = {
  en: {
    lang: 'தமிழ்', title: 'Categories',
    lead: 'Head office\'s one list of departments and categories. Every product sits in exactly one, and its rules — food, age limit, BIS goods — come from it. The owner adds or changes a category; a manager proposes one for the owner\'s approval.',
    kCount: 'Categories on the list', kTop: 'Top-level departments', kRegulated: 'Regulated categories',
    tabList: 'Category list', tabVariants: 'Report by category',
    listLead: 'Open a category to change it. A change is a new version; the earlier one stays on record. Nothing is ever deleted.',
    cPath: 'Category', cId: 'Id', cReg: 'Regulated as', cAttrs: 'Attributes', cVer: 'Version', cBy: 'Approved by',
    formH: 'Add or change a category', fId: 'Category id', fName: 'Name', fParent: 'Sits under', top: 'Nothing — a top-level department',
    fReg: 'Regulated as (drives the safety rules every product in it must meet)', fAttrs: 'Attributes every product in it may or must carry',
    aKey: 'Key', aLabel: 'Label', aType: 'Type', aRequired: 'Required', aAllowed: 'Allowed values (for a list, comma between)',
    fWhy: 'Why (for the owner\'s approval)', save: 'Save the category', ask: 'Ask the owner to approve',
    food: 'Food', packed: 'Packed', weighed: 'Weighed', age_restricted: 'Age limit', drug: 'Medicine (never sold)', hazardous: 'Hazardous', bis_controlled: 'BIS goods', liquor: 'Liquor (never sold)',
    none: 'none', empty: 'No category is on the list yet.', saved: 'Saved.', unchanged: 'Nothing changed — head office already holds exactly this.',
    needApproval: 'A new or changed category is approved by the owner. Write why, then press “Ask the owner to approve”; once he approves it on his Approvals page, press “Save the category” again.',
    asked: 'Asked. It waits for the owner on his Approvals page; nothing is saved until then.', waiting: 'Still waiting for the owner. Nothing was saved.',
    rejected: 'The owner rejected it: {why}', needWhy: 'Write the reason first.', needId: 'Write the category id and name first.',
    variantsLead: 'Every product in the category and the categories under it, each variant under its parent, with the brand and the manufacturer. A manufacturer nobody recorded says so.',
    vCat: 'Category (and everything under it)', all: 'The whole product master', run: 'Show the report',
    vSummary: '{families} families, {products} products.', maker: '{name}: {families} families, {products} products', notRecorded: 'not recorded', orphans: 'Variants whose parent is not held: {ids}',
    family: '{name} ({sku}) — {brand} — {maker}', variants: 'variants', noBrand: 'no brand',
    refused: 'Head office refused:', unreachable: 'Head office could not be reached. Nothing was saved — try again.', cannotRead: 'The category list could not be read from head office.',
    readOnly: 'You can read the list. A category is added by the owner, or proposed by a manager.', noRight: 'This account may not read the category list.', nobody: 'Nobody is signed in on this computer, so nothing can be shown.',
    notKnown: 'Not known',
  },
  ta: {
    lang: 'English', title: 'வகைகள்',
    lead: 'பிரிவுகள் மற்றும் வகைகளின் தலைமை அலுவலகப் பட்டியல் — ஒன்றே. ஒவ்வொரு பொருளும் சரியாக ஒன்றில் இருக்கும்; அதன் விதிகள் — உணவு, வயது வரம்பு, BIS பொருட்கள் — அதிலிருந்து வரும். உரிமையாளர் வகையைச் சேர்க்கிறார் அல்லது மாற்றுகிறார்; மேலாளர் உரிமையாளரின் ஒப்புதலுக்கு முன்மொழிகிறார்.',
    kCount: 'பட்டியலில் உள்ள வகைகள்', kTop: 'மேல்நிலைப் பிரிவுகள்', kRegulated: 'ஒழுங்குபடுத்தப்பட்ட வகைகள்',
    tabList: 'வகைப் பட்டியல்', tabVariants: 'வகைவாரி அறிக்கை',
    listLead: 'மாற்ற ஒரு வகையைத் திறக்கவும். மாற்றம் புதிய பதிப்பு; முந்தையது பதிவில் இருக்கும். எதுவும் நீக்கப்படாது.',
    cPath: 'வகை', cId: 'எண்', cReg: 'ஒழுங்குமுறை', cAttrs: 'பண்புகள்', cVer: 'பதிப்பு', cBy: 'ஒப்புதல் அளித்தவர்',
    formH: 'வகையைச் சேர் அல்லது மாற்று', fId: 'வகை எண்', fName: 'பெயர்', fParent: 'இதன் கீழ்', top: 'எதுவுமில்லை — மேல்நிலைப் பிரிவு',
    fReg: 'ஒழுங்குமுறை (இதிலுள்ள ஒவ்வொரு பொருளும் பின்பற்ற வேண்டிய பாதுகாப்பு விதிகளைத் தீர்மானிக்கும்)', fAttrs: 'இதிலுள்ள ஒவ்வொரு பொருளும் கொண்டிருக்கக்கூடிய அல்லது கொண்டிருக்க வேண்டிய பண்புகள்',
    aKey: 'குறியீடு', aLabel: 'பெயர்', aType: 'வகை', aRequired: 'கட்டாயம்', aAllowed: 'அனுமதிக்கப்பட்ட மதிப்புகள் (பட்டியலுக்கு, காற்புள்ளியால் பிரிக்கவும்)',
    fWhy: 'ஏன் (உரிமையாளரின் ஒப்புதலுக்கு)', save: 'வகையைச் சேமி', ask: 'உரிமையாளரிடம் ஒப்புதல் கேள்',
    food: 'உணவு', packed: 'பொதி செய்யப்பட்டது', weighed: 'எடை போடப்படுவது', age_restricted: 'வயது வரம்பு', drug: 'மருந்து (விற்கப்படாது)', hazardous: 'அபாயகரமானது', bis_controlled: 'BIS பொருட்கள்', liquor: 'மது (விற்கப்படாது)',
    none: 'இல்லை', empty: 'பட்டியலில் இன்னும் வகை இல்லை.', saved: 'சேமிக்கப்பட்டது.', unchanged: 'எதுவும் மாறவில்லை — தலைமை அலுவலகம் ஏற்கெனவே இதையே வைத்திருக்கிறது.',
    needApproval: 'புதிய அல்லது மாற்றிய வகைக்கு உரிமையாளர் ஒப்புதல் தேவை. காரணத்தை எழுதி “உரிமையாளரிடம் ஒப்புதல் கேள்” அழுத்துங்கள்; அவர் தனது ஒப்புதல்கள் பக்கத்தில் ஒப்புக்கொண்டதும் மீண்டும் “வகையைச் சேமி” அழுத்துங்கள்.',
    asked: 'கேட்கப்பட்டது. உரிமையாளரின் ஒப்புதல்கள் பக்கத்தில் காத்திருக்கிறது; அதுவரை எதுவும் சேமிக்கப்படாது.', waiting: 'உரிமையாளர் இன்னும் முடிவு செய்யவில்லை. எதுவும் சேமிக்கப்படவில்லை.',
    rejected: 'உரிமையாளர் நிராகரித்தார்: {why}', needWhy: 'முதலில் காரணத்தை எழுதுங்கள்.', needId: 'முதலில் வகை எண்ணையும் பெயரையும் எழுதுங்கள்.',
    variantsLead: 'வகையிலும் அதன் கீழுள்ள வகைகளிலும் உள்ள ஒவ்வொரு பொருளும், ஒவ்வொரு வகைமாறும் அதன் தாயின் கீழ், பிராண்ட் மற்றும் உற்பத்தியாளருடன். யாரும் பதியாத உற்பத்தியாளர் அப்படியே சொல்லப்படும்.',
    vCat: 'வகை (மற்றும் அதன் கீழுள்ள அனைத்தும்)', all: 'முழுப் பொருள் பதிவேடு', run: 'அறிக்கையைக் காட்டு',
    vSummary: '{families} குடும்பங்கள், {products} பொருட்கள்.', maker: '{name}: {families} குடும்பங்கள், {products} பொருட்கள்', notRecorded: 'பதியப்படவில்லை', orphans: 'தாய் பொருள் இல்லாத வகைமாறுகள்: {ids}',
    family: '{name} ({sku}) — {brand} — {maker}', variants: 'வகைமாறுகள்', noBrand: 'பிராண்ட் இல்லை',
    refused: 'தலைமை அலுவலகம் மறுத்தது:', unreachable: 'தலைமை அலுவலகத்தை அடைய முடியவில்லை. எதுவும் சேமிக்கப்படவில்லை — மீண்டும் முயலவும்.', cannotRead: 'வகைப் பட்டியலைத் தலைமை அலுவலகத்திலிருந்து படிக்க முடியவில்லை.',
    readOnly: 'பட்டியலை நீங்கள் படிக்கலாம். வகையை உரிமையாளர் சேர்க்கிறார், அல்லது மேலாளர் முன்மொழிகிறார்.', noRight: 'இந்தக் கணக்கு வகைப் பட்டியலைப் படிக்க முடியாது.', nobody: 'இந்தக் கணினியில் யாரும் உள்நுழையவில்லை, எனவே எதையும் காட்ட முடியாது.',
    notKnown: 'தெரியவில்லை',
  },
};
const t = (k) => WORDS[lang]?.[k] ?? WORDS.en[k] ?? k;
const fill = (s, vars) => s.replace(/\{(\w+)\}/g, (_, k) => String(vars[k] ?? ''));

const newKey = () => `category-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
async function call(method, path, body) {
  try {
    const res = await fetch(path, {
      method, credentials: 'same-origin', cache: 'no-store',
      headers: { accept: 'application/json', ...(method === 'POST' ? { 'content-type': 'application/json', 'idempotency-key': newKey() } : {}) },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    return { ok: res.ok, status: res.status, body: await res.json().catch(() => null) };
  } catch { return { ok: false, status: 0, body: null }; }
}
const tell = (el, ok, text) => { el.className = `status ${ok ? 'good' : 'err'}`; el.textContent = text; };
const say = (el, out, good) => tell(el, out.ok, out.ok ? good : out.status === 0 ? t('unreachable') : refusalLine(out.status, out.body?.error));
function canonical(v) {
  if (v === null || typeof v !== 'object') return JSON.stringify(v ?? null);
  if (Array.isArray(v)) return `[${v.map(canonical).join(',')}]`;
  return `{${Object.keys(v).filter((k) => v[k] !== undefined).sort().map((k) => `${JSON.stringify(k)}:${canonical(v[k])}`).join(',')}}`;
}
async function ownApproval(subjectRef, details) {
  const out = await call('GET', '/v1/approvals/requests');
  if (!out.ok) return {};
  const mine = (Array.isArray(out.body?.mine) ? out.body.mine : []).filter((r) => r.kind === 'category_define' && r.subjectRef === subjectRef && canonical(r.details) === canonical(details));
  const newest = (rows) => rows.slice().sort((a, b) => String(b.requestedAt).localeCompare(String(a.requestedAt)))[0];
  const approved = newest(mine.filter((r) => r.status === 'approved'));
  if (approved !== undefined) return { approvalId: approved.requestId };
  if (mine.some((r) => r.status === 'waiting')) return { waiting: true };
  const last = newest(mine);
  return last?.status === 'rejected' ? { rejected: last.decisionReason ?? '' } : {};
}

let categories = null;
let readFailed = false;
let pending = null; // the definition the last save needed the owner's approval for
let tab = 'list';

const pathOf = (c) => {
  const byId = new Map((categories ?? []).map((x) => [x.categoryId, x]));
  const names = []; const seen = new Set();
  for (let at = c; at !== undefined && !seen.has(at.categoryId); at = at.parentId === null ? undefined : byId.get(at.parentId)) { names.unshift(at.name); seen.add(at.categoryId); }
  return names.join(' › ');
};

function paintForm() {
  const reg = $('f-reg');
  if (reg.childElementCount === 0) {
    for (const k of KINDS) {
      const l = document.createElement('label'); l.className = 'check'; l.htmlFor = `reg-${k}`;
      const i = document.createElement('input'); i.type = 'checkbox'; i.id = `reg-${k}`; i.value = k;
      const s = document.createElement('span'); s.dataset.word = k;
      l.append(i, s); reg.append(l);
    }
    const attrs = $('f-attrs');
    for (let n = 0; n < 4; n += 1) {
      const row = document.createElement('div'); row.className = 'row';
      for (const [part, word] of [['key', 'aKey'], ['label', 'aLabel'], ['type', 'aType'], ['allowed', 'aAllowed'], ['required', 'aRequired']]) {
        const l = document.createElement('label'); l.htmlFor = `at-${part}-${n}`;
        const s = document.createElement('span'); s.dataset.word = word;
        let i;
        if (part === 'type') { i = document.createElement('select'); for (const ty of TYPES) { const o = document.createElement('option'); o.value = ty; o.textContent = ty; i.append(o); } }
        else { i = document.createElement('input'); if (part === 'required') { i.type = 'checkbox'; l.className = 'check'; } else i.autocomplete = 'off'; }
        i.id = `at-${part}-${n}`;
        if (part === 'required') l.append(i, s); else l.append(s, i);
        row.append(l);
      }
      attrs.append(row);
    }
  }
  for (const s of document.querySelectorAll('#form [data-word]')) s.textContent = t(s.dataset.word);
  const parent = $('f-parent'); const was = parent.value;
  parent.replaceChildren();
  const top = document.createElement('option'); top.value = ''; top.textContent = t('top'); parent.append(top);
  for (const c of [...(categories ?? [])].sort((a, b) => pathOf(a).localeCompare(pathOf(b)))) { const o = document.createElement('option'); o.value = c.categoryId; o.textContent = pathOf(c); parent.append(o); }
  parent.value = [...parent.options].some((o) => o.value === was) ? was : '';
  const editable = mayPropose || mayDefine;
  for (const el of $('form').querySelectorAll('input, select, button')) el.disabled = !editable;
  whyDisabled($('save'), editable ? '' : 'role');
  $('form').hidden = !editable;
  $('ask').hidden = pending === null;
}

function fillForm(c) {
  $('f-id').value = c.categoryId; $('f-name').value = c.name; $('f-parent').value = c.parentId ?? '';
  for (const k of KINDS) $(`reg-${k}`).checked = (c.regulated ?? []).includes(k);
  for (let n = 0; n < 4; n += 1) {
    const a = (c.attributes ?? [])[n];
    $(`at-key-${n}`).value = a?.key ?? ''; $(`at-label-${n}`).value = a?.label ?? ''; $(`at-type-${n}`).value = a?.type ?? 'text';
    $(`at-allowed-${n}`).value = (a?.allowed ?? []).join(', '); $(`at-required-${n}`).checked = a?.required === true;
  }
  pending = null; paintForm();
  $('form-status').textContent = '';
}

/** The definition the form says — in exactly the shape head office keeps (and an approval is fingerprinted on). */
function definitionOfForm() {
  const regulated = KINDS.filter((k) => $(`reg-${k}`).checked);
  const attributes = [];
  for (let n = 0; n < 4; n += 1) {
    const key = $(`at-key-${n}`).value.trim(); const label = $(`at-label-${n}`).value.trim();
    if (key === '' && label === '') continue;
    const type = $(`at-type-${n}`).value;
    const allowed = $(`at-allowed-${n}`).value.split(',').map((x) => x.trim()).filter((x) => x !== '');
    attributes.push({ key, label, type, ...($(`at-required-${n}`).checked ? { required: true } : {}), ...(type === 'enum' && allowed.length > 0 ? { allowed } : {}) });
  }
  return {
    categoryId: $('f-id').value.trim(), name: $('f-name').value.trim(), parentId: $('f-parent').value === '' ? null : $('f-parent').value,
    ...(regulated.length === 0 ? {} : { regulated: [...regulated].sort() }), ...(attributes.length === 0 ? {} : { attributes }),
  };
}

function paintList() {
  const tbody = $('rows');
  tbody.replaceChildren();
  const list = [...(categories ?? [])].sort((a, b) => pathOf(a).localeCompare(pathOf(b)));
  if (categories !== null && list.length === 0) {
    const tr = document.createElement('tr'); const td = document.createElement('td'); td.colSpan = 6; td.textContent = t('empty'); tr.append(td); tbody.append(tr);
  }
  for (const c of list) {
    const tr = document.createElement('tr'); tr.dataset.id = c.categoryId; tr.tabIndex = 0;
    for (const v of [pathOf(c), c.categoryId, (c.regulated ?? []).map((k) => t(k)).join(', ') || t('none'),
      (c.attributes ?? []).map((a) => `${a.label}${a.required === true ? ' *' : ''}`).join(', ') || t('none'), String(c.version), c.approvedBy]) {
      const td = document.createElement('td'); td.textContent = v; tr.append(td);
    }
    const open = () => fillForm(c);
    tr.addEventListener('click', open); tr.addEventListener('keydown', (e) => { if (e.key === 'Enter') open(); });
    tbody.append(tr);
  }
  const unknown = (el, v) => { el.textContent = categories === null ? t('notKnown') : String(v); el.classList.toggle('unknown', categories === null); };
  unknown($('v-count'), list.length); unknown($('v-top'), list.filter((c) => c.parentId === null).length); unknown($('v-regulated'), list.filter((c) => (c.regulated ?? []).length > 0).length);
  const sel = $('v-cat'); const was = sel.value; sel.replaceChildren();
  const all = document.createElement('option'); all.value = ''; all.textContent = t('all'); sel.append(all);
  for (const c of list) { const o = document.createElement('option'); o.value = c.categoryId; o.textContent = pathOf(c); sel.append(o); }
  sel.value = [...sel.options].some((o) => o.value === was) ? was : '';
}

function paintWords() {
  document.title = `SRE ${t('title')}`;
  for (const [id, k] of [['title', 'title'], ['page-h', 'title'], ['lead', 'lead'], ['k-count', 'kCount'], ['k-top', 'kTop'], ['k-regulated', 'kRegulated'], ['tab-list', 'tabList'], ['tab-variants', 'tabVariants'],
    ['list-h', 'tabList'], ['list-lead', 'listLead'], ['c-path', 'cPath'], ['c-id', 'cId'], ['c-reg', 'cReg'], ['c-attrs', 'cAttrs'], ['c-ver', 'cVer'], ['c-by', 'cBy'],
    ['form-h', 'formH'], ['l-f-id', 'fId'], ['l-f-name', 'fName'], ['l-f-parent', 'fParent'], ['l-f-reg', 'fReg'], ['l-f-attrs', 'fAttrs'], ['l-f-why', 'fWhy'], ['save', 'save'], ['ask', 'ask'],
    ['variants-h', 'tabVariants'], ['variants-lead', 'variantsLead'], ['l-v-cat', 'vCat'], ['run', 'run']]) { const el = $(id); if (el) el.textContent = t(k); }
  $('lang').textContent = t('lang');
  $('nobody').hidden = named; $('nobody').textContent = t('nobody');
}

function paint() {
  paintWords(); paintList(); paintForm();
  $('view-list').hidden = tab !== 'list'; $('view-variants').hidden = tab !== 'variants';
  for (const v of ['list', 'variants']) { if (v === tab) $(`tab-${v}`).setAttribute('aria-current', 'page'); else $(`tab-${v}`).removeAttribute('aria-current'); }
}

async function load() {
  const out = await call('GET', '/v1/catalogue/categories');
  readFailed = !out.ok;
  categories = out.ok && Array.isArray(out.body?.categories) ? out.body.categories : null;
  const st = $('page-status');
  if (readFailed) say(st, out, ''); else if (!mayPropose && !mayDefine) { st.className = 'status'; st.textContent = t('readOnly'); } else st.textContent = '';
  paint();
}

$('save').addEventListener('click', async () => {
  const st = $('form-status');
  const def = definitionOfForm();
  if (def.categoryId === '' || def.name === '') { tell(st, false, t('needId')); return; }
  const { categoryId, ...body } = def;
  let approvalId;
  if (!mayDefine) {
    const found = await ownApproval(categoryId, def);
    if (found.waiting === true) { tell(st, false, t('waiting')); return; }
    if (found.rejected !== undefined) { tell(st, false, fill(t('rejected'), { why: found.rejected })); pending = def; paintForm(); return; }
    approvalId = found.approvalId;
  }
  const out = await call('POST', `/v1/catalogue/categories/${encodeURIComponent(categoryId)}`, { ...body, ...(approvalId === undefined ? {} : { approvalId }) });
  if (!out.ok && out.body?.error?.code === 'no_approval') { pending = def; paintForm(); tell(st, false, t('needApproval')); return; }
  pending = null;
  if (out.ok) { await load(); tell($('form-status'), true, out.body?.changed === false ? t('unchanged') : t('saved')); } else say(st, out, '');
});
$('ask').addEventListener('click', async () => {
  const st = $('form-status');
  const why = $('f-why').value.trim();
  if (why === '') { tell(st, false, t('needWhy')); return; }
  if (pending === null) return;
  const out = await call('POST', '/v1/approvals/requests', { kind: 'category_define', subjectRef: pending.categoryId, details: pending, valueMinor: null, summary: `Category ${pending.name} (${pending.categoryId})`, reason: why });
  if (out.ok) { pending = null; paintForm(); tell(st, true, t('asked')); } else say(st, out, '');
});
$('variants-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const st = $('variants-status');
  const id = $('v-cat').value;
  const out = await call('GET', `/v1/catalogue/reports/variants${id === '' ? '' : `?${new URLSearchParams({ categoryId: id })}`}`);
  if (!out.ok) { say(st, out, ''); return; }
  st.textContent = '';
  const r = out.body;
  $('v-summary').textContent = `${fill(t('vSummary'), { families: r.familyCount, products: r.productCount })}${r.orphanVariants.length === 0 ? '' : ` ${fill(t('orphans'), { ids: r.orphanVariants.join(', ') })}`}`;
  $('v-makers').replaceChildren(...r.byManufacturer.map((m) => Object.assign(document.createElement('li'), { textContent: fill(t('maker'), { name: m.recorded ? m.manufacturer : t('notRecorded'), families: m.families, products: m.products }) })));
  $('v-families').replaceChildren(...r.families.map((f) => {
    const li = document.createElement('li'); li.dataset.product = f.productId;
    li.textContent = `${fill(t('family'), { name: f.name, sku: f.sku, brand: f.brand ?? t('noBrand'), maker: f.manufacturer ?? t('notRecorded') })}${f.variants.length === 0 ? '' : ` — ${f.variantCount} ${t('variants')}: ${f.variants.map((v) => `${v.name} (${Object.values(v.attributes).join(', ')})`).join('; ')}`}`;
    return li;
  }));
});
for (const v of ['list', 'variants']) $(`tab-${v}`).addEventListener('click', () => { tab = v; paint(); });
$('lang').addEventListener('click', () => { lang = lang === 'en' ? 'ta' : 'en'; document.documentElement.lang = lang; paint(); });

paint();
if (named && !mayRead) tell($('page-status'), false, t('noRight'));
if (named && mayRead) void load();

if ('serviceWorker' in navigator) {
  navigator.serviceWorker.register('./sw.js').catch(() => { /* the page still opens; it is not kept for offline use */ });
}

/** A greyed button says why (U1 · G3 · design system §4 "disabled state explains why"): the reason is the button's tooltip
 *  and the words beside it, in the reader's language. `why` is 'role' (your role may not), 'offline' (head office cannot
 *  be reached), a page's own { en, ta } pair or sentence; '' takes the words away. */
function whyWords() {
  return {
  role: { en: 'Your role may not do this.', ta: 'உங்கள் பங்குக்கு இதைச் செய்ய அனுமதி இல்லை.' },
  offline: { en: 'Head office cannot be reached, so this cannot be done now.', ta: 'தலைமை அலுவலகத்தை அடைய முடியவில்லை, எனவே இப்போது இதைச் செய்ய முடியாது.' },
  };
}
function whyDisabled(btn, why) {
  const tongue = document.documentElement.lang === 'ta' ? 'ta' : 'en';
  const words = why === '' || why === undefined || why === null ? '' : typeof why === 'string' ? (whyWords()[why]?.[tongue] ?? why) : (why[tongue] ?? why.en);
  let note = btn.nextElementSibling;
  if (!(note && note.classList.contains('sre-why'))) {
    note = document.createElement('small'); note.className = 'sre-why';
    note.id = `${btn.id || `b${Math.random().toString(36).slice(2, 7)}`}-why`;
    btn.after(note);
  }
  note.textContent = words; note.hidden = words === '';
  if (words === '') { btn.removeAttribute('title'); btn.removeAttribute('aria-describedby'); } else { btn.title = words; btn.setAttribute('aria-describedby', note.id); }
}
