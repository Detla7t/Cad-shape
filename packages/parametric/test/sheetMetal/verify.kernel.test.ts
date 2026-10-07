// Part of the Chili3d Project, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

/**
 * Verification of the sheet metal tools through real parametric bodies (the `sm*` feature
 * chain on the OCCT kernel), checked against independent analytic geometry: volumes from
 * thickness × developed area, folded corner positions from a 2D profile walker, slot / lip /
 * bead / crimp extents from region volumes, flat patterns from developed lengths.
 */

import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
    type IEdge,
    type IFace,
    type INode,
    type ISelection,
    type IShape,
    Matrix4,
    Plane,
    ShapeTypes,
    Transaction,
    XYZ,
} from "@chili3d/core";
import { createMockApplication, createMockVisualWithDocument, TestDocument } from "@chili3d/core/test-utils";
import { initWasm, ShapeFactory } from "@chili3d/wasm";
import { captureEdgeRef } from "../../src/features/edgeRef";
import type { FeatureData, SheetMetalFeatureData } from "../../src/features/feature";
import { ParametricBodyNode } from "../../src/parametricBodyNode";
import {
    BeadCommand,
    CrimpCommand,
    EasyEdgeCommand,
    FlangeCommand,
    FlattenCommand,
    HemCommand,
    PittsburghCommand,
    RollCommand,
    SheetMetalBaseCommand,
    SheetMetalBendCommand,
} from "../../src/sheetMetal/commands";
import { captureSheetLine } from "../../src/sheetMetal/features";
import { Arena } from "../../src/sheetMetal/frame";
import { layoutOf, mapPoint } from "../../src/sheetMetal/layout";
import { bendAllowance, sheetModelOf } from "../../src/sheetMetal/model";
import { DEFAULTS, INCH } from "../../src/sheetMetal/treatments";
import type { SketchData } from "../../src/sketch/sketchModel";
import { SketchNode } from "../../src/sketch/sketchNode";
import "../sketch/setup";

const WASM_BINARY = readFileSync(
    path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../wasm/lib/chili-wasm.wasm"),
);

beforeAll(async () => {
    await initWasm({ wasmBinary: WASM_BINARY });
    Object.defineProperty(globalThis, "shapeFactory", {
        value: new ShapeFactory(),
        writable: true,
        configurable: true,
    });
});

// ------------------------------------------------------------------ Document / body helpers

const selectionStub = { setSelectedNodes: () => {}, clearSelection: () => {} } as unknown as ISelection;

function newDoc(): TestDocument {
    const doc = new TestDocument({ application: createMockApplication(), selection: selectionStub });
    doc.visual = createMockVisualWithDocument(doc) as any;
    return doc;
}

type P2 = [number, number];

const polygon = (points: P2[]): SketchData => ({
    entities: points.map((p, i) => {
        const q = points[(i + 1) % points.length];
        return { id: i + 1, type: "line" as const, params: [p[0], p[1], q[0], q[1]] };
    }),
    constraints: [],
});

const rect = (x0: number, y0: number, x1: number, y1: number): SketchData =>
    polygon([
        [x0, y0],
        [x1, y0],
        [x1, y1],
        [x0, y1],
    ]);

function addSketch(doc: TestDocument, data: SketchData, plane = Plane.XY): SketchNode {
    const sketch = new SketchNode({ document: doc, plane, data });
    doc.modelManager.addNode(sketch);
    return sketch;
}

interface Material {
    readonly t?: number;
    readonly r?: number;
    readonly k?: number;
    readonly plane?: Plane;
}

function sheet(
    doc: TestDocument,
    data: SketchData,
    { t = 1, r = 1, k = 0.5, plane = Plane.XY }: Material = {},
) {
    const sketch = addSketch(doc, data, plane);
    const body = new ParametricBodyNode({
        document: doc,
        features: [{ id: "base", type: "smBase", sketchId: sketch.id, thickness: t, radius: r, kFactor: k }],
    });
    doc.modelManager.addNode(body);
    return { body, sketch };
}

function add(doc: TestDocument, body: ParametricBodyNode, feature: FeatureData) {
    Transaction.execute(doc, "add", () => body.setFeaturesEmitShapeChanged([...body.features, feature]));
}

function edit(doc: TestDocument, body: ParametricBodyNode, id: string, key: string, value: number | string) {
    Transaction.execute(doc, "edit", () => body.setFeatureParameter(id, key, value));
}

/** Lines of their own sketch, overshooting the blank, as bend / bead lines. */
function sketchLines(doc: TestDocument, lines: [P2, P2][]) {
    const sketch = addSketch(doc, {
        entities: lines.map(([a, b], i) => ({
            id: i + 1,
            type: "line" as const,
            params: [a[0], a[1], b[0], b[1]],
        })),
        constraints: [],
    });
    const edges = sketch.shape.value.findSubShapes(ShapeTypes.edge) as IEdge[];
    return edges.map((edge) => captureSheetLine(sketch.id, edge, Matrix4.identity()));
}

/** Vertical bend lines x = const across a blank of height h. */
const bendLines = (doc: TestDocument, xs: number[], h: number) =>
    sketchLines(
        doc,
        xs.map((x) => [
            [x, -10],
            [x, h + 10],
        ]),
    );

function bend(
    id: string,
    lines: ReturnType<typeof sketchLines>,
    angle: number,
    direction: "up" | "down",
    radius?: number,
) {
    return {
        id,
        type: "smBend" as const,
        lines,
        angle,
        direction,
        ...(radius === undefined ? {} : { radius }),
    };
}

/** Midpoint of the formed image (bottom face) of a flat blank edge. */
function formedImage(body: ParametricBodyNode, a: P2, b: P2): [number, number, number] {
    const model = sheetModelOf(body.shape.value)!;
    const arena = new Arena();
    try {
        const layout = layoutOf(arena, model);
        const p = mapPoint(layout, a, 0)!;
        const q = mapPoint(layout, b, 0)!;
        return [(p[0] + q[0]) / 2, (p[1] + q[1]) / 2, (p[2] + q[2]) / 2];
    } finally {
        arena.dispose();
    }
}

/** The body's edge whose midpoint is nearest to `point` (what a user clicks there). */
function nearestEdge(body: ParametricBodyNode, point: [number, number, number]): IEdge {
    const edges = body.shape.value.findSubShapes(ShapeTypes.edge) as IEdge[];
    let best = edges[0];
    let bestDistance = Number.POSITIVE_INFINITY;
    for (const edge of edges) {
        const [a, b] = edge.ends();
        const d = Math.hypot(
            (a.x + b.x) / 2 - point[0],
            (a.y + b.y) / 2 - point[1],
            (a.z + b.z) / 2 - point[2],
        );
        if (d < bestDistance) {
            best = edge;
            bestDistance = d;
        }
    }
    return best;
}

/** A picked edge, captured as the edge commands capture it. */
const edgeNear = (body: ParametricBodyNode, point: [number, number, number]) =>
    captureEdgeRef(nearestEdge(body, point));

/** The treated blank edges as [u of a, u of b, length], orientation-free. */
const flangeEdges = (body: ParametricBodyNode) =>
    (sheetModelOf(body.shape.value)?.flanges ?? []).map((f) => [
        Number(f.a[0].toFixed(9)),
        Number(f.b[0].toFixed(9)),
        Number(Math.hypot(f.a[0] - f.b[0], f.a[1] - f.b[1]).toFixed(9)),
    ]);

const errors = (body: ParametricBodyNode) => body.featureItems().map((item) => item.error);
const warnings = (body: ParametricBodyNode) => body.featureItems().map((item) => item.warning);
const solids = (shape: IShape) => shape.findSubShapes(ShapeTypes.solid).length;
const totalVolume = (shape: IShape) =>
    shape.findSubShapes(ShapeTypes.solid).reduce((sum, solid) => sum + solid.volume(), 0);

// ------------------------------------------------------------------ Geometry probes

interface Box3 {
    readonly min: [number, number, number];
    readonly max: [number, number, number];
}

/** Exact bounds of the B-rep vertices (the mesh-based `boundingBox` sits inside true arcs). */
function vertexBox(shape: IShape): Box3 {
    const min: [number, number, number] = [Infinity, Infinity, Infinity];
    const max: [number, number, number] = [-Infinity, -Infinity, -Infinity];
    for (const vertex of shape.findSubShapes(ShapeTypes.vertex) as unknown as { point(): XYZ }[]) {
        const p = vertex.point();
        [p.x, p.y, p.z].forEach((c, i) => {
            min[i] = Math.min(min[i], c);
            max[i] = Math.max(max[i], c);
        });
    }
    return { min, max };
}

function expectBox(actual: Box3, expected: Box3, digits = 6) {
    for (let i = 0; i < 3; i++) {
        expect(actual.min[i]).toBeCloseTo(expected.min[i], digits);
        expect(actual.max[i]).toBeCloseTo(expected.max[i], digits);
    }
}

function axisBox(min: number[], max: number[]): IShape {
    return shapeFactory.box(
        new Plane({ origin: new XYZ(min[0], min[1], min[2]), normal: XYZ.unitZ, xvec: XYZ.unitX }),
        max[0] - min[0],
        max[1] - min[1],
        max[2] - min[2],
    ).value;
}

/** Volume of the part's material inside an axis-aligned box. */
function regionVolume(shape: IShape, min: number[], max: number[]): number {
    return shapeFactory.booleanCommon([shape], [axisBox(min, max)]).value.volume();
}

/** The material between radii `inner`..`outer` around a y-parallel axis, over y ∈ [y0, y1]. */
function annulusPart(
    shape: IShape,
    center: [number, number],
    inner: number,
    outer: number,
    y0: number,
    y1: number,
) {
    const cylinder = (radius: number) =>
        shapeFactory.cylinder(XYZ.unitY, new XYZ(center[0], y0, center[1]), radius, y1 - y0).value;
    const tool =
        inner <= 0 ? cylinder(outer) : shapeFactory.booleanCut([cylinder(outer)], [cylinder(inner)]).value;
    return shapeFactory.booleanCommon([shape], [tool]).value;
}

const interference = (a: IShape, b: IShape) => shapeFactory.booleanCommon([a], [b]).value.volume();

// ------------------------------------------------------------------ Independent analytic profile walker

type Element = { kind: "straight"; length: number } | { kind: "bend"; angle: number; radius: number };
const S = (length: number): Element => ({ kind: "straight", length });
const B = (angle: number, radius: number): Element => ({ kind: "bend", angle, radius });

/**
 * Walks a sheet cross-section in the (x, z) plane: the sheet starts at x = 0 heading +x with
 * its bottom at z = 0 and top at z = t. A positive bend folds toward +z around an axis `radius`
 * above the top surface, a negative one toward −z around an axis `radius` below the bottom.
 * Returns every bottom/top corner — the B-rep vertices of the folded section.
 */
