// Part of the Chili3d Project, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

/**
 * Synthetic input that takes the same DOM path as the user's own: pointer, mouse, wheel and
 * keyboard events dispatched on the element under the point (or the focused element), bubbling
 * through the same listeners — the viewport's handlers, snapping, previews, gizmos, the sketch
 * editor, the hotkey service on `window`. Used by the viewport input tools and the generic UI
 * tools alike, so a click is one thing wherever it lands.
 */

export type PointerButton = "left" | "middle" | "right";
export type Modifier = "shift" | "ctrl" | "alt" | "meta";

export interface PointerOptions {
    readonly button?: PointerButton;
    readonly modifiers?: readonly Modifier[];
}

const BUTTON_INDEX: Record<PointerButton, number> = { left: 0, middle: 1, right: 2 };
const BUTTON_MASK: Record<PointerButton, number> = { left: 1, middle: 4, right: 2 };
const MODIFIERS: readonly Modifier[] = ["shift", "ctrl", "alt", "meta"];
const POINTER_ID = 1;

/** Buttons held between a `down` and its `up`, so moves in between report them like a drag. */
let pressed = 0;

export function resetPointerState(): void {
    pressed = 0;
}

/** The modifiers argument of a tool, or the message saying why it is not one. */
export function parseModifiers(value: unknown): Modifier[] | string {
    if (value === undefined) return [];
    const list = Array.isArray(value) ? value : String(value).split("+");
    const result: Modifier[] = [];
    for (const item of list) {
        const name = String(item).trim().toLowerCase();
        const modifier = name === "control" ? "ctrl" : name === "cmd" || name === "meta" ? "meta" : name;
        if (!MODIFIERS.includes(modifier as Modifier)) {
            return `unknown modifier "${item}", expected ${MODIFIERS.join("|")}`;
        }
        result.push(modifier as Modifier);
    }
    return result;
}

export function parseButton(value: unknown): PointerButton | string {
    if (value === undefined) return "left";
    const name = String(value).toLowerCase();
    return name in BUTTON_INDEX
        ? (name as PointerButton)
        : `unknown button "${value}", expected left|middle|right`;
}

function modifierInit(modifiers: readonly Modifier[] = []) {
    return {
        shiftKey: modifiers.includes("shift"),
        ctrlKey: modifiers.includes("ctrl"),
        altKey: modifiers.includes("alt"),
        metaKey: modifiers.includes("meta"),
    };
}

/** The element a real pointer at (clientX, clientY) would hit, kept inside `root`. */
export function elementAt(root: Element, clientX: number, clientY: number): Element {
    const hit = root.ownerDocument.elementFromPoint?.(clientX, clientY);
    return hit && (hit === root || root.contains(hit)) ? hit : root;
}

type PointerType =
    | "pointermove"
    | "pointerdown"
    | "pointerup"
    | "mousemove"
    | "mousedown"
    | "mouseup"
    | "click"
    | "dblclick"
    | "contextmenu"
    | "auxclick";

function fire(
    target: Element,
    type: PointerType,
    clientX: number,
    clientY: number,
    options: PointerOptions,
    detail = 0,
): boolean {
    const button = options.button ?? "left";
    const moving = type === "pointermove" || type === "mousemove";
    const init: PointerEventInit = {
        bubbles: true,
        cancelable: true,
        composed: true,
        clientX,
        clientY,
        screenX: clientX,
        screenY: clientY,
        button: moving ? (type === "pointermove" ? -1 : 0) : BUTTON_INDEX[button],
        buttons: pressed,
        detail,
        view: target.ownerDocument.defaultView,
        ...modifierInit(options.modifiers),
    };
    const isPointer = type.startsWith("pointer");
    const event =
        isPointer && typeof PointerEvent === "function"
            ? new PointerEvent(type, {
                  ...init,
                  pointerId: POINTER_ID,
                  pointerType: "mouse",
                  isPrimary: true,
              })
            : new MouseEvent(type, init);
    if (isPointer && typeof PointerEvent !== "function") {
        // Environments without PointerEvent still get the fields pointer handlers read.
        Object.defineProperties(event, {
            pointerId: { value: POINTER_ID },
            pointerType: { value: "mouse" },
            isPrimary: { value: true },
        });
    }
    return target.dispatchEvent(event);
}

