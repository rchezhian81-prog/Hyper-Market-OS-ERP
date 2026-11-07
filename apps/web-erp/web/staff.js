// Staff list and shifts (Round 4c) — the page over head office's durable roster store. The session
// (apps/web-erp/src/staff-session.ts, in the bundle as window.staff) does every call and every rule; this page lays out what it
// is told. It reads the list as it opens; every write is an explicit press. Every word this page adds has a Tamil twin; head
// office's own sentences stay in English (OB-553).

const $ = (id) => document.getElementById(id);
const api = window.staff ?? null;
const session = api?.session ?? null;
const may = session?.may ?? { named: false, read: false, manage: false };
let lang = 'en';
const t = (k) => (api === null ? k : api.words(lang, k));
const icon = (name) => (typeof window.sreIcon === 'function' ? window.sreIcon(name, 18) : null);
function text(tag, words, cls) { const n = document.createElement(tag); n.textContent = words; if (cls) n.className = cls; return n; }
function button(words, onClick) { const b = document.createElement('button'); b.type = 'button'; b.className = 'quiet sre-btn sre-btn-quiet'; b.textContent = words; b.addEventListener('click', onClick); return b; }

let roster = null;

function paintStaff() {
  const ul = $('staff-rows'); ul.replaceChildren();
  if (roster === null) return;
  if (roster.staff.length === 0) { ul.append(text('li', t('none'), 'meta')); return; }
  for (const m of roster.staff) {
    const li = document.createElement('li'); li.dataset.person = m.employeeId; li.dataset.active = String(m.active);
    if (!m.active) li.className = 'left';
    const head = document.createElement('div'); head.className = 'head';
    head.append(text('h4', `${m.name} (${m.employeeId})`), text('span', m.active ? t('working') : t('hasLeft'), 'meta'));
    li.append(head, text('p', `${t('roleWords')}: ${m.roles.join(', ')} · ${t('at')}: ${m.branchId}`, 'meta'));
    if (may.manage) {
      const status = text('p', '', 'status'); status.setAttribute('role', 'status');
      const acts = document.createElement('div'); acts.className = 'acts';
      acts.append(
        button(t('change'), () => { $('a-id').value = m.employeeId; $('a-name').value = m.name; $('a-store').value = m.branchId; $('a-roles').value = m.roles.join(', '); $('a-name').focus(); }),
        button(m.active ? t('left') : t('back'), async () => {
          status.textContent = t('reading');
          const out = await session.setActive(m, !m.active);
          status.textContent = out.result === 'ok' ? t('saved') : api.outcomeWords(lang, out);
          if (out.result === 'ok') void load();
        }));
      li.append(acts, status);
    }
    ul.append(li);
  }
}

function paintShifts() {
  const ul = $('shift-rows'); ul.replaceChildren();
  if (roster === null) return;
  if (roster.shifts.length === 0) { ul.append(text('li', t('noShifts'), 'meta')); return; }
  for (const s of roster.shifts) {
    const li = document.createElement('li'); li.dataset.shift = s.shiftId;
    li.append(text('h4', s.shown), text('p', `${t('at')}: ${s.branchId} · ${t('needs')}: ${s.requiredRoles.map((r) => `${r.role} ${r.count}`).join(', ')}`, 'meta'));
    ul.append(li);
  }
}

function paint() {
  $('title-text').textContent = t('title'); $('page-h').textContent = t('title'); $('lead').textContent = t('lead');
  document.title = `SRE ${t('title')}`;
  $('lang').textContent = lang === 'en' ? 'தமிழ்' : 'English';
  for (const [id, key] of [['list-h', 'listH'], ['list-lead', 'listLead'], ['add-h', 'addH'], ['add-lead', 'addLead'], ['a-id-l', 'id'], ['a-name-l', 'name'], ['a-store-l', 'store'], ['a-roles-l', 'roles'], ['a-save-text', 'save'],
    ['shifts-h', 'shiftsH'], ['shifts-lead', 'shiftsLead'], ['new-shift-h', 'newShiftH'], ['new-shift-lead', 'newShiftLead'], ['s-store-l', 'store'], ['s-starts-l', 'starts'], ['s-ends-l', 'ends'], ['s-needs-l', 'needs'], ['s-create-text', 'createShift']]) $(id).textContent = t(key);
  paintStaff(); paintShifts();
}

async function load() {
  $('list-status').textContent = t('reading');
  const out = await session.roster();
  if (out.result === 'ok') { roster = out.value; $('list-status').textContent = ''; } else { roster = null; $('list-status').textContent = api.outcomeWords(lang, out); }
  paintStaff(); paintShifts();
}

for (const [id, name] of [['a-save', 'user-round'], ['s-create', 'calendar-days']]) { const i = icon(name); if (i !== null) $(id).prepend(i); }
$('lang').addEventListener('click', () => { lang = lang === 'en' ? 'ta' : 'en'; document.documentElement.lang = lang; paint(); });
$('add-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  $('add-status').textContent = t('reading');
  const known = roster?.staff.find((m) => m.employeeId === $('a-id').value.trim());
  const out = await session.save({ employeeId: $('a-id').value, name: $('a-name').value, branchId: $('a-store').value, roles: $('a-roles').value, active: known?.active ?? true });
  $('add-status').textContent = out.result === 'ok' ? t('saved') : api.outcomeWords(lang, out);
  if (out.result === 'ok') void load();
});
$('shift-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  $('shift-status').textContent = t('reading');
  const out = await session.createShift({ branchId: $('s-store').value, startsAt: $('s-starts').value, endsAt: $('s-ends').value, needs: $('s-needs').value });
  $('shift-status').textContent = out.result === 'ok' ? t('shiftSaved') : api.outcomeWords(lang, out);
  if (out.result === 'ok') void load();
});

paint();
if (!may.named) $('page-status').textContent = t('nobody');
else if (!may.read) $('page-status').textContent = t('cannotRead');
else {
  $('list').hidden = false; $('shifts').hidden = false;
  if (may.manage) { $('add').hidden = false; $('shift-form').hidden = false; } else $('page-status').textContent = t('cannotManage');
  if (api.storeId !== undefined) { $('a-store').value = api.storeId; $('s-store').value = api.storeId; }
  void load();
}
