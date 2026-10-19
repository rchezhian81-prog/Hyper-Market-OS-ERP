// Supplier scorecard — the page over head office's D-10 route. The session (apps/web-erp/src/supplier-scorecard-session.ts,
// in the bundle as window.supplierScorecard) asks head office; this page only shows its answer: five figures built from
// the supplier's own purchase orders, goods receipts and matched invoices, each "Not rated" with its reason when head office
// cannot rate it — never a number. Nothing is written. Every word has a Tamil twin (in the session's copy).

const $ = (id) => document.getElementById(id);
const api = window.supplierScorecard ?? null;
const session = api?.session ?? null;
const may = session?.may ?? { named: false, read: false };

let lang = 'en';
const t = (k) => (api === null ? k : api.words(lang, k));
let card = null;
let contractId = null;

/** Rejection rate is a rate (lower is better); the other four are scores (higher is better). */
function toneOf(figure, r) {
  if (r.kind !== 'rated') return 'unknown';
  if (figure === 'rejectionRate') return r.bp > 200 ? 'degraded' : 'ok';
  return r.bp < 9_000 ? 'degraded' : 'ok';
}

function panel(figure, r) {
  const p = document.createElement('div');
  const tone = toneOf(figure, r);
  p.className = `panel tone-${tone}`;
  p.dataset.figure = figure;
  p.dataset.rated = String(r.kind === 'rated');
  const k = document.createElement('span'); k.className = 'k'; k.textContent = t(figure);
  const v = document.createElement('span'); v.className = 'v'; v.textContent = api.ratingWords(lang, r);
  const hint = document.createElement('span'); hint.className = 'hint'; hint.textContent = t(`${figure}Hint`);
  // The tone's shape beside the figure's name — never the only signal (the words say it too).
  if (typeof window.sreIcon === 'function' && typeof window.sreIcon.forTone === 'function') {
    const icon = window.sreIcon(window.sreIcon.forTone(tone), 18);
    if (icon) k.prepend(icon, ' ');
  }
  p.append(k, v, hint);
  return p;
}

function paint() {
  document.title = `SRE ${t('title')}`;
  for (const [id, k] of [['title-text', 'title'], ['page-h', 'title'], ['lead', 'lead'], ['l-supplier', 'supplier'], ['l-from', 'from'], ['l-to', 'to'], ['show', 'show']]) $(id).textContent = t(k);
  $('lang').textContent = t('lang');
  $('whoami').textContent = window.supplierScorecardData?.userId ?? '';
  $('nobody').hidden = may.named; $('nobody').textContent = t('nobody');
  $('show').disabled = !may.read;
  $('card-section').hidden = card === null;
  if (card === null) return;
  $('card-h').textContent = `${card.supplierId} · ${card.period.from} – ${card.period.to}`;
  $('figures').replaceChildren(...api.figures.map((f) => panel(f, card[f])));
  $('counts').textContent = `${card.deliveries} ${t('deliveries')} · ${card.ordersInScope} ${t('orders')} · ${card.orderLinesOnTimeInFull}/${card.orderLines} ${t('lines')} ${t('onTimeLines')} · ${card.invoiceLinesChecked} ${t('invoiceLines')}, ${card.invoiceLinesAboveAgreedPrice} ${t('aboveAgreed')}`;
  $('lead-time').textContent = `${t('agreedLead')}: ${card.agreedLeadTimeDays === null ? t('noContract') : `${card.agreedLeadTimeDays} ${t('days')}${contractId === null ? '' : ` (${contractId})`}`}`
    + (card.averageLeadTimeDays === null ? '' : ` · ${t('averageLead')} ${card.averageLeadTimeDays} ${t('days')} · ${t('worstLead')} ${card.worstLeadTimeDays} ${t('days')}`);
  $('nothing').hidden = card.ordersWithNothingReceived.length === 0;
  $('nothing').textContent = `${t('nothingReceived')} ${card.ordersWithNothingReceived.join(', ')}`;
  $('summary').textContent = `${t('summary')}: ${card.summary}`;
  $('sources').textContent = t('sources');
}

async function show(event) {
  event?.preventDefault();
  const out = await session.scorecard($('supplier').value, $('from').value, $('to').value);
  if (out.result === 'ok') { card = out.value.scorecard; contractId = out.value.contractId; $('page-status').className = 'status'; $('page-status').textContent = ''; }
  else { card = null; $('page-status').className = 'status err'; $('page-status').textContent = api.outcomeWords(lang, out); }
  paint();
}

$('ask').addEventListener('submit', (e) => { void show(e); });
$('lang').addEventListener('click', () => { lang = lang === 'en' ? 'ta' : 'en'; document.documentElement.lang = lang; paint(); });
paint();
if (may.named && !may.read) { $('page-status').className = 'status err'; $('page-status').textContent = t('cannotRead'); }

if ('serviceWorker' in navigator) {
  navigator.serviceWorker.register('./sw.js').catch(() => {
    // No offline copy this time; the screen still works online.
  });
}
