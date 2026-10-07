// Part of the Chili3d Project, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

/** Bytes per `String.fromCharCode` call — far below every engine's argument limit. */
const CHUNK = 0x8000;

/** Base64 of `bytes`, chunked so a multi-megabyte attachment does not overflow the call stack. */
export function bytesToBase64(bytes: Uint8Array): string {
    let binary = "";
    for (let i = 0; i < bytes.length; i += CHUNK) {
        binary += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
    }
    return btoa(binary);
}

/** The bytes of a base64 string; undefined when it is not base64. */
export function base64ToBytes(text: string): Uint8Array | undefined {
    let binary: string;
    try {
        binary = atob(text.replace(/\s+/g, ""));
    } catch {
        return undefined;
    }
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
    return bytes;
}
