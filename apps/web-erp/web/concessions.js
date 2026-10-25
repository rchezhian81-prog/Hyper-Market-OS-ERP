// Concessions — the page over head office's concession contracts, deposits, charge, settlement and expiry alerts
// (M27-FR-01..04 · OB-288 package 3 · OB-304). The session (apps/web-erp/src/concession-session.ts, in the bundle as
// window.concessions) does every call; this page lays out what it is told. With the feature switched off it says so and
// shows nothing else. Every write is a click; every word has a Tamil twin; every button carries an icon beside its word.

const $ = (id) => document.getElementById(id);
const api = window.concessions ?? null;
const session = api?.session ?? null;
const may = session?.may ?? { named: false, read: false, manage: false };
let lang = 'en';
const t = (k) => (api === null ? k : api.words(lang, k));
const money = (minor) => (api === null ? String(minor) : api.rupees(minor));
const icon = (name) => (typeof window.sreIcon === 'function' ? window.sreIcon(name, 18) : null);
function text(tag, words, cls) { const n = document.createElement(tag); n.textContent = words; if (cls) n.className = cls; return n; }
function button(words, iconName, act, quiet) { const b = document.createElement('button'); b.type = 'button'; if (quiet) b.className = 'quiet'; if (act) b.dataset.act = act; const i = icon(iconName); if (i !== null) b.append(i); b.append(text('span', words)); return b; }
const say = (id, out) => { $(id).textContent = api.outcomeWords(lang, out); };
let counters = null; let asked = []; let off = false;

function alertWords(a) { return `${t(`doc_${a.document}`)} ${a.on === '' ? t('notOnRecord') : a.on} — ${t(`level_${a.level}`)}`; }
function paintCounters() {
  const ul = $('c-rows'); ul.replaceChildren();
  if (counters === null) return;
  if (counters.contracts.length === 0) ul.append(text('li', t('countersNone')));
  for (const row of counters.contracts) {
    const c = row.contract; const tr = row.trading;
    const li = document.createElement('li'); li.dataset.contract = c.contractId;
    li.append(text('strong', `${c.name} (${c.contractId}) — ${tr.mayTrade ? `✓ ${t('mayTrade')}` : `⚠ ${t('cannotTrade')}`}`));
    li.append(text('span', `${c.concessionaireId} · ${c.branchId} · ${c.startsOn} → ${c.endsOn} · ${t(`basis_${c.basis}`)}${c.approvedBy ? ` · ${t('approvedBy')} ${c.approvedBy}` : ''}`, 'meta'));
    if (!tr.mayTrade) li.append(text('span', tr.blockedBy.map((b) => t(`blocked_${b}`)).join(' · '), 'meta'));
    if (row.deposit) li.append(text('span', `${t('depositHeld')}: ${money(row.deposit.outstandingLiabilityMinor)}`, 'meta'));
    for (const a of row.alerts) { const s = text('span', `⚠ ${alertWords(a)}`, 'meta'); s.dataset.alert = a.alertId; li.append(s); }
    ul.append(li);
  }
  const pick = $('m-contract'); const was = pick.value; pick.replaceChildren();
  for (const row of counters.contracts) { const o = document.createElement('option'); o.value = row.contract.contractId; o.textContent = `${row.contract.name} (${row.contract.contractId})`; pick.append(o); }
  if (was !== '') pick.value = was;
}
function paintAsked() {
  const ul = $('c-asked'); ul.replaceChildren();
  for (const r of asked) {
    if (r.status === 'used') continue;
    const li = document.createElement('li'); li.dataset.asked = r.requestId;
    li.append(text('strong', `${t('askedFor')}: ${r.subjectRef} — ${r.status}`));
    if (r.decidedBy) li.append(text('span', `${r.status === 'rejected' ? t('rejectedBy') : t('approvedBy')} ${r.decidedBy}${r.decisionReason ? ` — ${r.decisionReason}` : ''}`, 'meta'));
    if (r.status === 'approved' && may.manage) {
      const go = button(t('putInForce'), 'shield-check', 'put-in-force');
      go.addEventListener('click', async () => { const out = r.kind === 'concession_contract' ? await session.putInForce(r) : await session.forfeitWithApproval(r); say('c-status', out); if (out.result === 'ok') await load(); });
      li.append(go);
    }
    ul.append(li);
  }
}
function fig(label, value) { const d = document.createElement('div'); d.append(text('span', label, 'meta'), text('strong', value)); return d; }

