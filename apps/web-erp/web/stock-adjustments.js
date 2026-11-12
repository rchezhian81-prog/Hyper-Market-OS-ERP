// Adjust a quantity — the view layer (U6 · §27 Inventory "Adjustment" · M08-FR-03 · §28). Every word, every request and every
// cheap check live in the TESTED session model (apps/web-erp/src/stock-adjustments-session.ts, window.stockAdjustmentsSession);
// this file draws what it is told on the shared office parts (window.sreOffice) and sends a person's click through it — the ask
// and the approval behind the shared confirm sheet (OB-698: stock moves) — then reads head office again.

const $ = (id) => document.getElementById(id);
const session = window.stockAdjustmentsSession ?? null;
let lang = 'en';
const t = (k) => (session === null ? k : session.text(lang, k));
const both = (k) => ({ en: session.text('en', k), ta: session.text('ta', k) });
const office = () => (window.sreOffice && typeof window.sreOffice.table === 'function' ? window.sreOffice : null);
const REASONS = ['damaged', 'expired', 'miscount', 'found', 'theft_suspected', 'other'];

let requests = null; let pending = 0; let asAt = '';
let outcome = null;

function say(el, out, good) { const s = session.say(lang, out, good); el.className = `status ${s.tone}`; el.textContent = s.words; }
function myStore() {
  const o = window.sreOffice;
  const me = o && typeof o.me === 'function' ? o.me() : null;
  return (me && me.storeId) || (window.sreDirectory && window.sreDirectory.store && window.sreDirectory.store.id) || '';
}
const nameOf = (kind, id) => { const o = window.sreOffice; const n = o && typeof o.nameOf === 'function' ? o.nameOf(kind, id) : null; return n && n !== id ? `${n} (${id})` : id; };
/** U1 · G3: a greyed button says why (title + the line beside it), never a dead end. */
function whyDisabled(btn, words) {
  btn.disabled = words !== '';
  btn.title = words;
  let note = btn.nextElementSibling;
  if (!(note && note.classList.contains('sre-why'))) { note = document.createElement('small'); note.className = 'sre-why'; note.id = `${btn.id}-why`; btn.after(note); }
  note.textContent = words; note.hidden = words === '';
  if (words !== '') btn.setAttribute('aria-describedby', note.id); else btn.removeAttribute('aria-describedby');
}
async function confirmFirst(spec) {
  const o = window.sreOffice;
  if (!o || typeof o.confirm !== 'function') return 'unavailable';
  const answer = await o.confirm(spec);
  return answer && answer.ok === true ? answer : null;
}
const filled = (key, values) => ({ en: session.fill('en', key, values), ta: session.fill('ta', key, values) });

function paintReasons() {
  const was = $('reason').value;
  $('reason').replaceChildren(...REASONS.map((r) => { const o = document.createElement('option'); o.value = r; o.textContent = t(r); return o; }));
  if (REASONS.includes(was)) $('reason').value = was;
}

async function decide(r, decision, why, status) {
  status.className = 'status'; status.textContent = '';
  // No reason written: the session says so and nothing is sent — no sheet for that.
  if (why.value.trim() === '') { say(status, { result: 'invalid', key: 'needWhy' }); return; }
  if (decision === 'approved') {
    const spec = { title: both('confirmApproveTitle'), detail: filled('confirmApproveDetail', { product: nameOf('product', r.productId), place: nameOf('place', r.locationId), change: r.change, value: r.value }), authority: both('authorityApprove'), confirmLabel: both('approve'), tone: 'primary' };
    const answer = await confirmFirst(spec);
    if (answer === 'unavailable') { status.className = 'status err'; status.textContent = t('confirmUnavailable'); return; }
    if (answer === null) return;
  }
  const out = await session.decide(r.requestId, decision, why.value);
  if (out.result === 'ok') { say($('reg-status'), out, out.alreadyDecided ? 'already' : decision === 'approved' ? 'approvedNow' : 'rejectedNow'); await load(); return; }
  say(status, out);
}

