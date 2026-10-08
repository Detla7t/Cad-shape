// Part of the Chili3d Project, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

import { XYZ } from "@chili3d/core";
import { edgeSnapshotUV } from "../../sketch/externalRef";
import { sketchEntityEdge } from "../../sketch/sketchEntityEdge";
import {
    ConstraintKind,
    type SketchData,
    type SketchEntityData,
    type SketchPointRef,
    toUV,
} from "../../sketch/sketchModel";
import { appendEntity } from "../../sketch/sketchOperations";
import { SketchSolver } from "../../sketch/solver";
import { tangentConstraintFor } from "../../sketch/solverEntities";
import { ANGLE, expectQuantity, expectString, type FsMap, fail, LENGTH } from "../lang/values";
import { enumName } from "../std/registry";
import { MM_PER_METER, toKernelPlane } from "./fsContext";
import type { FsSketch } from "./sketch";

/** FeatureScript and interactive sketches use the same solver and kernel entity builder. */
export function solveSketchConstraints(sketch: FsSketch): void {
    if (!sketch.constraints.length && !sketch.initialGuesses.size) return;
    const plane = toKernelPlane(sketch.plane),
        data: SketchData = { entities: [], constraints: [] },
        byName = new Map<string, SketchEntityData>();
    for (const entity of sketch.entities) {
        if (entity.edges.length !== 1) continue;
        const snapshot = edgeSnapshotUV(plane, entity.edges[0]);
        if (!snapshot) continue;
        const id = appendEntity(data, snapshot.type, snapshot.params, { construction: entity.construction });
        byName.set(entity.id, data.entities.find((e) => e.id === id)!);
    }
    for (const point of sketch.points) {
        const uv = toUV(
            plane,
            new XYZ(...(point.position.map((v) => v * MM_PER_METER) as [number, number, number])),
        );
        const id = appendEntity(data, "point", uv);
        byName.set(point.id, data.entities.find((e) => e.id === id)!);
    }
    for (const [name, values] of sketch.initialGuesses) {
        const entity = byName.get(name);
        if (
            !entity ||
            !["line", "circle", "point"].includes(entity.type) ||
            values.length !== entity.params.length
        )
            fail(`skSetInitialGuess: unsupported seed for "${name}"`);
        entity.params = values.map((v) => v * MM_PER_METER);
    }
    for (const { id, definition } of sketch.constraints) {
        try {
            appendConstraint(
                data,
                byName,
                definition,
                new Set(sketch.entities.filter((e) => e.reverseEndpoints).map((e) => e.id)),
            );
        } catch (error) {
            fail(`skConstraint "${id}": ${error instanceof Error ? error.message : String(error)}`);
        }
    }
    const solver = new SketchSolver(plane, data);
    try {
        const outcome = solver.solve(true);
        if (!outcome.result.startsWith("Ok")) fail(`skSolve: ${outcome.result}`);
        for (const entity of sketch.entities) {
            const original = byName.get(entity.id);
            if (!original) continue;
            const solved = solver.entity(original.id)!;
            const edge = sketchEntityEdge(plane, solved);
            if (!edge.isOk) fail(`skSolve "${entity.id}": ${edge.error}`);
            sketch.context.track([edge.value]);
            entity.edges.splice(0, entity.edges.length, edge.value);
        }
        for (const point of sketch.points) {
            const original = byName.get(point.id)!;
            const p = solver.pointOf({ entityId: original.id, pointIndex: 0 });
            const world = plane.origin.add(plane.xvec.multiply(p[0])).add(plane.yvec.multiply(p[1]));
            point.position = [world.x / MM_PER_METER, world.y / MM_PER_METER, world.z / MM_PER_METER];
        }
    } finally {
        solver.dispose();
    }
}

