// Part of the Chili3d Project, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

import { command, Dimensions, type IStep, Precision, PubSub, VisualConfig, type XYZ } from "@chili3d/core";
import type { DragSnap, TentativeEntity } from "../autoConstraints";
import { entityDisplayMesh } from "../entityMesh";
import { arcAngles, ConstraintKind, rawArcSweep, type SketchPointRef, toUV } from "../sketchModel";
import type { SketchSolver } from "../solver";
import { tangentConstraintFor } from "../solverEntities";
import { endTangent, type TangentArc, tangentArc } from "../tangentArc";
import { SketchMultistepCommand } from "./sketchMultistepCommand";
import type { SketchPointSnapResult } from "./sketchPointSnapEventHandler";
import { type SketchPointSnapData, SketchPointStep } from "./sketchPointStep";

/** Arc params in sketch uv, the end projected onto the circle center/start define. */
function arcParams(
    center: [number, number],
    start: [number, number],
    end: [number, number],
): [number, number, number, number, number, number] | undefined {
    const [cx, cy] = center;
    const endDistance = Math.hypot(end[0] - cx, end[1] - cy);
    if (endDistance < Precision.Distance) return undefined;
    // project the end onto the circle so the PointOnArc constraint does not move
    // it (and with it the whole arc) on the first solve
    const scale = Math.hypot(start[0] - cx, start[1] - cy) / endDistance;
    return [cx, cy, start[0], start[1], cx + (end[0] - cx) * scale, cy + (end[1] - cy) * scale];
}

/** The arc the probe would complete, or undefined while its end is still on the center. */
function tentativeArc(
    center: [number, number],
    start: [number, number],
    end: [number, number],
): TentativeEntity | undefined {
    const params = arcParams(center, start, end);
    return params === undefined ? undefined : { type: "arc", params };
}

/** Three-point arc: center → start (radius + start angle) → end (counter-clockwise sweep). */
@command({ key: "sketch.arc", icon: "icon-arc" })
export class SketchArcCommand extends SketchMultistepCommand {
    getSteps(): IStep[] {
        return [
            new SketchPointStep("prompt.pickCircleCenter"),
            new SketchPointStep("prompt.pickFistPoint", this.getStartData),
            new SketchPointStep("prompt.pickArcEnd", this.getEndData),
        ];
    }

    protected executeMainTask(): void {
        const params = arcParams(this.uvOf(0), this.uvOf(1), this.uvOf(2));
        if (params === undefined) {
            PubSub.default.pub("displayError", "Arc end point is too close to the center");
            return;
        }
        // an end on the start ray (within angular tolerance, end = start included)
        // fixes no sweep direction — the preview shows "no arc" there, so reject
        // with feedback instead of committing an arc generateShape would refuse
        if (Math.abs(rawArcSweep(params)) <= Precision.Angle) {
            PubSub.default.pub("displayError", "Arc end point is on the start ray (zero sweep)");
            return;
        }
        this.commitNewEntity(this.editor.solver.addArc(...params));
    }

    private readonly getStartData = (): SketchPointSnapData => ({
        refPoint: () => this.stepDatas[0].point!,
        dimension: Dimensions.D1,
        preview: this.startPreview,
        // the sweep is still open here, so the arc is its whole circle (start = end)
        tentative: (probe) => tentativeArc(this.uvOf(0), probe, probe),
    });

    private readonly startPreview = (point: XYZ | undefined) => {
        const center = this.stepDatas[0].point!;
        if (point === undefined) {
            return [this.meshPoint(center)];
        }
        const plane = this.editor.node.plane;
        return [
            this.meshPoint(center),
            this.meshLine(center, point),
            this.meshCreatedShape("circle", plane.normal, center, plane.projectDistance(center, point)),
        ];
    };

    private readonly getEndData = (): SketchPointSnapData => ({
        refPoint: () => this.stepDatas[1].point!,
        preview: this.endPreview,
        tentative: (probe) => tentativeArc(this.uvOf(0), this.uvOf(1), probe),
    });