function paintRegister() {
  const o = office();
  const host = $('register');
  if (outcome !== null) { host.replaceChildren(); if (o !== null) o.state(host, o.stateOf(outcome), { title: session.say(lang, outcome).words }); else host.textContent = session.say(lang, outcome).words; return; }
  if (requests === null) { host.replaceChildren(); if (o !== null) o.state(host, 'loading'); return; }
  if (o === null) return;
  $('covers').textContent = t('covers');
  $('as-at').textContent = asAt === '' ? '' : `${t('asAt')} ${session.shopMomentOf(asAt)}`;
  $('reg-status').className = 'status'; $('reg-status').textContent = `${pending} ${t('waiting')}`;
  host.replaceChildren();
  if (requests.length === 0) { const all = $('all').checked; o.state(host, 'empty', { title: t(all ? 'emptyAll' : 'empty'), detail: t(all ? 'emptyAllDetail' : 'emptyDetail') }); return; }
  const rows = requests.map((r) => session.requestView(lang, r));
  o.table(host, {
    id: 'requests', label: both('registerH'), rows, pageSize: 10, sortable: true,
    rowKey: (r) => r.requestId, rowData: (r) => ({ request: r.requestId, status: r.status, yours: r.yours ? 'yes' : 'no' }),
    columns: [
      { key: 'productId', label: both('colProduct'), sort: 'text', value: (r) => nameOf('product', r.productId) },
      { key: 'locationId', label: both('colPlace'), sort: 'text', value: (r) => nameOf('place', r.locationId) },
      { key: 'change', label: both('colChange'), align: 'end', sort: false },
      { key: 'value', label: both('colValue'), align: 'end', sort: false },
      { key: 'reasonWord', label: both('colReason'), sort: 'text', value: (r) => (r.note === null ? r.reasonWord : `${r.reasonWord} — ${r.note}`) },
      { key: 'requestedBy', label: both('colAskedBy'), sort: 'text', value: (r) => `${nameOf('person', r.requestedBy)} · ${r.sourceWord}` },
      { key: 'when', label: both('colWhen'), sort: 'text' },
      { key: 'stateWord', label: both('colState'), sort: 'text', render: (r) => {
        const wrap = document.createElement('span'); wrap.className = 'sre-chips';
        wrap.append(o.recordChip(r.status === 'posted' ? 'approved' : r.status, r.stateWord));
        for (const f of r.flags) wrap.append(o.chip('degraded', f));
        return wrap;
      } },
      { key: 'decision', label: both('colDecision'), sort: false, render: (r) => {
        if (r.decision !== null) { const s = document.createElement('span'); s.textContent = r.decision; return s; }
        const box = document.createElement('div'); box.className = 'inline';
        if (r.yours) { const s = document.createElement('span'); s.className = 'meta'; s.textContent = t('yours'); box.append(s); return box; }
        if (!r.canDecide) { const s = document.createElement('span'); s.className = 'meta'; s.textContent = session.may.decide ? '' : t('cannotDecide'); box.append(s); return box; }
        const why = document.createElement('input'); why.className = 'sre-input adj-reason'; why.setAttribute('aria-label', `${t('decisionReason')}: ${r.requestId}`); why.placeholder = t('decisionReason'); why.autocomplete = 'off';
        const status = document.createElement('p'); status.className = 'status'; status.setAttribute('role', 'status');
        const yes = document.createElement('button'); yes.type = 'button'; yes.className = 'sre-btn'; yes.textContent = t('approve'); yes.dataset.act = 'approve';
        const no = document.createElement('button'); no.type = 'button'; no.className = 'sre-btn sre-btn-quiet'; no.textContent = t('reject'); no.dataset.act = 'reject';
        yes.addEventListener('click', () => { void decide(r, 'approved', why, status); });
        no.addEventListener('click', () => { void decide(r, 'rejected', why, status); });
        box.append(why, yes, no, status);
        return box;
      } },
    ],
    empty: { title: t('empty'), detail: t('emptyDetail') },
  });
}

