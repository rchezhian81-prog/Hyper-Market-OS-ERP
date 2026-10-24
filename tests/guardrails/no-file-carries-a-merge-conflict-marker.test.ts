import { describe, it, expect } from 'vitest';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';

// Hard rule #9 (CLAUDE.md): nothing is done without tests that prove it. A merge that leaves
// `<<<<<<<` / `>>>>>>>` in a committed file is a half-finished merge. Inside a JavaScript file the
// browser refuses the whole script. On 24 Oct 2026 a till service worker
// (`apps/pos/web/sw.js`) was committed with one, and only the lint step caught it, minutes before
// a merge. This guard reads every tracked text file, not only the ones lint parses, so a marker
// in a JSON pack, a YAML job, a shell script or a document is refused too.

/** Kinds git tracks that are not text, so a marker inside them is meaningless. */
const BINARY = /\.(png|jpe?g|gif|webp|ico|pdf|docx|xlsx|pptx|zip|gz|woff2?|ttf|otf|wasm)$/i;

/** A conflict marker is seven of the same character at the start of a line, then a space and a label (or nothing). */
const MARKER = /^(<{7}|>{7})( |$)/;

function trackedTextFiles(): string[] {
  const out = execFileSync('git', ['ls-files', '-z'], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  return out.split('\0').filter((f) => f !== '' && !BINARY.test(f));
}

function markersIn(text: string): number[] {
  const lines: number[] = [];
  text.split('\n').forEach((line, i) => { if (MARKER.test(line)) lines.push(i + 1); });
  return lines;
}

describe('guardrail: no committed file carries a merge-conflict marker', () => {
  it('reads every tracked text file and finds no <<<<<<< or >>>>>>> line', () => {
    const files = trackedTextFiles();
    expect(files.length).toBeGreaterThan(1000); // the scan surface is real, so green is not an empty list
    const offences: string[] = [];
    for (const file of files) {
      let text: string;
      try { text = readFileSync(file, 'utf8'); } catch { continue; } // a file deleted in the working tree is not committed content
      for (const line of markersIn(text)) offences.push(`${file}:${line}`);
    }
    expect(offences, `merge-conflict markers left in:\n${offences.join('\n')}`).toEqual([]);
  });

  it('knows a marker when it sees one, and does not mistake a heading rule or an arrow for one', () => {
    expect(markersIn("a\n<<<<<<< HEAD\nb\n=======\nc\n>>>>>>> branch\n")).toEqual([2, 6]);
    expect(markersIn('=======\n<<<<<<<<\n->>>>>>> not at the start\n')).toEqual([]);
  });
});
