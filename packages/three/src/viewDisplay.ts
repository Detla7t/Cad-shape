// Part of the Chili3d Project, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

import { type IEdge, type IFace, ShapeNode, ShapeTypes } from "@chili3d/core";
import { GreaterDepth } from "three";
import { LineMaterial } from "three/examples/jsm/lines/LineMaterial.js";
import { LineSegments2 } from "three/examples/jsm/lines/LineSegments2.js";
import { LineSegmentsGeometry } from "three/examples/jsm/lines/LineSegmentsGeometry.js";
import { Constants } from "./constants";
import { ThreeGeometry } from "./threeGeometry";
import type { ThreeView } from "./threeView";

export type ViewDisplayOptions = {
    hiddenEdges: boolean;
    tangentEdges: "visible" | "hidden" | "phantom";
    boundaryEdges: boolean;
};
interface DisplayCache {
    source: LineSegmentsGeometry;
    key: string;
    main: LineSegmentsGeometry;
    overlays: LineSegments2[];
}

/** Per-view presentation. The shared scene and pick buffers are restored after every render. */
export class ViewDisplay {
    readonly options: ViewDisplayOptions = {
        hiddenEdges: false,
        tangentEdges: "visible",
        boundaryEdges: false,
    };
    private readonly cache = new Map<ThreeGeometry, DisplayCache>();
    constructor(private readonly view: ThreeView) {}
    dispose() {
        for (const entry of this.cache.values()) this.release(entry);
        this.cache.clear();
    }
    private release(entry: DisplayCache) {
        entry.main.dispose();
        for (const overlay of entry.overlays) {
            overlay.geometry.dispose();
            overlay.material.dispose();
        }
    }
    render(draw: () => void) {
        const key = JSON.stringify(this.options);
        const restore: (() => void)[] = [];
        const seen = new Set<ThreeGeometry>();
        try {
            // Each camera supplies one headlight, even though the model scene is shared.
            for (const view of this.view.document.application.views) {
                if (view.document !== this.view.document || !("dynamicLight" in view)) continue;
                const light = (view as ThreeView).dynamicLight;
                const visible = light.visible;
                light.visible = view === this.view;
                restore.push(() => {
                    light.visible = visible;
                });
            }
            for (const visual of this.view.content.visuals()) {
                if (!(visual instanceof ThreeGeometry)) continue;
                seen.add(visual);
                const edges = visual.edges();
                const node = visual.geometryNode;
                if (!edges || !(node instanceof ShapeNode) || !node.shape.isOk || visual.renderOnTop)
                    continue;
                if (
                    !this.options.hiddenEdges &&
                    this.options.tangentEdges === "visible" &&
                    !this.options.boundaryEdges
                )
                    continue;
                let entry = this.cache.get(visual);
                if (entry?.source !== edges.geometry || entry.key !== key) {
                    if (entry) this.release(entry);
                    entry = this.build(visual, edges, node, key);
                    this.cache.set(visual, entry);
                }
                const source = edges.geometry;
                edges.geometry = entry.main;
                for (const overlay of entry.overlays) {
                    overlay.material.resolution.copy(edges.material.resolution);
                    visual.add(overlay);
                }
                const overlays = entry.overlays;
                restore.push(() => {
                    edges.geometry = source;
                    visual.remove(...overlays);
                });
            }
            draw();
        } finally {
            for (const reset of restore) reset();
            for (const [visual, entry] of this.cache)
                if (!seen.has(visual)) {
                    this.release(entry);
                    this.cache.delete(visual);
                }
        }
    }
    private build(visual: ThreeGeometry, edges: LineSegments2, node: ShapeNode, key: string): DisplayCache {
        const data = visual.geometryNode.mesh.edges!;
        const positions = new Float32Array(data.position);
        const tangents: number[] = [],
            boundaries: number[] = [];
        for (const range of data.range) {
            const edge = range.shape as unknown as IEdge;
            let tangent = false,
                boundary = false;
            try {
                const faces = edge.findAncestor(ShapeTypes.face, node.shape.value) as IFace[];
                boundary = faces.length === 1;
                tangent =
                    faces.length >= 2 &&
                    edge.hasContinuity(faces[0], faces[1]) &&
                    edge.continuity(faces[0], faces[1]) !== "c0";
            } catch {
                /* Imported display-only geometry can have no topology. Keep its edges. */
            }
            const start = range.start * 3,
                end = (range.start + range.count) * 3;
            if (boundary && this.options.boundaryEdges)
                boundaries.push(...data.position.subarray(start, end));
            if (tangent && this.options.tangentEdges !== "visible") {
                if (this.options.tangentEdges === "phantom")
                    tangents.push(...data.position.subarray(start, end));
                // Keep segment indices stable while making this range degenerate.
                for (let i = start; i < end; i += 3)
                    positions.set(data.position.subarray(start, start + 3), i);
            }
        }
        const main = edges.geometry.clone();
        main.setPositions(positions);
        const overlays: LineSegments2[] = [];
        const overlay = (
            points: ArrayLike<number>,
            options: { color?: number; hidden?: boolean; dashed?: boolean },
        ) => {
            if (!points.length) return;
            const geometry = new LineSegmentsGeometry().setPositions(Array.from(points));
            const material = new LineMaterial({
                color: options.color ?? edges.material.color,
                linewidth: options.color ? 1.7 : 1,
                depthWrite: false,
                dashed: options.dashed ?? false,
                dashSize: 3,
                gapSize: 2,
                ...(options.hidden ? { depthFunc: GreaterDepth } : {}),
                polygonOffset: true,
                polygonOffsetFactor: -2,
                polygonOffsetUnits: -2,
            });
            const line = new LineSegments2(geometry, material);
            line.computeLineDistances();
            line.raycast = () => {};
            line.layers.set(Constants.Layers.Wireframe);
            overlays.push(line);
        };
        overlay(tangents, { dashed: true });
        overlay(boundaries, { color: 0x428bd0 });
        if (this.options.hiddenEdges) overlay(positions, { hidden: true, dashed: true });
        return { source: edges.geometry, key, main, overlays };
    }
}
