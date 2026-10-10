// Part of the Chili3d Project, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

import {
    elementAt,
    nextFrame,
    type PointerOptions,
    parseButton,
    parseModifiers,
    pointerClick,
    pressKey,
    setNativeValue,
} from "../automation/domInput";
import {
    allElements,
    describeElement,
    findElement,
    isVisible,
    openDialogs,
    readElement,
    roleOf,
    snapshotUi,
    TARGET_PROPERTIES,
    targetSpecOf,
} from "../automation/uiElements";
import type { Tool, ToolResult } from "../llm/types";
import { DRIVE_APP_GROUP } from "./automationGroup";
import { commandState } from "./commandTools";
import { getApplication } from "./documentContext";

/**
 * Every panel the user can use, reachable the same way: a compact snapshot of the interactive
 * UI with stable refs, and clicks, focus, typing, option picks and reads aimed by ref, CSS
 * selector, aria-label or visible text. Input is dispatched as real DOM events.
 */

const text = (value: unknown): ToolResult => ({ content: JSON.stringify(value) });

function resolveTarget(args: Record<string, unknown>): Element | string {
    const spec = targetSpecOf(args);
    if (!spec) return "name the element: ref (from ui_snapshot), selector, label or text";
    return findElement(spec);
}

/** The element's center in client coordinates, scrolled into view first. */
function centerOf(element: Element) {
    (element as HTMLElement).scrollIntoView?.({ block: "nearest", inline: "nearest" });
    const rect = element.getBoundingClientRect();
    return { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 };
}

function snapshotTool(): Tool {
    return {
        name: "ui_snapshot",
        description:
            "List the visible interactive UI: each element's ref (stable while it exists), role, accessible name, text, value, checked/selected/expanded/disabled state, command id for ribbon buttons, and the container it sits in; plus open dialogs and the focused element. query and role filter; within limits it to one container (ref/selector/label/text). Capped at max entries.",
        parameters: {
            type: "object",
            properties: {
                query: {
                    type: "string",
                    description: "Only entries whose name/text/value/command contains this",
                },
                role: {
                    type: "string",
                    description: "Only entries with this role (button, tab, textbox, …)",
                },
                max: { type: "number", description: "Most entries to return (default 250)" },
                within: {
                    type: "object",
                    description: "Only inside this container: { ref | selector | label | text }",
                    properties: TARGET_PROPERTIES,
                },
                includeHidden: { type: "boolean", description: "Also list hidden elements" },
            },
        },
        indexGroup: DRIVE_APP_GROUP,
        handler: async (args) => {
            let root: Element | Document = document;
            if (args["within"] !== undefined) {
                const spec = targetSpecOf((args["within"] ?? {}) as Record<string, unknown>);
                if (!spec) return text({ error: "within needs ref, selector, label or text" });
                const found = findElement(spec);
                if (typeof found === "string") return text({ error: found });
                root = found;
            }
            const snapshot = snapshotUi(root, {
                query: typeof args["query"] === "string" ? args["query"] : undefined,
                role: typeof args["role"] === "string" ? args["role"] : undefined,
                max: Number(args["max"]) || undefined,
                includeHidden: args["includeHidden"] === true,
            });
            return text(snapshot);
        },
    };
}

