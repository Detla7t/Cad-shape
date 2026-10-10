// Part of the Chili3d Project, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

import {
    type BoundingBox,
    type Continuity,
    type EdgeMeshData,
    type I18nKeys,
    type ICurve,
    type IDocument,
    type IEdge,
    type IEqualityComparer,
    type IFace,
    type IShape,
    type IShapeMeshData,
    type ITrimmedCurve,
    type IWire,
    type Line,
    Matrix4,
    type Orientation,
    type OrientedBoundingBox,
    ParameterShapeNode,
    type Plane,
    Result,
    type ShapeType,
    ShapeTypes,
    XYZ,
    type XYZLike,
} from "@chili3d/core";

export class TestEdge implements IEdge {
    constructor(
        readonly start: XYZ,
        readonly end: XYZ,
    ) {}

    volume(): number {
        return 0;
    }
    setTolerance(_tolerance: number): void {}
    hasContinuity(_face1: IFace, _face2: IFace): boolean {
        throw new Error("Method not implemented.");
    }
    continuity(_face1: IFace, _face2: IFace): Continuity {
        throw new Error("Method not implemented.");
    }
    transformed(_matrix: Matrix4): IShape {
        throw new Error("Method not implemented.");
    }
    transformedMul(_matrix: Matrix4): IShape {
        throw new Error("Method not implemented.");
    }
    edgesMeshPosition(): EdgeMeshData {
        throw new Error("Method not implemented.");
    }
    clone(): IShape {
        throw new Error("Method not implemented.");
    }

    extremaDistance(_other: IShape): number {
        throw new Error("Method not implemented.");
    }

    dispose(): void {
        throw new Error("Method not implemented.");
    }
    update(_curve: ICurve): void {
        throw new Error("Method not implemented.");
    }
    trim(_start: number, _end: number): IEdge | undefined {
        throw new Error("Method not implemented.");
    }
    isClosed(): boolean {
        throw new Error("Method not implemented.");
    }
    isNull(): boolean {
        throw new Error("Method not implemented.");
    }
    reserve(): void {
        throw new Error("Method not implemented.");
    }
    section(_shape: IShape | Plane): IShape {
        throw new Error("Method not implemented.");
    }
    splitByWire(_edges: (IEdge | IWire)[]): IShape {
        throw new Error("Method not implemented.");
    }
    split(_shapes: IShape[]): IShape {
        throw new Error("Method not implemented.");
    }

    findAncestor(_ancestorType: ShapeType, _fromShape: IShape): IShape[] {
        throw new Error("Method not implemented.");
    }

    findSubShapes(_subshapeType: ShapeType): IShape[] {
        throw new Error("Method not implemented.");
    }
    findFaceContainsPoint(_point: XYZLike, _tolerance: number): IFace | undefined {
        throw new Error("Method not implemented.");
    }
    directSubShapes(): IShape[] {
        throw new Error("Method not implemented.");
    }
    offset(_distance: number, _dir: XYZ): Result<IEdge> {
        throw new Error("Method not implemented.");
    }
    hlr(_position: XYZLike, _direction: XYZLike, _xDir: XYZLike): IShape {
        throw new Error("Method not implemented.");
    }
    fixShape(_tolerance: number): IShape {
        throw new Error("Method not implemented.");
    }
    fixSmallFace(_tolerance: number): IShape {
        throw new Error("Method not implemented.");
    }
    fixSolid(_tolerance: number): IShape {
        throw new Error("Method not implemented.");
    }
    shellSewing(_tolerance: number): IShape {
        throw new Error("Method not implemented.");
    }
    checkShape(): boolean {
        return true;
    }
    checkFaces(): { index: number; isValid: boolean; status: string[] }[] {
        return [];
    }
    intersect(_other: IEdge | Line) {
        return [];
    }
    length(): number {
        return this.start.distanceTo(this.end);
    }
    firstParameter(): number {
        return 0;
    }
    lastParameter(): number {
        return this.length();
    }
    pointAt(parameter: number): XYZ {
        const direction = this.end.sub(this.start).normalize() ?? XYZ.unitX;
        return this.start.add(direction.multiply(parameter));
    }
    startPoint(): XYZ {
        return this.start;
    }
    endPoint(): XYZ {
        return this.end;
    }
    ends(): [start: XYZ, end: XYZ] {
        return [this.start, this.end];
    }
    get curve(): ITrimmedCurve {
        throw new Error("Method not implemented.");
    }
    get id(): string {
        return "testEdge";
    }
    boundingBox(): BoundingBox {
        throw new Error("Method not implemented.");
    }
    orientedBoundingBox(): OrientedBoundingBox {
        throw new Error("Method not implemented.");
    }
    shapeType: ShapeType = ShapeTypes.edge;
    matrix: Matrix4 = Matrix4.identity();
    get mesh(): IShapeMeshData {
        return {
            edges: {
                position: new Float32Array([
                    this.start.x,
                    this.start.y,
                    this.start.z,
                    this.end.x,
                    this.end.y,
                    this.end.z,
                ]),
                color: 0xff0000,
                lineType: "solid",
                range: [],
            },
            faces: undefined,
            vertexs: undefined,
        };
    }
    orientation(): Orientation {
        return "forward";
    }
    isPartner(_other: IShape): boolean {
        return true;
    }
    isSame(_other: IShape): boolean {
        return true;
    }
    isEqual(other: IShape): boolean {
        if (other instanceof TestEdge) {
            return this.start.isEqualTo(other.start) && this.end.isEqualTo(other.end);
        }
        return false;
    }
}

export class TestNode extends ParameterShapeNode {
    override display(): I18nKeys {
        return "body.line";
    }
    constructor(
        document: IDocument,
        readonly start: XYZ,
        readonly end: XYZ,
    ) {
        super({ document });
    }

    protected override setProperty<K extends keyof this>(
        property: K,
        newValue: this[K],
        _onPropertyChanged?: ((property: K, oldValue: this[K]) => void) | undefined,
        _equals?: IEqualityComparer<this[K]> | undefined,
    ): boolean {
        this.setPrivateValue(property, newValue);
        return true;
    }

    generateShape(): Result<IShape> {
        return Result.ok(new TestEdge(this.start, this.end));
    }
}