function walk(elements: Element[], t: number): P2[] {
    let bottom: P2 = [0, 0];
    let top: P2 = [0, t];
    let heading = 0;
    const corners: P2[] = [bottom, top];
    const rotate = (p: P2, c: P2, a: number): P2 => [
        c[0] + (p[0] - c[0]) * Math.cos(a) - (p[1] - c[1]) * Math.sin(a),
        c[1] + (p[0] - c[0]) * Math.sin(a) + (p[1] - c[1]) * Math.cos(a),
    ];
    for (const element of elements) {
        if (element.kind === "straight") {
            const d: P2 = [Math.cos(heading) * element.length, Math.sin(heading) * element.length];
            bottom = [bottom[0] + d[0], bottom[1] + d[1]];
            top = [top[0] + d[0], top[1] + d[1]];
        } else {
            const a = (element.angle * Math.PI) / 180;
            const left: P2 = [-Math.sin(heading), Math.cos(heading)];
            const center: P2 =
                a > 0
                    ? [top[0] + left[0] * element.radius, top[1] + left[1] * element.radius]
                    : [bottom[0] - left[0] * element.radius, bottom[1] - left[1] * element.radius];
            bottom = rotate(bottom, center, a);
            top = rotate(top, center, a);
            heading += a;
        }
        corners.push(bottom, top);
    }
    return corners;
}

/** The x/z bounds of walked corners (offset by `x0`) plus `extra` points, y over [y0, y1]. */
function walkedBox(corners: P2[], y0: number, y1: number, x0 = 0, extra: P2[] = []): Box3 {
    const xs = corners.map((p) => x0 + p[0]).concat(extra.map((p) => p[0]));
    const zs = corners.map((p) => p[1]).concat(extra.map((p) => p[1]));
    return { min: [Math.min(...xs), y0, Math.min(...zs)], max: [Math.max(...xs), y1, Math.max(...zs)] };
}

/** Formed volume of a walked strip of width `w`: straights are t·L, bends the annulus sector t·θ·(r + t/2). */
function formedVolume(elements: Element[], t: number, w: number): number {
    return (
        w *
        elements.reduce(
            (sum, e) =>
                sum +
                (e.kind === "straight"
                    ? e.length * t
                    : ((Math.abs(e.angle) * Math.PI) / 180) * t * (e.radius + t / 2)),
            0,
        )
    );
}

/** Developed (flat) length of a strip with the neutral layer at k·t. */
const developed = (elements: Element[], t: number, k: number) =>
    elements.reduce(
        (sum, e) => sum + (e.kind === "straight" ? e.length : bendAllowance(e.angle, e.radius, t, k)),
        0,
    );

/** The Pittsburgh profile as the shop draws it: pocket P, 180° fold leaving a t + c slot, lip H. */
const pittsburghProfile = (
    P: number,
    H: number,
    c: number,
    t: number,
    r: number,
    d: 1 | -1 = 1,
): Element[] => [S(P), B(180 * d, (t + c) / 2), S(P - r - t), B(-90 * d, r), S(H)];

// ================================================================== smBase

