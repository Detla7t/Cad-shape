// Part of the Chili3d Project, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

import {
    type IEdge,
    type IFace,
    type IShape,
    type IWire,
    Matrix4,
    type Plane,
    type Result,
    XYZ,
} from "@chili3d/core";
import {
    type AffineData,
    applyAffine,
    applyLinear,
    composeAffine,
    rotationAffine,
    type Vec3,
    vec,
} from "../featurescript/std/geometry";
import type { Loop2, V2 } from "./model";

/**
 * Kernel plumbing shared by the sheet metal builders: an arena that disposes every
 * intermediate shape, plane-to-world conversion, faces from 2D loops, and rigid
 * transforms (row-major 3x3 + translation, millimetres) as kernel matrices.
 */

export class SheetError extends Error {}

export function kernel<T>(result: Result<T>, what: string): T {
    if (!result.isOk) throw new SheetError(`${what} failed: ${result.error}`);
    return result.value;
}

export class Arena {
    private readonly shapes = new Set<IShape>();

    track<T extends IShape>(shape: T): T {
        this.shapes.add(shape);
        return shape;
    }

    trackAll<T extends IShape>(shapes: T[]): T[] {
        for (const shape of shapes) this.shapes.add(shape);
        return shapes;
    }

    /** Disposes everything tracked except `keep`. */
    dispose(keep?: IShape): void {
        for (const shape of this.shapes) if (shape !== keep) shape.dispose();
        this.shapes.clear();
    }
}

export const IDENTITY: AffineData = { m: [1, 0, 0, 0, 1, 0, 0, 0, 1], t: [0, 0, 0] };

export type { AffineData, Vec3 };
export { applyAffine, applyLinear, composeAffine, rotationAffine, vec };

export function translation(t: Vec3): AffineData {
    return { m: IDENTITY.m, t };
}

/** A rigid transform as a kernel matrix (column-major, no unit scaling). */
export function toMatrix(a: AffineData): Matrix4 {
    const m = a.m;
    return Matrix4.fromArray([
        m[0],
        m[3],
        m[6],
        0,
        m[1],
        m[4],
        m[7],
        0,
        m[2],
        m[5],
        m[8],
        0,
        a.t[0],
        a.t[1],
        a.t[2],
        1,
    ]);
}

export function isIdentity(a: AffineData): boolean {
    return a.m.every((x, i) => Math.abs(x - IDENTITY.m[i]) < 1e-12) && a.t.every((x) => Math.abs(x) < 1e-9);
}

export function placed(arena: Arena, shape: IShape, transform: AffineData): IShape {
    return isIdentity(transform) ? shape : arena.track(shape.transformedMul(toMatrix(transform)));
}

export const xyz = (v: Vec3): XYZ => new XYZ(v[0], v[1], v[2]);
export const v3 = (p: { x: number; y: number; z: number }): Vec3 => [p.x, p.y, p.z];

/** The blank's plane as a frame: (u, v, z) → body-local 3D. */
export class PlaneFrame {
    readonly origin: Vec3;
    readonly x: Vec3;
    readonly y: Vec3;
    readonly n: Vec3;

    constructor(plane: Plane) {
        this.origin = v3(plane.origin);
        this.x = v3(plane.xvec);
        this.y = v3(plane.yvec);
        this.n = v3(plane.normal);
    }

    point(u: number, v: number, z = 0): Vec3 {
        return vec.add(
            this.origin,
            vec.add(vec.scale(this.x, u), vec.add(vec.scale(this.y, v), vec.scale(this.n, z))),
        );
    }

    dir(du: number, dv: number, dz = 0): Vec3 {
        return vec.add(vec.scale(this.x, du), vec.add(vec.scale(this.y, dv), vec.scale(this.n, dz)));
    }

    /** Body-local 3D → (u, v) in the plane (the normal component dropped). */
    local(p: Vec3): V2 {
        const d = vec.sub(p, this.origin);
        return [vec.dot(d, this.x), vec.dot(d, this.y)];
    }
}

