// Business customers — the payments customers SAY they sent (W3 · M22-FR-04 · OB-41 "A" · §28 · P-03 · hard rules #2 #6).
// Every rule lives in the TESTED session (apps/web-erp/src/b2b-transfer-notes-session.ts, window.b2bTransferNotes). This
// file only draws the queue and passes each click through: MATCH a note to the line on the shop's own bank statement
// (head office accepts only the exact amount and reference) or REJECT it with a reason the customer reads (it stays on
// record). Nothing is read on open; "Show the payment notes" is a click. No prompt/confirm/alert.

const $ = (id) => document.getElementById(id);
const tn = window.b2bTransferNotes ?? null;
let lang = document.documentElement.lang === 'ta' ? 'ta' : 'en';
const w = (k) => tn.words(lang, k);

function field(labelKey, cls, extra = {}) {
  const label = document.createElement('label');
  const span = document.createElement('span'); span.textContent = w(labelKey);
  const input = document.createElement('input'); input.className = cls; input.autocomplete = 'off';
  Object.assign(input, extra);
  label.append(span, input);
  return { label, input };
}

async function show() {
  const out = await tn.session.queue();
  if (out.result !== 'ok') { $('tn-status').textContent = tn.outcomeWords(lang, out, ''); $('tn-list').replaceChildren(); return; }
  const q = out.value;
  $('tn-summary').textContent = `${q.pending} ${w('waiting')} · ${tn.rupees(q.pendingMinor)} ${w('waitingSum')}`;
  if (q.notes.length === 0) { const li = document.createElement('li'); li.textContent = w('none'); $('tn-list').replaceChildren(li); return; }
  $('tn-list').replaceChildren(...q.notes.map((n) => {
    const li = document.createElement('li');
    li.dataset.note = n.noteId;
    li.dataset.state = n.state;
    const head = document.createElement('strong');
    head.textContent = `${n.customerId} · ${tn.rupees(n.amountMinor)} · ${w(`st_${n.state}`)}`;
    const meta = document.createElement('span'); meta.className = 'meta';
    meta.textContent = `${w('sentOn')} ${n.transferredOn} · ${w('reference')} ${n.bankReference}${n.against.length > 0 ? ` · ${w('against')} ${n.against.join(', ')}` : ''}${n.decidedBy ? ` · ${n.decidedBy}` : ''}${n.reason ? ` — ${n.reason}` : ''}`;
    li.append(head, meta);
    if (n.state === 'pending') {
      const form = document.createElement('div'); form.className = 'row-form';
      const amount = field('receivedL', 'tn-received', { inputMode: 'decimal' });
      const on = field('receivedOnL', 'tn-on', { inputMode: 'numeric', placeholder: 'YYYY-MM-DD' });
      const ref = field('statementRefL', 'tn-ref');
      form.append(amount.label, on.label, ref.label);
      const match = document.createElement('button'); match.type = 'button'; match.className = 'tn-match'; match.textContent = w('match');
      match.addEventListener('click', async () => {
        const done = await tn.session.match(n.noteId, { receivedRupees: amount.input.value, receivedOn: on.input.value, bankReference: ref.input.value });
        $('tn-status').textContent = tn.outcomeWords(lang, done, 'matchedNow');
        $('tn-status').dataset.result = done.result;
        if (done.result === 'ok') await show();
      });
      const why = field('rejectWhyL', 'tn-why');
      const reject = document.createElement('button'); reject.type = 'button'; reject.className = 'quiet tn-reject'; reject.textContent = w('reject');
      reject.addEventListener('click', async () => {
        const done = await tn.session.reject(n.noteId, why.input.value);
        $('tn-status').textContent = tn.outcomeWords(lang, done, 'rejectedNow');
        $('tn-status').dataset.result = done.result;
        if (done.result === 'ok') await show();
      });
      li.append(form, match, why.label, reject);
    }
    return li;
  }));
}

function paintWords() {
  for (const [id, k] of [['tn-h', 'h'], ['tn-lead', 'lead'], ['tn-show-text', 'show']]) $(id).textContent = w(k);
}

if (tn !== null && tn.session.may.record) {
  $('tn').hidden = false;
  paintWords();
  $('tn-show').addEventListener('click', () => { void show(); });
  // The page's one language toggle (b2b.js flips it first); this section follows.
  $('lang').addEventListener('click', () => { lang = document.documentElement.lang === 'ta' ? 'ta' : 'en'; paintWords(); });
}
