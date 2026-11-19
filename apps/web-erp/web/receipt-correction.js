// Correct a saved receipt — the view layer of the box on Goods receipt review (R2 · batch 18c · OB-873). Every word and every
// request live in the TESTED session model (apps/web-erp/src/receipt-correction-session.ts, window.receiptCorrectionSession).
// The box draws itself at the foot of the page's <main>, so the page's own sections are untouched. It shows the receipt's
// lines as saved and as they stand now, and every correction with who asked, who approved and why — the original and the
// correction side by side. Nothing is sent until a button is pressed.

const api = window.receiptCorrectionSession ?? null;
const lang = () => (document.documentElement.lang === 'ta' ? 'ta' : 'en');
const w = (k) => (api === null ? k : api.words(lang(), k));
const mk = (tag, attrs = {}, text) => { const e = document.createElement(tag); for (const [k, v] of Object.entries(attrs)) e.setAttribute(k, v); if (text !== undefined) e.textContent = text; return e; };
let view = null;

function build() {
  const sec = mk('section', { id: 'grc-section', 'aria-labelledby': 'grc-h', class: 'card' });
  sec.append(
    mk('h2', { id: 'grc-h' }), mk('p', { id: 'grc-lede', class: 'help' }),
    (() => { const d = mk('div', { class: 'sre-field' }); d.append(mk('label', { for: 'grc-ref', id: 'grc-l-ref', class: 'sre-field-label' }), mk('input', { id: 'grc-ref', class: 'sre-input', autocomplete: 'off' })); return d; })(),
    mk('button', { id: 'grc-open', type: 'button', class: 'sre-btn sre-btn-secondary' }),
    mk('p', { id: 'grc-state', role: 'status' }),
    mk('div', { id: 'grc-lines' }), // U5: the lines are the shared register (sreOffice.table), never a plain table
    (() => { const d = mk('div', { class: 'sre-field' }); d.append(mk('label', { for: 'grc-line', id: 'grc-l-line', class: 'sre-field-label' }), mk('select', { id: 'grc-line', class: 'sre-input' })); return d; })(),
    (() => { const d = mk('div', { class: 'sre-field' }); d.append(mk('label', { for: 'grc-right', id: 'grc-l-right', class: 'sre-field-label' }), mk('input', { id: 'grc-right', class: 'sre-input', type: 'number', min: '0', step: '1', inputmode: 'numeric', autocomplete: 'off' })); return d; })(),
    (() => { const d = mk('div', { class: 'sre-field' }); d.append(mk('label', { for: 'grc-why', id: 'grc-l-why', class: 'sre-field-label' }), mk('input', { id: 'grc-why', class: 'sre-input', autocomplete: 'off', maxlength: '300' })); return d; })(),
    (() => { const d = mk('div', { class: 'buttons' }); d.append(mk('button', { id: 'grc-save', type: 'button', class: 'sre-btn sre-btn-primary' }), mk('button', { id: 'grc-ask', type: 'button', class: 'sre-btn sre-btn-secondary', hidden: '' })); return d; })(),
    mk('p', { id: 'grc-status', role: 'status', 'aria-live': 'polite' }),
    mk('h3', { id: 'grc-list-h' }), mk('ul', { id: 'grc-list' }),
  );
  const main = document.querySelector('main');
  main.append(sec);
}

const $ = (id) => document.getElementById(id);

