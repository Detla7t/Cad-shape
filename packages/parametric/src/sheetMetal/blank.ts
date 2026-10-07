// Part of the Chili3d Project, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

import { CurveUtils, type IEdge, type IFace, type IWire, ShapeTypes, type XYZ } from "@chili3d/core";
import { type PlaneFrame, SheetError, v3 } from "./frame";
import type { Loop2, Segment2, V2 } from "./model";

/**
 * A planar face as blank loops in its plane's coordinates: lines stay lines, circular
 * edges become three-point arcs (full circles split in two), anything else is sampled
 * into short lines. The outer wire comes first.
 */
export function loopsOfFace(face: IFace, frame: PlaneFrame): Loop2[] {
    const outer = face.outerWire();
    const wires = face.findSubShapes(ShapeTypes.wire) as IWire[];
    try {
        const ordered = [outer, ...wires.filter((wire) => !wire.isSame(outer))];
        return ordered.map((wire) => loopOfWire(wire, frame));
    } finally {
        outer.dispose();
        for (const wire of wires) wire.dispose();
    }
}

function loopOfWire(wire: IWire, frame: PlaneFrame): Loop2 {
    const edges = wire.edgeLoop();
    const segments: Segment2[] = [];
    try {
        for (const edge of edges) segments.push(...segmentsOfEdge(edge, frame));
    } finally {
        for (const edge of edges) edge.dispose();
    }
    return chain(segments);
}

function segmentsOfEdge(edge: IEdge, frame: PlaneFrame): Segment2[] {
    const p = (point: XYZ): V2 => frame.local(v3(point));
    const first = edge.firstParameter();
    const last = edge.lastParameter();
    const at = (fraction: number) => p(edge.pointAt(first + (last - first) * fraction));
    const basis = edge.curve.basisCurve;
    if (CurveUtils.isLine(basis)) return [{ kind: "line", a: p(edge.startPoint()), b: p(edge.endPoint()) }];
    if (CurveUtils.isCircle(basis)) {
        const closed = Math.abs(Math.abs(last - first) - 2 * Math.PI) < 1e-9;
        if (closed) {
            return [
                { kind: "arc", a: at(0), mid: at(0.25), b: at(0.5) },
                { kind: "arc", a: at(0.5), mid: at(0.75), b: at(1) },
            ];
        }
        return [{ kind: "arc", a: at(0), mid: at(0.5), b: at(1) }];
    }
    const samples = 24;
    const points = Array.from({ length: samples + 1 }, (_, i) => at(i / samples));
    return points.slice(1).map((b, i) => ({ kind: "line", a: points[i], b }));
}

const close = (a: V2, b: V2) => Math.hypot(a[0] - b[0], a[1] - b[1]) < 1e-6;

const reversed = (segment: Segment2): Segment2 =>
    segment.kind === "line"
        ? { kind: "line", a: segment.b, b: segment.a }
        : { kind: "arc", a: segment.b, mid: segment.mid, b: segment.a };

/** Orders and orients segments head-to-tail into one closed loop. */
function chain(segments: Segment2[]): Loop2 {
    if (segments.length === 0) throw new SheetError("The blank outline is empty");
    const remaining = [...segments];
    const loop: Segment2[] = [remaining.shift() as Segment2];
    while (remaining.length > 0) {
        const tail = loop[loop.length - 1].b;
        const index = remaining.findIndex((segment) => close(segment.a, tail) || close(segment.b, tail));
        if (index < 0) throw new SheetError("The blank outline is not a closed loop");
        const [next] = remaining.splice(index, 1);
        loop.push(close(next.a, tail) ? next : reversed(next));
    }
    if (!close(loop[loop.length - 1].b, loop[0].a)) throw new SheetError("The blank outline is not closed");
    return loop;
}

/** Straight outline edges of the blank (outer loop and holes), as 2D segments. */
export function straightEdges(blank: readonly Loop2[]): { a: V2; b: V2 }[] {
    return blank.flatMap((loop) =>
        loop.flatMap((segment) => (segment.kind === "line" ? [{ a: segment.a, b: segment.b }] : [])),
    );
}
