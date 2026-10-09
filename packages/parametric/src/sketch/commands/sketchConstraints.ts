// Part of the Chili3d Project, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

import { AsyncController, CancelableCommand, command, PubSub } from "@chili3d/core";
import { SketchEditor } from "../editor/sketchEditor";
import {
    ConstraintKind,
    entityPointCount,
    pointRefKey,
    type SketchData,
    type SketchPointRef,
} from "../sketchModel";
import type { SketchSolver } from "../solver";
import {
    allowsConstraintOnEntity,
    arcStartRef,
    centerRef,
    lineRefs,
    tangentConstraintFor,
} from "../solverEntities";

function editorOrError(): SketchEditor | undefined {
    const editor = SketchEditor.getActive();
    if (editor === undefined) {
        PubSub.default.pub("displayError", "No active sketch editor");
    }
    return editor;
}

export abstract class SketchConstraintCommand extends CancelableCommand {
    /**
     * Onshape keeps a constraint tool armed after each application until Escape;
     * tools that pick once and then open their own input (dimensions) or run their
     * own loop (trim) leave this off.
     */
    protected get repeatsUntilEscape(): boolean {
        return false;
    }

    async executeAsync(): Promise<void> {
        const editor = editorOrError();
        if (editor === undefined) return;
        const registration = editor.registerTool(this);
        editor.beginConstraintSelection();
        // a pre-selected target applies the constraint at once and ends the tool
        const preselected = editor.selectedEntityIds.length > 0;
        try {
            let again = true;
            while (again) {
                const picksBefore = editor.pickSequence;
                await this.executeWithEditor(editor);
                again =
                    this.repeatsUntilEscape &&
                    !preselected &&
                    !this.isCanceled &&
                    SketchEditor.getActive() === editor &&
                    editor.pickSequence > picksBefore &&
                    editor.lastPickCancelled === false;
                // the next round starts from a clean pick highlight
                if (again) editor.endConstraintSelection();
            }
        } finally {
            registration.dispose();
            editor.endConstraintSelection();
        }
    }

    protected abstract executeWithEditor(editor: SketchEditor): Promise<void>;
}

/** A constraint tool that stays armed for the next pair of targets until Escape. */
abstract class RepeatingConstraintCommand extends SketchConstraintCommand {
    protected override get repeatsUntilEscape(): boolean {
        return true;
    }
}

/** Same-kind constraint with the same ref set already exists — adding it would be redundant. */
function hasDuplicate(solver: SketchSolver, kind: ConstraintKind, refs: SketchPointRef[]): boolean {
    const key = refs.map(pointRefKey).sort().join("|");
    return solver
        .toData()
        .constraints.some((c) => c.kind === kind && c.refs.map(pointRefKey).sort().join("|") === key);
}

/** Adds the constraint unless redundant, then solves and commits. */
function addAndCommit(
    editor: SketchEditor,
    kind: ConstraintKind,
    refs: SketchPointRef[],
    extra?: { datum?: number; datums?: number[] },
): void {
    if (hasDuplicate(editor.solver, kind, refs)) {
        PubSub.default.pub("statusBarTip", "sketch.constraintExists");
        return;
    }
    const before = editor.solver.toData();
    editor.solver.addConstraint({ kind, refs, ...extra });
    solveAndCommit(editor, before);
}

function solveAndCommit(editor: SketchEditor, before: SketchData): void {
    const outcome = editor.solve(true);
    if (outcome && !outcome.result.startsWith("Ok")) {
        editor.solver.reset(before);
        editor.solve(true);
        PubSub.default.pub(
            "displayError",
            "This constraint conflicts with the sketch. The drawing was restored.",
        );
        return;
    }
    editor.commit();
}

