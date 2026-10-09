// Write-off CAPTURE — the shop-floor "record a loss" desk (M28-FR-01 · API-04 · §28 · ADR-0024 · P-02 one truth ·
// P-03 control-by-exception · hard rules #2/#5). Every rule lives in the TESTED session model
// (apps/web-erp/src/write-off-capture-session.ts), attached as window.writeOffCaptureSession, built on packages/ui.
// This file only collects the operator's choices into a draft, asks the session to ask or record, and paints the
// outcome. Asking and recording are HUMAN acts in the raiser's own name that run ONLY on an explicit click, never on
// load. A big loss is never recorded on a typed name: the raiser asks, a SECOND person who handles stock approves it
// on their own Approvals page, and "Record the loss" sends it naming that approval — the session says why not
// otherwise, and sends nothing. The loss type is a CHOSEN chip, never free text (M15). No prompt/confirm/alert; no
// fetch/XHR here — the audited POSTs live in the injected ports (browser-entry). No AI records a loss (hard rule #5).

const el = (id) => document.getElementById(id);
let lang = 'en';

// The shell's own bilingual chrome AND the sample stand-in's copy in one place. The chrome string (the sample
// banner) is the SHELL's, not the domain session's, so it is read from here rather than routed through the bundled
// session — whose vocabulary is the loss desk's, not the page frame's.
const CHROME = {
  en: {
    title: 'Record a loss', langName: 'தமிழ்',
    lead: 'Sample form. Connect the store computer to record a real loss.',
    productLabel: 'Which item', locationLabel: 'Where in the store', qtyLabel: 'How many', uomLabel: 'Unit',
    valueLabel: 'What it is worth (₹)', lossTypeLabel: 'What kind of loss',
    evidenceLabel: 'Photo or witness (for a big loss)',
    recordBtn: 'Record the loss',
    lossWastage: 'Wastage', lossDamage: 'Damage', lossExpiry: 'Expired', lossDonation: 'Donation', lossDestruction: 'Destruction',
    thresholdLabel: 'A loss is "big" at or above',
    materialHint: 'This is a big loss — it needs a photo or witness, and a second person who handles stock must approve it.',
    immaterialHint: 'This loss is small enough to record on your own.',
    approvalLead: 'A big loss needs the approval of a second person who handles stock — the store manager or the owner, never you. Write why and press “Ask for approval”. Once they approve it on their Approvals page, press “Record the loss”.',
    whyLabel: 'Why is this a loss? (the person approving reads it)',
    askBtn: 'Ask for approval',
    yourLossesTitle: 'Losses you asked approval for',
    yourLossesLead: 'Once one is approved, press “Carry on with this loss” to put exactly that loss back in the form, then press “Record the loss”.',
    carryOnBtn: 'Carry on with this loss', carriedOn: 'The form now holds exactly the loss you asked about.', whyWord: 'Why:',
    stateNotPermitted: 'You do not have permission to record a loss.',
    nobodyNamed: 'This store computer has not been told who is using this screen.',
    sampleNotConnected: 'This is sample data and is not connected to the store computer or head office — nothing was asked and nothing was recorded.',
    sampleData: 'Sample data — this is not your shop.', },
  ta: {
    title: 'இழப்பைப் பதிவு செய்', langName: 'English',
    lead: 'மாதிரி படிவம். உண்மையான இழப்பைப் பதிவு செய்ய கடை கணினியை இணைக்கவும்.',
    productLabel: 'எந்தப் பொருள்', locationLabel: 'கடையில் எங்கே', qtyLabel: 'எத்தனை', uomLabel: 'அலகு',
    valueLabel: 'மதிப்பு (₹)', lossTypeLabel: 'எந்த வகை இழப்பு',
    evidenceLabel: 'புகைப்படம் அல்லது சாட்சி (பெரிய இழப்புக்கு)',
    recordBtn: 'இழப்பைப் பதிவு செய்',
    lossWastage: 'கழிவு', lossDamage: 'சேதம்', lossExpiry: 'காலாவதி', lossDonation: 'நன்கொடை', lossDestruction: 'அழிப்பு',
    thresholdLabel: 'இதற்குச் சமமாக அல்லது அதற்கு மேல் ஒரு இழப்பு "பெரியது"',
    materialHint: 'இது ஒரு பெரிய இழப்பு — புகைப்படம் அல்லது சாட்சி தேவை; சரக்கைக் கையாளும் இரண்டாம் நபர் அதை அனுமதிக்க வேண்டும்.',
    immaterialHint: 'இந்த இழப்பு நீங்களே பதிவு செய்யும் அளவுக்குச் சிறியது.',
    approvalLead: 'பெரிய இழப்புக்குச் சரக்கைக் கையாளும் இரண்டாம் நபரின் அனுமதி தேவை — கடை மேலாளர் அல்லது உரிமையாளர், நீங்கள் அல்ல. ஏன் என்று எழுதி “அனுமதி கேள்” அழுத்தவும். அவர் தனது அனுமதிகள் பக்கத்தில் அனுமதித்த பிறகு “இழப்பைப் பதிவு செய்” அழுத்தவும்.',
    whyLabel: 'இது ஏன் இழப்பு? (அனுமதிப்பவர் இதைப் படிப்பார்)',
    askBtn: 'அனுமதி கேள்',
    yourLossesTitle: 'நீங்கள் அனுமதி கேட்ட இழப்புகள்',
    yourLossesLead: 'ஒன்று அனுமதிக்கப்பட்டதும், “இந்த இழப்பைத் தொடரவும்” அழுத்தி அதே இழப்பைப் படிவத்தில் மீண்டும் கொண்டு வந்து, பிறகு “இழப்பைப் பதிவு செய்” அழுத்தவும்.',
    carryOnBtn: 'இந்த இழப்பைத் தொடரவும்', carriedOn: 'நீங்கள் கேட்ட அதே இழப்பு இப்போது படிவத்தில் உள்ளது.', whyWord: 'ஏன்:',
    stateNotPermitted: 'இழப்பைப் பதிவு செய்ய உங்களுக்கு அனுமதி இல்லை.',
    nobodyNamed: 'இந்தத் திரையை யார் பயன்படுத்துகிறார்கள் என்று கடைக் கணினிக்குத் தெரியவில்லை.',
    sampleNotConnected: 'இது மாதிரித் தகவல்; கடைக் கணினியுடனோ தலைமை அலுவலகத்துடனோ இணைக்கப்படவில்லை — எதுவும் கேட்கப்படவில்லை, எதுவும் பதிவு செய்யப்படவில்லை.',
    sampleData: 'மாதிரித் தகவல் — இது உங்கள் கடை அல்ல.', },
};

