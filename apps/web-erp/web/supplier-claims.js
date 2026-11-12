// Supplier claims — the page over head office's one claims register (U6 · M07-FR-03 · M24-FR-02). The session
// (apps/web-erp/src/supplier-claims-session.ts, in the bundle as window.supplierClaims) does every call and every rule; this
// page lays out what it is told on the shared office parts (window.sreOffice: cards, table, state, chip, confirm). Every word
// has a Tamil twin; head office's own sentences stay in English (OB-553). Money moves only after the confirm sheet (OB-698).

const $ = (id) => document.getElementById(id);
const api = window.supplierClaims ?? null;
const session = api?.session ?? null;
const may = session?.may ?? { named: false, read: false, issue: false, decide: false };
let lang = 'en';
const t = (k) => (api === null ? k : api.words(lang, k));
const both = (k) => (api === null ? { en: k, ta: k } : { en: api.words('en', k), ta: api.words('ta', k) });
const office = () => window.sreOffice ?? null;
const icon = (name) => (typeof window.sreIcon === 'function' ? window.sreIcon(name, 18) : null);
const shopDayOf = (value) => window.sreShopDay?.dateOf(value) ?? value;
const shopTime = (at) => (at === null ? '' : window.sreShopDay?.dateTimeOf(at) ?? at);
const fill = (words, vars) => words.replace(/\{(\w+)\}/g, (_m, k) => String(vars[k] ?? ''));
function text(tag, words, cls) { const n = document.createElement(tag); n.textContent = words; if (cls) n.className = cls; return n; }
/** A greyed button says why (U1 · design system §4): the words sit in a small line after it, in the reader's language. */
function whyDisabled(btn, why) {
  let note = btn.nextElementSibling;
  if (!(note && note.classList.contains('sre-why'))) { note = document.createElement('small'); note.className = 'sre-why'; note.id = `${btn.id || `b${Math.random().toString(36).slice(2, 7)}`}-why`; btn.after(note); }
  note.textContent = why; note.hidden = why === '';
  if (why === '') btn.removeAttribute('aria-describedby'); else btn.setAttribute('aria-describedby', note.id);
}

let reg = null; let outcome = null; let readAt = null;
const money = (minor) => (minor === null ? t('notKnownValue') : api.rupees(minor));
const quantity = (c) => (c.quantityMinor === null ? '' : (c.uom && c.uom !== 'ea' ? `${(c.quantityMinor / 1000).toFixed(3)} ${c.uom}` : String(c.quantityMinor)));
const supplierOf = (id) => { const o = office(); const known = api.supplierLabel(reg, id); if (known !== id) return known; const n = o ? o.nameOf('supplier', id) : id; return n && n !== id ? `${n} (${id})` : id; };
const personOf = (id) => { const o = office(); const n = o ? o.nameOf('person', id) : id; return n && n !== id ? n : id; };

/** Issue a debit note: money leaves the supplier's balance — the confirm sheet says the figure and the name first (OB-698). */
async function issue(c, status) {
  const o = office();
  const ok = o === null ? { ok: true } : await o.confirm({
    title: fill(t('issueTitle'), { value: money(c.valueMinor), supplier: supplierOf(c.supplierId) }), detail: t('issueDetail'), authority: t('authority'), confirmLabel: t('issue'), tone: 'primary',
  });
  if (!ok.ok) { status.textContent = t('notConfirmed'); return; }
  status.textContent = t('reading');
  const out = await session.issue(c);
  status.textContent = out.result === 'ok' ? t('issued') : api.outcomeWords(lang, out);
  if (out.result === 'ok') await load();
}
/** Decide a supplier's claim: accepting is money, so the confirm sheet first; rejecting needs the reason alone. */
async function decide(c, decision, reason, status) {
  const o = office();
  if (reason.trim() === '') { status.textContent = t('needReason'); return; }
  if (decision === 'accept' && o !== null) {
    const ok = await o.confirm({ title: fill(t('acceptTitle'), { value: money(c.claimMinor), supplier: supplierOf(c.supplierId) }), detail: t('acceptDetail'), authority: t('authority'), confirmLabel: t('confirmAccept'), tone: 'primary' });
    if (!ok.ok) { status.textContent = t('notConfirmed'); return; }
  }
  status.textContent = t('reading');
  const out = await session.decide(c, decision, reason);
  status.textContent = out.result === 'ok' ? t('decided') : api.outcomeWords(lang, out);
  if (out.result === 'ok') await load();
}

