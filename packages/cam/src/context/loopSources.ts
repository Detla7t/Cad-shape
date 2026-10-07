// Part of the Chili3d Project, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

import { type Matrix4, Result } from "@chili3d/core";
import {
    arcAngles,
    type FlatPattern,
    flatPatternOf,
    type Loop2,
    type ParametricBodyNode,
    profileExternalRefs,
    type SketchData,
    type SketchEntityType,
    type SketchNode,
    sheetModelOf,
} from "@chili3d/parametric";
import type { CamLoop } from "../model/operation";
import type { Vec3 } from "../model/toolpath";
import {
    arcThrough,
    chainSegments,
    circleSegment,
    DEFAULT_LOOP_TOLERANCE,
    mapChains,
    orientLoops,
    type PlaneChain,
    type PlaneSegment,
    type Point2,
} from "./loops";

/**
 * Where 2D operations' loops come from: a sketch (its own lines, arcs and circles plus its
 * profile-role projected edges) or a sheet metal body's flat pattern — the exact 2D
 * development `flatPatternOf` computes for the DXF export (outline with the strips
 * unfolded, holes, bend lines, forming marks).
 */

function entitySegment(type: SketchEntityType, params: readonly number[]): PlaneSegment | undefined {
    if (type === "line") {
        const [x1, y1, x2, y2] = params;
        return Math.hypot(x2 - x1, y2 - y1) < 1e-12 ? undefined : { kind: "line", a: [x1, y1], b: [x2, y2] };
    }
    if (type === "circle") {
        const [cx, cy, r] = params;
        return r > 0 ? circleSegment([cx, cy], r) : undefined;
    }
    const [cx, cy, sx, sy] = params;
    const radius = Math.hypot(sx - cx, sy - cy);
    if (radius <= 0) return undefined;
    const [start, sweep] = arcAngles([...params]);
    return { kind: "arc", center: [cx, cy], radius, start, sweep };
}

/** A sketch's cut geometry in its (u, v) plane: its entities, then profile-role external edges. */
export function sketchSegments(data: SketchData): PlaneSegment[] {
    const segments: PlaneSegment[] = [];
    for (const entity of data.entities) {
        const segment = entitySegment(entity.type, entity.params);
        if (segment !== undefined) segments.push(segment);
    }
    for (const ref of profileExternalRefs(data)) {
        const segment = entitySegment(ref.type, ref.snapshot);
        if (segment !== undefined) segments.push(segment);
    }
    return segments;
}

/** A sketch as WCS loops: closed profiles oriented by nesting, open chains as they are. */
export function sketchLoops(
    sketch: SketchNode,
    modelToWcs: Matrix4,
    tolerance = DEFAULT_LOOP_TOLERANCE,
): CamLoop[] {
    const plane = sketch.plane;
    const transform = sketch.worldTransform().multiply(modelToWcs);
    const toWcs = (p: Point2): Vec3 => {
        const world = plane.origin.add(plane.xvec.multiply(p[0])).add(plane.yvec.multiply(p[1]));
        const q = transform.ofPoint(world);
        return [q.x, q.y, q.z];
    };
    const chains = chainSegments(sketchSegments(sketch.data));
    return orientLoops(mapChains(chains, toWcs, "sketch", tolerance));
}

function loopSegments(loop: Loop2): PlaneSegment[] {
    return loop.flatMap((segment): PlaneSegment[] => {
        if (segment.kind === "line") return [{ kind: "line", a: segment.a, b: segment.b }];
        const arc = arcThrough(segment.a, segment.mid, segment.b);
        return arc === undefined ? [{ kind: "line", a: segment.a, b: segment.b }] : [arc];
    });
}

/** A flat pattern's chains in the blank plane: the outline (outer first), bend lines, marks. */
export function flatPatternChains(pattern: FlatPattern): {
    outline: PlaneChain[];
    bends: PlaneChain[];
    marks: PlaneChain[];
} {
    return {
        outline: pattern.outline.map((loop) => ({ segments: loopSegments(loop), closed: true })),
        bends: pattern.bendLines.map((line) => ({
            segments: [{ kind: "line", a: line.a, b: line.b }],
            closed: false,
        })),
        marks: pattern.forming.map((line) => ({
            segments: [{ kind: "line", a: line.a, b: line.b }],
            closed: false,
        })),
    };
}

/**
 * A sheet metal body's flat pattern as WCS loops. The blank plane is mapped through the
 * body's placement into the WCS when it lies parallel to the WCS XY (a part cut where it is
 * modelled); otherwise the pattern is laid on the WCS XY in its own (u, v) — a flat blank
 * on the table. Loops sit at the sheet's top (z of the upper face).
 */
export function flatPatternLoops(
    body: ParametricBodyNode,
    modelToWcs: Matrix4,
    tolerance = DEFAULT_LOOP_TOLERANCE,
): Result<CamLoop[]> {
    const shape = body.shape;
    if (!shape.isOk) return Result.err(`"${body.name}" has no shape: ${shape.error}`);
    const model = sheetModelOf(shape.value);
    if (model === undefined) return Result.err(`"${body.name}" is not a sheet metal part`);
    const pattern = flatPatternOf(model);
    if (!pattern.isOk) return Result.err(pattern.error);
    const transform = body.worldTransform().multiply(modelToWcs);
    const plane = model.plane;
    const normal = transform.ofVector(plane.normal);
    const parallel = Math.abs(normal.z) >= 1 - 1e-6 * Math.max(1, normal.length());
    const lift = parallel && normal.z > 0 ? model.thickness : 0;
    const toWcs = parallel
        ? (p: Point2): Vec3 => {
              const local = plane.origin.add(plane.xvec.multiply(p[0])).add(plane.yvec.multiply(p[1]));
              const q = transform.ofPoint(local);
              return [q.x, q.y, q.z + lift];
          }
        : (p: Point2): Vec3 => [p[0], p[1], model.thickness];
    const chains = flatPatternChains(pattern.value);
    const outline = mapChains(chains.outline, toWcs, "hole", tolerance);
    if (outline.length > 0) outline[0].role = "outline";
    return Result.ok([
        ...orientLoops(outline),
        ...orientLoops(mapChains(chains.bends, toWcs, "bend", tolerance)),
        ...orientLoops(mapChains(chains.marks, toWcs, "mark", tolerance)),
    ]);
}
