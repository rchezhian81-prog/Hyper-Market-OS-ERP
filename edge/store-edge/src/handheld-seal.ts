// The "Handheld seal" panel on the store computer's own screen (OB-424 · ADR-0030 · OB-422 · P-04 · P-07 · P-08 ·
// hard rules #4/#10).
//
// OB-422 locked the handheld door: it speaks https only, under the store computer's own signing authority. A new handheld
// must trust that authority (the "seal") once before it can open the door — and it cannot fetch the seal through the door,
// because it does not trust the door yet. The owner chose (OB-424, 27 Oct 2026) that the seal reaches a new handheld from
// the store PC's OWN SCREEN: this panel, served by the screens server on the PC's loopback only. Nothing about it is on
// the shop network: no new listener, and the handheld door does not serve it.
//
// The panel shows three things, all PUBLIC — never a private key:
//   (a) the authority's certificate as a download, `authority.crt`, in DER (the form Android's "Install a certificate →
//       CA certificate" takes, as do iOS and Windows) — for the cable / file-share copy, the fallback that stays;
//   (b) a QR code that CARRIES THE CERTIFICATE ITSELF (its PEM text). A phone that does not yet trust the door cannot
//       fetch anything from this PC (the screens are loopback-only; the door is the thing it cannot trust yet), so a QR
//       of an address would point nowhere it can reach. A QR of the certificate needs no network at all: the screen IS
//       the channel, and what the phone reads is exactly what this box's door presents (ADR-0030, decision OB-424);
//   (c) the short fingerprint code — the start and the end of the SHA-256 fingerprint Android shows in the installed
//       certificate's details — which staff compare BY EYE on the handheld before they rely on it.
//
// When there is no seal to show — no handheld door on this box, a lock that could not be made or read, a certificate that
// does not agree with itself — the panel says so in plain words, English and Tamil, and shows no QR, no code and no
// download. It never makes a seal up (P-08, hard rule #10).

import { X509Certificate } from 'node:crypto';
import { encodeQr, qrSvg, type QrSymbol } from '../../../packages/receipt/src/qr-code';

/** Where the panel and its download live — on the screens server (the PC's loopback) ONLY. */
export const HANDHELD_SEAL_PATHS = Object.freeze({
  page: '/handheld-seal/',
  certificate: '/handheld-seal/authority.crt',
});

/** The download's media type: what Android's browser hands to its certificate installer. */
export const SEAL_CERTIFICATE_TYPE = 'application/x-x509-ca-cert';

/** What the store computer knows about its seal right now — from the RUNNING door, never from a guess. */
export type HandheldSealSource =
  | { readonly kind: 'door'; readonly authority: { readonly pem: string; readonly fingerprint: string; readonly notAfter: string } }
  /** `EDGE_DEVICE_PORT` is not set on this box: there is no handheld door, so there is no seal to hand over. */
  | { readonly kind: 'no_door' }
  /** The door was not opened; `problem` is the box's own words why (a lock that could not be made or read, a public host). */
  | { readonly kind: 'shut'; readonly problem: string }
  /** The box is still starting its door. */
  | { readonly kind: 'starting' };

export type HandheldSealNotReady = 'no_door' | 'door_shut' | 'starting' | 'seal_does_not_agree';

export type HandheldSealPanel =
  | {
    readonly ok: true;
    /** Full SHA-256 fingerprint of the certificate, colon hex — as Android shows it. */
    readonly fingerprint: string;
    /** The short code staff compare by eye: the first four and the last four pairs of the fingerprint. */
    readonly code: string;
    readonly notAfter: string;
    /** The certificate itself (DER) — the `authority.crt` download. Public. */
    readonly certificateDer: Buffer;
    /** The certificate itself (PEM) — what the QR carries. Public. */
    readonly certificatePem: string;
    readonly qr: { readonly carries: 'certificate_pem'; readonly version: number; readonly svg: string };
    readonly download: { readonly path: string; readonly fileName: 'authority.crt'; readonly type: string };
  }
  | { readonly ok: false; readonly reason: HandheldSealNotReady; readonly en: string; readonly ta: string; readonly detail?: string };

