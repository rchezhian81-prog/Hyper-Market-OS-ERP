// W5 (C18 · OB-152 · OB-155 · OB-166 · OB-181 · OB-142 · M25-FR-01) — on the Staff schedule page: check and PUBLISH the
// week's roster (head office refuses a roster that breaks a limit in force, naming every breach — OB-152 "A"), the weeks
// published and the ones that need publishing again, the owner's service standard per role, and labour cost against the
// day's sales (reported, never a cap). The session (apps/web-erp/src/working-time-session.ts, in the bundle as
// window.workingTime) does every call and every rule; this file lays out what it is told. Every word has a Tamil twin.

const $ = (id) => document.getElementById(id);
const api = window.workingTime ?? null;
const session = api?.session ?? null;
const may = session?.may ?? { named: false, rosterRead: false, rosterManage: false, setStandard: false, setGuide: false };
const lang = () => (document.documentElement.lang === 'ta' ? 'ta' : 'en');
const t = (k) => (api === null ? k : api.words(lang(), k));
const icon = (name) => (typeof window.sreIcon === 'function' ? window.sreIcon(name, 18) : null);
function el(tag, attrs = {}, ...kids) { const n = document.createElement(tag); for (const [k, v] of Object.entries(attrs)) { if (k === 'text') n.textContent = v; else if (k === 'cls') n.className = v; else n.setAttribute(k, v); } n.append(...kids); return n; }
function btn(id, words, iconName) { const b = el('button', { type: 'button', id }); const i = icon(iconName); if (i !== null) b.append(i); b.append(el('span', { text: words })); return b; }
function field(id, words, attrs = {}) { return el('label', { for: id }, el('span', { text: words }), el('input', { id, autocomplete: 'off', ...attrs })); }
const statusLine = (id) => el('p', { id, cls: 'status', role: 'status', 'aria-live': 'polite' });
const val = (id) => $(id)?.value ?? '';
const say = (id, out, okWords = '') => { $(id).textContent = out.result === 'ok' ? okWords : api.outcomeWords(lang(), out); };
const rupees = (m) => `₹${(m / 100).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

let check = null; let pubs = null; let standards = null; let cost = null; let published = null;
// The guide is the owner's number (OB-686: the old built-in 12% is gone). Head office compares against a guide typed here for
// a what-if, else the owner's own setting; with neither it compares nothing — the cost and its share, "guide not set".
let guide = null; // the owner's guide as head office answered ({ state: 'not_set' } | { state: 'set', guide })

function checkNode() {
  const box = el('div', { id: 'rc-out' });
  if (published !== null) box.append(el('p', { cls: 'status good', id: 'rc-published', text: `${t('published')} ${published.words ?? ''}` }));
  if (check === null) return box;
  const ul = el('ul', { cls: 'rows' });
  ul.append(el('li', { cls: `row ${check.publishable ? 'tone-ok' : 'tone-error'}`, id: 'rc-verdict', 'data-publishable': String(check.publishable) }, el('strong', { text: check.publishable ? t('publishable') : t('breaches') }),
    ...(check.breaches ?? []).map((b) => el('span', { cls: 'facts', text: b.detail }))));
  if ((check.notChecked ?? []).length > 0) ul.append(el('li', { cls: 'row tone-degraded', id: 'rc-notchecked' }, el('strong', { text: t('notCheckedList') }), ...check.notChecked.map((n) => el('span', { cls: 'facts', text: `${n.label} — ${n.missing}` }))));
  else ul.append(el('li', { cls: 'row tone-ok', text: t('allChecked') }));
  box.append(ul);
  return box;
}

function pubsNode() {
  const box = el('div', { id: 'rp-out' });
  if (pubs === null) return box;
  const ul = el('ul', { cls: 'rows' });
  if ((pubs.weeks ?? []).length === 0) ul.append(el('li', { cls: 'row', text: t('noPublications') }));
  for (const w of pubs.weeks ?? []) ul.append(el('li', { cls: `row ${w.state === 'published' ? 'tone-ok' : 'tone-degraded'}`, 'data-week': w.weekStart, 'data-state': w.state }, el('strong', { text: `${w.weekStart} – ${w.weekEnd}` }), el('span', { cls: 'facts', text: w.state === 'published' ? t('stands') : t('needs_publishing') })));
  box.append(ul);
  return box;
}

function standardsNode() {
  const box = el('div', { id: 'ls-out' });
  if (standards === null) return box;
  const ul = el('ul', { cls: 'rows' });
  if (standards.standards.length === 0) ul.append(el('li', { cls: 'row tone-degraded', text: t('noStandards') }));
  for (const s of standards.standards) ul.append(el('li', { cls: 'row', 'data-role': s.role }, el('strong', { text: `${s.role}: ${s.billsPerStaffHour}` }), el('span', { cls: 'facts', text: `${t('billsPerHour')} · ${t('setBy')} ${s.setBy}` })));
  box.append(ul);
  return box;
}

function costNode() {
  const box = el('div', { id: 'lc-out' });
  if (cost === null) return box;
  const share = cost.labourBps === 'not_meaningful' ? t('notMeaningful') : `${(cost.labourBps / 100).toFixed(2)}% ${t('shareOfSales')}`;
  const compared = cost.guideBps !== null && cost.guideBps !== undefined;
  const words = !compared ? t('guideNotSet') : cost.aboveGuide ? t('aboveGuide') : `${t('withinGuide')} (${cost.guideBps / 100}%)`;
  box.append(el('p', { cls: 'status', id: 'lc-line', 'data-guide': cost.guideFrom ?? (compared ? 'typed' : 'not_set'), text: `${t('costIs')} ${rupees(cost.labourCostMinor)} · ${share} · ${words}` }));
  if (compared) box.append(el('p', { cls: 'muted', text: cost.detail ?? '' }));
  return box;
}

function guideNode() {
  const line = guide === null ? '' : guide.state === 'set' ? t('guideOwnerSet').replace('{percent}', String(guide.guide.guideBps / 100)).replace('{who}', guide.guide.setBy) : t('guideOwnerNotSet');
  const box = el('div', { id: 'lg-box' }, el('h3', { text: t('guideOwnerH') }), el('p', { cls: 'status', id: 'lg-line', 'data-state': guide?.state ?? '', text: line }));
  if (may.setGuide) box.append(el('div', { cls: 'form-row' }, field('lg-percent', t('guidePercent'), { inputmode: 'decimal' }), btn('lg-save', t('guideSave'), 'check')), statusLine('lg-status'));
  return box;
}

function paint() {
  const typed = {}; for (const n of $('roster-pub').querySelectorAll('input')) typed[n.id] = n.value;
  const root = $('roster-pub'); root.replaceChildren(el('h2', { id: 'rc-h', text: t('rosterH') }),
    el('div', { cls: 'form-row' }, field('rc-branch', t('branch')), field('rc-week', t('weekStart'), { type: 'date' }), btn('rc-check', t('check'), 'list-checks'), ...(may.rosterManage ? [btn('rc-publish', t('publish'), 'send')] : [])),
    statusLine('rc-status'), checkNode(), el('h3', { text: t('publicationsH') }), pubsNode(),
    el('h3', { text: t('standardsH') }), statusLine('ls-status'), standardsNode(),
    ...(may.setStandard ? [el('div', { cls: 'form-row' }, field('ls-role', t('role')), field('ls-n', t('billsPerHour'), { inputmode: 'numeric' }), btn('ls-save', t('save'), 'check')), statusLine('ls-save-status')] : []),
    guideNode(),
    el('h3', { text: t('costH') }), el('div', { cls: 'form-row' }, field('lc-date', t('date'), { type: 'date' }), field('lc-sales', t('sales'), { inputmode: 'decimal' }), field('lc-guide', t('guide'), { inputmode: 'numeric' }), btn('lc-show', t('showCost'), 'indian-rupee')),
    statusLine('lc-status'), costNode());
  for (const [id, v] of Object.entries(typed)) { const n = $(id); if (n !== null) n.value = v; }
  wire();
}

async function loadPubs() { const b = val('rc-branch'); if (b.trim() === '') return; const out = await session.publications(b); pubs = out.result === 'ok' ? out.value : null; }
async function loadGuide() { const out = await session.labourGuide(); guide = out.result === 'ok' ? out.value : null; paint(); }
async function loadStandards() { const out = await session.standards(); standards = out.result === 'ok' ? out.value : null; paint(); say('ls-status', out); }

function wire() {
  const on = (id, f) => { const b = $(id); if (b !== null) b.addEventListener('click', f); };
  on('rc-check', async () => {
    $('rc-status').textContent = t('reading'); published = null;
    const out = await session.rosterCheck(val('rc-branch'), val('rc-week'));
    check = out.result === 'ok' ? out.value : null; await loadPubs(); paint(); say('rc-status', out);
  });
  on('rc-publish', async () => {
    $('rc-status').textContent = t('reading');
    const out = await session.publish(val('rc-branch'), val('rc-week'));
    published = out.result === 'ok' ? out.value : null; if (out.result === 'ok') check = null;
    await loadPubs(); paint(); say('rc-status', out);
  });
  on('ls-save', async () => { const out = await session.setStandard(val('ls-role'), val('ls-n')); if (out.result === 'ok') await loadStandards(); say('ls-save-status', out, t('saved')); });
  on('lg-save', async () => { const out = await session.setLabourGuide(val('lg-percent')); if (out.result === 'ok') { guide = out.value; paint(); } say('lg-status', out, t('saved')); });
  on('lc-show', async () => {
    $('lc-status').textContent = t('reading');
    const out = await session.labourCost(val('rc-branch'), val('lc-date'), val('lc-sales'), val('lc-guide'));
    cost = out.result === 'ok' ? out.value : null; paint(); say('lc-status', out);
  });
}

if (api !== null && $('roster-pub') !== null && may.named && may.rosterRead) {
  $('roster-pub').hidden = false;
  $('lang').addEventListener('click', () => { paint(); });
  paint();
  void loadStandards();
  void loadGuide();
}
