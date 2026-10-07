// Part of the Chili3d Project, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

/**
 * The generation pipeline on the real kernel: parts moved into a rotated and a tilted WCS,
 * the stock box, faces picked by tracked id, loops from a sketch (a rectangle with a hole)
 * and from a sheet metal flat pattern, and a generated program through a registered test
 * operation — with results going stale when the sketch is edited.
 */

import { readFileSync } from "node:fs";
import path from "node:path";
import {
    EditableShapeNode,
    type IDocument,
    type IFace,
    type IShape,
    Matrix4,
    Plane,
    Result,
    ShapeTypes,
    Transaction,
} from "@chili3d/core";
import { createMockApplication, createMockVisualWithDocument, TestDocument } from "@chili3d/core/test-utils";
import {
    captureSheetLine,
    initGarlicSync,
    ParametricBodyNode,
    type SketchData,
    SketchNode,
} from "@chili3d/parametric";
import { initWasm, ShapeFactory } from "@chili3d/wasm";
import {
    CamGenerator,
    type CamLoop,
    type CamOperationData,
    CamStudioNode,
    createOperationContext,
    registerCamOperation,
    type SetupData,
    SetupGeometry,
    signedArea,
    type ToolpathMove,
} from "../src";

const ROOT = path.resolve(import.meta.dirname, "..", "..");

beforeAll(async () => {
    await initWasm({ wasmBinary: readFileSync(path.join(ROOT, "wasm/lib/chili-wasm.wasm")) });
    Object.defineProperty(globalThis, "shapeFactory", {
        value: new ShapeFactory(),
        writable: true,
        configurable: true,
    });
    initGarlicSync(readFileSync(path.join(ROOT, "parametric/lib/garlic_bg.wasm")));
});

function newDoc(): TestDocument {
    const doc = new TestDocument({ application: createMockApplication() });
    doc.visual = createMockVisualWithDocument(doc) as any;
    return doc;
}

function boxNode(doc: IDocument, dx: number, dy: number, dz: number): EditableShapeNode {
    const shape = shapeFactory.box(Plane.XY, dx, dy, dz);
    expect(shape.isOk).toBe(true);
    const node = new EditableShapeNode({ document: doc, name: "Block", shape: shape.value });
    doc.modelManager.addNode(node);
    return node;
}

const rect = (x0: number, y0: number, x1: number, y1: number, clockwise = false): SketchData["entities"] => {
    const corners: [number, number][] = clockwise
        ? [
              [x0, y0],
              [x0, y1],
              [x1, y1],
              [x1, y0],
          ]
        : [
              [x0, y0],
              [x1, y0],
              [x1, y1],
              [x0, y1],
          ];
    return corners.map((p, i) => {
        const q = corners[(i + 1) % 4];
        return { id: i + 1, type: "line" as const, params: [p[0], p[1], q[0], q[1]] };
    });
};

function addSketch(doc: IDocument, data: SketchData): SketchNode {
    const sketch = new SketchNode({ document: doc, plane: Plane.XY, data });
    doc.modelManager.addNode(sketch);
    return sketch;
}

function setupOf(partIds: string[], wcs: SetupData["wcs"], operations: CamOperationData[] = []): SetupData {
    return {
        id: "s1",
        name: "Setup 1",
        machineId: "generic-3-axis",
        wcs,
        stock: { kind: "box", margin: { x: 2, y: 3, zTop: 1, zBottom: 0.5 } },
        partIds,
        operations,
    };
}

function expectBox(shape: IShape, min: number[], max: number[]) {
    const box = shape.boundingBox();
    const actual = [box.min.x, box.min.y, box.min.z, box.max.x, box.max.y, box.max.z];
    const expected = [...min, ...max];
    for (let i = 0; i < 6; i++) expect(actual[i]).toBeCloseTo(expected[i], 4);
}

