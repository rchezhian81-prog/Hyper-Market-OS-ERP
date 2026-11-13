// Training and adoption — the page over head office's adoption gate (QG-09), role curriculum (OB-320), training and
// competency, floor champions, access against the staff list, and sales per labour hour (OB-317). The session
// (apps/web-erp/src/adoption-session.ts, in the bundle as window.adoption) makes every call; this page lays out what it is
// told. Sections show only to a person whose role may use them; every act is a click. Every word has a Tamil twin; every
// button carries an icon beside its word.

const $ = (id) => document.getElementById(id);
// ── U2b (UI/UX gap audit G5 · G14 · P-07): a thing is PICKED by name through the chrome's picker, never typed as a code,
// and a date is written as the shop writes it (dd/mm/yyyy) through the chrome's shared field. The field keeps the id the
// page sends (the typed code stays possible when the list cannot be read — head office down, no right — so the form is
// never a dead end, P-01 · P-08); the chrome's sheet finds the thing by name, code or barcode and the name is shown beside
// the field. Mounted when the chrome is there (a page that paints first listens for `sre:chrome`); off the box nothing
// changes. The same six-line pattern as the U2 pages (store-tasks, delegation, floor-heat-map).
const u2bWords = Object.freeze({ en: { choose: 'Choose…', pickProduct: 'Which product?', pickPlace: 'Which place in the store?', pickPerson: 'Which person?', pickStore: 'Which store?', pickCustomer: 'Which customer?', pickApproval: 'Which approval?', pickSupplier: 'Which supplier?', yourStore: 'your store' }, ta: { choose: 'தேர்ந்தெடு…', pickProduct: 'எந்தப் பொருள்?', pickPlace: 'கடையில் எந்த இடம்?', pickPerson: 'எந்த நபர்?', pickStore: 'எந்தக் கடை?', pickCustomer: 'எந்த வாடிக்கையாளர்?', pickApproval: 'எந்த அனுமதி?', pickSupplier: 'எந்த விநியோகஸ்தர்?', yourStore: 'உங்கள் கடை' } }); // one line on purpose: a page's own word tables start a line with `en: {`
const u2bRepaints = [];
const repaintPickers = () => { for (const f of u2bRepaints) f(); };
/** Mount the picker on an input the page built itself (no id needed); the id a pick gives lands in the input. */
function pickableEl(input, kind, titleKey, extra = {}) {
  // U5: the chrome's own adapter (`sreOffice.pickable`) draws the "Choose…" button (#<id>-pick) and the name beside (#<id>-name);
  // this page keeps only its title words and the per-field options. The typed code stays the fallback (never a dead end).
  const office = window.sreOffice;
  if (!office || typeof office.pickable !== 'function') return;
  office.pickable(input, kind, { en: u2bWords.en[titleKey] ?? titleKey, ta: u2bWords.ta[titleKey] ?? titleKey }, extra);
}
function pickable(inputId, kind, titleKey, extra = {}) {
  const input = document.getElementById(inputId);
  if (!input) return;
  if (!window.sreOffice || typeof window.sreOffice.pick !== 'function') { document.addEventListener('sre:chrome', () => pickable(inputId, kind, titleKey, extra), { once: true }); return; }
  pickableEl(input, kind, titleKey, extra);
}
// the pickers' words and the shared fields' labels follow the language toggle like the page's own words
new MutationObserver(() => { repaintPickers(); if (typeof repaintShopDates === 'function') repaintShopDates(); }).observe(document.documentElement, { attributes: true, attributeFilter: ['lang'] });
// ── U2b end
const api = window.adoption ?? null;
const session = api?.session ?? null;
const may = session?.may ?? { named: false, open: false, gate: false, approve: false, train: false, champion: false, productivity: false, homeDepartment: false };
let lang = 'en';
const t = (k) => (api === null ? k : api.words(lang, k));
/** A role shown by its name in the reader's language, never its id (OB-699 · G16); the chrome's directory is the fallback. */
const ROLE_WORDS = {
  en: { owner: 'Owner', store_manager: 'Store manager', cashier: 'Cashier', accountant: 'Accountant', chartered_accountant: 'Chartered accountant', maker: 'Maker', concessionaire: 'Concessionaire', customer: 'Customer', supplier: 'Supplier', platform_admin: 'Platform administrator', security_reviewer: 'Security reviewer', committee: 'Internal Committee member' },
  ta: { owner: 'உரிமையாளர்', store_manager: 'கடை மேலாளர்', cashier: 'காசாளர்', accountant: 'கணக்காளர்', chartered_accountant: 'பட்டயக் கணக்காளர்', maker: 'தயாரிப்பாளர்', concessionaire: 'சலுகைதாரர்', customer: 'வாடிக்கையாளர்', supplier: 'விநியோகஸ்தர்', platform_admin: 'தள நிர்வாகி', security_reviewer: 'பாதுகாப்பு ஆய்வாளர்', committee: 'உள் குழு உறுப்பினர்' },
};
const roleName = (id) => ROLE_WORDS[lang]?.[id] ?? (window.sreOffice && typeof window.sreOffice.nameOf === 'function' ? window.sreOffice.nameOf('role', id) : id);
const FINDINGS_NOTE = { en: 'Head office\'s findings are in English.', ta: 'தலைமை அலுவலகத்தின் கண்டுபிடிப்புகள் ஆங்கிலத்தில் உள்ளன.' };
/** A sentence head office wrote (a gate finding): kept in English, marked so (OB-699, WCAG 3.1.2). */
const finding = (tag, words) => { const n = text(tag, words); n.setAttribute('lang', 'en'); return n; };

