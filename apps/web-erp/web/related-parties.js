// Related parties and staff buying — the page over head office's related-party list, staff-buying rules, staff accounts
// and salary accounts (M15-FR-03 · OB-301). The session (apps/web-erp/src/related-parties-session.ts, in the bundle as
// window.relatedParties) does every call; this page lays out what it is told. Each section shows only to a person whose
// role may use it; nothing is read before the page opens a section the person may see, and every save is a click.
// Every word has a Tamil twin; every button carries an icon beside its word.

const $ = (id) => document.getElementById(id);
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
  if (parties.parties.length === 0) ul.append(text('li', t('listEmpty')));
  for (const p of parties.parties) {
    const li = document.createElement('li'); li.dataset.party = p.partyId;
    li.append(text('strong', `${p.name} — ${p.relation}${p.active ? '' : ` (${t('inactive')})`}`));
    li.append(text('span', [p.kind === 'firm' ? t('firm') : t('person'), ...p.gstins, ...p.phones, ...p.bankAccountRefs].join(' · '), 'meta'));
    if (p.active) {
      const why = document.createElement('label'); why.append(text('span', t('takeOffWhy'))); const reason = document.createElement('input'); reason.autocomplete = 'off'; reason.className = 'take-off-why'; why.append(reason);
      const off = document.createElement('button'); off.className = 'quiet'; off.type = 'button'; off.dataset.act = 'take-off'; const i = icon('x'); if (i !== null) off.append(i); off.append(text('span', t('takeOff')));
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
