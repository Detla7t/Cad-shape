// Part of the Chili3d Project, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

import { AsyncController, command, type ParameterValue, PubSub } from "@chili3d/core";
import { angleDimensionChoice, parallelLines, pointDimensionChoice } from "../editor/dimensionChoice";
import {
    type DimensionAnchor,
    lineIntersection,
    pointLineFoot,
    pointLineSignedDistance,
    segmentOffset,
    toDisplayDatum,
    toStorageDatum,
} from "../editor/dimensionLayout";
import type { DimensionPreview } from "../editor/sketchAnnotations";
import { SketchEditor } from "../editor/sketchEditor";
import {
    ConstraintKind,
    datumUnitSpec,
    dimensionInputSource,
    entityRadius,
    isDatumEntityId,
    pointRefKey,
    type SketchConstraintData,
    type SketchData,
    type SketchPointRef,
} from "../sketchModel";
import type { SketchSolver } from "../solver";
import { allowsConstraintOnEntity } from "../solverEntities";
import { SketchConstraintCommand } from "./sketchConstraints";

@command({ key: "dimension.distance", icon: "icon-dDimension" })
export class DistanceDimensionCommand extends SketchConstraintCommand {
    protected async executeWithEditor(editor: SketchEditor): Promise<void> {
        this.controller = new AsyncController();
        const first = await editor.pickPointOrEntity("prompt.pickSketchPointOrEntity", this.controller);
        if (!first) return;
        const firstId = first.kind === "entity" ? first.entityId : first.ref.entityId;
        if (!allowsConstraintOnEntity(ConstraintKind.P2PDistance, firstId)) return;
        const firstEntity = first.kind === "entity" ? editor.solver.entity(first.entityId) : undefined;
        const before = editor.solver.toData();
        const round = firstEntity?.type === "circle" || firstEntity?.type === "arc";
        const single =
            !isDatumEntityId(firstId) &&
            ((round &&
                !before.constraints.some(
                    (c) => c.kind === ConstraintKind.Radius && c.refs[0]?.entityId === firstId,
                )) ||
                (firstEntity?.type === "line" &&
                    !before.constraints.some(
                        (c) =>
                            [
                                ConstraintKind.P2PDistance,
                                ConstraintKind.HorizontalDistance,
                                ConstraintKind.VerticalDistance,
                            ].includes(c.kind) && c.refs.every((r) => r.entityId === firstId),
                    )));
        this.controller = new AsyncController();
        const next = single
            ? await pickWithPreview(editor, () =>
                  editor.pickDimensionTarget(
                      (uv) => {
                          editor.annotations.setDimensionPreview(
                              uv
                                  ? round
                                      ? {
                                            kind: "radius",
                                            center: [firstEntity.params[0], firstEntity.params[1]],
                                            radius: entityRadius(firstEntity),
                                            diameter: firstEntity.type === "circle",
                                            position: uv,
                                        }
                                      : pointDimensionChoice(
                                            editor.solver.pointOf({ entityId: firstId, pointIndex: 0 }),
                                            editor.solver.pointOf({ entityId: firstId, pointIndex: 1 }),
                                            uv,
                                        ).preview
                                  : undefined,
                          );
                      },
                      this.controller!,
                      first,
                  ),
              )
            : await editor.pickPointOrEntity("prompt.pickSketchPointOrEntity", this.controller, first);
        if (!next) return;
        if (next.kind === "position") {
            if (round) {
                const radius = entityRadius(firstEntity);
                const diameter = firstEntity.type === "circle";
                const anchor: DimensionAnchor = {
                    kind: "vector",
                    dx: next.position[0] - firstEntity.params[0],
                    dy: next.position[1] - firstEntity.params[1],
                    diameter,
                };
                commitDimension(
                    editor,
                    {
                        kind: ConstraintKind.Radius,
                        refs: [{ entityId: firstId, pointIndex: 0 }],
                        datum: radius,
                    },
                    anchor,
                    diameter ? radius * 2 : radius,
                    {
                        rollback: before,
                        repeat: true,
                        apply: (id, value) =>
                            editor.solver.setDatumSource(id, dimensionInputSource(value, anchor)),
                    },
                );
            } else {
                commitPointDimension(
                    editor,
                    { entityId: firstId, pointIndex: 0 },
                    { entityId: firstId, pointIndex: 1 },
                    next.position,
                    before,
                );
            }
            return;
        }
        const secondId = next.kind === "entity" ? next.entityId : next.ref.entityId;
        if (!allowsConstraintOnEntity(ConstraintKind.P2PDistance, secondId)) return;
        const secondEntity = next.kind === "entity" ? editor.solver.entity(next.entityId) : undefined;
        if (firstEntity?.type === "line" && secondEntity?.type === "line") {
            this.controller = new AsyncController();
            if (!parallelLines(editor.solver, firstId, secondId)) {
                const position = await pickDimensionPosition(editor, this.controller, (uv) =>
                    uv ? angleDimensionChoice(editor.solver, firstId, secondId, uv)?.preview : undefined,
                );
                if (!position) return;
                const choice = angleDimensionChoice(editor.solver, firstId, secondId, position);
                if (!choice) return;
                commitDimension(
                    editor,
                    { kind: ConstraintKind.Angle, refs: choice.refs, datum: choice.datum },
                    choice.anchor,
                    toDisplayDatum(ConstraintKind.Angle, choice.datum),
                    { rollback: before, repeat: true, positiveOnly: false },
                );
                return;
            }
            // A distance between lines preserves their parallel relationship when edited.
            const refs = [firstId, secondId].flatMap((entityId) => [
                { entityId, pointIndex: 0 },
                { entityId, pointIndex: 1 },
            ]);
            const oriented =
                before.constraints.some(
                    (c) =>
                        c.kind === ConstraintKind.Parallel &&
                        [firstId, secondId].every((id) => c.refs.some((r) => r.entityId === id)),
                ) ||
                [ConstraintKind.Horizontal, ConstraintKind.Vertical].some((kind) =>
                    [firstId, secondId].every((id) =>
                        before.constraints.some((c) => c.kind === kind && c.refs[0]?.entityId === id),
                    ),
                );
            if (!oriented) editor.solver.addConstraint({ kind: ConstraintKind.Parallel, refs });
            const placed = await placePointLine(editor, refs[0], secondId, this.controller, before, true);
            if (!placed) {
                editor.solver.reset(before);
                editor.solve(true);
            }
            return;
        }
        let p1 = first.kind === "point" ? first.ref : { entityId: firstId, pointIndex: 0 };
        let p2 = next.kind === "point" ? next.ref : { entityId: secondId, pointIndex: 0 };
        const line =
            firstEntity?.type === "line"
                ? firstEntity
                : secondEntity?.type === "line"
                  ? secondEntity
                  : undefined;
        if (line) {
            let point = line.id === firstId ? p2 : p1;
            const other = line.id === firstId ? secondEntity : firstEntity;
            if (other?.type === "circle" || other?.type === "arc") {
                const center = editor.solver.pointOf(point),
                    p = line.params;
                const foot = pointLineFoot(center, [p[0], p[1]], [p[2], p[3]]) ?? [p[0], p[1]];
                point = circleEdgePoint(editor, other.id, foot);
                editor.solver.addConstraint({
                    kind: ConstraintKind.Perpendicular,
                    refs: [
                        { entityId: point.entityId, pointIndex: 0 },
                        point,
                        { entityId: line.id, pointIndex: 0 },
                        { entityId: line.id, pointIndex: 1 },
                    ],
                });
            }
            this.controller = new AsyncController();
            const placed = await placePointLine(editor, point, line.id, this.controller, before, true);
            if (!placed) {
                editor.solver.reset(before);
                editor.solve(true);
            }
            return;
        }
        // An edge selection measures from the circumference; a center point measures from the center.
        const toward1 = editor.solver.pointOf(p2),
            toward2 = editor.solver.pointOf(p1);
        if (round) p1 = circleEdgePoint(editor, firstId, toward1);
        const secondRound = secondEntity?.type === "circle" || secondEntity?.type === "arc";
        if (secondRound) p2 = circleEdgePoint(editor, secondId, toward2);
        if (round)
            editor.solver.addConstraint({
                kind: ConstraintKind.PointOnLine,
                refs: [p2, { entityId: p1.entityId, pointIndex: 0 }, p1],
            });
        if (secondRound)
            editor.solver.addConstraint({
                kind: ConstraintKind.PointOnLine,
                refs: [p1, { entityId: p2.entityId, pointIndex: 0 }, p2],
            });
        const uv1 = editor.solver.pointOf(p1),
            uv2 = editor.solver.pointOf(p2);
        this.controller = new AsyncController();
        const position = await pickDimensionPosition(editor, this.controller, (uv) =>
            uv ? pointDimensionChoice(uv1, uv2, uv).preview : undefined,
        );
        if (!position) {
            editor.solver.reset(before);
            editor.solve(true);
            return;
        }
        commitPointDimension(editor, p1, p2, position, before);
    }
}

