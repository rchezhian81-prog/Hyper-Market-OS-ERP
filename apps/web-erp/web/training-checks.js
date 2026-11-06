// Training checks (W3 · OB-675 · QG-02) — the page over head office's scored check per role. The session
// (apps/web-erp/src/training-checks-session.ts, in the bundle as window.trainingChecks) does every call and every rule;
// this page lays out what it is told. Setting a check, the pass mark (the owner) and recording an attempt are explicit
// presses; head office works out the score and refuses the person recording their own. Every word this page adds has a
// Tamil twin; head office's own sentences stay in English (OB-553).

const $ = (id) => document.getElementById(id);
const api = window.trainingChecks ?? null;
const session = api?.session ?? null;
const may = session?.may ?? { named: false, read: false, manage: false, setMark: false };
let lang = 'en';
const t = (k) => (api === null ? k : api.words(lang, k));
function text(tag, words, cls) { const n = document.createElement(tag); n.textContent = words; if (cls) n.className = cls; return n; }
function field(labelKey, control) { const l = document.createElement('label'); l.append(text('span', t(labelKey)), control); return l; }
function button(key, cls) { const b = document.createElement('button'); b.classList.add('sre-btn'); b.type = 'button'; b.textContent = t(key); if (cls) b.className = cls; return b; }
const when = (iso) => (api === null ? iso : api.moment(iso));

let view = null;
/** Words a person typed into a role's forms, kept across a repaint (a language switch). */
const typed = new Map();
/** The last answer under each role, and which of its forms are open — kept through a repaint. */
const said = new Map();
const opened = new Set();
const openKept = (roleId, key, d) => { d.open = opened.has(`${roleId}|${key}`); d.addEventListener('toggle', () => { if (d.open) opened.add(`${roleId}|${key}`); else opened.delete(`${roleId}|${key}`); }); };
const keep = (roleId, key, el) => { const k = `${roleId}|${key}`; if (typed.has(k)) el.value = typed.get(k); el.addEventListener('input', () => typed.set(k, el.value)); };

