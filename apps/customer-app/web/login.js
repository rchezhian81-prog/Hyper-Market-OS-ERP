// Customer / B2B portal sign-in — the THIN CLIENT (M02 / M20 / M22).
//
// It holds no password, no signing key and no token-minting code. It talks to the customer sign-in
// service (services/identity/src/customer-sign-in.ts, behind /auth/otp/ on the public proxy) and keeps
// only the short-lived token, in memory, for the tab's life. The session itself lives on that service
// behind an HttpOnly cookie this script cannot read. In the E2E the same service runs with a recording
// SMS transport and the local test identity provider; in this build no SMS provider is connected, so the
// service refuses to send a code and this page says so in plain words (OB-222).

const $ = (id) => document.getElementById(id);

const stepPhone = $('step-phone');
const stepCode = $('step-code');
const stepAccount = $('step-account');
const statusEl = $('status');
const resultEl = $('result');

// Held in memory only — never localStorage, never a cookie this script sets.
let challengeId = null;
let session = null; // { token }

// U0 · G20 (UI/UX gap audit, 1 Nov 2026 · §1 rule 6): one language at a time, switched by the reader and remembered on
// this device. The page's own words are in the HTML in both languages (`[lang]` spans, the other hidden by the
// stylesheet); every sentence this script writes carries both and shows the reader's.
const LANG_KEY = 'sre-lang';
const remembered = () => { try { return localStorage.getItem(LANG_KEY) === 'ta' ? 'ta' : 'en'; } catch { return 'en'; } };
const lang = () => (document.documentElement.lang === 'ta' ? 'ta' : 'en');
const pick = (words) => (typeof words === 'string' ? words : (lang() === 'ta' ? (words.ta || words.en) : words.en));
let status = { words: { en: '', ta: '' }, kind: '' };
let result = { en: '', ta: '' };
const paintWords = () => {
  statusEl.textContent = pick(status.words);
  statusEl.className = `status ${status.kind}`.trim();
  resultEl.textContent = pick(result);
};
const setStatus = (words, kind = '') => { status = { words, kind }; paintWords(); };
const setResult = (words) => { result = typeof words === 'string' ? { en: words, ta: words } : words; paintWords(); };
document.documentElement.lang = remembered();
$('lang').addEventListener('click', () => {
  const next = lang() === 'ta' ? 'en' : 'ta';
  document.documentElement.lang = next;
  try { localStorage.setItem(LANG_KEY, next); } catch { /* a device that remembers nothing still switches */ }
  paintWords();
});

