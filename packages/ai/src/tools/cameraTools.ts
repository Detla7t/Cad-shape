// Part of the Chili3d Project, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

import { Config, type IView, type XYZLike } from "@chili3d/core";
import type { Tool, ToolResult } from "../llm/types";
import { DRIVE_APP_GROUP } from "./automationGroup";
import { getActiveView } from "./documentContext";
import { nearestStandardView } from "./standardViews";

/**
 * The camera, exactly: read it (eye, target, up, projection, field of view, visible height) and
 * set it to given values, or pan and zoom it by amounts. Standard views and orbiting are
 * `rotate_view`, fitting is `fit_content`, the projection toggle is `set_camera_type`.
 */

const text = (value: unknown): ToolResult => ({ content: JSON.stringify(value) });
const round = (value: number) => Math.round(value * 1e6) / 1e6;
const point = (p: XYZLike) => ({ x: round(p.x), y: round(p.y), z: round(p.z) });
const sub = (a: XYZLike, b: XYZLike) => ({ x: a.x - b.x, y: a.y - b.y, z: a.z - b.z });
const add = (a: XYZLike, b: XYZLike) => ({ x: a.x + b.x, y: a.y + b.y, z: a.z + b.z });
const scale = (a: XYZLike, k: number) => ({ x: a.x * k, y: a.y * k, z: a.z * k });
const dot = (a: XYZLike, b: XYZLike) => a.x * b.x + a.y * b.y + a.z * b.z;
const length = (a: XYZLike) => Math.hypot(a.x, a.y, a.z);
const unit = (a: XYZLike) => scale(a, 1 / (length(a) || 1));

function fieldOfView(): number {
    try {
        return Config.instance.graphics.fieldOfView;
    } catch {
        return 45;
    }
}

/** Visible height at the target: both projections frame `2·d·tan(fov/2)` (see the camera controller). */
const viewHeightAt = (distance: number) => 2 * distance * Math.tan((fieldOfView() * Math.PI) / 360);

export function cameraState(view: IView) {
    const camera = view.cameraController;
    const eye = camera.cameraPosition;
    const target = camera.cameraTarget;
    const offset = sub(eye, target);
    const distance = length(offset);
    return {
        eye: point(eye),
        target: point(target),
        up: point(camera.cameraUp ?? { x: 0, y: 0, z: 1 }),
        direction: point(unit(scale(offset, -1))),
        distance: round(distance),
        projection: camera.cameraType,
        fieldOfView: fieldOfView(),
        viewHeight: round(viewHeightAt(distance)),
        viewport: { width: view.width, height: view.height },
        standardView: nearestStandardView(offset),
    };
}

function getCameraTool(): Tool {
    return {
        name: "get_camera",
        description:
            "Read the viewport camera exactly: eye, target, up, viewing direction, distance, projection (perspective/orthographic), field of view (degrees), the world height visible at the target (the zoom), the viewport size in pixels, and the view cube orientation it matches, if any.",
        parameters: { type: "object", properties: {} },
        indexGroup: DRIVE_APP_GROUP,
        handler: async () => {
            const view = getActiveView();
            if (!view) return text({ error: "no active view" });
            return text(cameraState(view));
        },
    };
}

const XYZ_SCHEMA = {
    type: "object",
    properties: { x: { type: "number" }, y: { type: "number" }, z: { type: "number" } },
    required: ["x", "y", "z"],
};

function readXyz(value: unknown, name: string): XYZLike | string | undefined {
    if (value === undefined) return undefined;
    const p = value as Partial<XYZLike>;
    if (typeof value !== "object" || value === null || ![p.x, p.y, p.z].every(Number.isFinite)) {
        return `${name} must be { x, y, z } numbers`;
    }
    return { x: Number(p.x), y: Number(p.y), z: Number(p.z) };
}

/** An up vector perpendicular to the viewing direction; a parallel one is replaced. */
function orthogonalUp(up: XYZLike, forward: XYZLike): XYZLike {
    const f = unit(forward);
    let candidate = sub(up, scale(f, dot(up, f)));
    if (length(candidate) < 1e-9) {
        const fallback = Math.abs(f.z) < 0.9 ? { x: 0, y: 0, z: 1 } : { x: 0, y: 1, z: 0 };
        candidate = sub(fallback, scale(f, dot(fallback, f)));
    }
    return unit(candidate);
}

interface CameraArgs {
    eye?: XYZLike;
    target?: XYZLike;
    up?: XYZLike;
    direction?: XYZLike;
}

function readCameraArgs(args: Record<string, unknown>): CameraArgs | string {
    const result: CameraArgs = {};
    for (const name of ["eye", "target", "up", "direction"] as const) {
        const value = readXyz(args[name], name);
        if (typeof value === "string") return value;
        if (value !== undefined) result[name] = value;
    }
    if (result.direction && length(result.direction) < 1e-12) return "direction must not be zero";
    if (result.up && length(result.up) < 1e-12) return "up must not be zero";
    return result;
}

