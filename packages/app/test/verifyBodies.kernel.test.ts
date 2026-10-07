// Part of the Chili3d Project, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

/**
 * The Model-tab primitive and direct bodies against the real OCCT kernel: every
 * `generateShape()` must return a valid shape whose volume (or area / length) is the
 * closed-form value of what the node describes.
 */

import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
    type IDocument,
    type IEdge,
    type IFace,
    type IShape,
    type IWire,
    Line,
    Plane,
    type Result,
    ShapeTypes,
    XYZ,
} from "@chili3d/core";
import { createMockDocument } from "@chili3d/core/test-utils";
import { initWasm, ShapeFactory } from "@chili3d/wasm";
import { BoxNode } from "../src/bodys/box";
import { ConeNode } from "../src/bodys/cone";
import { CylinderNode } from "../src/bodys/cylinder";
import { ExtrudeNode } from "../src/bodys/extrude";
import { FaceNode } from "../src/bodys/face";
import { FuseNode } from "../src/bodys/fuse";
import { HelixNode } from "../src/bodys/helix";
import { PipeNode } from "../src/bodys/pipe";
import { PolygonNode } from "../src/bodys/polygon";
import { PyramidNode } from "../src/bodys/pyramid";
import { RegularPolygonNode } from "../src/bodys/regularPolygon";
import { RevolvedNode } from "../src/bodys/revolve";
import { SphereNode } from "../src/bodys/sphere";
import { SweepedNode } from "../src/bodys/sweep";

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

let doc: IDocument;
beforeEach(() => {
    doc = createMockDocument();
});

const xyz = (x: number, y: number, z: number) => new XYZ({ x, y, z });

/** The value of an ok result; fails the test with the kernel's message otherwise. */
function ok<T>(result: Result<T>): T {
    expect(result.isOk ? "ok" : result.error).toBe("ok");
    return result.unchecked()!;
}

function expectValidSolid(shape: IShape, volume: number, digits = 3): void {
    expect(shape.findSubShapes(ShapeTypes.solid).length).toBe(1);
    expect(shape.checkShape()).toBe(true);
    expect(shape.volume()).toBeCloseTo(volume, digits);
}

function expectExtent(shape: IShape, expected: number[], digits = 3): void {
    const box = shape.boundingBox();
    const actual = [box.min.x, box.min.y, box.min.z, box.max.x, box.max.y, box.max.z];
    for (const [index, value] of expected.entries()) expect(actual[index]).toBeCloseTo(value, digits);
}

/** A closed polyline wire through `points` (the first point is repeated at the end). */
function loop(...points: XYZ[]): IWire {
    return ok(shapeFactory.polygon([...points, points[0]]));
}

function circleWire(center: XYZ, normal: XYZ, radius: number): IWire {
    return ok(shapeFactory.wire([ok(shapeFactory.circle(normal, center, radius))]));
}

describe("primitive solids", () => {
    test.each<[string, number, number, number, number[]]>([
        ["positive dimensions", 10, 20, 30, [0, 0, 0, 10, 20, 30]],
        ["a negative height builds downwards", 10, 20, -30, [0, 0, -30, 10, 20, 0]],
        ["a negative width builds towards −X", -10, 20, 30, [-10, 0, 0, 0, 20, 30]],
    ])("box: %s", (_, dx, dy, dz, extent) => {
        const shape = ok(new BoxNode({ document: doc, plane: Plane.XY, dx, dy, dz }).generateShape());
        expectValidSolid(shape, 6000);
        expectExtent(shape, extent);
    });

    test("box on a tilted plane keeps its volume", () => {
        const plane = new Plane({ origin: xyz(5, 5, 5), normal: xyz(0, 1, 1).normalize()!, xvec: XYZ.unitX });
        const shape = ok(new BoxNode({ document: doc, plane, dx: 4, dy: 5, dz: 6 }).generateShape());
        expectValidSolid(shape, 120);
    });

    test("cylinder", () => {
        const node = new CylinderNode({
            document: doc,
            normal: XYZ.unitZ,
            center: xyz(1, 2, 3),
            radius: 4,
            dz: 10,
        });
        const shape = ok(node.generateShape());
        expectValidSolid(shape, Math.PI * 16 * 10);
        expectExtent(shape, [-3, -2, 3, 5, 6, 13], 1);
    });

    test("cone with an apex", () => {
        const node = new ConeNode({ document: doc, normal: XYZ.unitZ, center: XYZ.zero, radius: 6, dz: 9 });
        const shape = ok(node.generateShape());
        expectValidSolid(shape, (Math.PI * 36 * 9) / 3);
        expectExtent(shape, [-6, -6, 0, 6, 6, 9], 1);
    });

    test("sphere", () => {
        const shape = ok(new SphereNode({ document: doc, center: xyz(1, 1, 1), radius: 5 }).generateShape());
        expectValidSolid(shape, (4 / 3) * Math.PI * 125);
        expectExtent(shape, [-4, -4, -4, 6, 6, 6], 1);
    });

    test.each<[string, number, number, number]>([
        ["positive dimensions", 10, 20, 30],
        ["a negative height", 10, 20, -30],
        ["a negative width", -10, 20, 30],
    ])("pyramid: %s", (_, dx, dy, dz) => {
        const shape = ok(new PyramidNode({ document: doc, plane: Plane.XY, dx, dy, dz }).generateShape());
        expectValidSolid(shape, 2000);
    });

    // The commands normalize a downward drag to a flipped normal, but the property panel
    // writes `dz` as typed. Box and pyramid build downwards for a negative height; so must
    // these — today the cylinder returns an invalid solid whose volume/bounding-box queries
    // abort the kernel, and the cone aborts outright.
    test.each<[string, (dz: number) => { generateShape(): Result<IShape> }, number]>([
        [
            "cylinder",
            (dz) => new CylinderNode({ document: doc, normal: XYZ.unitZ, center: XYZ.zero, radius: 4, dz }),
            Math.PI * 16 * 10,
        ],
        [
            "cone",
            (dz) => new ConeNode({ document: doc, normal: XYZ.unitZ, center: XYZ.zero, radius: 4, dz }),
            (Math.PI * 16 * 10) / 3,
        ],
    ])("%s with a negative height builds downwards", (_, make, volume) => {
        const shape = ok(make(-10).generateShape());
        expectValidSolid(shape, volume);
        expectExtent(shape, [-4, -4, -10, 4, 4, 0], 1);
    });
});

