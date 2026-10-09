// Part of the Chili3d Project, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

import {
    type BoundingBox,
    type EdgeMeshData,
    type FaceMeshData,
    type GeometryNode,
    type IShape,
    type ISubShape,
    type IVisualGeometry,
    type Matrix4,
    MeshUtils,
    OriginNode,
    type ShapeMeshRange,
    ShapeNode,
    type ShapeType,
    ShapeTypes,
    ShapeTypeUtils,
    type VertexMeshData,
} from "@chili3d/core";
import {
    type Material,
    Mesh,
    type MeshLambertMaterial,
    type Object3D,
    Points,
    type PointsMaterial,
} from "three";
import type { LineMaterial } from "three/examples/jsm/lines/LineMaterial.js";
import { LineSegments2 } from "three/examples/jsm/lines/LineSegments2.js";
import { LineSegmentsGeometry } from "three/examples/jsm/lines/LineSegmentsGeometry.js";
import { Constants } from "./constants";
import {
    defaultEdgeMaterial,
    defaultVertexMaterial,
    edgeMaterialOfWidth,
    lockFaceMaterial,
    lockLineMaterial,
    originVertexMaterial,
} from "./materials";
import { ThreeGeometryFactory, TopRenderOrder } from "./threeGeometryFactory";
import { ThreeHelper } from "./threeHelper";
import type { ThreeVisualContext } from "./threeVisualContext";
import { ThreeVisualObject } from "./threeVisualObject";

const OnTopMaterialKey = "onTopMaterial";

export class ThreeGeometry extends ThreeVisualObject implements IVisualGeometry {
    private _vertexMaterial?: PointsMaterial;
    private get vertexMaterial() {
        if (this._vertexMaterial !== undefined) return this._vertexMaterial;
        return this.geometryNode instanceof OriginNode ? originVertexMaterial : defaultVertexMaterial;
    }
    private _faceMaterial: Material | Material[];
    /** Set while the faces draw a translucent region fill of their own instead of the node material. */
    private ownsFaceMaterial = false;
    private _edgeMaterial: LineMaterial = defaultEdgeMaterial;
    private _edges?: LineSegments2;
    private ownsEdgeMaterial = false;
    private ownsVertexMaterial = false;
    private _faces?: Mesh;
    private _vertexs?: Points;
    private _renderOnTop = false;

    constructor(
        readonly geometryNode: GeometryNode,
        readonly context: ThreeVisualContext,
    ) {
        super(geometryNode);
        this._faceMaterial = context.getMaterial(geometryNode.materialId);
        this.generateShape();
        geometryNode.onPropertyChanged(this.handleGeometryPropertyChanged);
    }

    changeFaceMaterial(material: Material | Material[]) {
        if (this._faces) {
            this._faceMaterial = material;
            this._faces.material = material;
        }
    }

    get renderOnTop(): boolean {
        return this._renderOnTop;
    }

    /**
     * Toggles depth-test-free rendering above the rest of the scene (used while the
     * node is being edited, e.g. a sketch). Re-applied to meshes rebuilt later.
     */
    setRenderOnTop(value: boolean): void {
        if (this._renderOnTop === value) return;
        this._renderOnTop = value;
        if (this._vertexs) this.applyOnTopMaterial(this._vertexs, this.vertexMaterial);
        if (this._edges) this.applyOnTopMaterial(this._edges, this._edgeMaterial);
        if (this._faces) this.applyOnTopMaterial(this._faces, this._faceMaterial);
    }

    private applyOnTopMaterial(object: Mesh | LineSegments2 | Points, normalMaterial: Material | Material[]) {
        this.disposeOnTopMaterial(object);
        if (this._renderOnTop) {
            object.renderOrder = TopRenderOrder;
            const onTopMaterial = Array.isArray(normalMaterial)
                ? normalMaterial.map((x) => ThreeGeometryFactory.createOnTopMaterial(x))
                : ThreeGeometryFactory.createOnTopMaterial(normalMaterial);
            object.material = onTopMaterial as any;
            object.userData[OnTopMaterialKey] = onTopMaterial;
        } else {
            object.renderOrder = 0;
            object.material = normalMaterial as any;
        }
    }

    private disposeOnTopMaterial(object: Object3D): void {
        const material = object.userData[OnTopMaterialKey] as Material | Material[] | undefined;
        if (material === undefined) return;
        delete object.userData[OnTopMaterialKey];
        for (const item of Array.isArray(material) ? material : [material]) {
            item.dispose();
        }
    }

    box() {
        return this._faces?.geometry.boundingBox ?? this._edges?.geometry.boundingBox;
    }

    override boundingBox(): BoundingBox | undefined {
        const box = this._faces?.geometry.boundingBox ?? this._edges?.geometry.boundingBox;
        if (!box) return undefined;

        return {
            min: ThreeHelper.toXYZ(box.min),
            max: ThreeHelper.toXYZ(box.max),
        };
    }