function clickTool(): Tool {
    return {
        name: "ui_click",
        description:
            "Click a UI element the way the mouse does (pointer down/up, click; double:true double-clicks; button right opens context menus) at its center, after scrolling it into view. Aim with ref (from ui_snapshot), selector, label or visible text; several matches are an error listing them unless index picks one.",
        parameters: {
            type: "object",
            properties: {
                ...TARGET_PROPERTIES,
                double: { type: "boolean", description: "Double-click" },
                button: { type: "string", enum: ["left", "middle", "right"] },
                modifiers: {
                    type: "array",
                    items: { type: "string", enum: ["shift", "ctrl", "alt", "meta"] },
                },
            },
        },
        indexGroup: DRIVE_APP_GROUP,
        handler: async (args) => {
            const element = resolveTarget(args);
            if (typeof element === "string") return text({ error: element });
            const button = parseButton(args["button"]);
            if (!["left", "middle", "right"].includes(button)) return text({ error: button });
            const modifiers = parseModifiers(args["modifiers"]);
            if (typeof modifiers === "string") return text({ error: modifiers });
            const options = { button, modifiers } as PointerOptions;
            const described = describeElement(element);
            if (described.disabled)
                return text({ error: `${described.role} "${described.name}" is disabled` });
            const center = centerOf(element);
            // A real click lands on whatever is on top; another element covering it is reported.
            const hit = elementAt(document.documentElement, center.x, center.y);
            const target = hit !== document.documentElement && element.contains(hit) ? hit : element;
            const covered =
                hit !== document.documentElement && !element.contains(hit) && !hit.contains(element);
            pointerClick(target, center.x, center.y, options, args["double"] === true ? 2 : 1);
            await nextFrame();
            return text({
                ok: true,
                clicked: described,
                ...(covered ? { coveredBy: describeElement(hit) } : {}),
                command: commandState(getApplication()),
            });
        },
    };
}

function focusTool(): Tool {
    return {
        name: "ui_focus",
        description:
            "Move keyboard focus to a UI element (ref, selector, label or text), as tabbing to it would.",
        parameters: { type: "object", properties: { ...TARGET_PROPERTIES } },
        indexGroup: DRIVE_APP_GROUP,
        handler: async (args) => {
            const element = resolveTarget(args);
            if (typeof element === "string") return text({ error: element });
            (element as HTMLElement).focus?.();
            element.dispatchEvent(new FocusEvent("focusin", { bubbles: true }));
            await nextFrame();
            return text({ ok: document.activeElement === element, focused: describeElement(element) });
        },
    };
}

function typeTool(): Tool {
    return {
        name: "ui_type",
        description:
            'Type text into a field (input, textarea, contenteditable, code editor): focuses it, replaces its content (append:true keeps it), fires input and change like typing and leaving the field do; submit:true then presses Enter. Expressions and units are typed as the user would ("25 mm", "#width * 2").',
        parameters: {
            type: "object",
            properties: {
                ...TARGET_PROPERTIES,
                value: { type: "string", description: "The text to type" },
                append: { type: "boolean", description: "Keep the current content and add to it" },
                submit: { type: "boolean", description: "Press Enter afterwards" },
            },
            required: ["value"],
        },
        indexGroup: DRIVE_APP_GROUP,
        handler: async (args) => {
            const spec = targetSpecOf(args);
            const element = spec ? findElement(spec) : (document.activeElement ?? "nothing has focus");
            if (typeof element === "string") return text({ error: element });
            const value = String(args["value"] ?? "");
            const append = args["append"] === true;
            const html = element as HTMLElement;
            html.focus?.();
            if (element instanceof HTMLInputElement || element instanceof HTMLTextAreaElement) {
                setNativeValue(element, append ? element.value + value : value);
                element.dispatchEvent(
                    new InputEvent("input", { bubbles: true, data: value, inputType: "insertText" }),
                );
                element.dispatchEvent(new Event("change", { bubbles: true }));
            } else if (html.isContentEditable) {
                const selection = document.getSelection();
                if (!append && selection) {
                    selection.selectAllChildren(html);
                } else if (selection) {
                    selection.selectAllChildren(html);
                    selection.collapseToEnd();
                }
                // The editing command takes the browser's own path (beforeinput/input), which
                // rich editors such as CodeMirror listen to.
                const inserted =
                    typeof document.execCommand === "function" &&
                    document.execCommand("insertText", false, value);
                if (!inserted) {
                    html.textContent = append ? `${html.textContent ?? ""}${value}` : value;
                    html.dispatchEvent(
                        new InputEvent("input", { bubbles: true, data: value, inputType: "insertText" }),
                    );
                }
            } else {
                return text({
                    error: `${roleOf(element)} "${describeElement(element).name}" is not a text field`,
                });
            }
            if (args["submit"] === true) pressKey(element, "Enter");
            await nextFrame();
            return text({
                ok: true,
                field: describeElement(element),
                command: commandState(getApplication()),
            });
        },
    };
}

