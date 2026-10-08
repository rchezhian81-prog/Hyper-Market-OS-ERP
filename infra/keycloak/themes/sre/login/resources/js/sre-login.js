/* global document, window */
// The OB-18 sign-in behaviour on the identity server's pages: show/hide password, the Caps Lock hint, the design's
// own required-field messages, the pending-submit guard, and the help and connection dialogs. The behaviour is the
// pilot page's (LOGIN_JS in infra/pilot/demo-login/ui.ts). The one difference is language. There it is switched in
// the browser. Here Keycloak renders the page in the chosen language (the English / தமிழ் links carry kc_locale), so
// every word this script shows comes from the server-rendered page (data-* attributes), and nothing is kept in
// localStorage.
//
// Loaded as a module from this theme's own resources, so the page carries no inline script. It also starts
// Keycloak's own "signed in from another tab" check (base theme authChecker.js), which the base template used to
// start inline.

import { startSessionPolling } from './authChecker.js';

const root = document.getElementById('sre-login');
if (root !== null) {
  const $ = (selector) => root.querySelector(selector);

  // ── show / hide password (the design's text button) ────────────────────────────────────────────────────────
  const password = document.getElementById('password');
  const reveal = document.getElementById('sl-reveal');
  if (reveal !== null && password !== null) {
    const render = () => {
      const shown = password.type === 'text';
      reveal.textContent = shown ? reveal.dataset.textHide : reveal.dataset.textShow;
      reveal.setAttribute('aria-label', shown ? reveal.dataset.labelHide : reveal.dataset.labelShow);
      reveal.setAttribute('aria-pressed', String(shown));
    };
    reveal.hidden = false;
    reveal.addEventListener('click', () => {
      password.type = password.type === 'password' ? 'text' : 'password';
      render();
      password.focus();
    });
    render();
  }

  // ── Caps Lock hint ─────────────────────────────────────────────────────────────────────────────────────────
  const caps = document.getElementById('sl-caps');
  if (password !== null && caps !== null) {
    const onCaps = (e) => { if (e.getModifierState) caps.hidden = !e.getModifierState('CapsLock'); };
    password.addEventListener('keydown', onCaps);
    password.addEventListener('keyup', onCaps);
    password.addEventListener('blur', () => { caps.hidden = true; });
  }

  // ── the sign-in form: the design's required-field messages ─────────────────────────────────────────────────
  const login = document.getElementById('kc-form-login');
  const user = document.getElementById('username');
  const message = document.getElementById('sl-form-message');
  const show = (text) => {
    if (message === null) return;
    message.hidden = text === '';
    message.textContent = text;
    message.dataset.tone = 'red';
    message.setAttribute('role', 'alert');
  };
  if (login !== null) {
    login.noValidate = true; // with the script, the design's messages replace the browser's; without it, `required` still holds
    login.addEventListener('submit', (e) => {
      [user, password].forEach((el) => { if (el !== null) el.removeAttribute('aria-invalid'); });
      if (user !== null && user.value.trim() === '') {
        e.preventDefault(); e.stopImmediatePropagation();
        user.setAttribute('aria-invalid', 'true'); show(login.dataset.requiredId ?? ''); user.focus();
        return;
      }
      if (password !== null && password.value === '') {
        e.preventDefault(); e.stopImmediatePropagation();
        password.setAttribute('aria-invalid', 'true'); show(login.dataset.requiredPassword ?? ''); password.focus();
      }
    });
    [user, password].forEach((el) => {
      if (el === null) return;
      el.addEventListener('input', () => { el.removeAttribute('aria-invalid'); });
    });
  }

  // ── the pending-submit guard, for every form on the page ───────────────────────────────────────────────────
  root.querySelectorAll('form').forEach((form) => {
    form.addEventListener('submit', (e) => {
      if (e.defaultPrevented) return;
      if (form.dataset.busy === 'true') { e.preventDefault(); return; }
      form.dataset.busy = 'true';
      const button = form.querySelector('.sl-submit');
      const label = button === null ? null : button.querySelector('span');
      const before = label === null ? '' : label.textContent;
      if (button !== null) button.setAttribute('aria-busy', 'true');
      if (label !== null && form.dataset.signingIn) label.textContent = form.dataset.signingIn;
      window.setTimeout(() => {
        form.dataset.busy = 'false';
        if (button !== null) button.removeAttribute('aria-busy');
        if (label !== null) label.textContent = before;
      }, 15000);
    });
  });

  // ── the help and connection dialogs ────────────────────────────────────────────────────────────────────────
  const host = document.getElementById('sl-dialog-host');
  if (host !== null) {
    const title = document.getElementById('sl-dialog-title');
    const copy = document.getElementById('sl-dialog-copy');
    const first = document.getElementById('sl-dialog-close');
    const last = document.getElementById('sl-dialog-done');
    let opener = null;
    const setInert = (on) => { ['.sl-topbar', '.sl-main', '.sl-footer'].forEach((s) => { const el = $(s); if (el !== null) el.inert = on; }); };
    const close = () => { host.hidden = true; setInert(false); if (opener !== null) opener.focus(); };
    root.querySelectorAll('[data-open]').forEach((button) => {
      button.addEventListener('click', () => {
        const kind = button.getAttribute('data-open') === 'help' ? 'help' : 'connection';
        opener = button;
        title.textContent = host.dataset[`${kind}Title`] ?? '';
        copy.textContent = host.dataset[`${kind}Copy`] ?? '';
        host.hidden = false;
        setInert(true);
        first.focus({ preventScroll: true });
      });
    });
    first.addEventListener('click', close);
    last.addEventListener('click', close);
    host.addEventListener('click', (e) => { if (e.target === host) close(); });
    host.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') { e.preventDefault(); close(); }
      if (e.key === 'Tab') {
        if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
        else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
      }
    });
  }

  // Back from the browser's cache: the form is usable again.
  window.addEventListener('pageshow', (e) => {
    if (!e.persisted) return;
    root.querySelectorAll('form').forEach((form) => { form.dataset.busy = 'false'; });
    root.querySelectorAll('.sl-submit[aria-busy]').forEach((b) => { b.removeAttribute('aria-busy'); });
  });
}

const sso = document.body === null ? undefined : document.body.dataset.sreSsoUrl;
if (sso) startSessionPolling(sso);
