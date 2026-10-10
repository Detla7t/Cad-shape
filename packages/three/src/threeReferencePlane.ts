// Part of the Chili3d Project, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

import type { ReferencePlaneNode, ShapeType } from "@chili3d/core";
import {
    BufferGeometry,
    type Camera,
    CanvasTexture,
    DoubleSide,
    Float32BufferAttribute,
    FrontSide,
    LineBasicMaterial,
    LineLoop,
    Matrix4,
    Mesh,
    MeshBasicMaterial,
    OrthographicCamera,
    PerspectiveCamera,
    PlaneGeometry,
    Vector2,
    Vector3,
    type WebGLRenderer,
} from "three";
import { Constants } from "./constants";
import { ThreeVisualObject } from "./threeVisualObject";

/**
 * The label quad's height on screen while it is zoom-independent, CSS pixels. The glyphs fill
 * about 56% of it (a 50 px face in a 64 px texture), so the name reads at Onshape's size: a cap
 * height of about 11 px in a fitted isometric view.
 */
const LABEL_PX = 20;
/** The label's width over its height (the texture's aspect). */
const LABEL_ASPECT = 8;
/** Outside this share of the plane's size the label follows the geometry instead. */
const LABEL_MIN = 1 / 40;
const LABEL_MAX = 1 / 10;

/** World units one CSS pixel covers at `point` for `camera`. */
function worldPerPixel(camera: Camera, point: Vector3, renderer: WebGLRenderer): number {
    const height = renderer.domElement.clientHeight || renderer.getSize(new Vector2()).y || 1;
    if (camera instanceof OrthographicCamera) return (camera.top - camera.bottom) / camera.zoom / height;
    if (camera instanceof PerspectiveCamera) {
        const distance = Math.abs(
            point.clone().sub(camera.position).dot(camera.getWorldDirection(new Vector3())),
        );
        return (2 * distance * Math.tan((camera.fov * Math.PI) / 360)) / height;
    }
    return 1;
}

/**
 * Bounded translucent datum with a name; intentionally has no kernel sub-shapes. The name
 * keeps a constant size on screen over the useful zoom range and follows the plane's
 * geometry beyond it (Onshape's plane labels): never smaller than a fortieth of the plane,
 * never larger than a tenth of it.
 */
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
            side: FrontSide,
            depthWrite: false,
            polygonOffset: true,
            polygonOffsetFactor: -1,
            polygonOffsetUnits: -1,
        }),
    );
    private readonly backLabel = new Mesh(this.label.geometry, this.label.material);

    /** Where the labels sit: the corner they hang off, the plane's axes and the inset. */
    private anchor?: {
        front: Vector3;
        back: Vector3;
        xvec: Vector3;
        yvec: Vector3;
        inset: number;
        size: number;
    };

    constructor(readonly planeNode: ReferencePlaneNode) {
        super(planeNode);
        this.label.name = "plane-label";
        this.backLabel.name = "plane-label-back";
        this.label.onBeforeRender = (renderer, _scene, camera) => this.fitLabels(renderer, camera);
        this.add(this.fill, this.outline, this.label, this.backLabel);
        // Reference planes remain available as sketch supports in every display mode.
        for (const visual of [this.fill, this.outline, this.label, this.backLabel]) {
            visual.layers.enable(Constants.Layers.Solid);
            visual.layers.enable(Constants.Layers.Wireframe);
        }
        this.rebuild();
        planeNode.onPropertyChanged(this.changed);
        this.label.raycast = () => {};
        this.backLabel.raycast = () => {};
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
            context.font = "500 50px sans-serif";
            context.fillStyle = "#487daf";
            context.fillText(this.planeNode.name, 6, 52, 500);
            this.label.material.map?.dispose();
            this.label.material.map = new CanvasTexture(canvas);
            this.label.material.needsUpdate = true;
        }
        const size = this.planeNode.size;
        const { xvec, yvec, normal } = this.planeNode.basePlane;
        this.anchor = {
            front: new Vector3(corners[3].x, corners[3].y, corners[3].z),
            back: new Vector3(corners[2].x, corners[2].y, corners[2].z),
            xvec: new Vector3(xvec.x, xvec.y, xvec.z),
            yvec: new Vector3(yvec.x, yvec.y, yvec.z),
            inset: size * 0.015,
            size,
        };
        this.label.quaternion.setFromRotationMatrix(
            new Matrix4().makeBasis(
                this.anchor.xvec,
                this.anchor.yvec,
                new Vector3(normal.x, normal.y, normal.z),
            ),
        );
        // A separate back-facing inscription stays readable from the other side, still coplanar.
        this.backLabel.quaternion.copy(this.label.quaternion);
        this.backLabel.rotateY(Math.PI);
        this.placeLabels(size / 16);
    }

    /** Lays both labels out at `height` (world units), hanging off their corners. */
    private placeLabels(height: number): void {
        const anchor = this.anchor;
        if (anchor === undefined) return;
        const width = height * LABEL_ASPECT;
        const { xvec, yvec, inset } = anchor;
        const p = anchor.front
            .clone()
            .add(xvec.clone().multiplyScalar(inset + width / 2))
            .sub(yvec.clone().multiplyScalar(inset + height / 2));
        this.label.position.copy(p);
        this.label.scale.set(width, height, 1);
        const back = anchor.back
            .clone()
            .sub(xvec.clone().multiplyScalar(inset + width / 2))
            .sub(yvec.clone().multiplyScalar(inset + height / 2));
        this.backLabel.position.copy(back);
        this.backLabel.scale.copy(this.label.scale);
    }

    /** Before each frame: the on-screen size the camera gives, clamped to the plane's range. */
    private fitLabels(renderer: WebGLRenderer, camera: Camera): void {
        const anchor = this.anchor;
        if (anchor === undefined) return;
        const perPixel = worldPerPixel(camera, this.label.position, renderer);
        const height = Math.min(
            anchor.size * LABEL_MAX,
            Math.max(anchor.size * LABEL_MIN, LABEL_PX * perPixel),
        );
        if (Math.abs(height - this.label.scale.y) < height * 1e-3) return;
        this.placeLabels(height);
        this.label.updateMatrixWorld();
        this.backLabel.updateMatrixWorld();
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
