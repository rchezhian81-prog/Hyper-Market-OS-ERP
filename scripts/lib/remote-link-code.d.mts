// Types for scripts/lib/remote-link-code.mjs (OB-840 · ADR-0035): the link code and the pairing code.
export declare function publicKeyCore(line: string | undefined): string | undefined;
export declare function signingKeyCores(jwks: unknown): string[];
export declare function linkCode(hostKeyLines: readonly string[] | undefined, jwks: unknown): string | undefined;
export declare function pairingCode(publicKeyLine: string | undefined): string | undefined;
export declare function sameCode(a: unknown, b: unknown): boolean;
