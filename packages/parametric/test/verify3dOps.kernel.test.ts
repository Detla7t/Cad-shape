// Part of the Chili3d Project, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

/**
 * Analytic verification of the native parametric modeling operations against the real
 * OCCT kernel: every feature's output is measured (volume, solid count, kernel validity,
 * extent) and compared with the closed-form value of the solid it should produce.
 *
 * Volume formulas used below:
 * - fillet of a straight convex 90° edge of length L, radius r: removes (1 − π/4)·r²·L;
 * - chamfer of the same edge, distance d: removes d²·L / 2;
 * - three filleted edges meeting at one box corner: the straight runs remove
 *   (1 − π/4)·r²·(L₁ + L₂ + L₃ − 3r), the spherical corner patch r³·(1 − π/6);
 * - two filleted edges meeting at a corner whose third edge stays sharp (mitred):
 *   (1 − π/4)·r²·(L₁ + L₂ − 2r) + r³/3;
 * - fillet of a hole's circular rim (hole radius R): Pappus on the removed spandrel,
 *   (1 − π/4)·r² · 2π·(R + r·(10 − 3π)/(12 − 3π)).
 */

import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
    type IEdge,
    type IFace,
    type IShape,
    Matrix4,
    Plane,
    ShapeTypes,
    Transaction,
    XYZ,
} from "@chili3d/core";
import { createMockApplication, createMockVisualWithDocument, TestDocument } from "@chili3d/core/test-utils";
import { initWasm, ShapeFactory } from "@chili3d/wasm";
import { captureEdgeRef } from "../src/features/edgeRef";
import type {
    BooleanOperation,
    ExtrudeFeatureData,
    FeatureData,
    RevolveFeatureData,
} from "../src/features/feature";
import { captureProfileRef } from "../src/features/profileRef";
import { ParametricBodyNode } from "../src/parametricBodyNode";
import { ConstraintKind, type SketchData } from "../src/sketch/sketchModel";
import { SketchNode } from "../src/sketch/sketchNode";
import "./sketch/setup";

const WASM_BINARY = readFileSync(
    path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../wasm/lib/chili-wasm.wasm"),
);

beforeAll(async () => {
    await initWasm({ wasmBinary: WASM_BINARY });
    Object.defineProperty(globalThis, "shapeFactory", {
        value: new ShapeFactory(),
        writable: true,
        configurable: true,
    });
});

// ---------------------------------------------------------------------------- fixtures

type Entities = SketchData["entities"];

const rect = (x0: number, y0: number, x1: number, y1: number, id0 = 1): Entities => [
    { id: id0, type: "line", params: [x0, y0, x1, y0] },
    { id: id0 + 1, type: "line", params: [x1, y0, x1, y1] },
    { id: id0 + 2, type: "line", params: [x1, y1, x0, y1] },
    { id: id0 + 3, type: "line", params: [x0, y1, x0, y0] },
];

const circle = (cx: number, cy: number, r: number, id: number): Entities => [
    { id, type: "circle", params: [cx, cy, r] },
];

const FILLET_LOSS = 1 - Math.PI / 4;
const SPANDREL_CENTROID = (10 - 3 * Math.PI) / (12 - 3 * Math.PI);

function newDoc(): TestDocument {
    const doc = new TestDocument({ application: createMockApplication() });
    doc.visual = createMockVisualWithDocument(doc) as unknown as TestDocument["visual"];
    return doc;
}

function addSketch(doc: TestDocument, entities: Entities, plane: Plane = Plane.XY): SketchNode {
    const sketch = new SketchNode({ document: doc, plane, data: { entities, constraints: [] } });
    doc.modelManager.addNode(sketch);
    return sketch;
}

const planeAtZ = (z: number) =>
    new Plane({ origin: new XYZ({ x: 0, y: 0, z }), normal: XYZ.unitZ, xvec: XYZ.unitX });

/** The sketch's selectable profile faces, in mesh order (outer profiles first, then hole loops). */
function profileFaces(sketch: SketchNode): IFace[] {
    const ranges = sketch.mesh.faces?.range.filter((x) => x.shape.shapeType === ShapeTypes.face) ?? [];
    return ranges.map((x) => x.shape as unknown as IFace);
}

function addBody(doc: TestDocument, features: FeatureData[]): ParametricBodyNode {
    const body = new ParametricBodyNode({ document: doc, features });
    doc.modelManager.addNode(body);
    return body;
}

function extrude(
    id: string,
    sketch: SketchNode,
    depth: number | string,
    extra: Partial<ExtrudeFeatureData> = {},
) {
    return { id, type: "extrude", sketchId: sketch.id, depth, ...extra } as ExtrudeFeatureData;
}

/** A w×d×h box body at the origin, extruded from an XY rectangle. */
function boxBody(doc: TestDocument, w: number, d: number, h: number) {
    const sketch = addSketch(doc, rect(0, 0, w, d));
    const body = addBody(doc, [extrude("e1", sketch, h)]);
    return { body, sketch };
}

function append(body: ParametricBodyNode, ...features: FeatureData[]): void {
    body.setFeaturesEmitShapeChanged([...body.features, ...features]);
}

function setFeature(body: ParametricBodyNode, id: string, patch: Record<string, unknown>): void {
    body.setFeaturesEmitShapeChanged(
        body.features.map((f) => (f.id === id ? ({ ...f, ...patch } as FeatureData) : f)),
    );
}

const shapeOf = (body: ParametricBodyNode): IShape => body.shape.unchecked()!;
/** Row errors after an evaluation — the body evaluates lazily, on its first shape read. */
function errors(body: ParametricBodyNode): (string | undefined)[] {
    void body.shape;
    return body.featureItems().map((x) => x.error);
}
const volume = (body: ParametricBodyNode) => shapeOf(body).volume();
const solidCount = (body: ParametricBodyNode) => shapeOf(body).findSubShapes(ShapeTypes.solid).length;

/** Fails with the offending rows when any feature reports an error. */
function expectClean(...bodies: ParametricBodyNode[]): void {
    const broken = bodies.flatMap((body) =>
        body
            .featureItems()
            .filter((x) => x.error !== undefined)
            .map((x) => `${x.id}: ${x.error}`),
    );
    expect(broken).toEqual([]);
}

/** Valid closed solid(s): kernel check passes and the solid count is as expected. */
function expectSolid(body: ParametricBodyNode, volumeExpected: number, solids = 1, digits = 3): void {
    expectClean(body);
    const shape = shapeOf(body);
    expect(shape.checkShape()).toBe(true);
    expect(solidCount(body)).toBe(solids);
    expect(shape.volume()).toBeCloseTo(volumeExpected, digits);
}

function extent(body: ParametricBodyNode): number[] {
    const box = shapeOf(body).boundingBox();
    return [box.min.x, box.min.y, box.min.z, box.max.x, box.max.y, box.max.z];
}

function expectExtent(body: ParametricBodyNode, expected: number[], digits = 4): void {
    const actual = extent(body);
    for (const [index, value] of expected.entries()) expect(actual[index]).toBeCloseTo(value, digits);
}

/** Edges of the body's current shape passing `pick`, with the tracked-id ref a pick command captures. */
function edgeRefs(body: ParametricBodyNode, pick: (edge: IEdge) => boolean) {
    const edges = shapeOf(body).findSubShapes(ShapeTypes.edge) as IEdge[];
    return edges.flatMap((edge, index) => {
        if (!pick(edge)) return [];
        const id = body.edgeIdAt(index);
        return [captureEdgeRef(edge, id, body.edgeIdIsShared(id))];
    });
}