const LOSS_LABEL = { wastage: 'lossWastage', damage: 'lossDamage', expiry: 'lossExpiry', donation: 'lossDonation', destruction: 'lossDestruction' };
const SAMPLE_LOSS_TYPES = ['wastage', 'damage', 'expiry', 'donation', 'destruction'];
const SAMPLE_THRESHOLD_MINOR = 50000; // ₹500 — a clearly-marked sample line, never presented as the shop's

const rupees = (minor) => `₹${Math.floor(Math.abs(minor) / 100).toLocaleString('en-IN')}.${String(Math.abs(minor) % 100).padStart(2, '0')}`;

/** A stand-in with the same surface as the bundled session, so the shell always opens (and says so). It asks nothing
 *  and records nothing — it is not connected to anything. */
function sampleSession() {
  const notConnected = (l) => ({ tone: 'error', icon: '✕', label: CHROME[l].sampleNotConnected, announcement: CHROME[l].sampleNotConnected, needsAttention: true });
  return {
    connected: false,
    text: (l, key) => CHROME[l]?.[key] ?? CHROME.en[key] ?? key,
    isMaterial: (valueMinor) => valueMinor >= SAMPLE_THRESHOLD_MINOR,
    needsApproval: (loss) => loss.valueMinor >= SAMPLE_THRESHOLD_MINOR,
    view: (l) => ({
      screenState: { tone: 'ok', icon: '✓', label: '', announcement: '', needsAttention: false },
      lossTypes: SAMPLE_LOSS_TYPES.map((lt) => ({ lossType: lt, label: CHROME[l][LOSS_LABEL[lt]] })),
      thresholdMinor: SAMPLE_THRESHOLD_MINOR, thresholdText: rupees(SAMPLE_THRESHOLD_MINOR),
      nobodyNamed: false, mayCapture: true,
    }),
    askApproval: async () => ({ kind: 'sample' }),
    record: async () => ({ kind: 'sample' }),
    valueLoss: async () => ({ kind: 'not_connected' }),
    presentValue: () => null,
    yourLosses: async () => ({ state: 'not_connected', rows: [] }),
    presentAskOutcome: (l) => notConnected(l),
    presentRecordOutcome: (l) => notConnected(l),
  };
}

