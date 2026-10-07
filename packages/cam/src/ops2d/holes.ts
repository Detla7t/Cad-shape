// Part of the Chili3d Project, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

import { type IFace, type IShape, type ISolid, ShapeTypes, type XYZ } from "@chili3d/core";
import type { Point2 } from "../geometry2d/vec";

/**
 * Hole recognition for drilling: vertical cylindrical holes of the parts (or of picked
 * faces), found from their full-circle cylindrical faces — center, diameter, top and bottom —
 * and holes from picked circular edges.
 */

export interface Hole {
    readonly center: Point2;
    readonly diameter: number;
    /** Z where the hole starts (its rim). */
    readonly top: number;
    /** Z of the hole's floor (blind) or where it exits the part (through). */
    readonly bottom: number;
    /** True when the hole opens into air below its bottom. */
    readonly through: boolean;
}

interface Cylinder {
    readonly face: IFace;
    readonly center: Point2;
    readonly radius: number;
    readonly zMin: number;
    readonly zMax: number;
    readonly solid?: ISolid;
}

/** A vertical cylinder face's axis and radius, or undefined for any other face. */
function verticalCylinder(face: IFace): { center: Point2; radius: number } | undefined {
    let surface: ReturnType<IFace["surface"]> | undefined;
    try {
        surface = face.surface();
        if (surface.isPlanar()) return undefined;
        // The surface interface carries no type tag: cylinders are told apart by their members.
        const s = surface as unknown as {
            radius?: number;
            axis?: XYZ;
            location?: XYZ;
            majorRadius?: number;
            apex?: unknown;
            semiAngle?: number;
        };
        if ("majorRadius" in s || typeof s.apex === "function" || "semiAngle" in s) return undefined;
        if (typeof s.radius !== "number" || s.axis === undefined || s.location === undefined)
            return undefined;
        const bounds = surface.bounds();
        // A sphere has the same members but a bounded v range of π.
        if (Math.abs(bounds.v2 - bounds.v1) < 10) return undefined;
        if (Math.abs(Math.abs(s.axis.z) - 1) > 1e-6) return undefined;
        return { center: [s.location.x, s.location.y], radius: s.radius };
    } catch {
        return undefined;
    } finally {
        surface?.dispose();
    }
}

function cylindersOf(faces: readonly IFace[], solid?: ISolid): Cylinder[] {
    const out: Cylinder[] = [];
    for (const face of faces) {
        const cylinder = verticalCylinder(face);
        if (cylinder === undefined) continue;
        const box = face.boundingBox();
        out.push({ face, ...cylinder, zMin: box.min.z, zMax: box.max.z, ...(solid ? { solid } : {}) });
    }
    return out;
}

/** Whether the face's material lies outside the cylinder (a hole) at the sampled point. */
function opensTowardAxis(face: IFace, center: Point2, point: XYZ): boolean | undefined {
    let surface: ReturnType<IFace["surface"]> | undefined;
    try {
        surface = face.surface();
        const uv = surface.parameter(point, 1e-3);
        if (uv === undefined) return undefined;
        const [, normal] = face.normal(uv.u, uv.v);
        const radial = [point.x - center[0], point.y - center[1]];
        const d = normal.x * radial[0] + normal.y * radial[1];
        if (Math.abs(d) < 1e-12) return undefined;
        return d < 0;
    } catch {
        return undefined;
    } finally {
        surface?.dispose();
    }
}

const SAMPLES = 16;

/** Groups coaxial cylinder faces of equal radius and keeps the full, concave ones. */
function holesFromCylinders(cylinders: readonly Cylinder[], tolerance: number): Hole[] {
    const groups: Cylinder[][] = [];
    for (const cylinder of cylinders) {
        const group = groups.find(
            (g) =>
                g[0].solid === cylinder.solid &&
                Math.hypot(g[0].center[0] - cylinder.center[0], g[0].center[1] - cylinder.center[1]) <
                    tolerance &&
                Math.abs(g[0].radius - cylinder.radius) < tolerance &&
                g.some((c) => cylinder.zMin <= c.zMax + tolerance && cylinder.zMax >= c.zMin - tolerance),
        );
        if (group) group.push(cylinder);
        else groups.push([cylinder]);
    }
    const holes: Hole[] = [];
    for (const group of groups) {
        const { center, radius } = group[0];
        // Full circle: every sampled direction hits one of the group's faces.
        let concave: boolean | undefined;
        let full = true;
        for (let k = 0; k < SAMPLES && full; k++) {
            const angle = (2 * Math.PI * (k + 0.37)) / SAMPLES;
            let hit = false;
            for (const cylinder of group) {
                const z = (cylinder.zMin + cylinder.zMax) / 2;
                const point = {
                    x: center[0] + radius * Math.cos(angle),
                    y: center[1] + radius * Math.sin(angle),
                    z,
                } as XYZ;
                if (!cylinder.face.containsPoint(point, true, 1e-3 + radius * 1e-6)) continue;
                hit = true;
                concave ??= opensTowardAxis(cylinder.face, center, point);
                break;
            }
            full = hit;
        }
        if (!full || concave !== true) continue;
        const top = Math.max(...group.map((c) => c.zMax));
        const bottom = Math.min(...group.map((c) => c.zMin));
        const solid = group[0].solid;
        // Through when the whole bore opens into air below its bottom (a counterbore's floor
        // is material around a smaller hole: blind).
        const z = bottom - Math.max(0.05, radius * 0.05);
        const probes: XYZ[] = [{ x: center[0], y: center[1], z } as XYZ];
        for (let k = 0; k < 4; k++) {
            const angle = (k * Math.PI) / 2 + 0.3;
            probes.push({
                x: center[0] + 0.9 * radius * Math.cos(angle),
                y: center[1] + 0.9 * radius * Math.sin(angle),
                z,
            } as XYZ);
        }
        const through =
            solid === undefined || probes.every((probe) => !solid.containsPoint(probe, true, 1e-4));
        holes.push({ center, diameter: 2 * radius, top, bottom, through });
    }
    return holes;
}

