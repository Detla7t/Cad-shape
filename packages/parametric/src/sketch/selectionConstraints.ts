// Part of the Chili3d Project, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

import { Result } from "@chili3d/core";
import {
    ConstraintKind,
    entityPointCount,
    isExternalEntityId,
    pointRefKey,
    type SketchConstraintData,
    type SketchPointRef,
} from "./sketchModel";
import type { SketchSolver } from "./solver";
import { arcStartRef, centerRef, isAssociativeConstraintKind, lineRefs } from "./solverEntities";

/** A constraint before the solver gives it an id. */
export type NewSketchConstraint = Omit<SketchConstraintData, "id">;

/** One selected sketch target: a point (endpoint, center, origin) or a whole entity. */
export type SketchSelectionTarget =
    | { kind: "point"; ref: SketchPointRef }
    | { kind: "entity"; entityId: number };

/** The constraint tools Onshape applies to a whole selection at once. */
export type SelectionConstraintTool =
    | "coincident"
    | "horizontal"
    | "vertical"
    | "parallel"
    | "equal"
    | "concentric"
    | "fix";

/**
 * The constraints that apply `tool` to a whole selection in one step, Onshape's way:
 * Horizontal/Vertical take one or more lines, or two or more points (aligned with the
 * first); Coincident two or more points, or points and one curve; Parallel and Equal
 * two or more lines (or, for Equal, circles and arcs), each related to the first;
 * Concentric two or more circles, arcs or points, with at least one circle or arc; Fix
 * anything. The first selected item is the reference the others follow.
 *
 * `undefined` when the selection is not a complete batch for the tool (one point for
 * Horizontal, one line for Parallel …): the tool then picks the rest interactively.
 * An error when the tool cannot apply to the selection at all. Pure: reads the
 * solver, adds nothing.
 */
export function selectionConstraints(
    solver: SketchSolver,
    tool: SelectionConstraintTool,
    targets: readonly SketchSelectionTarget[],
): Result<NewSketchConstraint[]> | undefined {
    const points = targets.flatMap((target) => (target.kind === "point" ? [target.ref] : []));
    const entities = targets.flatMap((target) => (target.kind === "entity" ? [target.entityId] : []));
    const typeOf = (id: number) => solver.entity(id)?.type;
    const kinds = TOOL_KINDS[tool];
    if (
        !kinds.some(isAssociativeConstraintKind) &&
        [...entities, ...points.map((ref) => ref.entityId)].some(isExternalEntityId)
    )
        return Result.err("External references only accept associative constraints");
    switch (tool) {
        case "horizontal":
        case "vertical":
            return axisBatch(solver, tool, points, entities);
        case "coincident":
            return coincidentBatch(solver, points, entities);
        case "parallel":
            if (entities.length < 2 && points.length === 0) return undefined;
            if (points.length > 0 || !entities.every((id) => typeOf(id) === "line"))
                return Result.err("Parallel applies to two or more lines");
            return Result.ok(
                entities.slice(1).map((id) => ({
                    kind: ConstraintKind.Parallel,
                    refs: [...lineRefs(entities[0]), ...lineRefs(id)],
                })),
            );
        case "equal":
            return equalBatch(solver, points, entities);
        case "concentric":
            return concentricBatch(solver, points, entities);
        case "fix":
            return Result.ok(fixConstraints(solver, points, entities));
    }
}

const TOOL_KINDS: Record<SelectionConstraintTool, readonly ConstraintKind[]> = {
    horizontal: [ConstraintKind.Horizontal, ConstraintKind.HorizontalAlign],
    vertical: [ConstraintKind.Vertical, ConstraintKind.VerticalAlign],
    coincident: [ConstraintKind.P2PCoincident],
    parallel: [ConstraintKind.Parallel],
    equal: [ConstraintKind.EqualLength],
    concentric: [ConstraintKind.P2PCoincident],
    fix: [ConstraintKind.Fix],
};

const isRound = (type: string | undefined) => type === "circle" || type === "arc";

function axisBatch(
    solver: SketchSolver,
    tool: "horizontal" | "vertical",
    points: SketchPointRef[],
    entities: number[],
): Result<NewSketchConstraint[]> | undefined {
    if (entities.length === 0 && points.length < 2) return undefined;
    if (!entities.every((id) => solver.entity(id)?.type === "line") || points.length === 1)
        return Result.err("Pick lines, or two or more points to align");
    const kind = tool === "horizontal" ? ConstraintKind.Horizontal : ConstraintKind.Vertical;
    const alignKind = tool === "horizontal" ? ConstraintKind.HorizontalAlign : ConstraintKind.VerticalAlign;
    return Result.ok([
        // a datum axis is already where the constraint would put it
        ...entities.filter((id) => !solver.isFixed(id)).map((id) => ({ kind, refs: lineRefs(id) })),
        ...distinctPoints(points)
            .slice(1)
            .map((ref) => ({ kind: alignKind, refs: [points[0], ref] })),
    ]);
}

