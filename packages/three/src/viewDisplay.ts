// Part of the Chili3d Project, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

import { Config, type IEdge, type IFace, ShapeNode, ShapeTypes } from "@chili3d/core";
import { GreaterDepth, type Material, MeshLambertMaterial, MeshPhongMaterial } from "three";
import { LineMaterial } from "three/examples/jsm/lines/LineMaterial.js";
import { LineSegments2 } from "three/examples/jsm/lines/LineSegments2.js";
import { LineSegmentsGeometry } from "three/examples/jsm/lines/LineSegmentsGeometry.js";
import { Constants } from "./constants";
import { ThreeGeometry } from "./threeGeometry";
import type { ThreeView } from "./threeView";
import { ThreeMeshObject } from "./threeVisualObject";

export type ViewDisplayOptions = {
    translucent: boolean;
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
        translucent: false,
        hiddenEdges: false,
        tangentEdges: "visible",
        boundaryEdges: false,
    };
    private readonly materials = new Map<Material, MeshPhongMaterial>();
    private readonly cache = new Map<ThreeGeometry, DisplayCache>();
    constructor(private readonly view: ThreeView) {}
    dispose() {
        this.materials.forEach((material) => material.dispose());
        this.materials.clear();
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
        const graphics = Config.instance.graphics;
        const key = JSON.stringify([this.options, graphics.phantomLineWidth, graphics.phantomColor]);
        const restore: (() => void)[] = [];
        const seen = new Set<ThreeGeometry>();
        const seenMaterials = new Set<Material>();
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
                if (visual instanceof ThreeMeshObject && visual.mesh instanceof LineSegments2) {
                    const material = visual.mesh.material,
                        before = material.linewidth;
                    material.linewidth = graphics.meshLineWidth;
                    restore.push(() => {
                        material.linewidth = before;
                    });
                }
                if (!(visual instanceof ThreeGeometry)) continue;
                seen.add(visual);
                const faces = visual.faces();
                if (faces && !visual.renderOnTop) {
                    const original = faces.material;
                    const mapped = (Array.isArray(original) ? original : [original]).map((source) => {
                        if (
                            !(source instanceof MeshLambertMaterial) &&
                            !(source instanceof MeshPhongMaterial)
                        )
                            return source;
                        seenMaterials.add(source);
                        let material = this.materials.get(source);
                        if (!material) {
                            material =
                                source instanceof MeshPhongMaterial
                                    ? source.clone()
                                    : new MeshPhongMaterial();
                            this.materials.set(source, material);
                        }
                        material.color.copy(source.color);
                        material.map = source.map;
                        material.vertexColors = source.vertexColors;
                        material.side = source.side;
                        material.polygonOffset = source.polygonOffset;
                        material.polygonOffsetFactor = source.polygonOffsetFactor;
                        material.polygonOffsetUnits = source.polygonOffsetUnits;
                        material.opacity = this.options.translucent
                            ? Math.min(source.opacity, 0.3)
                            : source.opacity;
                        material.transparent = material.opacity < 1;
                        material.depthWrite = !this.options.translucent && source.depthWrite;
                        material.shininess = graphics.shininess;
                        material.specular.set(graphics.specularColor);
                        return material;
                    });
                    faces.material = Array.isArray(original) ? mapped : mapped[0];
                    restore.push(() => {
                        faces.material = original;
                    });
                    if (this.options.translucent) {
                        for (const material of mapped)
                            if (!(material instanceof MeshPhongMaterial)) {
                                const opacity = material.opacity,
                                    transparent = material.transparent,
                                    depthWrite = material.depthWrite;
                                material.opacity = Math.min(opacity, 0.3);
                                material.transparent = true;
                                material.depthWrite = false;
                                restore.push(() => {
                                    material.opacity = opacity;
                                    material.transparent = transparent;
                                    material.depthWrite = depthWrite;
                                });
                            }
                    }
                }
                const edges = visual.edges();
                if (edges && !visual.renderOnTop && nodeIsBody(visual)) {
                    const material = edges.material,
                        width = material.linewidth;
                    material.linewidth = graphics.bodyLineWidth;
                    restore.push(() => {
                        material.linewidth = width;
                    });
                }
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
            for (const reset of restore.reverse()) reset();
            for (const [source, material] of this.materials)
                if (!seenMaterials.has(source)) {
                    material.dispose();
                    this.materials.delete(source);
                }
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
                color:
                    options.color ??
                    (options.hidden ? edges.material.color : Config.instance.graphics.phantomColor),
                linewidth: options.color
                    ? 1.7
                    : options.hidden
                      ? 1
                      : Config.instance.graphics.phantomLineWidth,
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

function nodeIsBody(visual: ThreeGeometry) {
    return (
        visual.geometryNode.display() !== "body.sketch" && !!visual.geometryNode.mesh.faces?.position.length
    );
}
