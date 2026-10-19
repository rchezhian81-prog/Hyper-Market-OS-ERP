// Customer app — R4 Lane 2 (B23 · D-28 · WF-16 · M20-FR-04 · D01-FR-06): the online store's view layer, beside app.js.
//
//   • BEFORE YOU PAY (B23): for every product in the basket, every detail the shop must show — the MRP, the price with
//     tax, the delivery fee and the total, the best-before, the country of origin, the shop's legal name, address and
//     GSTIN, the return terms and the grievance officer — each as the SHOP said it, "not set" where the shop has not set
//     it (OB-223), and whether the product is sold online at all. Nothing here is composed by the phone.
//   • MY RECEIPTS (D-28): one switch, the same control both ways (OB-214); copies of my own bills; a card shows its last
//     four digits only; sending by SMS or WhatsApp is switched off and the page says so (OB-222).
//   • MY RETURNS (WF-16): each step as the shop recorded it; a refund the bank has not confirmed reads "waiting".
//   • STARS (M20-FR-04): rate what I bought, 1 to 5 stars — no place for words (OB-218); the shop's average and count.
//   • IMAGES (D01-FR-06): a product's photo from the shop's own server, when it has one; without one nothing changes.
// No prompt, confirm or alert; nothing on a timer; every state in words.

const el = (id) => document.getElementById(id);
const inr = (minor) => '₹' + (minor / 100).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const lang = () => (document.documentElement.lang === 'ta' ? 'ta' : 'en');

