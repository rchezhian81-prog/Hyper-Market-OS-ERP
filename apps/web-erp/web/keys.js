// Keys and credentials (U6 · §27 Admin/Security "keys" · M32-FR-03 · SEC-04 · hard rule 4) — the page over head office's
// secret and sign-in-revocation routes. The session (apps/web-erp/src/keys-session.ts, in the bundle as window.keys) does
// every call and every rule; this page lays out what it is told on the shared office parts (window.sreOffice: cards, table,
// state, recordChip, field, confirm). It reads head office as it opens (GETs only); every write is an explicit click behind
// the confirm sheet (OB-698). A secret's VALUE is never read, shown or typed. Every word this page adds has a Tamil twin;
// head office's own sentences stay in English (OB-699), said once. No prompt/confirm/alert; nothing on a timer.

const $ = (id) => document.getElementById(id);
const api = window.keys ?? null;
const session = api?.session ?? null;
const may = session?.may ?? { named: false, read: false, write: false, revokeTokens: false };
let lang = document.documentElement.lang === 'ta' ? 'ta' : 'en';
const t = (k) => (api === null ? k : api.words(lang, k));
const pair = (k) => ({ en: api === null ? k : api.words('en', k), ta: api === null ? k : api.words('ta', k) });
const fill = (text, values) => Object.entries(values).reduce((s, [k, v]) => s.split(`{${k}}`).join(String(v)), text);
const office = () => window.sreOffice ?? null;
const shopTime = (at) => (at ? window.sreShopDay?.dateTimeOf(at) ?? at : '');
const today = () => (window.sreShopDay?.today?.() ?? new Date().toISOString().slice(0, 10));

let secrets = null; let secretsOut = null; // head office's inventory, or why there is none
let review = null; let reviewOut = null;
let usage = null; let usageOut = null;
let revocations = null; let revocationsOut = null;
const tables = {}; // the live registers, by host id

function say(id, out, goodKey) {
  const n = $(id);
  n.dataset.result = out.result;
  n.textContent = out.result === 'ok' ? t(goodKey) : api.outcomeWords(lang, out);
}
function text(tag, words, cls) { const n = document.createElement(tag); n.textContent = words; if (cls) n.className = cls; return n; }

/** A register on the shared part; the host is emptied first so a repaint never doubles it. */
function register(hostId, opts) {
  const o = office(); const host = $(hostId);
  host.replaceChildren();
  if (!o) return;
  tables[hostId] = o.table(host, { pageSize: 10, sortable: true, ...opts });
}
function stateIn(hostId, out) {
  const o = office(); const host = $(hostId);
  host.replaceChildren();
  if (!o) return;
  o.state(host, o.stateOf(out), { detail: api.outcomeWords(lang, out) });
}
const kindWords = (k) => (t(`k_${k}`) === `k_${k}` ? k : t(`k_${k}`));
const envWords = (e) => (e === 'production' ? t('envProduction') : e === 'sandbox' ? t('envSandbox') : e);
const findingWords = (f) => (t(`f_${f}`) === `f_${f}` ? f : t(`f_${f}`));

