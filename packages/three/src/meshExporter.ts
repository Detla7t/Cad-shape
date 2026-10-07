// Part of the Chili3d Project, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

import { type IMeshExporter, type INode, NodeUtils, Result, type VisualNode } from "@chili3d/core";
import { Color, Group, type Material, Mesh, MeshStandardMaterial, Object3D } from "three";
import { GLTFExporter } from "three/examples/jsm/exporters/GLTFExporter.js";
import { OBJExporter } from "three/examples/jsm/exporters/OBJExporter.js";
import { PLYExporter } from "three/examples/jsm/exporters/PLYExporter.js";
import { STLExporter } from "three/examples/jsm/exporters/STLExporter.js";
import { Line2 } from "three/examples/jsm/lines/Line2.js";
import { LineSegments2 } from "three/examples/jsm/lines/LineSegments2.js";
import type { ThreeVisualContext } from "./threeVisualContext";

export class ThreeMeshExporter implements IMeshExporter {
    constructor(readonly content: ThreeVisualContext) {}

    exportToStl(nodes: VisualNode[], asciiMode: boolean): Result<BlobPart> {
        const exporter = new STLExporter();
        const group = this.parseNodeToGroup(nodes);
        const blob = exporter.parse(group, { binary: !asciiMode });
        this.disposeObject(group);
        return Result.ok(blob as BlobPart);
    }

    exportToPly(nodes: VisualNode[], asciiMode: boolean): Result<BlobPart> {
        const exporter = new PLYExporter();
        const group = this.parseNodeToGroup(nodes);
        const blobPart = exporter.parse(group, () => {}, { binary: !asciiMode });
        this.disposeObject(group);
        if (!blobPart) {
            return Result.err("can not export to ply");
        }
        return Result.ok(blobPart);
    }

    exportToObj(nodes: VisualNode[]): Result<BlobPart> {
        const exporter = new OBJExporter();
        const group = this.parseNodeToGroup(nodes);
        const blobPart = exporter.parse(group);
        this.disposeObject(group);
        return Result.ok(blobPart);
    }

    /**
     * glTF 2.0 through three's GLTFExporter: every model node becomes a named glTF node
     * (groups and folders keep their hierarchy), its faces carry the node's color as a
     * PBR material, and placements are baked into each node's matrix. glTF is Y-up in
     * metres; a root node rotates Chili3D's Z-up millimetres into that frame, so the vertex
     * data stays in millimetres.
     */
    async exportToGltf(nodes: VisualNode[], binary: boolean): Promise<Result<BlobPart>> {
        const root = new Group();
        root.name = "Chili3D";
        root.rotation.x = -Math.PI / 2;
        root.scale.setScalar(0.001);
        const materials = new Map<Material, MeshStandardMaterial>();
        for (const node of nodes) {
            const object = this.gltfObject(node, materials);
            if (object !== undefined) root.add(object);
        }
        try {
            const result = await new GLTFExporter().parseAsync(root, {
                binary,
                onlyVisible: false,
                trs: false,
            });
            return Result.ok(result instanceof ArrayBuffer ? result : JSON.stringify(result));
        } catch (error) {
            return Result.err(error instanceof Error ? error.message : String(error));
        } finally {
            for (const material of materials.values()) material.dispose();
        }
    }

    private gltfObject(node: INode, materials: Map<Material, MeshStandardMaterial>): Object3D | undefined {
        const parts: Object3D[] = [];
        if (NodeUtils.isLinkedListNode(node)) {
            for (let child = node.firstChild; child !== undefined; child = child.nextSibling) {
                const object = this.gltfObject(child, materials);
                if (object !== undefined) parts.push(object);
            }
        } else {
            const visual = this.content.getVisual(node);
            if (visual instanceof Object3D) {
                visual.updateWorldMatrix(true, true);
                visual.traverse((child) => {
                    if (child instanceof LineSegments2 || child instanceof Line2 || !(child instanceof Mesh))
                        return;
                    const mesh = new Mesh(child.geometry, this.gltfMaterial(child.material, materials));
                    mesh.name = node.name;
                    child.matrixWorld.decompose(mesh.position, mesh.quaternion, mesh.scale);
                    parts.push(mesh);
                });
            }
        }
        if (parts.length === 0) return undefined;
        if (parts.length === 1 && parts[0] instanceof Mesh) return parts[0];
        const group = new Group();
        group.name = node.name;
        group.add(...parts);
        return group;
    }

    private gltfMaterial(
        material: Material | Material[],
        materials: Map<Material, MeshStandardMaterial>,
    ): MeshStandardMaterial | MeshStandardMaterial[] {
        if (Array.isArray(material)) {
            return material.map((item) => this.gltfMaterial(item, materials) as MeshStandardMaterial);
        }
        let converted = materials.get(material);
        if (converted === undefined) {
            const source = (material as Material & { color?: unknown }).color;
            const color = source instanceof Color ? source.clone() : new Color(0xdedede);
            converted = new MeshStandardMaterial({
                name: material.name || `#${color.getHexString()}`,
                color,
                opacity: material.opacity,
                transparent: material.transparent || material.opacity < 1,
                side: material.side,
                metalness: 0,
                roughness: 0.8,
            });
            materials.set(material, converted);
        }
        return converted;
    }

    private disposeObject(object: Object3D) {
        object.traverse((child) => {
            if (child instanceof Mesh) {
                child.geometry.dispose();
            }
        });
    }

    private parseNodeToGroup(nodes: VisualNode[]) {
        const group = new Group();
        nodes.forEach((node) => {
            const visualObject = this.content.getVisual(node);
            if (visualObject instanceof Object3D) {
                visualObject.traverse((child) => {
                    if (child instanceof LineSegments2 || child instanceof Line2) {
                        return;
                    }
                    if (child instanceof Mesh) {
                        group.add(child.clone(false));
                    }
                });
            }
        });

        return group;
    }
}