const near = (a: number, b: number) => Math.abs(a - b) < 1e-6;

/** A straight edge running along `axis` whose other two coordinates are the given ones. */
function lineAlong(axis: "x" | "y" | "z", at: Partial<Record<"x" | "y" | "z", number>>) {
    return (edge: IEdge) => {
        if (edge.curve.basisCurve.curveType !== "line") return false;
        const s = edge.startPoint();
        const e = edge.endPoint();
        if (near(s[axis], e[axis])) return false;
        return Object.entries(at).every(
            ([k, v]) => near(s[k as "x"], v as number) && near(e[k as "x"], v as number),
        );
    };
}

/** The body face whose outward normal is +/-`axis`, as the press-pull command captures it. */
function outwardFaceRef(source: ParametricBodyNode, axis: "x" | "y" | "z", sign = 1) {
    const faces = shapeOf(source).findSubShapes(ShapeTypes.face) as IFace[];
    const index = faces.findIndex((face) => face.normal(0, 0)[1][axis] * sign > 1 - 1e-6);
    expect(index).toBeGreaterThanOrEqual(0);
    const id = source.faceIdAt(index);
    return captureProfileRef(faces[index], id, source.faceIdIsShared(id), true);
}

function pressPull(
    id: string,
    source: ParametricBodyNode,
    axis: "x" | "y" | "z",
    depth: number,
    extra: Partial<ExtrudeFeatureData> = {},
    sign = 1,
): ExtrudeFeatureData {
    return {
        id,
        type: "extrude",
        depth,
        source: { nodeId: source.id, profiles: [outwardFaceRef(source, axis, sign)] },
        ...extra,
    };
}

function setVariable(
    doc: TestDocument,
    name: string,
    expression: string,
    type: "length" | "angle" = "length",
) {
    Transaction.execute(doc, "edit variables", () => {
        doc.variables.setItems([{ id: `v-${name}`, name, expression, type }]);
    });
}

// ---------------------------------------------------------------------------- A1. extrude

