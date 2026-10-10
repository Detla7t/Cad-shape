// Part of the Chili3d Project, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

/**
 * The page's interactive UI as a remote client sees it: a compact snapshot (role, accessible
 * name, text, state, a stable ref) and a resolver that finds one element by ref, CSS selector,
 * aria-label or visible text. Refs stay the same for the same element across snapshots and
 * die with it; they are what later clicks and typing aim at.
 */

const refs = new WeakMap<Element, string>();
const elements = new Map<string, WeakRef<Element>>();
let nextRef = 1;

export function refOf(element: Element): string {
    let ref = refs.get(element);
    if (ref === undefined) {
        ref = `e${nextRef++}`;
        refs.set(element, ref);
        elements.set(ref, new WeakRef(element));
    }
    return ref;
}

export function elementByRef(ref: string): Element | undefined {
    const element = elements.get(ref)?.deref();
    if (element === undefined || !element.isConnected) {
        elements.delete(ref);
        return undefined;
    }
    return element;
}

const INTERACTIVE_ROLES = new Set([
    "button",
    "link",
    "menuitem",
    "menuitemcheckbox",
    "menuitemradio",
    "tab",
    "checkbox",
    "radio",
    "switch",
    "option",
    "treeitem",
    "combobox",
    "listbox",
    "slider",
    "spinbutton",
    "textbox",
    "searchbox",
    "gridcell",
]);

const IMPLICIT_ROLES: Record<string, string> = {
    BUTTON: "button",
    A: "link",
    SELECT: "combobox",
    TEXTAREA: "textbox",
    SUMMARY: "button",
    OPTION: "option",
    DIALOG: "dialog",
    DETAILS: "group",
};

function inputRole(input: HTMLInputElement): string {
    switch (input.type) {
        case "checkbox":
            return "checkbox";
        case "radio":
            return "radio";
        case "range":
            return "slider";
        case "number":
            return "spinbutton";
        case "button":
        case "submit":
        case "reset":
        case "image":
            return "button";
        case "search":
            return "searchbox";
        default:
            return "textbox";
    }
}

export function roleOf(element: Element): string {
    const explicit = element.getAttribute("role");
    if (explicit) return explicit.split(" ")[0];
    if (element instanceof HTMLInputElement) return inputRole(element);
    if (element.tagName === "A" && !element.hasAttribute("href")) return "generic";
    if ((element as HTMLElement).isContentEditable) return "textbox";
    return IMPLICIT_ROLES[element.tagName] ?? (hasClickHandler(element) ? "button" : "generic");
}

/** Elements the app made clickable by assigning `onclick` (the custom-element UI does this). */
function hasClickHandler(element: Element): boolean {
    const html = element as HTMLElement;
    return typeof html.onclick === "function" || typeof html.ondblclick === "function";
}

export function isInteractive(element: Element): boolean {
    if (element instanceof HTMLInputElement) return element.type !== "hidden";
    if (
        element instanceof HTMLButtonElement ||
        element instanceof HTMLSelectElement ||
        element instanceof HTMLTextAreaElement
    )
        return true;
    if (element.tagName === "A" && element.hasAttribute("href")) return true;
    if (element.tagName === "SUMMARY") return true;
    const role = element.getAttribute("role");
    if (role && INTERACTIVE_ROLES.has(role.split(" ")[0])) return true;
    if (
        (element as HTMLElement).isContentEditable &&
        !(element.parentElement as HTMLElement | null)?.isContentEditable
    )
        return true;
    const tabIndex = element.getAttribute("tabindex");
    if (tabIndex !== null && Number(tabIndex) >= 0 && element.tagName !== "DIALOG") return true;
    return hasClickHandler(element);
}

export function isVisible(element: Element): boolean {
    if (!element.isConnected) return false;
    const html = element as HTMLElement & { checkVisibility?: (options?: object) => boolean };
    if (typeof html.checkVisibility === "function") {
        return html.checkVisibility({ checkOpacity: false, checkVisibilityCSS: true });
    }
    // Without layout (tests), the hidden attribute and inline/computed display decide.
    for (let node: Element | null = element; node; node = node.parentElement) {
        if (node.hasAttribute("hidden")) return false;
        const style = node.ownerDocument.defaultView?.getComputedStyle(node);
        if (style && (style.display === "none" || style.visibility === "hidden")) return false;
    }
    return true;
}

const clean = (text: string | null | undefined, max = 120) => {
    const value = (text ?? "").replace(/\s+/g, " ").trim();
    return value.length > max ? `${value.slice(0, max - 1)}…` : value;
};

