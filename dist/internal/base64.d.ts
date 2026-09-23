/**
 * Base64 and UTF-8 helpers.
 *
 * Written out rather than using `btoa`, `Buffer`, or `node:buffer`: the
 * Workers runtime has Web APIs only, and `atob`/`btoa` throw on non-Latin1
 * input, which every one of these call sites can carry.
 */
/**
 * `ArrayBuffer`-backed bytes.
 *
 * Spelled out because TypeScript 5.7 made the typed arrays generic over their
 * buffer, and `TextEncoder.encode()` returns `Uint8Array<ArrayBufferLike>`,
 * which WebCrypto's `BufferSource` parameters reject. Copying into a fresh
 * buffer narrows it to `Uint8Array<ArrayBuffer>` without a cast.
 */
export type Bytes = Uint8Array<ArrayBuffer>;
export declare function utf8Encode(value: string): Bytes;
export declare function utf8Decode(bytes: Uint8Array): string;
/** Standard base64 with `=` padding. */
export declare function encodeBase64(bytes: Uint8Array): string;
/** Base64url, unpadded. The encoding used for tokens and the Gmail `raw` field. */
export declare function encodeBase64Url(bytes: Uint8Array): string;
/** Throws on malformed input so callers can reject a token cleanly. */
export declare function decodeBase64Url(value: string): Bytes;
/** Wrap base64 into 76-character lines, as RFC 2045 requires for MIME bodies. */
export declare function wrapBase64(value: string, width?: number): string;
//# sourceMappingURL=base64.d.ts.map