/** Center of the circle through three 2D points. */
export function circleCenter(a: V2, b: V2, c: V2): V2 {
    const d = 2 * (a[0] * (b[1] - c[1]) + b[0] * (c[1] - a[1]) + c[0] * (a[1] - b[1]));
    if (Math.abs(d) < 1e-12) throw new SheetError("Arc points are collinear");
    const sq = (p: V2) => p[0] * p[0] + p[1] * p[1];
    return [
        (sq(a) * (b[1] - c[1]) + sq(b) * (c[1] - a[1]) + sq(c) * (a[1] - b[1])) / d,
        (sq(a) * (c[0] - b[0]) + sq(b) * (a[0] - c[0]) + sq(c) * (b[0] - a[0])) / d,
    ];
}

/** Counter-clockwise angle from `from` to `to`, in (0, 2π]. */
export function ccw(from: number, to: number): number {
    let sweep = to - from;
    while (sweep <= 1e-12) sweep += 2 * Math.PI;
    while (sweep > 2 * Math.PI + 1e-12) sweep -= 2 * Math.PI;
    return sweep;
}

/** A kernel edge for one 2D segment at height `z` on the frame. */
function segmentEdge(arena: Arena, frame: PlaneFrame, segment: Loop2[number], z: number): IEdge {
    const p = (q: V2) => xyz(frame.point(q[0], q[1], z));
    if (segment.kind === "line")
        return arena.track(kernel(shapeFactory.line(p(segment.a), p(segment.b)), "sheet edge"));
    const center = circleCenter(segment.a, segment.mid, segment.b);
    const angle = (q: V2) => Math.atan2(q[1] - center[1], q[0] - center[0]);
    const toEnd = ccw(angle(segment.a), angle(segment.b));
    const toMid = ccw(angle(segment.a), angle(segment.mid));
    const [start, sweep] = toMid < toEnd ? [segment.a, toEnd] : [segment.b, 2 * Math.PI - toEnd];
    return arena.track(
        kernel(shapeFactory.arc(xyz(frame.n), p(center), p(start), (sweep * 180) / Math.PI), "sheet arc"),
    );
}

/** A planar face from 2D loops (outer first, then holes) at height `z`. */
export function faceFromLoops(arena: Arena, frame: PlaneFrame, loops: readonly Loop2[], z = 0): IFace {
    const wires: IWire[] = loops.map((loop) =>
        arena.track(
            kernel(
                shapeFactory.wire(loop.map((segment) => segmentEdge(arena, frame, segment, z))),
                "sheet outline",
            ),
        ),
    );
    return arena.track(kernel(shapeFactory.face(wires), "sheet face"));
}

/** A closed polygon face (3D points in order). */
export function polygonFace(arena: Arena, points: readonly Vec3[]): IFace {
    // The kernel's polygon does not close itself: repeat the first point.
    const wire = arena.track(kernel(shapeFactory.polygon([...points, points[0]].map(xyz)), "polygon"));
    return arena.track(kernel(shapeFactory.face([wire]), "polygon face"));
}

export function prism(arena: Arena, shape: IShape, direction: Vec3): IShape {
    return arena.track(kernel(shapeFactory.prism(shape, xyz(direction)), "sheet prism"));
}

/** Fuses solids into one; a single shape passes through. */
export function fuseAll(arena: Arena, shapes: IShape[]): IShape {
    if (shapes.length === 0) throw new SheetError("Nothing to build");
    if (shapes.length === 1) return shapes[0];
    const [first, ...rest] = shapes;
    return arena.track(kernel(shapeFactory.booleanFuse([first], rest, true), "sheet union"));
}

export function signedArea(points: readonly V2[]): number {
    let area = 0;
    for (let i = 0; i < points.length; i++) {
        const a = points[i];
        const b = points[(i + 1) % points.length];
        area += a[0] * b[1] - b[0] * a[1];
    }
    return area / 2;
}
