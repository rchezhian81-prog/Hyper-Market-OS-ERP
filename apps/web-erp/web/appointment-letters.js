// Appointment letters (C17 · OB-323) — the page over head office's letter routes. The session
// (apps/web-erp/src/appointment-letters-session.ts, in the bundle as window.appointmentLetters) does every call; this
// page lays out what it is told and reads the photo of the signed copy (its bytes and SHA-256). Every word has a Tamil
// twin; every button carries an icon beside its word.

const $ = (id) => document.getElementById(id);
// ── U2b (UI/UX gap audit G5 · G14 · P-07): a thing is PICKED by name through the chrome's picker, never typed as a code,
// and a date is written as the shop writes it (dd/mm/yyyy) through the chrome's shared field. The field keeps the id the
// page sends (the typed code stays possible when the list cannot be read — head office down, no right — so the form is
// never a dead end, P-01 · P-08); the chrome's sheet finds the thing by name, code or barcode and the name is shown beside
// the field. Mounted when the chrome is there (a page that paints first listens for `sre:chrome`); off the box nothing
// changes. The same six-line pattern as the U2 pages (store-tasks, delegation, floor-heat-map).
const u2bWords = Object.freeze({ en: { choose: 'Choose…', pickProduct: 'Which product?', pickPlace: 'Which place in the store?', pickPerson: 'Which person?', pickStore: 'Which store?', pickCustomer: 'Which customer?', pickApproval: 'Which approval?', pickSupplier: 'Which supplier?', yourStore: 'your store' }, ta: { choose: 'தேர்ந்தெடு…', pickProduct: 'எந்தப் பொருள்?', pickPlace: 'கடையில் எந்த இடம்?', pickPerson: 'எந்த நபர்?', pickStore: 'எந்தக் கடை?', pickCustomer: 'எந்த வாடிக்கையாளர்?', pickApproval: 'எந்த அனுமதி?', pickSupplier: 'எந்த விநியோகஸ்தர்?', yourStore: 'உங்கள் கடை' } }); // one line on purpose: a page's own word tables start a line with `en: {`
const u2bLang = () => (document.documentElement.lang === 'ta' ? 'ta' : 'en');
const u2bWord = (k) => u2bWords[u2bLang()][k] ?? u2bWords.en[k];
const u2bRepaints = [];
const repaintPickers = () => { for (const f of u2bRepaints) f(); };
/** Mount the picker on an input the page built itself (no id needed); the id a pick gives lands in the input. */
function pickableEl(input, kind, titleKey, extra = {}) {
  if (!input || input.dataset.pickable === 'on') return;
  const office = window.sreOffice;
  if (!office || typeof office.pick !== 'function') { document.addEventListener('sre:chrome', () => pickableEl(input, kind, titleKey, extra), { once: true }); return; }
  input.dataset.pickable = 'on';
  const row = document.createElement('div'); row.className = 'pick-row';
  input.replaceWith(row); row.append(input);
  const btn = document.createElement('button'); btn.type = 'button'; if (input.id) btn.id = `${input.id}-pick`; btn.className = 'sre-btn sre-btn-quiet pick';
  const name = document.createElement('span'); if (input.id) name.id = `${input.id}-name`; name.className = 'pick-name';
  row.append(btn, name);
  const paint = () => { btn.textContent = u2bWord('choose'); btn.setAttribute('aria-label', `${u2bWord('choose')} ${u2bWord(titleKey)}`); };
  paint(); u2bRepaints.push(paint);
  btn.addEventListener('click', async () => {
    const k = typeof extra.kindOf === 'function' ? extra.kindOf() : kind;
    const tk = typeof extra.titleOf === 'function' ? extra.titleOf() : titleKey;
    const picked = await office.pick({ kind: k, title: { en: u2bWords.en[tk], ta: u2bWords.ta[tk] }, allowCode: true, ...(typeof extra.scope === 'function' ? { scope: extra.scope() } : {}), ...(typeof extra.filter === 'function' ? { filter: extra.filter } : {}) });
    if (!picked || picked.ok !== true) return;
    const id = typeof extra.idOf === 'function' ? extra.idOf(picked) : String(picked.id ?? '');
    if (typeof extra.append === 'function') extra.append(input, id); else input.value = id;
    name.textContent = typeof picked.name === 'string' && picked.name !== id ? picked.name : '';
    input.dispatchEvent(new Event('change', { bubbles: true }));
    if (typeof extra.onPick === 'function') extra.onPick(picked);
  });
  input.addEventListener('input', () => { name.textContent = ''; });
}
function pickable(inputId, kind, titleKey, extra = {}) {
  const input = document.getElementById(inputId);
  if (!input) return;
  if (!window.sreOffice || typeof window.sreOffice.pick !== 'function') { document.addEventListener('sre:chrome', () => pickable(inputId, kind, titleKey, extra), { once: true }); return; }
  pickableEl(input, kind, titleKey, extra);
}
// the pickers' words and the shared fields' labels follow the language toggle like the page's own words
new MutationObserver(() => { repaintPickers(); if (typeof repaintShopDates === 'function') repaintShopDates(); }).observe(document.documentElement, { attributes: true, attributeFilter: ['lang'] });
// ── U2b end
const api = window.appointmentLetters ?? null;
const session = api?.session ?? null;
const may = session?.may ?? { named: false, open: false, wording: false };
let lang = 'en';
const t = (k) => (api === null ? k : api.words(lang, k));

