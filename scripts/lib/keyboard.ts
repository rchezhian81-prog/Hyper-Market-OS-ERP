// One answer typed at THIS keyboard (OB-257): the owner setup commands and the two migration owner steps ask for a YES and
// for each person's own till PIN here. `hidden`: nothing typed is shown (a PIN), and it is never kept, logged or echoed.
// Undefined when there is no keyboard (the command was not typed in a window) or on Ctrl+C.

export function askAtKeyboard(prompt: string, hidden: boolean): Promise<string | undefined> {
  const input = process.stdin;
  if (!input.isTTY || typeof input.setRawMode !== 'function') return Promise.resolve(undefined);
  return new Promise((done) => {
    process.stdout.write(prompt);
    let typed = '';
    const finish = (value: string | undefined): void => {
      input.setRawMode(false);
      input.pause();
      input.removeListener('data', onData);
      process.stdout.write('\n');
      done(value);
    };
    const onData = (chunk: Buffer | string): void => {
      for (const ch of String(chunk)) {
        if (ch === '\r' || ch === '\n') { finish(typed); return; }
        if (ch === '\u0003') { finish(undefined); return; }
        if (ch === '\u0008' || ch === '\u007f') { if (typed.length > 0) { typed = typed.slice(0, -1); if (!hidden) process.stdout.write('\b \b'); } continue; }
        if (ch >= ' ') { typed += ch; if (!hidden) process.stdout.write(ch); }
      }
    };
    input.setRawMode(true);
    input.resume();
    input.setEncoding('utf8');
    input.on('data', onData);
  });
}
