// Help and procedures — the role help centre (M25-FR-04) and emergency procedures (D11-FR-06). The session
// (apps/web-erp/src/help-session.ts, in the bundle as window.help) does every call and every save; this page lays out
// what it is told. Served by the store computer it reads the library the box holds and saves an acknowledgement on this
// screen for the box to carry (with the line down too). Every word has a Tamil twin; every button carries an icon.

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
// The signed-in person's own store filled in (changeable), its NAME said beside the field; nothing filled off the box.
const ownStores = new Set();
function ownStore(inputId) {
  ownStores.add(inputId);
  const me = window.sreOffice?.me?.() ?? null;
  const input = document.getElementById(inputId);
  if (me === null || !me.storeId || input === null) return;
  if (input.value.trim() === '') input.value = me.storeId;
  let note = document.getElementById(`${inputId}-own`);
  if (note === null) { note = document.createElement('small'); note.id = `${inputId}-own`; note.className = 'sre-why own-store'; (input.closest('.pick-row') ?? input).after(note); }
  note.textContent = `${me.storeName ?? me.storeId} — ${u2bWord('yourStore')}`;
}
// the pickers' words and the shared fields' labels follow the language toggle like the page's own words
new MutationObserver(() => { repaintPickers(); if (typeof repaintShopDates === 'function') repaintShopDates(); if (typeof ownStores !== 'undefined') for (const id of ownStores) ownStore(id); }).observe(document.documentElement, { attributes: true, attributeFilter: ['lang'] });
// ── U2b end
const api = window.help ?? null;
const session = api?.session ?? null;
const may = session?.may ?? { named: false, manage: false, contacts: false, drills: false, onBox: false };
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
let view = null; let sheets = null; let drills = null;
const pick = (en, ta) => (lang === 'ta' && ta ? ta : en);

function paintMine() {
  const box = $('sops'); box.replaceChildren();
  if (view === null) return;
  $('as-at').textContent = view.asAtWords;
  $('outstanding').textContent = `${view.outstanding} ${t('outstanding')}`;
  if (view.rows.length === 0) box.append(text('p', view.known ? t('noneForYou') : t('noLibrary')));
  for (const r of view.rows) {
    const card = document.createElement('article'); card.className = 'sop'; card.dataset.sop = r.sopId; card.dataset.category = r.category;
    card.append(text('strong', `${r.category === 'emergency' ? `⚠ ${t('emergency')}` : t('procedure')} · ${pick(r.title, r.titleTa)} (${t('version')} ${r.version})`));
    const words = pick(r.bodyEn, r.bodyTa);
    if (words !== null) card.append(text('p', words, 'words'));
    if (r.saved !== undefined) { const s = text('span', `${r.saved.stateWord}${r.saved.reason ? ` — ${r.saved.reason}` : ''}`, 'meta state'); s.dataset.state = r.saved.state; card.append(s); }
    if (r.upToDate) card.append(text('span', `✓ ${t('upToDate')}`, 'meta done'));
    else if (may.named) {
      const b = button(t('read'), 'book-open'); b.dataset.act = 'ack';
      b.addEventListener('click', async () => {
        b.disabled = true;
        const out = await session.acknowledge(r.sopId, r.version);
        say('ack-status', out);
        if (api.relay !== undefined) await api.relay.syncNow().catch(() => undefined);
        await loadMine();
      });
      card.append(b);
    }
    box.append(card);
  }
  const ul = $('contact-rows'); ul.replaceChildren();
  if (!view.contacts.set) ul.append(text('li', t('contactsNotSet')));
  for (const c of view.contacts.list) ul.append(text('li', `${c.label}: ${c.phone}`));
}
function paintSheets() {
  const ul = $('sheet-rows'); ul.replaceChildren();
  if (sheets === null) return;
  for (const s of sheets.sheets) {
    const li = document.createElement('li'); li.dataset.sheet = s.sopId;
    li.append(text('strong', `${s.sopId} — ${pick(s.title, s.titleTa)} (${t('version')} ${s.version})`));
    li.append(text('span', `${s.state === 'published' ? `✓ ${t('published')}` : s.state === 'behind_the_sheet' ? `⚠ ${t('behind')}` : t('notPublished')} · ${s.forRoles.join(', ')}`, 'meta'));
    if (s.state !== 'published') {
      const b = button(t('publish'), 'upload'); b.dataset.act = 'publish';
      b.addEventListener('click', async () => { say('sheet-status', await session.publishBuiltIn(s.sopId)); await loadSheets(); await loadMine(); });
      li.append(b);
    }
    ul.append(li);
  }
}
function paintDrills() {
  const ul = $('drill-rows'); ul.replaceChildren();
  if (drills === null) return;
  for (const p of drills.procedures) { const li = text('li', `${pick(p.title, p.titleTa)}: ${t('lastHeld')} ${p.lastHeldOn ?? t('never')}`); li.dataset.drill = p.sopId; ul.append(li); }
  // U2b: the procedure practised is picked from this list, never typed as an id
  const list = $('d-sop-list'); if (list) list.replaceChildren(...drills.procedures.map((p) => { const o = document.createElement('option'); o.value = p.sopId; o.label = pick(p.title, p.titleTa); return o; }));
}