let session = window.writeOffCaptureSession ?? sampleSession();
const chrome = (key) => CHROME[lang]?.[key] ?? CHROME.en[key] ?? key;
/** The session's words; a key the session does not know falls back to the shell's own copy (never a raw key). */
const t = (key) => { const said = session.text(lang, key); return said === key ? chrome(key) : said; };

/** A fresh idempotency key per loss. Held across a retry so a re-send of the SAME loss records once (the route is
 *  idempotent on the id) — and across asking, because an approval is asked ABOUT this id. Regenerated only after a
 *  loss is actually recorded. Not a money rule. */
const newId = () => (self.crypto?.randomUUID?.() ?? `wo-${Date.now()}-${Math.random().toString(36).slice(2)}`);
let writeOffId = newId();
let selectedLossType = null;
/** A finer reason a request was asked with (carried on from "Losses you asked approval for"); dropped on a new chip. */
let carriedReasonCode;
/** Write-offs asked about on this visit — so "Record the loss" becomes the next step even before the list is re-read. */
const askedHere = new Set();

/** The value the operator typed, in paise (₹ × 100). NaN when the box is blank — the session then refuses. */
function valueMinor() {
  const raw = el('wo-value').value.trim();
  const rupeesTyped = raw === '' ? NaN : Number(raw);
  return Number.isFinite(rupeesTyped) ? Math.round(rupeesTyped * 100) : NaN;
}

/** The loss exactly as the form holds it now — what is asked about, and what is recorded. */
function draftNow() {
  return {
    writeOffId,
    productId: el('wo-product').value,
    locationId: el('wo-location').value,
    qty: Math.trunc(Number(el('wo-qty').value)),
    uom: el('wo-uom').value,
    lossType: selectedLossType,
    valueMinor: valueMinor(),
    evidenceRef: el('wo-evidence').value,
    ...(carriedReasonCode === undefined ? {} : { reasonCode: carriedReasonCode }),
  };
}

function paintLossTypes(view) {
  const box = el('loss-types');
  box.replaceChildren(...view.lossTypes.map((c) => {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'chip';
    b.textContent = c.label;
    const chosen = c.lossType === selectedLossType;
    b.setAttribute('aria-pressed', chosen ? 'true' : 'false');
    if (chosen) b.classList.add('chosen');
    b.addEventListener('click', () => { selectedLossType = c.lossType; carriedReasonCode = undefined; paint(); });
    return b;
  }));
}

/** SF-05 — head office's value of the loss in the form: asked when the product, the place or the quantity changes; the
 *  value box is filled with head office's figure and locked. Where head office holds no cost, the box stays open for the
 *  operator's figure and the loss always needs a second person. Without head office (the sample) the box is typed. */
let valueLookup = 0;
let lastValue = null;
async function lookUpValue() {
  const mine = ++valueLookup;
  const outcome = await session.valueLoss({ productId: el('wo-product').value, locationId: el('wo-location').value, qty: Math.trunc(Number(el('wo-qty').value)) });
  if (mine !== valueLookup) return; // a newer question is already on its way
  lastValue = outcome;
  const box = el('wo-value');
  if (outcome.kind === 'valued') box.value = (outcome.valueMinor / 100).toFixed(2);
  else if (box.readOnly) box.value = ''; // head office's earlier figure no longer belongs to this loss
  box.readOnly = outcome.kind === 'valued';
  paintValueHint();
  paintMaterialHint();
}
function paintValueHint() {
  const hint = el('value-hint');
  const p = lastValue === null ? null : session.presentValue(lang, lastValue);
  if (p === null) { hint.hidden = true; return; }
  hint.hidden = false;
  hint.className = `material-hint tone-${p.tone}`;
  el('value-hint-icon').textContent = p.icon;
  el('value-hint-text').textContent = p.label;
}

/** The "big loss" hint and the approval step — shown from the value the operator has typed, against the injected
 *  threshold (or head office's word on this loss), so the operator sees WHY a photo and a second person's approval
 *  become required before they try to record. */
function paintMaterialHint() {
  const hint = el('material-hint');
  const v = valueMinor();
  const typed = Number.isFinite(v) && v > 0;
  const big = typed && session.needsApproval({ writeOffId, valueMinor: v, productId: el('wo-product').value, locationId: el('wo-location').value, qty: Math.trunc(Number(el('wo-qty').value)) });
  el('approval-step').hidden = !big;
  paintNextStep(big);
  if (!typed) { hint.hidden = true; return; }
  hint.hidden = false;
  hint.className = `material-hint ${big ? 'tone-degraded' : 'tone-idle'}`;
  el('material-hint-icon').textContent = big ? '⚠' : 'ℹ';
  el('material-hint-text').textContent = big ? t('materialHint') : t('immaterialHint');
}

