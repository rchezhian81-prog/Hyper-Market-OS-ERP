// Gift cards (W3 · D07-FR-04) — the office screen over head office's stored-value routes. The session
// (apps/web-erp/src/gift-cards-session.ts, in the bundle as window.giftCards) does every call and every rule; this page lays
// out what it is told. Nothing is read or written on open: every look, issue and payment is an explicit press. Every word this
// page adds has a Tamil twin; head office's own sentences stay in English (OB-553).

const $ = (id) => document.getElementById(id);
const api = window.giftCards ?? null;
const session = api?.session ?? null;
const may = session?.may ?? { named: false, read: false, issue: false, redeem: false };
let lang = 'en';
const t = (k) => (api === null ? k : api.words(lang, k));
function text(tag, words, cls) { const n = document.createElement(tag); n.textContent = words; if (cls) n.className = cls; return n; }

let card = null;
// One press of "take the payment" is one redemption: kept until head office answers, so a second press after a lost answer
// is the SAME payment (head office answers "already taken"), never a second one.
let pendingPress = null;

function paintCard() {
  const host = $('card'); host.replaceChildren();
  if (card === null) return;
  host.dataset.card = card.instrumentId;
  host.append(text('p', `${t('balance')}: ${api.rupees(card.balanceMinor)}`, 'balance'),
    text('p', `${t('owner')} ${card.ownerRef} · ${t('expires')} ${card.expiresOn ?? t('noExpiry')}`, 'meta'),
    text('h4', t('redemptions')));
  const ul = document.createElement('ul'); ul.className = 'rows history';
  if (card.redemptions.length === 0) ul.append(text('li', t('noRedemptions'), 'meta'));
  for (const r of card.redemptions) ul.append(text('li', `${api.rupees(r.amountMinor)} · ${api.moment(r.at)}`));
  host.append(ul);
}

function paint() {
  $('title-text').textContent = t('title'); $('page-h').textContent = t('title'); $('lead').textContent = t('lead');
  document.title = `SRE ${t('title')}`;
  $('lang').textContent = lang === 'en' ? 'தமிழ்' : 'English';
  for (const [id, key] of [['look-h', 'lookH'], ['l-card-l', 'card'], ['l-look-text', 'look'], ['redeem-h', 'redeemH'], ['d-card-l', 'card'], ['d-amount-l', 'amount'], ['d-channel-l', 'channel'], ['d-redeem-text', 'redeem'],
    ['issue-h', 'issueH'], ['i-card-l', 'card'], ['i-owner-l', 'boughtBy'], ['i-value-l', 'value'], ['i-expires-l', 'expiresOn'], ['i-issue-text', 'issue']]) $(id).textContent = t(key);
  const sel = $('d-channel'); const was = sel.value;
  sel.replaceChildren(...(api?.channels ?? []).map((c) => { const o = document.createElement('option'); o.value = c; o.textContent = t(`ch_${c}`); return o; }));
  if (was !== '') sel.value = was;
  paintCard();
}

async function look(id) {
  $('look-status').textContent = t('reading');
  const out = await session.look(id);
  if (out.result === 'ok') { card = out.value; $('look-status').textContent = ''; } else { card = null; $('look-status').textContent = api.outcomeWords(lang, out); }
  paintCard();
}

$('lang').addEventListener('click', () => { lang = lang === 'en' ? 'ta' : 'en'; document.documentElement.lang = lang; paint(); });
$('look-form').addEventListener('submit', (e) => { e.preventDefault(); void look($('l-card').value); });
for (const id of ['d-card', 'd-amount']) $(id).addEventListener('input', () => { pendingPress = null; });
$('redeem-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  $('redeem-status').textContent = t('reading');
  if (pendingPress === null) pendingPress = api.newPress();
  const out = await session.redeem({ card: $('d-card').value, amount: $('d-amount').value, channel: $('d-channel').value }, pendingPress);
  if (out.result === 'lost_link') { $('redeem-status').textContent = api.outcomeWords(lang, out); return; }
  pendingPress = null;
  if (out.result !== 'ok') { $('redeem-status').textContent = api.outcomeWords(lang, out); return; }
  $('redeem-status').textContent = `${t(out.value.alreadyApplied ? 'already' : 'redeemed')} ${api.rupees(out.value.balanceMinor)}.`;
  if (may.read) { $('l-card').value = $('d-card').value; void look($('d-card').value); }
});
$('issue-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  $('issue-status').textContent = t('reading');
  const out = await session.issue({ card: $('i-card').value, boughtBy: $('i-owner').value, value: $('i-value').value, expiresOn: $('i-expires').value });
  $('issue-status').textContent = out.result === 'ok' ? `${t('issued')} ${api.rupees(out.value.balanceMinor)}.` : api.outcomeWords(lang, out);
});
paint();
if (!may.named) $('page-status').textContent = t('nobody');
else if (!may.read && !may.redeem && !may.issue) $('page-status').textContent = t('cannotRead');
else { $('look').hidden = !may.read; $('redeem').hidden = !may.redeem; $('issue').hidden = !may.issue; }