// U2 · G14 (UI/UX gap audit): a date a shop person reads — dd/mm/yyyy in the chrome's shared field (`sreOffice.dateField`),
// while the page goes on sending ISO (`dateOf`). Before the chrome has loaded, or off the box, the field stays as it was.
const wordsIn = (l, k) => (api === null ? k : api.words(l, k)); // the page's own words, for either language (null off the box)
const shopDates = new Map();
/** The shared fields' labels follow the language toggle like the page's own words do. */
function repaintShopDates() { const l = document.documentElement.lang === 'ta' ? 'ta' : 'en'; for (const [id, words] of shopDates) { const lab = $(id)?.closest('.sre-field')?.querySelector('.sre-field-label'); if (lab && lab.firstChild) lab.firstChild.textContent = words[l] ?? words.en; } }
function shopDate(id, words, opts = {}) {
  // U5: the chrome's own adapter (`sreOffice.shopDate`) swaps the box for the shared dd/mm/yyyy field under the same id; the
  // page reads ISO back with `dateOf` and remembers which fields it swapped.
  const office = window.sreOffice;
  if (!office || typeof office.shopDate !== 'function') { document.addEventListener('sre:chrome', () => shopDate(id, words, opts), { once: true }); return; }
  if (shopDates.has(id)) return;
  if (office.shopDate(id, words, opts) !== null) shopDates.set(id, words);
}
const dateOf = (id) => (shopDates.has(id) ? (window.sreOffice.dateValue(id) ?? '') : ($(id)?.value ?? ''));
const icon = (name) => (typeof window.sreIcon === 'function' ? window.sreIcon(name, 18) : null);
function text(tag, words, cls) { const n = document.createElement(tag); n.textContent = words; if (cls) n.className = cls; return n; }
function button(words, iconName, cls) { const b = document.createElement('button'); b.classList.add('sre-btn'); b.type = 'button'; if (cls) b.className = cls; const i = icon(iconName); if (i !== null) b.append(i); b.append(text('span', words)); return b; }
const say = (id, out) => { $(id).textContent = api.outcomeWords(lang, out); };
let gate = null; let cur = null; let training = null; let champs = null; let access = null; let prod = null;
const titleOf = (i) => (lang === 'ta' && i.titleTa ? i.titleTa : i.title);

