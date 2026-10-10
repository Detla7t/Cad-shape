// Part of the Chili3d Project, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

import type { IEdge, XYZ } from "@chili3d/core";
import { fail } from "../lang/values";
import type { EntityRef } from "./fsContext";

/**
 * Edge chains as std's `Path`s order them — shared by `@constructPaths` and the
 * operations that run along paths (ruled surfaces, sheet extension).
 */

/** Onshape's default path tolerance, `TOLERANCE.zeroLength * meter`, in kernel millimetres. */
const PATH_TOLERANCE_MM = 1e-5;

/** One edge of a path: which edge, and whether the path runs against its curve. */
export interface PathStep {
    readonly edge: number;
    readonly flipped: boolean;
}

/** An ordered chain of edges: what std's `Path` holds, as indexes into the input edges. */
export interface PathChain {
    readonly steps: readonly PathStep[];
    readonly closed: boolean;
}

/**
 * The input edges ordered into paths: one per connected chain, each running from a free
 * end (the first one in input order) or — when closed — from the start of its first
 * edge. Ends closer than `tolerance` (mm) meet; three or more ends at one point is a
 * branch, which no path can traverse.
 */
export function orderPaths(
    ends: readonly (readonly [XYZ, XYZ])[],
    tolerance = PATH_TOLERANCE_MM,
): PathChain[] {
    // Endpoint k is end (k % 2) of edge floor(k / 2); points within tolerance share a group.
    const points = ends.flatMap((pair) => [pair[0], pair[1]]);
    const group = points.map((_, k) => k);
    for (let k = 0; k < points.length; k++) {
        for (let j = 0; j < k; j++) {
            if (points[k].distanceTo(points[j]) < tolerance) {
                group[k] = group[j];
                break;
            }
        }
    }
    const members = new Map<number, number[]>();
    for (let k = 0; k < group.length; k++) members.set(group[k], [...(members.get(group[k]) ?? []), k]);
    if ([...members.values()].some((m) => m.length > 2)) fail("CONSTRUCT_PATH_NOT_MANIFOLD");
    const partner = (k: number) => members.get(group[k])?.find((other) => other !== k);

    const used = new Set<number>();
    const chains: PathChain[] = [];
    const walk = (startEdge: number, flipped: boolean): PathChain => {
        const steps: PathStep[] = [];
        let edge = startEdge;
        let reversed = flipped;
        for (;;) {
            used.add(edge);
            steps.push({ edge, flipped: reversed });
            // The end the path leaves this edge through, then whoever meets it there.
            const exit = 2 * edge + (reversed ? 0 : 1);
            const next = partner(exit);
            if (next === undefined) return { steps, closed: false };
            const nextEdge = Math.floor(next / 2);
            if (used.has(nextEdge)) return { steps, closed: nextEdge === startEdge };
            edge = nextEdge;
            reversed = next % 2 === 1;
        }
    };
    // Open chains first start from their first free end in input order.
    for (let k = 0; k < points.length; k++) {
        const edge = Math.floor(k / 2);
        if (used.has(edge) || partner(k) !== undefined) continue;
        chains.push(walk(edge, k % 2 === 1));
    }
    // What is left are loops.
    for (let edge = 0; edge < ends.length; edge++) {
        if (!used.has(edge)) chains.push(walk(edge, false));
    }
    return chains;
}

/** An edge's start and end in its curve's parameter direction — the sense `evEdgeTangentLine` uses. */
export function curveEnds(edge: IEdge): [XYZ, XYZ] {
    return [edge.curve.value(edge.firstParameter()), edge.curve.value(edge.lastParameter())];
}

/**
 * A sketch's curves counted once. The host keeps a sketch's edges both in its wire body
 * and on its region faces, where Onshape has a single edge per curve, so
 * `qCreatedBy(sketchId, EntityType.EDGE)` names each closed curve twice. Edges of the
 * same sketch with the same ends and midpoint keep the first in query order.
 */
export function distinctSketchEdges(refs: readonly EntityRef[]): EntityRef[] {
    const kept: { ref: EntityRef; points: XYZ[] }[] = [];
    const result: EntityRef[] = [];
    for (const ref of refs) {
        if (ref.kind !== "EDGE" || ref.body.flags.sketch !== true) {
            result.push(ref);
            continue;
        }
        const edge = ref.body.edges()[ref.index];
        const [start, end] = curveEnds(edge);
        const points = [start, end, edge.curve.value((edge.firstParameter() + edge.lastParameter()) / 2)];
        const same = kept.some(
            (other) =>
                other.ref.body.bodyAttr.createdBy === ref.body.bodyAttr.createdBy &&
                sameCurve(other.points, points),
        );
        if (same) continue;
        kept.push({ ref, points });
        result.push(ref);
    }
    return result;
}

/** Same ends (either way round) and the same midpoint. */
function sameCurve(a: readonly XYZ[], b: readonly XYZ[]): boolean {
    const near = (p: XYZ, q: XYZ) => p.distanceTo(q) < PATH_TOLERANCE_MM;
    const ends = (near(a[0], b[0]) && near(a[1], b[1])) || (near(a[0], b[1]) && near(a[1], b[0]));
    return ends && near(a[2], b[2]);
}
