// Part of the Chili3d Project, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

import type { IDisposable, Result } from "../foundation";
import type { BoundingBox, Line, Matrix4, OrientedBoundingBox, Plane, XYZ, XYZLike } from "../math";
import type { Continuity, ICurve, ITrimmedCurve } from "./curve";
import type { EdgeMeshData, IShapeMeshData } from "./meshData";
import type { ShapeType } from "./shapeType";
import type { ISurface } from "./surface";

export type Orientation = "forward" | "reversed" | "internal" | "external";

export interface ShapeDistanceMeasure {
    value: number;
    first: XYZLike;
    second: XYZLike;
}

export interface IShape extends IDisposable {
    readonly shapeType: ShapeType;
    get id(): string;
    get mesh(): IShapeMeshData;
    /** Borrowed mesh with an absolute linear deflection in model units, owned by the shape. */
    tessellate?(linearDeflection: number): IShapeMeshData;
    transformed(matrix: Matrix4): IShape;
    transformedMul(matrix: Matrix4): IShape;
    edgesMeshPosition(): EdgeMeshData;
    matrix: Matrix4;
    isClosed(): boolean;
    isNull(): boolean;
    /**
     * they share the same TShape with the same Locations and Orientations.
     */
    isEqual(other: IShape): boolean;
    /**
     * they share the same TShape with the same Locations, Orientations may differ.
     */
    isSame(other: IShape): boolean;
    /**
     * they share the same TShape. Locations and Orientations may differ.
     */
    isPartner(other: IShape): boolean;
    orientation(): Orientation;
    findAncestor(ancestorType: ShapeType, fromShape: IShape): IShape[];
    findSubShapes(subshapeType: ShapeType): IShape[];
    directSubShapes(): IShape[];
    section(shape: IShape | Plane): IShape;
    split(shapes: IShape[], tolerance?: number): IShape;
    reserve(): void;
    clone(): IShape;
    hlr(position: XYZLike, direction: XYZLike, xDir: XYZLike): IShape;
    boundingBox(): BoundingBox;
    /** Geometry bounds without display tessellation or shape-tolerance inflation. */
    exactBoundingBox?(): BoundingBox;
    /** Kernel edge indexes used only to close a periodic surface's parameter domain. */
    seamEdges?(): number[];
    orientedBoundingBox(): OrientedBoundingBox;
    extremaDistance(other: IShape): number;
    distanceMeasure?(other: IShape, maximum?: boolean): Result<ShapeDistanceMeasure>;
    checkShape(): boolean;
    checkFaces(): { index: number; isValid: boolean; status: string[] }[];
    fixShape(tolerance: number): IShape;
    fixSmallFace(tolerance: number): IShape;
    fixSolid(tolerance: number): IShape;
    shellSewing(tolerance: number): IShape;
    setTolerance(tolerance: number): void;
    volume(): number;
}

export interface ISubShape extends IShape {
    index: number;
    parent: IShape;
}

export interface ISubVertexShape extends ISubShape, IVertex {}

export interface ISubEdgeShape extends ISubShape, IEdge {}

export interface ISubFaceShape extends ISubShape, IFace {}

export interface IVertex extends IShape {
    point(): XYZ;
}

export interface IEdge extends IShape {
    update(curve: ICurve): void;
    intersect(other: IEdge | Line): { parameter: number; point: XYZ }[];
    length(): number;
    /** Kernel parameter at a fraction of the edge's arc length, independent of display tessellation. */
    arcLengthParameter?(fraction: number): number;
    get curve(): ITrimmedCurve;
    firstParameter(): number;
    lastParameter(): number;
    pointAt(parameter: number): XYZ;
    startPoint(): XYZ;
    endPoint(): XYZ;
    ends(): [start: XYZ, end: XYZ];
    offset(distance: number, dir: XYZ): Result<IEdge>;
    /**
     * Trims the edge to the parameter window [start, end]. Returns `undefined`
     * when the window is empty within tolerance — the kernel reports that as a
     * null edge instead of raising.
     */
    trim(start: number, end: number): IEdge | undefined;
    hasContinuity(face1: IFace, face2: IFace): boolean;
    continuity(face1: IFace, face2: IFace): Continuity;
}

export type JoinType = "arc" | "tangent" | "intersection";

export type OffsetMode = "skin" | "pipe" | "rectoVerso";

export interface IWire extends IShape {
    toFace(): Result<IFace>;
    edgeLoop(): IEdge[];
    offset(distance: number, joinType: JoinType): Result<IShape>;
}

export interface IFace extends IShape {
    area(): number;
    normal(u: number, v: number): [point: XYZ, normal: XYZ];
    outerWire(): IWire;
    surface(): ISurface;
    intersectLine(point: XYZLike, direction: XYZLike, tolerance?: number): XYZ | undefined;
    segmentsOfEdgeOnFace(edge: IEdge):
        | undefined
        | {
              start: number;
              end: number;
          };
    containsPoint(point: XYZLike, containsEdge: boolean, tolerance: number): boolean;
}

export interface IShell extends IShape {}

export interface ISolid extends IShape {
    containsPoint(point: XYZLike, containsSurface: boolean, tolerance: number): boolean;
}

export interface ICompound extends IShape {}

export interface ICompoundSolid extends IShape {}
