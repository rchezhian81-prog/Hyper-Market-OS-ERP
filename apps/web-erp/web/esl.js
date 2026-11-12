// Electronic shelf labels (U6 · §27 "Product — label/ESL" · D14-FR-05 · P-02 · P-03 · P-08) — the page over head office's
// label routes. The session (apps/web-erp/src/esl-session.ts, in the bundle as window.esl) does every call and every rule;
// this page lays out what it is told on the shared office parts (window.sreOffice: cards, table, state, chip, confirm).
// It reads head office as it opens (GETs only); the one write is "send the SAME price again" behind the confirm sheet
// (OB-698). Every word this page adds has a Tamil twin; head office's own sentences stay in English (OB-553, OB-699).

const $ = (id) => document.getElementById(id);
const api = window.esl ?? null;
const session = api?.session ?? null;
const may = session?.may ?? { named: false, read: false, labels: false };
let lang = document.documentElement.lang === 'ta' ? 'ta' : 'en';
const t = (k) => (api === null ? k : api.words(lang, k));
const pair = (k) => (api === null ? { en: k, ta: k } : { en: api.words('en', k), ta: api.words('ta', k) });
const fill = (words, values) => (api === null ? words : api.fill(words, values));
const office = () => window.sreOffice ?? null;
const shopTime = (at) => (at === null || at === undefined || at === '' ? '' : window.sreShopDay?.dateTimeOf(at) ?? at);
const nameOf = (productId) => { const o = office(); const n = o && typeof o.nameOf === 'function' ? o.nameOf('product', productId) : null; return n && n !== productId ? `${n} (${productId})` : productId; };

// U1 (OB-698 · design system §1.3): a greyed button says why — the page's own note beside it, in the reader's language.
const WHY_WORDS = {
  role: { en: 'Your role cannot do this. Ask the owner or the store manager.', ta: 'உங்கள் பங்கு இதைச் செய்ய முடியாது. உரிமையாளரையோ கடை மேலாளரையோ கேளுங்கள்.' },
};
function whyDisabled(btn, why) {
  const tongue = document.documentElement.lang === 'ta' ? 'ta' : 'en';
  const words = why === '' || why === undefined || why === null ? '' : typeof why === 'string' ? (WHY_WORDS[why]?.[tongue] ?? why) : (why[tongue] ?? why.en);
  let note = btn.nextElementSibling;
  if (!(note && note.classList.contains('sre-why'))) {
    note = document.createElement('small'); note.className = 'sre-why';
    note.id = `${btn.id || `b${Math.random().toString(36).slice(2, 7)}`}-why`;
    btn.after(note);
  }
  note.textContent = words; note.hidden = words === '';
  if (words === '') { btn.removeAttribute('title'); btn.removeAttribute('aria-describedby'); } else { btn.title = words; btn.setAttribute('aria-describedby', note.id); }
}

let pushes = null; let pushesOutcome = null; // head office's last answer, or why there is none
let labels = null; let labelsOutcome = null;

function setText(id, words) { const n = $(id); if (n !== null) n.textContent = words; }

function paintWords() {
  document.documentElement.lang = lang;
  setText('lang', t('lang'));
  setText('title-text', t('title')); setText('page-h', t('title')); document.title = `SRE ${t('title')}`;
  setText('lead', t('lead')); setText('standin', t('standin'));
  setText('pushes-h', t('pushesH')); setText('pushes-lead', t('pushesLead'));
  setText('refresh-text', t('refresh')); setText('english-note', t('findingsEnglish'));
  setText('to-mismatches', t('mismatches')); setText('to-devices', t('devices'));
  const n = $('nobody'); n.hidden = may.named; n.textContent = may.named ? '' : t('nobody');
  // the page's own gate, said before the chrome is even here: a person without the word is told so, in their language
  if (may.named && !may.read) $('page-status').textContent = t('cannotRead');
  $('pushes').hidden = !may.read;
}