async function post(path, body) {
  const res = await fetch(path, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  return res.json();
}

/** The service's refusal in both languages — the reason it gave, never a guess (P-08). */
function refusalWords(out, fallback) {
  const code = out?.error?.code ?? out?.reason;
  const both = (pair) => { const [en, ta] = pair.split(' / '); return { en, ta }; };
  if (code === 'sms_provider_not_configured') return both('Sign-in by a code to your phone is switched off: no SMS provider is connected to this shop yet. No code was sent. / குறியீடு மூலம் உள்நுழைவு நிறுத்தப்பட்டுள்ளது: SMS சேவை இன்னும் இணைக்கப்படவில்லை. குறியீடு அனுப்பப்படவில்லை.');
  if (code === 'customer_sign_in_not_switched_on' || code === 'sign_in_not_deployed') return both('Customer sign-in is not switched on for this shop yet. No code was sent. / வாடிக்கையாளர் உள்நுழைவு இன்னும் இயக்கப்படவில்லை. குறியீடு அனுப்பப்படவில்லை.');
  if (code === 'too_many_tries') return both('Too many tries for now. Please wait a few minutes, then ask for a new code. / இப்போது அதிக முயற்சிகள். சில நிமிடங்கள் காத்திருங்கள்.');
  return fallback;
}

$('send-code').addEventListener('click', async () => {
  const phoneNumber = $('phone').value.trim();
  if (phoneNumber === '') {
    setStatus({ en: 'Please enter your mobile number.', ta: 'உங்கள் கைபேசி எண்ணை உள்ளிடவும்.' }, 'warn');
    return;
  }
  setStatus({ en: 'Sending a code to your phone…', ta: 'உங்கள் தொலைபேசிக்குக் குறியீடு அனுப்பப்படுகிறது…' });
  let out = null;
  try { out = await post('/auth/otp/begin', { phoneNumber }); } catch { /* not reached */ }
  if (out && out.ok) {
    challengeId = out.challengeId;
    stepCode.hidden = false;
    $('code').focus();
    setStatus({ en: 'We sent a code to your phone. Enter it below.', ta: 'உங்கள் தொலைபேசிக்குக் குறியீடு அனுப்பினோம். கீழே உள்ளிடவும்.' }, 'good');
  } else {
    setStatus(refusalWords(out, { en: 'We could not send a code. Please check the number and try again.', ta: 'குறியீடு அனுப்ப முடியவில்லை. எண்ணைச் சரிபார்த்து மீண்டும் முயற்சிக்கவும்.' }), 'err');
  }
});

$('verify').addEventListener('click', async () => {
  const code = $('code').value.trim();
  let out = null;
  try { out = await post('/auth/otp/verify', { challengeId, code }); } catch { /* not reached */ }
  if (out && out.ok) {
    session = { token: out.token };
    stepPhone.hidden = true;
    stepCode.hidden = true;
    stepAccount.hidden = false;
    setStatus({ en: 'Signed in.', ta: 'உள்நுழைந்தீர்கள்.' }, 'good');
    setResult('');
  } else {
    setStatus(refusalWords(out, { en: 'That code was not accepted. Please try again.', ta: 'அந்தக் குறியீடு ஏற்கப்படவில்லை. மீண்டும் முயற்சிக்கவும்.' }), 'err');
  }
});

async function doAction(action) {
  if (session === null) {
    setResult({ en: 'Your session has ended — please sign in again.', ta: 'உங்கள் அமர்வு முடிந்தது — மீண்டும் உள்நுழையவும்.' });
    return;
  }
  // The service answers from the session it holds (the cookie goes with the call) — not from anything this page says.
  const out = await post('/auth/otp/check', { action });
  switch (out && out.outcome) {
    case 'allowed':
      setResult(action === 'view_orders' ? { en: 'Your orders are shown.', ta: 'உங்கள் ஆர்டர்கள் காட்டப்படுகின்றன.' } : { en: 'Done.', ta: 'முடிந்தது.' });
      break;
    case 'needs_second_factor':
      setResult({ en: 'Extra verification needed to change bank details — please confirm with your authenticator.', ta: 'வங்கி விவரங்களை மாற்றக் கூடுதல் சரிபார்ப்பு தேவை — உங்கள் அங்கீகார செயலியில் உறுதிப்படுத்தவும்.' });
      break;
    case 'needs_reauth':
      setResult({ en: 'Please sign in again to confirm this change.', ta: 'இந்த மாற்றத்தை உறுதிப்படுத்த மீண்டும் உள்நுழையவும்.' });
      break;
    default:
      setResult({ en: 'Your session has ended — please sign in again.', ta: 'உங்கள் அமர்வு முடிந்தது — மீண்டும் உள்நுழையவும்.' });
  }
}

$('view-orders').addEventListener('click', () => doAction('view_orders'));
$('change-bank').addEventListener('click', () => doAction('change_bank_details'));

$('sign-out').addEventListener('click', async () => {
  try { await post('/auth/otp/signout', {}); } catch { /* the token is forgotten below either way */ }
  // The token is discarded here, but the SERVER-side end of the session is what actually protects us:
  // the old session cookie, replayed, is refused by the service (proved by the E2E).
  session = null;
  setStatus({ en: 'Signed out.', ta: 'வெளியேறினீர்கள்.' }, 'good');
  setResult('');
});