function commitPointDimension(
    editor: SketchEditor,
    p1: SketchPointRef,
    p2: SketchPointRef,
    position: [number, number],
    before: SketchData,
): void {
    const choice = pointDimensionChoice(editor.solver.pointOf(p1), editor.solver.pointOf(p2), position);
    const refs = normalizeLineRefs(editor.solver, p1, p2);
    if (choice.datum < 0) refs.reverse();
    commitDimension(
        editor,
        { kind: choice.kind, refs, datum: Math.abs(choice.datum) },
        choice.anchor,
        Math.abs(choice.datum),
        { rollback: before, repeat: true, positiveOnly: choice.kind === ConstraintKind.P2PDistance },
    );
}

@command({ key: "dimension.radius", icon: "icon-dRadius" })
export class RadiusDimensionCommand extends SketchConstraintCommand {
    protected async executeWithEditor(editor: SketchEditor): Promise<void> {
        this.controller = new AsyncController();
        const entityId = await editor.pickEntity(
            "prompt.pickSketchEntity",
            ["circle", "arc"],
            undefined,
            this.controller,
        );
        if (entityId === undefined || !allowsConstraintOnEntity(ConstraintKind.Radius, entityId)) return;

        this.controller = new AsyncController();
        await placeRadius(editor, entityId, this.controller);
    }
}

