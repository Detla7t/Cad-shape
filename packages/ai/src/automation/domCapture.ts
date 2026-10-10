// Part of the Chili3d Project, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

/**
 * A best-effort picture of a DOM element without a screenshot library: the element is cloned
 * with its computed styles inlined, canvases replaced by their pixels and icon-sprite `<use>`
 * references resolved, then drawn through an SVG `<foreignObject>` onto a canvas. External
 * images and web fonts may be missing; the viewport itself is captured exactly by the view.
 */

const XHTML = "http://www.w3.org/1999/xhtml";
const MAX_ELEMENTS = 5000;

export interface CapturedImage {
    readonly dataUrl: string;
    readonly width: number;
    readonly height: number;
}

/** Copies every computed style property onto the clone's inline style. */
function inlineStyle(source: Element, target: Element) {
    const view = source.ownerDocument.defaultView;
    const computed = view?.getComputedStyle(source);
    if (!computed) return;
    let text = "";
    for (let i = 0; i < computed.length; i++) {
        const name = computed[i];
        text += `${name}:${computed.getPropertyValue(name)};`;
    }
    target.setAttribute("style", text);
}

/** `<use href="#icon">` points into the page's sprite, which the image does not have: inline it. */
function resolveUse(source: SVGUseElement, document: Document): Element | undefined {
    const href = source.getAttribute("href") ?? source.getAttribute("xlink:href");
    if (!href?.startsWith("#")) return undefined;
    const symbol = document.getElementById(href.slice(1));
    if (!symbol) return undefined;
    const group = document.createElementNS("http://www.w3.org/2000/svg", "svg");
    const viewBox = symbol.getAttribute("viewBox");
    if (viewBox) group.setAttribute("viewBox", viewBox);
    group.setAttribute("width", "100%");
    group.setAttribute("height", "100%");
    for (const child of symbol.childNodes) group.appendChild(child.cloneNode(true));
    return group;
}

/**
 * A childless copy. A custom element is copied as a plain `div` with its attributes: cloning it
 * would run its constructor, which expects the arguments the app passes. The inlined computed
 * style carries its look either way.
 */
function shallowCopy(source: Element): Element {
    if (!source.tagName.includes("-")) return source.cloneNode(false) as Element;
    const copy = source.ownerDocument.createElement("div");
    for (const attribute of source.attributes) {
        try {
            copy.setAttribute(attribute.name, attribute.value);
        } catch {
            /* an attribute name a div cannot take */
        }
    }
    return copy;
}

function cloneWithStyles(
    source: Element,
    budget: { left: number },
    canvasImage: (canvas: HTMLCanvasElement) => string | undefined,
): Node | undefined {
    if (budget.left-- <= 0) return undefined;
    const document = source.ownerDocument;
    if (source instanceof HTMLCanvasElement) {
        const image = document.createElement("img");
        let data: string | undefined;
        try {
            data = canvasImage(source) ?? source.toDataURL();
        } catch {
            data = undefined;
        }
        if (data) image.setAttribute("src", data);
        inlineStyle(source, image);
        return image;
    }
    if (source.tagName === "SCRIPT" || source.tagName === "STYLE" || source.tagName === "LINK")
        return undefined;
    if (source.tagName.toLowerCase() === "use") {
        const resolved = resolveUse(source as SVGUseElement, document);
        if (resolved) return resolved;
    }
    const clone = shallowCopy(source);
    inlineStyle(source, clone);
    if (source instanceof HTMLInputElement) {
        if (source.type === "checkbox" || source.type === "radio") {
            if (source.checked) clone.setAttribute("checked", "");
        } else clone.setAttribute("value", source.value);
    } else if (source instanceof HTMLTextAreaElement) {
        clone.textContent = source.value;
    } else if (source instanceof HTMLSelectElement) {
        clone.setAttribute("data-value", source.value);
    }
    const children = source.shadowRoot
        ? [...source.shadowRoot.childNodes, ...source.childNodes]
        : source.childNodes;
    for (const child of children) {
        if (child.nodeType === 3) clone.appendChild(child.cloneNode());
        else if (child.nodeType === 1) {
            const copy = cloneWithStyles(child as Element, budget, canvasImage);
            if (copy) clone.appendChild(copy);
        }
    }
    if (source instanceof HTMLSelectElement) {
        for (const option of clone.querySelectorAll("option")) {
            if ((option as HTMLOptionElement).value === source.value) option.setAttribute("selected", "");
        }
    }
    return clone;
}

