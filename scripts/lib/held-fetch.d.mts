export declare class HeldFetchTimeout extends Error {
  constructor(url: string, ms: number);
}
export declare function heldFetch(
  url: string | URL,
  init?: RequestInit,
  ms?: number,
  deps?: { fetch: typeof globalThis.fetch },
): Promise<Response>;
