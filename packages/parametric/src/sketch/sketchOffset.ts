// Part of the Chili3d Project, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

import { type IEdge, type IShape, type Plane, ShapeTypes } from "@chili3d/core";
import { collectEdges, groupConnected, hasBranchVertex } from "../features/profileGeometry";
import { edgeSnapshotUV } from "./externalRef";
import { sketchEntityEdge } from "./sketchEntityEdge";
import { ConstraintKind, type SketchData, type SketchEntityData } from "./sketchModel";
import { appendEntity, circleData, distance, intersections } from "./sketchOperations";

/** Offset entire connected chains so adjoining segments retain a common corner. */
export function offsetSketchEntities(data: SketchData, ids: number[], amount: number, plane: Plane): void {
    if (!Number.isFinite(amount) || Math.abs(amount) < 1e-8) throw new Error("Enter a nonzero offset.");
    const owned: IShape[] = [],
        edges: IEdge[] = [],
        output: SketchEntityData[] = [];
    try {
        for (const entity of data.entities.filter((e) => ids.includes(e.id))) {
            if (!["line", "circle", "arc"].includes(entity.type))
                throw new Error("Offset currently supports lines, circles and arcs.");
            const edge = sketchEntityEdge(plane, entity);
            if (!edge.isOk) throw new Error(edge.error);
            owned.push(edge.value);
            edges.push(edge.value);
        }
        for (const group of groupConnected(edges)) {
            if (hasBranchVertex(group)) throw new Error("Select a chain without branches to offset.");
            const wire = shapeFactory.wire(group);
            if (!wire.isOk) throw new Error(wire.error);
            owned.push(wire.value);
            if (!wire.value.isClosed()) {
                output.push(...offsetOpenChain(group, amount, plane));
                continue;
            }
            const result = wire.value.offset(amount, "intersection");
            if (!result.isOk || result.value.isNull()) throw new Error("The offset collapses this chain.");
            owned.push(result.value);
            const parts =
                result.value.shapeType === ShapeTypes.edge
                    ? [result.value as IEdge]
                    : collectEdges(result.value);
            if (!parts.length) throw new Error("The offset collapses this chain.");
            for (const edge of parts) {
                if (edge !== result.value) owned.push(edge);
                const snapshot = edgeSnapshotUV(plane, edge);
                if (!snapshot) throw new Error("The offset produced an unsupported curve.");
                output.push({ id: 0, ...snapshot });
            }
        }
        const added = output.map((e) => ({ ...e, id: appendEntity(data, e.type, e.params) }));
        // Keep adjacent endpoints joined when the result is subsequently dragged.
        const endpoints = added.flatMap((e) =>
            e.type === "line"
                ? [0, 1].map((i) => ({
                      ref: { entityId: e.id, pointIndex: i },
                      at: e.params.slice(i * 2, i * 2 + 2) as [number, number],
                  }))
                : e.type === "arc"
                  ? [1, 2].map((i) => ({
                        ref: { entityId: e.id, pointIndex: i },
                        at: e.params.slice(i * 2, i * 2 + 2) as [number, number],
                    }))
                  : [],
        );
        let cid = Math.max(0, ...data.constraints.map((c) => c.id)) + 1;
        for (let i = 0; i < endpoints.length; i++)
            for (let j = i + 1; j < endpoints.length; j++) {
                if (
                    endpoints[i].ref.entityId !== endpoints[j].ref.entityId &&
                    distance(endpoints[i].at, endpoints[j].at) < 1e-6
                )
                    data.constraints.push({
                        id: cid++,
                        kind: ConstraintKind.P2PCoincident,
                        refs: [endpoints[i].ref, endpoints[j].ref],
                    });
            }
    } finally {
        for (const shape of owned.reverse()) shape.dispose();
    }
}

function offsetOpenChain(edges: IEdge[], amount: number, plane: Plane): SketchEntityData[] {
    const entities = edges.map((edge) => {
        const value = edgeSnapshotUV(plane, edge);
        if (!value) throw new Error("The offset produced an unsupported curve.");
        return { id: 0, ...value };
    });
    const ends = (e: SketchEntityData) =>
        (e.type === "line" ? [0, 2] : [2, 4]).map((i) => e.params.slice(i, i + 2) as [number, number]);
    const allEnds = entities.flatMap(ends),
        start = allEnds.find((p) => allEnds.filter((q) => distance(p, q) < 1e-6).length === 1);
    if (!start) throw new Error("Select one open chain to offset.");
    let head = start;
    const output: SketchEntityData[] = [],
        joins: [number, number][] = [],
        reversed: boolean[] = [];
    while (entities.length) {
        const index = entities.findIndex((e) => ends(e).some((p) => distance(p, head) < 1e-6));
        if (index < 0) throw new Error("The selected chain is disconnected.");
        const e = entities.splice(index, 1)[0],
            points = ends(e),
            reverse = distance(points[1], head) < 1e-6;
        joins.push(head);
        reversed.push(reverse);
        head = points[reverse ? 0 : 1];
        const p = e.params,
            direction = reverse ? -1 : 1;
        if (e.type === "line") {
            const length = distance(points[0], points[1]),
                nx = (-(p[3] - p[1]) / length) * amount * direction,
                ny = ((p[2] - p[0]) / length) * amount * direction;
            output.push({ ...e, params: [p[0] + nx, p[1] + ny, p[2] + nx, p[3] + ny] });
        } else {
            const { r } = circleData(e),
                radius = r - amount * direction;
            if (radius <= 1e-8) throw new Error("The offset collapses this arc.");
            output.push({
                ...e,
                params: [p[0], p[1], ...p.slice(2).map((v, i) => p[i % 2] + ((v - p[i % 2]) * radius) / r)],
            });
        }
    }
    const unbounded = (e: SketchEntityData): SketchEntityData =>
        e.type === "arc" ? { ...e, type: "circle", params: [...e.params.slice(0, 2), circleData(e).r] } : e;
    const setEnd = (e: SketchEntityData, end: boolean, at: [number, number]) =>
        e.params.splice(e.type === "line" ? (end ? 2 : 0) : end ? 4 : 2, 2, ...at);
    for (let i = 1; i < output.length; i++) {
        const a = output[i - 1],
            b = output[i],
            ap = ends(a)[reversed[i - 1] ? 0 : 1],
            bp = ends(b)[reversed[i] ? 1 : 0];
        const candidates =
            distance(ap, bp) < 1e-6 ? [ap] : intersections(unbounded(a), unbounded(b), true, true);
        candidates.sort((x, y) => distance(x, joins[i]) - distance(y, joins[i]));
        if (!candidates.length) throw new Error("These offset segments do not meet.");
        setEnd(a, !reversed[i - 1], candidates[0]);
        setEnd(b, reversed[i], candidates[0]);
    }
    return output;
}