async function placeRadius(
    editor: SketchEditor,
    entityId: number,
    controller: AsyncController,
): Promise<void> {
    const entity = editor.solver.entity(entityId)!;
    const center: [number, number] = [entity.params[0], entity.params[1]];
    const radius = entityRadius(entity);
    const position = await pickDimensionPosition(editor, controller, (uv) =>
        uv === undefined ? undefined : { kind: "radius", center, radius, position: uv },
    );
    if (position === undefined) return;

    // anchor the label as a vector from the center so it follows the geometry
    commitDimension(
        editor,
        {
            kind: ConstraintKind.Radius,
            refs: [{ entityId, pointIndex: 0 }],
            datum: radius,
        },
        { kind: "vector", dx: position[0] - center[0], dy: position[1] - center[1] },
        radius,
    );
}

/** Runs a pick with a live dimension preview, always clearing the preview afterwards. */
async function pickWithPreview<T>(
    editor: SketchEditor,
    pick: () => Promise<T | undefined>,
): Promise<T | undefined> {
    try {
        return await pick();
    } finally {
        editor.annotations.setDimensionPreview(undefined);
    }
}

/**
 * Picks the dimension-label position with the dimension previewed live. The controller
 * takes the command's slot so `cancel()` aborts exactly this pick, and the preview is
 * cleared once it ends — the placement step the distance-dimension commands share.
 */
async function pickDimensionPosition(
    editor: SketchEditor,
    controller: AsyncController,
    preview: (uv: [number, number] | undefined) => DimensionPreview | undefined,
): Promise<[number, number] | undefined> {
    return pickWithPreview(editor, () =>
        editor.pickPosition(
            "prompt.pickDimensionPosition",
            (uv) => editor.annotations.setDimensionPreview(preview(uv)),
            controller,
        ),
    );
}

