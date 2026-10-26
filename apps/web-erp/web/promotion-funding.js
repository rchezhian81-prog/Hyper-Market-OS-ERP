// Supplier offer funding (M05-FR-04 · QG-02) — the page over head office's own funding record. The session
// (apps/web-erp/src/promotion-funding-session.ts, in the bundle as window.promotionFunding) does every call; this page lays
// out what it is told. Nothing is read on open; every write is a click. Every word has a Tamil twin; every button its icon.

const $ = (id) => document.getElementById(id);
const api = window.promotionFunding ?? null;
const session = api?.session ?? null;
const may = session?.may ?? { named: false, read: false, record: false, receipt: false };
let lang = 'en';
const t = (k) => (api === null ? k : api.words(lang, k));
const icon = (name) => (typeof window.sreIcon === 'function' ? window.sreIcon(name, 18) : null);
function text(tag, words, cls) { const n = document.createElement(tag); n.textContent = words; if (cls) n.className = cls; return n; }
const say = (id, out) => { $(id).textContent = api.outcomeWords(lang, out); };
let reg = null;

function paintRegister() {
  const ul = $('register-rows'); ul.replaceChildren();
  $('r-totals').textContent = ''; $('r-from').textContent = '';
  if (reg === null) return;
  $('r-totals').textContent = `${t('totals')}: ${t('earned')} ${api.rupees(reg.earnedMinor)} · ${t('received')} ${api.rupees(reg.receivedMinor)} · ${t('ledger')} ${api.rupees(reg.ledgerMinor)} · ${reg.agrees ? `✓ ${t('agrees')}` : `⚠ ${t('differs')}`} · ${reg.needingAttention} ${t('attention')}`;
  $('r-from').textContent = reg.incomeAccount === null ? `⚠ ${t('noIncome')}` : t('unitsFrom');
  if (reg.lines.length === 0) ul.append(text('li', `○ ${t('none')}`));
  for (const l of reg.lines) {
    const li = document.createElement('li'); li.dataset.offer = l.promotionId; li.dataset.supplier = l.supplierId;
    if (l.findings.length > 0) li.className = 'attention';
    li.append(text('strong', `${t('offer')} ${l.promotionId} · ${t('supplier')} ${l.supplierId} · ${api.rupees(l.perUnitMinor)} ${t('rate')} · ${l.capMinor === null ? t('noCap') : `${t('cap')} ${api.rupees(l.capMinor)}`}`));
    li.append(text('span', `${t('units')}: ${l.unitsSold} · ${t('earned')} ${api.rupees(l.earnedMinor)} · ${t('received')} ${api.rupees(l.receivedMinor)} · ${t('ledger')} ${api.rupees(l.ledgerMinor)} · ${t('outstanding')} ${api.rupees(l.outstandingMinor)}`, 'figures'));
    for (const f of l.findings) li.append(text('span', `⚠ ${t(`f_${f}`)}`, 'finding'));
    if (l.findings.length === 0) li.append(text('span', `✓ ${t('agrees')}`, 'meta'));
    ul.append(li);
  }
}
function paint() {
  $('title-text').textContent = t('title'); $('page-h').textContent = t('title'); $('lead').textContent = t('lead');
  $('lang').textContent = lang === 'en' ? 'தமிழ்' : 'English';
  for (const [id, key] of [['register-h', 'registerH'], ['r-show-text', 'show'], ['agree-h', 'agreeH'], ['a-offer-l', 'offerId'], ['a-supplier-l', 'supplierId'], ['a-rate-l', 'perUnit'], ['a-cap-l', 'capRs'],
    ['a-products-l', 'products'], ['a-approval-l', 'approvalId'], ['a-record-text', 'record'], ['receipt-h', 'receiptH'], ['c-offer-l', 'offerId'], ['c-supplier-l', 'supplierId'], ['c-amount-l', 'amount'],
    ['c-on-l', 'receivedOn'], ['c-ref-l', 'reference'], ['c-record-text', 'recordReceipt']]) $(id).textContent = t(key);
  paintRegister();
}
async function showRegister() {
  const out = await session.register();
  if (out.result !== 'ok') { reg = null; say('r-status', out); paintRegister(); return; }
  reg = out.value; $('r-status').textContent = ''; paintRegister();
}

for (const [id, name] of [['r-show', 'search'], ['a-record', 'check'], ['c-record', 'banknote']]) { const i = icon(name); if (i !== null) $(id).prepend(i); }
$('lang').addEventListener('click', () => { lang = lang === 'en' ? 'ta' : 'en'; document.documentElement.lang = lang; paint(); });
paint();
if (!may.named) $('page-status').textContent = t('nobody');
else if (!may.read && !may.record) $('page-status').textContent = t('cannotRead');
else {
  if (may.read) { $('register').hidden = false; $('r-show').addEventListener('click', () => { void showRegister(); }); }
  if (may.record) {
    $('agree').hidden = false;
    $('a-record').addEventListener('click', async () => {
      const out = await session.agree({ promotionId: $('a-offer').value, supplierId: $('a-supplier').value, perUnitRupees: $('a-rate').value, capRupees: $('a-cap').value, productIds: $('a-products').value, approvalId: $('a-approval').value });
      say('a-status', out);
      if (out.result === 'ok' && may.read) await showRegister();
    });
  }
  if (may.receipt) {
    $('receipt').hidden = false;
    $('c-record').addEventListener('click', async () => {
      const out = await session.receipt({ promotionId: $('c-offer').value, supplierId: $('c-supplier').value, amountRupees: $('c-amount').value, receivedOn: $('c-on').value, reference: $('c-ref').value });
      say('c-status', out);
      if (out.result === 'ok' && may.read) await showRegister();
    });
  }
}