@command({ key: "constraint.coincident", icon: "icon-cCoincident" })
export class CoincidentConstraintCommand extends RepeatingConstraintCommand {
    protected async executeWithEditor(editor: SketchEditor): Promise<void> {
        this.controller = new AsyncController();
        const first = await editor.pickPointOrEntity("prompt.pickSketchPointOrEntity", this.controller);
        if (first === undefined) return;
        this.controller = new AsyncController();
        const second = await editor.pickPointOrEntity(
            "prompt.pickSketchPointOrEntity",
            this.controller,
            first,
        );
        if (second === undefined) return;
        if (first.kind === "point" && second.kind === "point") {
            if (pointRefKey(first.ref) === pointRefKey(second.ref)) {
                PubSub.default.pub("displayError", "Pick two different points");
                return;
            }
            addAndCommit(editor, ConstraintKind.P2PCoincident, [first.ref, second.ref]);
        } else {
            const point =
                first.kind === "point" ? first.ref : second.kind === "point" ? second.ref : undefined;
            const entityId =
                first.kind === "entity"
                    ? first.entityId
                    : second.kind === "entity"
                      ? second.entityId
                      : undefined;
            if (point === undefined || entityId === undefined) {
                PubSub.default.pub(
                    "displayError",
                    "Coincident needs a point and another point or curve. Pick an endpoint, center, or the origin.",
                );
                return;
            }
            addPointOn(editor, point, entityId);
        }
    }
}

abstract class LineConstraintCommand extends RepeatingConstraintCommand {
    protected abstract readonly kind: ConstraintKind.Horizontal | ConstraintKind.Vertical;

    protected async executeWithEditor(editor: SketchEditor): Promise<void> {
        this.controller = new AsyncController();
        const lineId = await editor.pickEntity("prompt.pickSketchEntity", "line", undefined, this.controller);
        if (lineId === undefined || !allowsConstraintOnEntity(this.kind, lineId)) return;
        addAndCommit(editor, this.kind, lineRefs(lineId));
    }
}

@command({ key: "constraint.horizontal", icon: "icon-cHorizontal" })
export class HorizontalConstraintCommand extends LineConstraintCommand {
    protected readonly kind = ConstraintKind.Horizontal;
}

@command({ key: "constraint.vertical", icon: "icon-cVertical" })
export class VerticalConstraintCommand extends LineConstraintCommand {
    protected readonly kind = ConstraintKind.Vertical;
}

abstract class TwoLineConstraintCommand extends RepeatingConstraintCommand {
    protected abstract readonly kind: ConstraintKind.Parallel | ConstraintKind.Perpendicular;

    protected async executeWithEditor(editor: SketchEditor): Promise<void> {
        this.controller = new AsyncController();
        const l1 = await editor.pickEntity(
            "prompt.pickSketchEntity",
            "line",
            { datum: true },
            this.controller,
        );
        if (l1 === undefined) return;
        this.controller = new AsyncController();
        const l2 = await editor.pickEntity(
            "prompt.pickSketchEntity",
            "line",
            { datum: true },
            this.controller,
        );
        if (l2 === undefined) return;
        if (l1 === l2) {
            PubSub.default.pub("displayError", "Pick two different lines");
            return;
        }
        addAndCommit(editor, this.kind, [...lineRefs(l1), ...lineRefs(l2)]);
    }
}

@command({ key: "constraint.parallel", icon: "icon-cParallel" })
export class ParallelConstraintCommand extends TwoLineConstraintCommand {
    protected readonly kind = ConstraintKind.Parallel;
}

@command({ key: "constraint.perpendicular", icon: "icon-cPerpendicular" })
export class PerpendicularConstraintCommand extends TwoLineConstraintCommand {
    protected readonly kind = ConstraintKind.Perpendicular;
}

abstract class TwoPointConstraintCommand extends RepeatingConstraintCommand {
    protected abstract readonly kind: ConstraintKind.HorizontalAlign | ConstraintKind.VerticalAlign;

    protected async executeWithEditor(editor: SketchEditor): Promise<void> {
        if (editor.selectedWholeEntityIds.length === 1) {
            const entity = editor.solver.entity(editor.selectedWholeEntityIds[0]);
            if (entity?.type === "line" && allowsConstraintOnEntity(this.kind, entity.id)) {
                addAndCommit(editor, this.kind, lineRefs(entity.id));
                return;
            }
        }
        this.controller = new AsyncController();
        const first = await editor.pickPointOrEntity("prompt.pickSketchPointOrEntity", this.controller);
        if (!first) return;
        if (first.kind === "entity") {
            if (
                editor.solver.entity(first.entityId)?.type === "line" &&
                allowsConstraintOnEntity(this.kind, first.entityId)
            ) {
                addAndCommit(editor, this.kind, lineRefs(first.entityId));
            }
            return;
        }
        const p1 = first.ref;
        if (!allowsConstraintOnEntity(this.kind, p1.entityId)) return;
        this.controller = new AsyncController();
        const p2 = await editor.pickPoint("prompt.pickSketchPoint", undefined, this.controller, p1);
        if (p2 === undefined || !allowsConstraintOnEntity(this.kind, p2.entityId)) return;
        addAndCommit(editor, this.kind, [p1, p2]);
    }
}