function paintShop() {
  const o = office(); if (o === null || reg === null) return;
  $('unattributed').hidden = reg.unattributed.length === 0;
  $('unattributed').textContent = reg.unattributed.length === 0 ? '' : `${t('notAttributed')} ${reg.unattributed.map((u) => u.grnId).join(', ')}`;
  if (reg.shopClaims.length === 0) { o.state($('shop-table'), 'empty', { title: t('noneShop'), detail: t('noneShopDetail') }); return; }
  o.table($('shop-table'), {
    id: 'shop-claims', label: both('shopH'), rows: reg.shopClaims, pageSize: 10, sortable: true,
    rowKey: (c) => c.claimId, rowData: (c) => ({ claim: c.claimId, supplier: c.supplierId, kind: c.kind, state: c.state }),
    columns: [
      { key: 'supplierId', label: both('supplier'), sort: 'text', filter: true, value: (c) => supplierOf(c.supplierId) },
      { key: 'kind', label: both('what'), sort: 'text', filter: true, value: (c) => t(`kind_${c.kind}`) },
      { key: 'productId', label: both('product'), sort: 'text', value: (c) => (c.productId === null ? null : (o.nameOf('product', c.productId) || c.productId)) },
      { key: 'quantityMinor', label: both('quantity'), sort: 'number', align: 'end', value: (c) => quantity(c) || null },
      { key: 'valueMinor', label: both('value'), sort: 'number', align: 'end', value: (c) => money(c.valueMinor) },
      { key: 'state', label: both('state'), sort: 'text', filter: true, value: (c) => t(`state_${c.state}`), render: (c) => o.chip(api.stateTone(c.state), t(`state_${c.state}`)) },
      { key: 'number', label: both('number'), sort: 'text', value: (c) => c.number },
      { key: 'raisedAt', label: both('raisedOn'), sort: 'text', value: (c) => shopDayOf(c.raisedAt) },
    ],
    drawer: {
      title: (c) => `${t(`kind_${c.kind}`)} · ${c.claimId}`,
      body: (c) => {
        const box = document.createElement('div');
        box.append(o.facts([[both('supplier'), supplierOf(c.supplierId)], [both('delivery'), c.grnId], [both('order'), c.poId ?? '—'], [both('product'), c.productId ?? '—'], [both('quantity'), quantity(c) || '—'],
          [both('value'), money(c.valueMinor)], [both('reason'), c.reason], [both('state'), t(`state_${c.state}`)], [both('number'), c.number ?? '—'], [both('raisedOn'), shopDayOf(c.raisedAt)]]));
        if (c.kind === 'debit_note' && c.state === 'raised') {
          const b = document.createElement('button'); b.type = 'button'; b.id = `issue-${c.claimId}`; b.className = 'sre-btn sre-btn-primary'; b.textContent = t('issue'); b.dataset.act = 'issue';
          b.disabled = !may.issue;
          const status = text('p', '', 'status'); status.setAttribute('role', 'status');
          b.addEventListener('click', () => { o.closeDrawer(); void issue(c, $('shop-status')); });
          box.append(b); whyDisabled(b, may.issue ? '' : t('cannotIssue')); box.append(status);
        }
        return box;
      },
    },
    empty: { title: t('noneShop'), detail: t('noneShopDetail') },
  });
}

function paintSupplier() {
  const o = office(); if (o === null || reg === null) return;
  if (reg.supplierClaims.length === 0) { o.state($('sup-table'), 'empty', { title: t('noneSupplier'), detail: t('noneSupplierDetail') }); return; }
  o.table($('sup-table'), {
    id: 'supplier-claims', label: both('supplierH'), rows: reg.supplierClaims, pageSize: 10, sortable: true,
    rowKey: (c) => c.submissionId, rowData: (c) => ({ submission: c.submissionId, supplier: c.supplierId, state: c.state }),
    columns: [
      { key: 'supplierId', label: both('supplier'), sort: 'text', filter: true, value: (c) => supplierOf(c.supplierId) },
      { key: 'poId', label: both('order'), sort: 'text', value: (c) => c.poId },
      { key: 'claimMinor', label: both('claimed'), sort: 'number', align: 'end', value: (c) => money(c.claimMinor) },
      { key: 'why', label: both('why') },
      { key: 'state', label: both('state'), sort: 'text', filter: true, value: (c) => t(`state_${c.state}`), render: (c) => o.chip(api.stateTone(c.state), t(`state_${c.state}`)) },
      { key: 'receivedAt', label: both('receivedOn'), sort: 'text', value: (c) => shopDayOf(c.receivedAt) },
    ],
    drawer: {
      title: (c) => `${supplierOf(c.supplierId)} · ${c.submissionId}`,
      body: (c) => {
        const box = document.createElement('div');
        box.append(o.facts([[both('supplier'), supplierOf(c.supplierId)], [both('order'), c.poId ?? '—'], [both('claimed'), money(c.claimMinor)], [both('why'), c.why || '—'], [both('receivedOn'), shopDayOf(c.receivedAt)],
          [both('state'), t(`state_${c.state}`)], ...(c.decidedBy === null ? [] : [[both('decidedBy'), personOf(c.decidedBy)], [both('reason'), c.reason ?? '—']])]));
        if (c.state === 'awaiting_buyer') {
          const form = document.createElement('div'); form.className = 'decide';
          form.append(o.field({ id: `reason-${c.submissionId}`, label: both('reason'), required: true }));
          const yes = document.createElement('button'); yes.type = 'button'; yes.className = 'sre-btn sre-btn-primary'; yes.textContent = t('accept'); yes.dataset.act = 'accept'; yes.id = `accept-${c.submissionId}`;
          const no = document.createElement('button'); no.type = 'button'; no.className = 'sre-btn sre-btn-quiet'; no.textContent = t('reject'); no.dataset.act = 'reject'; no.id = `reject-${c.submissionId}`;
          yes.disabled = !may.decide; whyDisabled(yes, may.decide ? '' : t('cannotDecide'));
          no.disabled = !may.decide; whyDisabled(no, may.decide ? '' : t('cannotDecide'));
          const acts = document.createElement('div'); acts.className = 'actions'; acts.append(yes, no);
          const reasonOf = () => $(`reason-${c.submissionId}`)?.value ?? '';
          yes.addEventListener('click', () => { const r = reasonOf(); o.closeDrawer(); void decide(c, 'accept', r, $('sup-status')); });
          no.addEventListener('click', () => { const r = reasonOf(); o.closeDrawer(); void decide(c, 'reject', r, $('sup-status')); });
          form.append(acts); box.append(form);
        }
        return box;
      },
    },
    empty: { title: t('noneSupplier'), detail: t('noneSupplierDetail') },
  });
}

