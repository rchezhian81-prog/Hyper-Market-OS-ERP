// Write-off CAPTURE — the shop-floor "record a loss" desk (M28-FR-01 · API-04 · §28 · P-02 one truth ·
// P-03 control-by-exception · hard rules #2/#5). Every rule lives in the TESTED session model
// (apps/web-erp/src/write-off-capture-session.ts), attached as window.writeOffCaptureSession, built on
// packages/ui. This file only collects the operator's choices into a draft and asks the session to record it,
// then paints the outcome. Recording is a HUMAN write in the raiser's own name that runs ONLY on an explicit
// click, never on load; the session refuses BEFORE any POST the cases the operator can see are wrong (no
// permission, an incomplete form, or a MATERIAL loss with no evidence / no separate approver / the raiser
// approving their own — §28). The server re-checks all of it and records the loss in the caller's own name.
// The loss type is a CHOSEN chip, never free text (M15). No prompt/confirm/alert; no fetch/XHR here — the
// audited POST lives in the injected port (browser-entry). No AI records a loss (hard rule #5).

const el = (id) => document.getElementById(id);
let lang = 'en';

// The shell's own bilingual chrome AND the sample stand-in's copy in one place. The two chrome strings
// (sample banner, stale strip) are the SHELL's, not the domain session's, so they are read from here rather
// than routed through the bundled session — whose vocabulary is the loss desk's, not the page frame's.
const CHROME = {
  en: {
    title: 'Record a loss', langName: 'தமிழ்',
    lead: 'Sample form. Connect the store computer to record a real loss.',
    productLabel: 'Which item', locationLabel: 'Where in the store', qtyLabel: 'How many', uomLabel: 'Unit',
    valueLabel: 'What it is worth (₹)', lossTypeLabel: 'What kind of loss',
    evidenceLabel: 'Photo or witness (for a big loss)', approverLabel: 'Manager approving (a different person)',
    recordBtn: 'Record the loss',
    lossWastage: 'Wastage', lossDamage: 'Damage', lossExpiry: 'Expired', lossDonation: 'Donation', lossDestruction: 'Destruction',
    thresholdLabel: 'A loss is "big" at or above', materialHint: 'This is a big loss — it needs a photo or witness and a manager to approve it.',
    immaterialHint: 'This loss is small enough to record on your own.',
    recorded: 'Loss recorded. The shelf figure has come down.',
    needsEvidence: 'This is a big loss — capture a photo or witness before recording it.',
    needsApproval: 'This is a big loss — a different person (a manager) must approve it. You cannot approve your own.',
    approverNotAuthorised: 'That person cannot approve a loss. Ask a manager or the owner.',
    conflict: 'This loss was already recorded. Nothing was recorded again.',
    refused: 'Could not record the loss — check the item, quantity and value, and your permission.',
    lostLink: 'No connection — not saved. Try again.',
    stateNotPermitted: 'You do not have permission to record a loss.',
    nobodyNamed: 'This store computer has not been told who is using this screen.',
    sampleData: 'Sample data — this is not your shop.', staleShell: 'No connection to the store computer. This page is what it was last told, at',
  },
  ta: {
    title: 'இழப்பைப் பதிவு செய்', langName: 'English',
    lead: 'மாதிரி படிவம். உண்மையான இழப்பைப் பதிவு செய்ய கடை கணினியை இணைக்கவும்.',
    productLabel: 'எந்தப் பொருள்', locationLabel: 'கடையில் எங்கே', qtyLabel: 'எத்தனை', uomLabel: 'அலகு',
    valueLabel: 'மதிப்பு (₹)', lossTypeLabel: 'எந்த வகை இழப்பு',
    evidenceLabel: 'புகைப்படம் அல்லது சாட்சி (பெரிய இழப்புக்கு)', approverLabel: 'அனுமதிக்கும் மேலாளர் (வேறு ஒருவர்)',
    recordBtn: 'இழப்பைப் பதிவு செய்',
    lossWastage: 'கழிவு', lossDamage: 'சேதம்', lossExpiry: 'காலாவதி', lossDonation: 'நன்கொடை', lossDestruction: 'அழிப்பு',
    thresholdLabel: 'இதற்குச் சமமாக அல்லது அதற்கு மேல் ஒரு இழப்பு "பெரியது"', materialHint: 'இது ஒரு பெரிய இழப்பு — புகைப்படம் அல்லது சாட்சி மற்றும் அதை அனுமதிக்க ஒரு மேலாளர் தேவை.',
    immaterialHint: 'இந்த இழப்பு நீங்களே பதிவு செய்யும் அளவுக்குச் சிறியது.',
    recorded: 'இழப்பு பதிவு செய்யப்பட்டது. அலமாரி எண்ணிக்கை குறைந்தது.',
    needsEvidence: 'இது ஒரு பெரிய இழப்பு — பதிவு செய்வதற்கு முன் புகைப்படம் அல்லது சாட்சியைப் பிடிக்கவும்.',
    needsApproval: 'இது ஒரு பெரிய இழப்பு — வேறு ஒருவர் (ஒரு மேலாளர்) அனுமதிக்க வேண்டும். உங்கள் சொந்ததை நீங்கள் அனுமதிக்க முடியாது.',
    approverNotAuthorised: 'அந்த நபர் ஒரு இழப்பை அனுமதிக்க முடியாது. ஒரு மேலாளர் அல்லது உரிமையாளரிடம் கேளுங்கள்.',
    conflict: 'இந்த இழப்பு ஏற்கனவே பதிவு செய்யப்பட்டது. மீண்டும் எதுவும் பதிவு செய்யப்படவில்லை.',
    refused: 'இழப்பைப் பதிவு செய்ய முடியவில்லை — பொருள், எண்ணிக்கை, மதிப்பு மற்றும் உங்கள் அனுமதியைச் சரிபார்க்கவும்.',
    lostLink: 'இணைப்பு இல்லை — சேமிக்கப்படவில்லை. மீண்டும் முயற்சிக்கவும்.',
    stateNotPermitted: 'இழப்பைப் பதிவு செய்ய உங்களுக்கு அனுமதி இல்லை.',
    nobodyNamed: 'இந்தத் திரையை யார் பயன்படுத்துகிறார்கள் என்று கடைக் கணினிக்குத் தெரியவில்லை.',
    sampleData: 'மாதிரித் தகவல் — இது உங்கள் கடை அல்ல.', staleShell: 'கடை கணினியுடன் இணைப்பு இல்லை. இந்தப் பக்கம் கடைசியாகச் சொல்லப்பட்டது:',
  },
};