    private readonly handleGeometryPropertyChanged = (property: keyof GeometryNode) => {
        if (property === "materialId") {
            if (!this.ownsFaceMaterial)
                this.changeFaceMaterial(this.context.getMaterial(this.geometryNode.materialId));
        } else if ((property as keyof ShapeNode) === "shape") {
            this.removeMeshes();
            this.generateShape();
        }
    };

    private referenceImages: Mesh[] = [];

    private generateShape() {
        const mesh = this.geometryNode.mesh;
        if (mesh?.vertexs?.position.length) this.initVertexs(mesh.vertexs);
        if (mesh?.faces?.position.length) this.initFaces(mesh.faces);
        if (mesh?.edges?.position.length) this.initEdges(mesh.edges);
        this.referenceImages = (mesh?.images ?? []).map((data) =>
            ThreeGeometryFactory.createFaceGeometry(data, {
                onTextureLoaded: () => this.geometryNode.document.visual.update(),
            }),
        );
        this.referenceImages.forEach((image) => {
            image.raycast = () => {};
            this.add(image);
        });
    }

    override dispose() {
        super.dispose();
        this.geometryNode.removePropertyChanged(this.handleGeometryPropertyChanged);
        this.removeMeshes();
    }

    private removeMeshes() {
        for (const image of this.referenceImages) {
            this.remove(image);
            image.geometry.dispose();
            for (const m of Array.isArray(image.material) ? image.material : [image.material]) m.dispose();
        }
        this.referenceImages = [];
        if (this._vertexs) {
            this.disposeOnTopMaterial(this._vertexs);
            this.remove(this._vertexs);
            this._vertexs.geometry.dispose();
            if (this.ownsVertexMaterial) this._vertexMaterial?.dispose();
            this._vertexMaterial = undefined;
            this.ownsVertexMaterial = false;
            this._vertexs = null as any;
        }
        if (this._edges) {
            this.disposeOnTopMaterial(this._edges);
            this.remove(this._edges);
            this._edges.geometry.dispose();
            if (this.ownsEdgeMaterial) this._edgeMaterial.dispose();
            this.ownsEdgeMaterial = false;
            this._edges = null as any;
        }
        if (this._faces) {
            this.disposeOnTopMaterial(this._faces);
            this.remove(this._faces);
            this._faces.geometry.dispose();
            if (this.ownsFaceMaterial) {
                for (const m of Array.isArray(this._faceMaterial) ? this._faceMaterial : [this._faceMaterial])
                    m.dispose();
                this._faceMaterial = this.context.getMaterial(this.geometryNode.materialId);
                this.ownsFaceMaterial = false;
            }
            this._faces = null as any;
        }
    }

    /**
     * Points that carry their own colour (a sketch's entity points) get a material of the
     * data's size and colour and stay visible in shaded modes, like the origin marker;
     * plain topology vertices share the default wireframe material.
     */
    private initVertexs(data: VertexMeshData) {
        const buff = ThreeGeometryFactory.createVertexBufferGeometry(data);
        const styled = data.color !== undefined && !(this.geometryNode instanceof OriginNode);
        if (styled) {
            const material = ThreeGeometryFactory.createVertexMaterial(data);
            ThreeGeometryFactory.setColor(buff, data, material);
            this._vertexMaterial = material;
            this.ownsVertexMaterial = true;
        }
        this._vertexs = new Points(buff, this.vertexMaterial);
        this._vertexs.layers.set(Constants.Layers.Wireframe);
        if (this.geometryNode instanceof OriginNode || styled)
            this._vertexs.layers.enable(Constants.Layers.Solid);
        if (this._renderOnTop) this.applyOnTopMaterial(this._vertexs, this.vertexMaterial);
        this.add(this._vertexs);
    }

    private initEdges(data: EdgeMeshData) {
        const buff = ThreeGeometryFactory.createEdgeBufferGeometry(data);
        this.ownsEdgeMaterial = Array.isArray(data.color) || data.lineType === "dash";
        this._edgeMaterial = this.ownsEdgeMaterial
            ? ThreeGeometryFactory.createEdgeMaterial(data)
            : edgeMaterialOfWidth(data.lineWidth);
        if (this.ownsEdgeMaterial) ThreeGeometryFactory.setColor(buff, data, this._edgeMaterial);
        this._edges = new LineSegments2(buff, this._edgeMaterial);
        if (data.lineType === "dash") this._edges.computeLineDistances();
        this._edges.layers.set(Constants.Layers.Wireframe);
        if (this._renderOnTop) this.applyOnTopMaterial(this._edges, this._edgeMaterial);
        this.add(this._edges);
    }

