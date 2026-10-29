// Loyalty — the service desk's enrolment (OB-329), the member look-up, the app tie, and the owner's programme settings
// (OB-295). The session (apps/web-erp/src/loyalty-desk-session.ts, in the bundle as window.loyaltyDesk) asks head office;
// this page shows its answers. The phone number goes in a request body only. The name is optional and a skipped one
// stays "not on record". Tiers and expiry read "not set" until the owner enters them; the CA's note stands beside
// expiry. Every state is an icon AND words; every word has a Tamil twin.

// OB-606: a moment is shown on the SHOP's date (its zone, as the store computer told the page) — never this device's own date.
const shopDayOf = (value) => window.sreShopDay?.dateOf(value) ?? '';
const $ = (id) => document.getElementById(id);
const api = window.loyaltyDesk ?? null;
const session = api?.session ?? null;
const may = session?.may ?? { named: false, enrol: false, read: false, configure: false, runExpiry: false };

let lang = 'en';
const t = (k) => (api === null ? k : api.words(lang, k));
let notice = null;
let programme = null;
let found = null;
let tierDrafts = [];

const icon = (name) => (typeof window.sreIcon === 'function' ? window.sreIcon(name, 18) : null);
for (const [id, name] of [['enrol', 'user-round'], ['find', 'search'], ['confirm', 'monitor-smartphone'], ['link', 'monitor-smartphone'], ['add-tier', 'list-plus'], ['save-tiers', 'check'], ['save-expiry', 'calendar-clock'], ['run-expiry', 'refresh-cw'], ['save-referral', 'users']]) {
  const i = icon(name); if (i !== null) $(id).prepend(i);
}

function text(tag, words, cls) { const n = document.createElement(tag); n.textContent = words; if (cls) n.className = cls; return n; }
function bad(where, out) { $(where).className = 'status err'; $(where).textContent = `⚠ ${api.outcomeWords(lang, out)}`; }
function good(where, words) { $(where).className = 'status good'; $(where).textContent = `✓ ${words}`; }
const said = (pair) => (pair === undefined || pair === null ? '' : pair[lang] ?? pair.en);

// ── Enrol (OB-329) ───────────────────────────────────────────────────────────────────────────────────────────────────
function paintNotice() {
  $('notice-h').textContent = t('noticeH');
  if (notice === null) { $('notice-text').textContent = ''; $('notice-draft').hidden = true; $('notice-version').textContent = ''; return; }
  $('notice-text').textContent = notice[lang] ?? notice.en;
  $('notice-draft').hidden = notice.status !== 'draft_for_owner_signature';
  $('notice-draft').textContent = `⚠ ${t('draft')}`;
  $('notice-version').textContent = `${t('noticeVersion')} ${notice.version}`;
}
async function enrol() {
  const out = await session.enrol({ mobile: $('enrol-mobile').value, name: $('enrol-name').value, saidYes: $('enrol-yes').checked, seenOnPhone: $('enrol-seen').checked });
  if (out.result !== 'ok') { bad('enrol-status', out); return; }
  const v = out.value;
  if (v.alreadyMember) good('enrol-status', `${t('alreadyMember')} ${v.mobileLast4}`);
  else good('enrol-status', `${t('enrolled')} ${v.mobileLast4}. ${v.name ? t('nameKept') : t('nameSkipped')}`);
  $('enrol-status').dataset.last4 = v.mobileLast4;
  for (const id of ['enrol-mobile', 'enrol-name']) $(id).value = '';
  for (const id of ['enrol-yes', 'enrol-seen']) $(id).checked = false;
}

