// Part of the Chili3d Project, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

import {
    type EdgeMeshData,
    formatDocumentValue,
    type IDisposable,
    type IView,
    LENGTH_UNITS,
    type MeasurementResult,
    MeshDataUtils,
    XYZ,
} from "@chili3d/core";
import style from "./viewportUtilities.module.css";

const GUIDE_COLOR = 0x1683b9;

/**
 * The dashed outline and label of the selection measurement. They are drawn in the 3D scene
 * — an on-top dashed line mesh, endpoint points and a 3D-anchored label — so the renderer
 * draws them in the same frame and with the same camera as the measured geometry: while the
 * view rotates they stay on the edges they measure instead of trailing behind as a separately
 * projected overlay would.
 */
export class MeasurementGuide {
    private meshIds: number[] = [];
    private label?: IDisposable;

    constructor(private readonly view: IView) {}

    show(result?: MeasurementResult) {
        this.clear();
        if (!result) return;
        const segments = result.segments.filter((pair) =>
            pair.every((p) => Number.isFinite(p.x) && Number.isFinite(p.y) && Number.isFinite(p.z)),
        );
        if (segments.length === 0) return;
        const context = this.view.document.visual.context;
        const length = segments.reduce((sum, [a, b]) => sum + new XYZ(a).distanceTo(new XYZ(b)), 0);
        // Dashes are measured along the line in model units: size them to the guide so a long
        // edge and a short one both read as dashed.
        const dash = Math.max(length / 60, 1e-3);
        const outline: EdgeMeshData = {
            position: new Float32Array(segments.flatMap(([a, b]) => [a.x, a.y, a.z, b.x, b.y, b.z])),
            range: [],
            color: GUIDE_COLOR,
            lineType: "dash",
            dashSize: dash,
            gapSize: dash * 0.6,
            lineWidth: 1.5,
        };
        this.meshIds.push(context.displayMesh([outline], { onTop: true }));
        if (result.mode !== "length") {
            for (const point of segments[0]) {
                const marker = MeshDataUtils.createVertexMesh(new XYZ(point), 6, GUIDE_COLOR);
                this.meshIds.push(context.displayMesh([marker], { onTop: true }));
            }
        }
        const [a, b] = segments[Math.floor(segments.length / 2)];
        const middle = new XYZ(a).add(new XYZ(b)).multiply(0.5);
        const text = `${result.label}: ${formatDocumentValue(result.value, this.view.document, LENGTH_UNITS)}`;
        this.label = this.view.htmlText(text, middle, {
            hideDelete: true,
            className: style.guideLabel,
            // Just above the guide's midpoint.
            center: { x: 0.5, y: 1.4 },
        });
        this.view.update();
    }

    private clear() {
        const context = this.view.document.visual.context;
        for (const id of this.meshIds) context.removeMesh(id);
        this.meshIds = [];
        this.label?.dispose();
        this.label = undefined;
    }

    dispose() {
        this.clear();
        this.view.update();
    }
}
