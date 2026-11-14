// CR-01 step 4a · ADR-0033 · OB-732 "B": add ONE setting to a settings file that already exists, keeping every byte before
// it exactly as it was. Used by `store-computer setup` and `till:install` to add the privilege-seal key once to a copy set
// up before the key existed. Pure: the caller writes the text, and never shows the value.

/** The text with `key=value` (and a comment line above it) appended at the end; a missing final line break is added first. */
export function withSettingAppended(text, key, value, comment) {
  const body = String(text);
  const nl = body.includes('\r\n') ? '\r\n' : '\n';
  const sep = body === '' || body.endsWith('\n') ? '' : nl;
  return `${body}${sep}${comment === undefined ? '' : `# ${comment}${nl}`}${key}=${value}${nl}`;
}
