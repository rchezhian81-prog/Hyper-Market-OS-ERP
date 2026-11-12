// The first-run screens' HAND-OFF to the person at the PC — CR-01 step 2b, fixed after the owner's first real install.
//
// What happened on the store PC (2026-11-09): SRE-Setup.exe runs as administrator, so the screens' server it starts does
// too; that server asked Windows to open the browser itself, hidden and as administrator, and no browser appeared. The
// one-time key was only in that lost address, the server's own words were kept nowhere, and the server (node.exe) stayed
// running, so running SRE-Setup.exe again was refused ("DeleteFile failed; code 5").
//
// Now the server never opens a browser when it is started by the setup program. It writes the address, key and all, into
// one Internet shortcut — "Finish SRE setup" on the person's own desktop, which only that person and administrators can
// read — and SRE-Setup.exe opens that address AS THE PERSON who started it (infra/windows/sre-setup.iss). If the
// browser still does not come up, the person double-clicks the shortcut. The shortcut is removed when the server stops.
// Every line the server says is also kept in the setup log.

/** An Internet shortcut (.url) that opens `url`. */
export function shortcutText(url) {
  return `[InternetShortcut]\r\nURL=${url}\r\n`;
}

/** The address a shortcut written by shortcutText opens, or undefined. */
export function urlInShortcut(text) {
  const m = /^URL=(.+)$/m.exec(String(text));
  return m === null ? undefined : m[1].trim();
}

/** The screens' address for this port and key (the key after #, so it is never sent to any server in a request line). */
export function screensUrl(port, key) {
  return `http://127.0.0.1:${port}/setup/#key=${key}`;
}

/** Write the shortcut (replacing an old one). False when it could not be written; the caller says so. */
export function writeHandoff(fs, file, url) {
  try { fs.writeFileSync(file, shortcutText(url), 'utf8'); return true; } catch { return false; }
}

/** Remove the shortcut, once the server stops: its key no longer opens anything. */
export function removeHandoff(fs, file) {
  try { if (fs.existsSync(file)) fs.unlinkSync(file); } catch { /* nothing more to do */ }
}

/** A `say` that also keeps each line in `logFile` (best effort, as the setup tool's own log is). Never given a key. */
export function loggedSay(fs, logFile, say, now = () => new Date()) {
  return (line) => {
    say(line);
    if (logFile === undefined || logFile === '') return;
    try { fs.appendFileSync(logFile, `${now().toISOString()}  [screens] ${line}\n`, 'utf8'); } catch { /* the console still has it */ }
  };
}

/** The value after `flag` in argv, or undefined. */
export function argValue(argv, flag) {
  const i = argv.indexOf(flag);
  return i < 0 || i + 1 >= argv.length ? undefined : argv[i + 1];
}
