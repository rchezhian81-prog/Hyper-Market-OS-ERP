// The write-off capture page's line-down parts (M28-FR-01 "queued; approval on sync") — drawn under the capture form
// (write-off-capture.js). The sessions (apps/web-erp/src/write-off-queue-session.ts) are in the bundle as
// window.writeOffQueue (a loss saved on this screen for the store computer to carry) and window.writeOffDecide (the
// captured losses waiting at head office for a second person). This file only draws what they say. Every word has a
// Tamil twin; every button carries an icon beside its word.

const el = (id) => document.getElementById(id);
const q = window.writeOffQueue ?? null;
const dec = window.writeOffDecide ?? null;
const lang = () => (document.documentElement.lang === 'ta' ? 'ta' : 'en');
const w = (k) => (q !== null ? q.text(lang(), k) : dec !== null ? dec.words(lang(), k) : k);
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
    const out = q.save(lang(), { productId: el('woq-product').value, locationId: el('woq-location').value, qty: el('woq-qty').value, uom: el('woq-uom').value, lossType: el('woq-type').value, reasonCode: el('woq-reason').value, evidenceRef: el('woq-evidence').value });
    el('woq-result').hidden = false; el('woq-result-icon').textContent = out.ok ? '✓' : '✕'; el('woq-result-text').textContent = out.ok ? w('stSavedHere') : out.words;
    paintQueue(); void syncQueue();
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
    li.append(text('span', `${w(r.state)} · ${w('raisedBy')} ${r.loss.raisedBy} · ${w('value')} ${r.valueMinor === undefined || r.valueMinor === null ? '—' : rupees(r.valueMinor)}${r.decisionReason ? ` · ${r.decisionReason}` : ''}`, 'lead'));
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
    r.textContent = out.result === 'ok' ? `✓ ${fs.words(lang(), 'recorded')} ${out.value.itcWords}` : `⚠ ${fs.outcomeWords(lang(), out)}`;
    if (out.result === 'ok') { el('fs-qty').value = ''; el('fs-note').value = ''; }
  });
  el('lang').addEventListener('click', () => { paintFreeSample(); });
  paintFreeSample();
}
void syncQueue();
setInterval(() => { void syncQueue(); }, 15_000);