describe("extrude from sketch profiles", () => {
    // 20×30 rectangle on XY → 6000 per 10 mm of depth.
    test.each<[string, Partial<ExtrudeFeatureData>, number, number[]]>([
        ["blind", { depth: 10 }, 6000, [0, 0, 0, 20, 30, 10]],
        ["opposite direction (negative depth)", { depth: -10 }, 6000, [0, 0, -10, 20, 30, 0]],
        ["symmetric: depth on each side", { depth: 10, symmetric: true }, 12000, [0, 0, -10, 20, 30, 10]],
        ["start offset", { depth: 10, startOffset: 5 }, 6000, [0, 0, 5, 20, 30, 15]],
        ["negative start offset", { depth: 10, startOffset: -5 }, 6000, [0, 0, -5, 20, 30, 5]],
        [
            "symmetric from a start offset",
            { depth: 10, startOffset: 5, symmetric: true },
            12000,
            [0, 0, -5, 20, 30, 15],
        ],
    ])("%s", (_, options, expectedVolume, expectedExtent) => {
        const doc = newDoc();
        const sketch = addSketch(doc, rect(0, 0, 20, 30));
        const body = addBody(doc, [extrude("e1", sketch, 10, options)]);
        expectSolid(body, expectedVolume);
        expectExtent(body, expectedExtent);
        // A plain prism is exactly six planar faces — a symmetric sweep must not leave
        // the mid-plane seam splitting its sides.
        expect(shapeOf(body).findSubShapes(ShapeTypes.face).length).toBe(6);
    });

    test.each<[string, Plane, number[]]>([
        ["YZ plane sweeps along +X", Plane.YZ, [0, 0, 0, 10, 20, 30]],
        ["ZX plane sweeps along +Y (u runs along −X)", Plane.ZX, [-20, 0, 0, 0, 10, 30]],
        ["offset XY plane starts on the plane", planeAtZ(7), [0, 0, 7, 20, 30, 17]],
    ])("sketch on the %s", (_, plane, expectedExtent) => {
        const doc = newDoc();
        const sketch = addSketch(doc, rect(0, 0, 20, 30), plane);
        const body = addBody(doc, [extrude("e1", sketch, 10)]);
        expectSolid(body, 6000);
        expectExtent(body, expectedExtent);
    });

    test("a region with a hole extrudes as a pierced solid by default", () => {
        const doc = newDoc();
        const sketch = addSketch(doc, [...rect(0, 0, 40, 30), ...circle(20, 15, 5, 5)]);
        const body = addBody(doc, [extrude("e1", sketch, 10)]);
        expectSolid(body, (1200 - 25 * Math.PI) * 10);
        // Through-hole: outer 4 sides + top + bottom + the cylindrical bore.
        expect(shapeOf(body).findSubShapes(ShapeTypes.face).length).toBe(7);
    });

    test("an explicitly picked hole loop extrudes as its own solid", () => {
        const doc = newDoc();
        const sketch = addSketch(doc, [...rect(0, 0, 40, 30), ...circle(20, 15, 5, 5)]);
        const faces = profileFaces(sketch);
        expect(faces.length).toBe(2);
        // Mesh order: outer profile (with the hole) first, then the hole loop as a disk.
        expect(faces[1].area()).toBeCloseTo(25 * Math.PI, 3);
        const body = addBody(doc, [extrude("e1", sketch, 10, { profiles: [captureProfileRef(faces[1])] })]);
        expectSolid(body, 250 * Math.PI);
    });

    test("picking both the pierced region and its hole loop fills the hole back in", () => {
        const doc = newDoc();
        const sketch = addSketch(doc, [...rect(0, 0, 40, 30), ...circle(20, 15, 5, 5)]);
        const profiles = profileFaces(sketch).map((face) => captureProfileRef(face));
        const body = addBody(doc, [extrude("e1", sketch, 10, { profiles })]);
        expectSolid(body, 12000);
    });

    test("disjoint regions become one compound of separate solids", () => {
        const doc = newDoc();
        const sketch = addSketch(doc, [...rect(0, 0, 10, 10), ...rect(20, 0, 40, 10, 5)]);
        const body = addBody(doc, [extrude("e1", sketch, 5)]);
        expectSolid(body, 500 + 1000, 2);
    });

    test("regions sharing an edge merge into one solid", () => {
        const doc = newDoc();
        // Two rectangles sharing the x=10 edge (a branch vertex at each end).
        const sketch = addSketch(doc, [
            ...rect(0, 0, 10, 10),
            { id: 5, type: "line", params: [10, 0, 25, 0] },
            { id: 6, type: "line", params: [25, 0, 25, 10] },
            { id: 7, type: "line", params: [25, 10, 10, 10] },
        ]);
        const faces = profileFaces(sketch);
        expect(faces.length).toBe(2);
        const profiles = faces.map((face) => captureProfileRef(face));
        const body = addBody(doc, [extrude("e1", sketch, 4, { profiles })]);
        expectSolid(body, 25 * 10 * 4);
    });

    test("only the picked region of a crossing sketch is extruded", () => {
        const doc = newDoc();
        // Two overlapping squares: three regions (two L-shapes and the 10×10 overlap).
        const sketch = addSketch(doc, [...rect(0, 0, 20, 20), ...rect(10, 10, 30, 30, 5)]);
        const faces = profileFaces(sketch);
        expect(faces.length).toBe(3);
        const overlap = faces.find((face) => Math.abs(face.area() - 100) < 1e-6);
        expect(overlap).toBeDefined();
        const body = addBody(doc, [extrude("e1", sketch, 3, { profiles: [captureProfileRef(overlap!)] })]);
        expectSolid(body, 300);
        expectExtent(body, [10, 10, 0, 20, 20, 3]);

        // Every region together: the union of both squares, one solid.
        setFeature(body, "e1", { profiles: faces.map((face) => captureProfileRef(face)) });
        expectSolid(body, (400 + 400 - 100) * 3);
    });

    test("a circle profile extrudes to the analytic cylinder", () => {
        const doc = newDoc();
        const sketch = addSketch(doc, circle(0, 0, 7, 1));
        const body = addBody(doc, [extrude("e1", sketch, 12)]);
        expectSolid(body, Math.PI * 49 * 12);
        expect(shapeOf(body).findSubShapes(ShapeTypes.face).length).toBe(3);
    });

    test("a profile bounded by lines and an arc (slot) extrudes to its analytic area", () => {
        const doc = newDoc();
        // A D-shape: diameter on the x axis from (−10,0) to (10,0), half-disk above.
        const sketch = addSketch(doc, [
            { id: 1, type: "line", params: [-10, 0, 10, 0] },
            { id: 2, type: "arc", params: [0, 0, 10, 0, -10, 0] },
        ]);
        const body = addBody(doc, [extrude("e1", sketch, 10)]);
        expectSolid(body, 50 * Math.PI * 10);
        expectExtent(body, [-10, 0, 0, 10, 10, 10], 1);
    });

    describe("join / cut / intersect onto the preceding feature", () => {
        // Host 40³ box; tool profile 20×20 at (30..50, 10..30) sweeping z 0..40 → overlap 10×20×40.
        test.each<[BooleanOperation, number, number[]]>([
            ["fuse", 64000 + 16000 - 8000, [0, 0, 0, 50, 40, 40]],
            ["cut", 64000 - 8000, [0, 0, 0, 40, 40, 40]],
            ["common", 8000, [30, 10, 0, 40, 30, 40]],
        ])("%s", (operation, expectedVolume, expectedExtent) => {
            const doc = newDoc();
            const { body } = boxBody(doc, 40, 40, 40);
            const tool = addSketch(doc, rect(30, 10, 50, 30));
            append(body, extrude("e2", tool, 40, { operation }));
            expectSolid(body, expectedVolume);
            expectExtent(body, expectedExtent);
        });

        test("a symmetric cut from the mid-plane pierces through", () => {
            const doc = newDoc();
            const { body } = boxBody(doc, 40, 40, 40);
            const hole = addSketch(doc, circle(20, 20, 5, 1), planeAtZ(20));
            append(body, extrude("e2", hole, 25, { operation: "cut", symmetric: true }));
            expectSolid(body, 64000 - 25 * Math.PI * 40);
        });

        test("a cut of several profiles removes each", () => {
            const doc = newDoc();
            const { body } = boxBody(doc, 40, 40, 10);
            const holes = addSketch(doc, [...circle(10, 10, 3, 1), ...circle(30, 30, 4, 2)], planeAtZ(10));
            append(body, extrude("e2", holes, -10, { operation: "cut" }));
            expectSolid(body, 16000 - (9 + 16) * Math.PI * 10);
        });

        test("a join from a start-offset profile fuses the offset prism", () => {
            const doc = newDoc();
            const { body } = boxBody(doc, 40, 40, 10);
            // Starts 5 below the top face and reaches 15 above it: the lower 5 overlap the box.
            const boss = addSketch(doc, rect(10, 10, 20, 20), planeAtZ(10));
            append(body, extrude("e2", boss, 20, { operation: "fuse", startOffset: -5 }));
            expectSolid(body, 16000 + 100 * 15);
            expectExtent(body, [0, 0, 0, 40, 40, 25]);
        });

        test("a cut that misses the body leaves it unchanged", () => {
            const doc = newDoc();
            const { body } = boxBody(doc, 40, 40, 10);
            const away = addSketch(doc, rect(100, 100, 110, 110));
            append(body, extrude("e2", away, 10, { operation: "cut" }));
            expectSolid(body, 16000);
        });

        test("an intersect that misses the body empties it", () => {
            const doc = newDoc();
            const { body } = boxBody(doc, 40, 40, 10);
            const away = addSketch(doc, rect(100, 100, 110, 110));
            append(body, extrude("e2", away, 10, { operation: "common" }));
            expectClean(body);
            expect(solidCount(body)).toBe(0);
        });

        test.each<BooleanOperation>([
            "fuse",
            "cut",
            "common",
        ])("%s as the first feature reports a feature error", (operation) => {
            const doc = newDoc();
            const sketch = addSketch(doc, rect(0, 0, 10, 10));
            const body = addBody(doc, [extrude("e1", sketch, 10, { operation })]);
            expect(errors(body)).toEqual(["Extrude join/cut/intersect requires a preceding feature"]);
        });
    });

    test("a zero depth reports a feature error and keeps the last good shape", () => {
        const doc = newDoc();
        const { body } = boxBody(doc, 20, 20, 10);
        expectSolid(body, 4000);
        setFeature(body, "e1", { depth: 0 });
        expect(errors(body)[0]).toBeDefined();
        expect(body.shape.isOk).toBe(true);
        expect(volume(body)).toBeCloseTo(4000, 6);
        setFeature(body, "e1", { depth: 5 });
        expectSolid(body, 2000);
    });

    test("an open sketch reports a feature error", () => {
        const doc = newDoc();
        const sketch = addSketch(doc, [{ id: 1, type: "line", params: [0, 0, 10, 0] }]);
        const body = addBody(doc, [extrude("e1", sketch, 10)]);
        expect(errors(body)).toEqual(["Sketch profile is not closed"]);
    });
});

// ---------------------------------------------------------------------------- A2. revolve

/** Revolve of a sketch around a fixed world axis (a datum-like axis — no live source). */
function revolve(
    id: string,
    sketch: SketchNode,
    angle: number | string,
    extra: Partial<RevolveFeatureData> = {},
) {
    return {
        id,
        type: "revolve",
        sketchId: sketch.id,
        angle,
        axis: { point: { x: 0, y: 0, z: 0 }, direction: { x: 0, y: 1, z: 0 } },
        ...extra,
    } as RevolveFeatureData;
}