function roleCard(r) {
  const li = document.createElement('li'); li.dataset.role = r.roleId; li.dataset.pilot = r.pilot; li.dataset.final = r.final;
  li.append(text('h4', `${t('role')}: ${r.roleId}`));
  li.append(text('p', `${t('check')}: ${r.check === null ? t('noCheck') : `${t('version')} ${r.check.version} · ${r.check.items} ${t('items')}`} · ${t('passMark')}: ${r.passMarkPercent === null ? t('notSet') : `${r.passMarkPercent}%`}`, 'meta summary'));
  li.append(text('p', `${t('trained')}: ${r.trained.length} · ${r.passedCount} ${t('passedOf')}${r.passedPercent === null ? '' : ` (${r.passedPercent}%)`}`, 'meta counts'));
  const v = text('p', `${t('pilot')}: ${r.pilot === 'passed' ? `✓ ${t('passed')}` : `✕ ${t('notPassed')}`} · ${t('final')}: ${r.final === 'passed' ? `✓ ${t('passed')}` : `✕ ${t('notPassed')}`}`, 'verdict');
  li.append(v);
  if (r.why.length > 0) { const ul = document.createElement('ul'); ul.className = 'plain why'; for (const w of r.why) ul.append(text('li', w)); li.append(text('strong', t('why')), ul); }
  if (r.items.length > 0) { const ol = document.createElement('ol'); ol.className = 'plain items'; for (const i of r.items) ol.append(text('li', `${i.text}`)); li.append(ol); }
  if (r.trained.length > 0) {
    const ul = document.createElement('ul'); ul.className = 'plain people';
    for (const p of r.trained) { const pl = text('li', `${p.name} (${p.employeeId}) — ${p.latest === null ? t('notSat') : `${t('latest')} ${p.latest.scorePercent}%, ${p.latest.passed ? t('resultPassed') : t('resultNotPassed')}`}`); pl.dataset.person = p.employeeId; ul.append(pl); }
    li.append(ul);
  }
  const status = text('p', said.get(r.roleId) ?? '', 'status'); status.setAttribute('role', 'status'); status.setAttribute('aria-live', 'polite');
  // What head office answered stays under the role through the repaint that follows a save.
  const done = async (out, okWords) => { const w = out.result === 'ok' ? okWords(out.value) : api.outcomeWords(lang, out); said.set(r.roleId, w); if (out.result === 'ok') await load(); else status.textContent = w; };

  if (may.manage) {
    const d = document.createElement('details'); d.className = 'set-check'; d.append(text('summary', t('checkH'))); openKept(r.roleId, 'check', d);
    const q = document.createElement('textarea'); q.className = 'questions'; q.value = r.items.filter((i) => i.kind === 'question').map((i) => i.text).join('\n'); keep(r.roleId, 'q', q);
    const k = document.createElement('textarea'); k.className = 'tasks'; k.value = r.items.filter((i) => i.kind === 'task').map((i) => i.text).join('\n'); keep(r.roleId, 'k', k);
    const save = button('saveCheck'); save.className = 'save-check';
    save.addEventListener('click', async () => { status.textContent = t('reading'); await done(await session.setCheck(r.roleId, q.value, k.value), () => t('checkSaved')); });
    d.append(field('questions', q), field('tasks', k), save); li.append(d);
  }
  if (may.setMark) {
    const d = document.createElement('div'); d.className = 'row-form pass-mark';
    const m = document.createElement('input'); m.inputMode = 'numeric'; m.autocomplete = 'off'; m.className = 'mark'; if (r.passMarkPercent !== null) m.value = String(r.passMarkPercent); keep(r.roleId, 'm', m);
    const b = button('setMark'); b.className = 'set-mark';
    b.addEventListener('click', async () => { status.textContent = t('reading'); await done(await session.setPassMark(r.roleId, m.value), () => t('markSaved')); });
    d.append(field('markLabel', m), b); li.append(text('strong', t('markH')), d);
  }
  if (may.manage && r.items.length > 0) {
    const d = document.createElement('details'); d.className = 'record'; d.append(text('summary', t('attemptH'))); openKept(r.roleId, 'record', d);
    const who = document.createElement('input'); who.autocomplete = 'off'; who.className = 'person'; keep(r.roleId, 'who', who);
    const ticks = document.createElement('div'); ticks.className = 'ticks';
    const boxes = r.items.map((i) => { const l = document.createElement('label'); const c = document.createElement('input'); c.type = 'checkbox'; c.dataset.item = i.itemId; l.append(c, text('span', `${i.text} — ${t('passedItem')}`)); ticks.append(l); return [c, i]; });
    const note = document.createElement('input'); note.autocomplete = 'off'; note.className = 'note';
    const b = button('record'); b.className = 'record-attempt';
    b.addEventListener('click', async () => {
      status.textContent = t('reading');
      const out = await session.record(r.roleId, who.value, boxes.map(([c, i]) => ({ itemId: i.itemId, passed: c.checked })), note.value);
      await done(out, (v) => `${t('attemptSaved')} ${t('scored')} ${v.scorePercent}% (${t('passMarkWas')} ${v.passMarkPercent}%) — ${v.passed ? t('resultPassed') : t('resultNotPassed')}.`);
    });
    d.append(field('person', who), ticks, field('note', note), b); li.append(d);
  }
  li.append(status);
  return li;
}

function paintView() {
  const ul = $('roles'); ul.replaceChildren(); $('as-at').textContent = '';
  if (view === null) return;
  $('as-at').textContent = view.asAt === '' ? '' : when(view.asAt);
  if (view.roles.length === 0) ul.append(text('li', t('noRoles'), 'meta'));
  for (const r of view.roles) ul.append(roleCard(r));
}

function paint() {
  document.title = `SRE ${t('title')}`;
  $('title-text').textContent = t('title'); $('page-h').textContent = t('title'); $('lead').textContent = t('lead');
  $('lang').textContent = lang === 'en' ? 'தமிழ்' : 'English';
  $('reading-h').textContent = t('readingH'); $('refresh-text').textContent = t('refresh');
  paintView();
}

async function load() {
  const out = await session.read();
  if (out.result === 'ok') { view = out.value; $('page-status').textContent = ''; } else $('page-status').textContent = api.outcomeWords(lang, out);
  paintView();
}

$('lang').addEventListener('click', () => { lang = lang === 'en' ? 'ta' : 'en'; document.documentElement.lang = lang; paint(); });
$('refresh').addEventListener('click', () => { void load(); });
paint();
if (!may.named) $('page-status').textContent = t('nobody');
else if (!may.read) $('page-status').textContent = t('cannotRead');
else { $('reading').hidden = false; $('page-status').textContent = t('reading'); void load(); }
