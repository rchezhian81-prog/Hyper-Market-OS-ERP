// Morning brief — the page over head office's EA-07 read (R4 · OB-222 · signed OB-227). The session (apps/web-erp/src/
// morning-brief-session.ts, in the bundle as window.morningBrief) asks head office for today's brief; this page shows it
// and whether it was sent. Sending is switched off, so the page says "Not sent" in those words. Nothing is written on
// open. Every word has a Tamil twin.

const $ = (id) => document.getElementById(id);
const api = window.morningBrief ?? null;
const session = api?.session ?? null;
const may = session?.may ?? { named: false, read: false };

let lang = 'en';
const t = (k) => (api === null ? k : api.words(lang, k));
let brief = null;

function say(id, out) { $(id).className = 'status err'; $(id).textContent = api.outcomeWords(lang, out); }

function paint() {
  document.title = `SRE ${t('title')}`;
  for (const [id, k] of [['title-text', 'title'], ['page-h', 'title'], ['lead', 'lead'], ['show', 'show'], ['brief-h', 'briefH'], ['sent-k', 'sentK']]) $(id).textContent = t(k);
  $('lang').textContent = t('lang');
  $('whoami').textContent = window.morningBriefData?.userId ?? '';
  $('nobody').hidden = may.named; $('nobody').textContent = t('nobody');
  $('show').disabled = !may.read;
  $('brief-section').hidden = brief === null;
  if (brief === null) return;
  $('sent-v').textContent = brief.sent ? t('sent') : t('notSent');
  $('sent-detail').textContent = brief.sending === 'switched_off' ? t('switchedOff') : brief.detail;
  $('sent-detail').dataset.sending = brief.sending;
  $('lines').replaceChildren(...(brief.lines ?? []).map((l) => { const li = document.createElement('li'); li.className = 'row'; li.textContent = l; return li; }));
}

async function show() {
  const out = await session.today();
  if (out.result === 'ok') { brief = out.value; $('page-status').className = 'status'; $('page-status').textContent = ''; } else { brief = null; say('page-status', out); }
  paint();
}

$('show').addEventListener('click', () => { void show(); });
$('lang').addEventListener('click', () => { lang = lang === 'en' ? 'ta' : 'en'; document.documentElement.lang = lang; paint(); });
paint();
if (may.named && !may.read) { $('page-status').className = 'status err'; $('page-status').textContent = t('cannotRead'); }
else if (may.read) void show();

if ('serviceWorker' in navigator) {
  navigator.serviceWorker.register('./sw.js').catch(() => {
    // No offline copy this time; the screen still works online.
  });
}
