// Part of the Chili3d Project, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

import { type IView, XYZ } from "@chili3d/core";
import {
    elementAt,
    interpolate,
    type Modifier,
    nextFrame,
    type PointerButton,
    type PointerOptions,
    parseButton,
    parseKeyCombo,
    parseModifiers,
    pointerClick,
    pointerDown,
    pointerMove,
    pointerUp,
    pressKey,
    wheel,
} from "../automation/domInput";
import { findElement, TARGET_PROPERTIES, targetSpecOf } from "../automation/uiElements";
import type { Tool, ToolResult } from "../llm/types";
import { DRIVE_APP_GROUP } from "./automationGroup";
import { commandState } from "./commandTools";
import { getActiveView, getApplication } from "./documentContext";
import { imageResult } from "./viewTools";

/**
 * Pointer and keyboard input into the viewport, dispatched as DOM events on the element under
 * the point — the same path a real mouse takes, so snapping, previews, gizmos, picking and the
 * sketch editor all react as they do for the user.
 */

const text = (value: unknown): ToolResult => ({ content: JSON.stringify(value) });

interface ViewPoint {
    x: number;
    y: number;
}

const POINT_SCHEMA = {
    type: "object",
    description:
        "{ x, y } in view pixels (0,0 = top left), or { point: { x, y, z } } a world point (mm) projected",
    properties: {
        x: { type: "number" },
        y: { type: "number" },
        point: {
            type: "object",
            properties: { x: { type: "number" }, y: { type: "number" }, z: { type: "number" } },
        },
    },
};

/** A tool's point argument in view pixels: pixels as given, normalized [0,1], or a world point projected. */
function resolvePoint(view: IView, value: unknown, normalized: boolean): ViewPoint | string {
    const raw = value as { x?: unknown; y?: unknown; point?: { x?: unknown; y?: unknown; z?: unknown } };
    if (typeof value !== "object" || value === null)
        return "expected a point { x, y } or { point: { x, y, z } }";
    if (raw.point !== undefined) {
        const p = raw.point;
        if (![p?.x, p?.y, p?.z].every((v) => Number.isFinite(Number(v))))
            return "point needs numeric x, y, z";
        const screen = view.worldToScreen(new XYZ({ x: Number(p.x), y: Number(p.y), z: Number(p.z) }));
        return { x: screen.x, y: screen.y };
    }
    const x = Number(raw.x);
    const y = Number(raw.y);
    if (!Number.isFinite(x) || !Number.isFinite(y)) return "x and y must be numbers";
    return normalized ? { x: x * view.width, y: y * view.height } : { x, y };
}

/** View pixels → client coordinates and the element a real pointer there would hit. */
function locate(view: IView, point: ViewPoint) {
    const dom = view.dom!;
    const rect = dom.getBoundingClientRect();
    const clientX = rect.left + point.x;
    const clientY = rect.top + point.y;
    const fallback = dom.querySelector("canvas") ?? dom;
    const target = elementAt(dom, clientX, clientY);
    return { clientX, clientY, target: target === dom ? fallback : target };
}

