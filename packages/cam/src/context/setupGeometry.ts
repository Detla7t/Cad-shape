// Part of the Chili3d Project, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

import {
    type IDisposable,
    type IDocument,
    type IShape,
    type Matrix4,
    Result,
    ShapeNode,
} from "@chili3d/core";
import type { CamMesh } from "../model/operation";
import type { SetupData, StockData } from "../model/setup";
import type { Vec3 } from "../model/toolpath";
import { modelToWcsMatrix } from "./wcs";

/**
 * A setup's geometry in its WCS, built once per generation run and shared by its
 * operations: the parts (each part node's shape × its world placement × the WCS inverse),
 * their bounds, the stock box and the triangulation. Shapes it transforms are its own and
 * go when it is disposed — operations must not keep them past `generate`.
 */

export interface Box3 {
    readonly min: Vec3;
    readonly max: Vec3;
}

/** The nodes a setup machines, in its `partIds` order; an error names a missing or broken part. */
export function setupPartNodes(document: IDocument, setup: SetupData): Result<ShapeNode[]> {
    const nodes: ShapeNode[] = [];
    for (const id of setup.partIds) {
        const node = findShapeNode(document, id);
        if (node === undefined) return Result.err(`Part ${id} is no longer in the document`);
        if (!node.shape.isOk)
            return Result.err(`Part "${node.name}" has no valid shape: ${node.shape.error}`);
        nodes.push(node);
    }
    return Result.ok(nodes);
}

export function findShapeNode(document: IDocument, id: string): ShapeNode | undefined {
    const [node] = document.modelManager.findNodes((candidate) => candidate.id === id);
    return node instanceof ShapeNode ? node : undefined;
}

/** Bounds of shapes (their kernel boxes); undefined for none. */
export function shapesBox(shapes: readonly IShape[]): Box3 | undefined {
    let box: { min: [number, number, number]; max: [number, number, number] } | undefined;
    for (const shape of shapes) {
        const b = shape.boundingBox();
        if (box === undefined) {
            box = { min: [b.min.x, b.min.y, b.min.z], max: [b.max.x, b.max.y, b.max.z] };
            continue;
        }
        box.min = [
            Math.min(box.min[0], b.min.x),
            Math.min(box.min[1], b.min.y),
            Math.min(box.min[2], b.min.z),
        ];
        box.max = [
            Math.max(box.max[0], b.max.x),
            Math.max(box.max[1], b.max.y),
            Math.max(box.max[2], b.max.z),
        ];
    }
    return box;
}

/**
 * The stock's box in WCS. Box: the parts' bounds grown by the margins. Cylinder: a bar
 * along WCS z centred on the parts, its top `zTop` above theirs. Body: the stock body's
 * bounds. Sheet: width × height on the WCS XY from the origin, its top at z = 0.
 */
export function stockBox(stock: StockData, parts: Box3 | undefined, stockBody?: Box3): Box3 {
    const base = parts ?? { min: [0, 0, 0], max: [0, 0, 0] };
    switch (stock.kind) {
        case "box": {
            const m = stock.margin;
            return {
                min: [base.min[0] - m.x, base.min[1] - m.y, base.min[2] - m.zBottom],
                max: [base.max[0] + m.x, base.max[1] + m.y, base.max[2] + m.zTop],
            };
        }
        case "cylinder": {
            const cx = (base.min[0] + base.max[0]) / 2;
            const cy = (base.min[1] + base.max[1]) / 2;
            const r = stock.diameter / 2;
            const top = base.max[2] + stock.zTop;
            return { min: [cx - r, cy - r, top - stock.length], max: [cx + r, cy + r, top] };
        }
        case "body":
            return stockBody ?? base;
        case "sheet":
            return { min: [0, 0, -stock.thickness], max: [stock.width, stock.height, 0] };
    }
}