// The receipt's lines — as saved and as they stand now — in the shared register (U5), one page, no search or sort.
let linesReg = null;
/** The session's own words for a key, in both languages, so the register repaints them on the language switch. */
const pair = (k) => ({ en: api === null ? k : api.words('en', k), ta: api === null ? k : api.words('ta', k) });
function linesRegister() {
  if (linesReg && linesReg.connected()) return linesReg;
  const host = $('grc-lines');
  if (!host || !window.sreOffice) return null;
  linesReg = window.sreOffice.table(host, {
    id: 'grc-lines-register', label: pair('line'), search: false, pageSize: 200,
    rowKey: (l) => l.lineId, rowData: (l) => ({ line: l.lineId }),
    columns: [
      { key: 'line', label: pair('line'), value: (l) => `${l.lineId} · ${l.productId}` },
      { key: 'receivedMinor', label: pair('received'), align: 'end', value: (l) => String(l.receivedMinor) },
      { key: 'nowMinor', label: pair('now'), align: 'end', value: (l) => String(l.nowMinor) },
    ],
    rows: [],
  });
  return linesReg;
}

function paint() {
  $('grc-h').textContent = w('heading'); $('grc-lede').textContent = w('lede');
  $('grc-l-ref').textContent = w('receipt'); $('grc-open').textContent = w('open');
  $('grc-l-line').textContent = w('line'); $('grc-l-right').textContent = w('right'); $('grc-l-why').textContent = w('why');
  $('grc-save').textContent = w('save'); $('grc-ask').textContent = w('ask'); $('grc-list-h').textContent = w('corrections');
  const sel = $('grc-line'); const list = $('grc-list');
  const reg = linesRegister();
  if (view === null) { if (reg) reg.setRows([]); sel.replaceChildren(); list.replaceChildren(); return; }
  const keep = sel.value;
  sel.replaceChildren(...view.lines.map((l) => mk('option', { value: l.lineId }, `${l.lineId} · ${l.productId}`)));
  if (keep) sel.value = keep;
  if (reg) reg.setRows(view.lines);
  list.replaceChildren(...(view.corrections.length === 0 ? [mk('li', {}, w('none'))] : view.corrections.map((c) => {
    const li = mk('li', { 'data-correction': c.correctionId }, `${c.documentNumber} · ${c.lineId} · ${c.wasMinor} → ${c.nowMinor} · ₹${(c.valueMinor / 100).toFixed(2)} · ${w('by')} ${c.requestedBy} · ${w('approved')} ${c.approvedBy} · “${c.reason}”`);
    for (const e of c.exceptions) li.append(mk('div', { class: 'exception' }, `${w('exception')} ${e}`));
    return li;
  })));
}

async function open() {
  const got = await api.open($('grc-ref').value);
  if (got === 'not_found' || got === 'lost_link') { view = null; $('grc-state').textContent = got === 'lost_link' ? w('lost') : w('notFound'); paint(); return; }
  // OB-875 B: head office's words when the receipt's month is filed or signed — said before anything is typed.
  view = got; $('grc-state').textContent = got.monthLocked ? `${got.receiptNumber} — ${got.monthLocked}` : `${got.receiptNumber}`; paint();
}

function say(out) {
  $('grc-status').textContent = api.outcomeWords(lang(), out);
  $('grc-ask').hidden = out.kind !== 'needs_approval';
}
const form = () => ({ lineId: $('grc-line').value, right: $('grc-right').value, why: $('grc-why').value });

if (api !== null && api.may && document.querySelector('main') !== null) {
  build(); paint();
  $('grc-open').addEventListener('click', () => { void open(); });
  $('grc-save').addEventListener('click', async () => {
    if (view === null) return;
    $('grc-save').disabled = true;
    try {
      const out = await api.save(view.grnId, form());
      say(out);
      if (out.kind === 'saved') { $('grc-right').value = ''; $('grc-why').value = ''; await open(); $('grc-status').textContent = api.outcomeWords(lang(), out); }
    } finally { $('grc-save').disabled = false; }
  });
  $('grc-ask').addEventListener('click', async () => {
    if (view === null) return;
    const f = form();
    say(await api.askApproval(view.grnId, f, `Correct ${view.receiptNumber} line ${f.lineId} to ${f.right}`));
  });
  $('lang')?.addEventListener('click', () => { setTimeout(paint, 0); });
  document.addEventListener('sre:chrome', () => paint());
}
