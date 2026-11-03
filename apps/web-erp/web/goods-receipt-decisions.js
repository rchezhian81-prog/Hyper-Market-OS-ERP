// Goods receipts — the decisions a delivery waits for (W4 · M07-FR-03 · WF-04 · §28 · hard rules #2 #10). Every rule lives in
// the TESTED session (apps/web-erp/src/goods-receipt-session.ts createReceiptDecisionsSession, window.receiptDecisions). This
// file only draws, on a click, each held line and held excess head office says waits for a person, and passes each decision
// through with its reason. The person who received a delivery is shown why they cannot decide it, and no buttons; head
// office refuses a self-decision too, and its words are shown. Nothing is read on open. No prompt/confirm/alert.

const $ = (id) => document.getElementById(id);
const rd = window.receiptDecisions ?? null;
let lang = document.documentElement.lang === 'ta' ? 'ta' : 'en';
const w = (k) => rd.words(lang, k);
let pending = null;

function el(tag, words, cls) { const n = document.createElement(tag); if (words !== undefined) n.textContent = words; if (cls) n.className = cls; return n; }
function button(cls, words, onClick) { const b = el('button', words, `sre-btn ${cls}`); b.type = 'button'; b.addEventListener('click', onClick); return b; }

/** Pass a decision through; say head office's answer on the row; then read the list again (and the page's own list). */
async function decided(row, out, good) {
  const said = row.querySelector('.decide-status');
  said.textContent = rd.outcomeWords(lang, out, good); said.dataset.result = out.result;
  if (out.result !== 'ok') return;
  // The row goes once decided: the answer stays on the section, with the delivery it was for.
  $('decide-status').textContent = `${row.dataset.grn}: ${said.textContent}`; $('decide-status').dataset.result = 'ok';
  $('refresh')?.click(); // the page's own register (its returns, its dispatches) reads head office again
  await show(false);
}

function paint() {
  const ul = $('decide-rows'); ul.replaceChildren();
  if (pending === null) return;
  if (pending.length === 0) { ul.append(el('li', w('none'), 'note')); return; }
  for (const g of pending) {
    const li = el('li', undefined, 'row'); li.dataset.grn = g.grnId; li.dataset.receivedByYou = String(g.receivedByYou);
    li.append(el('strong', `${g.grnId} · ${g.warehouseId} · ${w('receivedBy')} ${g.receivedBy}`));
    if (g.receivedByYou) li.append(el('p', w('yours'), 'note decide-yours'));
    const reason = document.createElement('input'); reason.className = 'decide-reason'; reason.autocomplete = 'off'; reason.setAttribute('aria-label', w('reasonL')); reason.placeholder = w('reasonL');
    const offer = !g.receivedByYou;
    for (const l of g.lines) {
      const line = el('div', undefined, 'decide-line'); line.dataset.line = l.lineId;
      const what = [l.quarantinedMinor > 0 ? `${l.quarantinedMinor} ${l.uom} ${w('heldLine')}` : '', l.rejectedMinor > 0 ? `${l.rejectedMinor} ${l.uom} ${w('refusedLine')}` : ''].filter((x) => x !== '').join(' · ');
      line.append(el('span', `${l.lineId} · ${l.productId} — ${what}`));
      if (offer && rd.session.may.decide) {
        const choices = [...(l.mayAccept ? ['accept'] : []), 'return', 'claim'];
        for (const d of choices) line.append(button(`decide-${d}`, w(d), async () => decided(li, await rd.session.disposeLine(g.grnId, l.lineId, d, reason.value), 'decided')));
      }
      li.append(line);
    }
    if (g.heldExcessMinor > 0) {
      const ex = el('div', undefined, 'decide-excess');
      ex.append(el('span', `${g.heldExcessMinor} ${w('excess')}`));
      if (offer && rd.session.may.decide) {
        ex.append(button('excess-accept', w('acceptExcess'), async () => decided(li, await rd.session.decideExcess(g.grnId, 'approved', reason.value), 'decided')));
        ex.append(button('excess-refuse', w('refuseExcess'), async () => decided(li, await rd.session.decideExcess(g.grnId, 'rejected', reason.value), 'decided')));
      }
      li.append(ex);
    }
    if (g.refusedExcessAwaitingReturn && rd.session.may.recordReturn) {
      li.append(button('excess-returned', w('excessReturned'), async () => decided(li, await rd.session.excessReturned(g.grnId, reason.value), 'returned')));
    }
    if (offer) li.append(reason);
    li.append(el('p', '', 'note decide-status'));
    ul.append(li);
  }
}

async function show(clearStatus = true) {
  const out = await rd.session.pending();
  if (clearStatus) $('decide-status').textContent = '';
  if (out.result !== 'ok') { $('decide-status').textContent = rd.outcomeWords(lang, out, ''); return; }
  pending = out.value; paint();
}

function paintWords() {
  for (const [id, k] of [['decide-heading', 'h'], ['decide-lead', 'lead'], ['decide-show', 'show']]) $(id).textContent = w(k);
  paint();
}

if (rd !== null && (rd.session.may.decide || rd.session.may.recordReturn)) {
  $('decide').hidden = false;
  paintWords();
  $('decide-show').addEventListener('click', () => { void show(); });
  // The page's one language toggle (goods-receipt.js flips it first); this section follows.
  $('lang').addEventListener('click', () => { lang = document.documentElement.lang === 'ta' ? 'ta' : 'en'; paintWords(); });
}