describe("parts in the WCS", () => {
    test("a WCS rotated about Z at the block's top corner: parts, mesh, stock", () => {
        const doc = newDoc();
        const block = boxNode(doc, 40, 20, 10);
        // x along model +Y, origin on the top face at (40, 0): y = z × x = model −X.
        const setup = setupOf([block.id], { origin: [40, 0, 10], xAxis: [0, 1, 0], zAxis: [0, 0, 1] });
        const geometry = SetupGeometry.build(doc, setup);
        expect(geometry.isOk).toBe(true);
        const context = createOperationContext(geometry.value, machine(), operation([]));
        expect(context.parts).toHaveLength(1);
        expectBox(context.parts[0], [0, 0, -10], [20, 40, 0]);
        expect(context.stock.min).toEqual([-2, -3, -10.5]);
        expect(context.stock.max[0]).toBeCloseTo(22, 4);
        expect(context.stock.max[1]).toBeCloseTo(43, 4);
        expect(context.stock.max[2]).toBeCloseTo(1, 4);
        const mesh = context.partMesh();
        expect(mesh.indices.length).toBe(36);
        const zs = Array.from(mesh.positions).filter((_, i) => i % 3 === 2);
        const ys = Array.from(mesh.positions).filter((_, i) => i % 3 === 1);
        expect(Math.min(...zs)).toBeCloseTo(-10, 4);
        expect(Math.max(...zs)).toBeCloseTo(0, 4);
        expect(Math.max(...ys)).toBeCloseTo(40, 4);
        geometry.value.dispose();
    });

    test("a tilted WCS machining the +X side, with the node moved in the model", () => {
        const doc = newDoc();
        const block = boxNode(doc, 40, 20, 10);
        block.transform = Matrix4.fromTranslation(5, 0, 0);
        const setup = setupOf([block.id], { origin: [45, 0, 0], xAxis: [0, 1, 0], zAxis: [1, 0, 0] });
        const geometry = SetupGeometry.build(doc, setup).value;
        // x = model Y, y = z × x = model Z, z = model X − 45.
        expectBox(geometry.parts[0], [0, 0, -40], [20, 10, 0]);
        geometry.dispose();
    });

    test("a face picked by its tracked id resolves on the rebuilt body, in WCS", () => {
        const doc = newDoc();
        const sketch = addSketch(doc, { entities: rect(0, 0, 40, 20), constraints: [] });
        const body = new ParametricBodyNode({
            document: doc,
            features: [{ id: "f1", type: "extrude", sketchId: sketch.id, depth: 10 }],
        });
        doc.modelManager.addNode(body);
        const faces = body.shape.value.findSubShapes(ShapeTypes.face) as IFace[];
        const top = faces.findIndex((face) => face.normal(0, 0)[1].z > 0.9 && face.boundingBox().min.z > 9);
        expect(top).toBeGreaterThanOrEqual(0);
        const id = body.faceIdAt(top);
        expect(id).not.toBeUndefined();
        // Deepen the extrude: the top face moves up and may change index; the id still finds it.
        Transaction.execute(doc, "deepen", () => body.setFeatureParameter("f1", "depth", 15));
        const setup = setupOf([body.id], { origin: [0, 0, 0], xAxis: [1, 0, 0], zAxis: [0, 0, 1] });
        const geometry = SetupGeometry.build(doc, setup).value;
        const context = createOperationContext(
            geometry,
            machine(),
            operation([{ kind: "face", nodeId: body.id, id, index: 999 }]),
        );
        const picked = context.selectedFaces();
        expect(picked).toHaveLength(1);
        expectBox(picked[0], [0, 0, 15], [40, 20, 15]);
        geometry.dispose();
    });
});