function labelledBy(element: Element): string {
    const ids = element.getAttribute("aria-labelledby");
    if (!ids) return "";
    return ids
        .split(/\s+/)
        .map((id) => element.ownerDocument.getElementById(id)?.textContent ?? "")
        .join(" ");
}

function labelFor(element: Element): string {
    const id = element.getAttribute("id");
    const byFor = id ? element.ownerDocument.querySelector(`label[for="${CSS.escape(id)}"]`) : null;
    return byFor?.textContent ?? element.closest("label")?.textContent ?? "";
}

/** What a screen reader would call it, simplified: aria, labels, title, then text. */
export function accessibleName(element: Element): string {
    const aria = element.getAttribute("aria-label");
    if (aria) return clean(aria);
    const by = labelledBy(element);
    if (by.trim()) return clean(by);
    const isField =
        element instanceof HTMLInputElement ||
        element instanceof HTMLSelectElement ||
        element instanceof HTMLTextAreaElement;
    if (isField) {
        const label = labelFor(element);
        if (label.trim()) return clean(label);
        const placeholder = element.getAttribute("placeholder");
        if (placeholder) return clean(placeholder);
    }
    const text = isField ? "" : clean(visibleText(element));
    if (text) return text;
    const title = element.getAttribute("title") ?? element.querySelector("title")?.textContent;
    if (title) return clean(title);
    return clean(element.getAttribute("alt") ?? element.getAttribute("data-command") ?? "");
}

function visibleText(element: Element): string {
    const html = element as HTMLElement;
    // innerText skips hidden descendants where layout exists; textContent where it does not.
    return typeof html.innerText === "string" && html.innerText !== ""
        ? html.innerText
        : (element.textContent ?? "");
}

/** Every element under `root`, open shadow roots included, in document order. */
export function* allElements(root: Element | Document): Generator<Element> {
    const stack: Element[] = [];
    const push = (parent: Element | Document | ShadowRoot) => {
        const children = parent.children;
        for (let i = children.length - 1; i >= 0; i--) stack.push(children[i]);
    };
    push(root);
    while (stack.length) {
        const element = stack.pop()!;
        yield element;
        if (element.shadowRoot) push(element.shadowRoot);
        push(element);
    }
}

export interface UiNode {
    ref: string;
    role: string;
    name: string;
    tag: string;
    text?: string;
    value?: string;
    checked?: boolean;
    selected?: boolean;
    expanded?: boolean;
    disabled?: boolean;
    focused?: boolean;
    command?: string;
    in?: string;
}

function isDisabled(element: Element): boolean {
    return (
        (element as HTMLButtonElement).disabled === true ||
        element.getAttribute("aria-disabled") === "true" ||
        element.closest("fieldset:disabled") !== null
    );
}

function fieldValue(element: Element): string | undefined {
    if (element instanceof HTMLSelectElement) {
        return clean(element.selectedOptions[0]?.textContent ?? element.value, 80);
    }
    if (element instanceof HTMLInputElement && (element.type === "checkbox" || element.type === "radio"))
        return undefined;
    if (element instanceof HTMLInputElement || element instanceof HTMLTextAreaElement)
        return clean(element.value, 200);
    if ((element as HTMLElement).isContentEditable) return clean(element.textContent, 200);
    const now = element.getAttribute("aria-valuenow");
    return now ?? undefined;
}

function checkedOf(element: Element): boolean | undefined {
    if (element instanceof HTMLInputElement && (element.type === "checkbox" || element.type === "radio"))
        return element.checked;
    const aria = element.getAttribute("aria-checked") ?? element.getAttribute("aria-pressed");
    return aria === null ? undefined : aria === "true";
}

const REGION_ROLES = new Set([
    "dialog",
    "alertdialog",
    "menu",
    "toolbar",
    "tablist",
    "tree",
    "region",
    "navigation",
]);

/** The nearest named container: a dialog, a menu, a labelled region, or the custom element it sits in. */
function regionOf(element: Element): string | undefined {
    for (let node = element.parentElement; node; node = node.parentElement) {
        const role = node.getAttribute("role") ?? (node.tagName === "DIALOG" ? "dialog" : null);
        if (role && REGION_ROLES.has(role)) {
            const name = node.getAttribute("aria-label") ?? labelledBy(node);
            return clean(name ? `${role} "${name}"` : role, 60);
        }
        if (node.tagName.includes("-") && node.tagName !== "CHILI-EDITOR") return node.tagName.toLowerCase();
    }
    return undefined;
}

