// Access review — the page over head office's access review and permission matrix (M02-FR-01/02 · SEC-11 · §28). The
// session (apps/web-erp/src/access-review-session.ts, in the bundle as window.accessReview) asks head office on a click;
// this page lists who holds what, where and up to how much, with the rows that need a look first — each flag an icon AND
// words — and saves the permission matrix as a CSV. Read-only. Every word has a Tamil twin.

const $ = (id) => document.getElementById(id);
const api = window.accessReview ?? null;
const session = api?.session ?? null;
const may = session?.may ?? { named: false, read: false };

let lang = 'en';
const t = (k) => (api === null ? k : api.words(lang, k));
let review = null;

const icon = (name) => (typeof window.sreIcon === 'function' ? window.sreIcon(name, 18) : null);
for (const [id, name] of [['read', 'search'], ['export', 'file-text']]) { const i = icon(name); if (i !== null) $(id).prepend(i, ' '); }

function say(out) { $('page-status').className = 'status err'; $('page-status').textContent = api.outcomeWords(lang, out); }
function text(tag, words, cls) { const n = document.createElement(tag); n.textContent = words; if (cls) n.className = cls; return n; }

function limitText(l) {
  if (l.state === 'unlimited') return `∞ ${t('unlimited')}`;
  if (l.state === 'not_set') return `○ ${t('notSet')}`;
  if (l.state === 'limit') return `✓ ₹${(l.limitMinor / 100).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
  return '';
}

function row(r) {
  const li = document.createElement('li');
  li.className = `row tone-${r.flags.length > 0 ? 'error' : 'ok'}`;
  li.dataset.user = r.userId;
  li.dataset.flags = r.flags.join(' ');
  li.append(text('strong', `${r.flags.length > 0 ? '⚠' : '✓'} ${r.displayName ?? r.userId} (${r.userId})`));
  const facts = document.createElement('div');
  facts.className = 'facts';
  facts.append(text('span', `${t('signInK')}: ${t(`si_${r.signIn}`)}${r.machine ? ` · ${t('machine')}` : ''}`));
  if (r.secondFactor !== null) facts.append(text('span', `${t('secondK')}: ${r.secondFactor ? `✓ ${t('yes')}` : `✗ ${t('no')}`}`));
  for (const role of r.roles) { const s = text('span', `${t('rolesK')}: ${role.roleName} — ${t('whereK')}: ${api.whereWords(lang, role)}`); s.dataset.role = role.roleId; facts.append(s); }
  for (const e of r.emergency) facts.append(text('span', `⏱ ${t('emergencyK')} ${e.expiresAt} (${e.roleId})`));
  if (r.moneyLimits) facts.append(text('span', `${t('limitsK')}: ${['refund', 'purchase_order', 'stock_adjustment'].map((k) => `${t(`k_${k}`)} ${limitText(r.moneyLimits[k])}`).join(' · ')}`, 'limits'));
  li.append(facts);
  if (r.flags.length > 0) {
    const ul = document.createElement('ul');
    ul.className = 'flags';
    for (const f of r.flags) { const item = text('li', `⚠ ${t(`f_${f}`)}`); item.dataset.flag = f; ul.append(item); }
    li.append(ul);
  }
  return li;
}

function paint() {
  document.title = `SRE ${t('title')}`;
  for (const [id, k] of [['title-text', 'title'], ['page-h', 'title'], ['lead', 'lead'], ['read-text', 'read'], ['only-flagged-l', 'onlyFlagged'], ['export-text', 'exportCsv'], ['last-sign-in', 'lastSignIn']]) $(id).textContent = t(k);
  $('lang').textContent = t('lang');
  $('whoami').textContent = window.accessReviewData?.userId ?? '';
  $('nobody').hidden = may.named; $('nobody').textContent = t('nobody');
  $('read').disabled = !may.read; $('export').disabled = !may.read; whyDisabled($('read'), may.read ? '' : 'role'); whyDisabled($('export'), may.read ? '' : 'role');
  $('rows-section').hidden = review === null;
  if (review === null) return;
  $('rows-h').textContent = `${t('countK')}: ${review.count} · ⚠ ${t('flaggedK')}: ${review.flagged}`;
  $('rows').replaceChildren(...(review.rows.length === 0 ? [text('li', `✓ ${t('nothingFlagged')}`, 'row')] : api.ordered(review.rows).map(row)));
}

async function show() {
  const out = await session.read($('only-flagged').checked);
  if (out.result === 'ok') { review = out.value; $('page-status').className = 'status'; $('page-status').textContent = ''; } else say(out);
  paint();
}

async function exportCsv() {
  const out = await session.matrixCsv();
  if (out.result !== 'ok') { say(out); return; }
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([out.value.csv], { type: 'text/csv' }));
  a.download = out.value.filename;
  document.body.append(a); a.click(); a.remove();
  $('page-status').className = 'status good';
  $('page-status').textContent = `✓ ${t('saved')} ${out.value.filename}`;
}

$('read').addEventListener('click', () => { void show(); });
$('export').addEventListener('click', () => { void exportCsv(); });
$('lang').addEventListener('click', () => { lang = lang === 'en' ? 'ta' : 'en'; document.documentElement.lang = lang; paint(); });
paint();
if (may.named && !may.read) { $('page-status').className = 'status err'; $('page-status').textContent = t('cannotRead'); }

if ('serviceWorker' in navigator) {
  navigator.serviceWorker.register('./sw.js').catch(() => {
    // No offline copy this time; the screen still works online.
  });
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