describe("loops", () => {
    test("a sketch rectangle (drawn clockwise) with a hole: outer CCW, hole CW, in a rotated WCS", () => {
        const doc = newDoc();
        const sketch = addSketch(doc, {
            entities: [...rect(0, 0, 40, 20, true), { id: 9, type: "circle", params: [20, 10, 5] }],
            constraints: [],
        });
        const setup = setupOf([], { origin: [40, 0, 10], xAxis: [0, 1, 0], zAxis: [0, 0, 1] });
        const geometry = SetupGeometry.build(doc, setup).value;
        const loops = createOperationContext(
            geometry,
            machine(),
            operation([{ kind: "sketch", nodeId: sketch.id }]),
        ).selectedLoops();
        expect(loops).toHaveLength(2);
        const [outer, hole] = loops[0].points.length === 4 ? loops : [loops[1], loops[0]];
        expect(outer.closed && hole.closed).toBe(true);
        expect(outer.role).toBe("sketch");
        expect(outer.z).toBeCloseTo(-10, 6);
        expect(signedArea(outer.points)).toBeCloseTo(800, 6);
        expect(signedArea(hole.points)).toBeLessThan(0);
        expect(Math.abs(signedArea(hole.points))).toBeCloseTo(Math.PI * 25, 0);
        // The rectangle in WCS: x' = model y, y' = 40 − model x.
        const xs = outer.points.map((p) => p[0]);
        const ys = outer.points.map((p) => p[1]);
        expect([Math.min(...xs), Math.max(...xs), Math.min(...ys), Math.max(...ys)]).toEqual([0, 20, 0, 40]);
        // Chords within the default 0.01 mm of the hole's circle.
        for (const p of hole.points) expect(Math.hypot(p[0] - 10, p[1] - 20)).toBeCloseTo(5, 6);
        geometry.dispose();
    });

    test("a sheet metal flat pattern: outline, hole and bend line at the sheet's top", () => {
        const doc = newDoc();
        const blank = addSketch(doc, {
            entities: [...rect(0, 0, 100, 50), { id: 9, type: "circle", params: [70, 25, 6] }],
            constraints: [],
        });
        const body = new ParametricBodyNode({
            document: doc,
            features: [
                { id: "base", type: "smBase", sketchId: blank.id, thickness: 1, radius: 1, kFactor: 0.5 },
            ],
        });
        doc.modelManager.addNode(body);
        const bendSketch = addSketch(doc, {
            entities: [{ id: 1, type: "line", params: [30, -10, 30, 60] }],
            constraints: [],
        });
        const edge = bendSketch.shape.value.findSubShapes(ShapeTypes.edge)[0];
        Transaction.execute(doc, "bend", () =>
            body.setFeaturesEmitShapeChanged([
                ...body.features,
                {
                    id: "bend",
                    type: "smBend",
                    lines: [captureSheetLine(bendSketch.id, edge as any, Matrix4.identity())],
                    angle: 90,
                    direction: "up",
                } as any,
            ]),
        );
        expect(body.featureItems().map((item) => item.error)).toEqual([undefined, undefined]);
        const setup = setupOf([body.id], { origin: [0, 0, 0], xAxis: [1, 0, 0], zAxis: [0, 0, 1] });
        const geometry = SetupGeometry.build(doc, setup).value;
        const loops: CamLoop[] = createOperationContext(
            geometry,
            machine(),
            operation([{ kind: "flatPattern", nodeId: body.id }]),
        ).selectedLoops();
        const outline = loops.filter((loop) => loop.role === "outline");
        const holes = loops.filter((loop) => loop.role === "hole");
        const bends = loops.filter((loop) => loop.role === "bend");
        expect([outline.length, holes.length, bends.length]).toEqual([1, 1, 1]);
        expect(signedArea(outline[0].points)).toBeCloseTo(5000, 6);
        expect(outline[0].z).toBeCloseTo(1, 6);
        expect(signedArea(holes[0].points)).toBeLessThan(0);
        expect(bends[0].closed).toBe(false);
        expect(bends[0].points).toEqual([
            [30, 0],
            [30, 50],
        ]);
        geometry.dispose();
    });
});

