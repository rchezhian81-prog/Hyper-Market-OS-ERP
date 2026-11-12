// The write-off capture page's line-down parts (M28-FR-01 "queued; approval on sync") — drawn under the capture form
// (write-off-capture.js). The sessions (apps/web-erp/src/write-off-queue-session.ts) are in the bundle as
// window.writeOffQueue (a loss saved on this screen for the store computer to carry) and window.writeOffDecide (the
// captured losses waiting at head office for a second person). This file only draws what they say. Every word has a
// Tamil twin; every button carries an icon beside its word.

const el = (id) => document.getElementById(id);
// U5 · G17: the chrome's shared parts (window.sreOffice) may load after this page — each part is drawn once it is there,
// and the page keeps its words meanwhile. States are the chrome's chips and state boxes, never a ✓/⚠ character.
const sreO = () => window.sreOffice ?? null;
/** The chrome's "Not known" in the reader's language — never a dash. */
const notKnownWord = () => { const o = sreO(); return o && typeof o.words === 'function' ? o.words('notKnown') : 'Not known'; };
/** A status line said with a chip and words: the state's chip first, then the words (in their own span when it has an id). */
function sayWith(holder, state, words, textId) {
  const o = sreO(); const s = document.createElement('span'); if (textId) s.id = textId; s.textContent = words;
  holder.replaceChildren(...(o && state !== null ? [o.recordChip(state), ' '] : []), s);
}

// ── U2 (UI/UX gap audit G5 · P-07): a thing is PICKED by name through the chrome's picker, never typed as a code ───────
// The field keeps the id the page sends (the typed code stays possible when the list cannot be read — head office down,
// no right — so the form is never a dead end, P-01 · P-08); the chrome's sheet finds it by name, code or barcode and the
// name is shown beside the field. Mounted when the chrome is there (a page that paints first listens for `sre:chrome`).
const pickWords = {
  en: { choose: 'Choose…', pickProduct: 'Which product?', pickPlace: 'Which place in the store?', pickPerson: 'Which person?', pickStore: 'Which store?', pickCustomer: 'Which customer?', pickApproval: 'Which approval?' },
  ta: { choose: 'தேர்ந்தெடு…', pickProduct: 'எந்தப் பொருள்?', pickPlace: 'கடையில் எந்த இடம்?', pickPerson: 'எந்த நபர்?', pickStore: 'எந்தக் கடை?', pickCustomer: 'எந்த வாடிக்கையாளர்?', pickApproval: 'எந்த அனுமதி?' },
};
function pickable(inputId, kind, titleKey, extra = {}) {
  const input = document.getElementById(inputId);
  if (!input || input.dataset.pickable === 'on') return;
  const o = sreO();
  if (!o || typeof o.pickable !== 'function') { document.addEventListener('sre:chrome', () => pickable(inputId, kind, titleKey, extra), { once: true }); return; }
  o.pickable(input, kind, { en: pickWords.en[titleKey], ta: pickWords.ta[titleKey] }, extra);
}
const q = window.writeOffQueue ?? null;
const dec = window.writeOffDecide ?? null;
const lang = () => (document.documentElement.lang === 'ta' ? 'ta' : 'en');
const w = (k) => (q !== null ? q.text(lang(), k) : dec !== null ? dec.words(lang(), k) : k);
// U1 · OB-698 (design system §1.3, §27.1): a money/stock click asks the shared consequence-and-confirm sheet first.
// `null` = the person went back (nothing is sent); 'unavailable' = the sheet could not open (said, never silent).
async function confirmFirst(spec) {
  const office = window.sreOffice;
  if (!office || typeof office.confirm !== 'function') return 'unavailable';
  const answer = await office.confirm(spec);
  return answer && answer.ok === true ? answer : null;
}