function paint() {
  repaintShopDates();
  $('title-text').textContent = t('title'); $('page-h').textContent = t('title'); $('lead').textContent = t('lead');
  $('lang').textContent = lang === 'en' ? 'தமிழ்' : 'English';
  for (const [id, key] of [['mine-h', 'forYou'], ['contacts-h', 'contactsH'], ['manage-h', 'manageH'], ['sheets-h', 'sheetsH'], ['write-h', 'writeH'], ['w-id-l', 'sopId'], ['w-version-l', 'versionL'], ['w-cat-l', 'category'], ['w-cat-p', 'procedure'], ['w-cat-e', 'emergency'], ['w-title-l', 'titleEn'], ['w-title-ta-l', 'titleTa'], ['w-roles-l', 'roles'], ['w-en-l', 'bodyEn'], ['w-ta-l', 'bodyTa'], ['w-save-text', 'save'],
    ['sc-h', 'contactsSet'], ['sc-lines-l', 'contactLine'], ['sc-save-text', 'contactsSet'], ['drill-h', 'drillH'], ['d-sop-l', 'drillSop'], ['d-branch-l', 'branch'], ['d-on-l', 'heldOn'], ['d-who-l', 'participants'], ['d-found-l', 'findings'], ['d-save-text', 'record']]) { const n = $(id); if (n) n.textContent = t(key); }
  paintMine(); paintSheets(); paintDrills();
}
async function loadMine() { const o = await session.view(lang); if (o.result === 'ok') { view = o.value; $('page-status').textContent = ''; } else say('page-status', o); paintMine(); }
async function loadSheets() { const o = await session.builtIn(); if (o.result === 'ok') sheets = o.value; else say('sheet-status', o); paintSheets(); }
async function loadDrills() { const o = await session.drills(); if (o.result === 'ok') drills = o.value; else say('d-status', o); paintDrills(); }

for (const [id, name] of [['w-save', 'file-text'], ['sc-save', 'shield-check'], ['d-save', 'clipboard-check']]) { const i = icon(name); if (i !== null) $(id).prepend(i); }
$('lang').addEventListener('click', () => { lang = lang === 'en' ? 'ta' : 'en'; document.documentElement.lang = lang; paint(); void loadMine(); });
paint();
if (session === null) $('page-status').textContent = t('nobody');
else {
  if (!may.named) $('page-status').textContent = t('nobody');
  if (may.named || may.onBox) { $('mine').hidden = false; $('contacts').hidden = false; void loadMine(); }
  if (may.manage) {
    $('manage').hidden = false; void loadSheets();
    $('w-save').addEventListener('click', async () => {
      const out = await session.write({ sopId: $('w-id').value, title: $('w-title').value, titleTa: $('w-title-ta').value, version: $('w-version').value, roles: $('w-roles').value, category: $('w-cat').value, bodyEn: $('w-en').value, bodyTa: $('w-ta').value });
      say('w-status', out); if (out.result === 'ok') await loadMine();
    });
  }
  if (may.contacts) {
    $('set-contacts').hidden = false;
    $('sc-save').addEventListener('click', async () => { const out = await session.setContacts($('sc-lines').value); say('sc-status', out); if (out.result === 'ok') await loadMine(); });
  }
  if (may.drills) {
    $('drills').hidden = false; void loadDrills();
    $('d-save').addEventListener('click', async () => {
      const out = await session.recordDrill({ sopId: $('d-sop').value, branchId: $('d-branch').value, heldOn: dateOf('d-on'), participants: $('d-who').value, findings: $('d-found').value });
      say('d-status', out); if (out.result === 'ok') await loadDrills();
    });
  }
}
// the chrome loads after this script: its shared date fields replace the plain ones once it is there
document.addEventListener('sre:chrome', () => { shopDate('d-on', { en: wordsIn('en', 'heldOn'), ta: wordsIn('ta', 'heldOn') }); paint(); }, { once: true });

// ── U2b (G5): pick by name, never type a code
pickable('d-branch', 'store', 'pickStore');
ownStore('d-branch');
document.addEventListener('sre:chrome', () => ownStore('d-branch'), { once: true });
pickable('d-who', 'person', 'pickPerson', { append: (input, id) => { const have = input.value.trim(); input.value = have === '' ? id : `${have.replace(/,\s*$/, '')}, ${id}`; } });
// the roles a procedure is for, from the roles the store computer knows (the typed list stays the fallback)
(function roleList() {
  const list = $('w-roles-list'); const d = window.sreDirectory; if (!list || !d) return;
  const roles = new Set([...(Array.isArray(d.people) ? d.people.map((p) => p.roleId) : []), ...(Array.isArray(d.me?.roleIds) ? d.me.roleIds : [])].filter((r) => typeof r === 'string' && r !== ''));
  list.replaceChildren(...[...roles].map((r) => { const o = document.createElement('option'); o.value = r; return o; }));
})();
