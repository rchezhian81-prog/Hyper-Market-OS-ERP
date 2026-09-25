// Customer / B2B portal sign-in — the THIN CLIENT (M02 / M20 / M22).
//
// It holds no password, no signing key and no token-minting code. It talks to the auth backend over
// four small endpoints and keeps only the short-lived session token, in memory, for the tab's life.
// In production that backend is the real IdP / cloud auth API; in the E2E it is a local Node server
// running the same production engines with the local/test IdP and OTP simulator.

const $ = (id) => document.getElementById(id);

const stepPhone = $('step-phone');
const stepCode = $('step-code');
const stepAccount = $('step-account');
const statusEl = $('status');
const resultEl = $('result');

// Held in memory only — never localStorage, never a cookie this script sets.
let challengeId = null;
let session = null; // { token, sessionId }

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

$('send-code').addEventListener('click', async () => {
  const phoneNumber = $('phone').value.trim();
  if (phoneNumber === '') {
    setStatus('Please enter your mobile number.', 'warn');
    return;
  }
  setStatus('Sending a code to your phone…');
  const out = await post('/auth/otp/begin', { phoneNumber });
  if (out && out.ok) {
    challengeId = out.challengeId;
    stepCode.hidden = false;
    $('code').focus();
    setStatus('We sent a code to your phone. Enter it below.', 'good');
  } else {
    setStatus('We could not send a code. Please check the number and try again.', 'err');
  }
});

$('verify').addEventListener('click', async () => {
  const code = $('code').value.trim();
  const out = await post('/auth/otp/verify', { challengeId, code });
  if (out && out.ok) {
    session = { token: out.token, sessionId: out.sessionId };
    stepPhone.hidden = true;
    stepCode.hidden = true;
    stepAccount.hidden = false;
    setStatus('Signed in.', 'good');
    setResult('');
  } else {
    setStatus('That code was not accepted. Please try again.', 'err');
  }
});

async function doAction(action) {
  if (session === null) {
    setResult('Your session has ended — please sign in again.');
    return;
  }
  const out = await post('/auth/action', { token: session.token, sessionId: session.sessionId, action });
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
  if (session !== null) {
    await post('/auth/signout', { sessionId: session.sessionId });
  }
  // The token is discarded here, but the SERVER-side revocation is what actually protects us: even
  // if this token were replayed, the backend refuses a revoked session (proved by the E2E).
  session = null;
  setStatus('Signed out.', 'good');
  setResult('');
});
