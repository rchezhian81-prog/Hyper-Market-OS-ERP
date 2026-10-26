// Feature switches — feature-flag governance (M01-FR-03 · QG-02) — the page over head office's /v1/platform/flags routes.
// The session (apps/web-erp/src/switches-session.ts, in the bundle as window.switches) does every call; this page lays out
// what it is told. Nothing is read on open; every write is a click. Every word has a Tamil twin; every button its icon.

const $ = (id) => document.getElementById(id);
const api = window.switches ?? null;
const session = api?.session ?? null;
const may = session?.may ?? { named: false, read: false, change: false };
let lang = 'en';
const t = (k) => (api === null ? k : api.words(lang, k));
const icon = (name) => (typeof window.sreIcon === 'function' ? window.sreIcon(name, 18) : null);
function text(tag, words, cls) { const n = document.createElement(tag); n.textContent = words; if (cls) n.className = cls; return n; }
function button(words, iconName, cls) { const b = document.createElement('button'); b.type = 'button'; if (cls) b.className = cls; const i = icon(iconName); if (i !== null) b.append(i); b.append(text('span', words)); return b; }
const say = (id, out) => { $(id).textContent = api.outcomeWords(lang, out); };
let board = null; let history = null; let preview = null;

function paintBoard() {
  const ul = $('board-rows'); ul.replaceChildren();
  if (board === null) return;
  if (board.flags.length === 0) ul.append(text('li', `○ ${t('none')}`));
  for (const f of board.flags) {
    const li = document.createElement('li'); li.dataset.key = f.key; li.dataset.state = String(f.enabled);
    li.append(text('strong', `${f.enabled ? '●' : '○'} ${f.key} · ${f.enabled ? t('on') : t('off')}`));
    const h = button(t('history'), 'history', 'quiet'); h.dataset.act = 'history';
    h.addEventListener('click', () => { void showHistory(f.key); });
    li.append(h); ul.append(li);
  }
}
function paintHistory() {
  const ul = $('history-rows'); ul.replaceChildren();
  if (history === null) return;
  for (const v of [...history.versions].reverse()) {
    const li = document.createElement('li'); li.dataset.version = String(v.version);
    li.append(text('strong', `${history.key} · ${t('version')} ${v.version} · ${v.enabled ? t('on') : t('off')}`));
    li.append(text('span', [v.reason ?? '', `${t('by')} ${v.changedBy}`, v.approvedBy === undefined ? '' : `${t('approvedBy')} ${v.approvedBy}`, v.rolledBackFrom === undefined ? '' : `${t('restored')} ${v.rolledBackFrom}`].filter((x) => x !== '').join(' · '), 'meta'));
    if (may.change) {
      const lab = document.createElement('label'); lab.append(text('span', t('backWhy'))); const why = document.createElement('input'); why.className = 'back-why'; why.autocomplete = 'off'; lab.append(why);
      const b = button(t('back'), 'rotate-ccw', 'quiet'); b.dataset.act = 'back';
      b.addEventListener('click', async () => {
        const out = await session.rollback(history.key, v.version, why.value, $('ch-approval').value);
        say('s-status', out);
        if (out.result === 'ok') { await showBoard(); await showHistory(history.key); }
      });
      const acts = document.createElement('div'); acts.className = 'acts'; acts.append(lab, b); li.append(acts);
    }
    ul.append(li);
  }
}
function paintPreview() {
  if (preview === null) { $('ch-said').textContent = ''; return; }
  const w = api.previewWords(lang, preview);
  $('ch-said').textContent = `${w.change}. ${w.who}`;
  $('ch-said').dataset.highImpact = String(preview.highImpact);
}
function paint() {
  $('title-text').textContent = t('title'); $('page-h').textContent = t('title'); $('lead').textContent = t('lead');
  $('lang').textContent = lang === 'en' ? 'தமிழ்' : 'English';
  for (const [id, key] of [['board-h', 'boardH'], ['s-show-text', 'show'], ['change-h', 'changeH'], ['ch-key-l', 'key'], ['ch-state-l', 'state'], ['ch-on', 'on'], ['ch-off', 'off'],
    ['ch-reason-l', 'reason'], ['ch-approval-l', 'approvalId'], ['ch-preview-text', 'preview'], ['ch-save-text', 'save']]) $(id).textContent = t(key);
  paintBoard(); paintHistory(); paintPreview();
}
async function showBoard() {
  const out = await session.board();
  if (out.result !== 'ok') { board = null; say('s-status', out); paintBoard(); return; }
  board = out.value; paintBoard();
}
async function showHistory(key) {
  const out = await session.history(key);
  if (out.result !== 'ok') { say('s-status', out); return; }
  history = out.value; paintHistory();
}

for (const [id, name] of [['s-show', 'search'], ['ch-preview', 'search'], ['ch-save', 'check']]) { const i = icon(name); if (i !== null) $(id).prepend(i); }
$('lang').addEventListener('click', () => { lang = lang === 'en' ? 'ta' : 'en'; document.documentElement.lang = lang; paint(); });
paint();
if (!may.named) $('page-status').textContent = t('nobody');
else if (!may.read) $('page-status').textContent = t('cannotRead');
else {
  $('board').hidden = false;
  $('s-show').addEventListener('click', () => { void showBoard(); });
  if (may.change) {
    $('change').hidden = false;
    $('ch-preview').addEventListener('click', async () => {
      const out = await session.preview($('ch-key').value, $('ch-state').value === 'on');
      if (out.result !== 'ok') { preview = null; paintPreview(); say('ch-status', out); return; }
      preview = out.value; paintPreview(); $('ch-status').textContent = '';
    });
    $('ch-save').addEventListener('click', async () => {
      const out = await session.save($('ch-key').value, $('ch-state').value === 'on', $('ch-reason').value, $('ch-approval').value);
      say('ch-status', out);
      if (out.result === 'ok') { await showBoard(); await showHistory($('ch-key').value.trim()); }
    });
  }
}