function paintGate() {
  if (gate === null) return;
  // U5 · G13: the verdict as the chrome's chip (tone + icon) and its words, never a ✓ / ⚠ / ✕ character
  const o = window.sreOffice;
  const tone = gate.verdict === 'GO' ? 'ok' : gate.verdict === 'HOLD' ? 'degraded' : 'error';
  $('gate-verdict').replaceChildren(o && typeof o.chip === 'function' ? o.chip(tone, t(gate.verdict)) : document.createTextNode(t(gate.verdict)));
  $('gate-verdict').dataset.verdict = gate.verdict;
  const why = $('gate-why'); why.replaceChildren();
  if (gate.why.length === 0) why.append(text('li', t('allClear')));
  else why.append(text('li', FINDINGS_NOTE[lang] ?? FINDINGS_NOTE.en, 'meta'));
  for (const w of gate.why) why.append(finding('li', w));
  // U5 · G17: the roles as the chrome's register (sort in words, paging, rows that stack on a phone); the curriculum's state as the chip
  const missingOf = (r) => r.gaps.map((g) => `${g.name}: ${[g.notCompetent.length > 0 ? `${t('notCompetent')} ${g.notCompetent.join(', ')}` : '', g.notAcknowledged.length > 0 ? `${t('notAcknowledged')} ${g.notAcknowledged.join(', ')}` : ''].filter((x) => x !== '').join('; ')}`).join(' | ');
  const W = (k) => ({ en: api === null ? k : api.words('en', k), ta: api === null ? k : api.words('ta', k) });
  if (o && typeof o.table === 'function') {
    const opts = {
      id: 'gate-roles', label: W('gateH'), bodyId: 'gate-roles-body', sortable: true, pageSize: 10, search: false,
      rowKey: (r) => r.roleId, rowData: (r) => ({ role: r.roleId }),
      columns: [
        { key: 'role', label: W('role'), value: (r) => roleName(r.roleId) },
        { key: 'people', label: W('people'), sort: 'number', align: 'end', value: (r) => r.people },
        { key: 'curriculum', label: W('curriculum'), value: (r) => (r.curriculum.approved ? `${t('approvedV')} ${r.curriculum.version}` : t('notApproved')), render: (r) => o.recordChip(r.curriculum.approved ? 'approved' : 'pending', r.curriculum.approved ? `${t('approvedV')} ${r.curriculum.version}` : t('notApproved')) },
        { key: 'missing', label: W('missing'), value: (r) => (missingOf(r) === '' ? t('nothingMissing') : missingOf(r)) },
      ],
      rows: gate.roles, empty: { title: W('allClear') },
    };
    if (gateTable === null || !gateTable.connected()) gateTable = o.table($('gate-roles-host'), opts); else gateTable.setRows(gate.roles);
  } else document.addEventListener('sre:chrome', paintGate, { once: true });
}
let gateTable = null;
function paintCurriculum() {
  const box = $('cur-roles'); box.replaceChildren();
  if (cur === null) return;
  for (const r of cur.roles) {
    const block = document.createElement('div'); block.className = 'role-block'; block.dataset.role = r.roleId;
    block.append(text('strong', `${t('role')}: ${roleName(r.roleId)}`));
    block.append(text('span', r.approved === null ? `${t('proposed')} — ${t('notApproved')}` : `${t('approvedV')} ${r.approved.version} · ${t('approvedBy')} ${r.approved.approvedBy}`, 'meta'));
    const chosen = new Set((r.approved?.items ?? r.proposed).map((i) => i.itemId));
    const all = [...r.proposed, ...(r.approved?.items ?? []).filter((i) => !r.proposed.some((p) => p.itemId === i.itemId))];
    const boxes = [];
    for (const i of all) {
      const l = document.createElement('label'); const c = document.createElement('input'); c.type = 'checkbox'; c.checked = chosen.has(i.itemId); c.disabled = !may.approve; c.dataset.item = i.itemId;
      // A procedure with no Tamil title yet (the owner's guide sections are English documents) is shown in English, marked so.
      const title = text('span', `${i.itemId} — `); if (lang === 'ta' && !i.titleTa) title.setAttribute('lang', 'en');
      // A title's segments (split at ' — ') that are still the document's English heading are marked English (OB-699).
      titleOf(i).split(' — ').forEach((seg, n) => { if (n > 0) title.append(document.createTextNode(' — ')); const sp = document.createElement('span'); sp.textContent = seg; if (lang === 'ta' && /[A-Za-z]{2,}/.test(seg) && !/[\u0B80-\u0BFF]/.test(seg)) sp.setAttribute('lang', 'en'); title.append(sp); });
      l.append(c, title); block.append(l); boxes.push([c, i]);
      itemOption(i.itemId, titleOf(i));
    }
    if (may.approve) {
      const b = button(t('approve'), 'badge-check'); b.dataset.approve = r.roleId;
      b.addEventListener('click', async () => { const out = await session.approve(r.roleId, boxes.filter(([c]) => c.checked).map(([, i]) => i)); say('cur-status', out); if (out.result === 'ok') { await loadCurriculum(); await loadGate(); } });
      block.append(b);
    }
    box.append(block);
  }
}
function paintTraining() {
  const ul = $('t-rows'); ul.replaceChildren();
  if (training === null) return;
  if (training.rows.length === 0) ul.append(text('li', t('trainingNone')));
  for (const r of training.rows) {
    const li = document.createElement('li'); li.dataset.assignment = r.assignmentId;
    li.append(text('strong', `${r.employeeId} — ${r.itemId} ${r.title === r.itemId ? '' : `(${r.title})`}`));
    li.append(text('span', `${t(`s_${r.state}`)}${r.dueOn ? ` · ${t('due')} ${r.dueOn}` : ''}`, 'meta state'));
    if (may.train && (r.state === 'assigned' || r.state === 'overdue')) {
      const b = button(t('done'), 'check'); b.dataset.act = 'done';
      b.addEventListener('click', async () => { const out = await session.complete(r.assignmentId); say('t-status', out); await loadTraining(); await loadGate(); });
      li.append(b);
    }
    if (may.train && (r.state === 'completed' || r.state === 'not_yet_competent')) {
      const b = button(t('competent'), 'badge-check'); b.dataset.act = 'competent';
      b.addEventListener('click', async () => { const out = await session.sign(r.assignmentId, 'competent'); say('t-status', out); await loadTraining(); await loadGate(); });
      const n = button(t('notYet'), 'rotate-ccw', 'quiet'); n.dataset.act = 'not-yet';
      n.addEventListener('click', async () => { const out = await session.sign(r.assignmentId, 'not_yet'); say('t-status', out); await loadTraining(); });
      li.append(b, n);
    }
    ul.append(li);
  }
}
function paintChampions() {
  const ul = $('c-rows'); ul.replaceChildren();
  if (champs === null) return;
  for (const d of champs.departments) {
    const li = document.createElement('li'); li.dataset.department = d.departmentId;
    li.append(text('strong', `${d.name}: ${d.state === 'named' ? `${d.employeeName ?? d.employeeId} (${d.employeeId})` : d.state === 'champion_left' ? `${d.employeeId} ${t('championLeft')}` : t('notSet')}`));
    if (may.champion) {
      const l = document.createElement('label'); l.append(text('span', t('champion'))); const inp = document.createElement('input'); inp.autocomplete = 'off'; l.append(inp);
      const b = button(t('name'), 'user-round');
      b.addEventListener('click', async () => { const out = await session.nameChampion(d.departmentId, inp.value); say('c-status', out); if (out.result === 'ok') { await loadChampions(); await loadGate(); } });
      li.append(l, b);
    }
    ul.append(li);
  }
}
function paintAccess() {
  const ul = $('x-rows'); ul.replaceChildren();
  if (access === null) return;
  if (access.mismatches.length === 0) ul.append(text('li', `✓ ${t('accessClear')}`));
  for (const m of access.mismatches) { const li = text('li', `${m.severity === 'critical' ? '✕' : m.severity === 'warning' ? '⚠' : '•'} ${t(m.severity)} — ${m.detail[lang]}`); li.dataset.kind = m.kind; ul.append(li); }
}
function paintProductivity() {
  const ul = $('pr-rows'); ul.replaceChildren();
  if (prod === null) return;
  const rate = (r) => (r.kind === 'per_hour' ? `${api.rupees(r.minorPerHour)} ${t('perHour')}` : `${t('noRate')} ${r.because ?? ''}`);
  const s = text('li', `${t('store')}: ${api.rupees(prod.store.salesMinor)} · ${api.hoursOf(prod.store.labourMinutes)} ${t('hours')} · ${rate(prod.store.rate)}`); s.dataset.row = 'store'; ul.append(s);
  for (const d of prod.departments) { const li = text('li', `${d.name}: ${api.rupees(d.salesMinor)} · ${d.labourMinutes === null ? t('notAttributed') : `${api.hoursOf(d.labourMinutes)} ${t('hours')} · ${rate(d.rate)}`}`); li.dataset.row = d.departmentId; ul.append(li); }
  ul.append(text('li', `${t('unowned')} ${api.rupees(prod.unownedSalesMinor)}`));
  // OB-357: the hours of people with no home department — by name, never guessed into a department.
  const na = prod.notAttributed;
  if (na !== undefined && na.labourMinutes > 0) {
    const li = text('li', `⚠ ${t('notAttributedH')} ${api.hoursOf(na.labourMinutes)} ${t('hours')} — ${na.people.map((p) => `${p.name} (${p.employeeId}, ${api.hoursOf(p.labourMinutes)}${p.why === 'home_department_not_live' ? `, ${t('notLive')}` : ''})`).join('; ')}`);
    li.dataset.row = 'not-attributed'; ul.append(li);
  }
}
/** OB-357: the department choices for a home department — the live departments head office lists. */
function paintHomeDepartments() {
  const sel = $('hd-dept'); const was = sel.value;
  const none = document.createElement('option'); none.value = ''; none.textContent = t('homeNone');
  const opts = (champs?.departments ?? []).map((d) => { const o = document.createElement('option'); o.value = d.departmentId; o.textContent = `${d.name} (${d.departmentId})`; return o; });
  sel.replaceChildren(none, ...opts); sel.value = was;
}

