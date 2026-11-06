// Document retention (W3 · M31-FR-01) — the page over head office's retention reads and its disposal act. The session
// (apps/web-erp/src/document-retention-session.ts, in the bundle as window.documentRetention) does every call and every
// rule; this page lays out what it is told. It reads as it opens; recording a disposal is an explicit press with a reason,
// offered only on a document head office proposes. Every word this page adds has a Tamil twin; head office's own sentences
// stay in English (OB-553).

const $ = (id) => document.getElementById(id);
const api = window.documentRetention ?? null;
const session = api?.session ?? null;
const may = session?.may ?? { named: false, read: false, dispose: false };
let lang = 'en';
const t = (k) => (api === null ? k : api.words(lang, k));
function text(tag, words, cls) { const n = document.createElement(tag); n.textContent = words; if (cls) n.className = cls; return n; }

let docs = null; let tpls = null;

function paintDocs() {
  $('docs').replaceChildren(); $('docs-sum').textContent = '';
  if (docs === null) return;
  $('docs-sum').textContent = `${t('today')} ${docs.today} · ${docs.proposed} ${t('proposed')} · ${docs.disposedCount} ${t('disposedCount')}`;
  if (docs.plan.length === 0) $('docs').append(text('li', t('noDocs'), 'meta'));
  for (const d of docs.plan) {
    const li = document.createElement('li'); li.dataset.document = d.documentId; li.dataset.action = d.action;
    li.append(text('h4', `${d.documentId} · ${d.kind.replace(/_/g, ' ')} — ${t(d.action)}`), text('p', d.reason, 'meta'));
    if (d.action === 'propose_disposal' && may.dispose) {
      const form = document.createElement('form'); form.className = 'acts';
      const l = document.createElement('label'); const id = `why-${d.documentId}`; l.htmlFor = id; l.append(text('span', t('reason')));
      const why = document.createElement('input'); why.id = id; why.autocomplete = 'off'; why.maxLength = 500; l.append(why);
      const status = text('p', '', 'status'); status.setAttribute('role', 'status');
      const b = document.createElement('button'); b.type = 'submit'; b.className = 'quiet sre-btn sre-btn-quiet'; b.textContent = t('dispose');
      form.append(l, b, status);
      form.addEventListener('submit', async (e) => {
        e.preventDefault();
        status.textContent = t('reading');
        const out = await session.dispose(d.documentId, why.value);
        status.textContent = out.result === 'ok' ? t('disposed') : api.outcomeWords(lang, out);
        if (out.result === 'ok') { $('docs-status').textContent = t('disposed'); void load(); }
      });
      li.append(form);
    }
    $('docs').append(li);
  }
}

function paintTemplates() {
  $('tpls').replaceChildren();
  if (tpls === null) return;
  if (tpls.length === 0) $('tpls').append(text('li', t('noTemplates'), 'meta'));
  for (const v of tpls) {
    const li = document.createElement('li'); li.dataset.template = `${v.templateId}@${v.version}`;
    li.append(text('p', `${v.templateId} v${v.version} — ${v.disposable ? t('disposable') : t('mustKeep')} · ${v.detail}`, 'meta'));
    $('tpls').append(li);
  }
}

function paint() {
  document.title = `SRE ${t('title')}`;
  $('title-text').textContent = t('title'); $('page-h').textContent = t('title'); $('lead').textContent = t('lead');
  $('lang').textContent = lang === 'en' ? 'தமிழ்' : 'English';
  $('docs-h').textContent = t('docsH'); $('tpl-h').textContent = t('templatesH');
  paintDocs(); paintTemplates();
}

async function load() {
  $('tpl-status').textContent = t('reading');
  const [d, v] = await Promise.all([session.documents(), session.templates()]);
  if (d.result === 'ok') docs = d.value; else { docs = null; $('docs-status').textContent = api.outcomeWords(lang, d); }
  if (v.result === 'ok') { tpls = v.value; $('tpl-status').textContent = ''; } else { tpls = null; $('tpl-status').textContent = api.outcomeWords(lang, v); }
  paintDocs(); paintTemplates();
}

$('lang').addEventListener('click', () => { lang = lang === 'en' ? 'ta' : 'en'; document.documentElement.lang = lang; paint(); });
paint();
if (!may.named) $('page-status').textContent = t('nobody');
else if (!may.read) $('page-status').textContent = t('cannotRead');
else { $('docs-s').hidden = false; $('tpl-s').hidden = false; if (!may.dispose) $('page-status').textContent = t('cannotDispose'); void load(); }
