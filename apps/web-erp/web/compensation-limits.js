// Compensation limits (W3 · M21-FR-03) — the page over head office's compensation authority limits. The session
// (apps/web-erp/src/compensation-limits-session.ts, in the bundle as window.compensationLimits) does every call and every
// rule; this page lays out what it is told. It reads as it opens; saving is an explicit press. Every word this page adds has a
// Tamil twin; head office's own sentences stay in English (OB-553).

const $ = (id) => document.getElementById(id);
const api = window.compensationLimits ?? null;
const session = api?.session ?? null;
const may = session?.may ?? { named: false, read: false, set: false };
let lang = 'en';
const t = (k) => (api === null ? k : api.words(lang, k));
let limits = null;

function paintLimits() {
  if (limits === null) { $('now-limits').textContent = ''; $('now-source').textContent = ''; return; }
  $('now-limits').textContent = `${t('agent')} ${api.rupees(limits.agentAuthorityMinor)} · ${t('ceiling')} ${api.rupees(limits.deskCeilingMinor)}`;
  $('now-source').textContent = limits.isStandard ? t('standard') : t('shopsOwn');
  $('now').dataset.standard = String(limits.isStandard);
}

function paint() {
  $('title-text').textContent = t('title'); $('page-h').textContent = t('title'); $('lead').textContent = t('lead');
  document.title = `SRE ${t('title')}`;
  $('lang').textContent = lang === 'en' ? 'தமிழ்' : 'English';
  for (const [id, key] of [['now-h', 'nowH'], ['set-h', 'setH'], ['s-agent-l', 'agent'], ['s-ceiling-l', 'ceiling'], ['s-save-text', 'save']]) $(id).textContent = t(key);
  paintLimits();
}

async function load() {
  $('now-status').textContent = t('reading');
  const out = await session.limits();
  if (out.result === 'ok') { limits = out.value; $('now-status').textContent = ''; } else { limits = null; $('now-status').textContent = api.outcomeWords(lang, out); }
  paintLimits();
}

$('lang').addEventListener('click', () => { lang = lang === 'en' ? 'ta' : 'en'; document.documentElement.lang = lang; paint(); });
$('set-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  $('set-status').textContent = t('reading');
  const out = await session.save({ agent: $('s-agent').value, ceiling: $('s-ceiling').value });
  if (out.result === 'ok') { limits = out.value; $('set-status').textContent = t('saved'); paintLimits(); } else $('set-status').textContent = api.outcomeWords(lang, out);
});
paint();
if (!may.named) $('page-status').textContent = t('nobody');
else if (!may.read) $('page-status').textContent = t('cannotRead');
else { $('now').hidden = false; if (may.set) $('set').hidden = false; else $('page-status').textContent = t('cannotSet'); void load(); }