describe("planar bodies", () => {
    test("closed polygon as a face", () => {
        const node = new PolygonNode({
            document: doc,
            points: [xyz(0, 0, 0), xyz(10, 0, 0), xyz(10, 5, 0), xyz(0, 5, 0), xyz(0, 0, 0)],
        });
        node.isFace = true;
        const shape = ok(node.generateShape());
        expect(shape.shapeType).toBe(ShapeTypes.face);
        expect((shape as IFace).area()).toBeCloseTo(50, 6);
    });

    test("regular hexagon as a face has area 3√3/2·r²", () => {
        const node = new RegularPolygonNode({
            document: doc,
            normal: XYZ.unitZ,
            xvec: XYZ.unitX,
            center: XYZ.zero,
            radius: 4,
            sides: 6,
        });
        node.isFace = true;
        const shape = ok(node.generateShape());
        expect((shape as IFace).area()).toBeCloseTo(((3 * Math.sqrt(3)) / 2) * 16, 6);
    });

    test("regular polygon as a wire has perimeter n·2r·sin(π/n)", () => {
        const node = new RegularPolygonNode({
            document: doc,
            normal: XYZ.unitZ,
            xvec: XYZ.unitX,
            center: XYZ.zero,
            radius: 4,
            sides: 5,
        });
        const shape = ok(node.generateShape());
        expect(shape.shapeType).toBe(ShapeTypes.wire);
        const length = (shape.findSubShapes(ShapeTypes.edge) as IEdge[]).reduce(
            (sum, e) => sum + e.length(),
            0,
        );
        expect(length).toBeCloseTo(5 * 8 * Math.sin(Math.PI / 5), 6);
    });

    test.each<[string, boolean]>([
        ["outer loop picked first", false],
        ["hole loop picked first", true],
    ])("face from an outer loop and a hole loop (%s)", (_, holeFirst) => {
        const outer = loop(xyz(0, 0, 0), xyz(20, 0, 0), xyz(20, 10, 0), xyz(0, 10, 0));
        const hole = circleWire(xyz(10, 5, 0), XYZ.unitZ, 2);
        const node = new FaceNode({ document: doc, shapes: holeFirst ? [hole, outer] : [outer, hole] });
        const face = ok(node.generateShape()) as IFace;
        expect(face.area()).toBeCloseTo(200 - 4 * Math.PI, 4);
        expect(face.checkShape()).toBe(true);
    });

    test("face from open edges reports an error instead of throwing", () => {
        const a = ok(shapeFactory.line(xyz(0, 0, 0), xyz(10, 0, 0)));
        const b = ok(shapeFactory.line(xyz(20, 0, 0), xyz(20, 10, 0)));
        const node = new FaceNode({ document: doc, shapes: [a, b] });
        let result: Result<IShape> | undefined;
        expect(() => {
            result = node.generateShape();
        }).not.toThrow();
        expect(result?.isOk).toBe(false);
    });
});

