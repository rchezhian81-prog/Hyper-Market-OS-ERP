// Customers — the page over head office's M16 routes (R4 · OB-74 · signed OB-227). The session (apps/web-erp/src/customers-
// session.ts, in the bundle as window.customers) asks head office; this page only shows its answers: every customer with
// its segment ("not profiled" listed, never left out), the records that may be the same person (a suggestion — nothing
// merges by itself), and the merges waiting for a second person, in force, and undone. Nothing is written on open.
// Every word has a Tamil twin.

// OB-606: a moment is shown on the SHOP's date (its zone, as the store computer told the page) — never this device's own date.
const shopDayOf = (value) => window.sreShopDay?.dateOf(value) ?? '';
const $ = (id) => document.getElementById(id);
const api = window.customers ?? null;
const session = api?.session ?? null;
const may = session?.may ?? { named: false, read: false, record: false, propose: false, approve: false };

let lang = 'en';
const t = (k) => (api === null ? k : api.words(lang, k));
let overview = null;
let matches = null;
let record = null;

function el(tag, cls, text) { const e = document.createElement(tag); if (cls) e.className = cls; if (text !== undefined) e.textContent = text; return e; }
function say(id, out, good) { $(id).className = `status ${good ? 'good' : 'err'}`; $(id).textContent = good ? out : api.outcomeWords(lang, out); }
const segmentWords = (s) => t(`segment_${s}`);

// ── W1: the summary cards and the office register (window.sreOffice, from the shared chrome) ──────────────────────
// Every figure is head office's answer; before it answers the cards say "Not known" and the register says it is reading;
// when it cannot answer the register says why (no link · not your role · refused) — never an empty "all clear" list.
let register = null;
let overviewOut = null;
const office = () => window.sreOffice ?? null;
const SEGMENTS = ['loyal', 'regular', 'new', 'lapsing', 'lapsed', 'insufficient_history', 'not_profiled'];
function paintRegister() {
  const o = office();
  if (o === null) return; // the chrome draws them the moment it loads (sre:chrome)
  const counts = overview?.counts ?? null;
  const cards = o.cards($('counts'), SEGMENTS.map((s) => ({
    label: segmentWords(s),
    value: counts === null ? null : (counts[s] ?? 0),
    note: t('segmentCount'),
    tone: s === 'not_profiled' && (counts?.[s] ?? 0) > 0 ? 'pending' : undefined,
  })));
  [...cards.children].forEach((card, i) => { card.dataset.segment = SEGMENTS[i]; });
  const host = $('customer-register');
  if (register === null || !host.contains(document.getElementById('customers-table'))) {
    register = o.table(host, {
      id: 'customers', label: { en: customersWord('en', 'registerLabel'), ta: customersWord('ta', 'registerLabel') }, bodyId: 'customer-rows', pageSize: 10,
      rows: null,
      rowKey: (c) => c.customerRef,
      rowData: (c) => ({ customer: c.customerRef, segment: c.segment, profiled: String(c.profiled) }),
      empty: { title: { en: customersWord('en', 'emptyCustomers'), ta: customersWord('ta', 'emptyCustomers') }, detail: { en: customersWord('en', 'emptyCustomersDetail'), ta: customersWord('ta', 'emptyCustomersDetail') } },
      columns: [
        { key: 'customerRef', label: both('colCustomer'), sort: 'text' },
        { key: 'segment', label: both('colSegment'), sort: 'text', filter: true, value: (c) => both(`segment_${c.segment}`) },
        { key: 'orders', label: both('colBills'), sort: 'number', align: 'end', value: (c) => c.orders },
        { key: 'lastOrderAt', label: both('colLastBill'), sort: 'text', value: (c) => (c.lastOrderAt === null ? both('noOrder') : shopDayOf(c.lastOrderAt)) },
      ],
      drawer: {
        title: (c) => c.customerRef,
        body: (c) => {
          const box = document.createElement('div');
          box.append(o.facts([
            [both('colCustomer'), c.customerRef], [both('colSegment'), segmentWords(c.segment)], [both('colBills'), String(c.orders)],
            [both('colLastBill'), c.lastOrderAt === null ? t('noOrder') : shopDayOf(c.lastOrderAt)],
          ]));
          if (may.record) {
            const b = el('button', 'sre-btn sre-btn-primary', t('recordFromRow'));
            b.type = 'button';
            b.addEventListener('click', () => { o.closeDrawer(); $('record-ref').value = c.customerRef; void openRecord(); $('record-h').scrollIntoView({ block: 'start' }); });
            box.append(b);
          }
          return box;
        },
      },
    });
  }
  if (overview !== null) register.setRows(overview.customers ?? []);
  else if (overviewOut !== null) register.setState(o.stateOf(overviewOut), { detail: api.outcomeWords(lang, overviewOut) });
  else if (!may.read) register.setState('denied', { detail: t(may.named ? 'cannotRead' : 'nobody') });
  else register.setRows(null);
}
/** A word of this page in both languages, so the register redraws itself in the reader's language. */
const both = (k) => ({ en: customersWord('en', k), ta: customersWord('ta', k) });
const customersWord = (l, k) => (api === null ? k : api.words(l, k));
document.addEventListener('sre:chrome', () => paintRegister());