const toneOf = (state) => (state === 'confirmed' ? 'ok' : state === 'partial' ? 'pending' : state === 'unconfirmed' ? 'error' : 'idle');
const stateWords = (row) => (row.state === 'partial' ? fill(t('st_partial'), { n: row.unconfirmed.length }) : t(`st_${row.state}`));

function paintCards() {
  const o = office(); if (o === null) return;
  const unknown = (why) => ({ value: null, note: why });
  const sent = pushes === null ? unknown(pushesOutcome === null ? '' : api.outcomeWords(lang, pushesOutcome)) : { value: pushes.rows.length, note: '' };
  const confirmed = pushes === null ? unknown('') : { value: pushes.rows.filter((r) => r.state === 'confirmed').length, note: '', tone: 'ok' };
  const notConfirmed = pushes === null ? unknown('') : { value: pushes.rows.filter((r) => r.state === 'partial' || r.state === 'unconfirmed').length, note: '', tone: pushes.rows.some((r) => r.state === 'partial' || r.state === 'unconfirmed') ? 'degraded' : 'ok' };
  const lab = labels === null ? unknown(labelsOutcome === null ? '' : (labelsOutcome.result === 'invalid' ? t(labelsOutcome.why) : api.outcomeWords(lang, labelsOutcome))) : { value: labels.total, note: '' };
  const active = labels === null ? unknown('') : { value: labels.active, note: '', tone: 'ok' };
  const never = labels === null ? unknown('') : { value: labels.neverHeard, note: '', tone: labels.neverHeard > 0 ? 'degraded' : 'ok' };
  o.cards($('cards'), [
    { label: pair('cSent'), ...sent, icon: 'send' },
    { label: pair('cConfirmed'), ...confirmed, icon: 'check' },
    { label: pair('cNotConfirmed'), ...notConfirmed, icon: 'alert' },
    { label: pair('cLabels'), ...lab, icon: 'tag' },
    { label: pair('cActive'), ...active, icon: 'activity' },
    { label: pair('cNever'), ...never, icon: 'circle-help' },
  ]);
  setText('labels-note', labels === null && labelsOutcome !== null && labelsOutcome.result === 'invalid' ? t(labelsOutcome.why) : '');
  setText('covers', pushes === null ? '' : fill(t('readAt'), { time: shopTime(pushes.asAt) }));
}

function unconfirmedRows() { return pushes === null ? [] : pushes.rows.filter((r) => r.state === 'partial' || r.state === 'unconfirmed'); }

function paintPrimary() {
  const b = $('send-all'); if (b === null) return;
  const n = unconfirmedRows().length;
  setText('send-all-text', n === 0 ? t('sendAll') : fill(t('sendAllN'), { n }));
  b.disabled = n === 0 || !may.read;
  whyDisabled(b, !may.read ? 'role' : n === 0 ? pair('nothingToSend') : '');
}

function rowButton(row) {
  if (row.state !== 'partial' && row.state !== 'unconfirmed') return null;
  const b = document.createElement('button');
  b.type = 'button'; b.className = 'quiet sre-btn sre-btn-quiet'; b.textContent = t('sendAgain'); b.dataset.push = row.pushId; // drawn only for a reader who may send (the section is hidden otherwise)
  b.addEventListener('click', () => { void sendAgain([row]); });
  return b;
}

