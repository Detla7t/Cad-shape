// Part of the Chili3d Project, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

// Shared factory implementations for the `@chili3d/element` mocks used by UI tests.
// Test files import `mockElement` (default) or `mockElementRealEvents` BEFORE
// importing the module under test; those modules register the hoisted
// `rs.mock("@chili3d/element", ...)` call at module scope and delegate the factory
// implementation here (`rs.mock` factories must stay sync — rstest does not await
// async factories — so this helper is loaded via `rs.hoisted`):
//
//     rs.mock("@chili3d/element", () => {
//         const { createElementMocks } = rs.hoisted(() => require("./elementMocks"));
//         return createElementMocks();
//     });
//
// The mock stores event handlers on `_on*` fields (e.g. `_onclick`) so tests can
// invoke them directly. Pass `{ realEvents: true }` when a test triggers handlers
// through `el.click()` / real event dispatch instead.

export interface ElementMockOptions {
    /**
     * Also assign event handlers (onclick, onchange, ...) to the real DOM properties,
     * in addition to the `_on*` fields.
     */
    realEvents?: boolean;
}

const EVENT_PROPS = [
    "onclick",
    "ondblclick",
    "onchange",
    "oninput",
    "onkeydown",
    "onblur",
    "onfocus",
] as const;

function applyProps(el: HTMLElement, props: any, opts: ElementMockOptions): void {
    if (!props || typeof props !== "object" || props instanceof Node) return;
    if (props.className) el.className = String(props.className);
    if (props.id) el.id = String(props.id);
    if (props.title) el.title = String(props.title);
    if (props.textContent !== undefined && typeof props.textContent !== "object") {
        el.textContent = String(props.textContent);
    }
    if (props.type) (el as HTMLInputElement).type = String(props.type);
    if (typeof props.value === "string") (el as HTMLInputElement).value = props.value;
    if (props.checked !== undefined) {
        (el as HTMLInputElement).checked = Boolean(props.checked);
        (el as any)._checked = props.checked;
    }
    if (props.readOnly !== undefined) (el as HTMLInputElement).readOnly = Boolean(props.readOnly);
    if (props.selected !== undefined) {
        (el as HTMLOptionElement).selected = Boolean(props.selected);
        // Happy-DOM scrambles `option.selected` when several options are appended to
        // a select — keep the raw flag so tests can assert what was passed in.
        (el as any)._selected = props.selected;
    }
    if (props.htmlFor) (el as HTMLLabelElement).htmlFor = String(props.htmlFor);
    if (props.href) (el as HTMLAnchorElement).href = String(props.href);
    if (props.target) (el as HTMLAnchorElement).target = String(props.target);
    if (props.style) Object.assign(el.style, props.style);
    for (const name of EVENT_PROPS) {
        if (!props[name]) continue;
        (el as any)[`_${name}`] = props[name];
        if (opts.realEvents) (el as any)[name] = props[name];
    }
}

function appendChildren(el: HTMLElement, children: any[]): void {
    for (const c of children) {
        if (c instanceof Node) el.appendChild(c);
        else if (typeof c === "string") el.appendChild(document.createTextNode(c));
    }
}

export function createEl(tag: string, props: any, children: any[], opts: ElementMockOptions): HTMLElement {
    const el = document.createElement(tag);
    // The real element helpers allow the first argument to be a child node instead of props
    if (props instanceof Node || typeof props === "string") {
        appendChildren(el, [props, ...children]);
        return el;
    }
    applyProps(el, props, opts);
    appendChildren(el, children);
    return el;
}

function createSvg(props: any): SVGElement {
    const el = document.createElementNS("http://www.w3.org/2000/svg", "svg");
    if (props && typeof props === "object") {
        if (props.className) el.setAttribute("class", String(props.className));
        if (props.icon) el.setAttribute("icon", String(props.icon));
        if (props.title) el.setAttribute("title", String(props.title));
        if (props.textContent !== undefined && typeof props.textContent !== "object") {
            el.textContent = String(props.textContent);
        }
        if (props.onclick) (el as any)._onclick = props.onclick;
    }
    return el;
}

// Mock for `createIcon`: string icons become an <svg> carrying the icon name in an
// `icon` attribute (mirrors `createSvg`), non-string icons fall back to "icon-chili".
function createIconMock(icon: any): SVGElement {
    return createSvg({ icon: typeof icon === "string" ? icon : "icon-chili" });
}

// Mock for `setSVGIcon`: updates the `icon` attribute so tests can assert icon swaps.
function setSVGIconMock(svgEl: any, newIcon: string): void {
    (svgEl as Element).setAttribute("icon", newIcon);
}

class MockConverter {
    convert(v: unknown) {
        return { isOk: true, value: v };
    }
    convertBack(v: string) {
        return { isOk: true, value: v };
    }
}

class MockExpander extends HTMLElement {
    contenxtPanel: HTMLElement;
    constructor(_title: string) {
        super();
        this.contenxtPanel = document.createElement("div");
        this.appendChild(this.contenxtPanel);
    }
}

// happy-dom rejects `new` on unregistered HTMLElement subclasses ("Illegal constructor").
if (typeof customElements !== "undefined" && !customElements.get("chili-mock-expander")) {
    customElements.define("chili-mock-expander", MockExpander);
}

function createCollection(opts: any): HTMLElement {
    const container = document.createElement("div");
    if (opts?.sources && opts.template) {
        const items: any[] = [];
        if (typeof opts.sources.forEach === "function") {
            opts.sources.forEach((item: any) => {
                items.push(item);
            });
        } else if (Array.isArray(opts.sources)) {
            items.push(...opts.sources);
        }
        for (let i = 0; i < items.length; i++) {
            const el = opts.template(items[i], i);
            if (el instanceof Node) container.appendChild(el);
        }
    }
    return container;
}

/**
 * Returns the full mocked `@chili3d/element` module namespace. Test files may pick
 * only the entries they need or override individual entries afterwards.
 */
export function createElementMocks(options: ElementMockOptions = {}) {
    return {
        div: (props: any, ...children: any[]) => createEl("div", props, children, options),
        span: (props: any, ...children: any[]) => createEl("span", props, children, options),
        label: (props: any, ...children: any[]) => createEl("label", props, children, options),
        input: (props: any, ...children: any[]) => createEl("input", props, children, options),
        button: (props: any, ...children: any[]) => createEl("button", props, children, options),
        a: (props: any, ...children: any[]) => createEl("a", props, children, options),
        select: (props: any, ...children: any[]) => createEl("select", props, children, options),
        option: (props: any, ...children: any[]) => createEl("option", props, children, options),
        img: (props: any, ...children: any[]) => createEl("img", props, children, options),
        svg: createSvg,
        createIcon: createIconMock,
        createCadIcon: createIconMock,
        setSVGIcon: setSVGIconMock,
        collection: createCollection,
        Expander: MockExpander,
        NumberConverter: MockConverter,
        StringConverter: MockConverter,
        XYConverter: MockConverter,
        XYZConverter: MockConverter,
        ColorConverter: MockConverter,
        UrlStringConverter: MockConverter,
    };
}
