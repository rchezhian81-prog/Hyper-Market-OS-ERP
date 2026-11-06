/** Every row of the first sheet of an .xlsx, as arrays of cell text. */
export declare function readXlsxGrid(buf: Uint8Array): string[][];
/** The rows under the first row holding `mustHave`, as header → cell text. */
export declare function readXlsxTable(buf: Uint8Array, mustHave: string): Record<string, string>[];
