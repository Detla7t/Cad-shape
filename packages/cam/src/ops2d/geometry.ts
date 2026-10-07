// Part of the Chili3d Project, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

import { type IEdge, type IFace, type IWire, ShapeTypes } from "@chili3d/core";
import { ARC_TOLERANCE } from "../geometry2d/arcs";
import { type Region, regions } from "../geometry2d/clip";
import { arcStepAngle } from "../geometry2d/path";
import { oriented, removeDuplicatePoints } from "../geometry2d/polygon";
import type { Point2 } from "../geometry2d/vec";
import type { CamLoop, CamOperationContext } from "../model/operation";
import type { Vec3 } from "../model/toolpath";

/**
 * What 2D operations cut, gathered from an operation's selection: closed loops and open
 * chains in the WCS XY plane at a Z, from picked sketches/flat patterns (`CamLoop`s), the
 * boundaries of picked horizontal planar faces, and chains of picked edges.
 */

export interface Profile {
    readonly points: readonly Point2[];
    readonly closed: boolean;
    /** Z of the profile's plane (WCS). */
    readonly z: number;
    readonly role?: CamLoop["role"];
    readonly source: "loop" | "face" | "edge";
}

/** A face's (or a set of nested loops') material region at a Z. */
export interface RegionAt extends Region {
    readonly z: number;
    readonly source: "loop" | "face" | "edge";
}

/** Points along an edge within `tolerance` (WCS, both ends). */
export function edgePolyline(edge: IEdge, tolerance = ARC_TOLERANCE): Vec3[] {
    const t0 = edge.firstParameter();
    const t1 = edge.lastParameter();
    const at = (t: number): Vec3 => {
        const p = edge.pointAt(t);
        return [p.x, p.y, p.z];
    };
    let kind = "other";
    let radius = 0;
    try {
        const curve = edge.curve;
        const basis =
            (curve as unknown as { basisCurve?: { curveType: string; radius?: number } }).basisCurve ?? curve;
        kind = basis.curveType;
        if (kind === "circle") radius = (basis as unknown as { radius: number }).radius;
    } catch {
        // A degenerate edge has no curve: nothing to cut along.
        return [];
    }
    if (kind === "line") return [at(t0), at(t1)];
    if (kind === "circle" && radius > 0) {
        const n = Math.max(2, Math.ceil(Math.abs(t1 - t0) / arcStepAngle(radius, tolerance)));
        return Array.from({ length: n + 1 }, (_, i) => at(t0 + ((t1 - t0) * i) / n));
    }
    // Free-form curves: subdivide until each chord's middle is within the tolerance.
    const out: Vec3[] = [at(t0)];
    const subdivide = (a: number, pa: Vec3, b: number, pb: Vec3, depth: number) => {
        const m = (a + b) / 2;
        const pm = at(m);
        const chordMid: Vec3 = [(pa[0] + pb[0]) / 2, (pa[1] + pb[1]) / 2, (pa[2] + pb[2]) / 2];
        const deviation = Math.hypot(pm[0] - chordMid[0], pm[1] - chordMid[1], pm[2] - chordMid[2]);
        if (depth < 12 && (deviation > tolerance || depth < 2)) {
            subdivide(a, pa, m, pm, depth + 1);
            subdivide(m, pm, b, pb, depth + 1);
        } else out.push(pb);
    };
    const n = 8;
    let previous = out[0];
    for (let i = 1; i <= n; i++) {
        const t = t0 + ((t1 - t0) * i) / n;
        const p = at(t);
        subdivide(t0 + ((t1 - t0) * (i - 1)) / n, previous, t, p, 0);
        previous = p;
    }
    return out;
}

const close3 = (a: Vec3, b: Vec3, tolerance: number) =>
    Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]) <= tolerance;

/** Joins polylines end to end (reversing as needed) into chains; closed when they come round. */
export function chainPolylines(
    polylines: readonly Vec3[][],
    tolerance = 1e-3,
): { points: Vec3[]; closed: boolean }[] {
    const remaining = polylines.filter((p) => p.length >= 2).map((p) => [...p]);
    const chains: { points: Vec3[]; closed: boolean }[] = [];
    for (let chain = remaining.shift(); chain !== undefined; chain = remaining.shift()) {
        let grown = true;
        while (grown) {
            grown = false;
            for (let i = 0; i < remaining.length; i++) {
                const p = remaining[i];
                const head = chain[0];
                const tail = chain[chain.length - 1];
                if (close3(tail, p[0], tolerance)) chain.push(...p.slice(1));
                else if (close3(tail, p[p.length - 1], tolerance)) chain.push(...[...p].reverse().slice(1));
                else if (close3(head, p[p.length - 1], tolerance)) chain.unshift(...p.slice(0, -1));
                else if (close3(head, p[0], tolerance)) chain.unshift(...[...p].reverse().slice(0, -1));
                else continue;
                remaining.splice(i, 1);
                grown = true;
                break;
            }
        }
        const closed = chain.length > 2 && close3(chain[0], chain[chain.length - 1], tolerance);
        if (closed) chain.pop();
        chains.push({ points: chain, closed });
    }
    return chains;
}

const flatZ = (points: readonly Vec3[]) =>
    points.reduce((m, p) => Math.min(m, p[2]), Number.POSITIVE_INFINITY);