const describeTarget = (element: Element) =>
    `${element.tagName.toLowerCase()}${element.id ? `#${element.id}` : ""}${
        typeof element.className === "string" && element.className
            ? `.${element.className.split(" ")[0]}`
            : ""
    }`;

const ACTIONS = ["move", "down", "up", "click", "double_click", "drag", "wheel"] as const;
type Action = (typeof ACTIONS)[number];

function viewPointerTool(): Tool {
    return {
        name: "view_pointer",
        description:
            "Send pointer input to the viewport through the real DOM event path, as the user's mouse would: move (hover/preview/snap), down, up, click, double_click, drag (down, moves along path, up) or wheel (zoom at the point). Coordinates are view pixels (0,0 top left; see get_camera viewport) — or normalized 0..1 with normalized:true, or a world point { point: { x, y, z } } projected through the camera. Use it to answer a command's picks, drag gizmos, sketch, orbit (drag with the orbit button) and box-select. Returns where it landed and the running command's state; screenshot:true adds an image.",
        parameters: {
            type: "object",
            properties: {
                action: { type: "string", enum: [...ACTIONS] },
                x: { type: "number", description: "View pixel x (or 0..1 with normalized)" },
                y: { type: "number", description: "View pixel y (or 0..1 with normalized)" },
                point: { ...POINT_SCHEMA.properties.point, description: "World point (mm) instead of x/y" },
                path: {
                    type: "array",
                    items: POINT_SCHEMA,
                    description: "drag: the points to pass through, start first (at least 2)",
                },
                steps: { type: "number", description: "drag: moves between two path points (default 8)" },
                normalized: { type: "boolean", description: "x/y (and path x/y) are 0..1 of the view" },
                button: { type: "string", enum: ["left", "middle", "right"], description: "Default left" },
                modifiers: {
                    type: "array",
                    items: { type: "string", enum: ["shift", "ctrl", "alt", "meta"] },
                },
                deltaY: {
                    type: "number",
                    description: "wheel: vertical delta (negative zooms in, default -100)",
                },
                deltaX: { type: "number", description: "wheel: horizontal delta" },
                screenshot: { type: "boolean", description: "Also return a viewport image afterwards" },
            },
            required: ["action"],
        },
        indexGroup: DRIVE_APP_GROUP,
        handler: viewPointerHandler,
    };
}

const viewPointerHandler: Tool["handler"] = async (args) => {
    const view = getActiveView();
    if (!view?.dom) return text({ error: "no active viewport — pointer input needs a visible view" });
    const action = args["action"] as Action;
    if (!ACTIONS.includes(action)) return text({ error: `action must be one of ${ACTIONS.join("|")}` });
    const button = parseButton(args["button"]);
    if (!["left", "middle", "right"].includes(button)) return text({ error: button });
    const modifiers = parseModifiers(args["modifiers"]);
    if (typeof modifiers === "string") return text({ error: modifiers });
    const options: PointerOptions = { button: button as PointerButton, modifiers: modifiers as Modifier[] };
    const normalized = args["normalized"] === true;

    let points: ViewPoint[];
    if (action === "drag") {
        const path = args["path"];
        if (!Array.isArray(path) || path.length < 2)
            return text({ error: "drag needs a path of at least 2 points" });
        const resolved = path.map((p) => resolvePoint(view, p, normalized));
        const bad = resolved.find((p) => typeof p === "string");
        if (bad) return text({ error: bad });
        points = resolved as ViewPoint[];
    } else {
        const point = resolvePoint(
            view,
            args["point"] !== undefined ? { point: args["point"] } : args,
            normalized,
        );
        if (typeof point === "string") return text({ error: point });
        points = [point];
    }

    const first = locate(view, points[0]);
    switch (action) {
        case "move":
            pointerMove(first.target, first.clientX, first.clientY, options);
            break;
        case "down":
            pointerMove(first.target, first.clientX, first.clientY, options);
            pointerDown(first.target, first.clientX, first.clientY, options);
            break;
        case "up":
            pointerUp(first.target, first.clientX, first.clientY, options);
            break;
        case "click":
            pointerClick(first.target, first.clientX, first.clientY, options, 1);
            break;
        case "double_click":
            pointerClick(first.target, first.clientX, first.clientY, options, 2);
            break;
        case "wheel":
            pointerMove(first.target, first.clientX, first.clientY, options);
            wheel(
                first.target,
                first.clientX,
                first.clientY,
                Number(args["deltaX"] ?? 0),
                Number(args["deltaY"] ?? -100),
                options,
            );
            break;
        case "drag": {
            const steps = Math.max(1, Math.min(200, Math.round(Number(args["steps"] ?? 8))));
            pointerMove(first.target, first.clientX, first.clientY, options);
            pointerDown(first.target, first.clientX, first.clientY, options);
            // Pointer capture keeps a real drag on the element it started on.
            const captured = first.target;
            let last = points[0];
            for (const next of points.slice(1)) {
                for (const p of interpolate(last, next, steps)) {
                    const at = locate(view, p);
                    pointerMove(captured, at.clientX, at.clientY, options);
                }
                last = next;
            }
            const end = locate(view, last);
            pointerUp(captured, end.clientX, end.clientY, options);
            break;
        }
    }
    await nextFrame();
    const end = points[points.length - 1];
    const payload = {
        ok: true,
        action,
        pixel: { x: Math.round(end.x * 10) / 10, y: Math.round(end.y * 10) / 10 },
        target: describeTarget(first.target),
        command: commandState(getApplication()),
    };
    return args["screenshot"] === true ? imageResult(view, payload) : text(payload);
};

function pressKeyTool(): Tool {
    return {
        name: "press_key",
        description:
            'Press a key or hotkey like the keyboard does: keydown (and the character typed into a focused text field), keyup. key is a key name ("Escape", "Enter", "Delete", "a") or a combo ("Ctrl+Z", "Shift+Tab"). It goes to the element given by ref/selector/label/text (focused first), to the viewport with target:"view", or to whatever has focus — hotkeys reach the app from any of them.',
        parameters: {
            type: "object",
            properties: {
                key: { type: "string", description: 'Key or combo, e.g. "Escape", "Ctrl+Shift+Z", "l"' },
                modifiers: {
                    type: "array",
                    items: { type: "string", enum: ["shift", "ctrl", "alt", "meta"] },
                },
                repeat: { type: "number", description: "Press it this many times (default 1)" },
                target: { type: "string", enum: ["focused", "view"], description: "Default focused" },
                ...TARGET_PROPERTIES,
            },
            required: ["key"],
        },
        indexGroup: DRIVE_APP_GROUP,
        handler: async (args) => {
            const combo = parseKeyCombo(String(args["key"] ?? ""));
            if (typeof combo === "string") return text({ error: combo });
            if (combo.key === "") return text({ error: "key is required" });
            const extra = parseModifiers(args["modifiers"]);
            if (typeof extra === "string") return text({ error: extra });
            let target: Element;
            const spec = targetSpecOf(args);
            if (spec) {
                const found = findElement(spec);
                if (typeof found === "string") return text({ error: found });
                (found as HTMLElement).focus?.();
                target = found;
            } else if (args["target"] === "view") {
                const view = getActiveView();
                if (!view?.dom) return text({ error: "no active viewport" });
                target = view.dom;
            } else {
                target = document.activeElement ?? document.body;
            }
            const repeat = Math.max(1, Math.min(100, Math.round(Number(args["repeat"] ?? 1))));
            let handled = 0;
            for (let i = 0; i < repeat; i++) {
                const proceed = pressKey(target, combo.key, { modifiers: [...combo.modifiers, ...extra] });
                if (!proceed) handled++;
            }
            await nextFrame();
            return text({
                ok: true,
                key: combo.key,
                modifiers: [...combo.modifiers, ...extra],
                target: describeTarget(target),
                // A handler that took the key cancels its default (hotkeys, the viewport's tools).
                handledByApp: handled > 0,
                command: commandState(getApplication()),
            });
        },
    };
}

export function buildInputTools(): Tool[] {
    return [viewPointerTool(), pressKeyTool()];
}
