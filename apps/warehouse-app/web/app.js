// Warehouse handheld — the view layer (M09 / OA-9). It renders the assigned work and dispatches the
// worker's scans; every rule lives in the TESTED session model
// (`apps/warehouse-app/src/warehouse-session.ts`), attached as `window.warehouseSession`, which
// orchestrates the authoritative receiving / warehouse / FEFO engines.
//
// ── What this file exists to hold ───────────────────────────────────────────
//
// **1. A scan is a scan.** Receiving and put-away are scanner-first, and the only way that stays true
// is if the screen offers **no way to type a code**. There is no product/bin input box anywhere. A
// retail scanner is a keyboard that types fast and presses Enter, so codes are collected globally and
// flushed on Enter — the same as the till and the picker, and for the same reason: an input that can
// lose focus is how a barcode lands in the wrong field.
//
// **2. A refused scan must be FELT, not just seen.** Each result carries a colour, a word (English and
// Tamil), a sound and a buzz, because the worker may be in ear defenders in a cold store. The word is
// the model's own outcome code, translated here — never re-decided.
//
// **3. No `prompt`, `confirm` or `alert`, and the result banner does not fade** — the same decisions
// the till, the manager and the picker screens hold.
//
// No scan touches the network. Every scan is local and queues to the device (§31), and the tested session
// is what queued it — this file only shows the result. The one call it makes is a read of the store
// computer's sync status, for the badge (design system §1 rule 4).

const el = (id) => document.getElementById(id);

// ── Words ─────────────────────────────────────────────────────────────────
//
// The scan-feedback keys are the session's own `FEEDBACK_CODES`. A completeness tripwire
// (`tests/guardrails/the-warehouse-screen-speaks-both-languages.test.ts`) fails the build if either
// language is missing one, so a worker is never shown a blank reason when a scan is refused.
// NOTE: the Tamil below is pending a native-speaker review before go-live (OWNER-ACTION OA-10).