    private readonly endPreview = (point: XYZ | undefined) => {
        const plane = this.editor.node.plane;
        const center = this.stepDatas[0].point!;
        const start = this.stepDatas[1].point!;
        const meshes = [this.meshPoint(center), this.meshLine(center, start)];
        if (point === undefined) {
            return meshes;
        }
        const [cx, cy] = toUV(plane, center);
        const [sx, sy] = toUV(plane, start);
        const [ex, ey] = toUV(plane, point);
        const [, sweep] = arcAngles([cx, cy, sx, sy, ex, ey]);
        // a sweep of (almost) 2π means the cursor is on the start ray — no arc yet
        if (Math.abs(sweep - Math.PI * 2) < Precision.Angle) {
            return meshes;
        }
        meshes.push(this.meshCreatedShape("arc", plane.normal, center, start, (sweep * 180) / Math.PI));
        return meshes;
    };
}

/**
 * Onshape's Tangent arc: starts on the end of a line or arc and leaves it tangentially,
 * ending where the second pick lands. The start is coincident with that end and the
 * arc tangent to its curve — the tool's own constraints, kept even under Shift; the
 * free end is inferred like any drawn point.
 */
@command({ key: "sketch.tangentArc", icon: "icon-arc" })
export class SketchTangentArcCommand extends SketchMultistepCommand {
    getSteps(): IStep[] {
        return [
            new SketchPointStep("prompt.pickFistPoint", this.getStartData),
            new SketchPointStep("prompt.pickArcEnd", this.getEndData),
        ];
    }

    protected executeMainTask(): void {
        const source = this.source();
        if (source === undefined) {
            PubSub.default.pub("displayError", "Start a tangent arc on the end of a line or arc");
            return;
        }
        const arc = this.arcTo(this.uvOf(1));
        if (arc === undefined) {
            PubSub.default.pub("displayError", "The arc end is on the tangent line (no arc)");
            return;
        }
        const solver = this.editor.solver;
        const id = solver.addArc(...arc.params);
        solver.addConstraint({
            kind: ConstraintKind.P2PCoincident,
            refs: [{ entityId: id, pointIndex: arc.startIndex }, source],
        });
        const tangent = tangentConstraintFor(
            "arc",
            id,
            solver.entity(source.entityId)?.type,
            source.entityId,
        );
        if (tangent !== undefined) solver.addConstraint(tangent);
        // the center and the free end are inferred; the start is attached above
        this.commitNewEntity(id, [0, arc.startIndex === 1 ? 2 : 1]);
    }

    /** The line or arc end the first pick snapped onto, or undefined. */
    private source(): SketchPointRef | undefined {
        return tangentSource(this.editor.solver, (this.stepDatas[0] as SketchPointSnapResult).sketchSnap);
    }

    private arcTo(end: [number, number]): TangentArc | undefined {
        const source = this.source();
        const entity = source && this.editor.solver.entity(source.entityId);
        const direction = source && entity && endTangent(entity, source.pointIndex);
        return direction && tangentArc(this.uvOf(0), direction, end);
    }

    private readonly getStartData = (): SketchPointSnapData => ({
        dimension: Dimensions.D1D2D3,
        acceptSnap: (snap) => tangentSource(this.editor.solver, snap) !== undefined,
    });

    private readonly getEndData = (): SketchPointSnapData => ({
        refPoint: () => this.stepDatas[0].point!,
        dimension: Dimensions.D1D2,
        preview: this.endPreview,
        tentative: (probe) => {
            const arc = this.arcTo(probe);
            return arc === undefined ? undefined : { type: "arc", params: arc.params };
        },
    });

    private readonly endPreview = (point: XYZ | undefined) => {
        const start = this.meshPoint(this.stepDatas[0].point!);
        const arc = point === undefined ? undefined : this.arcTo(toUV(this.editor.node.plane, point));
        if (arc === undefined) return [start];
        return [
            start,
            entityDisplayMesh(
                this.editor.node.plane,
                { id: 0, type: "arc", params: arc.params },
                VisualConfig.defaultEdgeColor,
            ),
        ];
    };
}

/** The end of a line or arc a snap landed on: where a tangent arc can start. */
function tangentSource(solver: SketchSolver, snap: DragSnap | undefined): SketchPointRef | undefined {
    if (snap?.kind !== "point") return undefined;
    const entity = solver.entity(snap.point.entityId);
    return entity !== undefined && endTangent(entity, snap.point.pointIndex) !== undefined
        ? snap.point
        : undefined;
}