/**
 * Creates the constraint right away so the dimension stays visible while the
 * input is open, but commits only on confirm — creation + datum land in a
 * single undo step; cancelling rolls the constraint back from the solver.
 */
function commitDimension(
    editor: SketchEditor,
    constraint: Omit<SketchConstraintData, "id">,
    anchor: DimensionAnchor,
    initial: ParameterValue,
    options?: {
        apply?: (id: number, value: ParameterValue) => void;
        positiveOnly?: boolean;
        rollback?: SketchData;
        repeat?: boolean;
    },
): void {
    const id = editor.solver.addConstraint(constraint);
    editor.dimensionAnchors.set(id, anchor);
    editor.solve(true);
    editor.promptDatum(
        initial,
        (value) => (options?.apply ?? ((cid, v) => editor.solver.setDatumSource(cid, v)))(id, value),
        datumUnitSpec(constraint.kind),
        () => {
            if (options?.rollback) editor.solver.reset(options.rollback);
            else editor.solver.removeConstraint(id);
            editor.dimensionAnchors.delete(id);
            editor.solve(true);
        },
        {
            positiveOnly: options?.positiveOnly,
            constraintId: id,
            onAccepted: options?.repeat
                ? () => {
                      editor.clearSelection();
                      queueMicrotask(() => {
                          if (SketchEditor.getActive() === editor)
                              PubSub.default.pub("executeCommand", "dimension.distance");
                      });
                  }
                : undefined,
        },
    );
}

/**
 * Endpoints shared with neighbours through coincident constraints make the
 * picked refs point at different entities for what is one line. Rewrite such
 * refs to that line's own endpoints so the dimension — and its hover
 * highlight — belongs to the line the user sees.
 */
function normalizeLineRefs(
    solver: SketchSolver,
    p1: SketchPointRef,
    p2: SketchPointRef,
): [SketchPointRef, SketchPointRef] {
    if (p1.entityId === p2.entityId) return [p1, p2];
    const coincident = (a: SketchPointRef, b: SketchPointRef) =>
        solver.coincidentGroup(a).some((r) => pointRefKey(r) === pointRefKey(b));
    for (const entity of solver.entities()) {
        if (entity.type !== "line") continue;
        const start: SketchPointRef = { entityId: entity.id, pointIndex: 0 };
        const end: SketchPointRef = { entityId: entity.id, pointIndex: 1 };
        if (coincident(start, p1) && coincident(end, p2)) return [start, end];
        if (coincident(start, p2) && coincident(end, p1)) return [end, start];
    }
    return [p1, p2];
}

@command({ key: "dimension.pointLineDistance", icon: "icon-cPointLineDistance" })
export class PointLineDistanceCommand extends SketchConstraintCommand {
    protected async executeWithEditor(editor: SketchEditor): Promise<void> {
        this.controller = new AsyncController();
        const p = await editor.pickPoint("prompt.pickSketchPoint", undefined, this.controller);
        if (p === undefined || !allowsConstraintOnEntity(ConstraintKind.P2LDistance, p.entityId)) return;
        this.controller = new AsyncController();
        const lineId = await editor.pickEntity(
            "prompt.pickSketchEntity",
            "line",
            { datum: true },
            this.controller,
        );
        if (lineId === undefined || !allowsConstraintOnEntity(ConstraintKind.P2LDistance, lineId)) return;

        const l1: SketchPointRef = { entityId: lineId, pointIndex: 0 };
        const l2: SketchPointRef = { entityId: lineId, pointIndex: 1 };
        const uvP = editor.solver.pointOf(p);
        const uv1 = editor.solver.pointOf(l1);
        const uv2 = editor.solver.pointOf(l2);
        this.controller = new AsyncController();
        const position = await pickDimensionPosition(editor, this.controller, (uv) =>
            uv === undefined ? undefined : { kind: "pointLine", p: uvP, l1: uv1, l2: uv2, position: uv },
        );
        if (position === undefined) return;

        // anchor the label perpendicular to the point→foot segment so it follows the geometry
        const foot = pointLineFoot(uvP, uv1, uv2) ?? uv1;
        // signed datum (display convention: positive = left of the line direction);
        // a signed value keeps the point on its current side instead of mirroring it
        const initial = pointLineSignedDistance(uvP, uv1, uv2);
        commitDimension(
            editor,
            {
                kind: ConstraintKind.P2LDistance,
                refs: [p, l1, l2],
                datum: toStorageDatum(ConstraintKind.P2LDistance, initial),
            },
            { kind: "offset", offset: segmentOffset(uvP, foot, position) },
            initial,
            { positiveOnly: false },
        );
    }
}