describe("revolve", () => {
    // Rectangle x∈[10,20], y∈[0,10] around the Y axis: a tube of volume π(20² − 10²)·10 per turn.
    const TUBE = Math.PI * (400 - 100) * 10;

    test.each<[string, number, number]>([
        ["full turn", 360, TUBE],
        ["half turn", 180, TUBE / 2],
        ["quarter turn", 90, TUBE / 4],
        ["quarter turn the other way (negative angle)", -90, TUBE / 4],
        ["eighth turn", 45, TUBE / 8],
    ])("%s", (_, angle, expectedVolume) => {
        const doc = newDoc();
        const sketch = addSketch(doc, rect(10, 0, 20, 10));
        const body = addBody(doc, [revolve("r1", sketch, angle)]);
        expectSolid(body, expectedVolume, 1, 2);
    });

    test("positive and negative angles sweep to opposite sides of the sketch plane", () => {
        const doc = newDoc();
        const sketch = addSketch(doc, rect(10, 0, 20, 10));
        const plus = addBody(doc, [revolve("r1", sketch, 90)]);
        const minus = addBody(doc, [revolve("r1", sketch, -90)]);
        expectClean(plus, minus);
        // Right-hand rotation about +Y carries +X towards −Z.
        const [, , plusMinZ, , , plusMaxZ] = extent(plus);
        const [, , minusMinZ, , , minusMaxZ] = extent(minus);
        expect(plusMaxZ).toBeCloseTo(0, 3);
        expect(plusMinZ).toBeCloseTo(-20, 1);
        expect(minusMinZ).toBeCloseTo(0, 3);
        expect(minusMaxZ).toBeCloseTo(20, 1);
    });

    test("a variable-driven angle follows the variable", () => {
        const doc = newDoc();
        setVariable(doc, "a", "90", "angle");
        const sketch = addSketch(doc, rect(10, 0, 20, 10));
        const body = addBody(doc, [revolve("r1", sketch, "a")]);
        expectSolid(body, TUBE / 4, 1, 2);
        setVariable(doc, "a", "270", "angle");
        expectSolid(body, (TUBE * 3) / 4, 1, 2);
    });

    test("a profile touching the axis revolves into a solid cylinder", () => {
        const doc = newDoc();
        const sketch = addSketch(doc, rect(0, 0, 10, 10));
        const body = addBody(doc, [revolve("r1", sketch, 360)]);
        expectSolid(body, Math.PI * 100 * 10, 1, 2);
    });

    test("a circle off the axis revolves into the Pappus torus", () => {
        const doc = newDoc();
        const sketch = addSketch(doc, circle(15, 0, 3, 1));
        const body = addBody(doc, [revolve("r1", sketch, 360)]);
        expectSolid(body, 2 * Math.PI * 15 * Math.PI * 9, 1, 1);
    });

    test("two regions sharing an edge revolve into one solid, as extrude merges them", () => {
        const doc = newDoc();
        const sketch = addSketch(doc, [
            ...rect(10, 0, 15, 10),
            { id: 5, type: "line", params: [15, 0, 20, 0] },
            { id: 6, type: "line", params: [20, 0, 20, 10] },
            { id: 7, type: "line", params: [20, 10, 15, 10] },
        ]);
        const faces = profileFaces(sketch);
        expect(faces.length).toBe(2);
        const body = addBody(doc, [
            revolve("r1", sketch, 360, { profiles: faces.map((face) => captureProfileRef(face)) }),
        ]);
        expectSolid(body, TUBE, 1, 2);
    });

    test("revolving about a line of the same sketch follows when that line moves", () => {
        const doc = newDoc();
        const axisLine: Entities = [{ id: 9, type: "line", params: [0, 0, 0, 10] }];
        const sketch = addSketch(doc, [...rect(10, 0, 20, 10), ...axisLine]);
        // The axis entity is open, so it never becomes a profile.
        expect(profileFaces(sketch).length).toBe(1);
        const axisEdge = (sketch.shape.unchecked()!.findSubShapes(ShapeTypes.edge) as IEdge[]).find(
            lineAlong("y", { x: 0, z: 0 }),
        );
        expect(axisEdge).toBeDefined();
        const body = addBody(doc, [
            revolve("r1", sketch, 360, {
                axisSource: { nodeId: sketch.id, edge: captureEdgeRef(axisEdge!) },
            }),
        ]);
        expectSolid(body, TUBE, 1, 2);

        // Move the axis line to x = −5: the tube now spans radii 15..25.
        sketch.setDataEmitShapeChanged({
            entities: [...rect(10, 0, 20, 10), { id: 9, type: "line", params: [-5, 0, -5, 10] }],
            constraints: [],
        });
        expectSolid(body, Math.PI * (625 - 225) * 10, 1, 2);
        expect(extent(body)[0]).toBeCloseTo(-30, 1);
    });

    test("revolving about another body's edge follows that body", () => {
        const doc = newDoc();
        // The datum: a thin bar whose edge x=0,z=0 runs along Y.
        const { body: datum, sketch: datumSketch } = boxBody(doc, 2, 10, 2);
        const axisRef = edgeRefs(datum, lineAlong("y", { x: 0, z: 0 }));
        expect(axisRef.length).toBe(1);
        const sketch = addSketch(doc, rect(10, 0, 20, 10));
        const body = addBody(doc, [
            revolve("r1", sketch, 360, { axisSource: { nodeId: datum.id, edge: axisRef[0] } }),
        ]);
        expectSolid(body, TUBE, 1, 2);

        // Slide the bar to x∈[−5,−3]: the axis edge (its x-min, z=0 edge) moves to x=−5.
        datumSketch.setDataEmitShapeChanged({ entities: rect(-5, 0, -3, 10), constraints: [] });
        expectSolid(body, Math.PI * (625 - 225) * 10, 1, 2);
    });

    test("an axis crossing the profile reports a feature error", () => {
        const doc = newDoc();
        const sketch = addSketch(doc, rect(-5, 0, 5, 10));
        const body = addBody(doc, [revolve("r1", sketch, 360)]);
        expect(errors(body)).toEqual(["Failed to revolve profile"]);
    });

    test("a full turn either way and a turn just short of it", () => {
        const doc = newDoc();
        const sketch = addSketch(doc, rect(10, 0, 20, 10));
        const back = addBody(doc, [revolve("r1", sketch, -360)]);
        const almost = addBody(doc, [revolve("r1", sketch, 359)]);
        expectSolid(back, TUBE, 1, 2);
        expectSolid(almost, (TUBE * 359) / 360, 1, 2);
    });

    // The kernel aborts on a zero angle and wraps anything past a full turn (400° builds a
    // 40° sector): the feature must refuse both with its own error before reaching it.
    test.each([0, 400, -400, 720])("an angle of %s° is refused by the feature, not the kernel", (angle) => {
        const doc = newDoc();
        const sketch = addSketch(doc, rect(10, 0, 20, 10));
        const body = addBody(doc, [revolve("r1", sketch, angle)]);
        const [error] = errors(body);
        expect(error).toBeDefined();
        expect(error).not.toMatch(/Aborted|RuntimeError/);
    });
});

// ---------------------------------------------------------------------------- A3. boolean feature