/** Where the eye goes: given, or along `direction`, or keeping the current offset from the target. */
function resolveEye(
    view: IView,
    a: CameraArgs,
    target: XYZLike,
    args: Record<string, unknown>,
): XYZLike | string {
    const camera = view.cameraController;
    const offset = a.eye
        ? sub(a.eye, target)
        : a.direction
          ? scale(unit(a.direction), -length(sub(camera.cameraPosition, camera.cameraTarget)))
          : sub(camera.cameraPosition, camera.cameraTarget);
    let distance = length(offset);
    if (args["distance"] !== undefined) distance = Number(args["distance"]);
    if (args["viewHeight"] !== undefined) {
        distance = Number(args["viewHeight"]) / (2 * Math.tan((fieldOfView() * Math.PI) / 360));
    }
    if (!Number.isFinite(distance) || distance <= 0) return "distance / viewHeight must be positive";
    if (length(offset) < 1e-12) return "eye and target must differ";
    return add(target, scale(unit(offset), distance));
}

function setCameraTool(): Tool {
    return {
        name: "set_camera",
        description:
            "Set the viewport camera to exact values. Any of: eye, target, up (world mm), direction (instead of eye: the viewing direction, keeping the distance), distance or viewHeight (the world height visible at the target — the zoom), projection. Omitted values keep their current state. Returns the camera as get_camera reads it.",
        parameters: {
            type: "object",
            properties: {
                eye: { ...XYZ_SCHEMA, description: "Camera position" },
                target: { ...XYZ_SCHEMA, description: "Point looked at (orbit center)" },
                up: { ...XYZ_SCHEMA, description: "Screen-up direction; made perpendicular to the view" },
                direction: { ...XYZ_SCHEMA, description: "Viewing direction (eye → target), instead of eye" },
                distance: { type: "number", description: "Eye-to-target distance" },
                viewHeight: { type: "number", description: "World height visible at the target" },
                projection: { type: "string", enum: ["perspective", "orthographic"] },
                animate: { type: "boolean", description: "Tween there instead of jumping (default false)" },
            },
        },
        indexGroup: DRIVE_APP_GROUP,
        handler: async (args) => {
            const view = getActiveView();
            if (!view) return text({ error: "no active view" });
            const parsed = readCameraArgs(args);
            if (typeof parsed === "string") return text({ error: parsed });
            const projection = args["projection"];
            if (projection !== undefined && projection !== "perspective" && projection !== "orthographic") {
                return text({ error: "projection must be perspective or orthographic" });
            }
            const camera = view.cameraController;
            const target = parsed.target ?? camera.cameraTarget;
            const eye = resolveEye(view, parsed, target, args);
            if (typeof eye === "string") return text({ error: eye });
            const up = orthogonalUp(parsed.up ?? camera.cameraUp ?? { x: 0, y: 0, z: 1 }, sub(target, eye));
            if (projection !== undefined) camera.cameraType = projection;
            if (args["animate"] === true) await camera.animateLookAt(eye, target, up);
            else camera.lookAt(eye, target, up);
            view.update();
            return text({ ok: true, ...cameraState(view) });
        },
    };
}

function panZoomTool(): Tool {
    return {
        name: "pan_zoom_view",
        description:
            "Pan and/or zoom the viewport camera by amounts. dx/dy pan exactly as a pan drag of the pointer by that many pixels does (dx right, dy down; the scene follows the pointer); zoom > 1 magnifies around the target by that factor (2 = twice as close), < 1 zooms out. For a zoom anchored at the cursor, send a wheel with view_pointer instead.",
        parameters: {
            type: "object",
            properties: {
                dx: { type: "number", description: "Pan drag to the right, in pixels" },
                dy: { type: "number", description: "Pan drag downwards, in pixels" },
                zoom: { type: "number", description: "Magnification factor (> 0)" },
            },
        },
        indexGroup: DRIVE_APP_GROUP,
        handler: async (args) => {
            const view = getActiveView();
            if (!view) return text({ error: "no active view" });
            const camera = view.cameraController;
            const dx = Number(args["dx"] ?? 0);
            const dy = Number(args["dy"] ?? 0);
            const zoom = args["zoom"] === undefined ? undefined : Number(args["zoom"]);
            if (!Number.isFinite(dx) || !Number.isFinite(dy))
                return text({ error: "dx and dy must be numbers" });
            if (zoom !== undefined && !(Number.isFinite(zoom) && zoom > 0)) {
                return text({ error: "zoom must be a positive number" });
            }
            if (dx === 0 && dy === 0 && zoom === undefined)
                return text({ error: "provide dx/dy and/or zoom" });
            // The viewport's pan drag calls this with the pointer's movement.
            if (dx !== 0 || dy !== 0) camera.pan(dx, dy);
            if (zoom !== undefined) {
                const target = camera.cameraTarget;
                const offset = sub(camera.cameraPosition, target);
                camera.lookAt(
                    add(target, scale(offset, 1 / zoom)),
                    target,
                    camera.cameraUp ?? { x: 0, y: 0, z: 1 },
                );
            }
            view.update();
            return text({ ok: true, ...cameraState(view) });
        },
    };
}

export function buildCameraTools(): Tool[] {
    return [getCameraTool(), setCameraTool(), panZoomTool()];
}
