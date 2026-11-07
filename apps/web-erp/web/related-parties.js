// Related parties and staff buying — the page over head office's related-party list, staff-buying rules, staff accounts
// and salary accounts (M15-FR-03 · OB-301). The session (apps/web-erp/src/related-parties-session.ts, in the bundle as
// window.relatedParties) does every call; this page lays out what it is told. Each section shows only to a person whose
// role may use it; nothing is read before the page opens a section the person may see, and every save is a click.
// Every word has a Tamil twin; every button carries an icon beside its word.

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
// the pickers' words follow the language toggle like the page's own words
new MutationObserver(() => { repaintPickers(); }).observe(document.documentElement, { attributes: true, attributeFilter: ['lang'] });
// ── U2b end
const api = window.relatedParties ?? null;
const session = api?.session ?? null;
const may = session?.may ?? { named: false, open: false, parties: false, policy: false, staffAccounts: false, salary: false };
let lang = 'en';
const t = (k) => (api === null ? k : api.words(lang, k));
const icon = (name) => (typeof window.sreIcon === 'function' ? window.sreIcon(name, 18) : null);
function text(tag, words, cls) { const n = document.createElement(tag); n.textContent = words; if (cls) n.className = cls; return n; }
const say = (id, out) => { $(id).textContent = api.outcomeWords(lang, out); };
let parties = null; let policy = null; let accounts = null; let salary = null;

function paintParties() {
  const ul = $('p-rows'); ul.replaceChildren();
  if (parties === null) return;
  // U2b: a NEW entry's code is given by the page (the next free number), never invented
  if ($('p-id').value.trim() === '') $('p-id').value = `RP-${parties.parties.length + 1}`;
  if (parties.parties.length === 0) ul.append(text('li', t('listEmpty')));
  for (const p of parties.parties) {
    const li = document.createElement('li'); li.dataset.party = p.partyId;
    li.append(text('strong', `${p.name} — ${p.relation}${p.active ? '' : ` (${t('inactive')})`}`));
    li.append(text('span', [p.kind === 'firm' ? t('firm') : t('person'), ...p.gstins, ...p.phones, ...p.bankAccountRefs].join(' · '), 'meta'));
    if (p.active) {
      const why = document.createElement('label'); why.append(text('span', t('takeOffWhy'))); const reason = document.createElement('input'); reason.autocomplete = 'off'; reason.className = 'take-off-why'; why.append(reason);
      const off = document.createElement('button'); off.className = 'quiet sre-btn sre-btn-quiet'; off.type = 'button'; off.dataset.act = 'take-off'; const i = icon('x'); if (i !== null) off.append(i); off.append(text('span', t('takeOff')));
      off.addEventListener('click', async () => { const out = await session.takeOff(p.partyId, reason.value); say('p-status', out); if (out.result === 'ok') await loadParties(); });
      li.append(why, off);
    }
    ul.append(li);
  }
  const m = $('m-rows'); m.replaceChildren();
  if (parties.supplierMatches.length === 0) m.append(text('li', t('matchesNone')));
  for (const s of parties.supplierMatches) {
    const li = document.createElement('li'); li.dataset.supplier = s.supplierId;
    li.append(text('strong', `⚠ ${s.supplierId}${s.name === null ? '' : ` — ${s.name}`}`));
    for (const x of s.matches) li.append(text('span', `${t(`on_${x.on}`)} ${x.shown} → ${x.partyName} (${x.relation})`, 'meta'));
    m.append(li);
  }
}
function paintPolicy() {
  if (policy === null) return;
  const cap = policy.staffDiscountCapBps === null ? t('notSet') : `${Number((policy.staffDiscountCapBps / 100).toFixed(2))}%`;
  const desk = policy.serviceDeskLaneIds === null ? t('notSet') : policy.serviceDeskLaneIds.join(', ');
  $('s-now').textContent = `${t('policyNow')} ${t('cap')}: ${cap} · ${t('desk')}: ${desk}`;
}
function paintAccounts() {
  const ul = $('a-rows'); ul.replaceChildren();
  if (accounts === null) return;
  if (accounts.accounts.length === 0) ul.append(text('li', t('accountsNone')));
  for (const a of accounts.accounts) ul.append(text('li', `${a.employeeId} — ${a.customerRef}`));
}
function paintSalary() {
  const ul = $('w-rows'); ul.replaceChildren();
  if (salary === null) return;
  if (salary.accounts.length === 0) ul.append(text('li', t('salaryNone')));
  for (const a of salary.accounts) ul.append(text('li', `${a.employeeId} — ${a.account} (${a.recordedBy})`));
}

