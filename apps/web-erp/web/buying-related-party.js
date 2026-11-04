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
  for (const [id, k] of [['rpo-title', 'rpH'], ['rpo-lead', 'rpLede'], ['rpo-po-label', 'po'], ['rpo-check', 'check'], ['rpo-reason-label', 'reason'], ['rpo-approve-go', 'approve']]) $(id).textContent = w(k);
  $('rpo-approve').hidden = true;
  if (last === null) return;
  if (!last.needed) { say('rpo-status', w('noMatch', { supplier: last.supplierId }), 'good'); return; }
  const lines = [w('match', { supplier: last.supplierId, facts: last.matchedOn ?? '' })];
  lines.push(last.approved && last.approval !== null ? w('approved', { who: last.approval.approvedBy, at: shopWhen(last.approval.at), reason: last.approval.reason }) : w('notApproved'));
  say('rpo-status', lines.join(' '), last.approved ? 'good' : 'err');
  $('rpo-approve').hidden = last.approved || !may.approve;
}

async function check() {
  const out = await session.check($('rpo-po').value);
  if (out.result !== 'ok') { last = null; paint(); say('rpo-status', api.outcomeWords(lang(), out), 'err'); return; }
  last = out.value; paint();
}

if (api !== null && may.read) {
  $('rpo').hidden = false;
  paint();
  new MutationObserver(paint).observe(document.documentElement, { attributes: true, attributeFilter: ['lang'] });
  $('rpo-check').addEventListener('click', async () => { const b = $('rpo-check'); b.disabled = true; try { say('rpo-approve-status', ''); await check(); } finally { b.disabled = false; } });
  $('rpo-approve-go').addEventListener('click', async () => {
    const b = $('rpo-approve-go'); b.disabled = true;
    try {
      const out = await session.approve($('rpo-po').value, $('rpo-reason').value);
      if (out.result !== 'ok') { say('rpo-approve-status', api.outcomeWords(lang(), out), 'err'); return; }
      await check();
      say('rpo-approve-status', out.value.alreadyApproved ? w('alreadyApproved') : w('approvedNow'), 'good');
    } finally { b.disabled = false; }
  });
}