async function load() {
  if (session === null || session.nobody || !session.may.read) return;
  outcome = null;
  const out = await session.list($('all').checked);
  if (out.result === 'ok') { requests = out.requests; pending = out.pending; asAt = out.asAt; }
  else { requests = null; outcome = out; say($('reg-status'), out); }
  paintRegister();
}

// The ask, in two steps: the session's own checks with NO request (`dryRun`), the confirm sheet, then the request.
async function askForIt() {
  $('new-status').className = 'status'; $('new-status').textContent = '';
  const form = { productId: $('product').value, locationId: $('place').value, direction: document.querySelector('input[name="direction"]:checked')?.value ?? 'less', quantityText: $('qty').value, uom: $('uom').value, reasonCode: $('reason').value, note: $('note').value };
  const missing = session.check(form);
  if (missing !== null) { say($('new-status'), { result: 'invalid', key: missing }); return; }
  const change = session.changeWords(form.direction === 'more' ? session.quantityOf(form) : -session.quantityOf(form), form.uom.trim() === '' ? 'EA' : form.uom.trim());
  const spec = { title: both('confirmAskTitle'), detail: filled('confirmAskDetail', { product: nameOf('product', form.productId.trim()), place: nameOf('place', form.locationId.trim()), change, reason: t(form.reasonCode) }), authority: both('authorityAsk'), confirmLabel: both('ask'), tone: 'primary' };
  const answer = await confirmFirst(spec);
  if (answer === 'unavailable') { $('new-status').className = 'status err'; $('new-status').textContent = t('confirmUnavailable'); return; }
  if (answer === null) return;
  const out = await session.ask(form);
  say($('new-status'), out, out.result === 'ok' && out.alreadyRecorded ? 'askedAgain' : 'asked');
  if (out.result === 'ok') { $('qty').value = ''; $('note').value = ''; await load(); }
}

function paintWords() {
  document.title = `SRE ${t('title')}`;
  for (const [id, k] of [['who', 'title'], ['page-h', 'title'], ['lede', 'lede'], ['new-h', 'newH'], ['new-lede', 'newLede'], ['l-product', 'product'], ['l-place', 'place'], ['l-qty', 'quantity'], ['l-uom', 'unit'], ['l-reason', 'reason'], ['l-note', 'note'],
    ['l-direction', 'direction'], ['d-less', 'less'], ['d-more', 'more'], ['ask', 'ask'], ['reg-h', 'registerH'], ['reg-lede', 'registerLede'], ['l-all', 'showAll']]) {
    const el = $(id); if (el) el.textContent = t(k);
  }
  paintReasons();
  const nobody = $('nobody');
  nobody.hidden = !(session === null || session.nobody);
  nobody.textContent = t('nobody');
  const signed = session !== null && !session.nobody;
  $('new-section').hidden = !signed;
  if (signed) whyDisabled($('ask'), session.may.ask ? '' : t('cannotAsk'));
  if (signed && !session.may.read) { $('reg-status').className = 'status err'; $('reg-status').textContent = t('cannotRead'); }
}

function mountParts() {
  const o = window.sreOffice;
  if (!o || typeof o.pickable !== 'function') return;
  o.pickable('product', 'product', both('whichProduct'), { allowCode: true });
  o.pickable('place', 'place', both('whichPlace'), { allowCode: true, scope: () => ({ storeId: myStore() }) });
  if ($('place').value.trim() === '' && myStore() !== '') { $('place').value = myStore(); const n = $('place-name'); if (n) n.textContent = nameOf('place', myStore()); }
}

if (session !== null) {
  $('ask').addEventListener('click', () => { void askForIt(); });
  $('new').addEventListener('submit', (e) => { e.preventDefault(); void askForIt(); });
  $('all').addEventListener('change', () => { void load(); });
  $('lang').addEventListener('click', () => { lang = lang === 'en' ? 'ta' : 'en'; document.documentElement.lang = lang; paintWords(); paintRegister(); });
}
paintWords();
document.addEventListener('sre:chrome', () => { mountParts(); paintRegister(); void load(); }, { once: true });

if ('serviceWorker' in navigator) {
  navigator.serviceWorker.register('./sw.js').catch(() => {
    // No offline copy this time; the screen still works online.
  });
}