function loadImage(src: string): Promise<HTMLImageElement> {
    return new Promise((resolve, reject) => {
        const image = new Image();
        image.onload = () => resolve(image);
        image.onerror = () => reject(new Error("the browser could not render the element"));
        image.src = src;
    });
}

/**
 * Renders `element` as it is on screen into a PNG data URL, scaled down to `maxWidth`.
 * `canvasImage` supplies a canvas's pixels where reading them needs help (a WebGL view).
 */
export async function captureElement(
    element: Element,
    options: { maxWidth?: number; canvasImage?: (canvas: HTMLCanvasElement) => string | undefined } = {},
): Promise<CapturedImage> {
    const rect = element.getBoundingClientRect();
    const width = Math.max(1, Math.round(rect.width));
    const height = Math.max(1, Math.round(rect.height));
    const clone = cloneWithStyles(element, { left: MAX_ELEMENTS }, options.canvasImage ?? (() => undefined));
    if (!(clone instanceof Element)) throw new Error("nothing to capture");
    clone.setAttribute("xmlns", XHTML);
    // The picture starts at the element's own top left: drop the placement it has on the page.
    const rootStyle = (clone as HTMLElement).style;
    rootStyle.margin = "0";
    rootStyle.position = "relative";
    rootStyle.inset = "auto";
    rootStyle.left = "0";
    rootStyle.top = "0";
    rootStyle.transform = "none";
    const markup = new XMLSerializer().serializeToString(clone);
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}"><foreignObject x="0" y="0" width="100%" height="100%">${markup}</foreignObject></svg>`;
    const image = await loadImage(`data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`);
    const scale = Math.min(1, (options.maxWidth ?? 1600) / width);
    const canvas = element.ownerDocument.createElement("canvas");
    canvas.width = Math.max(1, Math.round(width * scale));
    canvas.height = Math.max(1, Math.round(height * scale));
    const context = canvas.getContext("2d");
    if (!context) throw new Error("no 2D canvas context");
    context.drawImage(image, 0, 0, canvas.width, canvas.height);
    return { dataUrl: canvas.toDataURL("image/png"), width: canvas.width, height: canvas.height };
}

/** A rectangle of an image (a data URL), scaled down to `maxWidth`. */
export async function cropImage(
    dataUrl: string,
    region: { x: number; y: number; width: number; height: number },
    scale: number,
    maxWidth = 1600,
): Promise<CapturedImage> {
    const image = await loadImage(dataUrl);
    // The view's pixels are device pixels; the region is in CSS pixels of the view.
    const sx = Math.max(0, region.x * scale);
    const sy = Math.max(0, region.y * scale);
    const sw = Math.max(1, Math.min(image.width - sx, region.width * scale));
    const sh = Math.max(1, Math.min(image.height - sy, region.height * scale));
    const fit = Math.min(1, maxWidth / sw);
    const canvas = document.createElement("canvas");
    canvas.width = Math.max(1, Math.round(sw * fit));
    canvas.height = Math.max(1, Math.round(sh * fit));
    const context = canvas.getContext("2d");
    if (!context) throw new Error("no 2D canvas context");
    context.drawImage(image, sx, sy, sw, sh, 0, 0, canvas.width, canvas.height);
    return { dataUrl: canvas.toDataURL("image/png"), width: canvas.width, height: canvas.height };
}