const WORDS = {
  en: {
    noBoxLink: 'not connected to a store computer', checkingBox: 'checking the store computer…',
    boxNotAnswering: 'store computer not answering', boxOnline: 'store computer online',
    noCloud: 'store computer cannot reach head office', cloudNotSetUp: 'no head office link set up',
    cloudUnknown: 'head office not checked yet', lastContact: 'last contact',
    staleShell: 'No connection to the store computer. This is the work this handheld was last given, at',
    goodsIn: 'Waiting to be put away', noWork: 'No warehouse work has been given to this handheld yet.',
    noWorkBody: 'Nothing is wrong. When work is assigned to you it will appear here on its own.',
    sample: 'Sample assignment — this is not real work.',
    receive: 'Receive a delivery', putAway: 'Put away — scan the bin',
    scanBarcode: 'Scan the delivery barcode', scanBin: 'Scan the bin to put it in',
    pointAndPull: 'Point the scanner and pull the trigger.',
    cancel: 'Cancel', ok: 'OK', units: 'units',
    waiting: 'waiting to sync', allSent: 'everything sent',
    stepSelect: 'Tap an item to put away, or receive a delivery',
    stepScanBin: 'Scan the bin to put it in',
    recalledFlag: 'RECALLED — holding bin only', expiredFlag: 'EXPIRED — holding bin only',
    // scan feedback, keyed by the session's outcome codes
    received: 'Received', unknown_barcode: 'Unknown barcode — set aside for someone to sort out',
    over_delivery_needs_approval: 'More than ordered — a second person must approve it',
    dsd_needs_approval: 'No purchase order — a second person must approve it',
    price_change_refused: 'The price cannot be changed at the door',
    not_on_order: 'This is not on the purchase order',
    moved: 'Put away', duplicate_ignored: 'Already scanned — nothing changed',
    wrong_sku: 'That is not the item waiting to be put away',
    unknown_bin: 'Not a bin in this store — set aside for someone to sort out',
    bin_full: 'That bin is full — it would overflow',
    insufficient_goods_in: 'More than is waiting to be put away',
    insufficient_in_bin: 'The bin does not hold that many',
    not_pickable_state: 'This stock cannot go in a pickable bin — use a holding bin',
    recalled_into_pickable: 'Recalled stock cannot go in a pickable bin — use a holding bin',
    expired_into_pickable: 'Expired stock cannot go in a pickable bin — use a holding bin',
    invalid_command: 'That scan could not be used',
  },
  ta: {
    noBoxLink: 'கடை கணினியுடன் இணைக்கப்படவில்லை', checkingBox: 'கடை கணினியைச் சரிபார்க்கிறது…',
    boxNotAnswering: 'கடை கணினி பதிலளிக்கவில்லை', boxOnline: 'கடை கணினி இணைப்பில்',
    noCloud: 'கடை கணினி தலைமை அலுவலகத்தை அடைய முடியவில்லை', cloudNotSetUp: 'தலைமை அலுவலக இணைப்பு அமைக்கப்படவில்லை',
    cloudUnknown: 'தலைமை அலுவலகம் இன்னும் சரிபார்க்கப்படவில்லை', lastContact: 'கடைசித் தொடர்பு',
    staleShell: 'கடை கணினியுடன் இணைப்பு இல்லை. இந்த கருவிக்குக் கடைசியாகக் கொடுக்கப்பட்ட வேலை இதுதான்:',
    goodsIn: 'அடுக்க வைக்கக் காத்திருப்பவை', noWork: 'இந்த கருவிக்கு இதுவரை கிடங்கு வேலை தரப்படவில்லை.',
    noWorkBody: 'எந்தப் பிரச்சனையும் இல்லை. உங்களுக்கு வேலை ஒதுக்கப்பட்டால் அது தானாகவே இங்கே தோன்றும்.',
    sample: 'மாதிரி வேலை — இது உண்மையான வேலை அல்ல.',
    receive: 'பொருள் வரவு பெறு', putAway: 'அடுக்கு — இடத்தை ஸ்கேன் செய்',
    scanBarcode: 'வரவின் பார்கோடை ஸ்கேன் செய்யவும்', scanBin: 'வைக்கும் இடத்தை ஸ்கேன் செய்யவும்',
    pointAndPull: 'ஸ்கேனரை நோக்கி டிரிக்கரை அழுத்தவும்.',
    cancel: 'ரத்து', ok: 'சரி', units: 'அலகுகள்',
    waiting: 'அனுப்பக் காத்திருக்கிறது', allSent: 'அனைத்தும் அனுப்பப்பட்டன',
    stepSelect: 'அடுக்க ஒரு பொருளைத் தொடவும், அல்லது வரவு பெறவும்',
    stepScanBin: 'வைக்கும் இடத்தை ஸ்கேன் செய்யவும்',
    recalledFlag: 'திரும்பப் பெறப்பட்டது — சேமிப்பு இடம் மட்டும்', expiredFlag: 'காலாவதி — சேமிப்பு இடம் மட்டும்',
    received: 'பெறப்பட்டது', unknown_barcode: 'தெரியாத பார்கோடு — சரிபார்க்க ஒதுக்கி வைக்கப்பட்டது',
    over_delivery_needs_approval: 'ஆர்டரை விட அதிகம் — இரண்டாவது நபர் ஒப்புதல் அளிக்க வேண்டும்',
    dsd_needs_approval: 'கொள்முதல் ஆர்டர் இல்லை — இரண்டாவது நபர் ஒப்புதல் அளிக்க வேண்டும்',
    price_change_refused: 'வாசலில் விலையை மாற்ற முடியாது',
    not_on_order: 'இது கொள்முதல் ஆர்டரில் இல்லை',
    moved: 'அடுக்கப்பட்டது', duplicate_ignored: 'ஏற்கனவே ஸ்கேன் செய்யப்பட்டது — எதுவும் மாறவில்லை',
    wrong_sku: 'இது அடுக்கக் காத்திருக்கும் பொருள் அல்ல',
    unknown_bin: 'இந்தக் கடையின் இடம் அல்ல — சரிபார்க்க ஒதுக்கி வைக்கப்பட்டது',
    bin_full: 'அந்த இடம் நிரம்பியுள்ளது — வழிந்து விடும்',
    insufficient_goods_in: 'அடுக்கக் காத்திருப்பதை விட அதிகம்',
    insufficient_in_bin: 'அந்த இடத்தில் அவ்வளவு இல்லை',
    not_pickable_state: 'இந்தப் பொருளை எடுக்கும் இடத்தில் வைக்க முடியாது — சேமிப்பு இடத்தைப் பயன்படுத்தவும்',
    recalled_into_pickable: 'திரும்பப் பெற்ற பொருளை எடுக்கும் இடத்தில் வைக்க முடியாது — சேமிப்பு இடத்தைப் பயன்படுத்தவும்',
    expired_into_pickable: 'காலாவதிப் பொருளை எடுக்கும் இடத்தில் வைக்க முடியாது — சேமிப்பு இடத்தைப் பயன்படுத்தவும்',
    invalid_command: 'அந்த ஸ்கேனைப் பயன்படுத்த முடியவில்லை',
  },
};
let lang = 'en';
const t = (key) => WORDS[lang][key] ?? WORDS.en[key] ?? key;

