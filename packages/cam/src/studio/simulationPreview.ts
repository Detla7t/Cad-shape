// Part of the Chili3d Project, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

import type { FaceMeshData, IDisposable, IDocument, INode } from "@chili3d/core";
import type { StockMeshData } from "@chili3d/rs";
import { type WcsData, wcsPointToModel, wcsVectorToModel, wcsYAxis } from "../context/wcs";
import type { ToolData } from "../model/tool";
import type { Vec3 } from "../model/toolpath";
import { cylinderMesh, markerMatrix } from "./toolpathPreview";

/**
 * The simulated stock drawn in the model, like the toolpath preview: a temporary mesh of the
 * document's visual context (nothing enters the model or its undo history), moved out of the
 * setup's WCS, coloured per vertex by its deviation from the parts — green on the part,
 * blue where material is left (paler for thin allowances, deeper for thick ones), red where
 * a cut went below it — or plain stock grey without parts. While it shows, the parts' own
 * visuals are hidden (the finished stock coincides with them) and come back with `clear`.
 */

export const STOCK_COLOR = 0xb0b8c4;
export const ON_PART_COLOR = 0x43a047;
export const EXCESS_COLOR = 0x1e88e5;
export const GOUGE_COLOR = 0xe53935;

const rgb = (color: number): [number, number, number] => [
    ((color >> 16) & 0xff) / 255,
    ((color >> 8) & 0xff) / 255,
    (color & 0xff) / 255,
];

const STOCK = rgb(STOCK_COLOR);
const ON_PART = rgb(ON_PART_COLOR);
const GOUGE = rgb(GOUGE_COLOR);
const THIN = [0.62, 0.86, 0.97] as const;
const THICK = [0.1, 0.32, 0.78] as const;

/** Excess this thick (mm) or more is drawn in the deepest blue. */
const THICK_EXCESS = 5;

/** The colour (rgb, 0–1) of a deviation from the part, mm (NaN: no part there). */
export function deviationColor(deviation: number, tolerance: number): readonly [number, number, number] {
    if (Number.isNaN(deviation)) return STOCK;
    if (deviation < -tolerance) return GOUGE;
    if (deviation <= tolerance) return ON_PART;
    const t = Math.min(
        1,
        Math.max(0, Math.log(deviation / tolerance) / Math.log(THICK_EXCESS / Math.max(tolerance, 1e-6))),
    );
    return [
        THIN[0] + (THICK[0] - THIN[0]) * t,
        THIN[1] + (THICK[1] - THIN[1]) * t,
        THIN[2] + (THICK[2] - THIN[2]) * t,
    ];
}

/** Per-vertex colours of a mesh's deviations, as the visual context takes them. */
export function deviationColors(deviation: Float32Array, tolerance: number): number[] {
    const colors = new Array<number>(deviation.length * 3);
    for (let k = 0; k < deviation.length; k++) {
        const [r, g, b] = deviationColor(deviation[k], tolerance);
        colors[k * 3] = r;
        colors[k * 3 + 1] = g;
        colors[k * 3 + 2] = b;
    }
    return colors;
}

/** A WCS mesh in model coordinates. */
export function stockMeshToModel(mesh: StockMeshData, wcs: WcsData, tolerance: number): FaceMeshData {
    const { origin: o, xAxis: x, zAxis: z } = wcs;
    const y = wcsYAxis(wcs);
    const source = mesh.positions;
    const normals = mesh.normals;
    const position = new Float32Array(source.length);
    const normal = new Float32Array(normals.length);
    for (let k = 0; k < source.length; k += 3) {
        const [px, py, pz] = [source[k], source[k + 1], source[k + 2]];
        const [nx, ny, nz] = [normals[k], normals[k + 1], normals[k + 2]];
        for (let a = 0; a < 3; a++) {
            position[k + a] = o[a] + px * x[a] + py * y[a] + pz * z[a];
            normal[k + a] = nx * x[a] + ny * y[a] + nz * z[a];
        }
    }
    return {
        position,
        normal,
        index: mesh.indices,
        uv: new Float32Array((source.length / 3) * 2),
        groups: [],
        range: [],
        color: mesh.deviation === undefined ? STOCK_COLOR : deviationColors(mesh.deviation, tolerance),
    };
}

export class SimulationPreview implements IDisposable {
    private meshId: number | undefined;
    private marker: { id: number; key: string } | undefined;
    private hidden: INode[] = [];

    constructor(readonly document: IDocument) {}

    get visible(): boolean {
        return this.meshId !== undefined;
    }

    /** Draws the stock (replacing what was shown) and hides `parts`' visuals. */
    show(mesh: StockMeshData, wcs: WcsData, tolerance: number, parts: readonly INode[] = []): void {
        const context = this.document.visual.context;
        const id = context.displayMesh([stockMeshToModel(mesh, wcs, tolerance)]);
        if (this.meshId !== undefined) context.removeMesh(this.meshId);
        this.meshId = id;
        for (const node of parts) {
            if (this.hidden.includes(node)) continue;
            context.setVisible(node, false);
            this.hidden.push(node);
        }
        this.document.visual.update();
    }

    /** Puts the tool (a cylinder of its diameter and flute length) with its tip at `tip` (WCS). */
    showTool(tip: Vec3, wcs: WcsData, tool: ToolData): void {
        const context = this.document.visual.context;
        const radius = Math.max(0.1, tool.diameter / 2);
        const height = Math.max(radius * 2, tool.fluteLength ?? tool.stickout ?? radius * 6);
        const key = `${radius}:${height}`;
        const matrix = markerMatrix(wcsPointToModel(wcs, tip), wcsVectorToModel(wcs, [0, 0, 1]));
        if (this.marker !== undefined && this.marker.key !== key) this.hideTool();
        if (this.marker === undefined) {
            this.marker = {
                id: context.displayInstancedMesh(cylinderMesh(radius, height), [matrix], {
                    meshOpacity: 0.75,
                }),
                key,
            };
        } else {
            context.setInstanceMatrix(this.marker.id, [matrix]);
        }
        this.document.visual.update();
    }

    hideTool(): void {
        if (this.marker === undefined) return;
        this.document.visual.context.removeMesh(this.marker.id);
        this.marker = undefined;
        this.document.visual.update();
    }

    /** Removes the stock and the tool and shows the parts again. */
    clear(): void {
        const context = this.document.visual.context;
        if (this.meshId !== undefined) context.removeMesh(this.meshId);
        this.meshId = undefined;
        this.hideTool();
        for (const node of this.hidden) context.setVisible(node, true);
        this.hidden = [];
        this.document.visual.update();
    }

    dispose(): void {
        this.clear();
    }
}