describe("swept bodies", () => {
    test.each<[string, () => IShape, number]>([
        [
            "closed polyline wire",
            () => loop(xyz(0, 0, 0), xyz(10, 0, 0), xyz(10, 5, 0), xyz(0, 5, 0)),
            50 * 7,
        ],
        ["circle edge", () => ok(shapeFactory.circle(XYZ.unitZ, XYZ.zero, 3)), Math.PI * 9 * 7],
        ["planar face", () => ok(shapeFactory.rect(Plane.XY, 4, 6)), 24 * 7],
    ])("extrude of a %s", (_, section, volume) => {
        const shape = ok(new ExtrudeNode({ document: doc, section: section(), length: 7 }).generateShape());
        expectValidSolid(shape, volume);
    });

    test.each<[string, number, number]>([
        ["full turn", 360, 1],
        ["quarter turn", 90, 0.25],
        ["quarter turn backwards", -90, 0.25],
    ])("revolve of a closed wire: %s", (_, angle, fraction) => {
        const profile = loop(xyz(10, 0, 0), xyz(20, 0, 0), xyz(20, 10, 0), xyz(10, 10, 0));
        const axis = new Line({ point: XYZ.zero, direction: XYZ.unitY });
        const shape = ok(new RevolvedNode({ document: doc, profile, axis, angle }).generateShape());
        expectValidSolid(shape, Math.PI * 300 * 10 * fraction, 2);
    });

    test("revolve of a circle edge is the Pappus torus", () => {
        const profile = ok(shapeFactory.circle(XYZ.unitZ, xyz(15, 0, 0), 3));
        const axis = new Line({ point: XYZ.zero, direction: XYZ.unitY });
        const shape = ok(new RevolvedNode({ document: doc, profile, axis, angle: 360 }).generateShape());
        expectValidSolid(shape, 2 * Math.PI * 15 * Math.PI * 9, 1);
    });

    test("revolve with a zero angle is refused without a kernel abort", () => {
        const profile = loop(xyz(10, 0, 0), xyz(20, 0, 0), xyz(20, 10, 0), xyz(10, 10, 0));
        const axis = new Line({ point: XYZ.zero, direction: XYZ.unitY });
        const result = new RevolvedNode({ document: doc, profile, axis, angle: 0 }).generateShape();
        expect(result.isOk).toBe(false);
        expect(result.isOk ? "" : result.error).not.toMatch(/Aborted|RuntimeError/);
    });

    test("sweep of a circle along a straight path", () => {
        const profile = circleWire(XYZ.zero, XYZ.unitZ, 2);
        const route = ok(shapeFactory.line(XYZ.zero, xyz(0, 0, 30)));
        const shape = ok(
            new SweepedNode({ document: doc, profile: [profile], path: route, round: false }).generateShape(),
        );
        expectValidSolid(shape, Math.PI * 4 * 30, 2);
    });

    test("pipe along a straight path, solid and hollow", () => {
        const route = ok(shapeFactory.line(XYZ.zero, xyz(0, 0, 40)));
        const solid = ok(new PipeNode({ document: doc, radius: 3, path: route }).generateShape());
        expectValidSolid(solid, Math.PI * 9 * 40, 2);
        const hollow = ok(
            new PipeNode({ document: doc, radius: 3, path: route, thickness: 1 }).generateShape(),
        );
        expectValidSolid(hollow, Math.PI * (9 - 4) * 40, 2);
    });

    test("pipe along an L path with a bend radius: two straights plus a quarter torus", () => {
        const route = ok(shapeFactory.polygon([XYZ.zero, xyz(0, 0, 30), xyz(30, 0, 30)]));
        const r = 2;
        const bend = 6;
        const shape = ok(
            new PipeNode({ document: doc, radius: r, path: route, bendRadius: bend }).generateShape(),
        );
        const centerline = 30 - bend + (30 - bend) + (bend * Math.PI) / 2;
        expectValidSolid(shape, Math.PI * r * r * centerline, 1);
    });

    test("helix: turns = angle / 360°, height = turns·pitch, length = turns·√((2πr)² + pitch²)", () => {
        const node = new HelixNode({
            document: doc,
            origin: XYZ.zero,
            normal: XYZ.unitZ,
            xDir: XYZ.unitX,
            radius: 5,
            pitch: 10,
            angle: 720,
        });
        const shape = ok(node.generateShape());
        const edges = shape.findSubShapes(ShapeTypes.edge) as IEdge[];
        const length = edges.reduce((sum, e) => sum + e.length(), 0);
        expect(length).toBeCloseTo(2 * Math.hypot(2 * Math.PI * 5, 10), 2);
        // Two full turns end where they started in plan, 2·pitch higher (the bounding box
        // of the approximated curve is loose, the end points are exact).
        const start = edges[0].startPoint();
        const end = edges[edges.length - 1].endPoint();
        for (const [actual, expected] of [
            [start.x, 5],
            [start.y, 0],
            [start.z, 0],
            [end.x, 5],
            [end.y, 0],
            [end.z, 20],
        ]) {
            expect(actual).toBeCloseTo(expected, 4);
        }
    });
});

describe("combined bodies", () => {
    test("fuse node builds the union of its two shapes", () => {
        const bottom = ok(shapeFactory.box(Plane.XY, 10, 10, 10));
        const top = ok(
            shapeFactory.box(
                new Plane({ origin: xyz(5, 5, 5), normal: XYZ.unitZ, xvec: XYZ.unitX }),
                10,
                10,
                10,
            ),
        );
        const node = new FuseNode({ document: doc, bottom, top });
        let result: Result<IShape> | undefined;
        expect(() => {
            result = node.generateShape();
        }).not.toThrow();
        expectValidSolid(ok(result!), 2000 - 125);
    });
});