function paint() {
  $('title-text').textContent = t('title'); $('page-h').textContent = t('title'); $('lead').textContent = t('lead');
  $('lang').textContent = lang === 'en' ? 'தமிழ்' : 'English';
  for (const [id, key] of [['counters-h', 'countersH'], ['raise-text', 'raise'], ['contract-h', 'contractH'], ['f-id-l', 'contractId'], ['f-who-l', 'concessionaire'], ['f-name-l', 'name'], ['f-branch-l', 'branch'], ['f-start-l', 'startsOn'], ['f-end-l', 'endsOn'],
    ['f-basis-l', 'basis'], ['f-basis-rent', 'basis_fixed_rent'], ['f-basis-share', 'basis_revenue_share'], ['f-basis-higher', 'basis_higher_of_both'], ['f-rent-l', 'rent'], ['f-share-l', 'share'], ['f-util-l', 'utilities'], ['f-deposit-l', 'deposit'], ['f-ins-l', 'insurance'], ['f-lic-l', 'licence'],
    ['f-save-text', 'save'], ['f-ask-text', 'askApproval'], ['deposit-h', 'depositH'], ['d-who-l', 'concessionaire'], ['d-kind-l', 'movement'], ['d-kind-in', 'received'], ['d-kind-out', 'refunded'], ['d-kind-forfeit', 'forfeited'], ['d-amount-l', 'amount'], ['d-save-text', 'recordDeposit'],
    ['money-h', 'chargeH'], ['m-contract-l', 'contractPick'], ['m-from-l', 'from'], ['m-to-l', 'to'], ['m-metered-l', 'metered'], ['m-banked-l', 'banked'], ['m-charge-text', 'readCharge'], ['m-settle-text', 'readSettlement']]) $(id).textContent = t(key);
  if (off) $('page-status').textContent = t('off');
  paintCounters(); paintAsked();
}

async function load() {
  const o = await session.readCounters();
  if (o.result === 'refused' && o.code === 'feature_not_entitled') {
    off = true; $('page-status').textContent = t('off');
    for (const id of ['counters', 'contract', 'deposit', 'money']) $(id).hidden = true;
    return;
  }
  if (o.result !== 'ok') { say('page-status', o); return; }
  off = false; counters = o.value;
  $('counters').hidden = false; $('money').hidden = false;
  $('contract').hidden = !may.manage; $('deposit').hidden = !may.manage; $('raise').hidden = !may.manage;
  const a = await session.readMyRequests(); if (a.result === 'ok') asked = a.value;
  paintCounters(); paintAsked();
}
const form = () => ({ contractId: $('f-id').value, concessionaireId: $('f-who').value, name: $('f-name').value, branchId: $('f-branch').value, startsOn: $('f-start').value, endsOn: $('f-end').value, basis: $('f-basis').value,
  rentRupees: $('f-rent').value, sharePercent: $('f-share').value, utilitiesRupees: $('f-util').value, depositRupees: $('f-deposit').value, insuranceUntil: $('f-ins').value, licenceUntil: $('f-lic').value });

for (const [id, name] of [['raise', 'send'], ['f-save', 'file-text'], ['f-ask', 'hand'], ['d-save', 'banknote'], ['m-charge', 'calculator'], ['m-settle', 'scale']]) { const i = icon(name); if (i !== null) $(id).prepend(i); }
$('lang').addEventListener('click', () => { lang = lang === 'en' ? 'ta' : 'en'; document.documentElement.lang = lang; paint(); });
paint();
if (!may.named) { $('page-status').textContent = t('nobody'); }
else if (!may.read) { $('page-status').textContent = t('cannotRead'); }
else {
  void load();
  $('raise').addEventListener('click', async () => { const o = await session.raiseAlerts(); if (o.result === 'ok') $('c-status').textContent = `${o.value.raised} ${t('raised')} ${o.value.alreadyOpen}`; else say('c-status', o); });
  $('f-save').addEventListener('click', async () => { const o = await session.saveContract(form()); say('f-status', o); if (o.result === 'ok') { $('f-id').value = o.value.contractId; await load(); } });
  $('f-ask').addEventListener('click', async () => {
    const f = form();
    if (f.contractId.trim() === '') { const s = await session.saveContract(f); if (s.result !== 'ok') { say('f-status', s); return; } $('f-id').value = s.value.contractId; f.contractId = s.value.contractId; }
    const o = await session.askContractApproval(f); say('f-status', o); if (o.result === 'ok') await load();
  });
  $('d-save').addEventListener('click', async () => {
    const kind = $('d-kind').value;
    const o = kind === 'forfeited' ? await session.askForfeit($('d-who').value, $('d-amount').value) : await session.recordDeposit($('d-who').value, kind, $('d-amount').value);
    say('d-status', o); if (o.result === 'ok') await load();
  });
  const figs = (o, keys) => { const box = $('m-figs'); box.replaceChildren(); if (o.result !== 'ok') { say('m-status', o); return; } $('m-status').textContent = ''; for (const [label, key, isMoney] of keys) if (o.value[key] !== undefined) box.append(fig(t(label), isMoney ? money(o.value[key]) : o.value[key] ? t('reconciles') : `⚠ ${t('doesNot')}`)); };
  $('m-charge').addEventListener('click', async () => figs(await session.readCharge($('m-contract').value, $('m-from').value, $('m-to').value, $('m-metered').value), [['gross', 'grossSalesMinor', true], ['charge', 'chargeMinor', true], ['totalDue', 'totalDueMinor', true]]));
  $('m-settle').addEventListener('click', async () => figs(await session.readSettlement($('m-contract').value, $('m-from').value, $('m-to').value, $('m-banked').value), [['collected', 'collectedForThemMinor', true], ['charge', 'chargeMinor', true], ['payable', 'payableToThemMinor', true], ['difference', 'differenceMinor', true], ['reconciles', 'reconciles', false]]));
}