function paint() {
  repaintShopDates();
  $('title-text').textContent = t('title'); $('page-h').textContent = t('title'); $('lead').textContent = t('lead');
  $('lang').textContent = lang === 'en' ? 'தமிழ்' : 'English';
  for (const [id, key] of [['gate-h', 'gateH'], ['gate-read-text', 'readGate'], ['cur-h', 'curriculumH'], ['train-h', 'trainingH'], ['t-emp-l', 'employee'], ['t-item-l', 'item'], ['t-due-l', 'due'], ['t-assign-text', 'assign'], ['champ-h', 'championsH'], ['access-h', 'accessH'], ['x-read-text', 'checkAccess'], ['prod-h', 'productivityH'], ['pr-from-l', 'from'], ['pr-to-l', 'to'], ['pr-read-text', 'readProductivity'], ['hd-h', 'homeH'], ['hd-emp-l', 'homeEmployee'], ['hd-dept-l', 'homeDept'], ['hd-set-text', 'homeSet']]) { const n = $(id); if (n) n.textContent = t(key); }
  paintGate(); paintCurriculum(); paintTraining(); paintChampions(); paintAccess(); paintProductivity(); paintHomeDepartments();
}
async function loadGate() { if (!may.gate) return; const o = await session.gate(); if (o.result === 'ok') gate = o.value; else say('page-status', o); paintGate(); }
async function loadCurriculum() { const o = await session.curriculum(); if (o.result === 'ok') cur = o.value; else say('cur-status', o); paintCurriculum(); }
async function loadTraining() { const o = await session.training(); if (o.result === 'ok') training = o.value; else say('t-status', o); paintTraining(); }
async function loadChampions() { const o = await session.champions(); if (o.result === 'ok') champs = o.value; else say('c-status', o); paintChampions(); paintHomeDepartments(); }