function paintPushes() {
  const o = office(); const host = $('pushes-table'); if (o === null || host === null) return;
  if (!may.read) return;
  if (pushes === null) {
    if (pushesOutcome === null) o.state(host, 'loading', { title: pair('loading') });
    else o.state(host, o.stateOf(pushesOutcome), { title: api.outcomeWords(lang, pushesOutcome), detail: pair('notReadDetail') });
    paintPrimary(); return;
  }
  if (pushes.rows.length === 0) { o.state(host, 'empty', { title: pair('noPushes'), detail: pair('noPushesDetail') }); paintPrimary(); return; }
  o.table(host, {
    id: 'esl-pushes', label: pair('pushesH'), rows: pushes.rows, pageSize: 10, sortable: true,
    rowKey: (r) => r.pushId, rowData: (r) => ({ push: r.pushId, state: r.state, product: r.productId }),
    columns: [
      { key: 'productId', label: pair('product'), sort: 'text', value: (r) => nameOf(r.productId) },
      { key: 'priceMinor', label: pair('price'), sort: 'number', align: 'end', value: (r) => api.rupees(r.priceMinor) },
      { key: 'at', label: pair('sentWhen'), sort: 'text', value: (r) => shopTime(r.at) },
      { key: 'because', label: pair('why'), sort: 'text', value: (r) => t(`because_${r.because}`) },
      { key: 'labels', label: pair('labelsCol'), sort: 'number', align: 'end', value: (r) => `${r.confirmed.length} / ${r.labels}` },
      { key: 'state', label: pair('state'), sort: 'text', value: (r) => stateWords(r), render: (r) => o.chip(toneOf(r.state), stateWords(r)) },
      { key: 'detail', label: { en: 'Head office says', ta: 'தலைமை அலுவலகம் கூறுவது' }, sort: false, value: (r) => (r.detail === '' ? null : r.detail) },
      { key: 'action', label: pair('action'), sort: false, value: (r) => (r.state === 'partial' || r.state === 'unconfirmed' ? t('sendAgain') : null), render: (r) => rowButton(r) },
    ],
    empty: { title: pair('noPushes'), detail: pair('noPushesDetail') },
  });
  paintPrimary();
}

function paint() { paintWords(); paintCards(); paintPushes(); }

async function sendAgain(rows) {
  const o = office(); if (o === null || session === null || rows.length === 0) return;
  const one = rows.length === 1 ? rows[0] : null;
  const asked = await o.confirm({
    title: one ? pair('confirmTitle') : pair('confirmAllTitle'),
    detail: one
      ? { en: fill(api.words('en', 'confirmDetail'), { price: api.rupees(one.priceMinor), product: nameOf(one.productId), n: one.unconfirmed.length }), ta: fill(api.words('ta', 'confirmDetail'), { price: api.rupees(one.priceMinor), product: nameOf(one.productId), n: one.unconfirmed.length }) }
      : { en: fill(api.words('en', 'confirmAllDetail'), { n: rows.length }), ta: fill(api.words('ta', 'confirmAllDetail'), { n: rows.length }) },
    authority: pair('authority'), confirmLabel: pair('confirmLabel'), tone: 'primary',
  });
  if (!asked.ok) return;
  let done = 0; const failed = [];
  for (const row of rows) {
    const out = await session.retry(row.pushId);
    if (out.result === 'ok') { done += 1; if (one) $('send-status').textContent = out.value.retried ? fill(t('sentAgain'), { n: out.value.sentTo.length }) : t('alreadyShown'); }
    else failed.push(fill(t('retryRefused'), { why: out.result === 'invalid' ? t(out.why) : api.outcomeWords(lang, out) }));
  }
  if (!one) $('send-status').textContent = fill(t('sentAgainAll'), { done, all: rows.length, failed: failed.join(' ') });
  else if (failed.length > 0) $('send-status').textContent = failed[0];
  await read();
}

async function read() {
  if (session === null) { paint(); return; }
  pushes = null; pushesOutcome = null; labels = null; labelsOutcome = null; paint();
  const [p, l] = await Promise.all([session.pushes(), session.labels()]);
  if (p.result === 'ok') pushes = p.value; else pushesOutcome = p;
  if (l.result === 'ok') labels = l.value; else labelsOutcome = l;
  paint();
}

$('lang').addEventListener('click', () => { lang = lang === 'en' ? 'ta' : 'en'; paint(); });
$('refresh').addEventListener('click', () => { void read(); });
$('send-all').addEventListener('click', () => { void sendAgain(unconfirmedRows()); });
document.addEventListener('sre:chrome', () => { paint(); });
void read();
