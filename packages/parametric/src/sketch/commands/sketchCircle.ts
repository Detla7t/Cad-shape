// Part of the Chili3d Project, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

import { command, Dimensions, type IStep, PubSub, type XYZ } from "@chili3d/core";
import { toUV, toWorld } from "../sketchModel";
import { SketchMultistepCommand } from "./sketchMultistepCommand";
import { type SketchPointSnapData, SketchPointStep } from "./sketchPointStep";

/** Circle params in sketch uv: `center` and the radius out to a rim point `rim`. */
function circleParams(center: [number, number], rim: [number, number]): [number, number, number] {
    return [center[0], center[1], Math.hypot(rim[0] - center[0], rim[1] - center[1])];
}

@command({ key: "sketch.circle", icon: "icon-circle" })
export class SketchCircleCommand extends SketchMultistepCommand {
    getSteps(): IStep[] {
        return [
            new SketchPointStep("prompt.pickCircleCenter"),
            new SketchPointStep("prompt.pickRadius", this.getRadiusData),
        ];
    }

    protected executeMainTask(): void {
        const [cx, cy, radius] = circleParams(this.uvOf(0), this.uvOf(1));
        this.commitNewEntity(this.editor.solver.addCircle(cx, cy, radius));
    }

    private readonly getRadiusData = (): SketchPointSnapData => ({
        refPoint: () => this.stepDatas[0].point!,
        dimension: Dimensions.D1,
        preview: this.circlePreview,
        tentative: (probe) => ({ type: "circle", params: circleParams(this.uvOf(0), probe) }),
    });

    private readonly circlePreview = (point: XYZ | undefined) => {
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
}

/** Circumcircle in sketch coordinates. Collinear points do not define a circle. */
export function circleThroughPoints(
    a: [number, number],
    b: [number, number],
    c: [number, number],
): [number, number, number] | undefined {
    const bx = b[0] - a[0],
        by = b[1] - a[1],
        cx = c[0] - a[0],
        cy = c[1] - a[1];
    const d = 2 * (bx * cy - by * cx);
    if (Math.abs(d) < 1e-9 * Math.max(1, Math.hypot(bx, by) * Math.hypot(cx, cy))) return undefined;
    const bb = bx * bx + by * by,
        cc = cx * cx + cy * cy;
    const x = (cy * bb - by * cc) / d,
        y = (bx * cc - cx * bb) / d;
    return [a[0] + x, a[1] + y, Math.hypot(x, y)];
}

@command({ key: "sketch.circle3Point", icon: "icon-circle" })
export class SketchThreePointCircleCommand extends SketchMultistepCommand {
    getSteps(): IStep[] {
        return [
            new SketchPointStep("prompt.pickFistPoint"),
            new SketchPointStep("prompt.pickNextPoint"),
            new SketchPointStep("prompt.pickNextPoint", () => ({ preview: this.previewCircle })),
        ];
    }
    protected executeMainTask(): void {
        const circle = circleThroughPoints(this.uvOf(0), this.uvOf(1), this.uvOf(2));
        if (!circle) {
            PubSub.default.pub("displayError", "Choose three non-collinear points for a circle.");
            return;
        }
        this.commitNewEntity(this.editor.solver.addCircle(...circle));
    }
    private readonly previewCircle = (point: XYZ | undefined) => {
        if (!point) return [];
        const plane = this.editor.node.plane;
        const circle = circleThroughPoints(this.uvOf(0), this.uvOf(1), toUV(plane, point));
        if (!circle) return [this.meshLine(this.stepDatas[0].point!, point)];
        return [
            this.meshCreatedShape("circle", plane.normal, toWorld(plane, circle[0], circle[1]), circle[2]),
        ];
    };
}
