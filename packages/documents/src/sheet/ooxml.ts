// Part of the Chili3d Project, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

/**
 * A small, dependency-free XML reader for the OOXML parts ExcelJS does not model (tables,
 * drawings, themes, relationships). It runs where `DOMParser` does not (workers, Node) and
 * matches elements by local name, so the `x:`/`xdr:`/`a:` prefixes a producer picks do not
 * matter. Not a validating parser: no DTDs, entity declarations or namespaces resolution.
 */

export interface XmlElement {
    /** The local name ("twoCellAnchor" for `xdr:twoCellAnchor`). */
    name: string;
    /** Attributes by qualified name ("r:id"). */
    attrs: Record<string, string>;
    children: XmlElement[];
    /** Text directly inside the element (concatenated, entities decoded). */
    text: string;
}

const ENTITIES: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'" };

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

const localName = (qualified: string) => qualified.slice(qualified.indexOf(":") + 1);

/** The root element of an XML document; undefined for empty or malformed text. */
export function parseXml(xml: string): XmlElement | undefined {
    const root: XmlElement = { name: "#document", attrs: {}, children: [], text: "" };
    const stack: XmlElement[] = [root];
    const tag =
        /<(\/?)([\w:.-]+)((?:\s+[\w:.-]+\s*=\s*(?:"[^"]*"|'[^']*'))*)\s*(\/?)>|<!--[\s\S]*?-->|<\?[\s\S]*?\?>|<!\[CDATA\[([\s\S]*?)\]\]>|<![^>]*>/g;
    const attribute = /([\w:.-]+)\s*=\s*(?:"([^"]*)"|'([^']*)')/g;
    let last = 0;
    for (let match = tag.exec(xml); match; match = tag.exec(xml)) {
        const top = stack[stack.length - 1];
        if (match.index > last) top.text += decodeXml(xml.slice(last, match.index));
        last = tag.lastIndex;
        if (match[5] !== undefined) {
            top.text += match[5];
            continue;
        }
        if (match[2] === undefined) continue;
        if (match[1] === "/") {
            if (stack.length > 1) stack.pop();
            continue;
        }
        const attrs: Record<string, string> = {};
        for (let a = attribute.exec(match[3]); a; a = attribute.exec(match[3])) {
            attrs[a[1]] = decodeXml(a[2] ?? a[3] ?? "");
        }
        attribute.lastIndex = 0;
        const element: XmlElement = { name: localName(match[2]), attrs, children: [], text: "" };
        top.children.push(element);
        if (match[4] !== "/") stack.push(element);
    }
    return root.children[0];
}

/** An attribute by qualified or local name ("id" also finds "r:id"). */
export function attr(element: XmlElement | undefined, name: string): string | undefined {
    if (!element) return undefined;
    if (name in element.attrs) return element.attrs[name];
    for (const key in element.attrs) if (localName(key) === name) return element.attrs[key];
    return undefined;
}

export function child(element: XmlElement | undefined, name: string): XmlElement | undefined {
    return element?.children.find((c) => c.name === name);
}

export function children(element: XmlElement | undefined, name: string): XmlElement[] {
    return element?.children.filter((c) => c.name === name) ?? [];
}

/** Every descendant named `name`, depth first. */
export function descendants(element: XmlElement | undefined, name: string): XmlElement[] {
    const found: XmlElement[] = [];
    const visit = (e: XmlElement) => {
        for (const c of e.children) {
            if (c.name === name) found.push(c);
            visit(c);
        }
    };
    if (element) visit(element);
    return found;
}

/** `true`/`1` → true, `false`/`0` → false, absent → `fallback`. */
export function boolAttr(element: XmlElement | undefined, name: string, fallback: boolean): boolean {
    const value = attr(element, name);
    return value === undefined ? fallback : value === "1" || value === "true";
}

// ------------------------------------------------------------------ Package parts

export interface Relationship {
    id: string;
    type: string;
    target: string;
    external: boolean;
}

/** A part's relationships by id. */
export function parseRelationships(xml: string | undefined): Map<string, Relationship> {
    const map = new Map<string, Relationship>();
    for (const rel of children(parseXml(xml ?? ""), "Relationship")) {
        const id = attr(rel, "Id");
        if (!id) continue;
        map.set(id, {
            id,
            type: attr(rel, "Type") ?? "",
            target: attr(rel, "Target") ?? "",
            external: attr(rel, "TargetMode") === "External",
        });
    }
    return map;
}

/** The relationships part path of a part: "xl/worksheets/sheet1.xml" → "xl/worksheets/_rels/sheet1.xml.rels". */
export function relsPath(part: string): string {
    const slash = part.lastIndexOf("/");
    return `${part.slice(0, slash + 1)}_rels/${part.slice(slash + 1)}.rels`;
}

/** A relationship target resolved against its source part ("../media/a.png" from "xl/drawings/d.xml"). */
export function resolvePart(source: string, target: string): string {
    if (target.startsWith("/")) return target.slice(1);
    const parts = source.split("/").slice(0, -1);
    for (const segment of target.split("/")) {
        if (segment === "..") parts.pop();
        else if (segment !== "." && segment !== "") parts.push(segment);
    }
    return parts.join("/");
}

/** The shortest relative target from `source` to `part` (both package paths). */
export function relativeTarget(source: string, part: string): string {
    const from = source.split("/").slice(0, -1);
    const to = part.split("/");
    let common = 0;
    while (common < from.length && common < to.length - 1 && from[common] === to[common]) common++;
    return [...Array(from.length - common).fill(".."), ...to.slice(common)].join("/");
}

export const REL = {
    hyperlink: "http://schemas.openxmlformats.org/officeDocument/2006/relationships/hyperlink",
    table: "http://schemas.openxmlformats.org/officeDocument/2006/relationships/table",
    drawing: "http://schemas.openxmlformats.org/officeDocument/2006/relationships/drawing",
    image: "http://schemas.openxmlformats.org/officeDocument/2006/relationships/image",
    worksheet: "http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet",
    theme: "http://schemas.openxmlformats.org/officeDocument/2006/relationships/theme",
    sheetMetadata: "http://schemas.openxmlformats.org/officeDocument/2006/relationships/sheetMetadata",
} as const;

/** Appends relationships to a .rels document (or a new one), returning the XML and the new ids. */
export function addRelationships(
    xml: string | undefined,
    rels: { type: string; target: string; external?: boolean }[],
): { xml: string; ids: string[] } {
    const base = xml?.includes("</Relationships>")
        ? xml
        : '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"></Relationships>';
    let next = 1;
    for (const id of parseRelationships(base).keys()) {
        const n = /^rId(\d+)$/.exec(id);
        if (n) next = Math.max(next, Number(n[1]) + 1);
    }
    const ids: string[] = [];
    const entries = rels.map((rel) => {
        const id = `rId${next++}`;
        ids.push(id);
        return `<Relationship Id="${id}" Type="${rel.type}" Target="${escapeXml(rel.target)}"${rel.external ? ' TargetMode="External"' : ""}/>`;
    });
    return { xml: base.replace("</Relationships>", `${entries.join("")}</Relationships>`), ids };
}

/**
 * Inserts `element` into a part before the first of `before` (start tags, by qualified name
 * without "<") that occurs, else before the closing `</root>` tag — the schema's element
 * order without parsing the (possibly large) part.
 */
export function insertBefore(xml: string, element: string, before: readonly string[], root: string): string {
    let at = -1;
    for (const name of before) {
        const match = new RegExp(`<${name}[\\s/>]`).exec(xml);
        if (match && (at < 0 || match.index < at)) at = match.index;
    }
    if (at < 0) at = xml.lastIndexOf(`</${root}>`);
    if (at < 0) return xml;
    return xml.slice(0, at) + element + xml.slice(at);
}