const real = window.warehouseSession;
const data = window.warehouseData;
const outbox = window.warehouseOutbox ?? null;
const grnId = (data && data.grnId) || 'GRN';

let selected = null; // the goods-in item chosen to put away

// ── The scan panel ──────────────────────────────────────────────────────────
// A promise that resolves with the next scanned code, or null if cancelled. No text box exists.
let scanResolve = null;
function awaitScan(title) {
  el('scan-title').textContent = title;
  el('scan-awaiting').textContent = t('pointAndPull');
  el('scan').hidden = false;
  return new Promise((resolve) => { scanResolve = resolve; });
}
el('scan-cancel').addEventListener('click', () => {
  el('scan').hidden = true;
  if (scanResolve !== null) { const r = scanResolve; scanResolve = null; r(null); }
});

// ── Felt scan feedback: colour + word + sound + buzz (OA-9) ──────────────────
function feltResult(signal) {
  const banner = el('banner');
  banner.className = 'banner' + (signal.feedback === 'accept' ? ' good' : signal.feedback === 'warn' ? ' warn' : '');
  el('banner-title').textContent = t(signal.code) ?? signal.detail;
  el('banner-text').textContent = signal.detail;
  banner.hidden = false;
  if (typeof navigator !== 'undefined' && typeof navigator.vibrate === 'function') {
    try { navigator.vibrate(signal.vibrateMs); } catch { /* vibration is a nicety, never required */ }
  }
  beep(signal.sound);
}
el('banner-ok').addEventListener('click', () => { el('banner').hidden = true; });

/** A short tone per outcome. Guarded — a device with no audio still shows the colour and the word. */
function beep(kind) {
  try {
    const Ctx = window.AudioContext || window.webkitAudioContext;
    if (!Ctx) return;
    const ctx = new Ctx();
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.frequency.value = kind === 'ok' ? 880 : kind === 'warn' ? 520 : 220;
    gain.gain.value = 0.08;
    osc.connect(gain); gain.connect(ctx.destination);
    osc.start();
    osc.stop(ctx.currentTime + (kind === 'error' ? 0.35 : 0.12));
  } catch { /* no audio — the colour and the word carry it */ }
}

// ── Minting a scan command id, unique per scan (idempotent sync depends on it) ──
let seq = 0;
const nextId = (prefix) => `${prefix}-${Date.now()}-${seq++}`;

