// Till-side concession tagging — the THIN CLIENT (M27, owner decision).
//
// It holds no pricing, no commission logic and no minter. It records a partner-counter line by posting
// the docket fields to the backend, which runs the production @sre/concession engine, and it reflects the
// append-only tag stream the backend returns. A supervisor may reverse a posted tag; a cashier is refused
// server-side and told so (SoD §28). In production the backend is the cloud POS/concession API; in the
// browser E2E it is a local Node server running the same engine.

const $ = (id) => document.getElementById(id);

const statusEl = $('status');
const rowsEl = $('rows');

const setStatus = (text, kind = '') => {
  statusEl.textContent = text;
  statusEl.className = `status ${kind}`.trim();
};

async function post(path, body) {
  const res = await fetch(path, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  return res.json();
}

async function getJson(path) {
  const res = await fetch(path, { headers: { 'accept': 'application/json' } });
  return res.json();
}

// A stable idempotency key per (sale, line): a resend or double-tap of Record does not double-charge.
let lineSeq = 0;

function num(id) {
  return Number($(id).value);
}

function render(stream) {
  rowsEl.textContent = '';
  for (const t of stream.tags) {
    const tr = document.createElement('tr');
    tr.dataset['tagId'] = t.tagId;
    const cell = (text, cls) => {
      const td = document.createElement('td');
      td.textContent = text;
      if (cls) td.className = cls;
      return td;
    };
    tr.appendChild(cell(t.tagId));
    tr.appendChild(cell(t.kind));
    tr.appendChild(cell(String(t.grossMinor)));
    tr.appendChild(cell(String(t.netMinor)));
    tr.appendChild(cell(String(t.commissionMinor)));
    const action = document.createElement('td');
    if (t.kind === 'sale' || t.kind === 'return' || t.kind === 'cancellation') {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'secondary';
      btn.textContent = 'Reverse';
      btn.dataset['reverse'] = t.tagId;
      btn.addEventListener('click', () => reverse(t.tagId));
      action.appendChild(btn);
    }
    tr.appendChild(action);
    rowsEl.appendChild(tr);
  }
  $('t-gross').textContent = String(stream.totals.grossMinor);
  $('t-net').textContent = String(stream.totals.netMinor);
  $('t-commission').textContent = String(stream.totals.commissionMinor);
}

async function refresh() {
  const stream = await getJson('/concession/tag/stream');
  render(stream);
}

$('record').addEventListener('click', async () => {
  lineSeq += 1;
  const idempotencyKey = `till-3:sale-1:line-${lineSeq}`;
  const out = await post('/concession/tag/capture', {
    idempotencyKey,
    saleId: 'sale-1',
    lineId: `line-${lineSeq}`,
    concessionaireId: $('concessionaireId').value.trim(),
    counterId: $('counterId').value.trim(),
    productId: $('productId').value.trim(),
    qty: num('qty'),
    grossMinor: num('grossMinor'),
    discountMinor: num('discountMinor'),
    taxMinor: num('taxMinor'),
    capturedBy: $('role').value === 'supervisor' ? 'sup-ravi' : 'cashier-anita',
    byRole: $('role').value,
    source: $('source').value.trim(),
  });
  if (out && out.captured) {
    setStatus(`Recorded ${out.tag.tagId} — commission ${out.tag.commissionMinor}.`, 'good');
  } else if (out && out.refusal === 'duplicate_idempotency_key') {
    setStatus('Already recorded — nothing charged twice.', 'warn');
  } else {
    setStatus('Could not record the line.', 'err');
  }
  await refresh();
});

async function reverse(tagId) {
  const role = $('role').value;
  const out = await post('/concession/tag/reverse', {
    tagId,
    by: role === 'supervisor' ? 'sup-ravi' : 'cashier-anita',
    byRole: role,
    reasonCode: 'WRONG-COUNTER',
  });
  if (out && out.corrected) {
    setStatus(`Reversed ${tagId} by ${out.correction.tagId}.`, 'good');
  } else if (out && out.refusal === 'not_permitted_for_role') {
    setStatus('Only a supervisor may reverse a posted line — the refusal was recorded.', 'err');
  } else if (out && out.refusal === 'already_corrected_by_reversal') {
    setStatus('That line was already reversed.', 'warn');
  } else {
    setStatus('Could not reverse the line.', 'err');
  }
  await refresh();
}

void refresh();
