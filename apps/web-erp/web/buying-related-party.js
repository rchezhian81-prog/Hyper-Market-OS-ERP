// Buying · "Related-party check" (W5 · M15-FR-03 · OB-301). Every rule and word lives in the TESTED session
// (apps/web-erp/src/related-party-order-session.ts, window.relatedPartyOrders); this file draws head office's answer: whether
// the order's supplier matches the owner's related-party list (on which FACT — never the related person), and whether the
// owner has approved it. The approve step is offered only to a person who holds the owner's approval; head office checks he
// is the owner. Nothing is read on open. No prompt/confirm/alert.

const $ = (id) => document.getElementById(id);
const api = window.relatedPartyOrders ?? null;
const session = api?.session ?? null;
const may = session?.may ?? { named: false, read: false, approve: false };
const lang = () => (document.documentElement.lang === 'ta' ? 'ta' : 'en');
const w = (k, fill) => (api === null ? k : api.words(lang(), k, fill));
const shopWhen = (value) => window.sreShopDay?.dateTimeOf(value) ?? value;
function say(id, text, cls = '') { const el = $(id); el.className = `otb-status ${cls}`; el.textContent = text; }

let last = null;

function paint() {
  for (const [id, k] of [['rp-title', 'rpH'], ['rp-lead', 'rpLede'], ['rp-po-label', 'po'], ['rp-check', 'check'], ['rp-reason-label', 'reason'], ['rp-approve-go', 'approve']]) $(id).textContent = w(k);
  $('rp-approve').hidden = true;
  if (last === null) return;
  if (!last.needed) { say('rp-status', w('noMatch', { supplier: last.supplierId }), 'good'); return; }
  const lines = [w('match', { supplier: last.supplierId, facts: last.matchedOn ?? '' })];
  lines.push(last.approved && last.approval !== null ? w('approved', { who: last.approval.approvedBy, at: shopWhen(last.approval.at), reason: last.approval.reason }) : w('notApproved'));
  say('rp-status', lines.join(' '), last.approved ? 'good' : 'err');
  $('rp-approve').hidden = last.approved || !may.approve;
}

async function check() {
  const out = await session.check($('rp-po').value);
  if (out.result !== 'ok') { last = null; paint(); say('rp-status', api.outcomeWords(lang(), out), 'err'); return; }
  last = out.value; paint();
}

if (api !== null && may.read) {
  $('rp').hidden = false;
  paint();
  new MutationObserver(paint).observe(document.documentElement, { attributes: true, attributeFilter: ['lang'] });
  $('rp-check').addEventListener('click', async () => { const b = $('rp-check'); b.disabled = true; try { say('rp-approve-status', ''); await check(); } finally { b.disabled = false; } });
  $('rp-approve-go').addEventListener('click', async () => {
    const b = $('rp-approve-go'); b.disabled = true;
    try {
      const out = await session.approve($('rp-po').value, $('rp-reason').value);
      if (out.result !== 'ok') { say('rp-approve-status', api.outcomeWords(lang(), out), 'err'); return; }
      await check();
      say('rp-approve-status', out.value.alreadyApproved ? w('alreadyApproved') : w('approvedNow'), 'good');
    } finally { b.disabled = false; }
  });
}
