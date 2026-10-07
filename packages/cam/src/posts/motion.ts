// Part of the Chili3d Project, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

import type { CamProgram, PostProcessor } from "../model/post";
import type { ToolData } from "../model/tool";
import type { ToolpathMove, Vec3 } from "../model/toolpath";

/**
 * Toolpath geometry the posts (and the preview) share: arc sweeps and their linearization,
 * the in-plane/normal split of the three principal planes, and option resolution.
 */

export type ArcMove = Extract<ToolpathMove, { kind: "arc" }>;

/** The (u, v, normal) axis indexes of a principal plane, u × v = normal. */
export function planeAxes(plane: ArcMove["plane"]): readonly [number, number, number] {
    switch (plane) {
        case "XY":
            return [0, 1, 2];
        case "ZX":
            return [2, 0, 1];
        case "YZ":
            return [1, 2, 0];
    }
}

/** The plane-selection code of a principal plane. */
export function planeCode(plane: ArcMove["plane"]): "G17" | "G18" | "G19" {
    return plane === "XY" ? "G17" : plane === "ZX" ? "G18" : "G19";
}

const TWO_PI = Math.PI * 2;

/**
 * Signed sweep of an arc from `from`, radians: positive counter-clockwise seen from the
 * plane's positive normal. A move ending where it starts is a full circle.
 */
export function arcSweep(from: Vec3, arc: ArcMove): number {
    const [u, v] = planeAxes(arc.plane);
    const a0 = Math.atan2(from[v] - arc.center[v], from[u] - arc.center[u]);
    const a1 = Math.atan2(arc.to[v] - arc.center[v], arc.to[u] - arc.center[u]);
    let sweep = a1 - a0;
    const closed = Math.hypot(arc.to[u] - from[u], arc.to[v] - from[v]) < 1e-9;
    if (arc.clockwise) {
        while (sweep >= -1e-12) sweep -= TWO_PI;
        if (closed) sweep = -TWO_PI;
        else if (sweep < -TWO_PI) sweep += TWO_PI;
    } else {
        while (sweep <= 1e-12) sweep += TWO_PI;
        if (closed) sweep = TWO_PI;
        else if (sweep > TWO_PI) sweep -= TWO_PI;
    }
    return sweep;
}

/** Radius of an arc, measured at its start. */
export function arcRadius(from: Vec3, arc: ArcMove): number {
    const [u, v] = planeAxes(arc.plane);
    return Math.hypot(from[u] - arc.center[u], from[v] - arc.center[v]);
}

/**
 * Points along an arc (excluding `from`, ending exactly at `arc.to`) whose chords stay
 * within `tolerance` of it; a helix moves the normal coordinate linearly.
 */
export function arcPoints(from: Vec3, arc: ArcMove, tolerance = 0.01): Vec3[] {
    const [u, v, w] = planeAxes(arc.plane);
    const radius = arcRadius(from, arc);
    const sweep = arcSweep(from, arc);
    if (radius < 1e-9) return [arc.to];
    const step = radius > tolerance ? 2 * Math.acos(1 - tolerance / radius) : Math.PI / 2;
    const count = Math.min(4096, Math.max(1, Math.ceil(Math.abs(sweep) / Math.min(step, Math.PI / 8))));
    const a0 = Math.atan2(from[v] - arc.center[v], from[u] - arc.center[u]);
    const points: Vec3[] = [];
    for (let i = 1; i < count; i++) {
        const t = i / count;
        const angle = a0 + sweep * t;
        const point = [0, 0, 0] as [number, number, number];
        point[u] = arc.center[u] + radius * Math.cos(angle);
        point[v] = arc.center[v] + radius * Math.sin(angle);
        point[w] = from[w] + (arc.to[w] - from[w]) * t;
        points.push(point);
    }
    points.push(arc.to);
    return points;
}

/** Splits an arc into pieces of at most `maxSweep` radians (full circles for R-format posts). */
export function splitArc(from: Vec3, arc: ArcMove, maxSweep: number): ArcMove[] {
    const sweep = arcSweep(from, arc);
    const pieces = Math.max(1, Math.ceil(Math.abs(sweep) / maxSweep - 1e-9));
    if (pieces === 1) return [arc];
    const [u, v, w] = planeAxes(arc.plane);
    const radius = arcRadius(from, arc);
    const a0 = Math.atan2(from[v] - arc.center[v], from[u] - arc.center[u]);
    const result: ArcMove[] = [];
    for (let i = 1; i <= pieces; i++) {
        if (i === pieces) {
            result.push(arc);
            break;
        }
        const t = i / pieces;
        const angle = a0 + sweep * t;
        const to = [0, 0, 0] as [number, number, number];
        to[u] = arc.center[u] + radius * Math.cos(angle);
        to[v] = arc.center[v] + radius * Math.sin(angle);
        to[w] = from[w] + (arc.to[w] - from[w]) * t;
        result.push({ ...arc, to });
    }
    return result;
}

export type DrillMove = Extract<ToolpathMove, { kind: "drill" }>;

/**
 * The heights of a drill cycle, read the same way by every post, the stats and the
 * preview: `at` is the hole's top, the bottom is `depth` (positive) below it, and the R
 * plane is `retract` — an absolute WCS Z at or above the top. (A `retract` below the top
 * can only be a mistaken relative height: it is read as one, never below the top.)
 */
export function drillPlanes(move: DrillMove): { top: number; bottom: number; r: number } {
    const top = move.at[2];
    const r = move.retract >= top ? move.retract : top + Math.max(0, move.retract);
    return { top, bottom: top - Math.abs(move.depth), r };
}

/** The option values a post runs with: its defaults, then the machine's, then the caller's. */
export function resolvePostOptions(
    post: PostProcessor,
    program: CamProgram,
    options?: Readonly<Record<string, unknown>>,
): Readonly<Record<string, unknown>> {
    const machine = program.machine.post.id === post.id ? program.machine.post.options : undefined;
    return { ...post.defaultOptions, ...machine, ...options };
}

/** `D=6. FLAT ENDMILL - 6 MM FLAT` style tool description. */
export function toolDescription(tool: ToolData, num: (value: number) => string): string {
    const kind = tool.kind.replace(/([a-z])([A-Z])/g, "$1 $2").toUpperCase();
    const parts = [`D=${num(tool.diameter)}`];
    if (tool.cornerRadius !== undefined && tool.cornerRadius > 0) parts.push(`CR=${num(tool.cornerRadius)}`);
    return `${parts.join(" ")} ${kind}${tool.name ? ` - ${tool.name}` : ""}`;
}

/** The tools of a program in first-use order. */
export function programTools(program: CamProgram): ToolData[] {
    const seen = new Set<string>();
    const tools: ToolData[] = [];
    for (const path of program.toolpaths) {
        if (seen.has(path.toolId)) continue;
        seen.add(path.toolId);
        const tool = program.tools.get(path.toolId);
        if (tool !== undefined) tools.push(tool);
    }
    return tools;
}

/** Whether a tool axis is the plain +Z of 3-axis work. */
export function isVerticalAxis(axis: Vec3 | undefined): boolean {
    if (axis === undefined) return true;
    const length = Math.hypot(axis[0], axis[1], axis[2]);
    return length > 0 && Math.abs(axis[2] / length - 1) < 1e-6;
}
