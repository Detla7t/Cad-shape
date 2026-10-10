// Part of the Chili3d Project, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

import { AsyncController, CancelableCommand, command, PubSub } from "@chili3d/core";
import { SketchEditor } from "../editor/sketchEditor";
import {
    type NewSketchConstraint,
    pointOnCurve,
    type SelectionConstraintTool,
    type SketchSelectionTarget,
    selectionConstraints,
} from "../selectionConstraints";
import { ConstraintKind, pointRefKey, type SketchData, type SketchPointRef } from "../sketchModel";
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

    /**
     * The tool's selection-wide form (`selectionConstraints`): with a selection that is a
     * complete batch for it, the constraint applies to all of it in one undo step.
     */
    protected get selectionTool(): SelectionConstraintTool | undefined {
        return undefined;
    }

    async executeAsync(): Promise<void> {
        const editor = editorOrError();
        if (editor === undefined) return;
        const registration = editor.registerTool(this);
        editor.beginConstraintSelection();
        // a pre-selected target applies the constraint at once and ends the tool
        const preselected = editor.selectedEntityIds.length > 0;
        try {
            if (preselected && this.selectionTool !== undefined) {
                const applied = applySelectionConstraints(editor, this.selectionTool, editor.preselection);
                if (applied !== undefined) return;
            }
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

    /** Picks two entities for a two-entity constraint; undefined when cancelled or the same twice. */
    protected async pickTwoEntities(editor: SketchEditor): Promise<[number, number] | undefined> {
        this.controller = new AsyncController();
        const e1 = await editor.pickEntity("prompt.pickSketchEntity", undefined, undefined, this.controller);
        if (e1 === undefined) return undefined;
        this.controller = new AsyncController();
        const e2 = await editor.pickEntity("prompt.pickSketchEntity", undefined, undefined, this.controller);
        if (e2 === undefined) return undefined;
        if (e1 === e2) {
            PubSub.default.pub("displayError", "Pick two different entities");
            return undefined;
        }
        return [e1, e2];
    }
}

/**
 * The one commit path of the constraint tools: adds every constraint of `constraints`
 * that is not already there as one undoable change, and restores the drawing when the
 * sketch no longer solves. Returns whether anything was committed.
 */
export function applySketchConstraints(
    editor: SketchEditor,
    constraints: readonly NewSketchConstraint[],
): boolean {
    const seen = new Set<string>();
    const fresh = constraints.filter((constraint) => {
        const key = `${constraint.kind}/${constraint.role ?? ""}/${constraint.refs.map(pointRefKey).sort().join("|")}`;
        if (seen.has(key)) return false;
        seen.add(key);
        return !editor.solver.hasConstraint(constraint.kind, constraint.refs, constraint.role);
    });
    if (fresh.length === 0) {
        PubSub.default.pub("statusBarTip", "sketch.constraintExists");
        return false;
    }
    const before = editor.solver.toData();
    for (const constraint of fresh) editor.solver.addConstraint(constraint);
    return solveAndCommit(editor, before);
}

/**
 * Applies `tool` to `targets` as a whole (`selectionConstraints`). `undefined` when the
 * targets are no complete batch for the tool, so the caller picks the rest; otherwise
 * whether it committed (a refused selection shows why).
 */
export function applySelectionConstraints(
    editor: SketchEditor,
    tool: SelectionConstraintTool,
    targets: readonly SketchSelectionTarget[],
): boolean | undefined {
    const plan = selectionConstraints(editor.solver, tool, targets);
    if (plan === undefined) return undefined;
    if (!plan.isOk) {
        PubSub.default.pub("displayError", plan.error);
        return false;
    }
    return applySketchConstraints(editor, plan.value);
}

/** Adds the constraint unless redundant, then solves and commits. */
function addAndCommit(
    editor: SketchEditor,
    kind: ConstraintKind,
    refs: SketchPointRef[],
    extra?: Pick<NewSketchConstraint, "datum" | "datums" | "role">,
): void {
    applySketchConstraints(editor, [{ kind, refs, ...extra }]);
}

function solveAndCommit(editor: SketchEditor, before: SketchData): boolean {
    const outcome = editor.solve(true);
    if (outcome && !outcome.result.startsWith("Ok")) {
        editor.solver.reset(before);
        editor.solve(true);
        PubSub.default.pub(
            "displayError",
            "This constraint conflicts with the sketch. The drawing was restored.",
        );
        return false;
    }
    editor.commit();
    return true;
}

@command({ key: "constraint.coincident", icon: "icon-cCoincident" })
export class CoincidentConstraintCommand extends RepeatingConstraintCommand {
    protected override get selectionTool(): SelectionConstraintTool {
        return "coincident";
    }

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

/**
 * Horizontal / Vertical, one tool each as in Onshape: pick (or pre-select) lines to make them
 * horizontal, or two points to line them up. A point pair is the align constraint underneath.
 */
abstract class AxisConstraintCommand extends RepeatingConstraintCommand {
    protected abstract readonly kind: ConstraintKind.Horizontal | ConstraintKind.Vertical;
    protected abstract readonly alignKind: ConstraintKind.HorizontalAlign | ConstraintKind.VerticalAlign;

    protected override get selectionTool(): SelectionConstraintTool {
        return this.kind === ConstraintKind.Horizontal ? "horizontal" : "vertical";
    }

    protected async executeWithEditor(editor: SketchEditor): Promise<void> {
        this.controller = new AsyncController();
        const first = await editor.pickPointOrEntity("prompt.pickSketchPointOrEntity", this.controller);
        if (first === undefined) return;
        if (first.kind === "entity") {
            // an external reference is refused (with its tip) before its type is looked at
            if (!allowsConstraintOnEntity(this.kind, first.entityId)) return;
            if (editor.solver.entity(first.entityId)?.type !== "line") {
                PubSub.default.pub("displayError", "Pick a line, or two points to align");
                return;
            }
            addAndCommit(editor, this.kind, lineRefs(first.entityId));
            return;
        }
        const p1 = first.ref;
        if (!allowsConstraintOnEntity(this.alignKind, p1.entityId)) return;
        this.controller = new AsyncController();
        const p2 = await editor.pickPoint("prompt.pickSketchPoint", undefined, this.controller, p1);
        if (p2 === undefined || !allowsConstraintOnEntity(this.alignKind, p2.entityId)) return;
        if (pointRefKey(p1) === pointRefKey(p2)) {
            PubSub.default.pub("displayError", "Pick two different points");
            return;
        }
        addAndCommit(editor, this.alignKind, [p1, p2]);
    }
}

@command({ key: "constraint.horizontal", icon: "icon-cHorizontal" })
export class HorizontalConstraintCommand extends AxisConstraintCommand {
    protected readonly kind = ConstraintKind.Horizontal;
    protected readonly alignKind = ConstraintKind.HorizontalAlign;
}

@command({ key: "constraint.vertical", icon: "icon-cVertical" })
export class VerticalConstraintCommand extends AxisConstraintCommand {
    protected readonly kind = ConstraintKind.Vertical;
    protected readonly alignKind = ConstraintKind.VerticalAlign;
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

    protected override get selectionTool(): SelectionConstraintTool {
        return "parallel";
    }
}

@command({ key: "constraint.perpendicular", icon: "icon-cPerpendicular" })
export class PerpendicularConstraintCommand extends TwoLineConstraintCommand {
    protected readonly kind = ConstraintKind.Perpendicular;
}

/** Two picked entities as selection targets, in pick order. */
const entityPair = (pair: readonly [number, number]): SketchSelectionTarget[] =>
    pair.map((entityId) => ({ kind: "entity", entityId }));

/**
 * Equal: two or more lines (equal length) or round entities — circles and arcs in any mix,
 * so a trimmed circle can still be made equal to a whole one — (equal radius).
 */
@command({ key: "constraint.equal", icon: "icon-cEqual" })
export class EqualConstraintCommand extends RepeatingConstraintCommand {
    protected override get selectionTool(): SelectionConstraintTool {
        return "equal";
    }

    protected async executeWithEditor(editor: SketchEditor): Promise<void> {
        const pair = await this.pickTwoEntities(editor);
        if (pair !== undefined) applySelectionConstraints(editor, "equal", entityPair(pair));
    }
}

/** Concentric: two or more circles, arcs or points share a center (Onshape's Concentric). */
@command({ key: "constraint.concentric", icon: "icon-a-tongxinyueshu2424" })
export class ConcentricConstraintCommand extends RepeatingConstraintCommand {
    protected override get selectionTool(): SelectionConstraintTool {
        return "concentric";
    }

    protected async executeWithEditor(editor: SketchEditor): Promise<void> {
        const pair = await this.pickTwoEntities(editor);
        if (pair !== undefined) applySelectionConstraints(editor, "concentric", entityPair(pair));
    }
}

const isRound = (type: string | undefined) => type === "circle" || type === "arc";

/** Normal: a line meets a circle or arc at right angles — it runs through the center. */
@command({ key: "constraint.normal", icon: "icon-cPerpendicular" })
export class NormalConstraintCommand extends RepeatingConstraintCommand {
    protected async executeWithEditor(editor: SketchEditor): Promise<void> {
        const pair = await this.pickTwoEntities(editor);
        if (pair === undefined) return;
        const types = pair.map((id) => editor.solver.entity(id)?.type);
        const line = types[0] === "line" ? pair[0] : types[1] === "line" ? pair[1] : undefined;
        const round = isRound(types[0]) ? pair[0] : isRound(types[1]) ? pair[1] : undefined;
        if (line === undefined || round === undefined) {
            PubSub.default.pub("displayError", "Normal applies to a line and a circle or arc");
            return;
        }
        addAndCommit(editor, ConstraintKind.PointOnLine, [centerRef(round), ...lineRefs(line)], {
            role: "normal",
        });
    }
}

/**
 * Curvature (G2) continuity where two curves meet: two arcs become one circle (equal radius,
 * same center); a line and a Bézier keep the curve's end straight (both inner control points
 * on the line). Pairs whose curvature condition is not polynomial — an arc or a Bézier with a
 * Bézier — are refused with a message.
 */
@command({ key: "constraint.curvature", icon: "icon-cTangent" })
export class CurvatureConstraintCommand extends RepeatingConstraintCommand {
    protected async executeWithEditor(editor: SketchEditor): Promise<void> {
        const pair = await this.pickTwoEntities(editor);
        if (pair === undefined) return;
        const [t1, t2] = pair.map((id) => editor.solver.entity(id)?.type);
        if (t1 === "arc" && t2 === "arc") {
            addAndCommit(
                editor,
                ConstraintKind.EqualArcRadius,
                [centerRef(pair[0]), arcStartRef(pair[0]), centerRef(pair[1]), arcStartRef(pair[1])],
                { role: "curvature" },
            );
            return;
        }
        const line = t1 === "line" ? pair[0] : t2 === "line" ? pair[1] : undefined;
        const curve = t1 === "bezier" ? pair[0] : t2 === "bezier" ? pair[1] : undefined;
        if (line !== undefined && curve !== undefined) {
            const [start, end] = lineRefs(line);
            addAndCommit(
                editor,
                ConstraintKind.PointOnLine,
                [{ entityId: curve, pointIndex: 1 }, start, end, { entityId: curve, pointIndex: 2 }],
                { role: "curvature" },
            );
            return;
        }
        PubSub.default.pub("displayError", "Curvature applies to two arcs, or a line and a Bézier curve");
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
    const constraint = pointOnCurve(editor.solver, point, entityId);
    if (constraint !== undefined) applySketchConstraints(editor, [constraint]);
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

/**
 * Fix (Onshape's Fix): pins what is picked where it is — a point at its coordinates (two datum
 * values; double-click the badge to edit), or a whole entity: every point of it, and a
 * circle's radius.
 */
@command({ key: "constraint.fix", icon: "icon-cFix" })
export class FixConstraintCommand extends RepeatingConstraintCommand {
    protected override get selectionTool(): SelectionConstraintTool {
        return "fix";
    }

    protected async executeWithEditor(editor: SketchEditor): Promise<void> {
        this.controller = new AsyncController();
        const picked = await editor.pickPointOrEntity("prompt.pickSketchPointOrEntity", this.controller);
        if (picked === undefined) return;
        const id = picked.kind === "entity" ? picked.entityId : picked.ref.entityId;
        if (allowsConstraintOnEntity(ConstraintKind.Fix, id))
            applySelectionConstraints(editor, "fix", [picked]);
    }
}
