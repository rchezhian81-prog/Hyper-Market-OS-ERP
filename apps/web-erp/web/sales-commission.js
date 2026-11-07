// Sales commission (W3 · M22-FR-03) — the page over head office's commission rules and earnings. The session
// (apps/web-erp/src/sales-commission-session.ts, in the bundle as window.salesCommission) does every call and every rule;
// this page lays out what it is told. Proposing and approving are explicit presses; approving is offered on a rate waiting
// for approval, and head office refuses the person who proposed it. Every word this page adds has a Tamil twin; head
// office's own sentences stay in English (OB-553).

const $ = (id) => document.getElementById(id);
const api = window.salesCommission ?? null;
const session = api?.session ?? null;
const may = session?.may ?? { named: false, read: false, propose: false, approve: false };
let lang = 'en';
const t = (k) => (api === null ? k : api.words(lang, k));
function text(tag, words, cls) { const n = document.createElement(tag); n.textContent = words; if (cls) n.className = cls; return n; }
const when = (iso) => (api === null ? iso : api.moment(iso));
const pct = (bps) => (api === null ? String(bps) : api.percent(bps));
const rs = (m) => (api === null ? String(m) : api.rupees(m));

let view = null;

function paintView() {
  $('rules').replaceChildren(); $('earned').replaceChildren(); $('earned-sum').textContent = '';
  $('rules-s').hidden = view === null; $('earned-s').hidden = view === null;
  if (view === null) return;
  if (view.rules.length === 0) $('rules').append(text('li', t('noRules'), 'meta'));
  for (const r of view.rules) {
    const li = document.createElement('li'); li.dataset.rule = r.ruleId; li.dataset.inForce = String(r.inForce);
    const state = r.inForce ? t('inForce') : r.approvedBy === undefined ? t('waiting') : t('approvedOld');
    li.append(text('h4', `${pct(r.rateBps)} · ${r.capMinor === null ? t('noCap') : rs(r.capMinor)} — ${state}`),
      text('p', `${t('proposedBy')} ${r.proposedBy} · ${when(r.proposedAt)}${r.approvedBy === undefined ? '' : ` · ${t('approvedBy')} ${r.approvedBy}`}`, 'meta'));
    if (r.approvedBy === undefined && may.approve) {
      const status = text('p', '', 'status'); status.setAttribute('role', 'status');
      const b = document.createElement('button'); b.classList.add('sre-btn'); b.type = 'button'; b.textContent = t('approve');
      b.addEventListener('click', async () => {
        status.textContent = t('reading');
        const out = await session.approve(view.salespersonId, r.ruleId);
        status.textContent = out.result === 'ok' ? t('approved') : api.outcomeWords(lang, out);
        if (out.result === 'ok') void look();
      });
      li.append(b, status);
    }
    $('rules').append(li);
  }
  if (view.earned === null) { $('earned-sum').textContent = t('noEarned'); return; }
  $('earned-sum').textContent = `${t('total')} ${rs(view.earned.totalCommissionMinor)} · ${t('on')} ${rs(view.earned.totalBaseMinor)} · ${view.earned.count} ${t('invoices')}`;
  for (const a of view.earned.accruals) {
    const li = document.createElement('li'); li.dataset.accrual = a.accrualId;
    li.append(text('p', `${rs(a.commissionMinor)} · ${pct(a.rateBps)} ${t('on')} ${rs(a.baseMinor)} · ${a.ref} · ${when(a.at)}`, 'meta'));
    $('earned').append(li);
  }
}

function paint() {
  document.title = `SRE ${t('title')}`;
  $('title-text').textContent = t('title'); $('page-h').textContent = t('title'); $('lead').textContent = t('lead');
  $('lang').textContent = lang === 'en' ? 'தமிழ்' : 'English';
  for (const [id, key] of [['pick-h', 'salesperson'], ['c-sp-l', 'salesperson'], ['c-look-text', 'look'], ['rules-h', 'rulesH'], ['c-rate-l', 'rate'], ['c-cap-l', 'cap'], ['c-propose-text', 'propose'], ['earned-h', 'earnedH']]) $(id).textContent = t(key);
  paintView();
}

async function look() {
  $('look-status').textContent = t('reading');
  const out = await session.look($('c-sp').value);
  if (out.result === 'ok') { view = out.value; $('look-status').textContent = ''; } else { view = null; $('look-status').textContent = api.outcomeWords(lang, out); }
  paintView();
}

$('lang').addEventListener('click', () => { lang = lang === 'en' ? 'ta' : 'en'; document.documentElement.lang = lang; paint(); });
$('pick-form').addEventListener('submit', (e) => { e.preventDefault(); void look(); });
$('propose-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  $('propose-status').textContent = t('reading');
  const out = await session.propose(view?.salespersonId ?? $('c-sp').value, $('c-rate').value, $('c-cap').value);
  $('propose-status').textContent = out.result === 'ok' ? t('proposed') : api.outcomeWords(lang, out);
  if (out.result === 'ok') void look();
});
paint();
if (!may.named) $('page-status').textContent = t('nobody');
else if (!may.read) $('page-status').textContent = t('cannotRead');
else { $('pick').hidden = false; $('propose-form').hidden = !may.propose; }