/** Moves the pointer to the point: `pointermove` + `mousemove` on what is under it. */
export function pointerMove(target: Element, clientX: number, clientY: number, options: PointerOptions = {}) {
    fire(target, "pointermove", clientX, clientY, options);
    fire(target, "mousemove", clientX, clientY, options);
}

export function pointerDown(
    target: Element,
    clientX: number,
    clientY: number,
    options: PointerOptions = {},
    detail = 1,
) {
    pressed |= BUTTON_MASK[options.button ?? "left"];
    const proceed = fire(target, "pointerdown", clientX, clientY, options, detail);
    // A cancelled pointerdown suppresses the compatibility mouse events, as in browsers.
    if (proceed) fire(target, "mousedown", clientX, clientY, options, detail);
}

export function pointerUp(
    target: Element,
    clientX: number,
    clientY: number,
    options: PointerOptions = {},
    detail = 1,
) {
    pressed &= ~BUTTON_MASK[options.button ?? "left"];
    fire(target, "pointerup", clientX, clientY, options, detail);
    fire(target, "mouseup", clientX, clientY, options, detail);
}

/**
 * A full click (or double click with `count` 2) the way a browser fires it: down, up, then
 * `click` for the left button, `contextmenu` for the right, `auxclick` for the middle; a second
 * click is followed by `dblclick`.
 */
export function pointerClick(
    target: Element,
    clientX: number,
    clientY: number,
    options: PointerOptions = {},
    count = 1,
) {
    const button = options.button ?? "left";
    pointerMove(target, clientX, clientY, options);
    for (let i = 1; i <= count; i++) {
        pointerDown(target, clientX, clientY, options, i);
        pointerUp(target, clientX, clientY, options, i);
        if (button === "left") fire(target, "click", clientX, clientY, options, i);
        else if (button === "right") fire(target, "contextmenu", clientX, clientY, options, i);
        else fire(target, "auxclick", clientX, clientY, options, i);
    }
    if (count >= 2 && button === "left") fire(target, "dblclick", clientX, clientY, options, 2);
}

export function wheel(
    target: Element,
    clientX: number,
    clientY: number,
    deltaX: number,
    deltaY: number,
    options: PointerOptions = {},
) {
    const init: WheelEventInit = {
        bubbles: true,
        cancelable: true,
        composed: true,
        clientX,
        clientY,
        screenX: clientX,
        screenY: clientY,
        deltaX,
        deltaY,
        deltaMode: 0,
        buttons: pressed,
        view: target.ownerDocument.defaultView,
        ...modifierInit(options.modifiers),
    };
    target.dispatchEvent(new WheelEvent("wheel", init));
}

export interface KeyOptions {
    readonly code?: string;
    readonly modifiers?: readonly Modifier[];
}

/** "Ctrl+Shift+Z" → key "Z" with ctrl and shift; a bare "+" stays a key. */
export function parseKeyCombo(combo: string): { key: string; modifiers: Modifier[] } | string {
    if (combo.length === 1) return { key: combo, modifiers: [] };
    const parts = combo.split("+");
    const key = parts.pop() || "+";
    const modifiers = parseModifiers(parts.filter((part) => part !== ""));
    if (typeof modifiers === "string") return modifiers;
    return { key: KEY_ALIASES[key.toLowerCase()] ?? key, modifiers };
}