// ── the inventory ────────────────────────────────────────────────────────────────────────────────────────────────
function paintInventory() {
  const o = office();
  $('inv-h').textContent = t('invH'); $('inv-lead').textContent = t('invLead'); $('inv-read').textContent = t('readAgain');
  $('inv-cards').replaceChildren(); $('inv-note').textContent = '';
  if (secretsOut !== null && secretsOut.result !== 'ok') { stateIn('inv-table', secretsOut); return; }
  if (secrets === null) { if (o) { $('inv-table').replaceChildren(); o.state($('inv-table'), 'loading'); } return; }
  const day = today();
  const count = (f) => secrets.filter(f).length;
  const issues = review?.issues ?? [];
  if (o) o.cards($('inv-cards'), [
    { label: pair('cardActive'), value: count((s) => s.state === 'active'), tone: 'ok', icon: 'key' },
    { label: pair('cardRotating'), value: count((s) => s.state === 'rotating'), tone: 'pending' },
    { label: pair('cardOverdue'), value: count((s) => api.dueState(s, day) === 'overdue'), tone: count((s) => api.dueState(s, day) === 'overdue') > 0 ? 'error' : 'ok' },
    { label: pair('cardDueSoon'), value: count((s) => api.dueState(s, day) === 'due_soon'), tone: 'pending' },
    { label: pair('cardRevoked'), value: count((s) => s.state === 'revoked'), tone: 'degraded' },
    { label: pair('cardBlocking'), value: review === null ? null : issues.filter((i) => i.blocking).length, tone: issues.some((i) => i.blocking) ? 'error' : 'ok' },
  ]);
  const uses = usage?.uses ?? [];
  const useOf = (s) => { const mine = uses.filter((u) => u.credentialRef === s.secretId); return mine.length === 0 ? '—' : `${mine.reduce((n, u) => n + u.calls, 0)} / ${mine.reduce((n, u) => n + u.errors, 0)}`; };
  register('inv-table', {
    id: 'secrets', label: pair('invH'),
    columns: [
      { key: 'secretId', label: pair('cSecret'), sort: 'text' },
      { key: 'kind', label: pair('cKind'), filter: true, value: (s) => kindWords(s.kind) },
      { key: 'protects', label: pair('cProtects') },
      { key: 'owner', label: pair('cOwner'), sort: 'text', value: (s) => (s.owner && s.owner.trim() !== '' ? (o?.nameOf?.('person', s.owner) ?? s.owner) : '—') },
      { key: 'environment', label: pair('cEnv'), filter: true, value: (s) => envWords(s.environment) },
      { key: 'state', label: pair('cState'), filter: true, value: (s) => t(`st_${s.state}`), render: (s) => (o ? o.recordChip(s.state === 'rotating' ? 'running' : s.state === 'superseded' ? 'archived' : s.state, t(`st_${s.state}`) === `st_${s.state}` ? s.state : t(`st_${s.state}`)) : s.state) },
      { key: 'due', label: pair('cDue'), value: (s) => api.dueWords(lang, s, day) },
      { key: 'version', label: pair('cVersion'), sort: 'number', align: 'end' },
      { key: 'rotateEveryDays', label: pair('cEvery'), sort: 'number', align: 'end', value: (s) => `${s.rotateEveryDays} ${t('days')}` },
      { key: 'lastRotatedOn', label: pair('cRotated'), value: (s) => (s.lastRotatedOn ? api.dayWords(lang, s.lastRotatedOn) : '—') },
      { key: 'createdOn', label: pair('cMade'), value: (s) => (s.createdOn ? api.dayWords(lang, s.createdOn) : '—'), hidden: true },
      { key: 'use', label: pair('cUse'), value: useOf, hidden: true },
      { key: 'vaultRef', label: pair('cRef'), hidden: true },
    ],
    rows: secrets, rowKey: (s) => s.secretId, rowData: (s) => ({ secret: s.secretId, state: s.state, due: api.dueState(s, day) }),
    empty: { title: pair('noSecrets'), detail: pair('headOfficeEnglish') },
  });
  $('inv-note').textContent = t('headOfficeEnglish');
}

// ── head office's review ─────────────────────────────────────────────────────────────────────────────────────────
function paintReview() {
  const o = office();
  $('rev-h').textContent = t('revH'); $('rev-lead').textContent = t('revLead');
  if (reviewOut !== null && reviewOut.result !== 'ok') { stateIn('rev-table', reviewOut); return; }
  if (review === null) { if (o) { $('rev-table').replaceChildren(); o.state($('rev-table'), 'loading'); } return; }
  register('rev-table', {
    id: 'review', label: pair('revH'),
    columns: [
      { key: 'secretId', label: pair('cSecret'), sort: 'text' },
      { key: 'finding', label: pair('cFinding'), filter: true, value: (i) => findingWords(i.finding), render: (i) => (o ? o.recordChip(i.blocking ? 'error' : 'warning', findingWords(i.finding)) : findingWords(i.finding)) },
      { key: 'blocking', label: pair('cBlocking'), value: (i) => (i.blocking ? t('yes') : t('no')) },
      { key: 'detail', label: pair('headOfficeEnglish'), render: (i) => { const s = text('span', i.detail); s.lang = 'en'; return s; } },
    ],
    rows: review.issues, rowKey: (i) => `${i.secretId}-${i.finding}`, rowData: (i) => ({ secret: i.secretId, finding: i.finding, blocking: String(i.blocking) }),
    empty: { title: pair('revClean'), detail: review.detail },
  });
}