for (const [id, name] of [['gate-read', 'refresh-cw'], ['t-assign', 'list-plus'], ['x-read', 'shield-check'], ['pr-read', 'chart-column'], ['hd-set', 'user-round']]) { const i = icon(name); if (i !== null) $(id).prepend(i); }
$('lang').addEventListener('click', () => { lang = lang === 'en' ? 'ta' : 'en'; document.documentElement.lang = lang; paint(); });
paint();
if (!may.named) $('page-status').textContent = t('nobody');
else if (!may.open) $('page-status').textContent = t('cannotRead');
else {
  if (may.gate) { $('gate').hidden = false; void loadGate(); $('gate-read').addEventListener('click', loadGate); }
  $('cur').hidden = false; void loadCurriculum();
  $('train').hidden = false; void loadTraining();
  $('train-form').hidden = !may.train; $('t-assign').hidden = !may.train;
  $('t-assign').addEventListener('click', async () => { const out = await session.assign({ employeeId: $('t-emp').value, itemId: $('t-item').value, title: '', dueOn: dateOf('t-due') }); say('t-status', out); if (out.result === 'ok') { await loadTraining(); await loadGate(); } });
  $('champ').hidden = false; void loadChampions();
  $('access').hidden = false;
  $('x-read').addEventListener('click', async () => { const o = await session.access(); if (o.result === 'ok') { access = o.value; $('x-status').textContent = ''; } else say('x-status', o); paintAccess(); });
  if (may.productivity) {
    $('prod').hidden = false;
    $('pr-read').addEventListener('click', async () => { const o = await session.productivity(dateOf('pr-from'), dateOf('pr-to')); if (o.result === 'ok') { prod = o.value; $('pr-status').textContent = ''; } else say('pr-status', o); paintProductivity(); });
  }
  if (may.homeDepartment) {
    $('home-dept').hidden = false;
    $('hd-set').addEventListener('click', async () => { const out = await session.setHomeDepartment($('hd-emp').value, $('hd-dept').value); say('hd-status', out); });
  }
}
// the chrome loads after this script: its shared date fields replace the plain ones once it is there
document.addEventListener('sre:chrome', () => { shopDate('t-due', { en: wordsIn('en', 'due'), ta: wordsIn('ta', 'due') }); shopDate('pr-from', { en: wordsIn('en', 'from'), ta: wordsIn('ta', 'from') }); shopDate('pr-to', { en: wordsIn('en', 'to'), ta: wordsIn('ta', 'to') }); paint(); }, { once: true });

// ── U2b (G5): pick by name, never type a code; the curriculum item from the list this page shows
function itemOption(itemId, title) {
  const list = $('t-item-list'); if (!list || [...list.options].some((o) => o.value === itemId)) return;
  const o = document.createElement('option'); o.value = itemId; o.label = title; list.append(o);
}
pickable('t-emp', 'person', 'pickPerson');
pickable('hd-emp', 'person', 'pickPerson');
