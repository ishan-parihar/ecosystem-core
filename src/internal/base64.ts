/**
 * Base64 and UTF-8 helpers.
 *
 * Written out rather than using `btoa`, `Buffer`, or `node:buffer`: the
 * Workers runtime has Web APIs only, and `atob`/`btoa` throw on non-Latin1
 * input, which every one of these call sites can carry.
 */

const B64_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
const B64_LOOKUP: Record<string, number> = (() => {
	const table: Record<string, number> = {};
	for (let i = 0; i < B64_ALPHABET.length; i += 1) table[B64_ALPHABET.charAt(i)] = i;
	return table;
})();

/**
 * `ArrayBuffer`-backed bytes.
 *
 * Spelled out because TypeScript 5.7 made the typed arrays generic over their
 * buffer, and `TextEncoder.encode()` returns `Uint8Array<ArrayBufferLike>`,
 * which WebCrypto's `BufferSource` parameters reject. Copying into a fresh
 * buffer narrows it to `Uint8Array<ArrayBuffer>` without a cast.
 */
export type Bytes = Uint8Array<ArrayBuffer>;

export function utf8Encode(value: string): Bytes {
	const encoded = new TextEncoder().encode(value);
	const copy = new Uint8Array(encoded.byteLength);
	copy.set(encoded);
	return copy;
}

export function utf8Decode(bytes: Uint8Array): string {
	return new TextDecoder().decode(bytes);
}

/** Standard base64 with `=` padding. */
export function encodeBase64(bytes: Uint8Array): string {
	let out = '';
	for (let i = 0; i < bytes.length; i += 3) {
		const b0 = bytes[i] ?? 0;
		const b1 = bytes[i + 1];
		const b2 = bytes[i + 2];
		out += B64_ALPHABET.charAt(b0 >> 2);
		out += B64_ALPHABET.charAt(((b0 & 0x03) << 4) | ((b1 ?? 0) >> 4));
		out += b1 === undefined ? '=' : B64_ALPHABET.charAt(((b1 & 0x0f) << 2) | ((b2 ?? 0) >> 6));
		out += b2 === undefined ? '=' : B64_ALPHABET.charAt(b2 & 0x3f);
	}
	return out;
}

/** Base64url, unpadded. The encoding used for tokens and the Gmail `raw` field. */
export function encodeBase64Url(bytes: Uint8Array): string {
	return encodeBase64(bytes).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

/** Throws on malformed input so callers can reject a token cleanly. */
export function decodeBase64Url(value: string): Bytes {
	if (!/^[A-Za-z0-9_-]*$/.test(value)) throw new Error('invalid base64url characters');
	const normalized = value.replace(/-/g, '+').replace(/_/g, '/');
	const padding = normalized.length % 4 === 0 ? '' : '='.repeat(4 - (normalized.length % 4));
	const input = normalized + padding;

	const out = new Uint8Array(Math.floor((input.length * 3) / 4));
	let outIndex = 0;
	for (let i = 0; i < input.length; i += 4) {
		const c0 = B64_LOOKUP[input.charAt(i)];
		const c1 = B64_LOOKUP[input.charAt(i + 1)];
		const c2 = B64_LOOKUP[input.charAt(i + 2)];
		const c3 = B64_LOOKUP[input.charAt(i + 3)];
		if (c0 === undefined || c1 === undefined) throw new Error('invalid base64url input');
		out[outIndex++] = (c0 << 2) | (c1 >> 4);
		if (c2 !== undefined) out[outIndex++] = ((c1 & 0x0f) << 4) | (c2 >> 2);
		if (c2 !== undefined && c3 !== undefined) out[outIndex++] = ((c2 & 0x03) << 6) | c3;
	}
	return out.subarray(0, outIndex);
}

/** Wrap base64 into 76-character lines, as RFC 2045 requires for MIME bodies. */
export function wrapBase64(value: string, width = 76): string {
	const lines: string[] = [];
	for (let i = 0; i < value.length; i += width) lines.push(value.slice(i, i + width));
	return lines.join('\r\n');
}