// ── Render ────────────────────────────────────────────────────────────────
function render() {
  el('goods-in-heading').textContent = t('goodsIn');
  el('receive').textContent = t('receive');
  el('put-away').textContent = t('putAway');
  el('put-away').disabled = selected === null;
  el('step').firstChild.textContent = selected === null ? t('stepSelect') : t('stepScanBin');

  paintBadge();

  const host = el('goods-in');
  host.textContent = '';
  const items = real && typeof real.goodsIn === 'function' ? real.goodsIn() : [];
  if (items.length === 0) {
    el('empty').hidden = false;
    el('empty').textContent = `${t('noWork')} ${t('noWorkBody')}`;
    return;
  }
  el('empty').hidden = true;
  items.forEach((item, index) => {
    const row = document.createElement('button');
    row.type = 'button';
    row.className = 'item' + (item.recalled ? ' recalled' : '');
    row.setAttribute('aria-selected', String(selected === index));
    const what = document.createElement('div');
    what.className = 'what';
    what.textContent = item.productId + (item.batchId ? ` · ${item.batchId}` : '');
    const qty = document.createElement('div');
    qty.className = 'qty';
    qty.textContent = `${item.quantityMinor} ${t('units')} · ${item.uom}`;
    row.append(what, qty);
    if (item.recalled) { const f = document.createElement('div'); f.className = 'flag'; f.textContent = t('recalledFlag'); row.append(f); }
    row.addEventListener('click', () => { selected = index; render(); });
    host.append(row);
  });
}

// ── Actions ─────────────────────────────────────────────────────────────────
el('receive').addEventListener('click', async () => {
  const code = await awaitScan(t('scanBarcode'));
  if (code === null || real === undefined) return;
  const out = real.receive({ commandId: nextId('recv'), grnId, barcode: code, scannedQuantity: 1, source: 'po' });
  feltResult(out.signal);
  render();
});

el('put-away').addEventListener('click', async () => {
  if (selected === null || real === undefined) return;
  const item = real.goodsIn()[selected];
  if (item === undefined) return;
  const bin = await awaitScan(t('scanBin'));
  if (bin === null) return;
  const out = real.putAway({
    commandId: nextId('mv'), scannedProductId: item.productId, scannedBinId: bin,
    batchId: item.batchId, quantityMinor: item.quantityMinor, uom: item.uom, at: new Date().toISOString(),
  });
  feltResult(out.signal);
  selected = null;
  render();
});

// ── Language ────────────────────────────────────────────────────────────────
el('lang').addEventListener('click', () => {
  lang = lang === 'en' ? 'ta' : 'en';
  document.documentElement.lang = lang;
  el('sample').textContent = t('sample');
  render();
});

// ── The scanner ─────────────────────────────────────────────────────────────
// A shop scanner is a keyboard: it types the code fast and presses Enter. There is deliberately NO
// input box to focus — losing focus is how a scan goes into the wrong bin or a quantity field.
let scanBuffer = '';
window.addEventListener('keydown', (event) => {
  if (event.key === 'Enter') {
    const code = scanBuffer;
    scanBuffer = '';
    if (code.length < 3) return; // a person pressing Enter, not a scanner
    // A scanner's Enter is never a person's. Left to the browser it also PRESSES whatever button has focus —
    // the "Receive a delivery" the worker just tapped — and the panel silently asks for the next scan, so
    // every received item looked like it wanted scanning again. Found by the browser audit, not by eye.
    event.preventDefault();
    if (scanResolve !== null) {
      el('scan').hidden = true;
      const resolve = scanResolve;
      scanResolve = null;
      resolve(code);
    }
    return;
  }
  if (/^[0-9A-Za-z-]$/.test(event.key)) scanBuffer += event.key;
});

// ── The sync badge — connection · unsent · freshness (design system §1 rule 4 · P-08) ────────────
//
// Two lines of words beside one dot. The first is THIS DEVICE's unsent count: the scans queued here
// and not yet drained. The second is the STORE COMPUTER's own account of itself — reachable or not,
// and when head office last answered it — asked at the address the page was served from. A handheld
// on the shop wifi never guesses an address: with no store computer named, the badge says so rather
// than inventing one, and a page opened from the device's cache says it is not connected.
let box = { asked: false, reachable: false, status: null };
const laneBase = () => (typeof window.laneWriteBase === 'string' ? window.laneWriteBase : null);