function coincidentBatch(
    solver: SketchSolver,
    points: SketchPointRef[],
    entities: number[],
): Result<NewSketchConstraint[]> | undefined {
    const distinct = distinctPoints(points);
    if (entities.length === 0) {
        if (distinct.length < 2) return undefined;
        return Result.ok(
            distinct
                .slice(1)
                .map((ref) => ({ kind: ConstraintKind.P2PCoincident, refs: [distinct[0], ref] })),
        );
    }
    if (entities.length > 1) return Result.err("Coincident takes points, or points and one curve");
    if (distinct.length === 0) return undefined;
    const curve = entities[0];
    const onCurve = distinct.filter((ref) => ref.entityId !== curve);
    if (onCurve.length === 0) return Result.err("Pick a point from another entity");
    const constraints: NewSketchConstraint[] = [];
    for (const ref of onCurve) {
        const constraint = pointOnCurve(solver, ref, curve);
        if (constraint === undefined) return Result.err("Coincident places points on a line, circle or arc");
        constraints.push(constraint);
    }
    return Result.ok(constraints);
}

/** The incidence constraint putting `point` on the curve, or undefined for a curve without one. */
export function pointOnCurve(
    solver: SketchSolver,
    point: SketchPointRef,
    curve: number,
): NewSketchConstraint | undefined {
    switch (solver.entity(curve)?.type) {
        case "line":
            return { kind: ConstraintKind.PointOnLine, refs: [point, ...lineRefs(curve)] };
        case "circle":
            return { kind: ConstraintKind.PointOnCircle, refs: [point, centerRef(curve)] };
        case "arc":
            return { kind: ConstraintKind.PointOnArc, refs: [point, centerRef(curve), arcStartRef(curve)] };
        default:
            return undefined;
    }
}

function equalBatch(
    solver: SketchSolver,
    points: SketchPointRef[],
    entities: number[],
): Result<NewSketchConstraint[]> | undefined {
    if (entities.length < 2 && points.length === 0) return undefined;
    const types = entities.map((id) => solver.entity(id)?.type);
    const [first] = entities;
    if (points.length === 0 && types.every((type) => type === "line"))
        return Result.ok(
            entities.slice(1).map((id) => ({
                kind: ConstraintKind.EqualLength,
                refs: [...lineRefs(first), ...lineRefs(id)],
            })),
        );
    if (points.length === 0 && types.every(isRound))
        return Result.ok(entities.slice(1).map((id) => equalRadius(solver, first, id)));
    return Result.err("Equal requires two or more lines, or two or more circles or arcs");
}

/** Two arcs equate their center/start distances; a circle in the pair lends its radius param. */
function equalRadius(solver: SketchSolver, a: number, b: number): NewSketchConstraint {
    if (solver.entity(a)?.type === "arc" && solver.entity(b)?.type === "arc")
        return {
            kind: ConstraintKind.EqualArcRadius,
            refs: [centerRef(a), arcStartRef(a), centerRef(b), arcStartRef(b)],
        };
    return { kind: ConstraintKind.EqualRadius, refs: [centerRef(a), centerRef(b)] };
}

function concentricBatch(
    solver: SketchSolver,
    points: SketchPointRef[],
    entities: number[],
): Result<NewSketchConstraint[]> | undefined {
    if (entities.length + points.length < 2) return undefined;
    const types = entities.map((id) => solver.entity(id)?.type);
    if (!types.every((type) => isRound(type) || type === "point"))
        return Result.err("Concentric applies to circles, arcs and points");
    if (!types.some(isRound)) return Result.err("Concentric needs a circle or an arc");
    const centers = distinctPoints([...entities.map(centerRef), ...points]);
    return Result.ok(
        centers.slice(1).map((ref) => ({
            kind: ConstraintKind.P2PCoincident,
            refs: [centers[0], ref],
            role: "concentric" as const,
        })),
    );
}

/** Pins every selected point, and every point of each selected entity plus a circle's radius. */
function fixConstraints(
    solver: SketchSolver,
    points: SketchPointRef[],
    entities: number[],
): NewSketchConstraint[] {
    const refs = [...points];
    const constraints: NewSketchConstraint[] = [];
    for (const id of entities) {
        const entity = solver.entity(id);
        if (entity === undefined || solver.isFixed(id)) continue;
        for (let pointIndex = 0; pointIndex < entityPointCount(entity.type, entity.params); pointIndex++)
            refs.push({ entityId: id, pointIndex });
        if (entity.type === "circle")
            constraints.push({ kind: ConstraintKind.Radius, refs: [centerRef(id)], datum: entity.params[2] });
    }
    return [
        ...distinctPoints(refs)
            .filter((ref) => !solver.isFixed(ref.entityId))
            .map((ref) => ({ kind: ConstraintKind.Fix, refs: [ref], datums: [...solver.pointOf(ref)] })),
        ...constraints,
    ];
}

function distinctPoints(refs: readonly SketchPointRef[]): SketchPointRef[] {
    const seen = new Set<string>();
    return refs.filter((ref) => {
        const key = pointRefKey(ref);
        if (seen.has(key)) return false;
        seen.add(key);
        return true;
    });
}