type Target = { entity: SketchEntityData; point?: SketchPointRef };
function appendConstraint(
    data: SketchData,
    names: Map<string, SketchEntityData>,
    definition: FsMap,
    reversed: Set<string>,
): void {
    const kind = enumName(definition.field("constraintType"), "ConstraintType", "constraintType");
    if (kind === "NONE" || definition.field("driving") === false) return;
    for (const key of ["externalFirst", "externalSecond", "externalThird"])
        if (definition.field(key) !== undefined)
            fail(`${key} is not supported by the sketch constraint bridge yet`);
    const read = (field: string): Target => {
        const name = expectString(definition.field(field), field);
        const entity = names.get(name);
        if (entity)
            return {
                entity,
                point: entity.type === "point" ? { entityId: entity.id, pointIndex: 0 } : undefined,
            };
        const split = name.lastIndexOf("."),
            parent = names.get(name.slice(0, split)),
            suffix = name.slice(split + 1);
        if (!parent) fail(`Unknown or unsupported sketch entity "${name}"`);
        let index: number | undefined;
        if (suffix === "center" && ["circle", "arc"].includes(parent.type)) index = 0;
        if (suffix === "start" && parent.type === "line") index = 0;
        if (suffix === "end" && parent.type === "line") index = 1;
        if (suffix === "start" && parent.type === "arc") index = 1;
        if (suffix === "end" && parent.type === "arc") index = 2;
        if (index === undefined) fail(`Unsupported sketch point "${name}"`);
        if (parent.type === "arc" && index > 0 && reversed.has(name.slice(0, split))) index = 3 - index;
        return { entity: parent, point: { entityId: parent.id, pointIndex: index } };
    };
    const first = read("localFirst"),
        second = definition.field("localSecond") === undefined ? undefined : read("localSecond");
    const point = (t: Target | undefined): SketchPointRef => {
        if (!t?.point) fail("Expected a sketch point reference");
        return t.point;
    };
    const center = (t: Target | undefined): SketchPointRef => {
        if (!t || !["circle", "arc"].includes(t.entity.type)) fail("Expected a circle or arc");
        return { entityId: t.entity.id, pointIndex: 0 };
    };
    const line = (t: Target | undefined): SketchPointRef[] => {
        if (!t || t.entity.type !== "line") fail("Expected a line");
        return [0, 1].map((pointIndex) => ({ entityId: t.entity.id, pointIndex }));
    };
    const add = (kind: ConstraintKind, refs: SketchPointRef[], datum?: number, datums?: number[]) =>
        data.constraints.push({
            id: Math.max(0, ...data.constraints.map((c) => c.id)) + 1,
            kind,
            refs,
            datum,
            datums,
        });
    const length = () => expectQuantity(definition.field("length"), LENGTH, "length") * MM_PER_METER;
    switch (kind) {
        case "COINCIDENT": {
            if (first.point && second?.point) {
                add(ConstraintKind.P2PCoincident, [first.point, second.point]);
                return;
            }
            const p = first.point ? first : second,
                curve = first.point ? second : first;
            if (!curve) fail("Coincident needs a second entity");
            if (curve.entity.type === "line") add(ConstraintKind.PointOnLine, [point(p), ...line(curve)]);
            else if (curve.entity.type === "circle")
                add(ConstraintKind.PointOnCircle, [point(p), center(curve)]);
            else if (curve.entity.type === "arc")
                add(ConstraintKind.PointOnArc, [
                    point(p),
                    center(curve),
                    { entityId: curve.entity.id, pointIndex: 1 },
                ]);
            else fail("Unsupported coincident curve");
            return;
        }
        case "HORIZONTAL":
        case "VERTICAL":
            add(
                kind === "HORIZONTAL" ? ConstraintKind.Horizontal : ConstraintKind.Vertical,
                second ? [point(first), point(second)] : line(first),
            );
            return;
        case "PARALLEL":
        case "PERPENDICULAR":
            add(kind === "PARALLEL" ? ConstraintKind.Parallel : ConstraintKind.Perpendicular, [
                ...line(first),
                ...line(second),
            ]);
            return;
        case "CONCENTRIC":
            add(ConstraintKind.P2PCoincident, [center(first), center(second)]);
            return;
        case "MIDPOINT":
            add(ConstraintKind.Midpoint, [point(first), ...line(second)]);
            return;
        case "TANGENT": {
            const tangent = tangentConstraintFor(
                first.entity.type,
                first.entity.id,
                second?.entity.type,
                second?.entity.id ?? 0,
            );
            if (!tangent) fail("Unsupported tangent pair");
            add(tangent.kind, tangent.refs);
            return;
        }
        case "EQUAL":
            if (first.entity.type === "line")
                add(ConstraintKind.EqualLength, [...line(first), ...line(second)]);
            else if (first.entity.type === "circle" && second?.entity.type === "circle")
                add(ConstraintKind.EqualRadius, [center(first), center(second)]);
            else if (first.entity.type === "arc" && second?.entity.type === "arc")
                add(ConstraintKind.EqualArcRadius, [
                    center(first),
                    { entityId: first.entity.id, pointIndex: 1 },
                    center(second),
                    { entityId: second.entity.id, pointIndex: 1 },
                ]);
            else fail("Unsupported equal pair");
            return;
        case "LENGTH":
            add(ConstraintKind.P2PDistance, line(first), length());
            return;
        case "RADIUS":
        case "DIAMETER":
            add(ConstraintKind.Radius, [center(first)], length() / (kind === "DIAMETER" ? 2 : 1));
            return;
        case "DISTANCE": {
            const direction =
                definition.field("direction") === undefined
                    ? "MINIMUM"
                    : enumName(definition.field("direction"), "DimensionDirection", "direction");
            if (!["MINIMUM", "ALIGNED", "HORIZONTAL", "VERTICAL"].includes(direction))
                fail(`Unsupported distance direction "${direction}"`);
            if (!first.point || !second?.point)
                fail("Distance between curves is not supported by the sketch constraint bridge yet");
            const k =
                direction === "HORIZONTAL"
                    ? ConstraintKind.HorizontalDistance
                    : direction === "VERTICAL"
                      ? ConstraintKind.VerticalDistance
                      : ConstraintKind.P2PDistance;
            add(k, [first.point, second.point], length());
            return;
        }
        case "ANGLE":
            add(
                ConstraintKind.Angle,
                [...line(first), ...line(second)],
                expectQuantity(definition.field("angle"), ANGLE, "angle"),
            );
            return;
        case "FIX": {
            const refs = first.point
                ? [first.point]
                : Array.from(
                      { length: first.entity.type === "line" ? 2 : first.entity.type === "arc" ? 3 : 1 },
                      (_, pointIndex) => ({ entityId: first.entity.id, pointIndex }),
                  );
            for (const ref of refs)
                add(
                    ConstraintKind.Fix,
                    [ref],
                    undefined,
                    first.entity.params.slice(ref.pointIndex * 2, ref.pointIndex * 2 + 2),
                );
            if (!first.point && first.entity.type === "circle")
                add(ConstraintKind.Radius, [center(first)], first.entity.params[2]);
            return;
        }
        default:
            fail(`ConstraintType.${kind} is not supported yet`);
    }
}
