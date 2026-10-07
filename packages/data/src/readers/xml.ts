// Part of the Chili3d Project, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

/**
 * A small, forgiving XML reader for the parts of OOXML and OpenDocument a spreadsheet's cell
 * values live in: elements with attributes and text, comments, processing instructions, CDATA
 * and the predefined and numeric entities. No DTDs or namespace resolution — elements are
 * matched by local name (`x:row` and `row` are both `row`), which is all the readers need and
 * keeps them working on files that bind the namespaces to other prefixes.
 */
export interface XmlElement {
    /** Local name, without the prefix. */
    readonly name: string;
    /** Attributes by qualified name as written (`r`, `r:id`, `table:name`). */
    readonly attributes: ReadonlyMap<string, string>;
    readonly children: readonly XmlNode[];
}

export type XmlNode = XmlElement | string;

interface MutableElement {
    name: string;
    attributes: Map<string, string>;
    children: XmlNode[];
}

const ENTITIES: Record<string, string> = { lt: "<", gt: ">", amp: "&", quot: '"', apos: "'" };

export function decodeEntities(text: string): string {
    if (!text.includes("&")) return text;
    return text.replace(/&(#x[0-9a-fA-F]+|#\d+|\w+);/g, (match, entity: string) => {
        if (entity.startsWith("#x")) return String.fromCodePoint(Number.parseInt(entity.slice(2), 16));
        if (entity.startsWith("#")) return String.fromCodePoint(Number.parseInt(entity.slice(1), 10));
        return ENTITIES[entity] ?? match;
    });
}

function localName(qualified: string): string {
    const colon = qualified.indexOf(":");
    return colon < 0 ? qualified : qualified.slice(colon + 1);
}

const ATTRIBUTE = /([^\s=/>]+)\s*=\s*("([^"]*)"|'([^']*)')/g;

/** Parses `text` into its root element; throws on markup it cannot make sense of. */
export function parseXml(text: string): XmlElement {
    const root: MutableElement = { name: "#document", attributes: new Map(), children: [] };
    const stack: MutableElement[] = [root];
    let pos = 0;
    while (pos < text.length) {
        const open = text.indexOf("<", pos);
        if (open < 0) {
            appendText(stack, text.slice(pos));
            break;
        }
        if (open > pos) appendText(stack, text.slice(pos, open));
        if (text.startsWith("<!--", open)) {
            pos = skipPast(text, "-->", open);
        } else if (text.startsWith("<![CDATA[", open)) {
            const end = text.indexOf("]]>", open);
            if (end < 0) throw new Error("Unterminated CDATA section");
            stack[stack.length - 1].children.push(text.slice(open + 9, end));
            pos = end + 3;
        } else if (text.startsWith("<?", open)) {
            pos = skipPast(text, "?>", open);
        } else if (text.startsWith("<!", open)) {
            pos = skipPast(text, ">", open);
        } else if (text[open + 1] === "/") {
            const close = text.indexOf(">", open);
            if (close < 0) throw new Error("Unterminated closing tag");
            const name = localName(text.slice(open + 2, close).trim());
            // Pop to the matching element; a stray closing tag is ignored.
            const at = stack.map((element) => element.name).lastIndexOf(name);
            if (at > 0) stack.length = at;
            pos = close + 1;
        } else {
            const close = findTagEnd(text, open);
            const body = text.slice(open + 1, close);
            const selfClosing = body.endsWith("/");
            const content = selfClosing ? body.slice(0, -1) : body;
            const nameEnd = content.search(/[\s/>]|$/);
            const element: MutableElement = {
                name: localName(content.slice(0, nameEnd)),
                attributes: new Map(),
                children: [],
            };
            for (const match of content.slice(nameEnd).matchAll(ATTRIBUTE)) {
                element.attributes.set(match[1], decodeEntities(match[3] ?? match[4] ?? ""));
            }
            stack[stack.length - 1].children.push(element);
            if (!selfClosing) stack.push(element);
            pos = close + 1;
        }
    }
    const element = root.children.find((child): child is XmlElement => typeof child !== "string");
    if (element === undefined) throw new Error("The XML has no root element");
    return element;
}

function appendText(stack: MutableElement[], raw: string): void {
    if (stack.length > 1) stack[stack.length - 1].children.push(decodeEntities(raw));
}

function skipPast(text: string, marker: string, from: number): number {
    const end = text.indexOf(marker, from);
    if (end < 0) throw new Error(`Unterminated markup: expected ${marker}`);
    return end + marker.length;
}

/** The `>` ending the tag at `open`, skipping any inside quoted attribute values. */
function findTagEnd(text: string, open: number): number {
    let quote: string | undefined;
    for (let i = open + 1; i < text.length; i++) {
        const ch = text[i];
        if (quote !== undefined) {
            if (ch === quote) quote = undefined;
        } else if (ch === '"' || ch === "'") quote = ch;
        else if (ch === ">") return i;
    }
    throw new Error("Unterminated tag");
}

// ------------------------------------------------------------------ Queries

export function childElements(element: XmlElement, name?: string): XmlElement[] {
    return element.children.filter(
        (child): child is XmlElement =>
            typeof child !== "string" && (name === undefined || child.name === name),
    );
}

export function firstChild(element: XmlElement, name: string): XmlElement | undefined {
    return childElements(element, name)[0];
}

/** Every descendant element named `name`, in document order, not descending into a match. */
export function findElements(
    element: XmlElement,
    name: string,
    into?: (element: XmlElement) => boolean,
): XmlElement[] {
    const found: XmlElement[] = [];
    const visit = (node: XmlElement) => {
        for (const child of childElements(node)) {
            if (child.name === name) found.push(child);
            else if (into === undefined || into(child)) visit(child);
        }
    };
    visit(element);
    return found;
}

/** An attribute by local name, whatever prefix it was written with. */
export function attribute(element: XmlElement, name: string): string | undefined {
    const exact = element.attributes.get(name);
    if (exact !== undefined) return exact;
    for (const [key, value] of element.attributes) if (localName(key) === name) return value;
    return undefined;
}

/** All text below `element`, in order. */
export function textContent(element: XmlElement): string {
    return element.children.map((child) => (typeof child === "string" ? child : textContent(child))).join("");
}