const W = {
  en: {
    dutiesTitle: 'Before you pay', signInForDuties: 'Sign in to see every detail the shop must show before you pay.',
    noLines: 'Your basket is empty.', loading: 'Asking the shop…', notOnline: 'Not sold online yet', soldOnline: 'Sold online',
    storeNotOpen: 'The online store is not open yet', storeOpen: 'The online store is open', seller: 'Sold by', notSet: 'not set',
    notInShopList: 'The shop has no online details for this product.', stars: 'stars', notRated: 'Not rated yet', ratedBy: 'from',
    MRP: 'MRP', 'selling price with tax': 'Price with tax', 'delivery fee': 'Delivery fee', 'best-before date': 'Best before',
    'country of origin': 'Country of origin', 'shop legal name': 'Shop', 'shop address': 'Address', 'shop GSTIN': 'GSTIN',
    'return and refund terms': 'Returns and refunds', 'grievance officer name': 'Grievance officer', 'grievance officer contact': 'Grievance officer contact',
    total: 'Total with delivery', 'does not carry one': 'does not carry one', free: 'free',
    receiptsTitle: 'My receipts', receiptsLabel: 'Digital receipts', on: 'ON', off: 'OFF',
    receiptsWhy: 'Only if you switch this on, a copy of each bill appears here after the till sends it to the shop.',
    sendingOff: 'Sending receipts by SMS or WhatsApp is switched off — nothing is sent.', notLinked: 'Your app is not yet tied to your loyalty membership. Show this reference at the service desk with your phone:',
    noReceipts: 'No bills yet.', bill: 'Bill', tax: 'GST included', paid: 'Paid',
    returnsTitle: 'My returns', noReturns: 'You have not asked to return anything.', policyNotSet: 'The shop has not set its return windows yet ("not set"), so a return cannot be judged — raise a complaint and the shop will help.',
    policySet: 'Return windows by department, in days after delivery:',
    rateTitle: 'Rate what you bought', rateNone: 'Rate products once your order has reached you.', rated: 'Thank you — your stars are saved.',
    signIn: 'Please sign in first.', offline: 'Not saved — no connection. Please try again.', refused: 'The shop did not accept this:', busy: 'The shop could not answer just now. Please try again.',
  },
  ta: {
    dutiesTitle: 'பணம் செலுத்தும் முன்', signInForDuties: 'பணம் செலுத்தும் முன் கடை காட்ட வேண்டிய ஒவ்வொரு விவரத்தையும் பார்க்க உள்நுழையுங்கள்.',
    noLines: 'உங்கள் கூடை காலியாக உள்ளது.', loading: 'கடையிடம் கேட்கிறது…', notOnline: 'இன்னும் ஆன்லைனில் விற்கப்படவில்லை', soldOnline: 'ஆன்லைனில் விற்கப்படுகிறது',
    storeNotOpen: 'ஆன்லைன் கடை இன்னும் திறக்கப்படவில்லை', storeOpen: 'ஆன்லைன் கடை திறந்துள்ளது', seller: 'விற்பவர்', notSet: 'அமைக்கப்படவில்லை',
    notInShopList: 'இந்தப் பொருளுக்குக் கடையிடம் ஆன்லைன் விவரங்கள் இல்லை.', stars: 'நட்சத்திரங்கள்', notRated: 'இன்னும் மதிப்பிடப்படவில்லை', ratedBy: 'மொத்தம்',
    MRP: 'MRP', 'selling price with tax': 'வரி உட்பட விலை', 'delivery fee': 'விநியோகக் கட்டணம்', 'best-before date': 'சிறந்த பயன்பாட்டுத் தேதி',
    'country of origin': 'பிறந்த நாடு', 'shop legal name': 'கடை', 'shop address': 'முகவரி', 'shop GSTIN': 'GSTIN',
    'return and refund terms': 'திருப்பி அனுப்புதல் மற்றும் பணம் திருப்புதல்', 'grievance officer name': 'குறைதீர்ப்பு அலுவலர்', 'grievance officer contact': 'குறைதீர்ப்பு அலுவலர் தொடர்பு',
    total: 'விநியோகத்துடன் மொத்தம்', 'does not carry one': 'இல்லை', free: 'இலவசம்',
    receiptsTitle: 'என் ரசீதுகள்', receiptsLabel: 'டிஜிட்டல் ரசீதுகள்', on: 'இயக்கம்', off: 'நிறுத்தம்',
    receiptsWhy: 'இதை இயக்கினால் மட்டும், கட்டணப் பகுதி கடைக்கு அனுப்பிய பிறகு ஒவ்வொரு பில்லின் நகலும் இங்கே தோன்றும்.',
    sendingOff: 'SMS அல்லது WhatsApp மூலம் ரசீது அனுப்புதல் நிறுத்தப்பட்டுள்ளது — எதுவும் அனுப்பப்படாது.', notLinked: 'உங்கள் செயலி இன்னும் உங்கள் உறுப்பினர் கணக்குடன் இணைக்கப்படவில்லை. உங்கள் தொலைபேசியுடன் சேவை மையத்தில் இந்தக் குறிப்பைக் காட்டுங்கள்:',
    noReceipts: 'இன்னும் பில்கள் இல்லை.', bill: 'பில்', tax: 'GST உட்பட', paid: 'செலுத்தியது',
    returnsTitle: 'என் திருப்பி அனுப்புதல்கள்', noReturns: 'நீங்கள் எதையும் திருப்பி அனுப்பக் கேட்கவில்லை.', policyNotSet: 'கடை இன்னும் திருப்பி அனுப்பும் காலத்தை அமைக்கவில்லை ("அமைக்கப்படவில்லை"); அதுவரை புகார் எழுப்பினால் கடை உதவும்.',
    policySet: 'பிரிவு வாரியாக, விநியோகத்திற்குப் பிறகு திருப்பி அனுப்பும் நாட்கள்:',
    rateTitle: 'நீங்கள் வாங்கியதை மதிப்பிடுங்கள்', rateNone: 'உங்கள் ஆர்டர் வந்த பிறகு பொருட்களை மதிப்பிடலாம்.', rated: 'நன்றி — உங்கள் நட்சத்திரங்கள் சேமிக்கப்பட்டன.',
    signIn: 'முதலில் உள்நுழையுங்கள்.', offline: 'சேமிக்கப்படவில்லை — இணைப்பு இல்லை. மீண்டும் முயலுங்கள்.', refused: 'கடை இதை ஏற்கவில்லை:', busy: 'கடையால் இப்போது பதில் அளிக்க முடியவில்லை. மீண்டும் முயலுங்கள்.',
  },
};
const t = (k) => W[lang()][k] ?? W.en[k] ?? k;
const shopNow = () => window.shop;
const signedIn = () => shopNow()?.online !== undefined && shopNow().isSignedIn();
const refusalWords = (out) => (out.refusal === 'not_signed_in' ? t('signIn') : out.refusal === 'not_saved_no_connection' ? t('offline') : out.refusal === 'the_shop_could_not_answer' ? t('busy') : `${t('refused')} ${out.shopSaid ?? ''}`);
const nameOf = (id) => (window.shopData?.products ?? []).find((p) => p.productId === id)?.name ?? id;