const LOSS_LABEL = { wastage: 'lossWastage', damage: 'lossDamage', expiry: 'lossExpiry', donation: 'lossDonation', destruction: 'lossDestruction' };
const SAMPLE_LOSS_TYPES = ['wastage', 'damage', 'expiry', 'donation', 'destruction'];
const SAMPLE_THRESHOLD_MINOR = 50000; // ₹500 — a clearly-marked sample line, never presented as the shop's

const rupees = (minor) => `₹${Math.floor(Math.abs(minor) / 100).toLocaleString('en-IN')}.${String(Math.abs(minor) % 100).padStart(2, '0')}`;

/** A stand-in with the same surface as the bundled session, so the shell always opens (and says so). */
function sampleSession() {
  const status = (l, key, tone, icon, needsAttention) => ({ tone, icon, label: CHROME[l][key], announcement: CHROME[l][key], needsAttention });
  return {
    text: (l, key) => CHROME[l]?.[key] ?? CHROME.en[key] ?? key,
    isMaterial: (valueMinor) => valueMinor >= SAMPLE_THRESHOLD_MINOR,
    view: (l) => ({
      screenState: { tone: 'ok', icon: '✓', label: '', announcement: '', needsAttention: false },
      lossTypes: SAMPLE_LOSS_TYPES.map((lt) => ({ lossType: lt, label: CHROME[l][LOSS_LABEL[lt]] })),
      thresholdMinor: SAMPLE_THRESHOLD_MINOR, thresholdText: rupees(SAMPLE_THRESHOLD_MINOR),
      nobodyNamed: false, mayCapture: true,
    }),
    record: async () => 'lost_link',
    presentResult: (l, result) => {
      switch (result) {
        case 'recorded': return status(l, 'recorded', 'ok', '✓', false);
        case 'needs_evidence': return status(l, 'needsEvidence', 'degraded', '📷', true);
        case 'needs_approval': return status(l, 'needsApproval', 'degraded', '⚠', true);
        case 'approver_not_authorised': return status(l, 'approverNotAuthorised', 'error', '✕', true);
        case 'conflict': return status(l, 'conflict', 'degraded', 'ℹ', false);
        case 'lost_link': return status(l, 'lostLink', 'degraded', '⚠', true);
        default: return status(l, 'refused', 'error', '✕', true);
      }
    },
  };
}

