// Customer app — scan-and-go (OB-350 · R8-3 · D04-FR-06), beside app.js, online-store.js and customer-commerce.js.
//
// The phone builds the basket and shows the running total; payment and the bag check are at a till lane. The camera (or the
// number under the barcode) finds the product in the shop's own list on this phone (window.shopScanAndGo, tested in
// src/scan-and-go.ts). Two totals, each named for what it is: this phone's sum at the shelf prices BEFORE offers (always,
// offline too), and the shop's price with the till's own offers (asked of the shop on a tap). "Go to a till" hands the
// basket to the shop, which answers a six-digit code; the cashier keys it, the till RE-PRICES every line and takes the money.
// The phone sends product ids and counts, never a price. No prompt, confirm or alert; nothing on a background timer; every
// state in words; every word in English and Tamil; icons beside words; 56px targets.

const el = (id) => document.getElementById(id);
const inr = (minor) => `₹${(minor / 100).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const lang = () => (document.documentElement.lang === 'ta' ? 'ta' : 'en');

const W = {
  en: {
    title: 'Scan and go',
    lead: 'Scan as you shop. Your phone keeps the basket and the running total. Then go to any till lane: the cashier brings your basket up with a code, the till works out the price, and you pay there. Loose items sold by weight are weighed at the till.',
    scan: 'Scan a barcode', scanStop: 'Stop scanning', typed: 'Or type the number under the barcode', add: 'Add to my scan-and-go basket',
    looking: 'Point the camera at the barcode…', none: 'No barcode was read. Try again, or type the number under the barcode.', denied: 'The camera is not allowed. Allow it, or type the number under the barcode.',
    added: 'Added:', why_unknown_barcode: 'That barcode is not in the shop’s list on this phone. Take it to the till to be scanned there.',
    why_weighed_at_the_till: 'This is sold by weight — it is weighed at the till, not on the phone.', why_not_on_sale: 'This is not on sale just now.',
    why_too_many: 'That is as many as one basket can hold here — the till can take the rest.', why_handed_to_the_till: 'This basket is with the till now. Start a new basket to scan more.',
    needCode: 'Type the number under the barcode first.', empty: 'Nothing scanned yet.',
    shelf: 'On the shelf (before offers)', shop: 'The shop’s price', notAsked: 'not asked yet', priceNote: 'Neither is what you pay: the till works out the price at the lane, with the shop’s offers.',
    quote: 'See the shop’s price', unpriced: 'The shop has no price yet for some of these — the till will price them.',
    till: 'Go to a till', codeLabel: 'Show this code at the till', codeSay: 'Go to any till lane. The cashier keys this code, checks your bag and takes the payment.',
    recalledAt: 'Brought up at till {lane}. Pay there.', newTrip: 'Start a new basket', less: 'One less', more: 'One more',
    signIn: 'Please sign in first (in the basket).', offline: 'No signal — nothing was sent. Your basket is kept on this phone; you can also have it scanned at the till.',
    busy: 'The shop could not answer just now. Try again.', refused: 'The shop did not accept this:', noRoad: 'This app is not set up to reach the shop.',
  },
  ta: {
    title: 'ஸ்கேன் செய்து செல்',
    lead: 'வாங்கும்போதே ஸ்கேன் செய்யுங்கள். உங்கள் ஃபோன் கூடையையும் மொத்தத் தொகையையும் வைத்திருக்கும். பிறகு எந்தக் கட்டண வரிசைக்கும் செல்லுங்கள்: காசாளர் குறியீட்டைக் கொண்டு உங்கள் கூடையைத் திறப்பார், கட்டண இயந்திரம் விலையைக் கணக்கிடும், அங்கேயே செலுத்துங்கள். எடைக்கு விற்கப்படும் பொருட்கள் கட்டண வரிசையில் எடை போடப்படும்.',
    scan: 'பார்கோடை ஸ்கேன் செய்', scanStop: 'ஸ்கேன் செய்வதை நிறுத்து', typed: 'அல்லது பார்கோடின் கீழ் உள்ள எண்ணைத் தட்டச்சு செய்யுங்கள்', add: 'என் ஸ்கேன் கூடையில் சேர்',
    looking: 'கேமராவை பார்கோடை நோக்கிக் காட்டுங்கள்…', none: 'பார்கோடு படிக்கப்படவில்லை. மீண்டும் முயலுங்கள், அல்லது பார்கோடின் கீழ் உள்ள எண்ணைத் தட்டச்சு செய்யுங்கள்.', denied: 'கேமராவுக்கு அனுமதி இல்லை. அனுமதியுங்கள், அல்லது பார்கோடின் கீழ் உள்ள எண்ணைத் தட்டச்சு செய்யுங்கள்.',
    added: 'சேர்க்கப்பட்டது:', why_unknown_barcode: 'அந்தப் பார்கோடு இந்த ஃபோனில் உள்ள கடையின் பட்டியலில் இல்லை. கட்டண வரிசையில் ஸ்கேன் செய்ய எடுத்துச் செல்லுங்கள்.',
    why_weighed_at_the_till: 'இது எடைக்கு விற்கப்படுகிறது — ஃபோனில் அல்ல, கட்டண வரிசையில் எடை போடப்படும்.', why_not_on_sale: 'இது இப்போது விற்பனையில் இல்லை.',
    why_too_many: 'ஒரு கூடையில் இங்கே இவ்வளவுதான் — மீதியைக் கட்டண வரிசை எடுத்துக்கொள்ளும்.', why_handed_to_the_till: 'இந்தக் கூடை இப்போது கட்டண வரிசையில் உள்ளது. மேலும் ஸ்கேன் செய்ய புதிய கூடையைத் தொடங்குங்கள்.',
    needCode: 'முதலில் பார்கோடின் கீழ் உள்ள எண்ணைத் தட்டச்சு செய்யுங்கள்.', empty: 'இன்னும் எதுவும் ஸ்கேன் செய்யப்படவில்லை.',
    shelf: 'அலமாரியில் (சலுகைகளுக்கு முன்)', shop: 'கடையின் விலை', notAsked: 'இன்னும் கேட்கப்படவில்லை', priceNote: 'இரண்டும் நீங்கள் செலுத்துவது அல்ல: கடையின் சலுகைகளுடன் கட்டண வரிசையில் விலை கணக்கிடப்படும்.',
    quote: 'கடையின் விலையைப் பார்', unpriced: 'இவற்றில் சிலவற்றுக்குக் கடையிடம் இன்னும் விலை இல்லை — கட்டண வரிசை விலையிடும்.',
    till: 'கட்டண வரிசைக்குச் செல்', codeLabel: 'இந்தக் குறியீட்டைக் கட்டண வரிசையில் காட்டுங்கள்', codeSay: 'எந்தக் கட்டண வரிசைக்கும் செல்லுங்கள். காசாளர் இந்தக் குறியீட்டை உள்ளிட்டு, உங்கள் பையைச் சரிபார்த்து, கட்டணத்தைப் பெறுவார்.',
    recalledAt: 'கட்டண வரிசை {lane}-இல் திறக்கப்பட்டது. அங்கே செலுத்துங்கள்.', newTrip: 'புதிய கூடையைத் தொடங்கு', less: 'ஒன்று குறை', more: 'ஒன்று கூட்டு',
    signIn: 'முதலில் உள்நுழையுங்கள் (கூடையில்).', offline: 'சிக்னல் இல்லை — எதுவும் அனுப்பப்படவில்லை. உங்கள் கூடை இந்த ஃபோனில் உள்ளது; கட்டண வரிசையிலும் ஸ்கேன் செய்யலாம்.',
    busy: 'கடையால் இப்போது பதில் அளிக்க முடியவில்லை. மீண்டும் முயலுங்கள்.', refused: 'கடை இதை ஏற்கவில்லை:', noRoad: 'இந்தச் செயலிக்குக் கடையுடன் இணைப்பு அமைக்கப்படவில்லை.',
  },
};
const t = (k) => W[lang()][k] ?? W.en[k] ?? k;
const shop = () => window.shop;
const model = () => window.shopScanAndGo;
const icon = (name) => (typeof window.sreIcon === 'function' ? window.sreIcon(name, 20) : null);
function words(id, key, iconName) {
  const n = el(id); if (!n) return;
  n.replaceChildren(...[iconName ? icon(iconName) : null, document.createTextNode(t(key))].filter(Boolean));
}
function say(id, text, state) { el(id).textContent = text; if (state !== undefined) el(id).dataset.state = state; }
const refusalWords = (out) => (out.refusal === 'not_signed_in' ? t('signIn') : out.refusal === 'not_saved_no_connection' ? t('offline') : out.refusal === 'the_shop_could_not_answer' ? t('busy')
  : out.refusal === 'no_road_to_the_shop' ? t('noRoad') : `${t('refused')} ${out.shopSaid ?? ''}`);
function iconButton(text, iconName, onClick, cls) {
  const b = document.createElement('button'); b.type = 'button'; if (cls) b.className = cls;
  b.setAttribute('aria-label', text);
  const i = icon(iconName); if (i) b.append(i);
  b.append(document.createTextNode(text));
  b.addEventListener('click', onClick);
  return b;
}

let lastQuote = null; // the shop's answer for the basket as it stood when asked — cleared whenever the basket changes
let lastHand = null;  // the shop's answer to "Go to a till"

function paint() {
  const m = model(); if (m === undefined) return;
  words('sg-title', 'title'); say('sg-lead', t('lead'));
  words('sg-scan', 'scan', 'scan-barcode'); words('sg-scan-stop', 'scanStop', 'x'); say('sg-typed-label', t('typed'));
  words('sg-add', 'add', 'list-plus'); words('sg-quote', 'quote', 'percent'); words('sg-till', 'till', 'shopping-cart'); words('sg-new', 'newTrip', 'refresh-cw');
  say('sg-shelf-label', t('shelf')); say('sg-shop-label', t('shop')); say('sg-price-note', t('priceNote')); say('sg-code-label', t('codeLabel'));
  const lines = m.basket.lines();
  const code = m.basket.tillCode();
  el('sg-lines').replaceChildren(...(lines.length === 0 ? [Object.assign(document.createElement('p'), { className: 'note', textContent: t('empty') })] : lines.map((l) => {
    const row = document.createElement('div'); row.className = 'row'; row.dataset.product = l.productId; row.dataset.qty = String(l.quantityMinor);
    const name = document.createElement('span'); name.textContent = `${l.name} × ${l.quantityMinor} — ${inr(l.unitPriceMinor * l.quantityMinor)}`;
    row.append(name);
    if (code === undefined) {
      row.append(iconButton(t('less'), 'package-minus', () => { m.basket.setQuantity(l.productId, l.quantityMinor - 1); lastQuote = null; paint(); }, 'less'));
      row.append(iconButton(t('more'), 'list-plus', () => { add(l.productId); }, 'more'));
    }
    return row;
  })));
  el('sg-shelf').textContent = inr(m.basket.shelfTotalMinor());
  el('sg-shop').textContent = lastQuote === null ? t('notAsked') : lastQuote.priced ? inr(lastQuote.payableMinor ?? 0) : t('unpriced');
  el('sg-shop').dataset.asked = String(lastQuote !== null);
  el('sg-quote').hidden = code !== undefined || lines.length === 0;
  el('sg-till').hidden = code !== undefined || lines.length === 0;
  for (const id of ['sg-add', 'sg-typed']) el(id).disabled = code !== undefined;
  el('sg-code-box').hidden = code === undefined;
  el('sg-new').hidden = code === undefined;
  if (code !== undefined) {
    el('sg-code').textContent = code;
    const recalled = lastHand?.ok === true ? lastHand.value.recalled : null;
    el('sg-code-say').textContent = recalled ? t('recalledAt').replace('{lane}', recalled.laneId) : t('codeSay');
  }
}

function add(codeOrId) {
  const out = model().basket.add(codeOrId);
  if (!out.ok) { say('sg-say', t(`why_${out.why}`), out.why); return; }
  lastQuote = null;
  say('sg-say', `${t('added')} ${out.line.name} (× ${out.line.quantityMinor})`, 'added');
  paint();
}

el('sg-add').addEventListener('click', () => {
  const typed = el('sg-typed').value.trim();
  if (typed === '') { say('sg-say', t('needCode'), 'need_code'); return; }
  add(typed);
  el('sg-typed').value = '';
});
el('sg-quote').addEventListener('click', async () => {
  const m = model();
  el('sg-quote').disabled = true;
  try {
    const out = await shop().commerce.scanQuote(m.linesForTheShop(m.basket.lines()));
    if (!out.ok) { say('sg-say', refusalWords(out), 'refused'); return; }
    lastQuote = out.value; say('sg-say', '');
  } finally { el('sg-quote').disabled = false; }
  paint();
});
el('sg-till').addEventListener('click', async () => {
  const m = model();
  el('sg-till').disabled = true;
  try {
    const out = await shop().commerce.scanHand(m.basket.basketId(), m.linesForTheShop(m.basket.lines()));
    lastHand = out;
    if (!out.ok) { say('sg-say', refusalWords(out), 'refused'); return; }
    m.basket.handed(out.value.code); say('sg-say', '');
  } finally { el('sg-till').disabled = false; }
  paint();
});
el('sg-new').addEventListener('click', () => { model().basket.newTrip(); lastQuote = null; lastHand = null; say('sg-say', ''); paint(); });

// The camera — the phone's own reader; the picture never leaves the phone and the camera closes when scanning ends.
let stopped = false;
async function paintScan() {
  const supported = window.shopBarcode !== undefined && await window.shopBarcode.supported();
  el('sg-scan').hidden = !supported || model()?.basket.tillCode() !== undefined;
}
el('sg-scan').addEventListener('click', async () => {
  const video = el('sg-video');
  let stream = null;
  stopped = false;
  try { stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: 'environment' }, audio: false }); } catch { say('sg-say', t('denied'), 'denied'); return; }
  const reader = window.shopBarcodeStandIn ?? new window.BarcodeDetector({ formats: ['ean_13', 'ean_8', 'upc_a', 'upc_e', 'itf'] });
  el('sg-scan-box').hidden = false;
  say('sg-say', t('looking'), 'looking');
  try {
    video.srcObject = stream;
    await video.play().catch(() => undefined);
    const result = await window.shopBarcode.scanFrames({ reader, frame: () => video, stopped: () => stopped, maxFrames: 150, nextFrame: () => new Promise((r) => { setTimeout(r, 200); }) });
    if (result.found) add(result.code);
    else if (result.why !== 'stopped') say('sg-say', t('none'), 'none');
    else say('sg-say', '');
  } finally {
    for (const track of stream.getTracks()) track.stop();
    video.srcObject = null;
    el('sg-scan-box').hidden = true;
  }
});
el('sg-scan-stop').addEventListener('click', () => { stopped = true; });

// ── The hook app.js calls ─────────────────────────────────────────────────────────────────────────────────────────
window.shopScanAndGoView = {
  render: (view) => {
    if (view !== 'scan' || model() === undefined) return;
    paint(); void paintScan();
    // A basket already with the till: ask which till took it (on opening the screen — the customer's own act).
    if (model().basket.tillCode() !== undefined && shop()?.isSignedIn()) {
      void shop().commerce.scanBaskets().then((out) => {
        if (!out.ok) return;
        const mine = (out.value.baskets ?? []).find((b) => b.code === model().basket.tillCode());
        if (mine !== undefined) { lastHand = { ok: true, value: mine }; paint(); }
      });
    }
  },
};
