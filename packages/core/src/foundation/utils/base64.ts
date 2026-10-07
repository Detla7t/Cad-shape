// Part of the Chili3d Project, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

/**
 * Standard base64 (RFC 4648, with padding) for binary payloads kept in serialized
 * documents — table-driven, so tens of megabytes encode without building a binary string
 * for `btoa` and the same code runs in browsers, workers and Node.
 */

const ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
const CODES = new Uint8Array(128).fill(255);
for (let i = 0; i < ALPHABET.length; i++) CODES[ALPHABET.charCodeAt(i)] = i;

export function bytesToBase64(bytes: Uint8Array): string {
    const parts: string[] = [];
    const CHUNK = 3 * 16384;
    for (let start = 0; start < bytes.length; start += CHUNK) {
        const end = Math.min(bytes.length, start + CHUNK);
        let chunk = "";
        let i = start;
        for (; i + 2 < end; i += 3) {
            const n = (bytes[i] << 16) | (bytes[i + 1] << 8) | bytes[i + 2];
            chunk +=
                ALPHABET[n >> 18] + ALPHABET[(n >> 12) & 63] + ALPHABET[(n >> 6) & 63] + ALPHABET[n & 63];
        }
        if (i < end) {
            const n = (bytes[i] << 16) | ((i + 1 < end ? bytes[i + 1] : 0) << 8);
            chunk += ALPHABET[n >> 18] + ALPHABET[(n >> 12) & 63];
            chunk += i + 1 < end ? `${ALPHABET[(n >> 6) & 63]}=` : "==";
        }
        parts.push(chunk);
    }
    return parts.join("");
}

/** The bytes of `text`, or undefined when it is not base64 (whitespace is ignored). */
export function base64ToBytes(text: string): Uint8Array | undefined {
    const clean = /\s/.test(text) ? text.replace(/\s+/g, "") : text;
    if (clean.length % 4 !== 0) return undefined;
    const padding = clean.endsWith("==") ? 2 : clean.endsWith("=") ? 1 : 0;
    const bytes = new Uint8Array((clean.length / 4) * 3 - padding);
    let at = 0;
    for (let i = 0; i < clean.length; i += 4) {
        let n = 0;
        for (let k = 0; k < 4; k++) {
            const char = clean.charCodeAt(i + k);
            const isPad = char === 61 && i + k >= clean.length - padding;
            const code = isPad ? 0 : char < 128 ? CODES[char] : 255;
            if (code === 255) return undefined;
            n = (n << 6) | code;
        }
        bytes[at++] = n >> 16;
        if (at < bytes.length) bytes[at++] = (n >> 8) & 255;
        if (at < bytes.length) bytes[at++] = n & 255;
    }
    return bytes;
}