// ── use over 30 days ─────────────────────────────────────────────────────────────────────────────────────────────
function paintUsage() {
  const o = office();
  $('use-h').textContent = t('useH'); $('use-lead').textContent = t('useLead'); $('unusual-h').textContent = t('unusualH');
  $('use-checked').textContent = '';
  if (usageOut !== null && usageOut.result !== 'ok') { stateIn('use-table', usageOut); $('unusual-table').replaceChildren(); return; }
  if (usage === null) { if (o) { $('use-table').replaceChildren(); o.state($('use-table'), 'loading'); } return; }
  register('use-table', {
    id: 'use', label: pair('useH'),
    columns: [
      { key: 'credentialRef', label: pair('cSecret'), sort: 'text' },
      { key: 'callerId', label: pair('cCaller'), sort: 'text', value: (u) => o?.nameOf?.('person', u.callerId) ?? u.callerId },
      { key: 'api', label: pair('cApi'), filter: true },
      { key: 'calls', label: pair('cCalls'), sort: 'number', align: 'end' },
      { key: 'errors', label: pair('cRefusedCalls'), sort: 'number', align: 'end' },
      { key: 'daysUsed', label: pair('cDays'), sort: 'number', align: 'end' },
    ],
    rows: usage.uses, rowKey: (u) => `${u.credentialRef}-${u.callerId}-${u.api}`, rowData: (u) => ({ ref: u.credentialRef, caller: u.callerId }),
    empty: { title: pair('useNone'), detail: { en: `${usage.from} – ${usage.to}`, ta: `${usage.from} – ${usage.to}` } },
  });
  $('use-checked').textContent = usage.lastRolledUpDay === null ? t('notChecked') : `${t('checkedOn')} ${api.dayWords(lang, usage.lastRolledUpDay)}${usage.notJudged.length === 0 ? '' : ` · ${t('notJudged')}: ${usage.notJudged.join(', ')}`}`;
  register('unusual-table', {
    id: 'unusual', label: pair('unusualH'),
    columns: [
      { key: 'day', label: pair('cDay'), sort: 'text', value: (f) => api.dayWords(lang, f.day) },
      { key: 'identityId', label: pair('cWho'), value: (f) => o?.nameOf?.('person', f.identityId) ?? f.identityId },
      { key: 'api', label: pair('cApi') },
      { key: 'signal', label: pair('cSignal'), filter: true, value: (f) => (t(`sig_${f.signal}`) === `sig_${f.signal}` ? f.signal : t(`sig_${f.signal}`)), render: (f) => (o ? o.recordChip('warning', t(`sig_${f.signal}`) === `sig_${f.signal}` ? f.signal : t(`sig_${f.signal}`)) : f.signal) },
      { key: 'baselineDay', label: pair('cBaseline'), value: (f) => api.dayWords(lang, f.baselineDay) },
    ],
    rows: usage.findings, rowKey: (f) => `${f.day}-${f.identityId}-${f.api}`, rowData: (f) => ({ signal: f.signal, who: f.identityId }),
    empty: { title: pair('unusualNone'), detail: pair('useLead') },
  });
}