// ── Find a member ───────────────────────────────────────────────────────────────────────────────────────────────────
function paintFound() {
  if (found === null || !found.member) $('confirm-phone').hidden = true;
  if (found === null) { $('found').replaceChildren(); return; }
  if (!found.member) { $('found').replaceChildren(text('li', `○ ${t('notMember')}`, 'row')); return; }
  const s = found.standing;
  const li = document.createElement('li');
  li.className = 'row tone-ok';
  li.dataset.member = s.memberRef;
  li.append(text('strong', `✓ ${t('member')} ${s.mobileLast4} — ${s.pointsBalance} ${t('points')}`));
  const facts = document.createElement('div'); facts.className = 'facts';
  facts.append(text('span', `${t('spend')}: ${api.rupees(s.spend12mMinor)}`, 'spend'));
  const tierLine = s.tiers.state === 'not_set' ? `○ ${t('tiersNotSet')}`
    : s.tier === null ? `○ ${t('noTier')}` : `★ ${t('tier')}: ${lang === 'ta' && s.tier.nameTa ? s.tier.nameTa : s.tier.name} (${t('multiplier')}${api.multiplierWords(s.multiplierBps)})`;
  facts.append(text('span', tierLine, 'tier'));
  if (s.nextTier) facts.append(text('span', `↑ ${api.rupees(s.nextTier.moreSpendMinor)} ${t('more')} ${t('nextTier')} ${s.nextTier.name}`, 'next'));
  const exp = s.expiry.state === 'not_set' ? `○ ${t('expiryNotSet')}`
    : s.expiry.next ? `⏱ ${t('nextExpiry')}: ${s.expiry.next.points} ${t('points')} ${t('on')} ${shopDayOf(s.expiry.next.expiresAt)}` : `✓ ${t('nothingToExpire')}`;
  facts.append(text('span', exp, 'expiry'));
  li.append(facts);
  $('found').replaceChildren(li);
  // OB-364: a member carried from the old system — the desk confirms the number on the customer's own phone.
  const box = $('confirm-phone');
  box.hidden = !(found.phoneToConfirm === true && may.enrol);
  if (found.phoneToConfirm === true) li.append(text('span', `⚠ ${t('toConfirm')}`, 'facts to-confirm'));
}
async function confirmPhone() {
  const out = await session.confirmPhone($('find-mobile').value, $('confirm-seen').checked);
  if (out.result !== 'ok') { bad('confirm-status', out); return; }
  good('confirm-status', `${t('confirmed')} ${out.value.mobileLast4}`);
  $('confirm-seen').checked = false;
  if (found !== null && found.member) { found = { ...found, phoneToConfirm: false }; paintFound(); $('confirm-phone').hidden = true; }
}
async function find() {
  const out = await session.find($('find-mobile').value);
  if (out.result !== 'ok') { found = null; bad('find-status', out); paintFound(); return; }
  found = out.value; $('find-status').className = 'status'; $('find-status').textContent = '';
  paintFound();
}

async function link() {
  const out = await session.link($('link-mobile').value, $('link-ref').value, $('link-seen').checked);
  if (out.result !== 'ok') { bad('link-status', out); return; }
  good('link-status', `${t('linked')} (${out.value.mobileLast4})`);
}