function solidsOf(shape: IShape): ISolid[] {
    if (shape.shapeType === ShapeTypes.solid) return [shape as ISolid];
    return shape.findSubShapes(ShapeTypes.solid) as ISolid[];
}

/** The vertical cylindrical holes of the parts. */
export function detectHoles(parts: readonly IShape[], tolerance = 1e-3): Hole[] {
    const holes: Hole[] = [];
    for (const part of parts) {
        for (const solid of solidsOf(part)) {
            const faces = solid.findSubShapes(ShapeTypes.face) as IFace[];
            holes.push(...holesFromCylinders(cylindersOf(faces, solid), tolerance));
        }
    }
    return holes;
}

/**
 * Holes from picked faces: each picked cylinder face with its coaxial partners in the parts
 * (so a hole split into two half faces counts once and whole).
 */
export function holesFromFaces(faces: readonly IFace[], parts: readonly IShape[], tolerance = 1e-3): Hole[] {
    const picked = cylindersOf(faces);
    if (picked.length === 0) return [];
    const all = detectHoles(parts, tolerance);
    const out: Hole[] = [];
    for (const cylinder of picked) {
        const match = all.find(
            (hole) =>
                Math.hypot(hole.center[0] - cylinder.center[0], hole.center[1] - cylinder.center[1]) <
                    tolerance &&
                Math.abs(hole.diameter / 2 - cylinder.radius) < tolerance &&
                cylinder.zMin >= hole.bottom - tolerance &&
                cylinder.zMax <= hole.top + tolerance,
        );
        const hole = match ?? {
            center: cylinder.center,
            diameter: 2 * cylinder.radius,
            top: cylinder.zMax,
            bottom: cylinder.zMin,
            through: true,
        };
        if (!out.some((h) => samePlace(h, hole, tolerance))) out.push(hole);
    }
    return out;
}

const samePlace = (a: Hole, b: Hole, tolerance: number) =>
    Math.hypot(a.center[0] - b.center[0], a.center[1] - b.center[1]) < tolerance &&
    Math.abs(a.diameter - b.diameter) < tolerance &&
    Math.abs(a.top - b.top) < tolerance;

/** Holes at picked circular edges (rims), `depth` deep (or through to `bottom`). */
export function holesFromCircles(
    circles: readonly { center: Point2; radius: number; z: number }[],
    depth: number,
    tolerance = 1e-3,
): Hole[] {
    const out: Hole[] = [];
    for (const circle of circles) {
        const hole: Hole = {
            center: circle.center,
            diameter: 2 * circle.radius,
            top: circle.z,
            bottom: circle.z - depth,
            through: false,
        };
        // A hole's two rims are both circles: keep the upper one.
        const twin = out.findIndex(
            (h) =>
                Math.hypot(h.center[0] - hole.center[0], h.center[1] - hole.center[1]) < tolerance &&
                Math.abs(h.diameter - hole.diameter) < tolerance,
        );
        if (twin < 0) out.push(hole);
        else if (hole.top > out[twin].top) out[twin] = hole;
    }
    return out;
}

/**
 * Holes at picked rims (circular edges, sketch circles) drilled to the hole's bottom: a circle
 * on a hole of the parts (same axis and diameter, its plane within the hole) is that hole —
 * its real floor, through or blind; any other circle is drilled from its plane down to
 * `bottom` (the stock bottom), through the stock. A rim carries no depth of its own: the
 * stock's height measured from the rim drilled past the stock bottom whenever the rim was
 * below the stock top, and left a through hole short of its breakthrough.
 */
export function holesFromRims(
    circles: readonly { center: Point2; radius: number; z: number }[],
    parts: readonly IShape[],
    bottom: number,
    tolerance = 1e-3,
): Hole[] {
    const detected = detectHoles(parts, tolerance);
    const out: Hole[] = [];
    for (const circle of circles) {
        const match = detected.find(
            (hole) =>
                Math.hypot(hole.center[0] - circle.center[0], hole.center[1] - circle.center[1]) <
                    tolerance &&
                Math.abs(hole.diameter / 2 - circle.radius) < tolerance &&
                circle.z >= hole.bottom - tolerance &&
                circle.z <= hole.top + tolerance,
        );
        const hole: Hole = match ?? {
            center: circle.center,
            diameter: 2 * circle.radius,
            top: circle.z,
            bottom: Math.min(bottom, circle.z),
            through: true,
        };
        // A hole's two rims are both circles: keep it once, from the upper one.
        const twin = out.findIndex(
            (h) =>
                Math.hypot(h.center[0] - hole.center[0], h.center[1] - hole.center[1]) < tolerance &&
                Math.abs(h.diameter - hole.diameter) < tolerance,
        );
        if (twin < 0) out.push(hole);
        else if (hole.top > out[twin].top) out[twin] = hole;
    }
    return out;
}