function optionCandidates(): Element[] {
    return [...allElements(document)].filter(
        (element) =>
            ["option", "menuitem", "menuitemradio", "menuitemcheckbox", "treeitem"].includes(
                roleOf(element),
            ) && isVisible(element),
    );
}

function selectTool(): Tool {
    return {
        name: "ui_select",
        description:
            "Pick an option: in a <select> by its value or visible label (fires input/change like the user's pick); for a custom dropdown or menu, clicks it open and then clicks the option whose text matches.",
        parameters: {
            type: "object",
            properties: {
                ...TARGET_PROPERTIES,
                option: { type: "string", description: "Option value or visible label" },
            },
            required: ["option"],
        },
        indexGroup: DRIVE_APP_GROUP,
        handler: async (args) => {
            const element = resolveTarget(args);
            if (typeof element === "string") return text({ error: element });
            const wanted = String(args["option"] ?? "");
            const lower = wanted.trim().toLowerCase();
            if (element instanceof HTMLSelectElement) {
                const options = [...element.options];
                const option =
                    options.find((o) => o.value === wanted) ??
                    options.find((o) => (o.textContent ?? "").trim().toLowerCase() === lower);
                if (!option) {
                    return text({
                        error: `no option "${wanted}"`,
                        options: options.map((o) => ({
                            value: o.value,
                            label: (o.textContent ?? "").trim(),
                        })),
                    });
                }
                element.focus();
                setNativeValue(element, option.value);
                element.dispatchEvent(new Event("input", { bubbles: true }));
                element.dispatchEvent(new Event("change", { bubbles: true }));
                await nextFrame();
                return text({
                    ok: true,
                    selected: { value: option.value, label: (option.textContent ?? "").trim() },
                });
            }
            const before = new Set(optionCandidates());
            const center = centerOf(element);
            pointerClick(element, center.x, center.y, {}, 1);
            await nextFrame();
            const options = optionCandidates();
            const match =
                options.find((o) => describeElement(o).name.toLowerCase() === lower && !before.has(o)) ??
                options.find((o) => describeElement(o).name.toLowerCase() === lower) ??
                options.find((o) => describeElement(o).name.toLowerCase().includes(lower));
            if (!match) {
                return text({
                    error: `no visible option "${wanted}" after opening it`,
                    options: options.slice(0, 30).map((o) => describeElement(o).name),
                });
            }
            const at = centerOf(match);
            pointerClick(match, at.x, at.y, {}, 1);
            await nextFrame();
            return text({ ok: true, selected: describeElement(match) });
        },
    };
}

function readTool(): Tool {
    return {
        name: "ui_read",
        description:
            "Read the text and field values of a panel, dialog, toast or any element (ref, selector, label or text); without a target, the topmost open dialog, or else the whole page (capped). Fields come with their refs for ui_type/ui_click.",
        parameters: {
            type: "object",
            properties: {
                ...TARGET_PROPERTIES,
                maxText: { type: "number", description: "Longest text to return (default 4000)" },
            },
        },
        indexGroup: DRIVE_APP_GROUP,
        handler: async (args) => {
            const spec = targetSpecOf(args);
            let element: Element | string;
            if (spec) element = findElement(spec);
            else element = openDialogs(document).at(-1) ?? document.body;
            if (typeof element === "string") return text({ error: element });
            return text(readElement(element, Math.max(100, Number(args["maxText"]) || 4000)));
        },
    };
}

export function buildUiTools(): Tool[] {
    return [snapshotTool(), clickTool(), focusTool(), typeTool(), selectTool(), readTool()];
}
