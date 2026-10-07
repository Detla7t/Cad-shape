// Part of the Chili3d Project, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

/**
 * Synchronous SHA-256 (FIPS 180-4) and canonical JSON — the two primitives content addressing
 * rests on. `crypto.subtle.digest` is async, and every object the version store writes is hashed
 * on the capture path, inside the same tick as the edit; so the digest is computed here.
 *
 * Determinism is the whole point: the same JSON value hashes to the same id on every run and
 * every machine, which is what lets two branches share an unchanged feature, and two saves of
 * the same document dedupe their objects.
 */

const K = new Uint32Array([
    0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
    0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
    0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
    0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
    0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
    0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
    0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
    0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
]);

const encoder = new TextEncoder();

/** SHA-256 digest of `bytes`. */
export function sha256(bytes: Uint8Array): Uint8Array {
    const bitLength = bytes.length * 8;
    // Message + 0x80 + zero padding + 64-bit length, rounded up to whole 64-byte blocks.
    const blockCount = Math.ceil((bytes.length + 9) / 64);
    const padded = new Uint8Array(blockCount * 64);
    padded.set(bytes);
    padded[bytes.length] = 0x80;
    const view = new DataView(padded.buffer);
    view.setUint32(padded.length - 8, Math.floor(bitLength / 0x100000000));
    view.setUint32(padded.length - 4, bitLength >>> 0);

    const h = new Uint32Array([
        0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19,
    ]);
    const w = new Uint32Array(64);
    for (let block = 0; block < blockCount; block++) {
        const offset = block * 64;
        for (let i = 0; i < 16; i++) w[i] = view.getUint32(offset + i * 4);
        for (let i = 16; i < 64; i++) {
            const w15 = w[i - 15];
            const w2 = w[i - 2];
            const s0 = ((w15 >>> 7) | (w15 << 25)) ^ ((w15 >>> 18) | (w15 << 14)) ^ (w15 >>> 3);
            const s1 = ((w2 >>> 17) | (w2 << 15)) ^ ((w2 >>> 19) | (w2 << 13)) ^ (w2 >>> 10);
            w[i] = (w[i - 16] + s0 + w[i - 7] + s1) | 0;
        }
        let a = h[0];
        let b = h[1];
        let c = h[2];
        let d = h[3];
        let e = h[4];
        let f = h[5];
        let g = h[6];
        let hh = h[7];
        for (let i = 0; i < 64; i++) {
            const s1 = ((e >>> 6) | (e << 26)) ^ ((e >>> 11) | (e << 21)) ^ ((e >>> 25) | (e << 7));
            const ch = (e & f) ^ (~e & g);
            const t1 = (hh + s1 + ch + K[i] + w[i]) | 0;
            const s0 = ((a >>> 2) | (a << 30)) ^ ((a >>> 13) | (a << 19)) ^ ((a >>> 22) | (a << 10));
            const maj = (a & b) ^ (a & c) ^ (b & c);
            const t2 = (s0 + maj) | 0;
            hh = g;
            g = f;
            f = e;
            e = (d + t1) | 0;
            d = c;
            c = b;
            b = a;
            a = (t1 + t2) | 0;
        }
        h[0] = (h[0] + a) | 0;
        h[1] = (h[1] + b) | 0;
        h[2] = (h[2] + c) | 0;
        h[3] = (h[3] + d) | 0;
        h[4] = (h[4] + e) | 0;
        h[5] = (h[5] + f) | 0;
        h[6] = (h[6] + g) | 0;
        h[7] = (h[7] + hh) | 0;
    }
    const out = new Uint8Array(32);
    const outView = new DataView(out.buffer);
    for (let i = 0; i < 8; i++) outView.setUint32(i * 4, h[i]);
    return out;
}

const HEX = Array.from({ length: 256 }, (_, i) => i.toString(16).padStart(2, "0"));

function toHex(bytes: Uint8Array, length = bytes.length): string {
    let hex = "";
    for (let i = 0; i < length; i++) hex += HEX[bytes[i]];
    return hex;
}

/** Hex SHA-256 of the UTF-8 encoding of `text`. */
export function sha256Hex(text: string): string {
    return toHex(sha256(encoder.encode(text)));
}

/**
 * The id of a stored object: the first 128 bits of the SHA-256 of its canonical JSON. 128 bits
 * keep ids short (they are repeated in every list that references an object) with a collision
 * chance that is not a practical concern for one document's history.
 */
export function contentHash(text: string): string {
    return toHex(sha256(encoder.encode(text)), 16);
}

export type JsonValue = null | boolean | number | string | JsonValue[] | JsonObject;
export interface JsonObject {
    [key: string]: JsonValue;
}

/**
 * JSON with sorted object keys and no whitespace — one spelling per value, so equal values hash
 * equally whatever order their keys were written in. `undefined` fields are dropped (as
 * `JSON.stringify` drops them), an `undefined` array slot and a non-finite number become `null`.
 */
export function canonicalJson(value: unknown): string {
    if (value === null || value === undefined) return "null";
    switch (typeof value) {
        case "number":
            return Number.isFinite(value) ? JSON.stringify(value) : "null";
        case "string":
            return JSON.stringify(value);
        case "boolean":
            return value ? "true" : "false";
        case "object":
            break;
        default:
            return "null";
    }
    if (Array.isArray(value)) {
        return `[${value.map((x) => canonicalJson(x)).join(",")}]`;
    }
    const record = value as Record<string, unknown>;
    const keys = Object.keys(record)
        .filter((key) => record[key] !== undefined && typeof record[key] !== "function")
        .sort();
    return `{${keys.map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`).join(",")}}`;
}

/** Canonical JSON equality — key order and `undefined` fields do not count. */
export function jsonEquals(a: unknown, b: unknown): boolean {
    if (a === b) return true;
    return canonicalJson(a) === canonicalJson(b);
}

/** A plain-JSON copy of `value` (drops `undefined` fields and functions). */
export function toJsonValue(value: unknown): JsonValue {
    return JSON.parse(canonicalJson(value)) as JsonValue;
}

export function isJsonObject(value: unknown): value is JsonObject {
    return typeof value === "object" && value !== null && !Array.isArray(value);
}
