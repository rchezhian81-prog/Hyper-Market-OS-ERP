// Settings and their history (Round 4c · M01-FR-03) — the page over head office's versioned settings. The session
// (apps/web-erp/src/settings-session.ts, in the bundle as window.settings) does every call and every rule; this page lays out
// what it is told. It reads as it opens; going back is an explicit press with a reason. Every word this page adds has a Tamil
// twin; head office's own sentences stay in English (OB-553).

const $ = (id) => document.getElementById(id);
const api = window.settings ?? null;
const session = api?.session ?? null;
const may = session?.may ?? { named: false, read: false, write: false };
let lang = 'en';
const t = (k) => (api === null ? k : api.words(lang, k));
function text(tag, words, cls) { const n = document.createElement(tag); n.textContent = words; if (cls) n.className = cls; return n; }
function button(words, cls, onClick) { const b = document.createElement('button'); b.classList.add('sre-btn'); b.type = 'button'; b.className = cls; b.textContent = words; b.addEventListener('click', onClick); return b; }

let settings = null;
const open = new Map(); // key -> versions shown
const asked = new Map(); // `${key}:${version}` -> { requestId, ask }
// What the last "put back" on a version said: kept across the reload that follows it, so the person always sees it.
const said = new Map(); // `${key}:${version}` -> words

function versionNode(s, v) {
  const li = document.createElement('li'); li.dataset.version = String(v.version);
  li.append(text('p', `${t('version')} ${v.version}: ${api.valueWords(v.value)}`),
    text('p', `${t('by')} ${v.author} · ${t('at')} ${session.moment(v.at)} · ${t('why')}: ${v.reason}${v.rolledBackFrom === null ? '' : ` · ${t('restoredFrom')} ${v.rolledBackFrom}`}`, 'meta'));
  if (may.write && v.version !== s.version) {
    const status = text('p', said.get(`${s.key}:${v.version}`) ?? '', 'status'); status.setAttribute('role', 'status');
    const l = document.createElement('label'); const id = `why-${s.key}-${v.version}`; l.htmlFor = id; l.append(text('span', t('reason')));
    const why = document.createElement('input'); why.id = id; why.autocomplete = 'off'; l.append(why);
    const acts = document.createElement('div'); acts.className = 'acts';
    const tag = `${s.key}:${v.version}`;
    const goBack = async (approvalId) => {
      status.textContent = t('reading');
      const out = await session.goBack(s.key, v.version, asked.get(tag)?.ask.reason ?? why.value, s.version, approvalId);
      if (out.result !== 'ok') { status.textContent = api.outcomeWords(lang, out); return; }
      if (out.value.kind === 'needs_owner') {
        status.textContent = t('needsOwner');
        acts.append(button(t('askOwner'), 'quiet', async () => {
          const a = await session.askOwner(out.value.ask);
          if (a.result !== 'ok') { status.textContent = api.outcomeWords(lang, a); return; }
          asked.set(tag, { requestId: a.value.requestId, ask: out.value.ask });
          status.textContent = t('asked');
          acts.append(button(t('sendApproved'), 'quiet', async () => {
            const st = await session.approvalOf(a.value.requestId);
            if (st.result !== 'ok') { status.textContent = api.outcomeWords(lang, st); return; }
            if (st.value !== 'approved') { status.textContent = t('waiting'); return; }
            await goBack(a.value.requestId);
          }));
        }));
        return;
      }
      status.textContent = t('restored').replace('{v}', String(out.value.version));
      said.set(tag, status.textContent);
      void load();
    };
    acts.append(l, button(t('goBack'), 'quiet', () => { void goBack(undefined); }));
    li.append(acts, status);
  }
  return li;
}

function paint() {
  $('title-text').textContent = t('title'); $('page-h').textContent = t('title'); $('lead').textContent = t('lead');
  document.title = `SRE ${t('title')}`;
  $('lang').textContent = lang === 'en' ? 'தமிழ்' : 'English';
  $('list-h').textContent = t('listH');
  const ul = $('rows'); ul.replaceChildren();
  if (settings === null) return;
  for (const s of settings) {
    const li = document.createElement('li'); li.dataset.key = s.key; if (!s.isDefault) li.className = 'answered';
    const head = document.createElement('div'); head.className = 'head';
    head.append(text('h4', s.label), text('span', `${t('inForce')}: ${api.valueWords(s.value)}${s.isDefault ? ` (${t('onDefault')})` : ` · ${t('version')} ${s.version}`}`, 'meta'));
    li.append(head);
    const versions = open.get(s.key);
    li.append(button(versions === undefined ? t('history') : t('hide'), 'quiet', async () => {
      if (open.has(s.key)) { open.delete(s.key); paint(); return; }
      const out = await session.history(s.key);
      if (out.result !== 'ok') { $('list-status').textContent = api.outcomeWords(lang, out); return; }
      open.set(s.key, out.value); paint();
    }));
    if (versions !== undefined) {
      if (versions.length === 0) li.append(text('p', t('noHistory'), 'meta'));
      else { const vs = document.createElement('ul'); vs.className = 'versions'; vs.replaceChildren(...versions.map((v) => versionNode(s, v))); li.append(vs); }
    }
    ul.append(li);
  }
}

async function load() {
  $('list-status').textContent = t('reading');
  const out = await session.settings();
  if (out.result !== 'ok') { settings = null; $('list-status').textContent = api.outcomeWords(lang, out); paint(); return; }
  settings = out.value; $('list-status').textContent = '';
  for (const key of [...open.keys()]) { const h = await session.history(key); if (h.result === 'ok') open.set(key, h.value); }
  paint();
}

$('lang').addEventListener('click', () => { lang = lang === 'en' ? 'ta' : 'en'; document.documentElement.lang = lang; paint(); });
paint();
if (!may.named) $('page-status').textContent = t('nobody');
else if (!may.read) $('page-status').textContent = t('cannotRead');
else { $('list').hidden = false; if (!may.write) $('page-status').textContent = t('cannotWrite'); void load(); }