describe("boolean feature between bodies", () => {
    /** Host 40³ box; tool 20³ box at (30..50)³ → overlap 10³. */
    function hostAndTool() {
        const doc = newDoc();
        const { body: host } = boxBody(doc, 40, 40, 40);
        const toolSketch = addSketch(doc, rect(30, 30, 50, 50), planeAtZ(30));
        const tool = addBody(doc, [extrude("t1", toolSketch, 20)]);
        return { doc, host, tool, toolSketch };
    }

    test.each<[BooleanOperation, number, number[]]>([
        ["fuse", 64000 + 8000 - 1000, [0, 0, 0, 50, 50, 50]],
        ["cut", 64000 - 1000, [0, 0, 0, 40, 40, 40]],
        ["common", 1000, [30, 30, 30, 40, 40, 40]],
    ])("%s", (operation, expectedVolume, expectedExtent) => {
        const { host, tool } = hostAndTool();
        append(host, { id: "b1", type: "boolean", operation, toolIds: [tool.id] });
        expectSolid(host, expectedVolume);
        expectExtent(host, expectedExtent);
        // consumeTools defaults to true: the tool moves under the host.
        expect(tool.parent).toBe(host);
    });

    test("several tools are all applied", () => {
        const doc = newDoc();
        const { body: host } = boxBody(doc, 40, 40, 40);
        const a = addBody(doc, [extrude("t1", addSketch(doc, circle(10, 10, 5, 1), planeAtZ(-5)), 50)]);
        const b = addBody(doc, [extrude("t1", addSketch(doc, circle(30, 30, 4, 1), planeAtZ(-5)), 50)]);
        append(host, { id: "b1", type: "boolean", operation: "cut", toolIds: [a.id, b.id] });
        expectSolid(host, 64000 - (25 + 16) * Math.PI * 40);
    });

    test("intersect with several tools keeps only what all of them share", () => {
        const doc = newDoc();
        const { body: host } = boxBody(doc, 40, 40, 40);
        // Each tool overlaps the host by a 10-wide slab; all three share a 10×10×40 column.
        const a = addBody(doc, [extrude("t1", addSketch(doc, rect(30, 0, 50, 40)), 40)]);
        const b = addBody(doc, [extrude("t1", addSketch(doc, rect(0, 30, 40, 50)), 40)]);
        append(host, { id: "b1", type: "boolean", operation: "common", toolIds: [a.id, b.id] });
        expectSolid(host, 10 * 10 * 40);
        expectExtent(host, [30, 30, 0, 40, 40, 40]);
    });

    test("fusing a disjoint tool keeps two solids", () => {
        const { doc, host } = hostAndTool();
        const far = addBody(doc, [extrude("t1", addSketch(doc, rect(100, 0, 110, 10)), 10)]);
        append(host, { id: "b1", type: "boolean", operation: "fuse", toolIds: [far.id] });
        expectSolid(host, 64000 + 1000, 2);
    });

    test("a moved tool operates where it is displayed", () => {
        const { host, tool } = hostAndTool();
        append(host, {
            id: "b1",
            type: "boolean",
            operation: "cut",
            toolIds: [tool.id],
            consumeTools: false,
        });
        expectSolid(host, 63000);
        // Move the tool 5 deeper along each axis: overlap grows to 15³.
        tool.transform = Matrix4.fromTranslation(-5, -5, -5);
        expectSolid(host, 64000 - 15 ** 3);
    });

    test("editing the tool's sketch re-evaluates the host", () => {
        const { host, tool, toolSketch } = hostAndTool();
        append(host, { id: "b1", type: "boolean", operation: "cut", toolIds: [tool.id] });
        expectSolid(host, 63000);
        toolSketch.setDataEmitShapeChanged({ entities: rect(20, 20, 50, 50), constraints: [] });
        expectSolid(host, 64000 - 20 * 20 * 10);
    });

    test("a boolean with no preceding feature reports a feature error", () => {
        const { doc, tool } = hostAndTool();
        const body = addBody(doc, [{ id: "b1", type: "boolean", operation: "fuse", toolIds: [tool.id] }]);
        expect(errors(body)).toEqual(["boolean requires a preceding feature"]);
    });

    test("a tool id that names no body reports a feature error", () => {
        const { host } = hostAndTool();
        expectSolid(host, 64000);
        append(host, { id: "b1", type: "boolean", operation: "fuse", toolIds: ["missing"] });
        expect(errors(host)).toEqual([undefined, "Boolean tool not found"]);
        expect(volume(host)).toBeCloseTo(64000, 6);
    });
});

// ---------------------------------------------------------------------------- A4. fillet & chamfer

