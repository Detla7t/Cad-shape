// Part of the Chili3d Project, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

/**
 * The text of a file that may predate UTF-8 (CSV from a spreadsheet program, pre-2007 DXF):
 * UTF-8 when the bytes are valid UTF-8 (a byte-order mark is dropped), otherwise Windows-1252
 * — by far the most common legacy code page, and one that decodes every byte.
 */
export function decodeText(bytes: Uint8Array): string {
    try {
        return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    } catch {
        return new TextDecoder("windows-1252").decode(bytes);
    }
}
