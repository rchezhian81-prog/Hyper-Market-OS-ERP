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

const setStatus = (text, kind = '') => {
  statusEl.textContent = text;
  statusEl.className = `status ${kind}`.trim();
};
const setResult = (text) => {
  resultEl.textContent = text;
};

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
  if (code === 'sms_provider_not_configured') return 'Sign-in by a code to your phone is switched off: no SMS provider is connected to this shop yet. No code was sent. / குறியீடு மூலம் உள்நுழைவு நிறுத்தப்பட்டுள்ளது: SMS சேவை இன்னும் இணைக்கப்படவில்லை. குறியீடு அனுப்பப்படவில்லை.';
  if (code === 'customer_sign_in_not_switched_on' || code === 'sign_in_not_deployed') return 'Customer sign-in is not switched on for this shop yet. No code was sent. / வாடிக்கையாளர் உள்நுழைவு இன்னும் இயக்கப்படவில்லை. குறியீடு அனுப்பப்படவில்லை.';
  if (code === 'too_many_tries') return 'Too many tries for now. Please wait a few minutes, then ask for a new code. / இப்போது அதிக முயற்சிகள். சில நிமிடங்கள் காத்திருங்கள்.';
  return fallback;
}

$('send-code').addEventListener('click', async () => {
  const phoneNumber = $('phone').value.trim();
  if (phoneNumber === '') {
    setStatus('Please enter your mobile number.', 'warn');
    return;
  }
  setStatus('Sending a code to your phone…');
  let out = null;
  try { out = await post('/auth/otp/begin', { phoneNumber }); } catch { /* not reached */ }
  if (out && out.ok) {
    challengeId = out.challengeId;
    stepCode.hidden = false;
    $('code').focus();
    setStatus('We sent a code to your phone. Enter it below.', 'good');
  } else {
    setStatus(refusalWords(out, 'We could not send a code. Please check the number and try again.'), 'err');
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
    setStatus('Signed in.', 'good');
    setResult('');
  } else {
    setStatus(refusalWords(out, 'That code was not accepted. Please try again.'), 'err');
  }
});

async function doAction(action) {
  if (session === null) {
    setResult('Your session has ended — please sign in again.');
    return;
  }
  // The service answers from the session it holds (the cookie goes with the call) — not from anything this page says.
  const out = await post('/auth/otp/check', { action });
  switch (out && out.outcome) {
    case 'allowed':
      setResult(action === 'view_orders' ? 'Your orders are shown.' : 'Done.');
      break;
    case 'needs_second_factor':
      setResult('Extra verification needed to change bank details — please confirm with your authenticator.');
      break;
    case 'needs_reauth':
      setResult('Please sign in again to confirm this change.');
      break;
    default:
      setResult('Your session has ended — please sign in again.');
  }
}

$('view-orders').addEventListener('click', () => doAction('view_orders'));
$('change-bank').addEventListener('click', () => doAction('change_bank_details'));

$('sign-out').addEventListener('click', async () => {
  try { await post('/auth/otp/signout', {}); } catch { /* the token is forgotten below either way */ }
  // The token is discarded here, but the SERVER-side end of the session is what actually protects us:
  // the old session cookie, replayed, is refused by the service (proved by the E2E).
  session = null;
  setStatus('Signed out.', 'good');
  setResult('');
});
