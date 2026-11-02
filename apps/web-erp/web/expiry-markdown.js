// Markdowns on the Expiry page (W3 · D06-FR-05 "markdown ladder" · D-4 · D-16). The session
// (apps/web-erp/src/markdown-session.ts, in the bundle as window.markdowns) does every call and every rule; this lays out what
// head office proposed. ADVISORY ONLY: nothing here changes a price. "Send this price for approval" opens Change a price on
// Products and prices holding the product and the proposed price — the normal price checks run there, and a price under the
// margin floor waits for a second person's own approval (ADR-0024). No AI and no rule commits a markdown (hard rule #5).
// Loaded before expiry.js so its near-expiry rows can offer "Work out a markdown". Every word has a Tamil twin.

const $ = (id) => document.getElementById(id);
const api = window.markdowns ?? null;
const session = api?.session ?? null;
const lang = () => (document.documentElement.lang === 'ta' ? 'ta' : 'en');
const t = (k, slots) => (api === null ? k : api.words(lang(), k, slots));
let proposal = null; let clearance = null;

function proposalWords(p) {
  return p.reason === 'marked_down'
    ? t('proposal', { off: (p.markdownBps / 100).toFixed(p.markdownBps % 100 === 0 ? 0 : 1), from: api.rupees(p.currentPriceMinor), to: api.rupees(p.newPriceMinor) })
    : t('noMarkdown', { why: t(`r_${p.reason}`) });
}

function paint() {
  if (api === null || session === null || !session.may.propose) return;
  $('markdown').hidden = false;
  for (const [id, k] of [['md-h', 'proposeH'], ['md-lead', 'proposeLead'], ['l-md-product', 'product'], ['l-md-batch', 'batch'], ['l-md-days', 'daysLeft'], ['l-md-qty', 'onHand'],
    ['l-md-price', 'price'], ['l-md-rate', 'rate'], ['md-go', 'propose'], ['md-send-lead', 'sendLead'], ['md-send', 'sendForApproval'], ['cl-h', 'clearanceH'], ['cl-lead', 'clearanceLead'], ['cl-go', 'clearanceShow']]) $(id).textContent = t(k);
  $('md-result').hidden = proposal === null;
  if (proposal !== null) {
    $('md-proposal').textContent = proposalWords(proposal);
    $('md-surplus').textContent = proposal.surplusMinor > 0 ? t('surplus', { n: proposal.surplusMinor, held: proposal.onHandMinor }) : '';
    const send = $('md-send');
    send.hidden = proposal.reason !== 'marked_down';
    send.href = api.link(proposal.productId, proposal.newPriceMinor);
  }
  const box = $('cl-list');
  if (clearance === null) { box.replaceChildren(); return; }
  const parts = [];
  if (clearance.suggestions.length === 0) parts.push(Object.assign(document.createElement('p'), { className: 'lead', textContent: t('noSuggestions') }));
  for (const s of clearance.suggestions) {
    const row = document.createElement('div'); row.className = 'row'; row.dataset.product = s.productId; row.dataset.batch = s.batchId ?? '';
    const what = document.createElement('span'); what.className = 'what';
    const strong = document.createElement('strong'); strong.textContent = `${s.productId}${s.batchId === null ? '' : ` · ${s.batchId}`}`;
    const small = document.createElement('small'); small.textContent = proposalWords(s);
    what.append(strong, small); row.append(what);
    if (s.reason === 'marked_down') {
      const a = document.createElement('a'); a.className = 'send'; a.textContent = t('sendForApproval'); a.href = api.link(s.productId, s.newPriceMinor);
      row.append(a);
    }
    parts.push(row);
  }
  if (clearance.notJudged.length > 0) {
    const h = document.createElement('h3'); h.textContent = t('notJudgedH'); parts.push(h);
    for (const n of clearance.notJudged) parts.push(Object.assign(document.createElement('p'), { className: 'lead', textContent: `${n.productId}${n.batchId === null ? '' : ` · ${n.batchId}`}: ${t(`nj_${n.because}`)}` }));
  }
  box.replaceChildren(...parts);
}

/** expiry.js: a near-expiry row's "Work out a markdown" fills the form with what the list knows. */
window.expiryMarkdownPick = (item) => {
  $('md-product').value = item.productId; $('md-batch').value = item.batchId ?? '';
  $('md-days').value = String(Math.max(0, item.daysToExpiry)); $('md-qty').value = String(item.qty);
  $('md-price').value = ''; $('md-rate').value = '';
  $('md-product').scrollIntoView?.({ block: 'center' }); $('md-rate').focus();
};

$('md-form')?.addEventListener('submit', async (e) => {
  e.preventDefault();
  if (session === null) return;
  $('md-status').textContent = t('proposing');
  const out = await session.propose({ productId: $('md-product').value, batchId: $('md-batch').value, daysLeft: $('md-days').value, onHand: $('md-qty').value, price: $('md-price').value, rate: $('md-rate').value });
  proposal = out.result === 'ok' ? out.value : null;
  $('md-status').textContent = out.result === 'ok' ? '' : api.outcomeWords(lang(), out);
  paint();
});
$('cl-go')?.addEventListener('click', async () => {
  if (session === null) return;
  $('cl-status').textContent = t('reading');
  const out = await session.clearance();
  clearance = out.result === 'ok' ? out.value : null;
  $('cl-status').textContent = out.result === 'ok' ? '' : api.outcomeWords(lang(), out);
  paint();
});
new MutationObserver(paint).observe(document.documentElement, { attributes: true, attributeFilter: ['lang'] });
paint();