/** The device's clock face for a store-computer time — the person reading it is standing in the shop. */
function clock(iso) {
  return new Date(iso).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

function paintBadge() {
  const dot = el('queue-dot');
  const unsent = outbox === null ? 0 : outbox.unsentCount();
  dot.classList.remove('waiting', 'error', 'idle', 'degraded');
  // Words as well as a dot — one man in twelve cannot tell the two colours apart.
  el('queue-text').textContent = unsent === 0 ? t('allSent') : `${unsent} ${t('waiting')}`;
  let words;
  if (laneBase() === null) { dot.classList.add('idle'); words = t('noBoxLink'); }
  else if (!box.asked) { dot.classList.add('idle'); words = t('checkingBox'); }
  else if (!box.reachable) { dot.classList.add('error'); words = t('boxNotAnswering'); }
  else {
    const s = box.status;
    const when = s.lastContactAt ? ` · ${t('lastContact')} ${clock(s.lastContactAt)}` : '';
    if (s.cloud === 'online') words = `${t('boxOnline')}${when}`;
    else {
      dot.classList.add(s.cloud === 'unknown' || s.cloud === 'starting' ? 'idle' : 'degraded');
      words = `${s.cloud === 'offline' ? t('noCloud') : s.cloud === 'not_configured' ? t('cloudNotSetUp') : t('cloudUnknown')}${when}`;
    }
  }
  // Work waiting on this device shows as waiting unless the store computer itself is down — that is worse.
  if (unsent > 0 && !dot.classList.contains('error')) { dot.classList.remove('idle', 'degraded'); dot.classList.add('waiting'); }
  el('box-text').textContent = words;
}

async function refreshBadge() {
  const base = laneBase();
  if (base === null) { paintBadge(); return; }
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), 3000);
  try {
    const res = await fetch(`${base}/lane/sync-status`, { cache: 'no-store', signal: ctl.signal });
    box = res.ok ? { asked: true, reachable: true, status: await res.json() } : { asked: true, reachable: false, status: null };
  } catch {
    box = { asked: true, reachable: false, status: null };
  } finally {
    clearTimeout(timer);
  }
  paintBadge();
}
window.warehouseBadge = { refresh: refreshBadge, state: () => box };
void refreshBadge();
setInterval(() => { void refreshBadge(); }, 10_000);

// ── Boot ────────────────────────────────────────────────────────────────────
el('who').firstChild.textContent = (data && data.workerId) || '—';
el('assignment').textContent = (data && data.assignmentId) || '';
el('sample').hidden = real !== undefined;
el('sample').textContent = t('sample');

const storageProblem = window.warehouseStorageProblem;
el('storage').hidden = !storageProblem;
if (storageProblem) el('storage').textContent = storageProblem;

render();

// ── The shell's own honesty about where this page came from ──────────────────
// The service worker keeps a copy of the last page the store box actually served, so this screen
// still opens when the box cannot be reached. That copy carries the time it was taken, and this says
// so. **A cached page shown as a live one is the fault this product exists to refuse** (P-08).
function paintStale() {
  const at = window.shellCachedAt;
  const strip = el('stale');
  if (!strip) return;
  strip.hidden = at === undefined;
  if (at === undefined) return;
  // The device's own local time, because the person reading it is standing in the shop.
  strip.textContent = `${t('staleShell')} ${new Date(at).toLocaleString()}`;
}
paintStale();
el('lang').addEventListener('click', paintStale);

// The shell existed and nothing ever registered it would mean nothing was ever cached and the screen
// fell back to its sample data the moment the box was unreachable.
if ('serviceWorker' in navigator) {
  navigator.serviceWorker.register('./sw.js').catch(() => {
    /* the screen still opens; it just will not be there without a network */
  });
}
