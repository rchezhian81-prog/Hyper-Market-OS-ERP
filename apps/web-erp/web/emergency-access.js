// Emergency access (W3 · D11-FR-02 · M02-FR-04) — the page over head office's emergency-access routes. The session
// (apps/web-erp/src/emergency-access-session.ts, in the bundle as window.emergencyAccess) does every call and every rule;
// this page lays out what it is told. It reads as it opens; asking, giving and ending are explicit presses. The owner
// approves on the Approvals page, never here. Every word this page adds has a Tamil twin; head office's own sentences stay
// in English (OB-553).

const $ = (id) => document.getElementById(id);
const api = window.emergencyAccess ?? null;
const session = api?.session ?? null;
const may = session?.may ?? { named: false, read: false, ask: false, end: false };
let lang = 'en';
const t = (k) => (api === null ? k : api.words(lang, k));
function text(tag, words, cls) { const n = document.createElement(tag); n.textContent = words; if (cls) n.className = cls; return n; }
const when = (iso) => (api === null ? iso : api.moment(iso));
const storesWords = (scope) => (scope === 'all' ? 'all' : scope.join(', '));

let asks = null;
let grants = null;

// What "Give it" said for each grant, kept across the list's refresh so the answer is never wiped as the list repaints.
const givenWords = new Map();
function paintAsks() {
  $('asks').replaceChildren();
  if (asks === null) return;
  if (asks.length === 0) $('asks').append(text('li', t('noAsks'), 'meta'));
  for (const a of asks) {
    const li = document.createElement('li'); li.dataset.grant = a.grantId; li.dataset.status = a.status;
    li.append(text('h4', `${a.body.userId} — ${a.body.roleId} · ${storesWords(a.body.branchScope)} · ${a.body.minutes} ${t('minutesWord')}`),
      text('p', `${t(`st_${a.status}`)}${a.decidedBy === undefined ? '' : ` (${a.decidedBy})`} · ${a.body.reason}`, 'meta'));
    if (a.status === 'approved') {
      const status = text('p', '', 'status'); status.setAttribute('role', 'status');
      const b = document.createElement('button'); b.type = 'button'; b.textContent = t('give');
      b.addEventListener('click', async () => {
        status.textContent = t('reading');
        const out = await session.give(a);
        status.textContent = out.result === 'ok' ? `${t('given')} ${when(out.value.expiresAt)}.` : api.outcomeWords(lang, out);
        if (out.result === 'ok') { givenWords.set(a.grantId, status.textContent); void load(); }
      });
      li.append(b, status);
    } else if (givenWords.has(a.grantId)) {
      const status = text('p', givenWords.get(a.grantId), 'status'); status.setAttribute('role', 'status');
      li.append(status);
    }
    $('asks').append(li);
  }
}

function paintGrants() {
  $('grants').replaceChildren();
  if (grants === null) return;
  if (grants.length === 0) $('grants').append(text('li', t('noGrants'), 'meta'));
  for (const g of grants) {
    const li = document.createElement('li'); li.dataset.grant = g.grantId; li.dataset.active = String(g.active);
    const state = g.active ? t('live') : g.endedEarly ? t('endedEarly') : t('ended');
    li.append(text('h4', `${g.userId} — ${state}`),
      text('p', `${t('until')} ${when(g.expiresAt)} · ${t('for')} ${g.minutes} ${t('minutesWord')} · ${t('approvedBy')} ${g.approvedBy} · ${g.reason}`, 'meta'));
    if (g.active && may.end) {
      const status = text('p', '', 'status'); status.setAttribute('role', 'status');
      const b = document.createElement('button'); b.type = 'button'; b.className = 'quiet'; b.textContent = t('end'); b.title = t('endReasonHint');
      b.addEventListener('click', async () => {
        status.textContent = t('reading');
        const out = await session.end(g.grantId);
        status.textContent = out.result === 'ok' ? t('endedNow') : api.outcomeWords(lang, out);
        if (out.result === 'ok') void load();
      });
      li.append(b, status);
    }
    $('grants').append(li);
  }
}

function paint() {
  document.title = `SRE ${t('title')}`;
  $('title-text').textContent = t('title'); $('page-h').textContent = t('title'); $('lead').textContent = t('lead');
  $('lang').textContent = lang === 'en' ? 'தமிழ்' : 'English';
  for (const [id, key] of [['ask-h', 'askH'], ['e-person-l', 'person'], ['e-role-l', 'role'], ['e-stores-l', 'stores'], ['e-minutes-l', 'minutes'], ['e-reason-l', 'reason'], ['e-ask-text', 'ask'], ['asks-h', 'asksH'], ['review-h', 'reviewH']]) $(id).textContent = t(key);
  paintAsks(); paintGrants();
}

async function load() {
  if (may.ask) {
    $('asks-status').textContent = t('reading');
    const out = await session.myAsks();
    if (out.result === 'ok') { asks = out.value; $('asks-status').textContent = ''; } else { asks = null; $('asks-status').textContent = api.outcomeWords(lang, out); }
    paintAsks();
  }
  if (may.read) {
    $('review-status').textContent = t('reading');
    const out = await session.review();
    if (out.result === 'ok') { grants = out.value.grants; $('review-status').textContent = ''; } else { grants = null; $('review-status').textContent = api.outcomeWords(lang, out); }
    paintGrants();
  }
}

$('lang').addEventListener('click', () => { lang = lang === 'en' ? 'ta' : 'en'; document.documentElement.lang = lang; paint(); });
$('ask-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  $('ask-status').textContent = t('reading');
  const out = await session.ask({ userId: $('e-person').value, roleId: $('e-role').value, stores: $('e-stores').value, minutes: $('e-minutes').value, reason: $('e-reason').value });
  $('ask-status').textContent = out.result === 'ok' ? t('asked') : api.outcomeWords(lang, out);
  if (out.result === 'ok') void load();
});
paint();
if (!may.named) $('page-status').textContent = t('nobody');
else if (!may.read && !may.ask) $('page-status').textContent = t('cannotRead');
else { $('ask').hidden = !may.ask; $('review').hidden = !may.read; void load(); }
