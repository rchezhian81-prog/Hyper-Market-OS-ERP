// Order refunds — the desk's refund for an online order and the worklist of money still waiting on the bank (M18-FR-04).
// The session (apps/web-erp/src/order-refunds-session.ts, in the bundle as window.orderRefunds) asks head office; this page
// shows its answers. A refund goes back to the order's own payment token only, after a second person approves exactly it;
// one the bank has not confirmed reads "waiting", never done. Every state is an icon AND words; every word has a Tamil twin.

const $ = (id) => document.getElementById(id);
const api = window.orderRefunds ?? null;
const session = api?.session ?? null;
const may = session?.may ?? { named: false, read: false, issue: false };

let lang = 'en';
const t = (k) => (api === null ? k : api.words(lang, k));
let pending = null;
let money = null;
let draft = null;

const icon = (name) => (typeof window.sreIcon === 'function' ? window.sreIcon(name, 18) : null);

// U1 · G3: a button greyed for a role says why beside it (words, `title` and `aria-describedby`), never a mute grey.
const WHY_DISABLED = { role: { en: 'Your role may not do this.', ta: 'உங்கள் பங்குக்கு இதைச் செய்ய அனுமதி இல்லை.' } };
function whyDisabled(btn, why) {
  if (!btn || btn.tagName !== 'BUTTON') return;
  const tongue = document.documentElement.lang === 'ta' ? 'ta' : 'en';
  const words = why === '' || why === undefined || why === null ? '' : (WHY_DISABLED[why]?.[tongue] ?? why);
  let note = btn.nextElementSibling;
  if (!(note && note.classList.contains('sre-why'))) {
    note = document.createElement('small'); note.className = 'sre-why';
    note.id = `${btn.id || `b${Math.random().toString(36).slice(2, 7)}`}-why`;
    btn.after(note);
  }
  note.textContent = words; note.hidden = words === '';
  if (words === '') { btn.removeAttribute('title'); btn.removeAttribute('aria-describedby'); } else { btn.title = words; btn.setAttribute('aria-describedby', note.id); }
}
for (const [id, name] of [['show-pending', 'clock'], ['show-order', 'search'], ['ask', 'hand'], ['issue', 'indian-rupee']]) { const i = icon(name); if (i !== null) $(id).prepend(i); }

function text(tag, words, cls) { const n = document.createElement(tag); n.textContent = words; if (cls) n.className = cls; return n; }
function bad(where, out) { $(where).className = 'status err'; $(where).textContent = `⚠ ${api.outcomeWords(lang, out)}`; }
function good(where, words) { $(where).className = 'status good'; $(where).textContent = `✓ ${words}`; }
const MARK = { issued: '✓', pending: '⏱', refused: '⚠' };

function outcomeForm(r) {
  const wrap = document.createElement('div'); wrap.className = 'row-form';
  const label = document.createElement('label');
  const input = document.createElement('input'); input.className = 'statement'; input.autocomplete = 'off';
  label.append(text('span', t('statementRef')), input);
  const mk = (result, words, iconName) => {
    const b = document.createElement('button'); b.type = 'button'; b.className = `quiet outcome-${result}`;
    b.className = 'sre-btn';
    const i = icon(iconName); if (i !== null) b.append(i);
    b.append(text('span', words));
    b.disabled = !may.issue;
    whyDisabled(b, may.issue ? '' : 'role');
    b.addEventListener('click', () => { void recordOutcome(r, result, input.value); });
    return b;
  };
  wrap.append(label, mk('refunded', t('refunded'), 'circle-check'), mk('declined', t('declined'), 'x'));
  return wrap;
}

function paintPending() {
  if (pending === null) { $('pending').replaceChildren(); return; }
  if (pending.pendingPayments.length === 0 && pending.pendingRefunds.length === 0) { $('pending').replaceChildren(text('li', `✓ ${t('noneWaiting')}`, 'row tone-ok')); return; }
  $('pending').replaceChildren(
    ...pending.pendingRefunds.map((r) => {
      const li = document.createElement('li'); li.className = 'row tone-degraded'; li.dataset.refund = r.refundId; li.dataset.order = r.orderId;
      orderOption(r.orderId); li.addEventListener('click', () => { $('order-id').value = r.orderId; });
      li.append(text('strong', `⏱ ${t('refundWaiting')} — ${r.orderId} · ${api.rupees(r.amountMinor)}`));
      li.append(text('span', `${t(`basis_${r.basis}`)} · ${r.reason}`, 'facts'));
      li.append(outcomeForm(r));
      return li;
    }),
    ...pending.pendingPayments.map((p) => {
      const li = document.createElement('li'); li.className = 'row tone-degraded'; li.dataset.payment = p.orderId;
      orderOption(p.orderId); li.addEventListener('click', () => { $('order-id').value = p.orderId; });
      li.append(text('strong', `⏱ ${t('paymentWaiting')} — ${p.orderId} · ${api.rupees(p.amountMinor)}`));
      if (p.reason) li.append(text('span', p.reason, 'facts'));
      return li;
    }),
  );
}