function paint() {
  $('title-text').textContent = t('title'); $('page-h').textContent = t('title'); $('lead').textContent = t('lead');
  $('lang').textContent = lang === 'en' ? 'தமிழ்' : 'English';
  for (const [id, key] of [['parties-h', 'partiesH'], ['p-id-l', 'partyId'], ['p-name-l', 'name'], ['p-kind-l', 'kind'], ['p-kind-firm', 'firm'], ['p-kind-person', 'person'], ['p-relation-l', 'relation'], ['p-gstins-l', 'gstins'], ['p-phones-l', 'phones'], ['p-accounts-l', 'accounts'], ['p-save-text', 'saveParty'], ['m-h', 'matchesH'],
    ['staff-h', 'staffH'], ['s-cap-l', 'cap'], ['s-desk-l', 'desk'], ['s-save-text', 'savePolicy'], ['a-h', 'accountsH'], ['a-emp-l', 'employee'], ['a-ref-l', 'customerRef'], ['a-save-text', 'saveAccount'],
    ['salary-h', 'salaryH'], ['w-emp-l', 'employee'], ['w-ref-l', 'accountRef'], ['w-save-text', 'saveSalary']]) $(id).textContent = t(key);
  paintParties(); paintPolicy(); paintAccounts(); paintSalary();
}

async function loadParties() { const o = await session.readParties(); if (o.result === 'ok') parties = o.value; else say('p-status', o); paintParties(); }
async function loadPolicy() { const o = await session.readPolicy(); if (o.result === 'ok') policy = o.value; else say('s-status', o); paintPolicy(); }
async function loadAccounts() { const o = await session.readStaffAccounts(); if (o.result === 'ok') accounts = o.value; else say('a-status', o); paintAccounts(); }
async function loadSalary() { const o = await session.readSalary(); if (o.result === 'ok') salary = o.value; else say('w-status', o); paintSalary(); }

for (const [id, name] of [['p-save', 'shield-check'], ['s-save', 'percent'], ['a-save', 'user-round'], ['w-save', 'landmark']]) { const i = icon(name); if (i !== null) $(id).prepend(i); }
$('lang').addEventListener('click', () => { lang = lang === 'en' ? 'ta' : 'en'; document.documentElement.lang = lang; paint(); });
paint();
if (!may.named) { $('page-status').textContent = t('nobody'); }
else if (!may.open) { $('page-status').textContent = t('cannotRead'); }
else {
  if (may.parties) {
    $('parties').hidden = false; void loadParties();
    $('p-save').addEventListener('click', async () => {
      const out = await session.saveParty({ partyId: $('p-id').value, name: $('p-name').value, kind: $('p-kind').value, relation: $('p-relation').value, gstins: $('p-gstins').value, phones: $('p-phones').value, accounts: $('p-accounts').value });
      say('p-status', out); if (out.result === 'ok') await loadParties();
    });
  }
  $('staff').hidden = false; void loadPolicy();
  $('s-form').hidden = !may.policy; $('s-save').hidden = !may.policy;
  $('s-save').addEventListener('click', async () => { const out = await session.savePolicy({ capPercent: $('s-cap').value, desks: $('s-desk').value }); say('s-status', out); if (out.result === 'ok') await loadPolicy(); });
  void loadAccounts();
  $('a-form').hidden = !may.staffAccounts; $('a-save').hidden = !may.staffAccounts;
  $('a-save').addEventListener('click', async () => { const out = await session.saveStaffAccount({ employeeId: $('a-emp').value, customerRef: $('a-ref').value }); say('a-status', out); if (out.result === 'ok') await loadAccounts(); });
  if (may.salary) {
    $('salary').hidden = false; void loadSalary();
    $('w-save').addEventListener('click', async () => { const out = await session.saveSalary({ employeeId: $('w-emp').value, accountRef: $('w-ref').value }); say('w-status', out); if (out.result === 'ok') await loadSalary(); });
  }
}

// ── U2b (G5): pick by name, never type a code
pickable('a-emp', 'person', 'pickPerson');
pickable('w-emp', 'person', 'pickPerson');
pickable('a-ref', 'customer', 'pickCustomer');