// ── The programme (OB-295) ──────────────────────────────────────────────────────────────────────────────────────────
function tierRow(d, index) {
  const row = document.createElement('div');
  row.className = 'tier-row';
  row.dataset.index = String(index);
  const field = (key, cls, value, mode) => {
    const label = document.createElement('label');
    const input = document.createElement('input');
    input.className = cls; input.value = value; input.autocomplete = 'off';
    if (mode) input.inputMode = mode;
    input.disabled = !may.configure;
    input.addEventListener('input', () => { tierDrafts[index] = { ...tierDrafts[index], [key]: input.value }; });
    label.append(text('span', t({ name: 'tierName', nameTa: 'tierNameTa', spendRupees: 'tierSpend', multiplier: 'tierMultiplier' }[key])), input);
    return label;
  };
  row.append(field('name', 'tier-name', d.name), field('nameTa', 'tier-name-ta', d.nameTa ?? ''), field('spendRupees', 'tier-spend', d.spendRupees, 'decimal'), field('multiplier', 'tier-multiplier', d.multiplier, 'decimal'));
  if (may.configure) {
    const rm = document.createElement('button'); rm.type = 'button'; rm.className = 'quiet remove-tier';
    const i = icon('trash'); if (i !== null) rm.append(i);
    rm.append(text('span', t('removeTier')));
    rm.addEventListener('click', () => { tierDrafts.splice(index, 1); paintTierRows(); });
    row.append(rm);
  }
  return row;
}
function paintTierRows() { $('tier-rows').replaceChildren(...tierDrafts.map(tierRow)); }
function draftsFrom(p) {
  tierDrafts = p.tiers.tiers.map((x) => ({ name: x.name, nameTa: x.nameTa ?? '', spendRupees: String(x.minSpend12mMinor / 100), multiplier: api.multiplierWords(x.multiplierBps) }));
}
function lastSet(last) { return last === null ? '' : ` · ${t('lastSet')} ${last.setBy} ${shopDayOf(last.setAt)}: ${last.reason}`; }
function paintProgramme() {
  $('owner-only').hidden = may.configure || !may.read; $('owner-only').textContent = `○ ${t('ownerOnly')}`;
  for (const id of ['add-tier', 'save-tiers', 'save-expiry', 'tiers-reason', 'expiry-reason', 'expiry-months']) $(id).disabled = !may.configure;
  $('run-expiry').disabled = !may.runExpiry;
  if (programme === null) return;
  const tiersSet = programme.tiers.state === 'set';
  $('tiers-say').className = `status ${tiersSet ? 'good' : ''}`;
  $('tiers-say').dataset.state = programme.tiers.state;
  $('tiers-say').textContent = `${tiersSet ? '✓' : '○'} ${said(programme.tiers.say)}${lastSet(programme.tiers.last)}`;
  const expirySet = programme.expiry.state === 'set';
  $('expiry-say').className = `status ${expirySet ? 'good' : ''}`;
  $('expiry-say').dataset.state = programme.expiry.state;
  $('expiry-say').textContent = `${expirySet ? '✓' : '○'} ${said(programme.expiry.say)}${lastSet(programme.expiry.last)}`;
  $('ca-text').textContent = said(programme.accountingNote);
}
async function loadProgramme() {
  const out = await session.programme();
  if (out.result !== 'ok') { bad('page-status', out); return; }
  programme = out.value;
  draftsFrom(programme);
  $('expiry-months').value = programme.expiry.months === null ? '' : String(programme.expiry.months);
  paintProgramme(); paintTierRows();
}
async function saveTiers() {
  const out = await session.saveTiers(tierDrafts, $('tiers-reason').value);
  if (out.result !== 'ok') { bad('tiers-status', out); return; }
  programme = out.value; draftsFrom(programme);
  good('tiers-status', out.value.unchanged ? t('unchanged') : t('saved'));
  $('tiers-reason').value = '';
  paintProgramme(); paintTierRows();
}
async function saveExpiry() {
  const out = await session.saveExpiry($('expiry-months').value, $('expiry-reason').value);
  if (out.result !== 'ok') { bad('expiry-status', out); return; }
  programme = out.value;
  good('expiry-status', out.value.unchanged ? t('unchanged') : t('saved'));
  $('expiry-reason').value = '';
  paintProgramme();
}
async function runExpiry() {
  const out = await session.runExpiry();
  if (out.result !== 'ok') { bad('expiry-status', out); return; }
  $('expiry-status').className = `status ${out.value.on ? 'good' : ''}`;
  $('expiry-status').textContent = `${out.value.on ? '✓' : '○'} ${t('expiredSay')} ${out.value.detail}`;
}

// ── Referral rewards (OB-351) ───────────────────────────────────────────────────────────────────────────────────────
let referral = null;
function paintReferral() {
  for (const id of ['referrer-rupees', 'referred-rupees', 'referral-reason', 'save-referral']) $(id).disabled = !may.configure;
  if (referral === null) { $('referral-say').textContent = ''; return; }
  const side = (r) => (r.state === 'set' ? api.rupees(r.amountMinor) : t('rewardNotSet'));
  const both = referral.referrer.state === 'set' && referral.referred.state === 'set';
  $('referral-say').className = `status ${both ? 'good' : ''}`;
  $('referral-say').dataset.referrer = referral.referrer.state; $('referral-say').dataset.referred = referral.referred.state;
  $('referral-say').textContent = `${both ? '✓' : '○'} ${t('referrerL').replace(' (₹)', '')}: ${side(referral.referrer)} · ${t('referredL').replace(' (₹)', '')}: ${side(referral.referred)}${referral.lastSetBy ? ` · ${t('lastSet')} ${referral.lastSetBy} ${shopDayOf(referral.lastSetAt)}: ${referral.lastReason}` : ''}`;
}
async function loadReferral() {
  const out = await session.referralRewards();
  if (out.result !== 'ok') { bad('referral-status', out); return; }
  referral = out.value; paintReferral();
}
async function saveReferral() {
  const out = await session.saveReferralRewards($('referrer-rupees').value, $('referred-rupees').value, $('referral-reason').value);
  if (out.result !== 'ok') { bad('referral-status', out); return; }
  referral = out.value; good('referral-status', t('saved'));
  for (const id of ['referrer-rupees', 'referred-rupees', 'referral-reason']) $(id).value = '';
  paintReferral();
}

