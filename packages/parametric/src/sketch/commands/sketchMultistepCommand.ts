// Part of the Chili3d Project, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

import { type IDisposable, MultistepCommand, PubSub } from "@chili3d/core";
import { applyAutoConstraints, sketchSnapOptions } from "../autoConstraints";
import { SketchEditor } from "../editor/sketchEditor";
import { toUV } from "../sketchModel";
import type { SketchPointSnapResult } from "./sketchPointSnapEventHandler";

/**
 * Base class for in-sketch step commands: requires an active sketch editing session.
 *
 * The tools stay armed the way Onshape's do: a completed shape re-runs the steps
 * for the next one, Escape while a shape is in progress drops that shape and
 * keeps the tool, and Escape with nothing in progress (or choosing another
 * tool, or leaving the sketch) ends it.
 */
export abstract class SketchMultistepCommand extends MultistepCommand {
    private toolRegistration?: IDisposable;

    protected override canExcute(): Promise<boolean> {
        if (SketchEditor.getActive() === undefined) {
            PubSub.default.pub("displayError", "No active sketch editor");
            return Promise.resolve(false);
        }
        return Promise.resolve(true);
    }

    protected get editor(): SketchEditor {
        return SketchEditor.getActive()!;
    }

    protected override async executeAsync(): Promise<void> {
        if (!(await this.canExcute())) return;
        this.toolRegistration ??= this.editor.registerTool(this);
        if (await this.executeSteps()) {
            this.executeMainTask();
            this.repeatOperation = true;
            return;
        }
        // Escape (or a right-click) with picks already placed: the shape in progress
        // is dropped and the tool starts over, so the next Escape is the one that ends it
        if (this.stepDatas.length > 0 && !this.isCanceled) {
            this.stepDatas.length = 0;
            this._isRestarting = true;
        }
    }

    protected override afterExecute(): void {
        this.toolRegistration?.dispose();
        this.toolRegistration = undefined;
        super.afterExecute();
    }

    /**
     * Applies auto-constraints to a freshly added entity, then solves and commits.
     * `pointIndices` limits inference to the points the tool left free, when the tool
     * already attached the others itself.
     */
    protected commitNewEntity(entityId: number, pointIndices?: number[]): void {
        applyAutoConstraints(this.editor.solver, entityId, {
            ...sketchSnapOptions(this.editor.screenTolerance(), this.inferenceSuppressed()),
            pointIndices,
        });
        this.editor.solve(true);
        this.editor.commit();
    }

    /** Shift was held on one of the picks: no inferred constraints for this shape. */
    protected inferenceSuppressed(): boolean {
        return this.stepDatas.some((step) => (step as SketchPointSnapResult).suppressInference);
    }

    /** The step at `index` was completed by releasing a press-and-drag instead of a click. */
    protected stepWasDragged(index: number): boolean {
        return (this.stepDatas[index] as SketchPointSnapResult | undefined)?.dragged === true;
    }

    /** Sketch (u, v) of the point picked by the step at `index`. */
    protected uvOf(index: number): [number, number] {
        return toUV(this.editor.node.plane, this.stepDatas[index].point!);
    }
}