function paint() {
  const view = session.view(lang);

  el('title').textContent = t('title');
  el('lead').textContent = t('lead');
  el('whoami').textContent = window.writeOffCaptureData?.userId ?? '';
  el('lang').textContent = chrome('langName');

  const nobody = el('nobody');
  nobody.hidden = !view.nobodyNamed;
  nobody.textContent = view.nobodyNamed ? t('nobodyNamed') : '';

  // The capture form — only for a holder of inventory.movement.append, and only when the box knows who is here
  // (a loss carries the raiser's name).
  const capturer = el('capturer');
  const mayCapture = view.mayCapture && !view.nobodyNamed;
  capturer.hidden = !mayCapture;
  if (mayCapture) {
    el('product-label').textContent = t('productLabel');
    el('location-label').textContent = t('locationLabel');
    el('qty-label').textContent = t('qtyLabel');
    el('uom-label').textContent = t('uomLabel');
    el('value-label').textContent = t('valueLabel');
    el('loss-type-label').textContent = t('lossTypeLabel');
    el('evidence-label').textContent = t('evidenceLabel');
    el('approval-lead').textContent = t('approvalLead');
    el('why-label').textContent = t('whyLabel');
    el('ask').textContent = t('askBtn');
    el('record').textContent = t('recordBtn');
    el('threshold-hint').textContent = `${t('thresholdLabel')} ${view.thresholdText}`;
    el('your-losses-title').textContent = t('yourLossesTitle');
    el('your-losses-lead').textContent = t('yourLossesLead');
    paintLossTypes(view);
    paintMaterialHint();
  }
  paintLosses();

  const state = el('state');
  if (!view.mayCapture) {
    state.hidden = false;
    state.className = `state tone-${view.screenState.tone}`;
    el('state-icon').textContent = view.screenState.icon;
    el('state-text').textContent = view.screenState.label;
  } else {
    state.hidden = true;
  }
}

/** The last answer on screen, as a way to say it again — so switching language re-says it in the other one. */
let lastSaid = null;

/** Show an answer, and remember how to say it in the other language. */
function say(present) {
  lastSaid = present;
  paintResult(present(lang));
}

function paintResult(presentation) {
  const result = el('result');
  if (!result) return;
  result.hidden = false;
  result.className = `result tone-${presentation.tone}`;
  el('result-icon').textContent = presentation.icon;
  el('result-text').textContent = presentation.label;
  result.setAttribute('aria-label', presentation.announcement || presentation.label);
}

// ── "Losses you asked approval for" — the raiser's own requests still in play (a GET, read only) ─────────────

let losses = { state: 'not_connected', rows: [] };

/** One primary action at a time: for a big loss nobody has been asked about yet, "Ask for approval" is the next step;
 *  otherwise "Record the loss" is. Only the look changes — the session decides what each press does. */
function paintNextStep(big) {
  const inPlay = askedHere.has(writeOffId)
    || losses.rows.some((r) => r.writeOffId === writeOffId && (r.approvalStatus === 'waiting' || r.approvalStatus === 'approved'));
  const askFirst = big && !inPlay;
  el('ask').classList.toggle('primary', askFirst);
  el('record').classList.toggle('primary', !askFirst);
}

/** Put a loss asked about earlier back in the form, exactly as it was asked — the same id, the same figures. */
function carryOn(draft) {
  writeOffId = draft.writeOffId;
  el('wo-product').value = draft.productId;
  el('wo-location').value = draft.locationId;
  el('wo-qty').value = String(draft.qty);
  el('wo-uom').value = draft.uom;
  el('wo-value').value = (draft.valueMinor / 100).toFixed(2);
  el('wo-evidence').value = draft.evidenceRef ?? '';
  selectedLossType = draft.lossType;
  carriedReasonCode = draft.reasonCode === draft.lossType ? undefined : draft.reasonCode;
  paint();
  // SF-05: head office values it again — the same figure unless the stock's cost has moved since it was asked about.
  void lookUpValue();
  say(() => ({ tone: 'idle', icon: 'ℹ', label: t('carriedOn'), announcement: t('carriedOn'), needsAttention: false }));
  el('record').focus();
}