function paintMoney() {
  if (money === null) { $('money').replaceChildren(); return; }
  const p = money.position;
  const li = document.createElement('li'); li.className = 'row'; li.dataset.order = money.orderId;
  li.append(text('strong', `${money.orderId} — ${t('paymentState')}: ${money.payment.state}`));
  const facts = document.createElement('div'); facts.className = 'facts';
  for (const [k, v, cls] of [['paid', p.paidMinor, 'paid'], ['refundedK', p.refundedMinor, 'refunded'], ['pendingK', p.pendingMinor, 'pending'], ['refundableK', p.refundableMinor, 'refundable']]) facts.append(text('span', `${t(k)}: ${api.rupees(v)}`, cls));
  li.append(facts);
  for (const r of p.refunds ?? []) li.append(text('span', `${MARK[r.effectiveState] ?? '○'} ${t('issued')} ${r.refundId} · ${api.rupees(r.amountMinor)} — ${t(`state_${r.effectiveState}`)}`, `refund refund-${r.effectiveState}`));
  $('money').replaceChildren(li);
}

function paint() {
  document.title = `SRE ${t('title')}`;
  for (const [id, k] of [['title-text', 'title'], ['page-h', 'title'], ['lead', 'lead'], ['pending-h', 'pendingH'], ['show-pending-text', 'showPending'], ['refund-h', 'refundH'], ['l-order-id', 'orderId'], ['show-order-text', 'showOrder'],
    ['l-amount', 'amount'], ['l-basis', 'basis'], ['l-reason', 'reason'], ['ask-text', 'ask'], ['l-approval-id', 'asked'], ['issue-text', 'issue'], ['to-token', 'toToken']]) $(id).textContent = t(k);
  $('lang').textContent = t('lang');
  $('whoami').textContent = window.orderRefundsData?.userId ?? '';
  $('nobody').hidden = may.named; $('nobody').textContent = t('nobody');
  const chosen = $('basis').value || 'cancellation';
  $('basis').replaceChildren(...(api?.bases ?? []).map((b) => { const o = document.createElement('option'); o.value = b; o.textContent = t(`basis_${b}`); return o; }));
  $('basis').value = chosen;
  for (const id of ['show-pending', 'show-order', 'order-id']) $(id).disabled = !may.read;
  for (const id of ['show-pending', 'show-order']) whyDisabled($(id), may.read ? '' : 'role');
  for (const id of ['ask', 'issue', 'amount', 'basis', 'reason']) $(id).disabled = !may.issue;
  for (const id of ['ask', 'issue']) whyDisabled($(id), may.issue ? '' : 'role');
  paintPending(); paintMoney();
}

