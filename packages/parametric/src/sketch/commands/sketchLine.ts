// Part of the Chili3d Project, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

import { command, Dimensions, type IStep, Precision, property, type XYZ } from "@chili3d/core";
import { ConstraintKind, type SketchPointRef } from "../sketchModel";
import { SketchMultistepCommand } from "./sketchMultistepCommand";
import type { SketchPointSnapResult } from "./sketchPointSnapEventHandler";
import { type SketchPointSnapData, SketchPointStep } from "./sketchPointStep";

/** Line params in sketch uv for the endpoints `start` and `end`. */
function lineParams(start: [number, number], end: [number, number]): [number, number, number, number] {
    return [start[0], start[1], end[0], end[1]];
}

/**
 * Polyline-style line tool: each finished segment becomes the start of the next
 * one (joined by a coincident constraint), the chain ends when it closes on its
 * own first point, when a segment is drawn by press-and-drag, or with Escape —
 * which keeps the tool armed for a new chain. Untick "Connected" for separate
 * segments.
 */
@command({ key: "sketch.line", icon: "icon-line" })
export class SketchLineCommand extends SketchMultistepCommand {
    @property("option.command.isConnected")
    get isContinue() {
        return this.getPrivateValue("isContinue", true);
    }
    set isContinue(value: boolean) {
        this.setProperty("isContinue", value);
    }

    /** End point of the segment just committed, the next segment's start when chaining. */
    private chainFrom?: SketchPointRef;
    /** Start point of the chain's first segment: reaching it again closes the chain. */
    private chainStart?: [number, number];

    getSteps(): IStep[] {
        return [
            new SketchPointStep("prompt.pickFistPoint"),
            new SketchPointStep("prompt.pickNextPoint", this.getSecondPointData),
        ];
    }

    protected executeMainTask(): void {
        const start = this.uvOf(0);
        const end = this.uvOf(1);
        const solver = this.editor.solver;
        const id = solver.addLine(...lineParams(start, end));
        const previous = this.chainFrom;
        if (previous !== undefined && solver.entity(previous.entityId) !== undefined) {
            // the join is structural, not inferred: Shift (no inference) still chains
            const from = { entityId: id, pointIndex: 0 };
            if (!solver.hasConstraint(ConstraintKind.P2PCoincident, [from, previous]))
                solver.addConstraint({ kind: ConstraintKind.P2PCoincident, refs: [from, previous] });
        }
        this.commitNewEntity(id);
        this.chainStart ??= start;
        const closed =
            Math.hypot(end[0] - this.chainStart[0], end[1] - this.chainStart[1]) < Precision.Distance;
        this.chainFrom =
            this.isContinue && !closed && !this.stepWasDragged(1)
                ? { entityId: id, pointIndex: 1 }
                : undefined;
        if (this.chainFrom === undefined) this.chainStart = undefined;
    }

    protected override resetStepDatas(): void {
        if (this.chainFrom !== undefined && this.stepDatas.length === 2) {
            // the end pick's own flags (Shift, drag) belong to the finished segment
            const {
                suppressInference: _s,
                dragged: _d,
                ...next
            } = this.stepDatas[1] as SketchPointSnapResult;
            this.stepDatas[0] = next;
            this.stepDatas.length = 1;
            return;
        }
        this.chainFrom = undefined;
        this.chainStart = undefined;
        this.stepDatas.length = 0;
    }

    private readonly getSecondPointData = (): SketchPointSnapData => ({
        refPoint: () => this.stepDatas[0].point!,
        dimension: Dimensions.D1D2,
        preview: this.linePreview,
        tentative: (probe) => ({ type: "line", params: lineParams(this.uvOf(0), probe) }),
    });

    private readonly linePreview = (point: XYZ | undefined) => {
        if (point === undefined) {
            return [this.meshPoint(this.stepDatas[0].point!)];
        }
        return [this.meshPoint(this.stepDatas[0].point!), this.meshLine(this.stepDatas[0].point!, point)];
    };
}