export const SEAL_NOT_READY_WORDS: Readonly<Record<HandheldSealNotReady, { readonly en: string; readonly ta: string }>> = Object.freeze({
  no_door: {
    en: 'This store computer has no handheld door, so there is no seal to give a handheld. Handhelds connect to the store computer whose door is set up (in-store install runbook, Step 6).',
    ta: 'இந்தக் கடை கணினியில் கைக்கருவி வாசல் இல்லை; ஆகவே கைக்கருவிக்குக் கொடுக்க முத்திரை இல்லை. வாசல் அமைக்கப்பட்ட கடை கணினியுடன் கைக்கருவிகள் இணையும்.',
  },
  door_shut: {
    en: 'The handheld door is shut, so no seal is shown. Do not set up a handheld now. The tills keep selling. Run the doctor (pnpm run store-computer -- doctor) and fix what it says.',
    ta: 'கைக்கருவி வாசல் மூடப்பட்டுள்ளது; ஆகவே முத்திரை காட்டப்படவில்லை. இப்போது கைக்கருவியை அமைக்க வேண்டாம். பில்லிங் தொடரும். doctor-ஐ இயக்கி அது சொல்வதைச் சரிசெய்யுங்கள்.',
  },
  starting: {
    en: 'The handheld door is still starting. Reload this page in a minute.',
    ta: 'கைக்கருவி வாசல் இன்னும் தொடங்கிக்கொண்டிருக்கிறது. ஒரு நிமிடத்தில் இந்தப் பக்கத்தை மீண்டும் திறக்கவும்.',
  },
  seal_does_not_agree: {
    en: 'The seal this store computer holds does not agree with itself, so it is not shown. Do not set up a handheld now. Run the doctor and raise this.',
    ta: 'இந்தக் கடை கணினியில் உள்ள முத்திரை தனக்குத் தானே பொருந்தவில்லை; ஆகவே காட்டப்படவில்லை. இப்போது கைக்கருவியை அமைக்க வேண்டாம். doctor-ஐ இயக்கி இதைத் தெரிவியுங்கள்.',
  },
});

const notReady = (reason: HandheldSealNotReady, detail?: string): HandheldSealPanel =>
  ({ ok: false, reason, ...SEAL_NOT_READY_WORDS[reason], ...(detail === undefined ? {} : { detail }) });

/** The short code staff compare by eye: `AB:12:CD:34 … 9F:00:11:22` — the start and end of what Android shows. */
export function sealCode(fingerprint: string): string {
  const pairs = fingerprint.split(':');
  return `${pairs.slice(0, 4).join(':')} … ${pairs.slice(-4).join(':')}`;
}

const ONE_CERTIFICATE = /^-----BEGIN CERTIFICATE-----\r?\n[A-Za-z0-9+/=\r\n]+-----END CERTIFICATE-----\r?\n?$/;

/**
 * The panel's data, from what the running door holds. Pure. The certificate is re-read here and checked: exactly one
 * certificate, nothing else in the text (never a key), an authority (CA), and its own SHA-256 the same as the door's
 * fingerprint. Anything else is refused by name — the panel never shows a seal it cannot vouch for.
 */
export function handheldSealPanel(source: HandheldSealSource): HandheldSealPanel {
  if (source.kind === 'no_door') return notReady('no_door');
  if (source.kind === 'starting') return notReady('starting');
  if (source.kind === 'shut') return notReady('door_shut', source.problem);
  const pem = source.authority.pem;
  if (!ONE_CERTIFICATE.test(pem) || /PRIVATE KEY/.test(pem)) return notReady('seal_does_not_agree');
  let cert: X509Certificate;
  try { cert = new X509Certificate(pem); } catch { return notReady('seal_does_not_agree'); }
  if (!cert.ca || cert.fingerprint256 !== source.authority.fingerprint) return notReady('seal_does_not_agree');
  const certificatePem = pem.endsWith('\n') ? pem : `${pem}\n`;
  // Level L: the symbol is read off a lit screen, not off worn paper, and a smaller symbol is easier for a phone to hold.
  const symbol: QrSymbol = encodeQr(certificatePem, { ecl: 'L' });
  return {
    ok: true,
    fingerprint: cert.fingerprint256,
    code: sealCode(cert.fingerprint256),
    notAfter: new Date(cert.validTo).toISOString(),
    certificateDer: Buffer.from(cert.raw),
    certificatePem,
    qr: { carries: 'certificate_pem', version: symbol.version, svg: qrSvg(symbol, { moduleSize: 3, title: 'Handheld seal — the store computer\'s authority certificate' }) },
    download: { path: HANDHELD_SEAL_PATHS.certificate, fileName: 'authority.crt', type: SEAL_CERTIFICATE_TYPE },
  };
}

const esc = (s: string): string => s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]!));

const STYLE = [
  'body{margin:0;background:#f6f7f4;color:#14202b;font:16px/1.5 system-ui,sans-serif}',
  'main{max-width:760px;margin:0 auto;padding:16px;display:grid;gap:16px}',
  'h1{margin:0;font-size:24px}h1 .ta,.ta{display:block;color:#3b4a57}h1 .ta{font-size:18px}',
  'section{background:#fff;border-radius:12px;padding:16px;display:grid;gap:12px;border-left:6px solid #2f7d4f}',
  'section.not-ready{border-left-color:#b3261e}',
  '.problem{color:#7a1410;font-weight:600}',
  '.code{font:700 28px/1.3 ui-monospace,monospace;letter-spacing:.04em;word-break:break-word}',
  '.fingerprint{font:14px/1.4 ui-monospace,monospace;word-break:break-all;color:#3b4a57}',
  'figure{margin:0;justify-self:start;background:#fff;padding:8px;border-radius:8px}figure svg{max-width:100%;height:auto}',
  'a.download{display:inline-flex;align-items:center;min-height:44px;padding:0 16px;border-radius:10px;background:#14202b;color:#fff;font-weight:600;text-decoration:none;justify-self:start}',
  'ol{margin:0;padding-left:22px;display:grid;gap:6px}',
].join('');