const KEY_ALIASES: Record<string, string> = {
    esc: "Escape",
    escape: "Escape",
    enter: "Enter",
    return: "Enter",
    tab: "Tab",
    space: " ",
    del: "Delete",
    delete: "Delete",
    backspace: "Backspace",
    up: "ArrowUp",
    down: "ArrowDown",
    left: "ArrowLeft",
    right: "ArrowRight",
    home: "Home",
    end: "End",
    pageup: "PageUp",
    pagedown: "PageDown",
};

/** The `code` a US keyboard reports for `key` — handlers that read `code` see a plausible one. */
function codeOf(key: string): string {
    if (/^[a-z]$/i.test(key)) return `Key${key.toUpperCase()}`;
    if (/^[0-9]$/.test(key)) return `Digit${key}`;
    if (key === " ") return "Space";
    return key;
}

function isTextField(element: Element): element is HTMLInputElement | HTMLTextAreaElement {
    if (element instanceof HTMLTextAreaElement) return true;
    return (
        element instanceof HTMLInputElement &&
        !["checkbox", "radio", "button", "submit", "reset", "file", "range", "color"].includes(element.type)
    );
}

/** Writes `value` through the native setter, so React-controlled inputs see the change. */
export function setNativeValue(
    element: HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement,
    value: string,
) {
    const prototype = Object.getPrototypeOf(element) as object;
    const setter = Object.getOwnPropertyDescriptor(prototype, "value")?.set;
    if (setter) setter.call(element, value);
    else element.value = value;
}

/**
 * Presses a key on `target`: keydown, the default action a browser would take for a printable
 * key in a text field (insert the character, fire `input`), keyup. Returns whether keydown was
 * not cancelled.
 */
export function pressKey(target: Element, key: string, options: KeyOptions = {}): boolean {
    const init: KeyboardEventInit = {
        key,
        code: options.code ?? codeOf(key),
        bubbles: true,
        cancelable: true,
        composed: true,
        view: target.ownerDocument.defaultView,
        ...modifierInit(options.modifiers),
    };
    const proceed = target.dispatchEvent(new KeyboardEvent("keydown", init));
    const plain = !init.ctrlKey && !init.metaKey && !init.altKey;
    if (proceed && plain && key.length === 1 && isTextField(target)) {
        const start = target.selectionStart ?? target.value.length;
        const end = target.selectionEnd ?? target.value.length;
        setNativeValue(target, `${target.value.slice(0, start)}${key}${target.value.slice(end)}`);
        target.setSelectionRange?.(start + 1, start + 1);
        target.dispatchEvent(new InputEvent("input", { bubbles: true, data: key, inputType: "insertText" }));
    } else if (proceed && plain && key === "Backspace" && isTextField(target)) {
        const start = target.selectionStart ?? target.value.length;
        const end = target.selectionEnd ?? target.value.length;
        const from = start === end ? Math.max(0, start - 1) : start;
        setNativeValue(target, `${target.value.slice(0, from)}${target.value.slice(end)}`);
        target.setSelectionRange?.(from, from);
        target.dispatchEvent(new InputEvent("input", { bubbles: true, inputType: "deleteContentBackward" }));
    }
    target.dispatchEvent(new KeyboardEvent("keyup", init));
    return proceed;
}

/** Points `count` evenly spaced from a to b, b included, a excluded. */
export function interpolate(
    a: { x: number; y: number },
    b: { x: number; y: number },
    count: number,
): { x: number; y: number }[] {
    const points: { x: number; y: number }[] = [];
    for (let i = 1; i <= count; i++) {
        const t = i / count;
        points.push({ x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t });
    }
    return points;
}

/** One frame (or a macrotask where frames do not run), so handlers and renders settle. */
export function nextFrame(): Promise<void> {
    return new Promise((resolve) => {
        let done = false;
        const finish = () => {
            if (done) return;
            done = true;
            resolve();
        };
        if (typeof requestAnimationFrame === "function") requestAnimationFrame(() => finish());
        // Hidden tabs and test environments do not run frames.
        setTimeout(finish, 50);
    });
}