/** The material region of a horizontal planar face (outer boundary and holes), or undefined. */
export function faceRegion(face: IFace, tolerance = ARC_TOLERANCE): RegionAt | undefined {
    const box = face.boundingBox();
    if (Math.abs(box.max.z - box.min.z) > 1e-4) return undefined;
    const wires = face.findSubShapes(ShapeTypes.wire) as IWire[];
    const loops: Point2[][] = [];
    for (const wire of wires) {
        const chains = chainPolylines(wire.edgeLoop().map((edge) => edgePolyline(edge, tolerance)));
        for (const chain of chains) {
            if (chain.closed) loops.push(chain.points.map((p) => [p[0], p[1]] as Point2));
        }
    }
    const found = regions(loops);
    if (found.length === 0) return undefined;
    return { ...found[0], z: (box.max.z + box.min.z) / 2, source: "face" };
}

/** Center, radius and Z of a circular edge (an arc or a full circle). */
export function circleOfEdge(
    edge: IEdge,
): { center: Point2; radius: number; z: number; full: boolean } | undefined {
    try {
        const curve = edge.curve;
        const basis = (curve as unknown as { basisCurve?: unknown }).basisCurve ?? curve;
        const circle = basis as {
            curveType: string;
            center: { x: number; y: number; z: number };
            radius: number;
            axis: { z: number };
        };
        if (circle.curveType !== "circle" || Math.abs(Math.abs(circle.axis.z) - 1) > 1e-6) return undefined;
        const span = Math.abs(edge.lastParameter() - edge.firstParameter());
        return {
            center: [circle.center.x, circle.center.y],
            radius: circle.radius,
            z: circle.center.z,
            full: Math.abs(span - 2 * Math.PI) < 1e-6,
        };
    } catch {
        return undefined;
    }
}

export interface SelectionGeometry {
    /** Closed profiles, each on its own (a face contributes its outer boundary only). */
    readonly closed: readonly Profile[];
    /** Open chains. */
    readonly open: readonly Profile[];
    /** Material regions with their holes: faces, and nested closed loops grouped by Z. */
    readonly regions: readonly RegionAt[];
    /** Closed loops that are holes of their region (face inner boundaries, nested loops). */
    readonly holes: readonly Profile[];
}

/** The 2D geometry of an operation's selection, in WCS. */
export function selectionGeometry(
    context: CamOperationContext,
    tolerance = ARC_TOLERANCE,
): SelectionGeometry {
    const closed: Profile[] = [];
    const open: Profile[] = [];
    const regionList: RegionAt[] = [];
    const holes: Profile[] = [];

    const loopsByZ = new Map<number, { points: Point2[]; source: Profile["source"] }[]>();
    const addClosed = (points: Point2[], z: number, source: Profile["source"], role?: CamLoop["role"]) => {
        const clean = removeDuplicatePoints(points, true);
        if (clean.length < 3) return;
        closed.push({ points: oriented(clean, true), closed: true, z, source, ...(role ? { role } : {}) });
        const key = Math.round(z * 1e4) / 1e4;
        const group = loopsByZ.get(key) ?? [];
        group.push({ points: clean, source });
        loopsByZ.set(key, group);
    };

    for (const loop of context.selectedLoops()) {
        const points = loop.points.map((p) => [p[0], p[1]] as Point2);
        const z = loop.z ?? 0;
        if (loop.closed) addClosed(points, z, "loop", loop.role);
        else if (points.length >= 2)
            open.push({
                points,
                closed: false,
                z,
                source: "loop",
                ...(loop.role ? { role: loop.role } : {}),
            });
    }

    for (const face of context.selectedFaces()) {
        const region = faceRegion(face, tolerance);
        if (region === undefined) continue;
        regionList.push(region);
        closed.push({ points: region.outer, closed: true, z: region.z, source: "face", role: "outline" });
        for (const hole of region.holes)
            holes.push({ points: hole, closed: true, z: region.z, source: "face", role: "hole" });
    }

    const edges = context.selectedEdges();
    if (edges.length > 0) {
        for (const chain of chainPolylines(edges.map((edge) => edgePolyline(edge, tolerance)))) {
            const points = chain.points.map((p) => [p[0], p[1]] as Point2);
            const z = flatZ(chain.points);
            if (chain.closed) addClosed(points, z, "edge");
            else open.push({ points, closed: false, z, source: "edge" });
        }
    }

    for (const [z, loops] of loopsByZ) {
        for (const region of regions(loops.map((l) => l.points))) {
            regionList.push({ ...region, z, source: loops[0].source });
            for (const hole of region.holes)
                holes.push({ points: hole, closed: true, z, source: loops[0].source, role: "hole" });
        }
    }
    return { closed, open, regions: regionList, holes };
}

/** The Z of the stock top and bottom. */
export function stockTop(context: CamOperationContext): number {
    return context.stock.max[2];
}

export function stockBottom(context: CamOperationContext): number {
    return context.stock.min[2];
}

/** The highest Z of the parts (their bounding boxes), or undefined without parts. */
export function partsTop(context: CamOperationContext): number | undefined {
    let top: number | undefined;
    for (const part of context.parts) {
        const box = part.boundingBox();
        top = top === undefined ? box.max.z : Math.max(top, box.max.z);
    }
    return top;
}