// U2 · G14 (UI/UX gap audit): a date a shop person reads — dd/mm/yyyy in the chrome's shared field (`sreOffice.dateField`),
// while the page goes on sending ISO (`dateOf`). Before the chrome has loaded, or off the box, the field stays as it was.
const wordsIn = (l, k) => (api === null ? k : api.words(l, k)); // the page's own words, for either language (null off the box)
const shopDates = new Map();
/** The shared fields' labels follow the language toggle like the page's own words do. */
function repaintShopDates() { const l = document.documentElement.lang === 'ta' ? 'ta' : 'en'; for (const [id, words] of shopDates) { const lab = $(id)?.closest('.sre-field')?.querySelector('.sre-field-label'); if (lab && lab.firstChild) lab.firstChild.textContent = words[l] ?? words.en; } }
function shopDate(id, words, opts = {}) {
  const office = window.sreOffice; const input = $(id);
  if (!office || typeof office.dateField !== 'function' || input === null || shopDates.has(id)) return;
  // a value already on the plain field is carried over — ISO as the page set it, or dd/mm/yyyy as a person typed it
  const typed = input.value.trim();
  const iso = /^\d{4}-\d{2}-\d{2}$/.test(typed) ? typed : (typeof office.parseShopDate === 'function' ? office.parseShopDate(typed) : null);
  const field = office.dateField({ id, label: words, required: opts.required === true, ...(iso ? { value: iso } : {}), ...(opts.hint ? { hint: opts.hint } : {}) });
  const ownLabel = document.querySelector(`label[for="${id}"]`);
  if (ownLabel && !ownLabel.contains(input)) ownLabel.hidden = true; // the page's own label stays (its paint still writes it); the shared field carries the visible one
  (input.closest('label') ?? input).replaceWith(field);
  shopDates.set(id, words);
}
const dateOf = (id) => (shopDates.has(id) ? (window.sreOffice.dateValue(id) ?? '') : ($(id)?.value ?? ''));
const icon = (name) => (typeof window.sreIcon === 'function' ? window.sreIcon(name, 18) : null);
function text(tag, words, cls) { const n = document.createElement(tag); n.textContent = words; if (cls) n.className = cls; return n; }
function button(words, iconName, cls) { const b = document.createElement('button'); b.classList.add('sre-btn'); b.type = 'button'; if (cls) b.className = cls; const i = icon(iconName); if (i !== null) b.append(i); b.append(text('span', words)); return b; }
const say = (id, out) => { $(id).textContent = api.outcomeWords(lang, out); };
const toBase64 = (bytes) => { let s = ''; for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000)); return btoa(s); };
const hex = (buf) => [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('');
let wording = null; let letters = null; const shown = new Map();
// W5 · OB-323: the signed copies listed for a letter, and the one photo being looked at (read live, never stored).
const scanLists = new Map(); const scanShown = new Map();
const SHOWABLE = new Set(api?.scanMediaTypes ?? ['image/jpeg', 'image/png', 'image/webp']);

function paintWording() {
  if (wording === null) return;
  $('wording-now').textContent = wording.set ? `${t('wordingV')} ${wording.wording.version} · ${t('setBy')} ${wording.wording.setBy}` : t('wordingNotSet');
  $('wording-now').dataset.set = String(wording.set);
}
function paintLetters() {
  const ul = $('letter-rows'); ul.replaceChildren();
  if (letters === null) return;
  $('awaiting').textContent = `${letters.awaitingSignedCopy} ${t('awaiting')}`;
  if (letters.letters.length === 0) ul.append(text('li', t('none')));
  for (const l of letters.letters) {
    const li = document.createElement('li'); li.dataset.letter = l.letterId; li.dataset.employee = l.employeeId;
    li.append(text('strong', `${l.employeeId} — ${l.letterId} · ${t('effective')} ${l.effectiveFrom}`));
    li.append(text('span', `${l.signedCopyKept ? `✓ ${t('signedKept')}` : `⚠ ${t('notSigned')}`} · ${t('issuedBy')} ${l.issuedBy}`, 'meta state'));
    const full = shown.get(l.letterId);
    if (full !== undefined) li.append(text('p', lang === 'ta' ? full.textTa : full.textEn, 'letter-text'));
    else {
      const s = button(t('show'), 'file-text', 'quiet'); s.dataset.act = 'show';
      s.addEventListener('click', async () => { const o = await session.letter(l.letterId); if (o.result === 'ok') shown.set(l.letterId, o.value.letter); else say('l-status', o); paintLetters(); });
      li.append(s);
    }
    const lab = document.createElement('label'); lab.append(text('span', t('scan'))); const file = document.createElement('input'); file.type = 'file'; file.accept = 'image/jpeg,image/png,image/webp'; file.setAttribute('capture', 'environment'); lab.append(file);
    const k = button(t('keep'), 'upload'); k.dataset.act = 'keep';
    k.addEventListener('click', async () => {
      const f = file.files?.[0];
      let scan = null;
      if (f) { const bytes = new Uint8Array(await f.arrayBuffer()); scan = { mediaType: f.type, contentBase64: toBase64(bytes), sha256: hex(await crypto.subtle.digest('SHA-256', bytes)) }; }
      const out = await session.keepSignedCopy(l.letterId, scan); say('l-status', out); if (out.result === 'ok') await loadLetters();
    });
    li.append(lab, k);
    if (l.scans > 0) li.append(scansNode(l));
    ul.append(li);
  }
}
function scansNode(l) {
  const box = document.createElement('div'); box.className = 'scans'; box.dataset.scansOf = l.letterId;
  const list = scanLists.get(l.letterId);
  if (list === undefined) {
    const b = button(t('showScans'), 'search', 'quiet'); b.dataset.act = 'scans';
    b.addEventListener('click', async () => { const o = await session.letter(l.letterId); if (o.result === 'ok') { scanLists.set(l.letterId, o.value.scans ?? []); if (o.value.letter) shown.set(l.letterId, o.value.letter); } else say('l-status', o); paintLetters(); });
    box.append(b); return box;
  }
  if (list.length === 0) { box.append(text('p', t('noScans'), 'meta')); return box; }
  for (const sc of list) {
    const row = document.createElement('div'); row.className = 'scan'; row.dataset.scan = sc.scanId;
    row.append(text('span', `${sc.scanId} · ${t('keptBy')} ${sc.keptBy} · ${api.moment ? api.moment(sc.keptAt) : sc.keptAt} · ${t('fingerprint')} ${sc.sha256.slice(0, 12)}…`, 'meta'));
    const got = scanShown.get(sc.scanId);
    if (got !== undefined && SHOWABLE.has(got.scan.mediaType)) {
      const img = document.createElement('img'); img.alt = t('scanAlt'); img.className = 'scan-img'; img.src = `data:${got.scan.mediaType};base64,${got.contentBase64}`; row.append(img);
    } else {
      const v = button(t('viewScan'), 'search', 'quiet'); v.dataset.act = 'view-scan';
      v.addEventListener('click', async () => { const o = await session.signedScan(l.letterId, sc.scanId); if (o.result === 'ok') scanShown.set(sc.scanId, o.value); else say('l-status', o); paintLetters(); });
      row.append(v);
    }
    box.append(row);
  }
  return box;
}
function paint() {
  repaintShopDates();
  $('title-text').textContent = t('title'); $('page-h').textContent = t('title'); $('lead').textContent = t('lead');
  $('lang').textContent = lang === 'en' ? 'தமிழ்' : 'English';
  for (const [id, key] of [['wording-h', 'wordingH'], ['fields', 'fields'], ['wd-en-l', 'bodyEn'], ['wd-ta-l', 'bodyTa'], ['wd-save-text', 'saveWording'], ['make-h', 'makeH'], ['mk-emp-l', 'employee'], ['mk-from-l', 'effectiveFrom'], ['mk-save-text', 'make'], ['list-h', 'listH']]) { const n = $(id); if (n) n.textContent = t(key); }
  paintWording(); paintLetters();
}
async function loadWording() { const o = await session.wording(); if (o.result === 'ok') wording = o.value; else say('wd-status', o); paintWording(); }
async function loadLetters() { const o = await session.letters(); if (o.result === 'ok') letters = o.value; else say('l-status', o); paintLetters(); }

for (const [id, name] of [['wd-save', 'file-text'], ['mk-save', 'list-plus']]) { const i = icon(name); if (i !== null) $(id).prepend(i); }
$('lang').addEventListener('click', () => { lang = lang === 'en' ? 'ta' : 'en'; document.documentElement.lang = lang; paint(); });
paint();
if (!may.named) $('page-status').textContent = t('nobody');
else if (!may.open) $('page-status').textContent = t('cannotRead');
else {
  $('wording').hidden = false; void loadWording();
  $('wording-form').hidden = !may.wording;
  $('wd-save').addEventListener('click', async () => { const out = await session.setWording($('wd-en').value, $('wd-ta').value); say('wd-status', out); if (out.result === 'ok') await loadWording(); });
  $('make').hidden = false;
  $('mk-save').addEventListener('click', async () => { const out = await session.make($('mk-emp').value, dateOf('mk-from')); say('mk-status', out); if (out.result === 'ok') { shown.set(out.value.letter.letterId, out.value.letter); await loadLetters(); } });
  $('list').hidden = false; void loadLetters();
}
// the chrome loads after this script: its shared date fields replace the plain ones once it is there
document.addEventListener('sre:chrome', () => { shopDate('mk-from', { en: wordsIn('en', 'effectiveFrom'), ta: wordsIn('ta', 'effectiveFrom') }); paint(); }, { once: true });

// ── U2b (G5): pick by name, never type a code
pickable('mk-emp', 'person', 'pickPerson');
