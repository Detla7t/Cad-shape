// Part of the Chili3d Project, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

import {
    type BoundingBox,
    type IVisualObject,
    Matrix4,
    type PmiAnnotation,
    type PmiGeometry,
    pmiGeometry,
    XY,
    type XYZ,
} from "@chili3d/core";
import { type Camera, DoubleSide, type Mesh, Object3D, type Points, Vector3 } from "three";
import { LineMaterial } from "three/examples/jsm/lines/LineMaterial.js";
import { LineSegments2 } from "three/examples/jsm/lines/LineSegments2.js";
import { LineSegmentsGeometry } from "three/examples/jsm/lines/LineSegmentsGeometry.js";
import type { CSS2DObject } from "three/examples/jsm/renderers/CSS2DRenderer.js";
import { Constants } from "./constants";
import type { IHighlightable } from "./highlightable";
import { buildPmiFrame, buildTerminator, orientTerminator } from "./pmiElements";
import { TopRenderOrder } from "./threeGeometryFactory";
import { ThreeHelper } from "./threeHelper";
import type { ThreeVisualContext } from "./threeVisualContext";

const highlightMaterial = new LineMaterial({
    linewidth: 1.5,
    color: 0xffd400,
    side: DoubleSide,
    depthTest: false,
    transparent: true,
});

export interface ScreenSize {
    width: number;
    height: number;
}

/**
 * One HTML element a view places over the scene for an annotation: its frame or a marker
 * where a line meets the model. Every view builds its own element from `build` and calls
 * `beforeRender` with its camera each frame, so a frame can flip to the free side of its
 * leader and an arrowhead can turn with the line.
 */
export interface PmiLabel {
    readonly position: XYZ;
    /** The element point (fractions of its size) placed at `position`. */
    readonly center: XY;
    /** Set on the frame: the annotation a drag of this element moves (unless locked). */
    readonly annotation?: PmiAnnotation;
    build(): HTMLElement;
    beforeRender?(camera: Camera, object: CSS2DObject, size: ScreenSize): void;
}

/** The on-screen vector from `from` to `to` in pixels (y down). */
export function screenDelta(camera: Camera, size: ScreenSize, from: XYZ, to: XYZ): XY {
    const a = new Vector3(from.x, from.y, from.z).project(camera);
    const b = new Vector3(to.x, to.y, to.z).project(camera);
    return new XY(((b.x - a.x) * size.width) / 2, (-(b.y - a.y) * size.height) / 2);
}

function initialCenter(align: PmiGeometry["labelAlign"]): XY {
    switch (align) {
        case "leader":
            return new XY(0, 0.5);
        case "above":
            return new XY(0.5, 1);
        default:
            return new XY(0, 0);
    }
}

/**
 * The scene side of a PMI annotation: its leader, extension and dimension lines drawn on
 * top of the model, plus the label specs each view turns into HTML. Rebuilt whenever a
 * property of the node changes; `revision` tells the views to rebuild their elements.
 */
export class ThreePmiAnnotation extends Object3D implements IVisualObject, IHighlightable {
    locked: boolean = false;
    transform: Matrix4 = Matrix4.identity();
    /** Bumped on every rebuild; views compare it to refresh their labels. */
    revision = 0;
    highlighted = false;
    private _lines?: LineSegments2;
    private _material: LineMaterial;
    private _geometry: PmiGeometry;

    constructor(
        private readonly context: ThreeVisualContext,
        readonly annotation: PmiAnnotation,
    ) {
        super();
        this._material = this.newMaterial();
        this._geometry = pmiGeometry(annotation);
        this._lines = this.newLines(this._geometry);
        if (this._lines) this.add(this._lines);
        annotation.onPropertyChanged(this.onAnnotationChanged);
        context.pmiAnnotations.add(this);
    }

    private readonly onAnnotationChanged = () => {
        this.rebuild();
    };

    /** Lines and label specs follow the node; each view then refreshes its elements. */
    rebuild(): void {
        this._material.dispose();
        this._material = this.newMaterial();
        this._geometry = pmiGeometry(this.annotation);
        if (this._lines) {
            this.remove(this._lines);
            this._lines.geometry.dispose();
        }
        this._lines = this.newLines(this._geometry);
        if (this._lines) {
            this.add(this._lines);
            if (this.highlighted) this._lines.material = highlightMaterial;
        }
        this.revision++;
        this.context.visual?.update();
    }

    get geometry(): PmiGeometry {
        return this._geometry;
    }

    private newMaterial(): LineMaterial {
        return new LineMaterial({
            linewidth: this.annotation.lineWidth,
            color: this.annotation.color,
            side: DoubleSide,
            depthTest: false,
            transparent: true,
        });
    }

    private newLines(geometry: PmiGeometry): LineSegments2 | undefined {
        if (geometry.segments.length === 0) return undefined;
        const buffer = new LineSegmentsGeometry();
        buffer.setPositions(geometry.segments.flatMap(([a, b]) => [a.x, a.y, a.z, b.x, b.y, b.z]));
        buffer.computeBoundingBox();
        const lines = new LineSegments2(buffer, this._material);
        lines.layers.set(Constants.Layers.Wireframe);
        lines.renderOrder = TopRenderOrder;
        return lines;
    }

    /** The frame and the terminators, in world coordinates. */
    labels(): PmiLabel[] {
        const geometry = this._geometry;
        const annotation = this.annotation;
        const frame: PmiLabel = {
            annotation,
            position: geometry.labelPoint,
            center: initialCenter(geometry.labelAlign),
            build: () => buildPmiFrame(annotation, () => this.select()),
            beforeRender:
                geometry.labelAlign === "leader"
                    ? (camera, object, size) => {
                          const delta = screenDelta(camera, size, geometry.labelFrom, geometry.labelPoint);
                          object.center.set(delta.x >= 0 ? 0 : 1, 0.5);
                      }
                    : undefined,
        };
        const terminators = geometry.terminators.map(
            (terminator): PmiLabel => ({
                position: terminator.point,
                center: new XY(0.5, 0.5),
                build: () => buildTerminator(terminator.shape, annotation.color),
                beforeRender: (camera, object, size) => {
                    const delta = screenDelta(camera, size, terminator.point, terminator.toward);
                    orientTerminator(object.element, Math.atan2(delta.y, delta.x));
                },
            }),
        );
        return [frame, ...terminators];
    }

    private select(): void {
        const document = this.annotation.document;
        document.selection.setSelectedNodes([this.annotation], false);
        document.visual.update();
    }

    highlight(): void {
        this.highlighted = true;
        if (this._lines) this._lines.material = highlightMaterial;
        this.context.visual?.update();
    }

    unhighlight(): void {
        this.highlighted = false;
        if (this._lines) this._lines.material = this._material;
        this.context.visual?.update();
    }

    wholeVisual(): (Mesh | LineSegments2 | Points)[] {
        return this._lines ? [this._lines] : [];
    }

    boundingBox(): BoundingBox | undefined {
        return this.annotation.boundingBox() ?? (this._lines ? ThreeHelper.getBoundingBox(this) : undefined);
    }

    worldTransform(): Matrix4 {
        return Matrix4.identity();
    }

    dispose(): void {
        this.annotation.removePropertyChanged(this.onAnnotationChanged);
        this.context.pmiAnnotations.delete(this);
        this._lines?.geometry.dispose();
        this._material.dispose();
    }
}