/** An empty list item that says "nothing yet" in the shared look (never "all clear" — P-08). */
function nothingYet() { const li = el('li', 'row empty'); li.textContent = t('none'); return li; }
function mergeLine(m) { return `${m.mergedRef} ${t('into')} ${m.survivorRef} — ${m.reason} (${t('by')} ${m.proposedBy}${m.approvedBy ? `, ${m.approvedBy}` : ''})`; }

function paint() {
  document.title = `SRE ${t('title')}`;
  for (const [id, k] of [['title-text', 'title'], ['page-h', 'title'], ['lead', 'lead'], ['refresh', 'refresh'], ['segments-h', 'segmentsH'], ['duplicates-h', 'duplicatesH'], ['l-candidates', 'candidates'], ['check', 'check'], ['pending-h', 'pendingH'], ['inforce-h', 'inForceH'], ['reversed-h', 'reversedH']]) $(id).textContent = t(k);
  $('lang').textContent = t('lang');
  $('whoami').textContent = window.customersData?.userId ?? '';
  $('nobody').hidden = may.named; $('nobody').textContent = t('nobody');
  $('check').disabled = !may.read; $('refresh').disabled = !may.read; whyDisabled($('check'), may.read ? '' : 'role'); whyDisabled($('refresh'), may.read ? '' : 'role');
  paintRecord();

  paintRegister();

  $('matches').replaceChildren(...(matches === null ? [] : matches.length === 0 ? [el('li', 'row', t('noDuplicates'))] : matches.map((m) => {
    const li = el('li', `row ${m.disposition === 'merge_candidate' ? 'tone-degraded' : ''}`);
    li.dataset.pair = `${m.customerIds[0]}+${m.customerIds[1]}`; li.dataset.disposition = m.disposition;
    li.append(el('span', '', `${m.customerIds[0]} · ${m.customerIds[1]} — ${t(m.disposition)}`));
    if (may.propose) {
      const f = el('form'); const label = el('label'); const input = el('input'); input.className = 'reason'; input.autocomplete = 'off';
      label.append(el('span', '', t('reason')), input);
      const b = el('button', 'propose', t('propose')); b.type = 'submit';
      f.append(label, b);
      f.addEventListener('submit', (e) => { e.preventDefault(); void propose(m.customerIds[0], m.customerIds[1], input.value); });
      li.append(f);
    }
    return li;
  })));

  const merges = overview?.merges ?? { waitingForSecondPerson: [], inForce: [], reversed: [] };
  $('pending').replaceChildren(...(merges.waitingForSecondPerson.length === 0 ? [nothingYet()] : merges.waitingForSecondPerson.map((m) => {
    const li = el('li', 'row tone-degraded', ''); li.dataset.merge = m.mergeId;
    li.append(el('span', '', mergeLine(m)));
    if (may.approve) { const b = el('button', 'approve', t('approve')); b.type = 'button'; b.addEventListener('click', () => { void approve(m.mergeId); }); li.append(b); }
    return li;
  })));
  $('inforce').replaceChildren(...(merges.inForce.length === 0 ? [nothingYet()] : merges.inForce.map((m) => {
    const li = el('li', 'row tone-ok'); li.dataset.merge = m.mergeId;
    li.append(el('span', '', mergeLine(m)));
    if (may.approve) {
      const f = el('form'); const label = el('label'); const input = el('input'); input.className = 'undo-reason'; input.autocomplete = 'off';
      label.append(el('span', '', t('undoReason')), input);
      const b = el('button', 'undo', t('undo')); b.type = 'submit';
      f.append(label, b);
      f.addEventListener('submit', (e) => { e.preventDefault(); void undo(m.mergeId, input.value); });
      li.append(f);
    }
    return li;
  })));
  $('reversed').replaceChildren(...(merges.reversed.length === 0 ? [nothingYet()] : merges.reversed.map((m) => {
    const li = el('li', 'row'); li.dataset.merge = m.mergeId;
    li.append(el('span', '', `${mergeLine(m)} — ${m.reversalReason ?? ''}`));
    return li;
  })));
}