describe("generation", () => {
    registerCamOperation({
        type: "test.loopContour",
        label: "Loop contour (test)",
        category: "2d",
        machineKinds: ["mill"],
        selects: ["sketch"],
        defaults: () => ({ depth: 1 }),
        parameters: () => [{ key: "depth", label: "Depth", kind: "length" }],
        generate(operation, context) {
            const loops = context.selectedLoops();
            if (loops.length === 0) return Result.err("Pick a sketch");
            const depth = Number(operation.params["depth"] ?? 1);
            const moves: ToolpathMove[] = [];
            for (const loop of loops) {
                const [x0, y0] = loop.points[0];
                moves.push({ kind: "rapid", to: [x0, y0, 5] });
                moves.push({
                    kind: "linear",
                    to: [x0, y0, -depth],
                    feed: context.tool.cutting.plungeFeed ?? 100,
                });
                for (const [x, y] of [...loop.points.slice(1), loop.points[0]]) {
                    moves.push({ kind: "linear", to: [x, y, -depth], feed: context.tool.cutting.feed });
                }
                moves.push({ kind: "rapid", to: [x0, y0, 5] });
            }
            return Result.ok({ toolId: context.tool.id, moves });
        },
    });

    test("an operation generates, posts, and goes stale when its sketch changes", async () => {
        const doc = newDoc();
        const sketch = addSketch(doc, { entities: rect(0, 0, 10, 10), constraints: [] });
        const studio = new CamStudioNode({ document: doc });
        doc.modelManager.addNode(studio);
        const op: CamOperationData = {
            id: "op1",
            type: "test.loopContour",
            name: "Contour 1",
            toolId: "t2",
            selection: [{ kind: "sketch", nodeId: sketch.id }],
            params: { depth: 2 },
        };
        studio.setSetups([setupOf([], { origin: [0, 0, 0], xAxis: [1, 0, 0], zAxis: [0, 0, 1] }, [op])]);
        const generator = new CamGenerator(studio, { autoRegenerate: false });
        expect(generator.status("op1").state).toBe("pending");
        const status = await generator.generateOperation("s1", "op1");
        expect(status.state).toBe("ok");
        expect(status.stats?.cutting).toBeCloseTo(7 + 40, 6);
        const posted = generator.post("s1");
        expect(posted.isOk).toBe(true);
        expect(posted.value.fileName).toBe("Setup 1.nc");
        expect(posted.value.text).toContain(
            "(CONTOUR 1)\nT2 M6\nS10000 M3\nG54\nM8\nG0 X0. Y0.\nG43 Z5. H2\nG1 Z-2. F250.\nX10. F900.\nY10.\nX0.\nY0.\nG0 Z5.\n",
        );

        sketch.setDataEmitShapeChanged({ entities: rect(0, 0, 20, 10), constraints: [] });
        expect(generator.status("op1").stale).toBe(true);
        expect(generator.post("s1").isOk).toBe(false);
        await generator.regenerateStale();
        expect(generator.status("op1").stale).toBeUndefined();
        expect(generator.status("op1").stats?.cutting).toBeCloseTo(7 + 60, 6);
        generator.dispose();
    });

    test("a missing part or an unknown machine is the operation's error", async () => {
        const doc = newDoc();
        const studio = new CamStudioNode({ document: doc });
        const op: CamOperationData = { id: "op1", type: "test.loopContour", name: "Contour", params: {} };
        studio.setSetups([
            { ...setupOf(["gone"], { origin: [0, 0, 0], xAxis: [1, 0, 0], zAxis: [0, 0, 1] }, [op]) },
        ]);
        const generator = new CamGenerator(studio, { autoRegenerate: false });
        expect((await generator.generateOperation("s1", "op1")).error).toBe(
            "Part gone is no longer in the document",
        );
        studio.setSetups([{ ...studio.setups[0], partIds: [], machineId: "nope" }]);
        expect((await generator.generateOperation("s1", "op1")).error).toBe('Unknown machine "nope"');
        generator.dispose();
    });
});

function machine() {
    return {
        id: "generic-3-axis",
        name: "Generic",
        kind: "mill" as const,
        linearAxes: [{ name: "X" as const, min: 0, max: 100 }],
        maxFeed: 5000,
        rapidFeed: 10000,
        post: { id: "fanuc" },
    };
}

function operation(selection: CamOperationData["selection"]): CamOperationData {
    return { id: "o", type: "test", name: "Test", selection, params: {} };
}