    /** Faces with an `opacity` are a translucent region fill (an inactive sketch), not the node's material. */
    private initFaces(data: FaceMeshData) {
        const buff = ThreeGeometryFactory.createFaceBufferGeometry(data);
        if (data.groups.length > 1) buff.groups = data.groups;
        if (data.opacity !== undefined) {
            this._faceMaterial = ThreeGeometryFactory.createRegionMaterial(data.opacity, data.color);
            this.ownsFaceMaterial = true;
        }
        this._faces = new Mesh(buff, this._faceMaterial);
        this._faces.layers.set(Constants.Layers.Solid);
        if (this._renderOnTop) this.applyOnTopMaterial(this._faces, this._faceMaterial);
        this.add(this._faces);
    }

    setFacesMateiralTemperary(material: MeshLambertMaterial) {
        if (this._faces) this._faces.material = material;
    }

    setEdgesMateiralTemperary(material: LineMaterial) {
        if (this._edges) this._edges.material = material;
    }

    setVertexsMateiralTemperary(material: PointsMaterial) {
        if (this._vertexs) this._vertexs.material = material;
    }

    removeTemperaryMaterial(): void {
        if (this._vertexs) this._vertexs.material = this.vertexMaterial;
        if (this._edges && this._edges.material !== lockLineMaterial)
            this._edges.material = this._edgeMaterial;
        if (this._faces && this._faces.material !== lockFaceMaterial)
            this._faces.material = this._faceMaterial;
        // restore the on-top state the temporary material replaced
        if (this._renderOnTop) {
            if (this._vertexs) this.applyOnTopMaterial(this._vertexs, this.vertexMaterial);
            if (this._edges && this._edges.material !== lockLineMaterial)
                this.applyOnTopMaterial(this._edges, this._edgeMaterial);
            if (this._faces && this._faces.material !== lockFaceMaterial)
                this.applyOnTopMaterial(this._faces, this._faceMaterial);
        }
    }

    cloneSubEdge(index: number) {
        const positions = MeshUtils.subEdge(this.geometryNode.mesh.edges!, index);
        if (!positions) return undefined;

        const buff = new LineSegmentsGeometry();
        buff.setPositions(positions);
        buff.applyMatrix4(this.matrixWorld);

        return new LineSegments2(buff, defaultEdgeMaterial);
    }

    cloneSubFace(index: number) {
        const mesh = MeshUtils.subFace(this.geometryNode.mesh.faces!, index);
        if (!mesh) return undefined;

        const buff = ThreeGeometryFactory.createFaceBufferGeometry(mesh);
        buff.applyMatrix4(this.matrixWorld);

        return new Mesh(buff, this._faceMaterial);
    }

    faces() {
        return this._faces;
    }

    edges() {
        return this._edges;
    }

    vertexs() {
        return this._vertexs;
    }

    override getSubShapeAndIndex(shapeType: "face" | "edge" | "vertex", subVisualIndex: number) {
        const mesh = this.geometryNode.mesh;
        const groups =
            shapeType === "vertex"
                ? mesh.vertexs?.range
                : shapeType === "edge"
                  ? mesh.edges?.range
                  : mesh.faces?.range;
        // A hit outside every range — display-only geometry such as a construction line's dash
        // pattern, or a mesh replaced since the ray was cast — picks nothing rather than throwing.
        const found = groups === undefined ? undefined : ThreeHelper.findGroupIndex(groups, subVisualIndex);
        const index = found ?? -1;
        const subShape: ISubShape | undefined = found === undefined ? undefined : groups![found].shape;
        const transform: Matrix4 | undefined = found === undefined ? undefined : groups![found].transform;

        let shape: IShape | undefined = subShape;
        if (this.geometryNode instanceof ShapeNode) {
            shape = this.geometryNode.shape.value;
        }
        return { transform, shape, subShape, index, groups: groups ?? [] };
    }

    override subShapeVisual(shapeType: ShapeType): (Mesh | LineSegments2 | Points)[] {
        const shapes: (Mesh | LineSegments2 | Points | undefined)[] = [];

        const isWhole =
            shapeType === ShapeTypes.shape ||
            ShapeTypeUtils.hasCompound(shapeType) ||
            ShapeTypeUtils.hasCompoundSolid(shapeType) ||
            ShapeTypeUtils.hasSolid(shapeType);

        if (isWhole || ShapeTypeUtils.hasVertex(shapeType)) {
            shapes.push(this.vertexs());
        }

        if (isWhole || ShapeTypeUtils.hasEdge(shapeType) || ShapeTypeUtils.hasWire(shapeType)) {
            shapes.push(this.edges());
        }

        if (isWhole || ShapeTypeUtils.hasFace(shapeType) || ShapeTypeUtils.hasShell(shapeType)) {
            shapes.push(this.faces());
        }

        return shapes.filter((x) => x !== undefined);
    }

    override wholeVisual(): (Mesh | LineSegments2 | Points)[] {
        return [this.edges(), this.faces(), this.vertexs()].filter((x) => x !== undefined);
    }
}
