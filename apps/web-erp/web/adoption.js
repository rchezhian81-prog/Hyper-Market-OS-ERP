// Training and adoption — the page over head office's adoption gate (QG-09), role curriculum (OB-320), training and
// competency, floor champions, access against the staff list, and sales per labour hour (OB-317). The session
// (apps/web-erp/src/adoption-session.ts, in the bundle as window.adoption) makes every call; this page lays out what it is
// told. Sections show only to a person whose role may use them; every act is a click. Every word has a Tamil twin; every
// button carries an icon beside its word.

const $ = (id) => document.getElementById(id);
const api = window.adoption ?? null;
const session = api?.session ?? null;
const may = session?.may ?? { named: false, open: false, gate: false, approve: false, train: false, champion: false, productivity: false, homeDepartment: false };
let lang = 'en';
const t = (k) => (api === null ? k : api.words(lang, k));
const icon = (name) => (typeof window.sreIcon === 'function' ? window.sreIcon(name, 18) : null);
function text(tag, words, cls) { const n = document.createElement(tag); n.textContent = words; if (cls) n.className = cls; return n; }
function button(words, iconName, cls) { const b = document.createElement('button'); b.type = 'button'; if (cls) b.className = cls; const i = icon(iconName); if (i !== null) b.append(i); b.append(text('span', words)); return b; }
const say = (id, out) => { $(id).textContent = api.outcomeWords(lang, out); };
let gate = null; let cur = null; let training = null; let champs = null; let access = null; let prod = null;
const titleOf = (i) => (lang === 'ta' && i.titleTa ? i.titleTa : i.title);

function paintGate() {
  if (gate === null) return;
  $('gate-verdict').textContent = `${gate.verdict === 'GO' ? '✓' : gate.verdict === 'HOLD' ? '⚠' : '✕'} ${t(gate.verdict)}`;
  $('gate-verdict').dataset.verdict = gate.verdict;
  const why = $('gate-why'); why.replaceChildren();
  if (gate.why.length === 0) why.append(text('li', t('allClear')));
  for (const w of gate.why) why.append(text('li', w));
  const body = $('gate-roles').querySelector('tbody'); body.replaceChildren();
  for (const r of gate.roles) {
    const tr = document.createElement('tr'); tr.dataset.role = r.roleId;
    const missing = r.gaps.map((g) => `${g.name}: ${[g.notCompetent.length > 0 ? `${t('notCompetent')} ${g.notCompetent.join(', ')}` : '', g.notAcknowledged.length > 0 ? `${t('notAcknowledged')} ${g.notAcknowledged.join(', ')}` : ''].filter((x) => x !== '').join('; ')}`).join(' | ');
    for (const v of [r.roleId, String(r.people), r.curriculum.approved ? `${t('approvedV')} ${r.curriculum.version}` : t('notApproved'), missing === '' ? '—' : missing]) tr.append(text('td', v));
    body.append(tr);
  }
}
function paintCurriculum() {
  const box = $('cur-roles'); box.replaceChildren();
  if (cur === null) return;
  for (const r of cur.roles) {
    const block = document.createElement('div'); block.className = 'role-block'; block.dataset.role = r.roleId;
    block.append(text('strong', `${t('role')}: ${r.roleId}`));
    block.append(text('span', r.approved === null ? `${t('proposed')} — ${t('notApproved')}` : `${t('approvedV')} ${r.approved.version} · ${t('approvedBy')} ${r.approved.approvedBy}`, 'meta'));
    const chosen = new Set((r.approved?.items ?? r.proposed).map((i) => i.itemId));
    const all = [...r.proposed, ...(r.approved?.items ?? []).filter((i) => !r.proposed.some((p) => p.itemId === i.itemId))];
    const boxes = [];
    for (const i of all) {
      const l = document.createElement('label'); const c = document.createElement('input'); c.type = 'checkbox'; c.checked = chosen.has(i.itemId); c.disabled = !may.approve; c.dataset.item = i.itemId;
      l.append(c, text('span', `${i.itemId} — ${titleOf(i)}`)); block.append(l); boxes.push([c, i]);
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
  $('title-text').textContent = t('title'); $('page-h').textContent = t('title'); $('lead').textContent = t('lead');
  $('lang').textContent = lang === 'en' ? 'தமிழ்' : 'English';
  for (const [id, key] of [['gate-h', 'gateH'], ['th-role', 'role'], ['th-people', 'people'], ['th-cur', 'curriculum'], ['th-missing', 'missing'], ['gate-read-text', 'readGate'], ['cur-h', 'curriculumH'], ['train-h', 'trainingH'], ['t-emp-l', 'employee'], ['t-item-l', 'item'], ['t-due-l', 'due'], ['t-assign-text', 'assign'], ['champ-h', 'championsH'], ['access-h', 'accessH'], ['x-read-text', 'checkAccess'], ['prod-h', 'productivityH'], ['pr-from-l', 'from'], ['pr-to-l', 'to'], ['pr-read-text', 'readProductivity'], ['hd-h', 'homeH'], ['hd-emp-l', 'homeEmployee'], ['hd-dept-l', 'homeDept'], ['hd-set-text', 'homeSet']]) $(id).textContent = t(key);
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
  $('t-assign').addEventListener('click', async () => { const out = await session.assign({ employeeId: $('t-emp').value, itemId: $('t-item').value, title: '', dueOn: $('t-due').value }); say('t-status', out); if (out.result === 'ok') { await loadTraining(); await loadGate(); } });
  $('champ').hidden = false; void loadChampions();
  $('access').hidden = false;
  $('x-read').addEventListener('click', async () => { const o = await session.access(); if (o.result === 'ok') { access = o.value; $('x-status').textContent = ''; } else say('x-status', o); paintAccess(); });
  if (may.productivity) {
    $('prod').hidden = false;
    $('pr-read').addEventListener('click', async () => { const o = await session.productivity($('pr-from').value, $('pr-to').value); if (o.result === 'ok') { prod = o.value; $('pr-status').textContent = ''; } else say('pr-status', o); paintProductivity(); });
  }
  if (may.homeDepartment) {
    $('home-dept').hidden = false;
    $('hd-set').addEventListener('click', async () => { const out = await session.setHomeDepartment($('hd-emp').value, $('hd-dept').value); say('hd-status', out); });
  }
}
