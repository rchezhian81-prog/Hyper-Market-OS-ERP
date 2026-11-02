// Shelf compliance by bay — the page over head office's D-13 routes. The session (apps/web-erp/src/planogram-bays-session.ts,
// in the bundle as window.planogramBays) asks head office; this page only shows its answer: each bay's score over the
// facings staff counted, every gap named, the bay's photos, and that image recognition is switched off (no photo leaves the
// shop). A photo is read on this device and sent only to head office, only on the explicit "Keep this photo" click.
// Every word has a Tamil twin (in the session's copy).

const $ = (id) => document.getElementById(id);
const api = window.planogramBays ?? null;
const session = api?.session ?? null;
const may = session?.may ?? { named: false, read: false, record: false };

let lang = 'en';
const t = (k) => (api === null ? k : api.words(lang, k));
let view = null;

function bayRow(b) {
  const li = document.createElement('li');
  li.className = `row tone-${b.score.kind === 'scored' && b.score.bp === 10_000 ? 'ok' : b.score.kind === 'scored' ? 'degraded' : 'idle'}`;
  li.dataset.bay = b.bayKey;
  li.dataset.scored = String(b.score.kind === 'scored');
  const head = document.createElement('div'); head.className = 'head';
  const name = document.createElement('span'); name.textContent = b.bayKey;
  const score = document.createElement('span'); score.className = 'score'; score.textContent = `${t('score')}: ${api.scoreWords(lang, b)}`;
  head.append(name, score);
  const gaps = document.createElement('div'); gaps.className = 'facts gaps';
  gaps.textContent = b.gaps.length === 0 ? t('noGaps') : b.gaps.map((g) => `${g.productId} (${g.locationId}): ${g.words}`).join(' · ');
  const photos = document.createElement('div'); photos.className = 'facts photos';
  photos.textContent = `${t('photos')}: ${b.photos.length}`;
  li.append(head, gaps, photos);
  return li;
}


// U2 · G5 (UI/UX gap audit): the signed-in person's own store is filled in from the store computer (`sreOffice.me`) —
// the id stays what the page sends, the store's NAME is said beside it, and a person who may hold more than one store can
// still change it. Off the box, or before the chrome has loaded, nothing is filled in.
function ownStore(inputId) {
  const me = window.sreOffice?.me?.() ?? null;
  const input = $(inputId);
  if (me === null || !me.storeId || input === null) return;
  if (input.value.trim() === '') input.value = me.storeId;
  let note = document.getElementById(`${inputId}-own`);
  if (note === null) { note = document.createElement('small'); note.id = `${inputId}-own`; note.className = 'sre-why own-store'; input.after(note); }
  note.textContent = `${me.storeName ?? me.storeId} — ${t('yourStore')}`;
}
function paint() {
  ownStore('store');
  document.title = `SRE ${t('title')}`;
  for (const [id, k] of [['title-text', 'title'], ['page-h', 'title'], ['lead', 'lead'], ['l-store', 'store'], ['show', 'show'], ['photo-h', 'photoH'], ['l-bay', 'bay'], ['l-photo', 'photo'], ['keep', 'keep']]) $(id).textContent = t(k);
  $('lang').textContent = t('lang');
  $('whoami').textContent = window.planogramBaysData?.userId ?? '';
  $('nobody').hidden = may.named; $('nobody').textContent = t('nobody');
  $('show').disabled = !may.read; whyDisabled($('show'), may.read ? '' : 'role');
  $('bays-section').hidden = view === null;
  $('photo-section').hidden = view === null || !may.record;
  if (view === null) return;
  $('bays-h').textContent = `${view.storeId} · ${view.planogramId} v${view.planogramVersion}`;
  $('measured').textContent = t('measuredBy');
  $('recognition').dataset.state = view.recognition.state;
  $('recognition').textContent = view.recognition.state === 'switched_off' ? t('recognitionOff') : view.recognition.detail;
  $('bays').replaceChildren(...view.bays.map(bayRow));
  const select = $('photo-bay');
  const was = select.value;
  select.replaceChildren(...view.bays.map((b) => { const o = document.createElement('option'); o.value = b.bayKey; o.textContent = b.bayKey; o.dataset.aisle = String(b.aisle); o.dataset.rack = String(b.rack); o.dataset.bay = String(b.bay); return o; }));
  if ([...select.options].some((o) => o.value === was)) select.value = was;
}

async function show(event) {
  event?.preventDefault();
  const out = await session.bays($('store').value);
  if (out.result === 'ok') { view = out.value; $('page-status').className = 'status'; $('page-status').textContent = ''; }
  else { view = null; $('page-status').className = 'status err'; $('page-status').textContent = api.outcomeWords(lang, out); }
  paint();
}

/** Read the chosen file on this device as base64 — nothing leaves it until "Keep this photo". */
function readFile(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => { const s = String(reader.result ?? ''); resolve(s.slice(s.indexOf(',') + 1)); };
    reader.onerror = () => { reject(reader.error); };
    reader.readAsDataURL(file);
  });
}

async function keep() {
  const file = $('photo-file').files?.[0];
  const opt = $('photo-bay').selectedOptions[0];
  const say = (text, good) => { $('photo-status').className = `status ${good ? 'good' : 'err'}`; $('photo-status').textContent = text; };
  if (file === undefined || opt === undefined || view === null) { say(t('needAll'), false); return; }
  const contentBase64 = await readFile(file);
  const out = await session.keepPhoto({ storeId: view.storeId, aisle: Number(opt.dataset.aisle), rack: Number(opt.dataset.rack), bay: Number(opt.dataset.bay), mediaType: file.type, bytes: file.size, contentBase64 });
  if (out.result === 'ok') { say(t('kept'), true); $('photo-file').value = ''; await show(); } else say(api.outcomeWords(lang, out), false);
}

$('ask').addEventListener('submit', (e) => { void show(e); });
$('keep').addEventListener('click', () => { void keep(); });
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
// the chrome (and `sreOffice.me`) loads after this script: fill the store in once it is there
document.addEventListener('sre:chrome', () => { paint(); }, { once: true });