let listing = null;
const pictures = new Map(); // productId → data address from the shop's own server, or null when it has none

async function loadListing() {
  if (!signedIn()) { listing = null; return; }
  const out = await shopNow().online.listing();
  listing = out.ok ? out.value : null;
  for (const p of listing?.products ?? []) {
    if (p.image === undefined || pictures.has(`${p.productId}:${p.image.version}`)) continue;
    const pic = await shopNow().online.image(p.productId);
    pictures.set(`${p.productId}:${p.image.version}`, pic.ok ? pic.value : null);
  }
}

function dutyList(lines) {
  const dl = document.createElement('dl');
  dl.className = 'duties';
  for (const l of lines) {
    const d = document.createElement('div');
    d.dataset.field = l.field;
    const dt = document.createElement('dt'); dt.textContent = t(l.field);
    const dd = document.createElement('dd');
    const unset = l.value === 'not set';
    dd.textContent = unset ? t('notSet') : l.value === 'does not carry one' ? t('does not carry one') : l.value === 'free' ? t('free') : l.value;
    if (unset) dd.className = 'unset';
    d.append(dt, dd);
    dl.append(d);
  }
  return dl;
}

function starsText(rating) {
  if (rating === undefined || rating.count === 0) return t('notRated');
  return `★ ${rating.average.toFixed(1)} ${t('stars')} (${t('ratedBy')} ${rating.count})`;
}

function renderDuties() {
  const box = el('duties');
  const head = el('duties-shop');
  if (!box || !head) return;
  el('duties-title').textContent = t('dutiesTitle');
  const s = shopNow()?.state?.();
  const lines = (s?.lines ?? []).filter((l) => l.quantityMinor > 0);
  if (!signedIn()) { head.textContent = t('signInForDuties'); box.replaceChildren(); return; }
  if (listing === null) { head.textContent = t('loading'); box.replaceChildren(); return; }
  const shop = listing.shop;
  head.textContent = `${listing.onlineStore.open ? t('storeOpen') : `${t('storeNotOpen')}: ${listing.onlineStore.notOpenBecause ?? ''}`} · ${t('seller')}: ${shop.legalName === 'not set' ? t('notSet') : shop.legalName}`;
  if (lines.length === 0) { box.replaceChildren(); return; }
  box.replaceChildren(...lines.map((l) => {
    const row = document.createElement('div');
    row.className = 'row';
    row.dataset.productId = l.productId;
    const p = (listing.products ?? []).find((x) => x.productId === l.productId);
    const name = document.createElement('span'); name.className = 'name'; name.textContent = p?.name ?? nameOf(l.productId);
    const state = document.createElement('span'); state.className = 'state';
    if (p === undefined) { state.textContent = t('notInShopList'); row.append(name, state); return row; }
    state.textContent = p.soldOnline ? t('soldOnline') : `${t('notOnline')}: ${p.notOnline}`;
    row.append(name, state);
    const src = p.image === undefined ? null : pictures.get(`${p.productId}:${p.image.version}`);
    if (src) { const img = document.createElement('img'); img.className = 'pic'; img.src = src; img.alt = p.name; row.append(img); }
    const stars = document.createElement('p'); stars.className = 'note rating'; stars.textContent = starsText(p.rating); row.append(stars);
    row.append(dutyList(p.lines));
    if (typeof p.goodsMinor === 'number' && typeof p.deliveryFeeMinor === 'number') {
      const total = document.createElement('p'); total.className = 'note total';
      total.textContent = `${t('total')}: ${inr(p.goodsMinor * l.quantityMinor + p.deliveryFeeMinor)}`;
      row.append(total);
    }
    return row;
  }));
}

