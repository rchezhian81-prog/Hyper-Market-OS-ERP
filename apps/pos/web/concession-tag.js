// Till-side concession tagging — the THIN CLIENT, bound to the STORE BOX (M27-FR-03, Item 3, §31).
//
// It holds no pricing, no commission logic and no minter. A cashier records a partner-counter docket line and
// this page hands it to the box's loopback write socket (`POST /lane/concession-tags`), exactly as the till's
// sales and refunds travel: the box writes it durably to its own log FIRST, then queues it for the cloud, whose
// synced route resolves the partner's contract in force, snapshots the commission scheme there and records the
// cashier named here as the author. So the line is saved with the cable out, and commission is never computed
// on this page — head office computes it from the contract. Corrections (a reversal, an adjustment) are a
// supervisor's act at head office, never a rewrite here (§28, hard rule #2).

const $ = (id) => document.getElementById(id);

const statusEl = $('status');
const rowsEl = $('rows');

const setStatus = (text, kind = '') => {
  statusEl.textContent = text;
  statusEl.className = `status ${kind}`.trim();
};

/** Where the box's write socket is: what the shell was told, a `?lane=` port, or the standard lane port. */
function laneBase() {
  if (typeof window.laneWriteBase === 'string' && window.laneWriteBase !== '') return window.laneWriteBase.replace(/\/+$/, '');
  const port = new URLSearchParams(location.search).get('lane');
  return `http://127.0.0.1:${port && /^\d+$/.test(port) ? port : '8090'}`;
}

const str = (id) => $(id).value.trim();
const num = (id) => Number($(id).value);
const today = () => new Date().toISOString().slice(0, 10);

/** The lines this page recorded in this session — what the box accepted, never a claim about the cloud. */
const recorded = [];
const lineSeqBySale = new Map();

function render() {
  rowsEl.textContent = '';
  let gross = 0; let net = 0;
  for (const t of recorded) {
    const tr = document.createElement('tr');
    tr.dataset['tagId'] = t.tagId;
    const cell = (text, cls) => { const td = document.createElement('td'); td.textContent = text; if (cls) td.className = cls; return td; };
    tr.appendChild(cell(t.tagId));
    tr.appendChild(cell(t.productId));
    tr.appendChild(cell(String(t.grossMinor)));
    tr.appendChild(cell(String(t.grossMinor - t.discountMinor)));
    tr.appendChild(cell(t.state, t.state === 'saved' ? 'good' : 'err'));
    rowsEl.appendChild(tr);
    if (t.state === 'saved') { gross += t.grossMinor; net += t.grossMinor - t.discountMinor; }
  }
  $('t-gross').textContent = String(gross);
  $('t-net').textContent = String(net);
}

/** The docket line as the box's lane route reads it — and as the cloud's synced route will. */
function draftLine() {
  const saleId = str('saleId');
  const tillId = str('tillId');
  const seq = (lineSeqBySale.get(saleId) ?? 0) + 1;
  const lineId = str('lineId') !== '' ? str('lineId') : `line-${seq}`;
  const contractId = str('contractId');
  return {
    tagId: `${tillId}:${saleId}:${lineId}`,
    kind: 'sale',
    saleId, lineId, tillId,
    shiftId: str('shiftId') !== '' ? str('shiftId') : `shift-${today()}`,
    productId: str('productId'),
    concessionaireId: str('concessionaireId'),
    ...(contractId === '' ? {} : { contractId }),
    counterId: str('counterId'),
    qty: num('qty'), grossMinor: num('grossMinor'), discountMinor: num('discountMinor'), taxMinor: num('taxMinor'),
    capturedBy: str('capturedBy'),
    byRole: $('role').value,
    source: str('source'),
    at: new Date().toISOString(),
  };
}

function incomplete(line) {
  for (const k of ['saleId', 'tillId', 'productId', 'concessionaireId', 'counterId', 'capturedBy', 'source']) {
    if (typeof line[k] !== 'string' || line[k] === '') return k;
  }
  if (!Number.isInteger(line.qty) || line.qty <= 0) return 'qty';
  for (const k of ['grossMinor', 'discountMinor', 'taxMinor']) if (!Number.isInteger(line[k])) return k;
  return undefined;
}

let inFlight = false;
$('record').addEventListener('click', async () => {
  if (inFlight) return;
  const line = draftLine();
  const missing = incomplete(line);
  if (missing !== undefined) {
    setStatus(`Fill in ${missing} first — nothing was recorded. / முதலில் ${missing} நிரப்புங்கள்.`, 'warn');
    return;
  }
  inFlight = true;
  $('record').disabled = true;
  try {
    // The box's write socket: durable on the store computer before it answers, then queued for head office.
    const res = await fetch(`${laneBase()}/lane/concession-tags`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(line),
    });
    const out = await res.json();
    if (out && out.committed) {
      lineSeqBySale.set(line.saleId, (lineSeqBySale.get(line.saleId) ?? 0) + 1);
      recorded.push({ ...line, state: 'saved' });
      $('lineId').value = '';
      setStatus(`Saved ${line.tagId} on the store computer — it reaches head office when the connection is up; commission is worked out there from the contract. / கடைக் கணினியில் சேமிக்கப்பட்டது.`, 'good');
    } else {
      recorded.push({ ...line, state: 'refused' });
      setStatus(out && out.laneMessage ? out.laneMessage : 'The store computer could not record the line. / பதிவு செய்ய முடியவில்லை.', 'err');
    }
  } catch {
    setStatus('No connection to the store computer — nothing was recorded. Keep the docket and try again. / கடைக் கணினியுடன் இணைப்பு இல்லை.', 'err');
  } finally {
    inFlight = false;
    $('record').disabled = false;
    render();
  }
});

$('shiftId').placeholder = `shift-${today()}`;
render();
