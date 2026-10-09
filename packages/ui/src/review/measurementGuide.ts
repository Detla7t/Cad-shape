// Part of the Chili3d Project, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

import {
    type EdgeMeshData,
    formatDocumentValue,
    type IDisposable,
    type IView,
    LENGTH_UNITS,
    type MeasurementDetail,
    type MeasurementResult,
    MeshDataUtils,
    XYZ,
} from "@chili3d/core";
import style from "./viewportUtilities.module.css";

const GUIDE_COLOR = 0x1683b9;
/** ΔX, ΔY, ΔZ legs in the axis colours, as Onshape draws them. */
const AXIS_COLORS = { x: 0xd0312d, y: 0x2e9d3a, z: 0x2f6fd6 } as const;

/**
 * The dashed outline and label of the selection measurement. They are drawn in the 3D scene
 * — an on-top dashed line mesh, endpoint points and a 3D-anchored label — so the renderer
 * draws them in the same frame and with the same camera as the measured geometry: while the
 * view rotates they stay on the edges they measure instead of trailing behind as a separately
 * projected overlay would.
 */
export class MeasurementGuide {
    private meshIds: number[] = [];
    private labels: IDisposable[] = [];

    constructor(private readonly view: IView) {}

    show(result?: MeasurementResult, details: readonly MeasurementDetail[] = []) {
        this.clear();
        if (!result) return;
        this.showComponents(details);
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
        this.labels.push(
            this.view.htmlText(text, middle, {
                hideDelete: true,
                className: style.guideLabel,
                // Just above the guide's midpoint.
                center: { x: 0.5, y: 1.4 },
            }),
        );
        this.view.update();
    }

    /** The distance's ΔX/ΔY/ΔZ legs, each in its axis colour, labelled when it is not zero. */
    private showComponents(details: readonly MeasurementDetail[]) {
        const context = this.view.document.visual.context;
        for (const detail of details) {
            if (!detail.axis || !detail.segments?.length || detail.value < 1e-6) continue;
            const [a, b] = detail.segments[0];
            const dash = Math.max(detail.value / 40, 1e-3);
            const leg: EdgeMeshData = {
                position: new Float32Array([a.x, a.y, a.z, b.x, b.y, b.z]),
                range: [],
                color: AXIS_COLORS[detail.axis],
                lineType: "dash",
                dashSize: dash,
                gapSize: dash * 0.6,
                lineWidth: 1,
            };
            this.meshIds.push(context.displayMesh([leg], { onTop: true }));
            const middle = new XYZ(a).add(new XYZ(b)).multiply(0.5);
            const text = `${detail.label} ${formatDocumentValue(detail.value, this.view.document, LENGTH_UNITS)}`;
            this.labels.push(
                this.view.htmlText(text, middle, {
                    hideDelete: true,
                    className: `${style.guideLabel} ${style[`axis${detail.axis.toUpperCase()}`] ?? ""}`,
                    center: { x: 0.5, y: 0.5 },
                }),
            );
        }
    }

    private clear() {
        const context = this.view.document.visual.context;
        for (const id of this.meshIds) context.removeMesh(id);
        this.meshIds = [];
        for (const label of this.labels) label.dispose();
        this.labels = [];
    }

    dispose() {
        this.clear();
        this.view.update();
    }
}
