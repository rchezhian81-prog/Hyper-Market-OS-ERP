// POS shell — view layer. It renders basket state and dispatches cashier intents;
// all business logic lives in the TESTED session model (`apps/pos/src/session.ts`,
// which composes the pricing/promotions/tender/sale engines). At build time the
// bundled session is attached as `window.posSession`; until then this file runs a
// small in-memory stand-in with the same method names, so the shell is visually
// runnable and the layout can be usability-tested (QG-02) before the bundler lands.
//
// Nothing here calls the network: the sale path is local-only (hard rule #1). The
// service worker caches the shell so the lane opens during an outage.

const el = (id) => document.getElementById(id);

/** Format integer minor units as rupees for display (the model keeps exact minor units). */
const inr = (minor) =>
  '₹' + (minor / 100).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

/**
 * Stand-in with the same surface as the bundled PosSession. Replaced at build time
 * by the real, tested model — the view never contains pricing or tender rules.
 */
function demoSession() {
  const lines = [];
  let seq = 0;
  return {
    scan({ productId, description, unitPriceMinor, qty }) {
      seq += 1;
      lines.push({ lineId: 'L' + seq, productId, description, unitPriceMinor, qty, voided: false });
    },
    setQuantity(lineId, qty) {
      const line = lines.find((l) => l.lineId === lineId);
      if (line) line.qty = qty;
    },
    voidLine(lineId, reason) {
      const line = lines.find((l) => l.lineId === lineId);
      if (line && reason) {
        line.voided = true; // marked, never erased — voids stay visible (M15)
      }
    },
    basket: () => lines.slice(),
    payableMinor: () =>
      lines.filter((l) => !l.voided).reduce((sum, l) => sum + l.unitPriceMinor * l.qty, 0),
    syncBadge: () => ({ connection: navigator.onLine ? 'online' : 'offline', unsentCount: 0 }),
    tenderCash: (_saleId, receiptNumber) => receiptNumber, // stand-in: no real commit
    newSale: () => {
      lines.length = 0;
      seq = 0;
    },
  };
}

const session = window.posSession ?? demoSession();
let selectedLineId = null;

function render() {
  const rows = session.basket();
  const tbody = el('lines');
  tbody.replaceChildren();

  for (const line of rows) {
    const tr = document.createElement('tr');
    if (line.voided) tr.className = 'voided';
    if (line.lineId === selectedLineId) tr.style.background = '#334155';

    const name = document.createElement('td');
    name.textContent = line.description;
    const qty = document.createElement('td');
    qty.className = 'amount';
    qty.textContent = String(line.qty);
    const amount = document.createElement('td');
    amount.className = 'amount';
    amount.textContent = inr(line.unitPriceMinor * line.qty);

    tr.append(name, qty, amount);
    tr.addEventListener('click', () => {
      selectedLineId = line.lineId; // tap a line to select it (step 1 of qty/void)
      render();
    });
    tbody.append(tr);
  }

  el('empty').hidden = rows.length > 0;
  el('total').textContent = inr(session.payableMinor());

  const badge = session.syncBadge();
  el('conn-dot').className = badge.connection === 'online' ? 'dot' : 'dot offline';
  el('conn-text').textContent = badge.connection === 'online' ? 'Online' : 'Offline';
  el('unsent').textContent = 'Unsent: ' + badge.unsentCount;
}

// --- cashier intents (each within the ≤3-interaction budget) ---

// A scan arrives as keyboard input from the scanner (or the demo button).
el('unsent').addEventListener('click', () => {
  // Tapping the unsent count lists queued sales (spec); wired to the outbox view.
  window.alert('Queued sales: ' + session.syncBadge().unsentCount);
});

el('qty').addEventListener('click', () => {
  if (!selectedLineId) return window.alert('Tap a line first.');
  const entered = window.prompt('Quantity');
  const qty = Number(entered);
  if (Number.isInteger(qty) && qty > 0) {
    session.setQuantity(selectedLineId, qty);
    render();
  }
});

el('void').addEventListener('click', () => {
  if (!selectedLineId) return window.alert('Tap a line first.');
  const reason = window.prompt('Reason for void'); // reason is mandatory (M15)
  if (reason && reason.trim()) {
    session.voidLine(selectedLineId, reason.trim());
    selectedLineId = null;
    render();
  }
});

el('tender').addEventListener('click', () => {
  const payable = session.payableMinor();
  if (payable <= 0) return window.alert('Scan an item first.');
  // Cash completes LOCALLY and prints — it never waits on the network (hard rule
  // #1). The model commits stock to the local ledger and queues the sale for sync.
  if (!window.confirm('Take ' + inr(payable) + ' cash?')) return;
  const saleId = crypto.randomUUID();
  const receiptNumber = 'S-' + saleId.slice(0, 8).toUpperCase();
  try {
    const number = session.tenderCash(saleId, receiptNumber, new Date().toISOString());
    window.alert('Paid ' + inr(payable) + '\nReceipt ' + number + '\nSale saved on this lane.');
    session.newSale();
    selectedLineId = null;
    render();
  } catch (err) {
    // Errors state what happened, whether the sale was saved, and the next step.
    window.alert('Payment not completed. Sale NOT saved.\n' + (err?.message ?? String(err)));
  }
});

el('lang').addEventListener('click', () => {
  document.documentElement.lang = document.documentElement.lang === 'en' ? 'ta' : 'en';
});

// The badge must reflect connectivity immediately (P-08) — sales never wait on it.
window.addEventListener('online', render);
window.addEventListener('offline', render);

// --- barcode scanner input ---
// A hand scanner behaves as a keyboard: it types the code fast and ends with Enter.
// We buffer keystrokes and submit on Enter, so no focused input field is needed and
// the cashier never has to click anywhere first (1 interaction: scan).
let scanBuffer = '';

function handleScan(code) {
  if (!code) return;
  if (!session.scanBarcode) {
    // No catalogue bundle loaded — fall back to the stand-in demo item.
    session.scan({ productId: 'demo', description: 'Demo item', unitPriceMinor: 4500, qty: 1 });
    return render();
  }
  try {
    const outcome = session.scanBarcode(code);
    if (outcome.requiresAgeCheck) {
      // Age check is a deliberate extra step (legal) — see the spec's exceptions.
      if (!window.confirm(outcome.description + ' — customer looks of age?')) {
        session.voidLine(outcome.lineId, 'age check failed');
      }
    }
    render();
  } catch (err) {
    // States what happened and the next safe action; the bill is untouched.
    window.alert((err?.message ?? String(err)) + '\nNothing was added to the bill.');
  }
}

document.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') {
    handleScan(scanBuffer.trim());
    scanBuffer = '';
    return;
  }
  if (e.key === 'F2') return handleScan(''); // demo item, for layout testing
  if (e.key.length === 1) scanBuffer += e.key; // accumulate the scanned digits
});

if ('serviceWorker' in navigator) {
  navigator.serviceWorker.register('./sw.js').catch(() => {
    /* the shell still works without the SW; it just won't be cached offline */
  });
}

render();