@command({ key: "constraint.horizontalAlign", icon: "icon-cAlignH" })
export class HorizontalAlignConstraintCommand extends TwoPointConstraintCommand {
    protected readonly kind = ConstraintKind.HorizontalAlign;
}

@command({ key: "constraint.verticalAlign", icon: "icon-cAlignV" })
export class VerticalAlignConstraintCommand extends TwoPointConstraintCommand {
    protected readonly kind = ConstraintKind.VerticalAlign;
}

/** Round entities: an equal constraint between any two of them equates their radii. */
const isRound = (type: string | undefined) => type === "circle" || type === "arc";

/**
 * Picks two lines (equal length) or two round entities — circles and arcs in any mix, so a
 * trimmed circle can still be made equal to a whole one — (equal radius).
 */
@command({ key: "constraint.equal", icon: "icon-cEqual" })
export class EqualConstraintCommand extends RepeatingConstraintCommand {
    protected async executeWithEditor(editor: SketchEditor): Promise<void> {
        this.controller = new AsyncController();
        const e1 = await editor.pickEntity("prompt.pickSketchEntity", undefined, undefined, this.controller);
        if (e1 === undefined) return;
        this.controller = new AsyncController();
        const e2 = await editor.pickEntity("prompt.pickSketchEntity", undefined, undefined, this.controller);
        if (e2 === undefined) return;
        if (e1 === e2) {
            PubSub.default.pub("displayError", "Pick two different entities");
            return;
        }
        const t1 = editor.solver.entity(e1)?.type;
        const t2 = editor.solver.entity(e2)?.type;
        if (t1 === "line" && t2 === "line") {
            addAndCommit(editor, ConstraintKind.EqualLength, [...lineRefs(e1), ...lineRefs(e2)]);
        } else if (t1 === "arc" && t2 === "arc") {
            addAndCommit(editor, ConstraintKind.EqualArcRadius, [
                centerRef(e1),
                arcStartRef(e1),
                centerRef(e2),
                arcStartRef(e2),
            ]);
        } else if (isRound(t1) && isRound(t2)) {
            // Two circles, or a circle and an arc: the solver equates the arc's radius to the
            // circle's radius parameter.
            addAndCommit(editor, ConstraintKind.EqualRadius, [centerRef(e1), centerRef(e2)]);
        } else {
            PubSub.default.pub("displayError", "Equal requires two lines, or two circles or arcs");
        }
    }
}

/** Picks two entities (any order) and applies the matching tangent constraint. */
@command({ key: "constraint.tangent", icon: "icon-cTangent" })
export class TangentConstraintCommand extends RepeatingConstraintCommand {
    protected async executeWithEditor(editor: SketchEditor): Promise<void> {
        this.controller = new AsyncController();
        const e1 = await editor.pickEntity("prompt.pickSketchEntity", undefined, undefined, this.controller);
        if (e1 === undefined) return;
        this.controller = new AsyncController();
        const e2 = await editor.pickEntity("prompt.pickSketchEntity", undefined, undefined, this.controller);
        if (e2 === undefined) return;
        if (e1 === e2) {
            PubSub.default.pub("displayError", "Pick two different entities");
            return;
        }
        const t1 = editor.solver.entity(e1)?.type;
        const t2 = editor.solver.entity(e2)?.type;
        const tangent = tangentConstraintFor(t1, e1, t2, e2);
        if (tangent === undefined) {
            PubSub.default.pub("displayError", "Tangent does not apply to two lines");
            return;
        }
        addAndCommit(editor, tangent.kind, tangent.refs);
    }
}

/** Picks a point and an entity (or a datum axis), constraining the point onto it. */
@command({ key: "constraint.pointOn", icon: "icon-cPointOn" })
export class PointOnConstraintCommand extends RepeatingConstraintCommand {
    protected async executeWithEditor(editor: SketchEditor): Promise<void> {
        this.controller = new AsyncController();
        const p = await editor.pickPoint("prompt.pickSketchPoint", undefined, this.controller);
        if (p === undefined) return;
        this.controller = new AsyncController();
        const entityId = await editor.pickEntity(
            "prompt.pickSketchEntity",
            undefined,
            { datum: true },
            this.controller,
        );
        if (entityId === undefined) return;
        addPointOn(editor, p, entityId);
    }
}

