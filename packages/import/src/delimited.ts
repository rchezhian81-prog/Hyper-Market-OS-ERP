// Delimited-file parsing (M30-FR-01) — the front door for bulk data, and the store's
// #1 daily pain (audit A-03: an 80+ line supplier invoice typed by hand).
//
// A naive `split(',')` corrupts real supplier files silently: product names contain
// commas, addresses contain quotes, and exported cells contain line breaks. Silent
// corruption is the worst possible failure for an import, so this is a proper RFC
// 4180 parser — quoted fields, escaped quotes (`""`), embedded commas and newlines,
// CRLF or LF — and it REPORTS a malformed file rather than guessing.
//
// Pure and synchronous: text in, rows out.

export interface ParseOptions {
  /** Field separator — comma for CSV, tab for the TSV many ERPs export. */
  readonly delimiter?: string;
  /** Treat the first row as the header (default true). */
  readonly header?: boolean;
}

export interface ParsedFile {
  readonly headers: readonly string[];
  /** Each row keyed by header, in file order. */
  readonly rows: readonly Readonly<Record<string, string>>[];
  /** 1-based line number in the source file for each row (for error reporting). */
  readonly lineNumbers: readonly number[];
}

export class MalformedFileError extends Error {
  constructor(line: number, detail: string) {
    super(`Line ${line}: ${detail}.`);
    this.name = 'MalformedFileError';
  }
}

export class MissingHeaderError extends Error {
  constructor() {
    super('The file has no header row.');
    this.name = 'MissingHeaderError';
  }
}

/** Split the text into records of raw cells, tracking each record's start line. */
function tokenise(text: string, delimiter: string): { cells: string[]; line: number }[] {
  const records: { cells: string[]; line: number }[] = [];
  let cells: string[] = [];
  let field = '';
  let inQuotes = false;
  let line = 1;
  let recordLine = 1;
  let sawAnyChar = false;

  const endField = (): void => {
    cells.push(field);
    field = '';
  };
  const endRecord = (): void => {
    endField();
    // Ignore a trailing blank line (a single empty cell and nothing else).
    if (!(cells.length === 1 && cells[0] === '')) {
      records.push({ cells, line: recordLine });
    }
    cells = [];
    recordLine = line + 1;
  };

  for (let i = 0; i < text.length; i += 1) {
    const char = text[i]!;
    sawAnyChar = true;

    if (inQuotes) {
      if (char === '"') {
        if (text[i + 1] === '"') {
          field += '"'; // an escaped quote inside a quoted field
          i += 1;
        } else {
          inQuotes = false;
        }
      } else {
        if (char === '\n') line += 1; // a newline INSIDE a quoted field
        field += char;
      }
      continue;
    }

    if (char === '"' && field === '') {
      inQuotes = true;
    } else if (char === delimiter) {
      endField();
    } else if (char === '\r') {
      // handled by the following \n
    } else if (char === '\n') {
      endRecord();
      line += 1;
    } else {
      field += char;
    }
  }

  if (inQuotes) {
    throw new MalformedFileError(recordLine, 'a quoted value is never closed');
  }
  if (sawAnyChar && (field !== '' || cells.length > 0)) {
    endRecord();
  }
  return records;
}

/**
 * Parse a delimited file into header-keyed rows. Reports a row whose column count
 * does not match the header rather than silently dropping or shifting cells.
 */
export function parseDelimited(text: string, options: ParseOptions = {}): ParsedFile {
  const delimiter = options.delimiter ?? ',';
  const records = tokenise(text.replace(/^\uFEFF/, ''), delimiter); // strip a BOM

  if (records.length === 0) {
    throw new MissingHeaderError();
  }
  const headerRecord = records[0]!;
  const headers = headerRecord.cells.map((h) => h.trim());

  const rows: Record<string, string>[] = [];
  const lineNumbers: number[] = [];

  for (const record of records.slice(1)) {
    if (record.cells.length !== headers.length) {
      throw new MalformedFileError(
        record.line,
        `expected ${headers.length} column(s), found ${record.cells.length}`,
      );
    }
    const row: Record<string, string> = {};
    headers.forEach((headerName, index) => {
      row[headerName] = (record.cells[index] ?? '').trim();
    });
    rows.push(row);
    lineNumbers.push(record.line);
  }

  return { headers, rows, lineNumbers };
}