describe("fillet and chamfer", () => {
    // 40 (x) × 30 (y) × 20 (z) box.
    const V0 = 24000;

    function box() {
        const doc = newDoc();
        const { body, sketch } = boxBody(doc, 40, 30, 20);
        return { doc, body, sketch };
    }

    test.each<[string, "fillet" | "chamfer", number, (edge: IEdge) => boolean, number]>([
        ["fillet of a 40-long top edge", "fillet", 4, lineAlong("x", { y: 0, z: 20 }), FILLET_LOSS * 16 * 40],
        [
            "fillet of a 20-long vertical edge",
            "fillet",
            4,
            lineAlong("z", { x: 0, y: 0 }),
            FILLET_LOSS * 16 * 20,
        ],
        [
            "fillet of a 30-long bottom edge",
            "fillet",
            2.5,
            lineAlong("y", { x: 40, z: 0 }),
            FILLET_LOSS * 6.25 * 30,
        ],
        ["chamfer of a 40-long top edge", "chamfer", 3, lineAlong("x", { y: 0, z: 20 }), (9 / 2) * 40],
        ["chamfer of a 20-long vertical edge", "chamfer", 5, lineAlong("z", { x: 40, y: 30 }), (25 / 2) * 20],
    ])("%s", (_, kind, size, pick, removed) => {
        const { body } = box();
        const edges = edgeRefs(body, pick);
        expect(edges.length).toBe(1);
        append(
            body,
            kind === "fillet"
                ? { id: "c1", type: "fillet", radius: size, edges }
                : { id: "c1", type: "chamfer", distance: size, edges },
        );
        expectSolid(body, V0 - removed);
    });

    test("fillet of the four vertical edges in one feature", () => {
        const { body } = box();
        const edges = edgeRefs(body, (edge) => {
            if (edge.curve.basisCurve.curveType !== "line") return false;
            return (
                near(edge.startPoint().x, edge.endPoint().x) && near(edge.startPoint().y, edge.endPoint().y)
            );
        });
        expect(edges.length).toBe(4);
        append(body, { id: "f1", type: "fillet", radius: 3, edges });
        expectSolid(body, V0 - 4 * FILLET_LOSS * 9 * 20);
    });

    test("chamfer of two parallel edges in one feature", () => {
        const { body } = box();
        const edges = [
            ...edgeRefs(body, lineAlong("x", { y: 0, z: 20 })),
            ...edgeRefs(body, lineAlong("x", { y: 30, z: 0 })),
        ];
        expect(edges.length).toBe(2);
        append(body, { id: "c1", type: "chamfer", distance: 2, edges });
        expectSolid(body, V0 - 2 * 2 * 40);
    });

    test("fillet of the three edges at a corner rolls a spherical corner", () => {
        const { body } = box();
        const r = 4;
        const edges = [
            ...edgeRefs(body, lineAlong("x", { y: 0, z: 0 })),
            ...edgeRefs(body, lineAlong("y", { x: 0, z: 0 })),
            ...edgeRefs(body, lineAlong("z", { x: 0, y: 0 })),
        ];
        expect(edges.length).toBe(3);
        append(body, { id: "f1", type: "fillet", radius: r, edges });
        const removed = FILLET_LOSS * r * r * (40 + 30 + 20 - 3 * r) + r ** 3 * (1 - Math.PI / 6);
        expectSolid(body, V0 - removed, 1, 1);
    });

    test("fillet of two edges meeting at a corner with the third edge sharp (mitred)", () => {
        const { body } = box();
        const r = 4;
        const edges = [
            ...edgeRefs(body, lineAlong("x", { y: 0, z: 20 })),
            ...edgeRefs(body, lineAlong("y", { x: 0, z: 20 })),
        ];
        expect(edges.length).toBe(2);
        append(body, { id: "f1", type: "fillet", radius: r, edges });
        const removed = FILLET_LOSS * r * r * (40 + 30 - 2 * r) + r ** 3 / 3;
        expectSolid(body, V0 - removed, 1, 1);
    });

    test("fillet of a hole's circular rim matches Pappus", () => {
        const doc = newDoc();
        const { body } = boxBody(doc, 40, 40, 10);
        const hole = addSketch(doc, circle(20, 20, 8, 1), planeAtZ(10));
        append(body, extrude("e2", hole, -10, { operation: "cut" }));
        expectSolid(body, 16000 - 64 * Math.PI * 10);
        const rim = edgeRefs(
            body,
            (edge) =>
                edge.curve.basisCurve.curveType === "circle" &&
                near(edge.startPoint().z, 10) &&
                near(edge.endPoint().z, 10),
        );
        expect(rim.length).toBeGreaterThanOrEqual(1);
        const r = 2;
        append(body, { id: "f1", type: "fillet", radius: r, edges: rim });
        const removed = FILLET_LOSS * r * r * 2 * Math.PI * (8 + r * SPANDREL_CENTROID);
        expectSolid(body, 16000 - 640 * Math.PI - removed, 1, 2);
    });

    test("fillet of an edge merged by a flush join covers the whole merged span", () => {
        const doc = newDoc();
        const sketch1 = addSketch(doc, rect(-20, -20, 20, 20));
        const body = addBody(doc, [extrude("e1", sketch1, 20)]);
        const sketch2 = addSketch(doc, rect(20, -20, 40, 0));
        append(body, extrude("e2", sketch2, 20, { operation: "fuse" }));
        expectSolid(body, 32000 + 8000);
        const merged = edgeRefs(body, lineAlong("x", { y: -20, z: 20 }));
        expect(merged.length).toBe(1);
        append(body, { id: "f1", type: "fillet", radius: 2, edges: merged });
        expectSolid(body, 40000 - FILLET_LOSS * 4 * 60);

        // Deepen the box: the merged edge re-splits into 40 (z=40) and 20 (z=20) pieces,
        // both still filleted.
        setFeature(body, "e1", { depth: 40 });
        expectSolid(body, 64000 + 8000 - FILLET_LOSS * 4 * 60);
    });

    test("a radius larger than the faces allow reports a feature error and keeps the shape", () => {
        const { body } = box();
        const edges = edgeRefs(body, lineAlong("x", { y: 0, z: 20 }));
        append(body, { id: "f1", type: "fillet", radius: 4, edges });
        expectSolid(body, V0 - FILLET_LOSS * 16 * 40);
        setFeature(body, "f1", { radius: 25 });
        expect(errors(body)[1]).toBeDefined();
        expect(volume(body)).toBeCloseTo(V0 - FILLET_LOSS * 16 * 40, 3);
        setFeature(body, "f1", { radius: 5 });
        expectSolid(body, V0 - FILLET_LOSS * 25 * 40);
    });

    // OCCT raises on these, and the Release wasm build turns every raise into a module abort
    // (`RuntimeError: Aborted`): the row must carry a real error instead of a kernel crash.
    // Expected to fail until the WASM build catches OCCT's exceptions (`-fwasm-exceptions` in
    // cpp/CMakeLists.txt): the Release build disables exception catching, so the kernel's own
    // try/catch around BRepFilletAPI cannot turn an oversize radius into an error result and the
    // module aborts. `test.fails` turns red once the rebuilt binary lands; drop it then.
    test.fails.each<["fillet" | "chamfer", number]>([
        ["fillet", 25],
        ["chamfer", 25],
        ["chamfer", 20],
    ])("an oversize %s (%s on a 20-high box) is refused without a kernel abort", (kind, size) => {
        const { body } = box();
        const edges = edgeRefs(body, lineAlong("x", { y: 0, z: 20 }));
        append(
            body,
            kind === "fillet"
                ? { id: "c1", type: "fillet", radius: size, edges }
                : { id: "c1", type: "chamfer", distance: size, edges },
        );
        const [, error] = errors(body);
        expect(error).toBeDefined();
        expect(error).not.toMatch(/Aborted|RuntimeError/);
    });

    test("fillet of all twelve box edges: straight runs plus eight spherical corners", () => {
        const { body } = box();
        const edges = edgeRefs(body, () => true);
        expect(edges.length).toBe(12);
        const r = 3;
        append(body, { id: "f1", type: "fillet", radius: r, edges });
        const removed = FILLET_LOSS * r * r * 4 * (40 + 30 + 20 - 6 * r) + 8 * r ** 3 * (1 - Math.PI / 6);
        expectSolid(body, V0 - removed, 1, 1);
    });

    test("a fillet on one edge of a tangent chain rounds the whole chain (kernel propagation)", () => {
        const doc = newDoc();
        // Stadium slot: straights y=±5 for x∈[0,20], semicircle ends of radius 5.
        const sketch = addSketch(doc, [
            { id: 1, type: "line", params: [0, -5, 20, -5] },
            { id: 2, type: "arc", params: [20, 0, 20, -5, 20, 5] },
            { id: 3, type: "line", params: [20, 5, 0, 5] },
            { id: 4, type: "arc", params: [0, 0, 0, 5, 0, -5] },
        ]);
        const body = addBody(doc, [extrude("e1", sketch, 10)]);
        const area = 20 * 10 + 25 * Math.PI;
        expectSolid(body, area * 10, 1, 2);
        const r = 1;
        append(body, {
            id: "f1",
            type: "fillet",
            radius: r,
            edges: edgeRefs(body, lineAlong("x", { y: -5, z: 10 })),
        });
        const removed = FILLET_LOSS * r * r * (2 * 20 + 2 * Math.PI * (5 - r * SPANDREL_CENTROID));
        expectSolid(body, area * 10 - removed, 1, 2);
    });

    test("a concave fillet adds material", () => {
        const doc = newDoc();
        const { body } = boxBody(doc, 40, 40, 10);
        // A full-width step on top: the concave edge y=20, z=10 runs the whole 40.
        append(
            body,
            extrude("e2", addSketch(doc, rect(0, 0, 40, 20), planeAtZ(10)), 10, { operation: "fuse" }),
        );
        expectSolid(body, 16000 + 8000);
        const concave = edgeRefs(body, lineAlong("x", { y: 20, z: 10 }));
        expect(concave.length).toBe(1);
        append(body, { id: "f1", type: "fillet", radius: 3, edges: concave });
        expectSolid(body, 24000 + FILLET_LOSS * 9 * 40);
    });

    test.each<["fillet" | "chamfer", string]>([
        ["fillet", "The radius is too small."],
        ["chamfer", "The distance is too small."],
    ])("a zero-size %s reports a feature error", (kind, message) => {
        const { body } = box();
        const edges = edgeRefs(body, lineAlong("x", { y: 0, z: 20 }));
        append(
            body,
            kind === "fillet"
                ? { id: "c1", type: "fillet", radius: 0, edges }
                : { id: "c1", type: "chamfer", distance: 0, edges },
        );
        expect(errors(body)).toEqual([undefined, message]);
    });

    test("a fillet with no preceding feature reports a feature error", () => {
        const doc = newDoc();
        const body = addBody(doc, [{ id: "f1", type: "fillet", radius: 2, edges: [] }]);
        expect(errors(body)).toEqual(["fillet requires a preceding feature"]);
    });
});

// ---------------------------------------------------------------------------- A5. press-pull