@command({ key: "dimension.angle", icon: "icon-dAngle" })
export class AngleDimensionCommand extends SketchConstraintCommand {
    protected async executeWithEditor(editor: SketchEditor): Promise<void> {
        this.controller = new AsyncController();
        // datum: true — angles against the X/Y axes are a common reference
        const l1Id = await editor.pickEntity(
            "prompt.pickSketchEntity",
            "line",
            { datum: true },
            this.controller,
        );
        if (l1Id === undefined || !allowsConstraintOnEntity(ConstraintKind.Angle, l1Id)) return;
        this.controller = new AsyncController();
        const l2Id = await editor.pickEntity(
            "prompt.pickSketchEntity",
            "line",
            { datum: true },
            this.controller,
        );
        if (l2Id === undefined || !allowsConstraintOnEntity(ConstraintKind.Angle, l2Id)) return;

        const refs: SketchPointRef[] = [
            { entityId: l1Id, pointIndex: 0 },
            { entityId: l1Id, pointIndex: 1 },
            { entityId: l2Id, pointIndex: 0 },
            { entityId: l2Id, pointIndex: 1 },
        ];
        const [a1, a2, b1, b2] = refs.map((r) => editor.solver.pointOf(r));
        // A fresh controller, like every other placement step: without one the pick is left
        // riding the previous step's controller, and `cancel()` only reaches it while that
        // one happens to still be unresolved.
        this.controller = new AsyncController();
        const position = await pickDimensionPosition(editor, this.controller, (uv) =>
            uv === undefined ? undefined : { kind: "angle", a1, a2, b1, b2, position: uv },
        );
        if (position === undefined) return;

        // vertex = line intersection; parallel lines fall back to the centroid so the
        // label anchor still has a sensible reference point
        const vertex = lineIntersection(a1, a2, b1, b2) ?? [
            (a1[0] + a2[0] + b1[0] + b2[0]) / 4,
            (a1[1] + a2[1] + b1[1] + b2[1]) / 4,
        ];
        const d1: [number, number] = [a2[0] - a1[0], a2[1] - a1[1]];
        const d2: [number, number] = [b2[0] - b1[0], b2[1] - b1[1]];
        // signed sweep from d1 to d2: the sign records which side of the first
        // line the second line sits on, so later magnitude edits keep the angle
        // in place instead of flipping the line across its reference
        const initialRad = Math.atan2(d1[0] * d2[1] - d1[1] * d2[0], d1[0] * d2[0] + d1[1] * d2[1]);

        commitDimension(
            editor,
            { kind: ConstraintKind.Angle, refs, datum: initialRad },
            { kind: "vector", dx: position[0] - vertex[0], dy: position[1] - vertex[1] },
            toDisplayDatum(ConstraintKind.Angle, initialRad),
        );
    }
}

abstract class AxisDistanceCommand extends SketchConstraintCommand {
    protected abstract readonly axis: "h" | "v";