/** Triangles of shapes, concatenated (each shape's own location applied). */
export function shapesMesh(shapes: readonly IShape[]): CamMesh {
    const chunks: { positions: ArrayLike<number>; indices: Uint32Array }[] = [];
    for (const shape of shapes) {
        const faces = shape.mesh.faces;
        if (faces === undefined || faces.index.length === 0) continue;
        const matrix = shape.matrix;
        const positions = isIdentity(matrix) ? faces.position : matrix.ofPoints(faces.position);
        chunks.push({ positions, indices: faces.index });
    }
    const vertexCount = chunks.reduce((sum, chunk) => sum + chunk.positions.length, 0);
    const indexCount = chunks.reduce((sum, chunk) => sum + chunk.indices.length, 0);
    const positions = new Float32Array(vertexCount);
    const indices = new Uint32Array(indexCount);
    let p = 0;
    let i = 0;
    for (const chunk of chunks) {
        positions.set(chunk.positions, p);
        const offset = p / 3;
        for (let k = 0; k < chunk.indices.length; k++) indices[i + k] = chunk.indices[k] + offset;
        p += chunk.positions.length;
        i += chunk.indices.length;
    }
    return { positions, indices };
}

function isIdentity(matrix: Matrix4): boolean {
    const a = matrix.toArray();
    return a.every((value, index) => Math.abs(value - (index % 5 === 0 ? 1 : 0)) < 1e-12);
}

export class SetupGeometry implements IDisposable {
    private readonly transformed = new Map<string, IShape>();
    private readonly owned: IShape[] = [];
    private _mesh: CamMesh | undefined;
    private _partsBox: Box3 | undefined | null = null;
    readonly modelToWcs: Matrix4;

    private constructor(
        readonly document: IDocument,
        readonly setup: SetupData,
        readonly partNodes: readonly ShapeNode[],
    ) {
        this.modelToWcs = modelToWcsMatrix(setup.wcs);
    }

    static build(document: IDocument, setup: SetupData): Result<SetupGeometry> {
        const nodes = setupPartNodes(document, setup);
        if (!nodes.isOk) return Result.err(nodes.error);
        return Result.ok(new SetupGeometry(document, setup, nodes.value));
    }

    /** The parts in WCS, in `partIds` order. */
    get parts(): IShape[] {
        return this.partNodes.map((node) => this.shapeInWcs(node)!);
    }

    /** `node`'s shape in this setup's WCS (cached; owned by this geometry). */
    shapeInWcs(node: ShapeNode): IShape | undefined {
        const cached = this.transformed.get(node.id);
        if (cached !== undefined) return cached;
        if (!node.shape.isOk) return undefined;
        const shape = node.shape.value.transformedMul(node.worldTransform().multiply(this.modelToWcs));
        this.transformed.set(node.id, shape);
        this.owned.push(shape);
        return shape;
    }

    /** Keeps a shape derived from this geometry (a picked face) to dispose with it. */
    own<T extends IShape>(shape: T): T {
        this.owned.push(shape);
        return shape;
    }

    get partsBox(): Box3 | undefined {
        if (this._partsBox === null) this._partsBox = shapesBox(this.parts);
        return this._partsBox;
    }

    get stock(): Box3 {
        const stock = this.setup.stock;
        let body: Box3 | undefined;
        if (stock.kind === "body") {
            const node = findShapeNode(this.document, stock.nodeId);
            const shape = node === undefined ? undefined : this.shapeInWcs(node);
            body = shape === undefined ? undefined : shapesBox([shape]);
        }
        return stockBox(stock, this.partsBox, body);
    }

    partMesh(): CamMesh {
        this._mesh ??= shapesMesh(this.parts);
        return this._mesh;
    }

    dispose(): void {
        for (const shape of this.owned) {
            try {
                shape.dispose();
            } catch {
                // a shape the kernel already released
            }
        }
        this.owned.length = 0;
        this.transformed.clear();
        this._mesh = undefined;
    }
}