/** The page: the panel, in English and Tamil. Public material only. */
export function handheldSealPage(panel: HandheldSealPanel): string {
  const head = [
    '<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">',
    '<title>Handheld seal — store computer</title>', `<style>${STYLE}</style></head><body><main>`,
    '<h1 id="seal-heading"><span lang="en">Handheld seal</span><span lang="ta" class="ta">கைக்கருவி முத்திரை</span></h1>',
  ].join('');
  if (!panel.ok) {
    return [
      head,
      '<section class="not-ready" id="handheld-seal" data-seal="not-ready" data-reason="', esc(panel.reason), '">',
      '<div class="problem" role="alert" id="seal-problem">',
      `<p lang="en">${esc(panel.en)}</p><p lang="ta" class="ta">${esc(panel.ta)}</p>`,
      panel.detail === undefined ? '' : `<p lang="en" id="seal-problem-detail">${esc(panel.detail)}</p>`,
      '</div></section></main></body></html>',
    ].join('');
  }
  return [
    head,
    '<section id="handheld-seal" data-seal="ready">',
    '<p lang="en">A new handheld trusts this store computer once, at setup. Scan the QR code, or copy the file by cable. Then compare the code below with the one the handheld shows.</p>',
    '<p lang="ta" class="ta">புதிய கைக்கருவி அமைக்கும்போது ஒருமுறை இந்தக் கடை கணினியை நம்புகிறது. இந்தக் குறியீட்டைக் கைக்கருவியால் ஸ்கேன் செய்யுங்கள், அல்லது கோப்பைக் கேபிள் மூலம் நகலெடுங்கள். பிறகு கீழே உள்ள குறியீட்டைக் கைக்கருவி காட்டுவதுடன் ஒப்பிடுங்கள்.</p>',
    `<figure id="seal-qr" data-carries="${panel.qr.carries}" data-version="${panel.qr.version}">${panel.qr.svg}</figure>`,
    '<div><p lang="en">The code to compare on the handheld <span lang="ta" class="ta">கைக்கருவியில் ஒப்பிட வேண்டிய குறியீடு</span></p>',
    `<p class="code" id="seal-code">${esc(panel.code)}</p>`,
    `<p class="fingerprint" id="seal-fingerprint"><span lang="en">Full SHA-256 fingerprint:</span> ${esc(panel.fingerprint)}</p>`,
    `<p class="fingerprint" id="seal-until"><span lang="en">The seal lasts until</span> <span lang="ta">· முத்திரை செல்லுபடியாகும் நாள்</span> ${esc(panel.notAfter.slice(0, 10))}</p></div>`,
    `<a class="download" id="seal-download" href="${esc(panel.download.path)}" download="${panel.download.fileName}">Download authority.crt <span lang="ta">&nbsp;· பதிவிறக்கு</span></a>`,
    '<ol lang="en" id="seal-steps">',
    '<li>Get authority.crt onto the handheld: scan the QR code with a QR app that saves what it reads as a file named authority.crt (the code holds the whole certificate — no wifi is needed), or copy the downloaded file by cable.</li>',
    '<li>On the handheld: Settings → Security → Encryption &amp; credentials → Install a certificate → CA certificate, and choose authority.crt.</li>',
    '<li>Open the installed certificate on the handheld. Its SHA-256 fingerprint must START and END with the code above. If it does not, remove it and tell the manager.</li>',
    '<li>Only then enrol the handheld with its one-time code from head office.</li>',
    '</ol>',
    '<ol lang="ta" class="ta" id="seal-steps-ta">',
    '<li>authority.crt-ஐக் கைக்கருவிக்குக் கொண்டு செல்லுங்கள்: படித்ததை authority.crt என்ற கோப்பாகச் சேமிக்கும் QR செயலியால் QR குறியீட்டை ஸ்கேன் செய்யுங்கள் (குறியீட்டில் முழுச் சான்றிதழும் உள்ளது — wifi தேவையில்லை), அல்லது பதிவிறக்கிய கோப்பைக் கேபிள் மூலம் நகலெடுங்கள்.</li>',
    '<li>கைக்கருவியில்: Settings → Security → Encryption &amp; credentials → Install a certificate → CA certificate, பிறகு authority.crt-ஐத் தேர்ந்தெடுக்கவும்.</li>',
    '<li>நிறுவிய சான்றிதழைத் திறக்கவும். அதன் SHA-256 கைரேகை மேலே உள்ள குறியீட்டுடன் தொடங்கி முடிய வேண்டும். இல்லையெனில் அதை நீக்கி மேலாளரிடம் சொல்லுங்கள்.</li>',
    '<li>அதன் பிறகே தலைமை அலுவலகம் தந்த ஒருமுறைக் குறியீட்டுடன் கைக்கருவியைப் பதிவு செய்யுங்கள்.</li>',
    '</ol>',
    '</section></main></body></html>',
  ].join('');
}