// ── M16-FR-04 · one customer's record, complaints first ──────────────────────────────────────────────────────────────
const MARK = { open: '⚠', waiting_on_customer: '⏱', resolved: '✓', closed: '✓' };
function caseItem(c) {
  const li = el('li', `row ${c.state === 'open' || c.state === 'waiting_on_customer' ? 'tone-degraded' : 'tone-ok'}`);
  li.dataset.case = c.caseId; li.dataset.state = c.state; li.dataset.kind = c.kind;
  li.append(el('strong', '', `${MARK[c.state] ?? '○'} ${c.caseId} — ${t(`state_${c.state}`)} · ${shopDayOf(c.openedAt)}`));
  li.append(el('span', 'summary', c.summary));
  if (c.orderRef) li.append(el('span', 'muted', `${t('order')} ${c.orderRef}`));
  if (c.resolution) li.append(el('span', 'muted', `✓ ${t('answered')}: ${c.resolution}`));
  return li;
}
function paintRecord() {
  for (const [id, k] of [['record-h', 'recordH'], ['l-record-ref', 'recordRef'], ['record-open-text', 'open'], ['complaints-h', 'complaintsH'], ['othercases-h', 'otherCasesH'],
    ['household-h', 'householdH'], ['l-household-id', 'householdId'], ['household-link-text', 'link'], ['household-unlink-text', 'unlink'], ['history-h', 'historyH']]) $(id).textContent = t(k);
  paintHousehold();
  $('record-open').disabled = !may.record; whyDisabled($('record-open'), may.record ? '' : 'role');
  $('record').hidden = record === null;
  if (record === null) return;
  $('record').dataset.customer = record.customerRef;
  if (record.mergedInto !== undefined) {
    $('record-summary').textContent = `${t('mergedInto')} ${record.mergedInto}`;
    $('record-say').textContent = ''; $('record-complaints').replaceChildren(); $('record-other').replaceChildren();
    return;
  }
  const p = record.purchases ?? { count: 0, grossMinor: 0 };
  $('record-summary').textContent = `${t('bought')}: ${p.count} ${t('orders')} · ${t('netSpend')} ₹${((record.netSpendMinor ?? 0) / 100).toFixed(2)}${record.lastPurchaseAt ? ` · ${t('lastBill')} ${shopDayOf(record.lastPurchaseAt)}` : ''}`;
  const sh = record.serviceHistory;
  if (sh === undefined || sh.read !== true) {
    $('record-say').className = 'status err'; $('record-say').textContent = `⚠ ${sh?.say ?? ''}`;
    $('record-complaints').replaceChildren(); $('record-other').replaceChildren();
    return;
  }
  $('record-say').className = `status ${sh.complaints.open > 0 ? 'err' : 'good'}`;
  $('record-say').textContent = sh.complaints.count === 0 ? `✓ ${t('noComplaints')}` : `${sh.complaints.open > 0 ? '⚠' : '✓'} ${sh.complaints.count} — ${sh.complaints.open} ${t('openComplaintsK')}`;
  $('record-say').dataset.open = String(sh.complaints.open);
  $('record-complaints').replaceChildren(...(sh.complaints.recent.length === 0 ? [el('li', 'row', t('noComplaints'))] : sh.complaints.recent.map(caseItem)));
  $('record-other').replaceChildren(...(sh.otherCases.recent.length === 0 ? [nothingYet()] : sh.otherCases.recent.map(caseItem)));
}
// ── M16-FR-01 (W3) · the record's household and identity history ─────────────────────────────────────────────────────
let history = null;
function paintHousehold() {
  if (record === null || record.mergedInto !== undefined) { $('record-household').textContent = ''; $('household-form').hidden = true; $('record-history').replaceChildren(); return; }
  const h = record.household ?? null;
  $('record-household').textContent = h === null ? t('noHousehold') : `${t('inHousehold')} ${h.householdId} — ${h.members.length} ${t('householdMembers')}: ${h.members.join(', ')}`;
  $('record-household').dataset.household = h === null ? '' : h.householdId;
  $('household-form').hidden = !may.propose;
  $('household-unlink').hidden = h === null;
  $('record-history').replaceChildren(...(history === null ? [] : history.length === 0 ? [el('li', 'row', t('noHistory'))] : history.map((m) => {
    const state = m.reversedBy ? 'reversed' : m.inForce ? 'inforce' : 'proposed';
    const li = el('li', 'row'); li.dataset.merge = m.mergeId; li.dataset.state = state;
    li.append(el('span', '', `${mergeLine(m)} · ${t(`merge_${state}`)}`));
    return li;
  })));
}
async function readHistory(ref) {
  const out = await session.identityHistory(ref);
  history = out.result === 'ok' ? out.value.merges : null;
}
async function changeHousehold(unlink) {
  const ref = record?.customerRef ?? '';
  const out = unlink ? await session.unlinkHousehold(ref) : await session.linkHousehold(ref, $('household-id').value);
  if (out.result !== 'ok') { say('household-status', out, false); return; }
  say('household-status', t(unlink ? 'unlinked' : 'linked'), true);
  const again = await session.record(ref);
  if (again.result === 'ok') record = again.value;
  paint();
}
$('household-form').addEventListener('submit', (e) => { e.preventDefault(); void changeHousehold(false); });
$('household-unlink').addEventListener('click', () => { void changeHousehold(true); });