// ── change over / revoke ─────────────────────────────────────────────────────────────────────────────────────────
function secretOptions() {
  return (secrets ?? []).filter((s) => s.state !== 'revoked').map((s) => ({ value: s.secretId, label: `${s.secretId} — ${s.protects}` }));
}
function fieldValue(id) { return $(id)?.value ?? ''; }
function paintForms() {
  const o = office();
  $('rot-h').textContent = t('rotH'); $('rot-lead').textContent = t('rotLead'); $('rot-btn').textContent = t('rotBtn');
  $('rvk-h').textContent = t('rvkH'); $('rvk-lead').textContent = t('rvkLead'); $('rvk-btn').textContent = t('rvkBtn');
  $('tok-h').textContent = t('tokH'); $('tok-lead').textContent = t('tokLead'); $('tok-btn').textContent = t('tokBtn');
  if (!o) return;
  const keep = (id) => fieldValue(id);
  const rotWhich = keep('rot-which'); const rotRef = keep('rot-ref'); const rotGrace = keep('rot-grace') || '7';
  $('rot-form').replaceChildren(
    o.field({ id: 'rot-which', label: pair('rotWhich'), type: 'select', required: true, options: secretOptions(), value: rotWhich }),
    o.field({ id: 'rot-ref', label: pair('rotRef'), type: 'text', required: true, value: rotRef, inputmode: 'url' }),
    o.field({ id: 'rot-grace', label: pair('rotGrace'), type: 'number', required: true, value: rotGrace, inputmode: 'numeric' }),
  );
  const rvkWhich = keep('rvk-which'); const rvkReason = keep('rvk-reason');
  $('rvk-form').replaceChildren(
    o.field({ id: 'rvk-which', label: pair('rotWhich'), type: 'select', required: true, options: secretOptions(), value: rvkWhich }),
    o.field({ id: 'rvk-reason', label: pair('rvkReason'), type: 'textarea', required: true, value: rvkReason }),
  );
  const tokTarget = keep('tok-target') || 'user'; const tokWho = keep('tok-who'); const tokReason = keep('tok-reason') || 'security';
  $('tok-form').replaceChildren(
    o.field({ id: 'tok-target', label: pair('tokTarget'), type: 'select', required: true, options: [{ value: 'user', label: t('tokUser') }, { value: 'token', label: t('tokOne') }], value: tokTarget }),
    o.field({ id: 'tok-who', label: pair('tokWho'), type: 'text', required: true, value: tokWho }),
    o.field({ id: 'tok-reason', label: pair('tokReason'), type: 'select', required: true, options: (api?.revocationReasons ?? []).map((r) => ({ value: r, label: t(`rr_${r}`) })), value: tokReason }),
  );
}
async function rotate() {
  const o = office(); if (!o) return;
  if (!o.check($('rot-form'))) return;
  const secretId = fieldValue('rot-which'); const grace = fieldValue('rot-grace');
  // OB-698: the consequence, in whose name, then the person's own word — before a credential moves.
  const ask = await o.confirm({ title: pair('rotConfirmTitle'), detail: { en: fill(api.words('en', 'rotConfirmDetail'), { secret: secretId, grace }), ta: fill(api.words('ta', 'rotConfirmDetail'), { secret: secretId, grace }) }, authority: pair('lead'), confirmLabel: pair('rotBtn'), tone: 'primary' });
  if (!ask.ok) return;
  const out = await session.rotate(secretId, { newVaultRef: fieldValue('rot-ref'), graceDays: grace });
  say('rot-status', out, 'rotDone');
  if (out.result === 'ok') { $('rot-ref').value = ''; await readAll(); }
}
async function revoke() {
  const o = office(); if (!o) return;
  if (!o.check($('rvk-form'))) return;
  const secretId = fieldValue('rvk-which');
  const ask = await o.confirm({ title: pair('rvkConfirmTitle'), detail: { en: fill(api.words('en', 'rvkConfirmDetail'), { secret: secretId }), ta: fill(api.words('ta', 'rvkConfirmDetail'), { secret: secretId }) }, authority: pair('lead'), confirmLabel: pair('rvkBtn'), tone: 'danger' });
  if (!ask.ok) return;
  const out = await session.revoke(secretId, fieldValue('rvk-reason'));
  say('rvk-status', out, 'rvkDone');
  $('rvk-breaks').replaceChildren();
  if (out.result !== 'ok') return;
  const breaks = out.value.willBreak ?? [];
  $('rvk-breaks').replaceChildren(...(breaks.length === 0 ? [text('li', t('nothingBreaks'))] : breaks.map((b) => text('li', `${t('willBreak')}: ${b.adapterId} (${envWords(b.environment)})`))));
  $('rvk-reason').value = '';
  await readAll();
}
async function revokeTokens() {
  const o = office(); if (!o) return;
  if (!o.check($('tok-form'))) return;
  const who = fieldValue('tok-who');
  const ask = await o.confirm({ title: pair('tokConfirmTitle'), detail: { en: fill(api.words('en', 'tokConfirmDetail'), { who }), ta: fill(api.words('ta', 'tokConfirmDetail'), { who }) }, authority: pair('lead'), confirmLabel: pair('tokBtn'), tone: 'danger' });
  if (!ask.ok) return;
  const out = await session.revokeTokens(fieldValue('tok-target'), who, fieldValue('tok-reason'));
  say('tok-status', out, 'tokDone');
  if (out.result === 'ok') { $('tok-who').value = ''; await readRevocations(); }
}