export function describeElement(element: Element): UiNode {
    const name = accessibleName(element);
    const text = clean(visibleText(element), 80);
    const node: UiNode = {
        ref: refOf(element),
        role: roleOf(element),
        name,
        tag: element.tagName.toLowerCase(),
    };
    if (text && text !== name) node.text = text;
    const value = fieldValue(element);
    if (value !== undefined && value !== "") node.value = value;
    const checked = checkedOf(element);
    if (checked !== undefined) node.checked = checked;
    const selected = element.getAttribute("aria-selected");
    if (selected !== null) node.selected = selected === "true";
    else if (element instanceof HTMLOptionElement) node.selected = element.selected;
    const expanded = element.getAttribute("aria-expanded");
    if (expanded !== null) node.expanded = expanded === "true";
    if (isDisabled(element)) node.disabled = true;
    if (element.ownerDocument.activeElement === element) node.focused = true;
    const command = element.getAttribute("data-command");
    if (command) node.command = command;
    const region = regionOf(element);
    if (region) node.in = region;
    return node;
}

export interface SnapshotOptions {
    /** Only elements whose name, text, value or command contains this (case-insensitive). */
    readonly query?: string;
    /** Only elements with this role. */
    readonly role?: string;
    readonly max?: number;
    /** Also list hidden elements. */
    readonly includeHidden?: boolean;
}

export interface UiSnapshot {
    nodes: UiNode[];
    total: number;
    truncated: boolean;
    dialogs: { ref: string; name: string }[];
    focused?: string;
}

export function snapshotUi(root: Element | Document, options: SnapshotOptions = {}): UiSnapshot {
    const max = Math.max(1, Math.min(options.max ?? 250, 2000));
    const query = options.query?.trim().toLowerCase();
    const nodes: UiNode[] = [];
    let total = 0;
    for (const element of allElements(root)) {
        if (!isInteractive(element)) continue;
        if (!options.includeHidden && !isVisible(element)) continue;
        if (options.role && roleOf(element) !== options.role) continue;
        const node = describeElement(element);
        if (query) {
            const haystack = [node.name, node.text, node.value, node.command]
                .filter(Boolean)
                .join(" ")
                .toLowerCase();
            if (!haystack.includes(query)) continue;
        }
        total++;
        if (nodes.length < max) nodes.push(node);
    }
    // nodeType, not instanceof: the global Document need not be the page document's class.
    const document =
        root.nodeType === Node.DOCUMENT_NODE ? (root as Document) : (root as Element).ownerDocument;
    const dialogs = openDialogs(document).map((dialog) => ({
        ref: refOf(dialog),
        name: clean(dialog.getAttribute("aria-label") ?? labelledBy(dialog) ?? visibleText(dialog), 80),
    }));
    const active = document.activeElement;
    return {
        nodes,
        total,
        truncated: total > nodes.length,
        dialogs,
        ...(active && active !== document.body ? { focused: refOf(active) } : {}),
    };
}

/** Open modal and non-modal dialogs, topmost (last in document order) last. */
export function openDialogs(document: Document): Element[] {
    return [...allElements(document)].filter(
        (element) =>
            ((element.tagName === "DIALOG" && (element as HTMLDialogElement).open) ||
                element.getAttribute("role") === "dialog" ||
                element.getAttribute("role") === "alertdialog") &&
            isVisible(element),
    );
}

export interface TargetSpec {
    readonly ref?: string;
    readonly selector?: string;
    readonly label?: string;
    readonly text?: string;
    readonly role?: string;
    /** Which match, 0-based, when several elements fit. */
    readonly index?: number;
}

export const TARGET_PROPERTIES = {
    ref: { type: "string", description: "Element ref from ui_snapshot (e.g. e12) — the most precise" },
    selector: { type: "string", description: "CSS selector" },
    label: { type: "string", description: "aria-label / title / accessible name, exact (case-insensitive)" },
    text: {
        type: "string",
        description: "Visible text or accessible name: exact match first, then contains (case-insensitive)",
    },
    role: {
        type: "string",
        description: "Narrow text/label matches to this role (button, tab, menuitem, …)",
    },
    index: { type: "number", description: "Which match (0-based) when several fit" },
} as const;

export function targetSpecOf(args: Record<string, unknown>): TargetSpec | undefined {
    const spec: TargetSpec = {
        ref: typeof args["ref"] === "string" ? args["ref"] : undefined,
        selector: typeof args["selector"] === "string" ? args["selector"] : undefined,
        label: typeof args["label"] === "string" ? args["label"] : undefined,
        text: typeof args["text"] === "string" ? args["text"] : undefined,
        role: typeof args["role"] === "string" ? args["role"] : undefined,
        index: typeof args["index"] === "number" ? args["index"] : undefined,
    };
    return spec.ref || spec.selector || spec.label || spec.text ? spec : undefined;
}

const normalized = (text: string) => text.replace(/\s+/g, " ").trim().toLowerCase();