async function openRecord(event) {
  event?.preventDefault();
  const out = await session.record($('record-ref').value);
  if (out.result === 'ok') { record = out.value; $('record-status').className = 'status'; $('record-status').textContent = ''; await readHistory(record.customerRef); } else { record = null; history = null; say('record-status', out, false); }
  $('household-status').textContent = '';
  paint();
}
$('record-form').addEventListener('submit', (e) => { void openRecord(e); });
{ const i = typeof window.sreIcon === 'function' ? window.sreIcon('user-round', 18) : null; if (i !== null) $('record-open').prepend(i, ' '); }

async function load() {
  const out = await session.overview();
  overviewOut = out;
  if (out.result === 'ok') { overview = out.value; $('page-status').className = 'status'; $('page-status').textContent = ''; } else { overview = null; say('page-status', out, false); }
  paint();
}
async function check(event) {
  event?.preventDefault();
  const out = await session.duplicates($('candidates').value);
  if (out.result === 'ok') { matches = out.value.matches; $('dup-status').className = 'status'; $('dup-status').textContent = ''; } else { matches = null; say('dup-status', out, false); }
  paint();
}
async function propose(survivor, merged, reason) {
  const out = await session.propose(survivor, merged, reason);
  if (out.result === 'ok') { say('merge-status', t('proposed'), true); await load(); } else say('merge-status', out, false);
}
async function approve(mergeId) {
  const out = await session.approve(mergeId);
  if (out.result === 'ok') { say('merge-status', t('approved'), true); await load(); } else say('merge-status', out, false);
}
async function undo(mergeId, reason) {
  const out = await session.undo(mergeId, reason);
  if (out.result === 'ok') { say('merge-status', t('undone'), true); await load(); } else say('merge-status', out, false);
}

$('dup-form').addEventListener('submit', (e) => { void check(e); });
$('refresh').addEventListener('click', () => { void load(); });
$('lang').addEventListener('click', () => { lang = lang === 'en' ? 'ta' : 'en'; document.documentElement.lang = lang; paint(); });
paint();
if (may.named && !may.read) { $('page-status').className = 'status err'; $('page-status').textContent = t('cannotRead'); }
else if (may.read) void load();

if ('serviceWorker' in navigator) {
  navigator.serviceWorker.register('./sw.js').catch(() => {
    // No offline copy this time; the screen still works online.
  });
}

/** A greyed button says why (U1 · G3 · design system §4 "disabled state explains why"): the reason is the button's tooltip
 *  and the words beside it, in the reader's language. `why` is 'role' (your role may not), 'offline' (head office cannot
 *  be reached), a page's own { en, ta } pair or sentence; '' takes the words away. */
function whyWords() {
  return {
  role: { en: 'Your role may not do this.', ta: 'உங்கள் பங்குக்கு இதைச் செய்ய அனுமதி இல்லை.' },
  offline: { en: 'Head office cannot be reached, so this cannot be done now.', ta: 'தலைமை அலுவலகத்தை அடைய முடியவில்லை, எனவே இப்போது இதைச் செய்ய முடியாது.' },
  };
}
function whyDisabled(btn, why) {
  const tongue = document.documentElement.lang === 'ta' ? 'ta' : 'en';
  const words = why === '' || why === undefined || why === null ? '' : typeof why === 'string' ? (whyWords()[why]?.[tongue] ?? why) : (why[tongue] ?? why.en);
  let note = btn.nextElementSibling;
  if (!(note && note.classList.contains('sre-why'))) {
    note = document.createElement('small'); note.className = 'sre-why';
    note.id = `${btn.id || `b${Math.random().toString(36).slice(2, 7)}`}-why`;
    btn.after(note);
  }
  note.textContent = words; note.hidden = words === '';
  if (words === '') { btn.removeAttribute('title'); btn.removeAttribute('aria-describedby'); } else { btn.title = words; btn.setAttribute('aria-describedby', note.id); }
}
