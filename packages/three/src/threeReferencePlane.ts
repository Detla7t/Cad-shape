// Part of the Chili3d Project, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

import type { ReferencePlaneNode, ShapeType } from "@chili3d/core";
import {
    BufferGeometry,
    CanvasTexture,
    DoubleSide,
    Float32BufferAttribute,
    LineBasicMaterial,
    LineLoop,
    Matrix4,
    Mesh,
    MeshBasicMaterial,
    PlaneGeometry,
    Vector3,
} from "three";
import { Constants } from "./constants";
import { ThreeVisualObject } from "./threeVisualObject";

/** Bounded translucent datum with a name; intentionally has no kernel sub-shapes. */
export class ThreeReferencePlane extends ThreeVisualObject {
    private readonly fillMaterial = new MeshBasicMaterial({
        color: 0xacc7e2,
        side: DoubleSide,
        transparent: true,
        opacity: 0.12,
        depthWrite: false,
    });
    private readonly edgeMaterial = new LineBasicMaterial({ color: 0x91b6db });
    private readonly fill = new Mesh(new BufferGeometry(), this.fillMaterial);
    private readonly outline = new LineLoop(new BufferGeometry(), this.edgeMaterial);
    private readonly label = new Mesh(
        new PlaneGeometry(1, 1),
        new MeshBasicMaterial({
            transparent: true,
            side: DoubleSide,
            depthWrite: false,
            polygonOffset: true,
            polygonOffsetFactor: -1,
            polygonOffsetUnits: -1,
        }),
    );

    constructor(readonly planeNode: ReferencePlaneNode) {
        super(planeNode);
        this.label.name = "plane-label";
        this.add(this.fill, this.outline, this.label);
        // Reference planes remain available as sketch supports in every display mode.
        for (const visual of [this.fill, this.outline, this.label]) {
            visual.layers.enable(Constants.Layers.Solid);
            visual.layers.enable(Constants.Layers.Wireframe);
        }
        this.rebuild();
        planeNode.onPropertyChanged(this.changed);
        this.label.raycast = () => {};
    }

    private readonly changed = (property: keyof ReferencePlaneNode) => {
        if (["basePlane", "offset", "size", "name"].includes(property)) this.rebuild();
    };

    private rebuild() {
        const corners = this.planeNode.corners();
        const positions = corners.flatMap((p) => [p.x, p.y, p.z]);
        this.fill.geometry.dispose();
        this.fill.geometry = new BufferGeometry();
        this.fill.geometry.setAttribute("position", new Float32BufferAttribute(positions, 3));
        this.fill.geometry.setIndex([0, 1, 2, 0, 2, 3]);
        this.outline.geometry.dispose();
        this.outline.geometry = new BufferGeometry();
        this.outline.geometry.setAttribute("position", new Float32BufferAttribute(positions, 3));
        const canvas = document.createElement("canvas");
        canvas.width = 512;
        canvas.height = 64;
        const context = canvas.getContext("2d");
        if (context) {
            context.font = "30px sans-serif";
            context.fillStyle = "#487daf";
            context.fillText(this.planeNode.name, 4, 44, 504);
            this.label.material.map?.dispose();
            this.label.material.map = new CanvasTexture(canvas);
            this.label.material.needsUpdate = true;
        }
        const size = this.planeNode.size;
        const { xvec, yvec, normal } = this.planeNode.basePlane;
        const width = size * 0.5,
            height = size / 16,
            inset = size * 0.015;
        const p = corners[3].add(xvec.multiply(inset + width / 2)).sub(yvec.multiply(inset + height / 2));
        this.label.position.set(p.x, p.y, p.z);
        this.label.quaternion.setFromRotationMatrix(
            new Matrix4().makeBasis(
                new Vector3(xvec.x, xvec.y, xvec.z),
                new Vector3(yvec.x, yvec.y, yvec.z),
                new Vector3(normal.x, normal.y, normal.z),
            ),
        );
        this.label.scale.set(width, height, 1);
    }

    highlight() {
        this.fillMaterial.color.set(0xffc45c);
        this.fillMaterial.opacity = 0.3;
        this.edgeMaterial.color.set(0xe5a52d);
    }
    unhighlight() {
        this.fillMaterial.color.set(0xacc7e2);
        this.fillMaterial.opacity = 0.12;
        this.edgeMaterial.color.set(0x91b6db);
    }
    override wholeVisual() {
        return [this.fill];
    }
    override subShapeVisual(_type: ShapeType) {
        return [];
    }
    override getSubShapeAndIndex() {
        return { shape: undefined, subShape: undefined, index: -1, groups: [] };
    }
    override dispose() {
        this.planeNode.removePropertyChanged(this.changed);
        this.fill.geometry.dispose();
        this.outline.geometry.dispose();
        this.fillMaterial.dispose();
        this.edgeMaterial.dispose();
        this.label.material.map?.dispose();
        this.label.geometry.dispose();
        this.label.material.dispose();
        super.dispose();
    }
}
