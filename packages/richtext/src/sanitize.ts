// Part of the Chili3d Project, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

/**
 * HTML from files (Markdown previews, converted Word and OpenDocument files, pasted
 * content) is untrusted. It is parsed into an inert document (`DOMParser`: no script
 * runs, nothing loads) and rebuilt from an allowlist:
 *
 * - formatting, structure, lists, tables, links and images are kept; scripts, styles,
 *   frames, objects, forms, SVG/MathML (the namespace-confusion vectors) and templates are
 *   dropped with their content; any other element is unwrapped (its text stays);
 * - attributes are allowlisted per element — no event handlers, ids, names or classes;
 *   inline styles are reduced to text alignment (a style can fetch remote content);
 * - URLs must be http(s), mailto, tel or relative; images may also be `data:` PNG,
 *   JPEG, GIF, WebP or BMP; links open in a new tab without access to the app.
 */

const COMMON = ["title", "lang", "dir"];

const ALLOWED: Record<string, readonly string[]> = {
    a: ["href"],
    abbr: [],
    b: [],
    blockquote: [],
    br: [],
    caption: [],
    cite: [],
    code: [],
    col: ["span"],
    colgroup: ["span"],
    dd: [],
    del: [],
    details: [],
    div: ["align"],
    dl: [],
    dt: [],
    em: [],
    figcaption: [],
    figure: [],
    h1: ["align"],
    h2: ["align"],
    h3: ["align"],
    h4: ["align"],
    h5: ["align"],
    h6: ["align"],
    hr: [],
    i: [],
    img: ["src", "alt", "width", "height"],
    ins: [],
    kbd: [],
    li: ["value"],
    mark: [],
    ol: ["start", "type", "reversed"],
    p: ["align"],
    pre: [],
    q: [],
    s: [],
    samp: [],
    section: [],
    small: [],
    span: [],
    strike: [],
    strong: [],
    sub: [],
    summary: [],
    sup: [],
    table: [],
    tbody: [],
    td: ["colspan", "rowspan", "align"],
    tfoot: [],
    th: ["colspan", "rowspan", "scope", "align"],
    thead: [],
    tr: [],
    u: [],
    ul: [],
    article: [],
    aside: [],
    footer: [],
    header: [],
    main: [],
    nav: [],
};

/** Removed together with everything inside them. */
const DROPPED = new Set([
    "script",
    "style",
    "template",
    "iframe",
    "frame",
    "frameset",
    "object",
    "embed",
    "applet",
    "noscript",
    "noembed",
    "noframes",
    "svg",
    "math",
    "form",
    "input",
    "button",
    "select",
    "option",
    "optgroup",
    "textarea",
    "label",
    "link",
    "meta",
    "base",
    "head",
    "title",
    "xmp",
    "plaintext",
    "audio",
    "video",
    "source",
    "track",
    "canvas",
    "dialog",
    "portal",
    "slot",
]);

// biome-ignore lint/suspicious/noControlCharactersInRegex: browsers ignore these inside URL schemes
const URL_NOISE = /[\u0000- \u007f]+/g;
const SAFE_SCHEME = /^(https?:|mailto:|tel:)/i;
const SAFE_IMAGE = /^data:image\/(png|jpe?g|gif|webp|bmp);base64,[a-z0-9+/=\s]*$/i;

/** Whether `url` may stay: a safe scheme, or relative (no scheme at all). */
function safeUrl(url: string, image: boolean): boolean {
    const compact = url.replace(URL_NOISE, "");
    if (image && SAFE_IMAGE.test(url.trim())) return true;
    if (SAFE_SCHEME.test(compact)) return true;
    // Relative: no "scheme:" before the first "/", "?" or "#".
    return !/^[^/?#]*:/.test(compact);
}

function cleanAttributes(element: Element, tag: string): void {
    const allowed = new Set([...COMMON, ...(ALLOWED[tag] ?? [])]);
    for (const attribute of Array.from(element.attributes)) {
        const name = attribute.name.toLowerCase();
        const value = attribute.value;
        if (name === "style") {
            const align = /text-align\s*:\s*(left|right|center|justify)/i.exec(value)?.[1];
            if (align === undefined) element.removeAttribute(attribute.name);
            else element.setAttribute("style", `text-align: ${align.toLowerCase()}`);
            continue;
        }
        if (!allowed.has(name)) {
            element.removeAttribute(attribute.name);
            continue;
        }
        if ((name === "href" || name === "src") && !safeUrl(value, name === "src" && tag === "img")) {
            element.removeAttribute(attribute.name);
        }
    }
    if (tag === "a" && element.hasAttribute("href")) {
        element.setAttribute("target", "_blank");
        element.setAttribute("rel", "noopener noreferrer");
    }
}

function clean(parent: Node): void {
    for (const child of Array.from(parent.childNodes)) {
        if (child.nodeType === 3) continue; // text
        if (child.nodeType !== 1) {
            child.parentNode?.removeChild(child); // comments, processing instructions
            continue;
        }
        const element = child as Element;
        const tag = element.localName.toLowerCase();
        if (DROPPED.has(tag) || element.namespaceURI !== "http://www.w3.org/1999/xhtml") {
            element.parentNode?.removeChild(element);
            continue;
        }
        clean(element);
        if (ALLOWED[tag] === undefined) {
            // Unknown element: keep its (already cleaned) content.
            while (element.firstChild !== null) parent.insertBefore(element.firstChild, element);
            parent.removeChild(element);
            continue;
        }
        cleanAttributes(element, tag);
    }
}

export function sanitizeHtml(html: string): string {
    const document = new DOMParser().parseFromString(
        `<!DOCTYPE html><html><body>${html}</body></html>`,
        "text/html",
    );
    clean(document.body);
    return document.body.innerHTML;
}