function paintLosses() {
  const box = el('your-losses');
  const rows = el('capturer').hidden ? [] : losses.rows;
  box.hidden = rows.length === 0;
  el('loss-requests').replaceChildren(...rows.map((row) => {
    const li = document.createElement('li');
    li.className = 'loss-request';
    const summary = document.createElement('p');
    summary.className = 'loss-summary';
    summary.textContent = row.summary;
    const status = document.createElement('p');
    status.className = `loss-status tone-${row.status.tone}`;
    status.setAttribute('aria-label', row.status.announcement || row.status.label);
    const icon = document.createElement('span');
    icon.setAttribute('aria-hidden', 'true');
    icon.textContent = row.status.icon;
    const words = document.createElement('span');
    words.textContent = row.status.label;
    status.append(icon, words);
    const why = document.createElement('p');
    why.className = 'loss-why';
    why.textContent = `${t('whyWord')} ${row.why} · ${row.askedAt}`;
    li.append(summary, status, why);
    if (row.draft !== null) {
      const carry = document.createElement('button');
      carry.type = 'button';
      carry.className = 'carry';
      carry.textContent = t('carryOnBtn');
      carry.addEventListener('click', () => carryOn(row.draft));
      li.append(carry);
    }
    return li;
  }));
  if (!el('capturer').hidden) paintMaterialHint();
}

async function refreshLosses() {
  if (!session.connected) return;
  const read = await session.yourLosses(lang);
  // Head office's list is the word on what was asked; with no answer, what this page last saw is kept.
  if (read.state === 'read') losses = read;
  paintLosses();
}

/** One click at a time: the button is disabled while its step runs, so a double press never asks or records twice. */
async function busy(id, step) {
  const button = el(id);
  if (button.disabled) return;
  button.disabled = true;
  try { await step(); } finally { button.disabled = false; }
}

// Ask for approval — the raiser's OWN request, in their own session, for exactly the loss in the form. Nothing is
// recorded by asking; a second person who handles stock approves it on their own Approvals page.
el('ask').addEventListener('click', () => {
  void busy('ask', async () => {
    const outcome = await session.askApproval(lang, draftNow(), el('wo-why').value);
    say((l) => session.presentAskOutcome(l, outcome));
    if (outcome.kind === 'asked') { askedHere.add(writeOffId); el('wo-why').value = ''; paintMaterialHint(); await refreshLosses(); }
  });
});

// Record the loss — a HUMAN write that runs ONLY on this explicit click, never on load. Below the limit it goes as it
// is; a big loss goes only naming the raiser's own APPROVED request for exactly this loss. The server re-checks
// everything and records the loss in the caller's own name. Once it is in the books the id rolls over and the form
// clears for the next loss.
el('record').addEventListener('click', () => {
  void busy('record', async () => {
    const result = await session.record(draftNow());
    say((l) => session.presentRecordOutcome(l, result));
    const inTheBooks = result.kind === 'recorded'
      || (result.kind === 'head_office_refused' && result.code === 'write_off_already_recorded');
    if (inTheBooks) {
      for (const id of ['wo-product', 'wo-location', 'wo-qty', 'wo-value', 'wo-evidence', 'wo-why']) el(id).value = '';
      el('wo-value').readOnly = false;
      lastValue = null;
      paintValueHint();
      selectedLossType = null;
      carriedReasonCode = undefined;
      writeOffId = newId();
      paint();
      await refreshLosses();
    } else if (result.kind === 'head_office_refused') {
      // Head office may call a loss big that this page did not: the approval step appears for it now.
      paintMaterialHint();
    }
  });
});

el('wo-value').addEventListener('input', () => paintMaterialHint());
for (const id of ['wo-product', 'wo-location', 'wo-qty']) el(id).addEventListener('change', () => { void lookUpValue(); });

el('lang').addEventListener('click', () => {
  lang = lang === 'en' ? 'ta' : 'en';
  document.documentElement.lang = lang;
  paint();
  paintValueHint();
  if (lastSaid !== null) paintResult(lastSaid(lang));
  void refreshLosses();
});

el('sample').hidden = window.writeOffCaptureSession !== undefined;
el('sample').textContent = chrome('sampleData');
paint();
void refreshLosses();

if ('serviceWorker' in navigator) {
  navigator.serviceWorker.register('./sw.js').catch(() => {
    /* the screen still opens; it just will not be there without a network */
  });
}