describe("smBase — the flat blank", () => {
    test.each([0.5, 0.8, 1.5, 3])("a %s mm blank from a rectangle is one valid plate of area × t", (t) => {
        const doc = newDoc();
        const { body } = sheet(doc, rect(0, 0, 250, 120), { t, r: 2, k: 0.4 });
        expect(errors(body)).toEqual([undefined]);
        const shape = body.shape.value;
        expect(shape.volume()).toBeCloseTo(250 * 120 * t, 6);
        expectBox(vertexBox(shape), { min: [0, 0, 0], max: [250, 120, t] });
        expect(solids(shape)).toBe(1);
        expect(shape.checkShape()).toBe(true);
        const model = sheetModelOf(shape)!;
        expect([model.thickness, model.radius, model.kFactor, model.flat]).toEqual([t, 2, 0.4, false]);
        expect(model.blank).toHaveLength(1);
        expect(model.blank[0].map((segment) => segment.kind)).toEqual(["line", "line", "line", "line"]);
    });

    test("an empty bend radius and K-factor fall back to the thickness and 0.44", () => {
        const doc = newDoc();
        const sketch = addSketch(doc, rect(0, 0, 100, 50));
        const body = new ParametricBodyNode({
            document: doc,
            features: [
                { id: "base", type: "smBase", sketchId: sketch.id, thickness: 1.2, radius: "", kFactor: "" },
            ],
        });
        doc.modelManager.addNode(body);
        const model = sheetModelOf(body.shape.value)!;
        expect(model.radius).toBe(1.2);
        expect(model.kFactor).toBe(0.44);
    });

    test("a blank with a round hole keeps the hole: (area − πR²) × t", () => {
        const doc = newDoc();
        const data = rect(0, 0, 200, 100);
        data.entities.push({ id: 5, type: "circle", params: [60, 50, 15] });
        const { body } = sheet(doc, data, { t: 1.5 });
        expect(errors(body)).toEqual([undefined]);
        expect(body.shape.value.volume()).toBeCloseTo((200 * 100 - Math.PI * 15 ** 2) * 1.5, 4);
        const model = sheetModelOf(body.shape.value)!;
        expect(model.blank).toHaveLength(2);
        expect(model.blank[1].map((segment) => segment.kind)).toEqual(["arc", "arc"]);
    });

    test("an L-shaped blank is the polygon area × t", () => {
        const doc = newDoc();
        const { body } = sheet(
            doc,
            polygon([
                [0, 0],
                [150, 0],
                [150, 40],
                [50, 40],
                [50, 120],
                [0, 120],
            ]),
            { t: 2 },
        );
        expect(errors(body)).toEqual([undefined]);
        expect(body.shape.value.volume()).toBeCloseTo((150 * 40 + 50 * 80) * 2, 6);
    });

    test("a blank sketched on a vertical plane lies in that plane, the thickness along its normal", () => {
        const doc = newDoc();
        const { body } = sheet(doc, rect(0, 0, 80, 60), { t: 1.2, plane: Plane.YZ });
        expectBox(vertexBox(body.shape.value), { min: [0, 0, 0], max: [1.2, 80, 60] });
    });

    test.each([
        ["thickness", 0, /Thickness must be positive/],
        ["thickness", -1, /Thickness must be positive/],
        ["radius", -2, /Bend radius must be positive/],
        ["kFactor", 1.5, /K-factor must be between 0 and 1/],
        ["kFactor", -0.1, /K-factor must be between 0 and 1/],
    ] as const)("%s = %s is rejected", (key, value, message) => {
        const doc = newDoc();
        const { body } = sheet(doc, rect(0, 0, 100, 50));
        edit(doc, body, "base", key, value);
        expect(body.featureItems()[0].error).toMatch(message);
    });

    test("Sheet Metal must be the body's first feature", () => {
        const doc = newDoc();
        const { body, sketch } = sheet(doc, rect(0, 0, 100, 50));
        add(doc, body, {
            id: "base2",
            type: "smBase",
            sketchId: sketch.id,
            thickness: 1,
            radius: 1,
            kFactor: 0.5,
        });
        expect(body.featureItems()[1].error).toMatch(/must be the body's first feature/);
    });
});

// ================================================================== smBend

describe("smBend — bend lines", () => {
    const W = 200;
    const H = 100;
    const b = 120;

    test.each([
        [90, "up", 0.5],
        [45, "up", 0.5],
        [135, "up", 0.5],
        [90, "down", 0.5],
        [45, "down", 0.44],
        [135, "down", 0.44],
        [90, "up", 0.33],
        [30, "up", 0.44],
    ] as const)("a %s° %s bend (k = %s) folds the far flange to its analytic place", (angle, direction, k) => {
        const t = 1;
        const r = 2;
        const doc = newDoc();
        const { body } = sheet(doc, rect(0, 0, W, H), { t, r, k });
        add(doc, body, bend("bend", bendLines(doc, [b], H), angle, direction));
        expect(errors(body)).toEqual([undefined, undefined]);
        const shape = body.shape.value;
        const ba = bendAllowance(angle, r, t, k);
        // The larger (left) facet stays put; the far flange folds about the bend.
        const profile = [S(b - ba / 2), B(direction === "up" ? angle : -angle, r), S(W - b - ba / 2)];
        expectBox(vertexBox(shape), walkedBox(walk(profile, t), 0, H));
        // Volume: exact flat volume at k = 0.5; otherwise the neutral layer's shift, θ·t²·(0.5 − k)·H.
        expect(shape.volume()).toBeCloseTo(formedVolume(profile, t, H), 4);
        expect(shape.volume() - W * H * t).toBeCloseTo(((angle * Math.PI) / 180) * t * t * (0.5 - k) * H, 4);
        expect(solids(shape)).toBe(1);
        expect(shape.checkShape()).toBe(true);
    });

    test("bend deduction: the outside flange lengths add up to the flat length plus BD", () => {
        const t = 1.2;
        const r = 3;
        const k = 0.44;
        const doc = newDoc();
        const { body } = sheet(doc, rect(0, 0, W, H), { t, r, k });
        add(doc, body, bend("bend", bendLines(doc, [b], H), 90, "up"));
        const box = vertexBox(body.shape.value);
        const ba = bendAllowance(90, r, t, k);
        const bd = 2 * (r + t) - ba; // 2 × outside setback − bend allowance
        const outsideA = box.max[0] - box.min[0];
        const outsideB = box.max[2] - box.min[2];
        expect(outsideA + outsideB).toBeCloseTo(W + bd, 6);
        expect(outsideA).toBeCloseTo(b - ba / 2 + r + t, 6);
    });

    test("a bend's own radius overrides the part default", () => {
        const doc = newDoc();
        const { body } = sheet(doc, rect(0, 0, W, H), { t: 1, r: 1, k: 0.5 });
        add(doc, body, bend("bend", bendLines(doc, [b], H), 90, "up", 6));
        const ba = bendAllowance(90, 6, 1, 0.5);
        const profile = [S(b - ba / 2), B(90, 6), S(W - b - ba / 2)];
        expectBox(vertexBox(body.shape.value), walkedBox(walk(profile, 1), 0, H));
        expect(sheetModelOf(body.shape.value)?.bends.map((x) => x.radius)).toEqual([6]);
    });

    test("three bend lines in one feature fold in series from the largest facet", () => {
        const t = 1;
        const r = 1;
        const doc = newDoc();
        // The fourth side stops short of the base (a longer one would run into it).
        const { body } = sheet(doc, rect(0, 0, 290, 80), { t, r, k: 0.5 });
        add(doc, body, bend("bends", bendLines(doc, [150, 200, 250], 80), 90, "up"));
        expect(errors(body)).toEqual([undefined, undefined]);
        const ba = bendAllowance(90, r, t, 0.5);
        const profile = [
            S(150 - ba / 2),
            B(90, r),
            S(50 - ba),
            B(90, r),
            S(50 - ba),
            B(90, r),
            S(40 - ba / 2),
        ];
        expectBox(vertexBox(body.shape.value), walkedBox(walk(profile, t), 0, 80));
        expect(body.shape.value.volume()).toBeCloseTo(290 * 80 * t, 4);
        expect(solids(body.shape.value)).toBe(1);
    });

    test("bend features compose: a 90° up bend, then a 45° down bend further out", () => {
        const t = 1;
        const r = 1.5;
        const doc = newDoc();
        const { body } = sheet(doc, rect(0, 0, 300, 80), { t, r, k: 0.5 });
        add(doc, body, bend("b1", bendLines(doc, [180], 80), 90, "up"));
        add(doc, body, bend("b2", bendLines(doc, [250], 80), 45, "down"));
        expect(errors(body)).toEqual([undefined, undefined, undefined]);
        const ba90 = bendAllowance(90, r, t, 0.5);
        const ba45 = bendAllowance(45, r, t, 0.5);
        const profile = [
            S(180 - ba90 / 2),
            B(90, r),
            S(70 - ba90 / 2 - ba45 / 2),
            B(-45, r),
            S(50 - ba45 / 2),
        ];
        expectBox(vertexBox(body.shape.value), walkedBox(walk(profile, t), 0, 80));
        expect(body.shape.value.volume()).toBeCloseTo(300 * 80 * t, 4);
    });

    test("a diagonal bend line keeps the volume (no bend material beyond the blank outline)", () => {
        const doc = newDoc();
        const { body } = sheet(doc, rect(0, 0, W, H), { t: 1, r: 1, k: 0.5 });
        add(
            doc,
            body,
            bend(
                "bend",
                sketchLines(doc, [
                    [
                        [130, -10],
                        [160, 110],
                    ],
                ]),
                60,
                "up",
            ),
        );
        expect(errors(body)).toEqual([undefined, undefined]);
        expect(body.shape.value.volume()).toBeCloseTo(W * H, 3);
        expect(body.shape.value.checkShape()).toBe(true);
    });

    test.each([0, 180, 200, -30])("a %s° bend angle is rejected", (angle) => {
        const doc = newDoc();
        const { body } = sheet(doc, rect(0, 0, W, H));
        add(doc, body, bend("bend", bendLines(doc, [b], H), angle, "up"));
        expect(body.featureItems()[1].error).toMatch(/between 0° and 180°/);
    });

    test("crossing bend lines are rejected", () => {
        const doc = newDoc();
        const { body } = sheet(doc, rect(0, 0, W, H));
        add(
            doc,
            body,
            bend(
                "bend",
                sketchLines(doc, [
                    [
                        [100, -10],
                        [100, 110],
                    ],
                    [
                        [-10, 50],
                        [210, 50],
                    ],
                ]),
                90,
                "up",
            ),
        );
        expect(body.featureItems()[1].error).toMatch(/must not cross/);
    });

    test("a bend line along the blank's edge is rejected", () => {
        const doc = newDoc();
        const { body } = sheet(doc, rect(0, 0, W, H));
        add(doc, body, bend("bend", bendLines(doc, [W], H), 90, "up"));
        expect(body.featureItems()[1].error).toMatch(/run fully across the sheet/);
    });

    test("a bend line that misses the sheet is reported, not silently ignored", () => {
        const doc = newDoc();
        const { body } = sheet(doc, rect(0, 0, W, H));
        add(doc, body, bend("bend", bendLines(doc, [W + 50], H), 90, "up"));
        expect(body.featureItems()[1].error).toMatch(/across the sheet/);
    });

    test("a bend line through a hole keeps the bend sectors on both sides of the hole", () => {
        const doc = newDoc();
        const data = rect(0, 0, W, H);
        data.entities.push({ id: 5, type: "circle", params: [100, 50, 10] });
        const { body } = sheet(doc, data, { t: 1, r: 1, k: 0.5 });
        add(doc, body, bend("bend", bendLines(doc, [100], H), 90, "up"));
        expect(errors(body)).toEqual([undefined, undefined]);
        // k = 0.5: forming conserves the material, holes included (one missing sector would be ~94 mm³;
        // the rectangular bend ends against the hole's arcs overfill by ~0.1 mm³ each).
        const expected = W * H - Math.PI * 100;
        expect(Math.abs(body.shape.value.volume() - expected) / expected).toBeLessThan(1e-4);
    });

    test("a rolled sheet cannot also take bend lines", () => {
        const doc = newDoc();
        const { body } = sheet(doc, rect(0, 0, 2 * Math.PI * 30.5, 60));
        add(doc, body, { id: "roll", type: "smRoll", axis: "v", radius: 0, direction: "up" });
        add(doc, body, bend("bend", bendLines(doc, [50], 60), 90, "up"));
        expect(body.featureItems()[2].error).toMatch(/rolled sheet cannot also have bend lines/);
    });
});

// ================================================================== smEdge

describe("smEdge — edge treatments", () => {
    const W = 200;
    const H = 100;

    type Kind = "easyEdge" | "pittsburgh" | "hem" | "flange";
    interface Case {
        readonly kind: Kind;
        readonly direction: "up" | "down";
        readonly length: number;
        readonly angle?: number;
        readonly height?: number;
        readonly clearance?: number;
        readonly profile: (t: number, r: number) => Element[];
    }

    const cases: [string, Case][] = [
        [
            "easy edge up",
            { kind: "easyEdge", direction: "up", length: 6.35, profile: (_t, r) => [B(90, r), S(6.35)] },
        ],
        [
            "easy edge down",
            { kind: "easyEdge", direction: "down", length: 6.35, profile: (_t, r) => [B(-90, r), S(6.35)] },
        ],
        [
            "flange 45° up",
            { kind: "flange", direction: "up", length: 12, angle: 45, profile: (_t, r) => [B(45, r), S(12)] },
        ],
        [
            "flange 135° up",
            {
                kind: "flange",
                direction: "up",
                length: 12,
                angle: 135,
                profile: (_t, r) => [B(135, r), S(12)],
            },
        ],
        [
            "flange 90° down",
            {
                kind: "flange",
                direction: "down",
                length: 20,
                angle: 90,
                profile: (_t, r) => [B(-90, r), S(20)],
            },
        ],
        [
            "Pittsburgh up",
            {
                kind: "pittsburgh",
                direction: "up",
                length: 7.9375,
                height: 9.525,
                clearance: 0.5,
                profile: (t, r) => pittsburghProfile(7.9375, 9.525, 0.5, t, r),
            },
        ],
        [
            "Pittsburgh down",
            {
                kind: "pittsburgh",
                direction: "down",
                length: 7.9375,
                height: 9.525,
                clearance: 0.5,
                profile: (t, r) => pittsburghProfile(7.9375, 9.525, 0.5, t, r, -1),
            },
        ],
    ];

    function treated(c: Case, t: number, r: number, k: number) {
        const doc = newDoc();
        const { body } = sheet(doc, rect(0, 0, W, H), { t, r, k });
        add(doc, body, {
            id: "edge",
            type: "smEdge",
            kind: c.kind,
            edges: [edgeNear(body, [W, H / 2, 0])],
            direction: c.direction,
            length: c.length,
            ...(c.angle === undefined ? {} : { angle: c.angle }),
            ...(c.height === undefined ? {} : { height: c.height }),
            ...(c.clearance === undefined ? {} : { clearance: c.clearance }),
        });
        return { doc, body };
    }

    test.each(cases)("%s: the formed section matches the profile walker", (_name, c) => {
        const t = 0.8;
        const r = 1.2;
        const { body } = treated(c, t, r, 0.5);
        expect(errors(body)).toEqual([undefined, undefined]);
        const shape = body.shape.value;
        expect(solids(shape)).toBe(1);
        expect(shape.checkShape()).toBe(true);
        const corners = walk(c.profile(t, r), t);
        const blank: P2[] = [
            [0, 0],
            [0, t],
        ];
        expectBox(vertexBox(shape), walkedBox(corners, 0, H, W, blank));
        // k = 0.5: the formed material equals the developed strip plus the blank.
        expect(shape.volume()).toBeCloseTo(W * H * t + formedVolume(c.profile(t, r), t, H), 3);
    });

    test.each(cases)("%s: Flatten develops the strip with the K-factor", (_name, c) => {
        const t = 0.8;
        const r = 1.2;
        const k = 0.38;
        const { doc, body } = treated(c, t, r, k);
        add(doc, body, { id: "flat", type: "smFlatten" });
        expect(errors(body)).toEqual([undefined, undefined, undefined]);
        const flat = body.shape.value;
        const width = W + developed(c.profile(t, r), t, k);
        expectBox(vertexBox(flat), { min: [0, 0, 0], max: [width, H, t] });
        expect(totalVolume(flat)).toBeCloseTo(width * H * t, 4);
    });

    test("a hem is closed: the folded layer lies on the sheet (two thicknesses)", () => {
        const t = 1;
        const doc = newDoc();
        const { body } = sheet(doc, rect(0, 0, W, H), { t, r: 1, k: 0.5 });
        add(doc, body, {
            id: "hem",
            type: "smEdge",
            kind: "hem",
            edges: [edgeNear(body, [W, H / 2, 0])],
            direction: "up",
            length: 12,
        });
        expect(errors(body)).toEqual([undefined, undefined]);
        // treatments.ts: "A closed hem: the fold's inner radius is half a thickness, so the two layers touch."
        expect(vertexBox(body.shape.value).max[2]).toBeCloseTo(2 * t, 2);
        expect(
            regionVolume(body.shape.value, [W - 11, 0, t + 0.05], [W - 1, H, 2 * t - 0.05]),
        ).toBeGreaterThan(0.8 * 10 * H * (t - 0.1));
    });

    test("Pittsburgh pocket: a slot one sheet plus clearance wide, the pocket depth, the lip above it", () => {
        const t = 0.7;
        const r = 1;
        const c = Math.max(0.25, t / 2); // the handler's default clearance
        const P = DEFAULTS.pocketDepth;
        const lip = DEFAULTS.lipHeight;
        const doc = newDoc();
        const { body } = sheet(doc, rect(0, 0, W, H), { t, r, k: 0.5 });
        add(doc, body, {
            id: "pocket",
            type: "smEdge",
            kind: "pittsburgh",
            edges: [edgeNear(body, [W, H / 2, 0])],
            direction: "up",
            length: P,
            height: lip,
        });
        expect(errors(body)).toEqual([undefined, undefined]);
        const shape = body.shape.value;
        const x0 = W + r + t + 0.05; // clear of the lip bend
        const x1 = W + P - 0.05; // clear of the fold
        const span = (x1 - x0) * H;
        // The slot between the layers is empty and exactly t + c high.
        expect(regionVolume(shape, [x0, 0, t + 1e-3], [x1, H, 2 * t + c - 1e-3])).toBeCloseTo(0, 6);
        expect(regionVolume(shape, [x0, 0, 2 * t + c], [x1, H, 3 * t + c])).toBeCloseTo(span * t, 4);
        expect(regionVolume(shape, [x0, 0, 0], [x1, H, t])).toBeCloseTo(span * t, 4);
        expect(regionVolume(shape, [x0, 0, 3 * t + c + 1e-3], [x1, H, 3 * t + c + 20])).toBeCloseTo(0, 6);
        // The lip stands over the blank edge, lip-height tall above its bend.
        const lipBase = 3 * t + c + r;
        expect(regionVolume(shape, [W - 1, 0, lipBase], [W + t + 1, H, lipBase + lip + 1])).toBeCloseTo(
            t * lip * H,
            4,
        );
        expect(sheetModelOf(shape)?.flanges[0].seamDepth).toBeCloseTo(P, 9);
    });

    test("a Pittsburgh pocket too shallow for the lip radius is rejected", () => {
        const doc = newDoc();
        const { body } = sheet(doc, rect(0, 0, W, H), { t: 1, r: 2 });
        add(doc, body, {
            id: "pocket",
            type: "smEdge",
            kind: "pittsburgh",
            edges: [edgeNear(body, [W, H / 2, 0])],
            direction: "up",
            length: 2.5,
        });
        expect(body.featureItems()[1].error).toMatch(/pocket depth is too small/);
    });

    test("parameters take expressions: a 25.4 / 4 easy edge on a 0.03 * 25.4 sheet", () => {
        const doc = newDoc();
        const { body } = sheet(doc, rect(0, 0, W, H), { t: 1, r: 1, k: 0.5 });
        edit(doc, body, "base", "thickness", "0.03 * 25.4");
        add(doc, body, {
            id: "easy",
            type: "smEdge",
            kind: "easyEdge",
            edges: [edgeNear(body, [W, H / 2, 0])],
            direction: "up",
            length: "25.4 / 4",
        });
        expect(errors(body)).toEqual([undefined, undefined]);
        const t = 0.03 * INCH;
        expect(sheetModelOf(body.shape.value)?.thickness).toBeCloseTo(t, 9);
        expect(vertexBox(body.shape.value).max[2]).toBeCloseTo(t + 1 + INCH / 4, 6);
    });

    test("one edge takes one treatment", () => {
        const doc = newDoc();
        const { body } = sheet(doc, rect(0, 0, W, H));
        const edge = edgeNear(body, [W, H / 2, 0]);
        add(doc, body, { id: "e1", type: "smEdge", kind: "hem", edges: [edge], direction: "up", length: 10 });
        add(doc, body, { id: "e2", type: "smEdge", kind: "hem", edges: [edge], direction: "up", length: 10 });
        expect(errors(body)[1]).toBeUndefined();
        expect(errors(body)[2]).toMatch(/not a straight outline edge/);
    });

    test("one feature treats several edges", () => {
        const doc = newDoc();
        const t = 1;
        const { body } = sheet(doc, rect(0, 0, W, H), { t, r: 1, k: 0.5 });
        add(doc, body, {
            id: "flanges",
            type: "smEdge",
            kind: "flange",
            edges: [
                edgeNear(body, [W, H / 2, 0]),
                edgeNear(body, [0, H / 2, 0]),
                edgeNear(body, [W / 2, H, 0]),
            ],
            direction: "up",
            length: 15,
            angle: 90,
        });
        expect(errors(body)).toEqual([undefined, undefined]);
        const strip = formedVolume([B(90, 1), S(15)], t, 1);
        expect(body.shape.value.volume()).toBeCloseTo(W * H * t + strip * (2 * H + W), 3);
        expect(sheetModelOf(body.shape.value)?.flanges).toHaveLength(3);
    });

    test("an edge treatment on a blank edge that crosses a bend line is not built straight across the bend", () => {
        const doc = newDoc();
        const { body } = sheet(doc, rect(0, 0, 300, H), { t: 1, r: 1, k: 0.5 });
        add(doc, body, bend("bend", bendLines(doc, [280], H), 90, "up"));
        // The user clicks the bottom edge of the big flat facet; it belongs to the blank edge y = 0,
        // which runs on past the bend into the (now vertical) end flange.
        add(doc, body, {
            id: "flange",
            type: "smEdge",
            kind: "flange",
            edges: [edgeNear(body, [140, 0, 0])],
            direction: "down",
            length: 10,
            angle: 90,
        });
        // Either rejected, or confined to the flat facet: never material out where the sheet bent away.
        const shape = body.shape;
        const stray = shape.isOk ? regionVolume(shape.value, [285, -30, -30], [305, 1, 5]) : 0;
        expect(stray).toBeCloseTo(0, 6);
    });
});

// ================================================================== Pittsburgh seam fit

describe("Pittsburgh seam — easy edge into pocket", () => {
    const t = 0.7;
    const r = 1;
    const c = Math.max(0.25, t / 2);
    const fold = (t + c) / 2;
    const P = DEFAULTS.pocketDepth;
    const lip = DEFAULTS.lipHeight;
    const H = 100;

    /** Panel A (flat, XY) with the pocket on its x = 0 edge, opening back over the panel. */
    function pocketPanel(doc: TestDocument, pocket = P) {
        const { body } = sheet(doc, rect(0, 0, 300, H), { t, r, k: 0.5 });
        add(doc, body, {
            id: "pocket",
            type: "smEdge",
            kind: "pittsburgh",
            edges: [edgeNear(body, [0, H / 2, 0])],
            direction: "up",
            length: pocket,
            height: lip,
        });
        expect(errors(body)).toEqual([undefined, undefined]);
        return body;
    }

    /**
     * Panel B standing on A at the corner (its outside face at x = 0, against the lip), its easy
     * edge turned outward (−x) and resting on A, the way the seam is assembled.
     */
    function easyEdgePanel(doc: TestDocument, leg: number) {
        const bottom = 2 * t + r;
        const { body } = sheet(doc, rect(0, bottom, H, bottom + 150), { t, r, k: 0.5, plane: Plane.YZ });
        add(doc, body, {
            id: "easy",
            type: "smEdge",
            kind: "easyEdge",
            edges: [edgeNear(body, [0, H / 2, bottom])],
            direction: "down",
            length: leg,
        });
        expect(errors(body)).toEqual([undefined, undefined]);
        return body;
    }

    test('the default 1/4" easy edge fits the default 5/16" pocket of a mating panel without interference', () => {
        const doc = newDoc();
        const a = pocketPanel(doc);
        const b = easyEdgePanel(doc, DEFAULTS.easyEdgeLength);
        expect(DEFAULTS.easyEdgeLength).toBeCloseTo(INCH / 4, 9);
        expect(interference(a.shape.value, b.shape.value)).toBeCloseTo(0, 6);
        // The leg lies in the slot: resting on the panel, reaching r + leg past the pocket's edge...
        const leg = vertexBox(b.shape.value);
        const tip = -(r + DEFAULTS.easyEdgeLength);
        expect(leg.min[2]).toBeCloseTo(t, 6);
        expect(leg.min[0]).toBeCloseTo(tip, 6);
        const pocket = a.shape.value;
        // ...under the folded layer, which covers it from the lip bend to the leg's tip...
        expect(regionVolume(pocket, [tip, 0, 2 * t + c], [-(r + t) - 0.05, H, 3 * t + c])).toBeCloseTo(
            (-(r + t) - 0.05 - tip) * H * t,
            4,
        );
        // ...and short of the fold: the slot runs on, open, from the tip to where the fold begins.
        expect(regionVolume(pocket, [-P + 1e-3, 0, t + 1e-3], [tip, H, 2 * t + c - 1e-3])).toBeCloseTo(0, 6);
    });

    test("control: a leg reaching past the fold collides with the pocket", () => {
        const doc = newDoc();
        const a = pocketPanel(doc);
        const b = easyEdgePanel(doc, P + fold - r + 0.4);
        expect(interference(a.shape.value, b.shape.value)).toBeGreaterThan(0.01);
    });

    /**
     * A one-piece wrapper: four sides with three 90° up bends, the pocket on the start edge
     * and the easy edge (down) on the end edge closing the fourth corner. Inner size wi × hi.
     */
    function wrapper(doc: TestDocument, leg: number, wi = 300, hi = 200) {
        const ba = bendAllowance(90, r, t, 0.5);
        const u1 = wi + t - r + ba / 2;
        const u2 = u1 + (hi - 2 * r) + ba;
        const u3 = u2 + (wi - 2 * r) + ba;
        const end = u3 + ba / 2 + hi - 2 * r - t;
        const { body } = sheet(doc, rect(0, 0, end, H), { t, r, k: 0.5 });
        add(doc, body, bend("bends", bendLines(doc, [u1, u2, u3], H), 90, "up"));
        add(doc, body, {
            id: "pocket",
            type: "smEdge",
            kind: "pittsburgh",
            edges: [edgeNear(body, formedImage(body, [0, 0], [0, H]))],
            direction: "up",
            length: P,
            height: lip,
        });
        add(doc, body, {
            id: "easy",
            type: "smEdge",
            kind: "easyEdge",
            edges: [edgeNear(body, formedImage(body, [end, 0], [end, H]))],
            direction: "down",
            length: leg,
        });
        const pocketStrip = pittsburghProfile(P, lip, c, t, r);
        const easyStrip = [B(-90, r), S(leg)];
        const developedArea = (end + developed(pocketStrip, t, 0.5) + developed(easyStrip, t, 0.5)) * H;
        return { body, end, developedArea, pocketStrip, easyStrip, wi, hi };
    }

    test("one-piece wrapper: the seam-fit check flags an easy edge that collides with the pocket", () => {
        const doc = newDoc();
        // seamFit only compares the straight leg with the pocket depth: a leg equal to the pocket passes.
        const { body, developedArea } = wrapper(doc, P);
        expect(errors(body)).toEqual([undefined, undefined, undefined, undefined]);
        const lost = developedArea * t - body.shape.value.volume();
        // The formed easy edge overlaps the pocket's fold (the fused part lost material)...
        expect(lost).toBeGreaterThan(0.01);
        // ...so the seam does not fit and the feature should say so.
        expect(warnings(body)[3]).toMatch(/Pittsburgh pocket/);
    });
});

// ================================================================== smRoll

describe("smRoll — round duct", () => {
    test.each([0.5, 0.44, 0.3])("radius 0 closes the blank into a full cylinder (k = %s)", (k) => {
        const t = 1;
        const width = 2 * Math.PI * 60;
        const L = 200;
        const doc = newDoc();
        const { body } = sheet(doc, rect(0, 0, width, L), { t, k });
        add(doc, body, { id: "roll", type: "smRoll", axis: "v", radius: 0, direction: "up" });
        expect(errors(body)).toEqual([undefined, undefined]);
        const shape = body.shape.value;
        const ri = width / (2 * Math.PI) - k * t; // the neutral layer carries the blank width
        expect(shape.volume()).toBeCloseTo(Math.PI * ((ri + t) ** 2 - ri ** 2) * L, 3);
        expect(solids(shape)).toBe(1);
        expect(shape.checkShape()).toBe(true);
        // The start edge stays put; the axis sits t + ri above it (mesh bounds: within the chord sag).
        const box = shape.boundingBox();
        expect(box.min.y).toBeCloseTo(0, 6);
        expect(box.max.y).toBeCloseTo(L, 6);
        expect(Math.abs(box.min.z)).toBeLessThan(0.2);
        expect(Math.abs(box.max.z - 2 * (ri + t))).toBeLessThan(0.2);
        expect(Math.abs(box.max.x - box.min.x - 2 * (ri + t))).toBeLessThan(0.2);
        // Material sits exactly between ri and ri + t around the axis.
        expect(annulusPart(shape, [0, t + ri], ri + 1e-3, ri + t - 1e-3, 0, L).volume()).toBeCloseTo(
            Math.PI * ((ri + t - 1e-3) ** 2 - (ri + 1e-3) ** 2) * L,
            2,
        );
    });

    test("a partial roll curls by width / neutral radius; the end edge lands on the arc", () => {
        const t = 1;
        const k = 0.44;
        const ri = 40;
        const doc = newDoc();
        const { body } = sheet(doc, rect(0, 0, 100, 50), { t, k });
        add(doc, body, { id: "roll", type: "smRoll", axis: "v", radius: ri, direction: "up" });
        expect(errors(body)).toEqual([undefined, undefined]);
        const theta = 100 / (ri + k * t);
        const shape = body.shape.value;
        expect(shape.volume()).toBeCloseTo((theta / 2) * ((ri + t) ** 2 - ri ** 2) * 50, 3);
        // Axis at (x = 0, z = t + ri); the end edge rotated by θ toward +z.
        const axisZ = t + ri;
        const end: P2[] = [
            [(t + ri) * Math.sin(theta), axisZ - (t + ri) * Math.cos(theta)],
            [ri * Math.sin(theta), axisZ - ri * Math.cos(theta)],
        ];
        const start: P2[] = [
            [0, 0],
            [0, t],
        ];
        expectBox(vertexBox(shape), walkedBox([...start, ...end], 0, 50));
    });

    test("axis u rolls around x: the duct runs along the blank's x extent", () => {
        const t = 1;
        const circumference = 2 * Math.PI * 40.5;
        const doc = newDoc();
        const { body } = sheet(doc, rect(0, 0, 150, circumference), { t, k: 0.5 });
        add(doc, body, { id: "roll", type: "smRoll", axis: "u", radius: 0, direction: "up" });
        expect(errors(body)).toEqual([undefined, undefined]);
        const box = body.shape.value.boundingBox();
        expect(box.min.x).toBeCloseTo(0, 6);
        expect(box.max.x).toBeCloseTo(150, 6);
        expect(box.max.y - box.min.y).toBeCloseTo(2 * 41, 1);
        expect(body.shape.value.volume()).toBeCloseTo(Math.PI * (41 ** 2 - 40 ** 2) * 150, 3);
    });

    test("direction down curls the duct below the sheet", () => {
        const t = 1;
        const doc = newDoc();
        const { body } = sheet(doc, rect(0, 0, 2 * Math.PI * 50.5, 100), { t, k: 0.5 });
        add(doc, body, { id: "roll", type: "smRoll", axis: "v", radius: 0, direction: "down" });
        const box = body.shape.value.boundingBox();
        expect(Math.abs(box.max.z - t)).toBeLessThan(0.2);
        expect(Math.abs(box.min.z - (t - 2 * 51))).toBeLessThan(0.2);
        expect(annulusPart(body.shape.value, [0, -50], 50 + 1e-3, 51 - 1e-3, 0, 100).volume()).toBeCloseTo(
            Math.PI * ((51 - 1e-3) ** 2 - (50 + 1e-3) ** 2) * 100,
            2,
        );
    });

    test.each([
        ["a radius too small for the blank", rect(0, 0, 300, 50), 10, /wider than the roll's circumference/],
        ["a negative radius", rect(0, 0, 300, 50), -5, /cannot be negative/],
        [
            "a non-rectangular blank",
            polygon([
                [0, 0],
                [100, 0],
                [100, 40],
                [50, 40],
                [50, 80],
                [0, 80],
            ]),
            0,
            /rectangular blank/,
        ],
    ] as const)("%s is rejected", (_name, data, radius, message) => {
        const doc = newDoc();
        const { body } = sheet(doc, data as SketchData);
        add(doc, body, { id: "roll", type: "smRoll", axis: "v", radius, direction: "up" });
        expect(body.featureItems()[1].error).toMatch(message);
    });

    test("a partial roll takes seam treatments on its edges parallel to the roll axis", () => {
        const t = 1;
        const L = 200;
        const width = 2 * Math.PI * 100.5;
        const doc = newDoc();
        const { body } = sheet(doc, rect(0, 0, width, L), { t, r: 1, k: 0.5 });
        // A radius a little over the closing one leaves the seam open for the lock.
        add(doc, body, { id: "roll", type: "smRoll", axis: "v", radius: 103, direction: "up" });
        add(doc, body, {
            id: "easy",
            type: "smEdge",
            kind: "easyEdge",
            edges: [edgeNear(body, formedImage(body, [0, 0], [0, L]))],
            direction: "up",
            length: 6.35,
        });
        add(doc, body, {
            id: "pocket",
            type: "smEdge",
            kind: "pittsburgh",
            edges: [edgeNear(body, formedImage(body, [width, 0], [width, L]))],
            direction: "up",
            length: DEFAULTS.pocketDepth,
            height: DEFAULTS.lipHeight,
            clearance: 0.5,
        });
        expect(errors(body)).toEqual([undefined, undefined, undefined, undefined]);
        const strips =
            developed([B(90, 1), S(6.35)], t, 0.5) +
            developed(pittsburghProfile(DEFAULTS.pocketDepth, DEFAULTS.lipHeight, 0.5, t, 1), t, 0.5);
        expect(body.shape.value.volume()).toBeCloseTo((width + strips) * L * t, 2);
        expect(solids(body.shape.value)).toBe(1);
        expect(sheetModelOf(body.shape.value)?.flanges.map((f) => f.kind)).toEqual([
            "easyEdge",
            "pittsburgh",
        ]);
    });

    test("a sheet rolls once", () => {
        const doc = newDoc();
        const { body } = sheet(doc, rect(0, 0, 2 * Math.PI * 30.5, 60));
        add(doc, body, { id: "roll", type: "smRoll", axis: "v", radius: 0, direction: "up" });
        add(doc, body, { id: "roll2", type: "smRoll", axis: "v", radius: 0, direction: "up" });
        expect(body.featureItems()[2].error).toMatch(/already rolled/);
    });
});

// ================================================================== smCrimp / smBead

describe("smCrimp and smBead", () => {
    const t = 1;
    const ri = 100;
    const ro = ri + t;
    const L = 500;
    const circumference = 2 * Math.PI * (ri + 0.5 * t);
    const axis: P2 = [0, t + ri];

    function duct(doc: TestDocument) {
        const { body } = sheet(doc, rect(0, 0, circumference, L), { t, k: 0.5 });
        add(doc, body, { id: "roll", type: "smRoll", axis: "v", radius: 0, direction: "up" });
        return body;
    }

    /** The largest radius of material about the duct axis over y ∈ [y0, y1] (bisection on annulus volumes). */
    function maxRadius(shape: IShape, y0: number, y1: number): number {
        let lo = ri - 10;
        let hi = ro + 10;
        for (let i = 0; i < 16; i++) {
            const mid = (lo + hi) / 2;
            if (annulusPart(shape, axis, mid, ro + 20, y0, y1).volume() > 1e-9) lo = mid;
            else hi = mid;
        }
        return (lo + hi) / 2;
    }

    test("a crimp corrugates its end: `count` flutes `depth` deep over `length`, the rest a plain shell", () => {
        const doc = newDoc();
        const body = duct(doc);
        const length = 38;
        const depth = 1.5;
        const count = 36;
        add(doc, body, { id: "crimp", type: "smCrimp", end: "end", length, depth, count });
        expect(errors(body)).toEqual([undefined, undefined, undefined]);
        const shape = body.shape.value;
        expect(shape.checkShape()).toBe(true);
        expect(solids(shape)).toBe(1);
        const y0 = L - length + 0.5;
        const y1 = L - 0.5;
        const crest = maxRadius(shape, y0, y1);
        // The flutes reach `depth` in from the crest, the sheet a thickness under them.
        expect(annulusPart(shape, axis, 0, crest - depth - t - 1e-3, y0, y1).volume()).toBeCloseTo(0, 6);
        expect(annulusPart(shape, axis, 0, crest - depth - t + 0.2, y0, y1).volume()).toBeGreaterThan(0.1);
        // Above mid-depth the crimp is `count` separate ridges.
        expect(solids(annulusPart(shape, axis, crest - depth / 2, crest + 1, y0, y1))).toBe(count);
        // A corrugated ring of radial thickness t: ∫(t·R − t²/2)dφ = 2πt(crest − depth/2) − πt².
        const crimpArea = 2 * Math.PI * t * (crest - depth / 2) - Math.PI * t * t;
        expect(regionVolume(shape, [-200, y0, -200], [200, y1, 300]) / (crimpArea * (y1 - y0))).toBeCloseTo(
            1,
            3,
        );
        // The plain part is untouched: exactly ri..ri + t.
        const y2 = L - length - 10;
        expect(annulusPart(shape, axis, 0, ri - 1e-3, 1, y2).volume()).toBeCloseTo(0, 6);
        expect(annulusPart(shape, axis, ro + 1e-3, ro + 10, 1, y2).volume()).toBeCloseTo(0, 6);
        expect(regionVolume(shape, [-200, 1, -200], [200, y2, 300])).toBeCloseTo(
            Math.PI * (ro ** 2 - ri ** 2) * (y2 - 1),
            1,
        );
    });

    test("a crimp at the start end sits at the start", () => {
        const doc = newDoc();
        const body = duct(doc);
        add(doc, body, { id: "crimp", type: "smCrimp", end: "start", length: 40, depth: 2, count: 24 });
        expect(errors(body)).toEqual([undefined, undefined, undefined]);
        const shape = body.shape.value;
        expect(annulusPart(shape, axis, 0, ri - 0.5, 0.5, 39.5).volume()).toBeGreaterThan(0.1);
        expect(annulusPart(shape, axis, 0, ri - 0.5, 45, L - 0.5).volume()).toBeCloseTo(0, 6);
    });

    test("a crimped end slips into the plain end of a duct of the same size", () => {
        const doc = newDoc();
        const body = duct(doc);
        add(doc, body, { id: "crimp", type: "smCrimp", end: "end", length: 38, depth: 1.5, count: 36 });
        // The mating duct's bore is ri: the crimped end must stay inside it.
        const outside = annulusPart(body.shape.value, axis, ri + 1e-3, ro + 5, L - 37.5, L - 0.5).volume();
        expect(outside).toBeCloseTo(0, 3);
    });

    test.each([
        [{ count: 2 }, /at least 3 corrugations/],
        [{ depth: 150 }, /crimp depth must be positive and smaller than the radius/],
        [{ length: 600 }, /longer than the duct/],
    ] as const)("crimp %o is rejected", (override, message) => {
        const doc = newDoc();
        const body = duct(doc);
        add(doc, body, {
            id: "crimp",
            type: "smCrimp",
            end: "end",
            length: 38,
            depth: 1.5,
            count: 36,
            ...override,
        });
        expect(body.featureItems()[2].error).toMatch(message);
    });

    test("an end crimps once, and a partial roll cannot be crimped", () => {
        const doc = newDoc();
        const body = duct(doc);
        add(doc, body, { id: "c1", type: "smCrimp", end: "end", length: 38, depth: 1.5, count: 36 });
        add(doc, body, { id: "c2", type: "smCrimp", end: "end", length: 38, depth: 1.5, count: 36 });
        expect(body.featureItems()[3].error).toMatch(/already crimped/);

        const doc2 = newDoc();
        const { body: partial } = sheet(doc2, rect(0, 0, 100, 100), { t, k: 0.5 });
        add(doc2, partial, { id: "roll", type: "smRoll", axis: "v", radius: 50, direction: "up" });
        add(doc2, partial, { id: "crimp", type: "smCrimp", end: "end", length: 20, depth: 1, count: 12 });
        expect(partial.featureItems()[2].error).toMatch(/fully closed roll/);
    });

    test.each([
        ["out", "end", 1],
        ["in", "end", -1],
        ["out", "start", 1],
    ] as const)("a ring bead (%s, from the %s) stands `height` proud at `offset`", (direction, from, sign) => {
        const width = 8;
        const height = 3;
        const offset = 60;
        const doc = newDoc();
        const body = duct(doc);
        add(doc, body, { id: "bead", type: "smBead", offset, from, width, height, direction });
        expect(errors(body)).toEqual([undefined, undefined, undefined]);
        const shape = body.shape.value;
        expect(shape.checkShape()).toBe(true);
        const center = from === "end" ? L - offset : offset;
        // The bead's footprint on the surface it bulges from (beadSection's geometry).
        const rho = (width * width) / 8 / height + height / 2;
        const footprint = 2 * Math.sqrt((rho + t) ** 2 - (rho + t - height) ** 2);
        // Radial bands (inner, outer) on the side the bead bulges to: past its apex, off the sheet, near the apex.
        const band = (from: number, to: number): [number, number] =>
            sign > 0 ? [ro + from, ro + to] : [Math.max(0, ri - to), ri - from];
        const beyond = annulusPart(shape, axis, ...band(height + 1e-3, 10), 0, L);
        const proud = annulusPart(shape, axis, ...band(1e-3, 10), 0, L);
        const apex = annulusPart(shape, axis, ...band(height - 0.2, 10), 0, L);
        expect(beyond.volume()).toBeCloseTo(0, 6);
        expect(apex.volume()).toBeGreaterThan(0.1);
        const box = proud.boundingBox();
        expect((box.min.y + box.max.y) / 2).toBeCloseTo(center, 1);
        expect(box.max.y - box.min.y).toBeCloseTo(footprint, 0);
    });

    test("a ring bead on the crimp is rejected", () => {
        const doc = newDoc();
        const body = duct(doc);
        add(doc, body, { id: "crimp", type: "smCrimp", end: "end", length: 38, depth: 1.5, count: 36 });
        add(doc, body, {
            id: "bead",
            type: "smBead",
            offset: 20,
            from: "end",
            width: 8,
            height: 3,
            direction: "out",
        });
        expect(body.featureItems()[3].error).toMatch(/plain part of the duct/);
    });

    test("a ring bead needs a rolled sheet; a line bead needs a flat one", () => {
        const doc = newDoc();
        const { body } = sheet(doc, rect(0, 0, 100, 100));
        add(doc, body, {
            id: "bead",
            type: "smBead",
            offset: 20,
            from: "end",
            width: 8,
            height: 3,
            direction: "out",
        });
        expect(body.featureItems()[1].error).toMatch(/ring bead needs a rolled sheet/);

        const rolled = duct(doc);
        const [line] = sketchLines(doc, [
            [
                [10, 10],
                [10, 90],
            ],
        ]);
        add(doc, rolled, { id: "bead", type: "smBead", line, width: 8, height: 3, direction: "out" });
        expect(rolled.featureItems()[2].error).toMatch(/Line beads go on a flat sheet/);
    });

    test.each([
        ["out", 1],
        ["in", -1],
    ] as const)("a line bead (%s) rises `height` along its sketch line, domed at both ends", (direction, sign) => {
        const width = 10;
        const height = 3;
        const doc = newDoc();
        const { body } = sheet(doc, rect(0, 0, 200, 100), { t, k: 0.5 });
        const [line] = sketchLines(doc, [
            [
                [40, 50],
                [160, 50],
            ],
        ]);
        add(doc, body, { id: "bead", type: "smBead", line, width, height, direction });
        expect(errors(body)).toEqual([undefined, undefined]);
        const shape = body.shape.value;
        expect(solids(shape)).toBe(1);
        expect(shape.checkShape()).toBe(true);
        const rho = (width * width) / 8 / height + height / 2;
        const half = Math.sqrt((rho + t) ** 2 - (rho + t - height) ** 2);
        // Material off the sheet only over the bead (line ± footprint/2, domes past the ends).
        const z0 = sign > 0 ? t + 1e-3 : -height - 1;
        const z1 = sign > 0 ? t + height + 1 : -1e-3;
        const off = regionVolume(shape, [-1, -1, z0], [201, 101, z1]);
        const over = regionVolume(
            shape,
            [40 - half - 0.01, 50 - half - 0.01, z0],
            [160 + half + 0.01, 50 + half + 0.01, z1],
        );
        expect(off).toBeGreaterThan(1);
        expect(over).toBeCloseTo(off, 4);
        // It is exactly `height` tall (bulging away from the sheet's surface).
        expect(
            regionVolume(
                shape,
                [-1, -1, sign > 0 ? t + height + 1e-3 : -height - 5],
                [201, 101, sign > 0 ? t + height + 5 : -height - 1e-3],
            ),
        ).toBeCloseTo(0, 6);
        const apex = sign > 0 ? [t + height - 0.05, t + height + 1] : [-height - 1, -height + 0.05];
        expect(regionVolume(shape, [100, 0, apex[0]], [101, 100, apex[1]])).toBeGreaterThan(1e-3);
    });

    test("a line bead rides its facet through a bend; across a bend zone it is rejected", () => {
        const doc = newDoc();
        const { body } = sheet(doc, rect(0, 0, 200, 100), { t, r: 1, k: 0.5 });
        add(doc, body, bend("bend", bendLines(doc, [150], 100), 90, "up"));
        const [onFacet, across] = sketchLines(doc, [
            [
                [20, 50],
                [120, 50],
            ],
            [
                [120, 30],
                [180, 30],
            ],
        ]);
        add(doc, body, { id: "bead", type: "smBead", line: onFacet, width: 10, height: 3, direction: "out" });
        expect(errors(body)).toEqual([undefined, undefined, undefined]);
        add(doc, body, { id: "bead2", type: "smBead", line: across, width: 10, height: 3, direction: "out" });
        expect(body.featureItems()[3].error).toMatch(/one flat region/);
    });
});

// ================================================================== smFlatten

describe("smFlatten — the flat pattern", () => {
    test("after bends the flat pattern is the blank exactly, one mark per bend line", () => {
        const t = 1.2;
        const doc = newDoc();
        const { body } = sheet(doc, rect(0, 0, 300, 200), { t, r: 2, k: 0.44 });
        add(doc, body, bend("b1", bendLines(doc, [80], 200), 45, "down"));
        add(doc, body, bend("b2", bendLines(doc, [220], 200), 90, "up"));
        add(doc, body, { id: "flat", type: "smFlatten" });
        expect(errors(body)).toEqual([undefined, undefined, undefined, undefined]);
        const flat = body.shape.value;
        expectBox(vertexBox(flat), { min: [0, 0, 0], max: [300, 200, t] });
        expect(totalVolume(flat)).toBeCloseTo(300 * 200 * t, 6);
        expect(solids(flat)).toBe(1);
        // The plate's 12 edges plus the two bend marks, on the top face.
        const edges = flat.findSubShapes(ShapeTypes.edge) as IEdge[];
        expect(edges).toHaveLength(14);
        const marks = edges.filter(
            (edge) =>
                Math.abs(edge.length() - 200) < 1e-6 &&
                Math.abs(edge.startPoint().z - t) < 1e-9 &&
                edge.startPoint().x > 1 &&
                edge.startPoint().x < 299,
        );
        expect(marks.map((edge) => Math.round(edge.startPoint().x)).sort((p, q) => p - q)).toEqual([80, 220]);
        expect(sheetModelOf(flat)?.flat).toBe(true);
    });

    test("after edge treatments the flat pattern adds each strip's developed width", () => {
        const t = 0.7;
        const r = 1;
        const k = 0.44;
        const c = Math.max(0.25, t / 2);
        const doc = newDoc();
        const { body } = sheet(doc, rect(0, 0, 200, 100), { t, r, k });
        add(doc, body, {
            id: "pocket",
            type: "smEdge",
            kind: "pittsburgh",
            edges: [edgeNear(body, [0, 50, 0])],
            direction: "up",
            length: DEFAULTS.pocketDepth,
            height: DEFAULTS.lipHeight,
        });
        add(doc, body, {
            id: "easy",
            type: "smEdge",
            kind: "easyEdge",
            edges: [edgeNear(body, [200, 50, 0])],
            direction: "down",
            length: 6.35,
        });
        add(doc, body, {
            id: "hem",
            type: "smEdge",
            kind: "hem",
            edges: [edgeNear(body, [100, 100, 0])],
            direction: "up",
            length: 12,
        });
        add(doc, body, { id: "flat", type: "smFlatten" });
        expect(errors(body)).toEqual([undefined, undefined, undefined, undefined, undefined]);
        const pocket = developed(pittsburghProfile(DEFAULTS.pocketDepth, DEFAULTS.lipHeight, c, t, r), t, k);
        const easy = developed([B(-90, r), S(6.35)], t, k);
        // The hem's fold radius is the treatment's own (see the closed-hem test); develop what the model holds.
        const hemElements =
            sheetModelOf(body.shape.value)?.flanges.find((f) => f.kind === "hem")?.elements ?? [];
        expect(hemElements.map((e) => e.kind)).toEqual(["bend", "straight"]);
        const hem = developed(hemElements as Element[], t, k);
        const flat = body.shape.value;
        expectBox(vertexBox(flat), { min: [-pocket, 0, 0], max: [200 + easy, 100 + hem, t] });
        // Flat area = blank + strips (they meet only at the corners).
        expect(totalVolume(flat) / t).toBeCloseTo(200 * 100 + (pocket + easy) * 100 + hem * 200, 3);
        const marks =
            flat.findSubShapes(ShapeTypes.edge).length -
            flat.findSubShapes(ShapeTypes.solid)[0].findSubShapes(ShapeTypes.edge).length;
        expect(marks).toBe(2 + 1 + 1);
    });

    test("after roll, crimp and bead the flat pattern is the rectangle with crimp and bead lines", () => {
        const circumference = 2 * Math.PI * 100.5;
        const doc = newDoc();
        const { body } = sheet(doc, rect(0, 0, circumference, 500), { t: 1, k: 0.5 });
        add(doc, body, { id: "roll", type: "smRoll", axis: "v", radius: 0, direction: "up" });
        add(doc, body, { id: "crimp", type: "smCrimp", end: "end", length: 38, depth: 1.5, count: 36 });
        add(doc, body, {
            id: "bead",
            type: "smBead",
            offset: 60,
            from: "end",
            width: 8,
            height: 3,
            direction: "out",
        });
        add(doc, body, { id: "flat", type: "smFlatten" });
        expect(errors(body)).toEqual([undefined, undefined, undefined, undefined, undefined]);
        const flat = body.shape.value;
        expectBox(vertexBox(flat), { min: [0, 0, 0], max: [circumference, 500, 1] });
        expect(totalVolume(flat)).toBeCloseTo(circumference * 500, 4);
        const marks = (flat.findSubShapes(ShapeTypes.edge) as IEdge[]).filter(
            (edge) => Math.abs(edge.startPoint().y - edge.endPoint().y) < 1e-9 && edge.startPoint().z > 0.5,
        );
        const across = marks
            .map((edge) => Number(edge.startPoint().y.toFixed(6)))
            .filter((y) => y > 1 && y < 499);
        expect(across.sort((p, q) => p - q)).toEqual([440, 462]);
    });

    test("sheet metal features after Flatten are rejected; removing Flatten re-forms the part", () => {
        const doc = newDoc();
        const { body } = sheet(doc, rect(0, 0, 200, 100), { t: 1, r: 1, k: 0.5 });
        add(doc, body, bend("bend", bendLines(doc, [120], 100), 90, "up"));
        const formed = vertexBox(body.shape.value);
        add(doc, body, { id: "flat", type: "smFlatten" });
        add(doc, body, {
            id: "hem",
            type: "smEdge",
            kind: "hem",
            edges: [edgeNear(body, [0, 50, 0])],
            direction: "up",
            length: 10,
        });
        expect(body.featureItems()[3].error).toMatch(/must come before Flatten/);
        Transaction.execute(doc, "rm", () => {
            body.removeFeature("hem");
            body.removeFeature("flat");
        });
        expect(errors(body)).toEqual([undefined, undefined]);
        expectBox(vertexBox(body.shape.value), formed);
    });
});

// ================================================================== Re-evaluation

describe("re-evaluation of the sheet metal chain", () => {
    const W = 200;
    const H = 100;
    const b = 120;

    function bentWithEasyEdge(doc: TestDocument, onMovingFlange: boolean) {
        const { body, sketch } = sheet(doc, rect(0, 0, W, H), { t: 1, r: 1, k: 0.5 });
        add(doc, body, bend("bend", bendLines(doc, [b], H), 90, "up"));
        const edge = onMovingFlange ? formedImage(body, [W, 0], [W, H]) : formedImage(body, [0, 0], [0, H]);
        add(doc, body, {
            id: "easy",
            type: "smEdge",
            kind: "easyEdge",
            edges: [edgeNear(body, edge)],
            direction: "up",
            length: 6.35,
        });
        expect(errors(body)).toEqual([undefined, undefined, undefined]);
        return { body, sketch };
    }

    /** Box of the bent part with an easy edge (up) on the fixed facet's x = 0 edge. */
    function expectedFixedSideBox(t: number, r: number, angle: number, width = W) {
        const ba = bendAllowance(angle, r, t, 0.5);
        const folded = walk([S(b - ba / 2), B(angle, r), S(width - b - ba / 2)], t);
        const easy = walk([B(90, r), S(6.35)], t);
        return walkedBox(
            folded,
            0,
            H,
            0,
            easy.map((p) => [-p[0], p[1]] as P2),
        );
    }

    test("a thickness edit rebuilds the bend and the treatment; undo restores", () => {
        const doc = newDoc();
        const { body } = bentWithEasyEdge(doc, false);
        expectBox(vertexBox(body.shape.value), expectedFixedSideBox(1, 1, 90));
        edit(doc, body, "base", "thickness", 2);
        expect(errors(body)).toEqual([undefined, undefined, undefined]);
        expectBox(vertexBox(body.shape.value), expectedFixedSideBox(2, 1, 90));
        doc.history.undo();
        expectBox(vertexBox(body.shape.value), expectedFixedSideBox(1, 1, 90));
    });

    test("a bend angle edit re-folds the flange", () => {
        const doc = newDoc();
        const { body } = bentWithEasyEdge(doc, false);
        edit(doc, body, "bend", "angle", 45);
        expect(errors(body)).toEqual([undefined, undefined, undefined]);
        expectBox(vertexBox(body.shape.value), expectedFixedSideBox(1, 1, 45));
    });

    test("a blank size edit in the sketch re-folds around the same bend line", () => {
        const doc = newDoc();
        const { body, sketch } = bentWithEasyEdge(doc, false);
        Transaction.execute(doc, "resize", () => sketch.setDataEmitShapeChanged(rect(0, 0, 230, H)));
        expect(errors(body)).toEqual([undefined, undefined, undefined]);
        expectBox(vertexBox(body.shape.value), expectedFixedSideBox(1, 1, 90, 230));
    });

    test("a blank resize that makes the far side the larger facet keeps the treatment on the near edge", () => {
        const doc = newDoc();
        const { body, sketch } = bentWithEasyEdge(doc, false);
        // 260 wide: the region right of the bend (138.8) now outgrows the left one (118.8).
        Transaction.execute(doc, "resize", () => sketch.setDataEmitShapeChanged(rect(0, 0, 260, H)));
        expect(errors(body)).toEqual([undefined, undefined, undefined]);
        expect(flangeEdges(body)).toEqual([[0, 0, H]]);
    });

    test("suppressing the bend unfolds the part; un-suppressing folds it back", () => {
        const doc = newDoc();
        const { body } = bentWithEasyEdge(doc, false);
        Transaction.execute(doc, "suppress", () => body.setFeatureSuppressed("bend", true));
        expect(errors(body)).toEqual([undefined, undefined, undefined]);
        const easy = walk([B(90, 1), S(6.35)], 1).map((p) => [-p[0], p[1]] as P2);
        expectBox(
            vertexBox(body.shape.value),
            walkedBox(
                [
                    [0, 0],
                    [W, 1],
                ],
                0,
                H,
                0,
                easy,
            ),
        );
        Transaction.execute(doc, "unsuppress", () => body.setFeatureSuppressed("bend", false));
        expectBox(vertexBox(body.shape.value), expectedFixedSideBox(1, 1, 90));
    });

    test("deleting the bend re-evaluates the treatments after it", () => {
        const doc = newDoc();
        const { body } = bentWithEasyEdge(doc, false);
        Transaction.execute(doc, "delete", () => body.removeFeature("bend"));
        expect(errors(body)).toEqual([undefined, undefined]);
        expect(body.shape.value.volume()).toBeCloseTo(W * H + formedVolume([B(90, 1), S(6.35)], 1, H), 3);
    });

    test.each([
        [
            "the bend angle 90° → 45°",
            (doc: TestDocument, body: ParametricBodyNode) => edit(doc, body, "bend", "angle", 45),
        ],
        [
            "the bend suppressed",
            (doc: TestDocument, body: ParametricBodyNode) =>
                Transaction.execute(doc, "suppress", () => body.setFeatureSuppressed("bend", true)),
        ],
        [
            "the bend radius 1 → 10",
            (doc: TestDocument, body: ParametricBodyNode) => edit(doc, body, "bend", "radius", 10),
        ],
        [
            "the thickness 1 → 2",
            (doc: TestDocument, body: ParametricBodyNode) => edit(doc, body, "base", "thickness", 2),
        ],
    ])("an easy edge on the moving flange follows when %s", (_name, change) => {
        const doc = newDoc();
        const { body } = bentWithEasyEdge(doc, true);
        change(doc, body);
        expect(errors(body)).toEqual([undefined, undefined, undefined]);
        expect(flangeEdges(body)).toEqual([[W, W, H]]);
    });

    test("a non-sheet-metal feature in between ends the sheet metal chain; suppressing it resumes the chain", () => {
        const doc = newDoc();
        const { body } = sheet(doc, rect(0, 0, W, H), { t: 1, r: 1, k: 0.5 });
        add(doc, body, bend("bend", bendLines(doc, [b], H), 90, "up"));
        const block = addSketch(doc, rect(10, 10, 30, 30));
        add(doc, body, { id: "boss", type: "extrude", sketchId: block.id, depth: 5, operation: "fuse" });
        expect(errors(body)).toEqual([undefined, undefined, undefined]);
        expect(sheetModelOf(body.shape.value)).toBeUndefined();
        add(doc, body, {
            id: "hem",
            type: "smEdge",
            kind: "hem",
            edges: [edgeNear(body, [0, 50, 0])],
            direction: "up",
            length: 10,
        });
        expect(body.featureItems()[3].error).toMatch(/need a sheet metal part before them/);
        Transaction.execute(doc, "suppress", () => body.setFeatureSuppressed("boss", true));
        expect(errors(body)).toEqual([undefined, undefined, undefined, undefined]);
        expect(sheetModelOf(body.shape.value)?.flanges.map((f) => f.kind)).toEqual(["hem"]);
    });
});

// ================================================================== Duct maker combinations

describe("duct maker combinations", () => {
    test("rectangular duct: three bends, Pittsburgh pocket and easy edge close a 300 × 200 duct; flatten", () => {
        const t = 0.7;
        const r = 1;
        const c = Math.max(0.25, t / 2);
        const P = DEFAULTS.pocketDepth;
        const lip = DEFAULTS.lipHeight;
        const leg = DEFAULTS.easyEdgeLength;
        const wi = 300;
        const hi = 200;
        const H = 400;
        const ba = bendAllowance(90, r, t, 0.5);
        const u1 = wi + t - r + ba / 2;
        const u2 = u1 + (hi - 2 * r) + ba;
        const u3 = u2 + (wi - 2 * r) + ba;
        const end = u3 + ba / 2 + hi - 2 * r - t;
        const doc = newDoc();
        const { body } = sheet(doc, rect(0, 0, end, H), { t, r, k: 0.5 });
        add(doc, body, bend("bends", bendLines(doc, [u1, u2, u3], H), 90, "up"));
        add(doc, body, {
            id: "pocket",
            type: "smEdge",
            kind: "pittsburgh",
            edges: [edgeNear(body, formedImage(body, [0, 0], [0, H]))],
            direction: "up",
            length: P,
            height: lip,
        });
        add(doc, body, {
            id: "easy",
            type: "smEdge",
            kind: "easyEdge",
            edges: [edgeNear(body, formedImage(body, [end, 0], [end, H]))],
            direction: "down",
            length: leg,
        });
        expect(errors(body)).toEqual([undefined, undefined, undefined, undefined]);
        expect(warnings(body)).toEqual([undefined, undefined, undefined, undefined]);
        const shape = body.shape.value;
        expect(solids(shape)).toBe(1);
        expect(shape.checkShape()).toBe(true);
        const pocketStrip = developed(pittsburghProfile(P, lip, c, t, r), t, 0.5);
        const easyStrip = developed([B(-90, r), S(leg)], t, 0.5);
        // No interference anywhere (the easy edge sits in the slot): formed = developed material.
        expect(shape.volume()).toBeCloseTo((end + pocketStrip + easyStrip) * H * t, 2);
        // Outside: from the pocket's edge to side B's outer face, A's bottom to C's top.
        expectBox(vertexBox(shape), { min: [-P, 0, 0], max: [wi + 2 * t, H, hi + 2 * t] });
        // The opening is clear, wi × hi inside the walls.
        expect(
            regionVolume(shape, [t + r + 0.01, 0, t + r + 0.01], [wi + t - r - 0.01, H, t + hi - r - 0.01]),
        ).toBeCloseTo(0, 6);
        expect(regionVolume(shape, [wi + t, 0, 50], [wi + 2 * t, H, 150])).toBeCloseTo(t * 100 * H, 4);
        expect(regionVolume(shape, [50, 0, hi + t], [250, H, hi + 2 * t])).toBeCloseTo(200 * t * H, 4);
        expect(regionVolume(shape, [0, 0, 50], [t, H, 150])).toBeCloseTo(t * 100 * H, 4);

        add(doc, body, { id: "flat", type: "smFlatten" });
        const flat = body.shape.value;
        expectBox(vertexBox(flat), { min: [-pocketStrip, 0, 0], max: [end + easyStrip, H, t] });
        expect(totalVolume(flat)).toBeCloseTo((end + pocketStrip + easyStrip) * H * t, 4);
        // Bend marks: 3 bend lines + 2 pocket bends + 1 easy edge bend.
        const marks = (flat.findSubShapes(ShapeTypes.edge) as IEdge[]).filter(
            (edge) => Math.abs(edge.length() - H) < 1e-6 && Math.abs(edge.startPoint().z - t) < 1e-9,
        );
        expect(marks.length - 2).toBe(6);
    });

    test("round duct: roll, crimp and bead, valid and dimensionally right; flatten", () => {
        const t = 0.8;
        const ri = 150;
        const L = 600;
        const k = 0.5;
        const circumference = 2 * Math.PI * (ri + k * t);
        const doc = newDoc();
        const { body } = sheet(doc, rect(0, 0, circumference, L), { t, k });
        add(doc, body, { id: "roll", type: "smRoll", axis: "v", radius: 0, direction: "up" });
        add(doc, body, { id: "crimp", type: "smCrimp", end: "end", length: 50, depth: 2, count: 40 });
        add(doc, body, {
            id: "bead",
            type: "smBead",
            offset: 80,
            from: "end",
            width: 8,
            height: 3,
            direction: "out",
        });
        add(doc, body, {
            id: "bead2",
            type: "smBead",
            offset: 80,
            from: "start",
            width: 8,
            height: 3,
            direction: "out",
        });
        expect(errors(body)).toEqual([undefined, undefined, undefined, undefined, undefined]);
        const shape = body.shape.value;
        expect(shape.checkShape()).toBe(true);
        const axis: P2 = [0, t + ri];
        // Two beads proud of the shell, at 80 from each end.
        const proud = annulusPart(shape, axis, ri + t + 1e-3, ri + t + 10, 0, L);
        expect(solids(proud)).toBe(2);
        // Plain shell between: exactly ri..ri + t.
        expect(annulusPart(shape, axis, ri + 1e-3, ri + t - 1e-3, 100, 500).volume()).toBeCloseTo(
            Math.PI * ((ri + t - 1e-3) ** 2 - (ri + 1e-3) ** 2) * 400,
            1,
        );
        add(doc, body, { id: "flat", type: "smFlatten" });
        expectBox(vertexBox(body.shape.value), { min: [0, 0, 0], max: [circumference, L, t] });
    });
});

// ================================================================== Command / data layer

describe("sheet metal commands produce the feature data the handlers evaluate", () => {
    type Pick = { shape: IShape; owner: { node: INode }; transform: Matrix4 };

    function run(command: object, doc: TestDocument, stepDatas: { nodes?: INode[]; shapes?: Pick[] }[]) {
        const c = command as any;
        c._application = { activeView: { document: doc } };
        c.stepDatas = stepDatas.map((data) => ({ nodes: data.nodes ?? [], shapes: data.shapes ?? [] }));
        c.executeMainTask();
    }

    const pick = (node: INode, shape: IShape): Pick => ({
        shape,
        owner: { node },
        transform: Matrix4.identity(),
    });
    const lastFeature = (body: ParametricBodyNode) => body.features.at(-1) as SheetMetalFeatureData;

    function baseBody(doc: TestDocument, w: number, h: number) {
        const sketch = addSketch(doc, rect(0, 0, w, h));
        const faces = (sketch.mesh.faces?.range ?? [])
            .filter((range) => range.shape.shapeType === ShapeTypes.face)
            .map((range) => range.shape as unknown as IFace);
        expect(faces).toHaveLength(1);
        const command = new SheetMetalBaseCommand();
        command.thickness = 0.8;
        run(command, doc, [{ nodes: [sketch], shapes: faces.map((face) => pick(sketch, face)) }]);
        const body = doc.modelManager.findNode(
            (node) => node instanceof ParametricBodyNode,
        ) as ParametricBodyNode;
        return { body, sketch };
    }

    test("Sheet Metal and Bend emit smBase / smBend data that evaluates", () => {
        const doc = newDoc();
        const { body, sketch } = baseBody(doc, 300, 100);
        expect(body.features[0]).toMatchObject({
            type: "smBase",
            sketchId: sketch.id,
            thickness: 0.8,
            radius: 1,
            kFactor: 0.44,
        });
        expect((body.features[0] as { profiles?: unknown[] }).profiles).toHaveLength(1);
        expect(errors(body)).toEqual([undefined]);
        expect(body.shape.value.volume()).toBeCloseTo(300 * 100 * 0.8, 6);
        expect(sketch.visible).toBe(false);

        const lines = addSketch(doc, {
            entities: [{ id: 1, type: "line", params: [200, -10, 200, 110] }],
            constraints: [],
        });
        const bendCommand = new SheetMetalBendCommand();
        bendCommand.angle = 60;
        bendCommand.direction = "sheetMetal.down";
        const [line] = lines.shape.value.findSubShapes(ShapeTypes.edge);
        run(bendCommand, doc, [{ nodes: [body] }, { shapes: [pick(lines, line)] }]);
        expect(lastFeature(body)).toMatchObject({ type: "smBend", angle: 60, direction: "down" });
        expect(errors(body)).toEqual([undefined, undefined]);
        expect(sheetModelOf(body.shape.value)?.bends.map((x) => [x.angle, x.radius])).toEqual([[-60, 1]]);
        expect(lines.visible).toBe(false);
    });

    test("Easy edge / Pittsburgh / Hem / Flange emit smEdge data with their defaults; Flatten toggles", () => {
        const doc = newDoc();
        const { body } = baseBody(doc, 300, 100);
        const commands: [object, Record<string, unknown>, [number, number, number]][] = [
            [new EasyEdgeCommand(), { kind: "easyEdge", length: 6.35, direction: "up" }, [0, 50, 0]],
            [
                new PittsburghCommand(),
                {
                    kind: "pittsburgh",
                    length: Math.round(DEFAULTS.pocketDepth * 100) / 100,
                    height: Math.round(DEFAULTS.lipHeight * 100) / 100,
                    direction: "up",
                },
                [300, 50, 0],
            ],
            [new HemCommand(), { kind: "hem", length: 12.7, direction: "up" }, [150, 100, 0]],
            [new FlangeCommand(), { kind: "flange", length: 12.7, angle: 90, direction: "up" }, [150, 0, 0]],
        ];
        for (const [command, expected, point] of commands) {
            run(command, doc, [{ shapes: [pick(body, nearestEdge(body, point))] }]);
            expect(lastFeature(body)).toMatchObject({ type: "smEdge", ...expected });
        }
        expect(errors(body)).toEqual([undefined, undefined, undefined, undefined, undefined]);
        expect(sheetModelOf(body.shape.value)?.flanges.map((f) => f.kind)).toEqual([
            "easyEdge",
            "pittsburgh",
            "hem",
            "flange",
        ]);

        run(new FlattenCommand(), doc, [{ nodes: [body] }]);
        expect(lastFeature(body).type).toBe("smFlatten");
        expect(sheetModelOf(body.shape.value)?.flat).toBe(true);
        run(new FlattenCommand(), doc, [{ nodes: [body] }]);
        expect(body.features.some((feature) => feature.type === "smFlatten")).toBe(false);
        expect(sheetModelOf(body.shape.value)?.flat).toBe(false);
    });

    test("Roll → Crimp → Bead (ring) emit evaluable round-duct features", () => {
        const doc = newDoc();
        const { body } = baseBody(doc, 2 * Math.PI * 100, 400);
        run(new RollCommand(), doc, [{ nodes: [body] }]);
        expect(lastFeature(body)).toMatchObject({ type: "smRoll", axis: "v", radius: 0, direction: "up" });
        run(new CrimpCommand(), doc, [{ nodes: [body] }]);
        expect(lastFeature(body)).toMatchObject({
            type: "smCrimp",
            end: "end",
            length: 38.1,
            depth: 1.5,
            count: 36,
        });
        run(new BeadCommand(), doc, [{ nodes: [body] }]);
        expect(lastFeature(body)).toMatchObject({
            type: "smBead",
            offset: 50,
            from: "end",
            width: 8,
            height: 3,
            direction: "out",
        });
        expect(errors(body)).toEqual([undefined, undefined, undefined, undefined]);
        const model = sheetModelOf(body.shape.value)!;
        expect(model.roll).toEqual({ axis: "v", radius: undefined, direction: 1 });
        expect(model.crimps).toEqual([{ end: "end", length: 38.1, depth: 1.5, count: 36 }]);
        expect(model.beads).toEqual([
            { kind: "ring", offset: 50, from: "end", width: 8, height: 3, direction: 1 },
        ]);
    });
});