const icon = (name) => (typeof window.sreIcon === 'function' ? window.sreIcon(name, 18) : null);
function text(tag, words, cls) { const n = document.createElement(tag); n.textContent = words; if (cls) n.className = cls; return n; }
function button(words, iconName, cls) { const b = document.createElement('button'); b.type = 'button'; b.className = `act ${cls ?? ''}`; const i = icon(iconName); if (i !== null) b.append(i); b.append(text('span', words)); return b; }
const rupees = (m) => `₹${(m / 100).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

function options(sel, values) {
  const keep = sel.value;
  sel.replaceChildren(...['', ...values].map((v) => { const o = document.createElement('option'); o.value = v; o.textContent = v === '' ? w('choose') : w(v); return o; }));
  sel.value = keep;
}
function paintQueue() {
  if (q === null) { el('woq').hidden = true; return; }
  el('woq').hidden = false;
  for (const [id, key] of [['woq-title', 'queueH'], ['woq-lead', 'queueLead'], ['woq-product-l', 'product'], ['woq-location-l', 'location'], ['woq-qty-l', 'qty'], ['woq-uom-l', 'uom'], ['woq-type-l', 'lossType'], ['woq-reason-l', 'reason'], ['woq-evidence-l', 'evidence'], ['woq-save-text', 'save'], ['woq-saved-h', 'savedH']]) el(id).textContent = w(key);
  options(el('woq-type'), q.lossTypes); options(el('woq-reason'), q.reasons);
  el('woq-form').hidden = !q.canCapture;
  const rows = q.saved(lang());
  el('woq-saved').replaceChildren(...(rows.length === 0 ? [text('li', w('noneSaved'))] : rows.map((r) => {
    const li = text('li', r.words); li.dataset.writeOff = r.writeOffId; li.dataset.state = r.state;
    if (r.reason) li.append(text('div', r.reason, 'exc'));
    return li;
  })));
}
async function syncQueue() {
  const relay = window.writeOffQueueRelay;
  if (!relay) return;
  try { await relay.syncNow(); } catch { /* kept on this device; the next pass tries again */ }
  paintQueue();
}
if (q !== null) {
  const i = icon('trash'); if (i !== null) el('woq-save').prepend(i);
  el('woq-form').addEventListener('submit', (ev) => {
    ev.preventDefault();
    void (async () => {
    // U1 · OB-698: the consequence-and-confirm sheet before the loss is saved for sending — Go back saves nothing. An
    // incomplete form skips the sheet and gets the queue's own words on what is missing (nothing is saved either way).
    const complete = ['woq-product', 'woq-location', 'woq-qty', 'woq-type', 'woq-reason'].every((id) => el(id).value.trim() !== '');
    const sub = (l, key) => String(q.text(l, key)).replace('{qty}', `${el('woq-qty').value} ${el('woq-uom').value}`.trim()).replace('{product}', el('woq-product').value);
    const answer = complete ? await confirmFirst({ title: { en: sub('en', 'confirmTitle'), ta: sub('ta', 'confirmTitle') }, detail: { en: sub('en', 'confirmDetail'), ta: sub('ta', 'confirmDetail') }, authority: { en: sub('en', 'confirmAuthority'), ta: sub('ta', 'confirmAuthority') }, confirmLabel: { en: sub('en', 'confirmLabel'), ta: sub('ta', 'confirmLabel') }, tone: 'danger' }) : { ok: true };
    if (answer === 'unavailable') { el('woq-result').hidden = false; sayWith(el('woq-result'), 'warning', w('confirmUnavailable'), 'woq-result-text'); return; }
    if (answer === null) return;
    const out = q.save(lang(), { productId: el('woq-product').value, locationId: el('woq-location').value, qty: el('woq-qty').value, uom: el('woq-uom').value, lossType: el('woq-type').value, reasonCode: el('woq-reason').value, evidenceRef: el('woq-evidence').value });
    el('woq-result').hidden = false; sayWith(el('woq-result'), out.ok ? 'done' : 'failed', out.ok ? w('stSavedHere') : out.words, 'woq-result-text');
    paintQueue(); void syncQueue();
    })();
  });
}

let pending = null;
function paintDecide() {
  if (dec === null || !dec.session.may.read) { el('wod').hidden = true; return; }
  el('wod').hidden = false;
  el('wod-title').textContent = w('pendingH');
  if (pending === null) return;
  el('wod-rows').replaceChildren(...(pending.captures.length === 0 ? [text('li', w('pendingNone'))] : pending.captures.map((r) => {
    const li = document.createElement('li'); li.dataset.writeOff = r.loss.writeOffId; li.dataset.state = r.state;
    li.append(text('strong', `${r.loss.productId} × ${r.loss.qty} ${r.loss.uom} · ${w(r.loss.lossType)} · ${w(r.loss.reasonCode)}`));
    li.append(text('span', `${w(r.state)} · ${w('raisedBy')} ${r.loss.raisedBy} · ${w('value')} ${r.valueMinor === undefined || r.valueMinor === null ? notKnownWord() : rupees(r.valueMinor)}${r.decisionReason ? ` · ${r.decisionReason}` : ''}`, 'lead'));
    if (r.state === 'awaiting_approval' && dec.session.may.decide) {
      const lab = document.createElement('label'); lab.append(text('span', w('why'))); const why = document.createElement('textarea'); why.className = 'wod-why'; lab.append(why);
      const ok = button(w('approve'), 'check', 'primary'); ok.dataset.act = 'approve';
      const no = button(w('reject'), 'x'); no.dataset.act = 'reject';
      const go = async (d) => { const out = await dec.session.decide(r.loss.writeOffId, d, why.value); el('wod-status').textContent = dec.outcomeWords(lang(), out); if (out.result === 'ok') await loadDecide(); };
      ok.addEventListener('click', () => { void go('approved'); }); no.addEventListener('click', () => { void go('rejected'); });
      li.append(lab, ok, no);
    }
    return li;
  })));
}
async function loadDecide() {
  if (dec === null || !dec.session.may.read) return;
  const o = await dec.session.pending();
  if (o.result === 'ok') pending = o.value; else el('wod-status').textContent = dec.outcomeWords(lang(), o);
  paintDecide();
}
el('lang').addEventListener('click', () => { paintQueue(); paintDecide(); });
// U2: the line-down loss and the free sample pick the item and the place by name too.
if (q !== null) { pickable('woq-product', 'product', 'pickProduct'); pickable('woq-location', 'place', 'pickPlace'); }
paintQueue(); paintDecide();
void loadDecide();

// ── FG-4 · OB-386: give a free sample (window.freeSample does the call; head office values it and works out the GST
//    credit to give back — the screen shows head office's sentence, never a figure of its own). ──
const fs = window.freeSample ?? null;
function paintFreeSample() {
  if (fs === null) return;
  const fw = (k) => fs.words(lang(), k);
  for (const [id, key] of [['fs-title', 'fsH'], ['fs-lead', 'fsLead'], ['fs-product-l', 'product'], ['fs-location-l', 'location'], ['fs-qty-l', 'qty'], ['fs-uom-l', 'uom'], ['fs-note-l', 'note'], ['fs-save-text', 'record']]) el(id).textContent = fw(key);
  { const i = typeof window.sreIcon === 'function' ? window.sreIcon('ticket', 18) : null; if (i !== null) el('fs-title').prepend(i, ' '); }
}
if (fs !== null && fs.session.may.named) {
  el('fs').hidden = false;
  { const i = typeof window.sreIcon === 'function' ? window.sreIcon('package-minus', 18) : null; if (i !== null) el('fs-save').prepend(i); }
  el('fs-save').disabled = !fs.session.may.record;
  el('fs-form').addEventListener('submit', async (event) => {
    event.preventDefault();
    const out = await fs.session.record({ productId: el('fs-product').value, locationId: el('fs-location').value, qty: el('fs-qty').value, uom: el('fs-uom').value, note: el('fs-note').value });
    const r = el('fs-result');
    r.dataset.result = out.result;
    sayWith(r, out.result === 'ok' ? 'done' : 'warning', out.result === 'ok' ? fs.words(lang(), 'recorded') : fs.outcomeWords(lang(), out));
    if (out.result === 'ok') { el('fs-qty').value = ''; el('fs-note').value = ''; if (pendingShown) void loadPending(); }
  });
  el('lang').addEventListener('click', () => { paintFreeSample(); });
  paintFreeSample();
  pickable('fs-product', 'product', 'pickProduct'); pickable('fs-location', 'place', 'pickPlace');
}

// ── OB-393: the free samples waiting for a store manager other than the giver. Read on a click, never on open; the giver's
//    own rows carry no buttons (head office refuses a self-approval by name anyway). ──
let pendingShown = false;
let pendingRows = null; // null = not read
function paintPending() {
  if (fs === null) return;
  const fw = (k) => fs.words(lang(), k);
  el('fsp-title').textContent = fw('pendingH');
  el('fsp-lead').textContent = fw('pendingLead');
  el('fsp-load-text').textContent = fw('loadPending');
  const rows = el('fsp-rows');
  if (pendingRows === null) { rows.replaceChildren(); return; }
  if (pendingRows.length === 0) { rows.replaceChildren(text('li', fw('pendingNone'), 'muted')); return; }
  rows.replaceChildren(...pendingRows.map((p) => {
    const li = document.createElement('li');
    li.className = 'row tone-degraded'; li.dataset.issue = p.issueId;
    li.append(text('strong', `⏳ ${p.qty} ${p.uom} ${p.productId} · ${p.locationId}`), text('span', `${p.note} — ${fw('givenBy')} ${p.requestedBy} · ${p.tradingDay}`, 'facts'));
    if (fs.session.viewerId !== null && p.requestedBy === fs.session.viewerId) { li.append(text('span', fw('yours'), 'muted')); return li; }
    if (!fs.session.may.approve) return li;
    const label = document.createElement('label');
    const reason = document.createElement('input'); reason.className = 'decision-reason'; reason.autocomplete = 'off'; reason.maxLength = 300;
    label.append(text('span', fw('decisionReason')), reason);
    const said = text('p', '', 'result'); said.setAttribute('role', 'status');
    const go = async (decision) => {
      const out = await fs.session.decide(p, decision, reason.value);
      said.dataset.result = out.result;
      if (out.result !== 'ok') { sayWith(said, 'warning', fs.outcomeWords(lang(), out)); return; }
      sayWith(el('fsp-said'), 'done', decision === 'approve' ? `${fw('approved')} ${out.value.itcWords ?? ''}` : fw('rejectedOk'));
      el('fsp-said').dataset.result = 'ok';
      await loadPending();
    };
    const yes = button(fw('approve'), 'check', 'primary'); yes.dataset.act = 'approve'; yes.addEventListener('click', () => { void go('approve'); });
    const no = button(fw('reject'), 'x'); no.dataset.act = 'reject'; no.addEventListener('click', () => { void go('reject'); });
    li.append(label, yes, no, said);
    return li;
  }));
}
async function loadPending() {
  const out = await fs.session.pending();
  pendingShown = true;
  if (out.result !== 'ok') { pendingRows = null; sayWith(el('fsp-said'), 'warning', fs.outcomeWords(lang(), out)); el('fsp-said').dataset.result = out.result; paintPending(); return; }
  pendingRows = out.value.pending;
  paintPending();
}
if (fs !== null && fs.session.may.named && (fs.session.may.approve || fs.session.may.record)) {
  el('fsp').hidden = false;
  { const i = icon('list-checks'); if (i !== null) el('fsp-load').prepend(i); }
  el('fsp-load').addEventListener('click', () => { void loadPending(); });
  el('lang').addEventListener('click', () => { paintPending(); });
  paintPending();
}
void syncQueue();
setInterval(() => { void syncQueue(); }, 15_000);