describe("press-pull on a body face", () => {
    test.each<[string, number, Partial<ExtrudeFeatureData>, number, number[]]>([
        ["pull out and join", 10, { operation: "fuse" }, 64000 + 16000, [0, 0, 0, 40, 40, 50]],
        ["push in and cut", -10, { operation: "cut" }, 64000 - 16000, [0, 0, 0, 40, 40, 30]],
        ["symmetric join", 10, { operation: "fuse", symmetric: true }, 64000 + 16000, [0, 0, 0, 40, 40, 50]],
        ["intersect with an inward prism", -15, { operation: "common" }, 1600 * 15, [0, 0, 25, 40, 40, 40]],
        [
            "join from a start offset",
            10,
            { operation: "fuse", startOffset: 5 },
            64000 + 16000,
            [0, 0, 0, 40, 40, 55],
        ],
    ])("%s", (_, depth, extra, expectedVolume, expectedExtent) => {
        const doc = newDoc();
        const { body } = boxBody(doc, 40, 40, 40);
        append(body, pressPull("p1", body, "z", depth, extra));
        expectSolid(body, expectedVolume, extra.startOffset === undefined ? 1 : 2);
        expectExtent(body, expectedExtent);
    });

    test("pulling a side face of another body builds a new standalone prism", () => {
        const doc = newDoc();
        const { body: source } = boxBody(doc, 40, 40, 40);
        const prism = addBody(doc, [pressPull("p1", source, "x", 15)]);
        expectSolid(prism, 1600 * 15);
        expectExtent(prism, [40, 0, 0, 55, 40, 40]);
    });

    test("a pull of the face a fillet trimmed sweeps the trimmed outline", () => {
        const doc = newDoc();
        const { body } = boxBody(doc, 40, 40, 40);
        append(body, {
            id: "f1",
            type: "fillet",
            radius: 4,
            edges: edgeRefs(body, lineAlong("x", { y: 40, z: 40 })),
        });
        const v1 = 64000 - FILLET_LOSS * 16 * 40;
        expectSolid(body, v1);
        // The top face is now 40 × 36: its pull adds 40·36·10.
        append(body, pressPull("p1", body, "z", 10, { operation: "fuse" }));
        expectSolid(body, v1 + 40 * 36 * 10);
    });

    test("the press-pull follows its source face when the body grows upstream", () => {
        const doc = newDoc();
        const { body } = boxBody(doc, 40, 40, 40);
        append(body, pressPull("p1", body, "x", 10, { operation: "fuse" }));
        expectSolid(body, 64000 + 16000);
        setFeature(body, "e1", { depth: 20 });
        // The +X face is now 40 × 20.
        expectSolid(body, 32000 + 8000);
        expectExtent(body, [0, 0, 0, 50, 40, 20]);
    });
});

// ---------------------------------------------------------------------------- A6. parametric behaviour

/** A rectangle fully constrained by the solver: corner fixed at the origin, width `w`, height `h`. */
function constrainedRect(
    width: number | string,
    height: number | string,
    initialWidth: number,
    initialHeight: number,
): SketchData {
    const p = (entityId: number, pointIndex: number) => ({ entityId, pointIndex });
    return {
        // Entities as the editor leaves them: already solved for the initial datums.
        entities: rect(0, 0, initialWidth, initialHeight),
        constraints: [
            { id: 1, kind: ConstraintKind.P2PCoincident, refs: [p(1, 1), p(2, 0)] },
            { id: 2, kind: ConstraintKind.P2PCoincident, refs: [p(2, 1), p(3, 0)] },
            { id: 3, kind: ConstraintKind.P2PCoincident, refs: [p(3, 1), p(4, 0)] },
            { id: 4, kind: ConstraintKind.P2PCoincident, refs: [p(4, 1), p(1, 0)] },
            { id: 5, kind: ConstraintKind.Horizontal, refs: [p(1, 0), p(1, 1)] },
            { id: 6, kind: ConstraintKind.Horizontal, refs: [p(3, 0), p(3, 1)] },
            { id: 7, kind: ConstraintKind.Vertical, refs: [p(2, 0), p(2, 1)] },
            { id: 8, kind: ConstraintKind.Vertical, refs: [p(4, 0), p(4, 1)] },
            { id: 9, kind: ConstraintKind.Fix, refs: [p(1, 0)], datums: [0, 0] },
            { id: 10, kind: ConstraintKind.P2PDistance, refs: [p(1, 0), p(1, 1)], datum: width },
            { id: 11, kind: ConstraintKind.P2PDistance, refs: [p(2, 0), p(2, 1)], datum: height },
        ],
    };
}

describe("parametric re-evaluation", () => {
    test("a variable-driven sketch dimension carries the extrude, the cut and the fillet", () => {
        const doc = newDoc();
        setVariable(doc, "w", "40");
        const sketch = new SketchNode({
            document: doc,
            plane: Plane.XY,
            data: constrainedRect("w", 30, 40, 30),
        });
        doc.modelManager.addNode(sketch);
        const body = addBody(doc, [extrude("e1", sketch, 20)]);
        expectSolid(body, 40 * 30 * 20);

        const hole = addSketch(doc, circle(10, 15, 4, 1), planeAtZ(20));
        append(body, extrude("e2", hole, -20, { operation: "cut" }));
        const holeVolume = 16 * Math.PI * 20;
        // Fillet the far top edge (x = 40 side, along Y) — it moves with the dimension.
        const far = edgeRefs(body, lineAlong("y", { x: 40, z: 20 }));
        expect(far.length).toBe(1);
        append(body, { id: "f1", type: "fillet", radius: 3, edges: far });
        expectSolid(body, 24000 - holeVolume - FILLET_LOSS * 9 * 30);

        setVariable(doc, "w", "60");
        expectSolid(body, 36000 - holeVolume - FILLET_LOSS * 9 * 30);
        expectExtent(body, [0, 0, 0, 60, 30, 20]);
        // The fillet stayed on the moved far edge: the near (x=0) top edge is still sharp.
        expect(edgeRefs(body, lineAlong("y", { x: 0, z: 20 })).length).toBe(1);
        expect(edgeRefs(body, lineAlong("y", { x: 60, z: 20 })).length).toBe(0);

        setVariable(doc, "w", "40");
        expectSolid(body, 24000 - holeVolume - FILLET_LOSS * 9 * 30);
    });

    test("a variable-driven fillet radius and extrude depth follow the variable", () => {
        const doc = newDoc();
        setVariable(doc, "h", "20");
        const sketch = addSketch(doc, rect(0, 0, 40, 30));
        const body = addBody(doc, [extrude("e1", sketch, "h")]);
        append(body, {
            id: "f1",
            type: "fillet",
            radius: "h / 5",
            edges: edgeRefs(body, lineAlong("x", { y: 0, z: 20 })),
        });
        expectSolid(body, 24000 - FILLET_LOSS * 16 * 40);
        setVariable(doc, "h", "30");
        expectSolid(body, 36000 - FILLET_LOSS * 36 * 40);
    });

    test("suppressing, unsuppressing and deleting a mid-chain feature", () => {
        const doc = newDoc();
        const { body } = boxBody(doc, 40, 30, 20);
        const hole = addSketch(doc, circle(20, 15, 5, 1), planeAtZ(20));
        append(body, extrude("e2", hole, -20, { operation: "cut" }));
        append(body, {
            id: "f1",
            type: "fillet",
            radius: 2,
            edges: edgeRefs(body, lineAlong("z", { x: 0, y: 0 })),
        });
        const filletLoss = FILLET_LOSS * 4 * 20;
        const holeVolume = 25 * Math.PI * 20;
        expectSolid(body, 24000 - holeVolume - filletLoss);

        body.setFeatureSuppressed("e2", true);
        expectSolid(body, 24000 - filletLoss);
        expect(body.featureItems()[1].suppressed).toBe(true);

        body.setFeatureSuppressed("e2", false);
        expectSolid(body, 24000 - holeVolume - filletLoss);

        body.setFeatureSuppressed("f1", true);
        expectSolid(body, 24000 - holeVolume);
        body.setFeatureSuppressed("f1", false);

        body.removeFeature("e2");
        expectSolid(body, 24000 - filletLoss);
        expect(body.features.map((f) => f.id)).toEqual(["e1", "f1"]);
    });

    test("reordering independent features gives the same solid", () => {
        const doc = newDoc();
        const { body } = boxBody(doc, 40, 30, 20);
        const hole = addSketch(doc, circle(20, 15, 5, 1), planeAtZ(20));
        append(body, extrude("e2", hole, -20, { operation: "cut" }));
        append(body, {
            id: "f1",
            type: "fillet",
            radius: 2,
            edges: edgeRefs(body, lineAlong("z", { x: 0, y: 0 })),
        });
        const expected = 24000 - 25 * Math.PI * 20 - FILLET_LOSS * 4 * 20;
        expectSolid(body, expected);

        body.moveFeature("f1", -1);
        expect(body.features.map((f) => f.id)).toEqual(["e1", "f1", "e2"]);
        expectSolid(body, expected);

        body.moveFeatureTo("f1", 2);
        expect(body.features.map((f) => f.id)).toEqual(["e1", "e2", "f1"]);
        expectSolid(body, expected);
    });

    test("a fillet whose edge vanishes upstream reports, keeps the shape, and heals", () => {
        const doc = newDoc();
        const { body } = boxBody(doc, 40, 40, 10);
        const hole = addSketch(doc, circle(20, 20, 8, 1), planeAtZ(10));
        append(body, extrude("e2", hole, -10, { operation: "cut" }));
        const rim = edgeRefs(
            body,
            (edge) => edge.curve.basisCurve.curveType === "circle" && near(edge.startPoint().z, 10),
        );
        expect(rim.length).toBeGreaterThanOrEqual(1);
        append(body, { id: "f1", type: "fillet", radius: 2, edges: rim });
        const good = volume(body);
        expectClean(body);

        // Move the hole off the plate: the cut removes nothing and no circular edge is left.
        hole.setDataEmitShapeChanged({ entities: circle(200, 20, 8, 1), constraints: [] });
        expect(errors(body)).toEqual([undefined, undefined, "Edge not found after rebuild"]);
        expect(volume(body)).toBeCloseTo(good, 6);

        hole.setDataEmitShapeChanged({ entities: circle(20, 20, 8, 1), constraints: [] });
        expectSolid(body, good);
    });

    test("undo and redo of a feature edit restore the exact volume", () => {
        const doc = newDoc();
        const { body } = boxBody(doc, 40, 30, 20);
        append(body, {
            id: "f1",
            type: "fillet",
            radius: 2,
            edges: edgeRefs(body, lineAlong("x", { y: 0, z: 20 })),
        });
        const before = volume(body);
        Transaction.execute(doc, "edit fillet", () => setFeature(body, "f1", { radius: 6 }));
        expectSolid(body, 24000 - FILLET_LOSS * 36 * 40);
        doc.history.undo();
        expectSolid(body, before);
        doc.history.redo();
        expectSolid(body, 24000 - FILLET_LOSS * 36 * 40);
    });
});