/** The nearest interactive element at or above `element` (a label inside a button → the button). */
function interactiveAncestor(element: Element): Element {
    for (let node: Element | null = element; node; node = node.parentElement) {
        if (isInteractive(node)) return node;
    }
    return element;
}

function querySelectorDeep(root: Document, selector: string): Element[] {
    const found: Element[] = [...root.querySelectorAll(selector)];
    for (const element of allElements(root)) {
        if (element.shadowRoot) found.push(...element.shadowRoot.querySelectorAll(selector));
    }
    return found;
}

/**
 * The one element `spec` names, or the message saying why there is none — with the candidates
 * when several fit and no index picks one.
 */
export function findElement(spec: TargetSpec, document: Document = globalThis.document): Element | string {
    if (spec.ref) {
        return elementByRef(spec.ref) ?? `no element has ref ${spec.ref} any more — take a new ui_snapshot`;
    }
    let candidates: Element[];
    if (spec.selector) {
        try {
            candidates = querySelectorDeep(document, spec.selector).filter(isVisible);
        } catch {
            return `invalid CSS selector ${JSON.stringify(spec.selector)}`;
        }
        if (candidates.length === 0)
            return `nothing visible matches the selector ${JSON.stringify(spec.selector)}`;
    } else {
        const wanted = normalized(spec.label ?? spec.text ?? "");
        const exact: Element[] = [];
        const partial: Element[] = [];
        for (const element of allElements(document)) {
            // Interactive elements by their name, everything else only as a leaf's own text (a
            // container's text is all of its descendants' — and reading it is expensive).
            const interactive = isInteractive(element);
            const names = spec.label
                ? [
                      element.getAttribute("aria-label") ?? "",
                      element.getAttribute("title") ?? "",
                      interactive ? accessibleName(element) : "",
                  ]
                : interactive
                  ? [accessibleName(element)]
                  : element.childElementCount === 0
                    ? [element.textContent ?? ""]
                    : [];
            if (!names.some(Boolean) || !isVisible(element)) continue;
            const values = names.map(normalized).filter(Boolean);
            if (values.includes(wanted)) exact.push(element);
            else if (!spec.label && values.some((value) => value.includes(wanted))) partial.push(element);
        }
        // A text match on a leaf (the label inside a button) means its control; a label match
        // means the labelled element itself (a toolbar, a dialog).
        const lift = spec.label ? (element: Element) => element : interactiveAncestor;
        const unique = (list: Element[]) => [...new Set(list.map(lift))];
        const byRole = (list: Element[]) =>
            spec.role ? list.filter((element) => roleOf(element) === spec.role) : list;
        // Keep the innermost: a button whose text matches also has ancestors whose text matches.
        const innermost = (list: Element[]) =>
            list.filter((a) => !list.some((b) => b !== a && a.contains(b)));
        candidates = innermost(byRole(unique(exact)));
        if (candidates.length === 0) candidates = innermost(byRole(unique(partial)));
        if (candidates.length === 0) {
            return `no visible element is named ${JSON.stringify(spec.label ?? spec.text)}${spec.role ? ` with role ${spec.role}` : ""} — ui_snapshot lists what is there`;
        }
    }
    if (spec.index !== undefined) {
        return (
            candidates[spec.index] ??
            `only ${candidates.length} element(s) match; index ${spec.index} is out of range`
        );
    }
    if (candidates.length > 1) {
        const listed = candidates.slice(0, 8).map((element) => {
            const node = describeElement(element);
            return `${node.ref} ${node.role} "${node.name}"${node.in ? ` in ${node.in}` : ""}`;
        });
        return `${candidates.length} elements match — pass index or ref: ${listed.join("; ")}`;
    }
    return candidates[0];
}

/** Text and form values of a container (a dialog, a panel), capped. */
export function readElement(element: Element, maxText = 4000) {
    const text = clean(visibleText(element), maxText);
    const fields = [...allElements(element)]
        .filter(
            (node) =>
                (node instanceof HTMLInputElement && node.type !== "hidden") ||
                node instanceof HTMLSelectElement ||
                node instanceof HTMLTextAreaElement ||
                ((node as HTMLElement).isContentEditable &&
                    !(node.parentElement as HTMLElement | null)?.isContentEditable),
        )
        .filter(isVisible)
        .slice(0, 100)
        .map((node) => {
            const description = describeElement(node);
            const value =
                node instanceof HTMLInputElement && (node.type === "checkbox" || node.type === "radio")
                    ? node.checked
                    : node instanceof HTMLSelectElement
                      ? node.value
                      : (description.value ?? "");
            return { ref: description.ref, name: description.name, role: description.role, value };
        });
    return { ...describeElement(element), text, fields };
}