// ── sign-ins cut short ───────────────────────────────────────────────────────────────────────────────────────────
function paintRevocations() {
  const o = office();
  if (revocationsOut !== null && revocationsOut.result !== 'ok') { stateIn('tok-table', revocationsOut); return; }
  if (revocations === null) { if (o) { $('tok-table').replaceChildren(); o.state($('tok-table'), 'loading'); } return; }
  const target = (r) => (r.jti !== undefined ? `${t('tokOneToken')} ${r.jti}` : `${t('tokAllOf')} ${o?.nameOf?.('person', r.userId ?? '') ?? r.userId ?? ''}${r.issuedBefore === undefined ? '' : ` (${t('tokUpTo')} ${shopTime(new Date(r.issuedBefore * 1000).toISOString())})`}`);
  register('tok-table', {
    id: 'revocations', label: pair('tokH'),
    columns: [
      { key: 'revokedAt', label: pair('cWhen'), sort: 'text', value: (r) => shopTime(r.revokedAt) },
      { key: 'target', label: pair('cTarget'), value: target },
      { key: 'reason', label: pair('cReason'), filter: true, value: (r) => (t(`rr_${r.reason}`) === `rr_${r.reason}` ? r.reason : t(`rr_${r.reason}`)) },
      { key: 'revokedBy', label: pair('cBy'), value: (r) => o?.nameOf?.('person', r.revokedBy) ?? r.revokedBy },
    ],
    rows: revocations, rowKey: (r) => r.id, rowData: (r) => ({ reason: r.reason, who: r.userId ?? r.jti ?? '' }),
    empty: { title: pair('tokNone'), detail: pair('tokLead') },
  });
}

// ── where the other credentials live ─────────────────────────────────────────────────────────────────────────────
function paintWhere() {
  const o = office();
  $('where-h').textContent = t('whereH'); $('where-lead').textContent = t('whereLead');
  $('where-cards').replaceChildren();
  if (!o) return;
  o.cards($('where-cards'), [
    { label: pair('wPartners'), value: '→', note: pair('wPartnersNote'), href: '../partners/', icon: 'users' },
    { label: pair('wBoxes'), value: '→', note: pair('wBoxesNote'), href: '../store-computers/', icon: 'monitor' },
    { label: pair('wUsers'), value: '→', note: pair('wUsersNote'), href: '../users/', icon: 'user' },
    { label: pair('wGates'), value: '→', note: pair('wGatesNote'), href: '../gates/', icon: 'shield-check' },
  ]);
}

function paint() {
  document.title = `SRE ${t('title')}`;
  $('title-text').textContent = t('title'); $('page-h').textContent = t('title'); $('lead').textContent = t('lead');
  $('lang').textContent = t('lang');
  $('whoami').textContent = window.keysData?.userId ?? '';
  $('nobody').hidden = may.named; $('nobody').textContent = t('nobody');
  $('page-status').textContent = !may.named ? '' : !may.read && !may.revokeTokens ? t('notAllowed') : '';
  // Each section offers only what this person may do — head office re-checks every act.
  $('inv').hidden = !may.read; $('rev').hidden = !may.read; $('use').hidden = !may.read;
  $('rot').hidden = !may.write; $('rvk').hidden = !may.write;
  $('tok').hidden = !may.revokeTokens;
  paintInventory(); paintReview(); paintUsage(); paintForms(); paintRevocations(); paintWhere();
}

async function readAll() {
  if (!may.read) return;
  secrets = null; review = null; usage = null; secretsOut = null; reviewOut = null; usageOut = null;
  paint();
  const [inv, rev, use] = await Promise.all([session.inventory(), session.review(), session.usage()]);
  secretsOut = inv; reviewOut = rev; usageOut = use;
  secrets = inv.result === 'ok' ? inv.value : null;
  review = rev.result === 'ok' ? rev.value : null;
  usage = use.result === 'ok' ? use.value : null;
  paint();
}
async function readRevocations() {
  if (!may.revokeTokens) return;
  const out = await session.tokenRevocations();
  revocationsOut = out; revocations = out.result === 'ok' ? out.value : null;
  paintRevocations();
}

$('lang').addEventListener('click', () => { lang = lang === 'en' ? 'ta' : 'en'; document.documentElement.lang = lang; paint(); });
$('inv-read').addEventListener('click', () => { void readAll(); });
$('rot-btn').addEventListener('click', () => { void rotate(); });
$('rvk-btn').addEventListener('click', () => { void revoke(); });
$('tok-btn').addEventListener('click', () => { void revokeTokens(); });
document.addEventListener('sre:chrome', () => { paint(); });
paint();
if (session !== null) { void readAll(); void readRevocations(); }

if ('serviceWorker' in navigator) {
  navigator.serviceWorker.register('./sw.js').catch(() => {
    // No offline copy this time; the screen still works online.
  });
}