let session = window.writeOffCaptureSession ?? sampleSession();
const t = (key) => session.text(lang, key);
const chrome = (key) => CHROME[lang]?.[key] ?? CHROME.en[key] ?? key;

/** A fresh idempotency key per loss. Held across a retry so a re-send of the SAME loss records once (the route
 *  is idempotent on the id); regenerated only after a loss is actually recorded. Not a money rule. */
const newId = () => (self.crypto?.randomUUID?.() ?? `wo-${Date.now()}-${Math.random().toString(36).slice(2)}`);
let writeOffId = newId();
let selectedLossType = null;

/** The value the operator typed, in paise (₹ × 100). NaN when the box is blank — the session then refuses. */
function valueMinor() {
  const rupeesTyped = Number(el('wo-value').value);
  return Number.isFinite(rupeesTyped) ? Math.round(rupeesTyped * 100) : NaN;
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
    b.addEventListener('click', () => { selectedLossType = c.lossType; paint(); });
    return b;
  }));
}

/** The "big loss" hint — shown from the value the operator has typed, against the injected threshold, so the
 *  operator sees WHY evidence + a second signature become required before they try to record. */
function paintMaterialHint() {
  const hint = el('material-hint');
  const v = valueMinor();
  if (!Number.isFinite(v) || v <= 0) { hint.hidden = true; return; }
  const material = session.isMaterial(v);
  hint.hidden = false;
  hint.className = `material-hint ${material ? 'tone-degraded' : 'tone-idle'}`;
  el('material-hint-icon').textContent = material ? '⚠' : 'ℹ';
  el('material-hint-text').textContent = material ? t('materialHint') : t('immaterialHint');
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
    el('approver-label').textContent = t('approverLabel');
    el('record').textContent = t('recordBtn');
    el('threshold-hint').textContent = `${t('thresholdLabel')} ${view.thresholdText}`;
    paintLossTypes(view);
    paintMaterialHint();
  }

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

function paintResult(presentation) {
  const result = el('result');
  if (!result) return;
  result.hidden = false;
  result.className = `result tone-${presentation.tone}`;
  el('result-icon').textContent = presentation.icon;
  el('result-text').textContent = presentation.label;
  result.setAttribute('aria-label', presentation.announcement || presentation.label);
}

// The raiser's decision — a HUMAN write that runs ONLY on this explicit click, never on load. The session
// refuses locally before any POST (no permission, incomplete form, or a material loss missing its evidence /
// separate approver / the raiser approving their own — §28); the server re-checks everything and records the
// loss in the caller's own name. On success the id rolls over and the form clears for the next loss.
el('record').addEventListener('click', () => {
  void (async () => {
    const approver = el('wo-approver').value.trim();
    const draft = {
      writeOffId,
      productId: el('wo-product').value,
      locationId: el('wo-location').value,
      qty: Math.trunc(Number(el('wo-qty').value)),
      uom: el('wo-uom').value,
      lossType: selectedLossType,
      valueMinor: valueMinor(),
      evidenceRef: el('wo-evidence').value,
      approval: approver === '' ? undefined : { by: approver },
    };
    const result = await session.record(draft);
    paintResult(session.presentResult(lang, result));
    if (result === 'recorded') {
      for (const id of ['wo-product', 'wo-location', 'wo-qty', 'wo-value', 'wo-evidence', 'wo-approver']) el(id).value = '';
      selectedLossType = null;
      writeOffId = newId();
      paint();
    }
  })();
});

el('wo-value').addEventListener('input', () => paintMaterialHint());

el('lang').addEventListener('click', () => { lang = lang === 'en' ? 'ta' : 'en'; document.documentElement.lang = lang; paint(); paintStale(); });

el('sample').hidden = window.writeOffCaptureSession !== undefined;
el('sample').textContent = chrome('sampleData');
paint();

function paintStale() {
  const at = window.shellCachedAt;
  const strip = el('stale');
  if (!strip) return;
  strip.hidden = at === undefined;
  if (at === undefined) return;
  strip.textContent = `${chrome('staleShell')} ${new Date(at).toLocaleString()}`;
}
paintStale();
el('lang').addEventListener('click', paintStale);

if ('serviceWorker' in navigator) {
  navigator.serviceWorker.register('./sw.js').catch(() => {
    /* the screen still opens; it just will not be there without a network */
  });
}