function addPointOn(editor: SketchEditor, point: SketchPointRef, entityId: number): void {
    if (point.entityId === entityId) {
        PubSub.default.pub("displayError", "Pick a point from another entity");
        return;
    }
    const type = editor.solver.entity(entityId)?.type;
    if (type === "line") addAndCommit(editor, ConstraintKind.PointOnLine, [point, ...lineRefs(entityId)]);
    else if (type === "circle")
        addAndCommit(editor, ConstraintKind.PointOnCircle, [point, centerRef(entityId)]);
    else if (type === "arc")
        addAndCommit(editor, ConstraintKind.PointOnArc, [point, centerRef(entityId), arcStartRef(entityId)]);
}

@command({ key: "constraint.midpoint", icon: "icon-cMid" })
export class MidpointConstraintCommand extends RepeatingConstraintCommand {
    protected async executeWithEditor(editor: SketchEditor): Promise<void> {
        this.controller = new AsyncController();
        const p = await editor.pickPoint("prompt.pickSketchPoint", undefined, this.controller);
        if (p === undefined) return;
        this.controller = new AsyncController();
        const lineId = await editor.pickEntity("prompt.pickSketchEntity", "line", undefined, this.controller);
        if (lineId === undefined || !allowsConstraintOnEntity(ConstraintKind.Midpoint, lineId)) return;
        addAndCommit(editor, ConstraintKind.Midpoint, [p, ...lineRefs(lineId)]);
    }
}

/** Two points symmetric about a picked line or datum axis. */
@command({ key: "constraint.symmetric", icon: "icon-cSymmetric" })
export class SymmetricConstraintCommand extends RepeatingConstraintCommand {
    protected async executeWithEditor(editor: SketchEditor): Promise<void> {
        this.controller = new AsyncController();
        const p1 = await editor.pickPoint("prompt.pickSketchPoint", undefined, this.controller);
        if (p1 === undefined) return;
        this.controller = new AsyncController();
        const p2 = await editor.pickPoint("prompt.pickSketchPoint", undefined, this.controller);
        if (p2 === undefined) return;
        this.controller = new AsyncController();
        const lineId = await editor.pickEntity(
            "prompt.pickSketchEntity",
            "line",
            { datum: true },
            this.controller,
        );
        if (lineId === undefined || !allowsConstraintOnEntity(ConstraintKind.Symmetric, lineId)) return;
        addAndCommit(editor, ConstraintKind.Symmetric, [p1, p2, ...lineRefs(lineId)]);
    }
}

/** Pins a point at its current coordinates (two datum values, double-click the badge to edit). */
@command({ key: "constraint.fix", icon: "icon-cFix" })
export class FixConstraintCommand extends RepeatingConstraintCommand {
    protected async executeWithEditor(editor: SketchEditor): Promise<void> {
        const selected = editor.selectedWholeEntityIds;
        if (selected.length) {
            const before = editor.solver.toData();
            for (const id of selected) {
                const entity = editor.solver.entity(id);
                if (!entity || !allowsConstraintOnEntity(ConstraintKind.Fix, id)) continue;
                for (
                    let pointIndex = 0;
                    pointIndex < entityPointCount(entity.type, entity.params);
                    pointIndex++
                ) {
                    const ref = { entityId: id, pointIndex };
                    if (!hasDuplicate(editor.solver, ConstraintKind.Fix, [ref]))
                        editor.solver.addConstraint({
                            kind: ConstraintKind.Fix,
                            refs: [ref],
                            datums: [...editor.solver.pointOf(ref)],
                        });
                }
                if (
                    entity.type === "circle" &&
                    !hasDuplicate(editor.solver, ConstraintKind.Radius, [centerRef(id)])
                )
                    editor.solver.addConstraint({
                        kind: ConstraintKind.Radius,
                        refs: [centerRef(id)],
                        datum: entity.params[2],
                    });
            }
            solveAndCommit(editor, before);
            return;
        }
        this.controller = new AsyncController();
        const p = await editor.pickPoint("prompt.pickSketchPoint", undefined, this.controller);
        if (p === undefined || !allowsConstraintOnEntity(ConstraintKind.Fix, p.entityId)) return;
        addAndCommit(editor, ConstraintKind.Fix, [p], { datums: [...editor.solver.pointOf(p)] });
    }
}