// ---------------------------------------------------------------------------- A7. edge identity

/**
 * A rectangle whose endpoints carry sub-tolerance noise, exactly as the sketch solver writes
 * them back (`e` are offsets far below any modeling tolerance). The geometry is the clean
 * rectangle; only the kernel's enumeration of the swept solid may differ.
 */
const noisyRect = (x0: number, y0: number, x1: number, y1: number, e: readonly number[]): Entities => [
    { id: 1, type: "line", params: [x0 + e[0], y0 + e[1], x1, y0 + e[2]] },
    { id: 2, type: "line", params: [x1, y0, x1, y1] },
    { id: 3, type: "line", params: [x1, y1, x0 + e[3], y1] },
    { id: 4, type: "line", params: [x0 + e[4], y1, x0 + e[5], y0 + e[6]] },
];

const SOLVER_NOISE: [string, number[]][] = [
    [
        "noise of a real solver write-back",
        [3.58e-18, -3.5e-18, -6.03e-18, 3.58e-18, 3.58e-18, 3.58e-18, -1.74e-17],
    ],
    ["one closing endpoint off by 1e-17", [0, 0, 0, 0, 0, 0, -1e-17]],
    ["one starting endpoint off by 1e-17", [1e-17, 0, 0, 0, 0, 0, 0]],
];

describe("edge references survive a kernel re-enumeration of the sweep", () => {
    test.each(SOLVER_NOISE)("an extrude's top-cap edge fillet stays on its edge (%s)", (_, noise) => {
        const doc = newDoc();
        const { body, sketch } = boxBody(doc, 40, 30, 20);
        // Fillet the far (x = 40) top edge; its opposite (x = 0) is parallel and equally long.
        append(body, {
            id: "f1",
            type: "fillet",
            radius: 3,
            edges: edgeRefs(body, lineAlong("y", { x: 40, z: 20 })),
        });
        expectSolid(body, 24000 - FILLET_LOSS * 9 * 30);

        sketch.setDataEmitShapeChanged({ entities: noisyRect(0, 0, 60, 30, noise), constraints: [] });
        expectSolid(body, 36000 - FILLET_LOSS * 9 * 30);
        // The volume cannot tell the two edges apart — which one is still sharp can.
        expect(edgeRefs(body, lineAlong("y", { x: 0, z: 20 })).length).toBe(1);
        expect(edgeRefs(body, lineAlong("y", { x: 60, z: 20 })).length).toBe(0);
    });

    test.each(SOLVER_NOISE)("a revolve's circular edge fillet stays on its edge (%s)", (_, noise) => {
        const doc = newDoc();
        const sketch = addSketch(doc, rect(10, 0, 20, 10));
        const body = addBody(doc, [revolve("r1", sketch, 360)]);
        const isCircle = (radius: number, y: number) => (edge: IEdge) => {
            const basis = edge.curve.basisCurve;
            return (
                basis.curveType === "circle" &&
                Math.abs((basis as unknown as { radius: number }).radius - radius) < 1e-6 &&
                near(edge.startPoint().y, y)
            );
        };
        // Fillet the outer top circle (r = 20, y = 10); the tube has three coaxial look-alikes.
        const r = 2;
        append(body, { id: "f1", type: "fillet", radius: r, edges: edgeRefs(body, isCircle(20, 10)) });
        const outerLoss = FILLET_LOSS * r * r * 2 * Math.PI * (20 - r * SPANDREL_CENTROID);
        expectSolid(body, Math.PI * 300 * 10 - outerLoss, 1, 1);

        // Raise the profile to y = 12 through a noisy write-back.
        sketch.setDataEmitShapeChanged({ entities: noisyRect(10, 0, 20, 12, noise), constraints: [] });
        expectSolid(body, Math.PI * 300 * 12 - outerLoss, 1, 1);
        // The fillet's trimmed boundaries sit on the top face (r = 18) and the outer wall (y = 10);
        // the other three original circles are untouched.
        for (const [radius, y] of [
            [18, 12],
            [20, 10],
            [10, 12],
            [10, 0],
            [20, 0],
        ]) {
            expect(edgeRefs(body, isCircle(radius, y)).length).toBe(1);
        }
    });
});

describe("revolve-based cut through the boolean feature (revolve has no join/cut of its own)", () => {
    test("a revolved ring cuts a groove into an extruded cylinder", () => {
        const doc = newDoc();
        const host = addBody(doc, [extrude("e1", addSketch(doc, circle(0, 0, 20, 1), Plane.ZX), 40)]);
        // The ZX sketch sweeps along +Y: a Ø40 cylinder on the Y axis, y∈[0,40].
        expectSolid(host, Math.PI * 400 * 40, 1, 2);
        // Groove profile: r∈[16,22] × y∈[15,25], around the Y axis — removes the r∈[16,20] annulus.
        const groove = addBody(doc, [revolve("r1", addSketch(doc, rect(16, 15, 22, 25)), 360)]);
        append(host, { id: "b1", type: "boolean", operation: "cut", toolIds: [groove.id] });
        expectSolid(host, Math.PI * 400 * 40 - Math.PI * (400 - 256) * 10, 1, 2);
    });
});