async function showPending() {
  const out = await session.pending();
  if (out.result !== 'ok') { pending = null; bad('pending-status', out); paintPending(); return; }
  pending = out.value; $('pending-status').className = 'status'; $('pending-status').textContent = out.value.detail;
  paintPending();
}
async function showOrder() {
  const out = await session.money($('order-id').value);
  if (out.result !== 'ok') { money = null; bad('order-status', out); paintMoney(); return; }
  money = out.value; $('order-status').className = 'status'; $('order-status').textContent = '';
  paintMoney();
}
async function ask() {
  const out = await session.ask({ orderId: $('order-id').value, amount: $('amount').value, basis: $('basis').value, reason: $('reason').value });
  if (out.result !== 'ok') { bad('refund-status', out); return; }
  draft = out.value.draft;
  $('approval-id').value = out.value.requestId;
  good('refund-status', `${t('asked')} ${out.value.requestId}. ${t('askedNext')}`);
}
// OB-694: an order refund is issued only after the shared confirm sheet (the chrome's) says the amount, the order, the basis
// and in whose name — and the person confirms. Go back sends nothing.
const office = () => (window.sreOffice && typeof window.sreOffice.confirm === 'function' ? Promise.resolve(window.sreOffice) : new Promise((resolve) => document.addEventListener('sre:chrome', () => resolve(window.sreOffice), { once: true })));
const CONFIRM = {
  en: { title: '{amount} will be refunded on order {order} ({basis})', detail: 'The money goes back to the payment the customer used, never anywhere else. A card or UPI refund reads "waiting for the bank" until the bank confirms it; it cannot be taken back once issued.', authority: 'In your name, under approval {approval}. Head office refuses it without a second person\'s approval of exactly this refund.', label: 'Issue the refund' },
  ta: { title: 'ஆர்டர் {order}-க்கு {amount} திருப்பித் தரப்படும் ({basis})', detail: 'பணம் வாடிக்கையாளர் பயன்படுத்திய கட்டணத்திற்கே திரும்பும், வேறெங்கும் அல்ல. வங்கி உறுதிப்படுத்தும் வரை கார்டு அல்லது யுபிஐ திருப்பம் "வங்கிக்காகக் காத்திருக்கிறது" என்றே படிக்கும்; வழங்கிய பின் திரும்பப் பெற முடியாது.', authority: 'உங்கள் பெயரில், அனுமதி {approval}-இன் கீழ். இதே திருப்பத்திற்கு இரண்டாவது நபரின் அனுமதி இல்லாமல் தலைமை அலுவலகம் மறுக்கும்.', label: 'திருப்பத்தை வழங்கு' },
};
const fillIn = (text, values) => Object.entries(values).reduce((acc, [k, v]) => acc.split(`{${k}}`).join(String(v)), text);
function issueSheet() {
  const basisEl = $('basis');
  const values = { amount: api.rupees(draft.amountMinor), order: draft.orderId, basis: basisEl?.selectedOptions?.[0]?.textContent ?? draft.basis, approval: $('approval-id').value.trim() || '—' };
  const pair = (k) => ({ en: fillIn(CONFIRM.en[k], values), ta: fillIn(CONFIRM.ta[k], values) });
  return { title: pair('title'), detail: pair('detail'), authority: pair('authority'), confirmLabel: pair('label'), tone: 'primary' };
}
async function issue() {
  if (draft === null) { $('refund-status').className = 'status err'; $('refund-status').textContent = `⚠ ${t('needAsk')}`; return; }
  if (!(await (await office()).confirm(issueSheet())).ok) return;
  const out = await session.issue(draft, $('approval-id').value);
  if (out.result !== 'ok') { bad('refund-status', out); return; }
  const state = out.value.refund.effectiveState;
  $('refund-status').className = `status ${state === 'issued' ? 'good' : 'err'}`;
  $('refund-status').dataset.state = state;
  $('refund-status').textContent = `${MARK[state] ?? '○'} ${t('issued')} ${draft.refundId} · ${api.rupees(draft.amountMinor)} — ${t(`state_${state}`)}`;
  draft = null; $('approval-id').value = '';
  await showOrder();
}
async function recordOutcome(r, result, statementRef) {
  const out = await session.outcome(r.orderId, r.refundId, result, statementRef);
  if (out.result !== 'ok') { bad('pending-status', out); return; }
  good('pending-status', `${t('outcomeSaved')} ${r.refundId} — ${t(result)}`);
  await showPending();
  $('pending-status').className = 'status good'; $('pending-status').textContent = `✓ ${t('outcomeSaved')} ${r.refundId} — ${t(result)}`;
}

$('show-pending').addEventListener('click', () => { void showPending(); });
$('show-order').addEventListener('click', () => { void showOrder(); });
$('ask').addEventListener('click', () => { void ask(); });
$('issue').addEventListener('click', () => { void issue(); });
$('lang').addEventListener('click', () => { lang = lang === 'en' ? 'ta' : 'en'; document.documentElement.lang = lang; paint(); });
paint();
if (may.named && !may.read) { $('page-status').className = 'status err'; $('page-status').textContent = `⚠ ${t('cannotRead')}`; }

if ('serviceWorker' in navigator) {
  navigator.serviceWorker.register('./sw.js').catch(() => {
    // No offline copy this time; the screen still works online.
  });
}

// ── U2b (G5): the order is taken from the list the page reads — a tap on a pending row fills the box, and the box offers the same numbers; a typed number stays possible
function orderOption(orderId) {
  const list = $('order-list'); if (!list || [...list.options].some((o) => o.value === orderId)) return;
  const o = document.createElement('option'); o.value = orderId; list.append(o);
}