// ── D-28 · My receipts ──────────────────────────────────────────────────────────────────────────────────────────────

let receiptsOn = false;
async function renderReceipts() {
  const sw = el('receipts-switch');
  if (!sw) return;
  el('receipts-title').textContent = t('receiptsTitle');
  el('receipts-label').textContent = t('receiptsLabel');
  el('receipts-why').textContent = t('receiptsWhy');
  el('receipts-sending').textContent = t('sendingOff');
  if (!signedIn()) { sw.disabled = true; el('receipts').replaceChildren(); el('receipts-say').textContent = t('signIn'); paintSwitch(); return; }
  sw.disabled = false;
  const choice = await shopNow().online.receiptChoice();
  if (!choice.ok) { el('receipts-say').textContent = refusalWords(choice); return; }
  receiptsOn = choice.value.on === true;
  paintSwitch();
  const mine = await shopNow().online.receipts();
  if (!mine.ok) { el('receipts-say').textContent = refusalWords(mine); return; }
  el('receipts-say').textContent = choice.value.member === null ? `${t('notLinked')} ${choice.value.appReference}` : mine.value.count === 0 ? t('noReceipts') : '';
  el('receipts').replaceChildren(...(mine.value.receipts ?? []).map((r) => {
    const row = document.createElement('div');
    row.className = 'row';
    row.dataset.receipt = r.receiptNumber;
    const head = document.createElement('span'); head.className = 'name'; head.textContent = `${t('bill')} ${r.receiptNumber} — ${r.tradingDay}`;
    const total = document.createElement('span'); total.className = 'price'; total.textContent = inr(r.totalMinor);
    const lines = document.createElement('p'); lines.className = 'note lines'; lines.textContent = r.lines.map((l) => `${l.quantityMinor} × ${l.name} ${inr(l.lineTotalMinor)}`).join(' · ');
    const tax = document.createElement('p'); tax.className = 'note tax'; tax.textContent = `${t('tax')}: ${inr(r.taxMinor)}`;
    const paid = document.createElement('p'); paid.className = 'note paid'; paid.textContent = `${t('paid')}: ${r.payments.map((p) => p.say).join(' · ')}`;
    row.append(head, total, lines, tax, paid);
    return row;
  }));
}
function paintSwitch() {
  const sw = el('receipts-switch');
  sw.setAttribute('aria-checked', String(receiptsOn));
  sw.textContent = receiptsOn ? t('on') : t('off');
}
el('receipts-switch')?.addEventListener('click', async () => {
  // One switch, the same control both ways — no confirmation on the way out (DPDP s.6(6), OB-214).
  const out = await shopNow().online.setReceipts(!receiptsOn);
  if (out.ok) receiptsOn = out.value; else el('receipts-say').textContent = refusalWords(out);
  void renderReceipts();
});

// ── WF-16 · My returns, and M20-FR-04 · stars ──────────────────────────────────────────────────────────────────────

