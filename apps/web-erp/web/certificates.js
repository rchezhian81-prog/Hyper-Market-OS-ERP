// Staff certificates (OB-522 · OB-502 · M25-FR-03) — the page over head office's certificate register routes. The session
// (apps/web-erp/src/certificates-session.ts, in the bundle as window.certificates) does every call and every rule; this page
// lays out what it is told. It reads head office as it opens (a GET); every write is a click. Every word has a Tamil twin;
// every button its icon.

const $ = (id) => document.getElementById(id);
const api = window.certificates ?? null;
const session = api?.session ?? null;
const may = session?.may ?? { named: false, read: false, manage: false };
let lang = 'en';
const t = (k) => (api === null ? k : api.words(lang, k));
const icon = (name) => (typeof window.sreIcon === 'function' ? window.sreIcon(name, 18) : null);
function text(tag, words, cls) { const n = document.createElement(tag); n.textContent = words; if (cls) n.className = cls; return n; }
function button(words, iconName, quiet) {
  const b = document.createElement('button'); b.type = 'button'; if (quiet) b.className = 'quiet';
  const i = icon(iconName); if (i !== null) b.append(i);
  b.append(text('span', words)); return b;
}
let loaded = null; // { today, people } as head office last answered
let lastOutcome = null; // the last load's outcome when it was not ok
let renewing = false;

const TONE = { valid: 'ok', expired: 'error', unverified: 'degraded', not_yet: 'degraded' };
const ICON = { valid: '✓', expired: '✕', unverified: '⚠', not_yet: '⚠' };
function standingWords(c) {
  if (c.standing === 'valid') return `${t('stValid')} · ${t('verifiedBy')} ${c.verifiedBy}`;
  if (c.standing === 'expired') return `${t('stExpired')} ${c.validUntil}`;
  if (c.standing === 'not_yet') return `${t('stFuture')} ${c.issuedOn}`;
  return t('stUnverified');
}

async function verifyOne(c, status) {
  const out = await session.verify(c);
  status.textContent = api.outcomeWords(lang, out, 'verify');
  if (out.result === 'ok') await load(api.outcomeWords(lang, out, 'verify'));
}
function startRenewal(c) {
  $('c-person').value = c.employeeId;
  $('c-kind').value = api.kinds.some((k) => k.kind === c.kind) ? c.kind : api.kinds[0].kind;
  $('c-issued').value = api.today(); $('c-until').value = '';
  renewing = true; $('c-renewing').hidden = false; $('c-renewing').textContent = t('renewing');
  $('c-status').textContent = '';
  $('c-until').focus();
}

function paintPeople() {
  $('people').replaceChildren();
  if (loaded === null) return;
  if (loaded.people.length === 0) { $('people').append(text('li', t('nobodyOnRoster'), 'meta')); return; }
  $('people').replaceChildren(...loaded.people.map((p) => {
    const li = document.createElement('li'); li.dataset.person = p.employeeId; li.dataset.food = p.food.allowed ? 'allowed' : 'blocked';
    li.append(text('h4', `${p.name} (${p.employeeId})`));
    const food = text('p', '', `food ${p.food.allowed ? 'allowed' : 'blocked'}`);
    food.append(text('span', p.food.allowed ? '✓' : '✕'), text('span', p.food.allowed ? `${t('foodOk')} ${p.food.validUntil}` : `${t('foodNo')} ${p.food.words[lang]}`));
    food.dataset.act = 'food';
    li.append(food);
    const certs = document.createElement('ul'); certs.className = 'certs';
    if (p.certificates.length === 0) certs.append(text('li', t('none'), 'meta'));
    for (const c of p.certificates) {
      const row = document.createElement('li'); row.className = `tone-${TONE[c.standing]}`; row.dataset.certificate = c.certificationId; row.dataset.standing = c.standing;
      row.append(text('div', `${ICON[c.standing]} ${api.kindWords(lang, c.kind)} · ${t('from')} ${c.issuedOn} ${t('to')} ${c.validUntil}`));
      row.append(text('div', standingWords(c), 'meta'));
      if (may.manage) {
        const acts = document.createElement('div'); acts.className = 'acts';
        const status = text('p', '', 'status'); status.setAttribute('role', 'status');
        if (c.standing === 'unverified' && c.employeeId !== may.me) {
          const v = button(t('verify'), 'badge-check'); v.dataset.act = 'verify';
          v.addEventListener('click', () => { void verifyOne(c, status); });
          acts.append(v);
        }
        const r = button(t('renew'), 'refresh-cw', true); r.dataset.act = 'renew';
        r.addEventListener('click', () => startRenewal(c));
        acts.append(r);
        row.append(acts, status);
      }
      certs.append(row);
    }
    li.append(certs);
    return li;
  }));
  // The person picker follows the roster head office sent.
  const sel = $('c-person'); const keep = sel.value;
  sel.replaceChildren(...loaded.people.filter((p) => p.active).map((p) => { const o = document.createElement('option'); o.value = p.employeeId; o.textContent = `${p.name} (${p.employeeId})`; return o; }));
  if (keep !== '') sel.value = keep;
}

