// Part of the Chili3d Project, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

/** Text escapes shared by every office writer (OOXML parts, ODF content, HTML from ODT). */

const ENTITIES: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'" };

/** XML text with its predefined and numeric character references decoded. */
export function decodeXml(text: string): string {
    if (!text.includes("&")) return text;
    return text.replace(/&(#x[\da-f]+|#\d+|\w+);/gi, (whole, entity: string) => {
        if (entity[0] === "#") {
            const code =
                entity[1] === "x" || entity[1] === "X"
                    ? Number.parseInt(entity.slice(2), 16)
                    : Number.parseInt(entity.slice(1), 10);
            return Number.isFinite(code) ? String.fromCodePoint(code) : whole;
        }
        return ENTITIES[entity] ?? whole;
    });
}

/** Whether a UTF-16 code unit is a control character XML 1.0 forbids (all below U+0020 but tab, LF, CR). */
export const isXmlControl = (code: number) => code < 0x20 && code !== 0x09 && code !== 0x0a && code !== 0x0d;

/**
 * Text or an attribute value as XML (also valid HTML): `&`, `<`, `>` and `"` escaped, and
 * the control characters XML 1.0 cannot carry at all dropped.
 */
export function escapeXml(text: string): string {
    let clean = text;
    for (let i = 0; i < text.length; i++) {
        if (isXmlControl(text.charCodeAt(i))) {
            clean = Array.from(text)
                .filter((ch) => !isXmlControl(ch.charCodeAt(0)))
                .join("");
            break;
        }
    }
    return clean.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}
