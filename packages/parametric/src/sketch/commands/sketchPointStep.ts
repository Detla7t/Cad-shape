// Part of the Chili3d Project, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

import { type AsyncController, type IDocument, type PointSnapData, PointStep } from "@chili3d/core";
import type { DragSnap, TentativeEntity } from "../autoConstraints";
import { SketchPointSnapEventHandler } from "./sketchPointSnapEventHandler";

/**
 * Point-snap data of the sketch drawing commands. `tentative` describes the entity
 * the probe would complete: it does not exist yet, so only the command — which
 * knows how it will be built — can hand it over, and the snap hint judges it for
 * the tangency the entity would get.
 */
export interface SketchPointSnapData extends PointSnapData {
    tentative?: (probe: [number, number]) => TentativeEntity | undefined;
    /**
     * Where the pick may land, judged by its sketch snap (undefined when nothing
     * snapped): a tangent arc starts only on the end of a line or arc. A refused
     * position is no valid point, like one the step's `validator` refuses.
     */
    acceptSnap?: (snap: DragSnap | undefined) => boolean;
}

/**
 * PointStep for in-sketch drawing commands: snaps to sketch targets, shows the
 * constraint icon as the hint, and renders the marker/preview on top so
 * occluding bodies can't hide them.
 */
export class SketchPointStep extends PointStep {
    protected override getEventHandler(
        document: IDocument,
        controller: AsyncController,
        data: PointSnapData,
    ) {
        const handler = new SketchPointSnapEventHandler(document, controller, data);
        handler.facePreviewOpion = { meshOpacity: 1, onTop: true };
        handler.tempPointOption = { onTop: true };
        return handler;
    }
}