    protected async executeWithEditor(editor: SketchEditor): Promise<void> {
        const kind = this.axis === "h" ? ConstraintKind.HorizontalDistance : ConstraintKind.VerticalDistance;
        this.controller = new AsyncController();
        const p1 = await editor.pickPoint("prompt.pickSketchPoint", undefined, this.controller);
        if (p1 === undefined || !allowsConstraintOnEntity(kind, p1.entityId)) return;
        this.controller = new AsyncController();
        const p2 = await editor.pickPoint("prompt.pickSketchPoint", undefined, this.controller);
        if (p2 === undefined || !allowsConstraintOnEntity(kind, p2.entityId)) return;

        const uv1 = editor.solver.pointOf(p1);
        const uv2 = editor.solver.pointOf(p2);
        const axis = this.axis;
        this.controller = new AsyncController();
        const position = await pickDimensionPosition(editor, this.controller, (uv) =>
            uv === undefined ? undefined : { kind: "axisDistance", p1: uv1, p2: uv2, axis, position: uv },
        );
        if (position === undefined) return;

        // offset along the cross axis from the points' midline
        const base = axis === "h" ? (uv1[1] + uv2[1]) / 2 : (uv1[0] + uv2[0]) / 2;
        const offset = (axis === "h" ? position[1] : position[0]) - base;
        const initial = axis === "h" ? uv2[0] - uv1[0] : uv2[1] - uv1[1];
        commitDimension(
            editor,
            {
                kind,
                refs: [p1, p2],
                datum: initial,
            },
            { kind: "offset", offset },
            initial,
            { positiveOnly: false },
        );
    }
}

@command({ key: "dimension.horizontalDistance", icon: "icon-dDimensionH" })
export class HorizontalDistanceCommand extends AxisDistanceCommand {
    protected readonly axis = "h";
}

@command({ key: "dimension.verticalDistance", icon: "icon-dDimensionV" })
export class VerticalDistanceCommand extends AxisDistanceCommand {
    protected readonly axis = "v";
}

/** A construction point carries the measured edge, so a circle edge and its center remain distinct picks. */
function circleEdgePoint(editor: SketchEditor, id: number, toward: [number, number]): SketchPointRef {
    const circle = editor.solver.entity(id)!,
        center = circle.params;
    const angle = Math.atan2(toward[1] - center[1], toward[0] - center[0]),
        radius = entityRadius(circle);
    const pointId = editor.solver.addEntity("line", [
        center[0],
        center[1],
        center[0] + radius * Math.cos(angle),
        center[1] + radius * Math.sin(angle),
    ]);
    editor.solver.setEntityStyle(pointId, { construction: true });
    const ref = { entityId: pointId, pointIndex: 1 };
    editor.solver.addConstraint({
        kind: ConstraintKind.P2PCoincident,
        refs: [
            { entityId: pointId, pointIndex: 0 },
            { entityId: id, pointIndex: 0 },
        ],
    });
    editor.solver.addConstraint({
        kind: circle.type === "circle" ? ConstraintKind.PointOnCircle : ConstraintKind.PointOnArc,
        refs:
            circle.type === "circle"
                ? [ref, { entityId: id, pointIndex: 0 }]
                : [ref, { entityId: id, pointIndex: 0 }, { entityId: id, pointIndex: 1 }],
    });
    return ref;
}
async function placePointLine(
    editor: SketchEditor,
    p: SketchPointRef,
    lineId: number,
    controller: AsyncController,
    rollback?: SketchData,
    repeat = false,
): Promise<boolean> {
    let l1 = { entityId: lineId, pointIndex: 0 },
        l2 = { entityId: lineId, pointIndex: 1 };
    const uvP = editor.solver.pointOf(p);
    let a = editor.solver.pointOf(l1),
        b = editor.solver.pointOf(l2);
    if (repeat && pointLineSignedDistance(uvP, a, b) < 0) {
        [l1, l2] = [l2, l1];
        [a, b] = [b, a];
    }
    const position = await pickDimensionPosition(editor, controller, (uv) =>
        uv ? { kind: "pointLine", p: uvP, l1: a, l2: b, position: uv } : undefined,
    );
    if (!position) return false;
    const initial = pointLineSignedDistance(uvP, a, b),
        foot = pointLineFoot(uvP, a, b) ?? a;
    commitDimension(
        editor,
        {
            kind: ConstraintKind.P2LDistance,
            refs: [p, l1, l2],
            datum: toStorageDatum(ConstraintKind.P2LDistance, initial),
        },
        { kind: "offset", offset: segmentOffset(uvP, foot, position) },
        initial,
        { positiveOnly: false, rollback, repeat },
    );
    return true;
}