function paint() {
  const o = office();
  $('title-text').textContent = t('title'); document.title = `SRE ${t('title')}`; $('page-h').textContent = t('title'); $('lead').textContent = t('lead');
  $('lang').textContent = lang === 'en' ? 'தமிழ்' : 'English';
  $('reload-text').textContent = t('refresh'); $('shop-h').textContent = t('shopH'); $('shop-lead').textContent = t('shopLead'); $('sup-h').textContent = t('supplierH'); $('sup-lead').textContent = t('supplierLead');
  $('covers').textContent = ''; $('cards').replaceChildren(); $('note').textContent = '';
  if (!may.read) return;
  if (outcome !== null) {
    $('page-status').textContent = api.outcomeWords(lang, outcome);
    if (o !== null) { o.state($('shop-table'), o.stateOf(outcome), { title: t('notKnown'), detail: t('notKnownDetail') }); o.state($('sup-table'), o.stateOf(outcome), { title: t('notKnown'), detail: t('notKnownDetail') }); }
    return;
  }
  if (reg === null) { if (o !== null) { o.state($('shop-table'), 'loading'); o.state($('sup-table'), 'loading'); } return; }
  $('page-status').textContent = '';
  $('covers').textContent = t('covers').split('{time}').join(shopTime(readAt));
  $('note').textContent = t('headOfficeEnglish');
  if (o !== null) {
    o.cards($('cards'), [
      { label: both('state_raised'), value: reg.counts.raised ?? 0, tone: (reg.counts.raised ?? 0) > 0 ? 'pending' : undefined, icon: 'receipt-text' },
      { label: both('state_issued'), value: reg.counts.issued ?? 0, icon: 'receipt' },
      { label: both('state_never_owed'), value: reg.counts.neverOwed ?? 0, icon: 'package-minus' },
      { label: both('state_pending'), value: reg.counts.returnPending ?? 0, tone: (reg.counts.returnPending ?? 0) > 0 ? 'pending' : undefined, icon: 'truck' },
      { label: both('state_awaiting_buyer'), value: reg.counts.awaitingBuyer ?? 0, tone: (reg.counts.awaitingBuyer ?? 0) > 0 ? 'pending' : undefined, icon: 'clock' },
    ]);
  }
  paintShop(); paintSupplier();
}

async function load() {
  $('page-status').textContent = t('reading');
  const out = await session.register();
  if (out.result === 'ok') { reg = out.value; outcome = null; readAt = new Date().toISOString(); } else { reg = null; outcome = out; }
  paint();
}

{ const i = icon('refresh-cw'); if (i !== null) $('reload').prepend(i); }
$('lang').addEventListener('click', () => { lang = lang === 'en' ? 'ta' : 'en'; document.documentElement.lang = lang; paint(); });
$('reload').addEventListener('click', () => { void load(); });
paint();
if (!may.named) $('page-status').textContent = t('nobody');
else if (!may.read) $('page-status').textContent = t('cannotRead');
else { $('reload').hidden = false; $('shop').hidden = false; $('supplier').hidden = false; void load(); }
document.addEventListener('sre:chrome', () => { paint(); });