// ── Paint ───────────────────────────────────────────────────────────────────────────────────────────────────────────
function paint() {
  document.title = `SRE ${t('title')}`;
  for (const [id, k] of [['title-text', 'title'], ['page-h', 'title'], ['lead', 'lead'], ['enrol-h', 'enrolH'], ['l-enrol-mobile', 'mobile'], ['l-enrol-name', 'name'], ['l-enrol-yes', 'saidYes'], ['l-enrol-seen', 'seen'], ['enrol-text', 'enrol'],
    ['find-h', 'findH'], ['l-find-mobile', 'mobile'], ['find-text', 'find'], ['confirm-h', 'confirmH'], ['confirm-lead', 'confirmLead'], ['l-confirm-seen', 'confirmSeen'], ['confirm-text', 'confirm'], ['link-h', 'linkH'], ['l-link-mobile', 'mobile'], ['l-link-ref', 'appRef'], ['l-link-seen', 'seen'], ['link-text', 'link'],
    ['programme-h', 'programmeH'], ['tiers-h', 'tiersH'], ['add-tier-text', 'addTier'], ['l-tiers-reason', 'reason'], ['save-tiers-text', 'saveTiers'], ['expiry-h', 'expiryH'], ['ca-h', 'caH'],
    ['l-expiry-months', 'months'], ['l-expiry-reason', 'reason'], ['save-expiry-text', 'saveExpiry'], ['run-expiry-text', 'runExpiry'],
    ['referral-h', 'referralH'], ['referral-lead', 'referralLead'], ['l-referrer-rupees', 'referrerL'], ['l-referred-rupees', 'referredL'], ['l-referral-reason', 'reason'], ['save-referral-text', 'saveReferral']]) $(id).textContent = t(k);
  $('lang').textContent = t('lang');
  $('whoami').textContent = window.loyaltyDeskData?.userId ?? '';
  $('nobody').hidden = may.named; $('nobody').textContent = t('nobody');
  for (const id of ['enrol', 'link', 'enrol-mobile', 'enrol-name', 'enrol-yes', 'enrol-seen', 'link-mobile', 'link-ref', 'link-seen']) $(id).disabled = !may.enrol;
  for (const id of ['find', 'find-mobile']) $(id).disabled = !may.read;
  paintNotice(); paintFound(); paintProgramme(); paintTierRows(); paintReferral();
}

$('enrol').addEventListener('click', () => { void enrol(); });
$('find').addEventListener('click', () => { void find(); });
$('confirm').addEventListener('click', () => { void confirmPhone(); });
$('link').addEventListener('click', () => { void link(); });
$('add-tier').addEventListener('click', () => { tierDrafts.push({ name: '', nameTa: '', spendRupees: '', multiplier: '' }); paintTierRows(); });
$('save-tiers').addEventListener('click', () => { void saveTiers(); });
$('save-expiry').addEventListener('click', () => { void saveExpiry(); });
$('run-expiry').addEventListener('click', () => { void runExpiry(); });
$('save-referral').addEventListener('click', () => { void saveReferral(); });
$('lang').addEventListener('click', () => { lang = lang === 'en' ? 'ta' : 'en'; document.documentElement.lang = lang; paint(); });
paint();
if (may.named && !may.read && !may.enrol) { $('page-status').className = 'status err'; $('page-status').textContent = `⚠ ${t('cannotRead')}`; }
if (may.enrol) void session.notice().then((out) => { if (out.result === 'ok') { notice = out.value; paintNotice(); } else bad('enrol-status', out); });
if (may.read) { void loadProgramme(); void loadReferral(); }

if ('serviceWorker' in navigator) {
  navigator.serviceWorker.register('./sw.js').catch(() => {
    // No offline copy this time; the screen still works online.
  });
}