function paint() {
  $('title-text').textContent = t('title'); $('page-h').textContent = t('title'); $('lead').textContent = t('lead');
  $('lang').textContent = lang === 'en' ? 'தமிழ்' : 'English';
  for (const [id, key] of [['record-h', 'recordH'], ['c-person-l', 'person'], ['c-kind-l', 'kind'], ['c-issued-l', 'issuedOn'], ['c-until-l', 'validUntil'],
    ['c-seen-l', 'seen'], ['c-record-text', 'record'], ['list-h', 'listH'], ['l-reload-text', 'reload']]) $(id).textContent = t(key);
  if (api !== null) {
    const sel = $('c-kind'); const keep = sel.value;
    sel.replaceChildren(...api.kinds.map((k) => { const o = document.createElement('option'); o.value = k.kind; o.textContent = k[lang]; return o; }));
    if (keep !== '') sel.value = keep;
  }
  if (renewing) $('c-renewing').textContent = t('renewing');
  if (lastOutcome !== null) $('l-status').textContent = api.outcomeWords(lang, lastOutcome);
  paintPeople();
}

async function load(said) {
  $('l-status').textContent = t('reading');
  const out = await session.load();
  if (out.result !== 'ok') { lastOutcome = out; loaded = null; paintPeople(); $('l-status').textContent = api.outcomeWords(lang, out); return; }
  lastOutcome = null; loaded = out.value; $('l-status').textContent = said ?? ''; paintPeople();
}

for (const [id, name] of [['c-record', 'check'], ['l-reload', 'refresh-cw']]) { const i = icon(name); if (i !== null) $(id).prepend(i); }
$('lang').addEventListener('click', () => { lang = lang === 'en' ? 'ta' : 'en'; document.documentElement.lang = lang; paint(); });
paint();
if (!may.named) $('page-status').textContent = t('nobody');
else if (!may.read) $('page-status').textContent = t('cannotRead');
else {
  $('list').hidden = false;
  $('l-reload').addEventListener('click', () => { void load(); });
  if (may.manage) {
    $('record').hidden = false;
    $('c-issued').value = api.today();
    $('c-record').addEventListener('click', async () => {
      const out = await session.record({ employeeId: $('c-person').value, kind: $('c-kind').value, issuedOn: $('c-issued').value, validUntil: $('c-until').value, seen: $('c-seen').checked });
      const said = api.outcomeWords(lang, out, 'record');
      $('c-status').textContent = said;
      if (out.result === 'ok') { renewing = false; $('c-renewing').hidden = true; $('c-seen').checked = false; $('c-until').value = ''; await load(); }
    });
  } else {
    $('page-status').textContent = t('cannotManage');
  }
  void load();
}
