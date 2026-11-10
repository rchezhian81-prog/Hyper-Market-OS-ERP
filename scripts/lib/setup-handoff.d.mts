interface HandoffFs {
  writeFileSync(file: string, data: string, enc: 'utf8'): void;
  existsSync(file: string): boolean;
  unlinkSync(file: string): void;
  appendFileSync(file: string, data: string, enc: 'utf8'): void;
}
export declare function shortcutText(url: string): string;
export declare function urlInShortcut(text: string): string | undefined;
export declare function screensUrl(port: number, key: string): string;
export declare function writeHandoff(fs: HandoffFs, file: string, url: string): boolean;
export declare function removeHandoff(fs: HandoffFs, file: string): void;
export declare function loggedSay(fs: HandoffFs, logFile: string | undefined, say: (line: string) => void, now?: () => Date): (line: string) => void;
export declare function argValue(argv: readonly string[], flag: string): string | undefined;
