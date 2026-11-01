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
let answeredAt = null;
// UI-3: the brief's source line and its cards (window.sreOffice) — the page's own words for them, in both languages.
const UI3 = {
  en: { covers: 'Trading day {day} · head office answered at {time}', notTold: 'not told', prepared: 'Prepared', sent: 'Sent to the phone', lines: 'Lines in the brief', yes: 'Yes', no: 'No', fromFigures: 'from the governed figures, no AI', notPrepared: 'head office has not prepared it' },
  ta: { covers: 'வணிக நாள் {day} · தலைமை அலுவலகம் பதிலளித்த நேரம் {time}', notTold: 'சொல்லப்படவில்லை', prepared: 'தயாரானது', sent: 'ஃபோனுக்கு அனுப்பப்பட்டது', lines: 'சுருக்கத்தில் உள்ள வரிகள்', yes: 'ஆம்', no: 'இல்லை', fromFigures: 'நிர்வகிக்கப்பட்ட எண்களிலிருந்து, AI இல்லை', notPrepared: 'தலைமை அலுவலகம் இதைத் தயாரிக்கவில்லை' },
};
const u3 = (k) => UI3[lang][k] ?? UI3.en[k];
function paintUi3() {
  if (brief === null) return;
  const time = answeredAt === null ? u3('notTold') : window.sreShopDay?.dateTimeOf(answeredAt) ?? answeredAt;
  $('brief-covers').textContent = u3('covers').split('{day}').join(brief.tradingDay ?? u3('notTold')).split('{time}').join(time);
  const o = window.sreOffice;
  if (!o) return;
  o.cards($('brief-cards'), [
    { label: u3('prepared'), value: brief.prepared ? u3('yes') : u3('no'), note: brief.prepared ? u3('fromFigures') : u3('notPrepared'), tone: brief.prepared ? 'ok' : 'pending', icon: 'file-text' },
    // A brief head office did not prepare has no lines to count — "Not known", never 0.
    { label: u3('lines'), value: brief.lines === undefined ? null : brief.lines.length, icon: 'list' },
  ]);
}
document.addEventListener('sre:chrome', () => { paintUi3(); });

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
  paintUi3();
  $('lines').replaceChildren(...(brief.lines ?? []).map((l) => { const li = document.createElement('li'); li.className = 'row'; li.textContent = l; return li; }));
}

async function show() {
  const out = await session.today();
  if (out.result === 'ok') { brief = out.value; answeredAt = new Date().toISOString(); $('page-status').className = 'status'; $('page-status').textContent = ''; } else { brief = null; say('page-status', out); }
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