async function renderReturns() {
  const list = el('my-returns');
  if (!list) return;
  el('my-returns-title').textContent = t('returnsTitle');
  el('rate-title').textContent = t('rateTitle');
  if (!signedIn()) { list.replaceChildren(); el('my-returns-empty').hidden = true; el('return-policy-say').textContent = ''; renderRateLines([]); return; }
  const policy = await shopNow().online.returnPolicy();
  if (policy.ok) {
    const w = policy.value.policy.windowDaysByCategory ?? {};
    el('return-policy-say').textContent = Object.keys(w).length === 0 ? t('policyNotSet') : `${t('policySet')} ${Object.entries(w).map(([c, d]) => `${c} ${d}`).join(', ')}`;
  }
  const out = await shopNow().online.returns();
  if (!out.ok) { el('return-policy-say').textContent = refusalWords(out); return; }
  el('my-returns-empty').hidden = out.value.count > 0;
  el('my-returns-empty').textContent = t('noReturns');
  list.replaceChildren(...out.value.returns.map((r) => {
    const row = document.createElement('div');
    row.className = 'row';
    row.dataset.returnId = r.returnId;
    row.dataset.stage = r.stage;
    const head = document.createElement('span'); head.className = 'name'; head.textContent = `${r.returnId} — ${r.stageSay}`;
    row.append(head);
    for (const s of r.steps) { const p = document.createElement('p'); p.className = 'note step'; p.textContent = s.say; row.append(p); }
    return row;
  }));
  const ratings = await shopNow().online.myRatings();
  const mine = new Map(ratings.ok ? ratings.value.ratings.map((x) => [x.productId, x.stars]) : []);
  const order = shopNow().state().order;
  renderRateLines(order === undefined ? [] : (shopNow().state().review?.lines ?? shopNow().state().lines).map((l) => l.productId), mine);
}

function renderRateLines(productIds, mine = new Map()) {
  const box = el('rate-lines');
  if (!box) return;
  if (productIds.length === 0) { box.replaceChildren(); el('rate-say').textContent = signedIn() ? t('rateNone') : ''; return; }
  box.replaceChildren(...[...new Set(productIds)].map((id) => {
    const row = document.createElement('div');
    row.className = 'row';
    row.dataset.productId = id;
    const name = document.createElement('span'); name.className = 'name'; name.textContent = nameOf(id);
    const stars = document.createElement('div'); stars.className = 'stars'; stars.setAttribute('role', 'group'); stars.setAttribute('aria-label', `${t('rateTitle')}: ${nameOf(id)}`);
    for (let n = 1; n <= 5; n += 1) {
      const b = document.createElement('button');
      b.type = 'button';
      b.dataset.stars = String(n);
      b.textContent = `${n} ★`;
      b.setAttribute('aria-label', `${n} ${t('stars')}`);
      b.setAttribute('aria-pressed', String(mine.get(id) === n));
      b.addEventListener('click', async () => {
        const out = await shopNow().online.rate(id, n);
        el('rate-say').textContent = out.ok ? t('rated') : refusalWords(out);
        void renderReturns();
      });
      stars.append(b);
    }
    row.append(name, stars);
    return row;
  }));
}

// ── The hooks app.js calls, and the words that change with the language ────────────────────────────────────────────

function paintLegal() {
  const privacy = el('link-privacy'); const terms = el('link-terms');
  if (privacy) privacy.textContent = lang() === 'ta' ? 'தனியுரிமை' : 'Privacy';
  if (terms) terms.textContent = lang() === 'ta' ? 'விதிமுறைகள், திருப்பி அனுப்புதல் மற்றும் பணம் திருப்புதல்' : 'Terms, returns and refunds';
}

window.shopR4 = {
  render: (view) => {
    paintLegal();
    if (view === 'basket') { renderDuties(); if (signedIn()) void loadListing().then(renderDuties); }
    if (view === 'order') void renderReturns();
    if (view === 'privacy') void renderReceipts();
  },
  signedIn: async () => { await loadListing(); renderDuties(); },
};
paintLegal();
renderDuties();
