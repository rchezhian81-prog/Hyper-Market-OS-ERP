// CR-01 step 4a (OI-06 · ADR-0033 · OB-731 "A"): the small "type your PIN again" box the Users & roles page opens on the store
// PC before each privilege act — asking for a role, approving one. A password field (never shown as typed), Confirm and
// Cancel, in English and Tamil. The PIN is handed back to the one request that needs it and kept nowhere: the box is
// removed from the page as soon as it is answered.

/** The few DOM pieces this uses — so a test can hand in a small stand-in for the page. */
export interface PinDoc {
  createElement(tag: string): PinEl;
  readonly body: { appendChild(el: PinEl): unknown; removeChild(el: PinEl): unknown };
}
export interface PinEl {
  setAttribute(name: string, value: string): void;
  appendChild(el: PinEl): unknown;
  addEventListener(type: string, fn: (e: { preventDefault(): void }) => void): void;
  textContent: string | null;
  value?: string;
  focus?(): void;
}

/** Ask for the PIN; resolves with what was typed, or null when the person cancels. */
export function askOfficePin(doc: PinDoc, words: { readonly ask: string; readonly askTa: string; readonly ok: string; readonly cancel: string }): Promise<string | null> {
  return new Promise((resolve) => {
    const form = doc.createElement('form');
    form.setAttribute('id', 'office-pin-confirm');
    form.setAttribute('role', 'dialog');
    form.setAttribute('aria-modal', 'true');
    form.setAttribute('style', 'position:fixed;inset:30% auto auto 50%;transform:translateX(-50%);z-index:2147483001;background:#fff;color:#14202b;border:2px solid #14202b;border-radius:8px;padding:16px;font:16px system-ui,sans-serif;max-width:24rem');
    const label = doc.createElement('label');
    label.setAttribute('for', 'office-pin-again');
    label.textContent = `${words.ask} · ${words.askTa}`;
    const input = doc.createElement('input');
    for (const [k, v] of [['id', 'office-pin-again'], ['type', 'password'], ['inputmode', 'numeric'], ['autocomplete', 'off'], ['maxlength', '6'], ['pattern', '[0-9]{6}'], ['required', '']]) input.setAttribute(k!, v!);
    input.setAttribute('style', 'display:block;width:100%;min-height:48px;font-size:1.25rem;margin:8px 0');
    const ok = doc.createElement('button');
    ok.setAttribute('type', 'submit');
    ok.setAttribute('style', 'min-height:44px;min-width:44px;margin-right:8px');
    ok.textContent = words.ok;
    const cancel = doc.createElement('button');
    cancel.setAttribute('type', 'button');
    cancel.setAttribute('style', 'min-height:44px;min-width:44px');
    cancel.textContent = words.cancel;
    for (const el of [label, input, ok, cancel]) form.appendChild(el);
    let done = false;
    const finish = (pin: string | null): void => {
      if (done) return;
      done = true;
      input.value = '';
      doc.body.removeChild(form);
      resolve(pin);
    };
    form.addEventListener('submit', (e) => { e.preventDefault(); const pin = (input.value ?? '').trim(); finish(pin === '' ? null : pin); });
    cancel.addEventListener('click', (e) => { e.preventDefault(); finish(null); });
    doc.body.appendChild(form);
    input.focus?.();
  });
}
