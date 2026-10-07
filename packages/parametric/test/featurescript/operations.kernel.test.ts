// Part of the Chili3d Project, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { type IShape, Plane, ShapeTypes } from "@chili3d/core";
import { initWasm, ShapeFactory } from "@chili3d/wasm";
import { FsMap, toDisplayString } from "../../src/featurescript/lang/values";
import { compileStudio, createInterpreter, runFeature } from "../../src/featurescript/runtime";

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

const HEADER = 'FeatureScript 2384;\nimport(path : "onshape/std/geometry.fs", version : "2384.0");\n';

/** Wraps `body` as a feature and runs it; returns the model bodies' shapes plus the log. */
function build(
    body: string,
    input?: IShape,
): { shapes: IShape[]; log: string[]; warnings: readonly string[] } {
    const log: string[] = [];
    const source = `${HEADER}
annotation { "Feature Type Name" : "Test" }
export const testFeature = defineFeature(function(context is Context, id is Id, definition is map)
    precondition {}
    {
${body}
    });`;
    const interpreter = createInterpreter({ print: (text) => log.push(text) });
    const module = interpreter.load({ path: "ops", source });
    const feature = module.feature("testFeature");
    expect(feature).toBeDefined();
    const result = runFeature({
        interpreter,
        feature: feature!,
        definition: () => new FsMap(),
        input,
        instanceId: "F1",
    });
    const shapes = result.bodies.map((b) => b.shape);
    const kept = [...shapes];
    result.context.dispose(kept);
    return { shapes, log, warnings: result.warnings };
}

const faceCount = (shape: IShape) => shape.findSubShapes(ShapeTypes.face).length;
const edgeCount = (shape: IShape) => shape.findSubShapes(ShapeTypes.edge).length;

describe("primitives", () => {
    test("fCuboid builds a box in meters, converted to millimetres", () => {
        const { shapes } = build(
            `fCuboid(context, id + "cube", { "corner1" : vector(0, 0, 0) * inch, "corner2" : vector(1, 2, 3) * millimeter });`,
        );
        expect(shapes).toHaveLength(1);
        expect(shapes[0].volume()).toBeCloseTo(6, 6);
        expect(faceCount(shapes[0])).toBe(6);
    });

    test("fCylinder and fSphere", () => {
        const { shapes } = build(`
            fCylinder(context, id + "cyl", { "bottomCenter" : vector(0, 0, 0) * mm, "topCenter" : vector(0, 0, 10) * mm, "radius" : 2 * mm });
            fSphere(context, id + "sph", { "center" : vector(50, 0, 0) * mm, "radius" : 3 * mm });`);
        expect(shapes).toHaveLength(2);
        expect(shapes[0].volume()).toBeCloseTo(Math.PI * 4 * 10, 3);
        expect(shapes[1].volume()).toBeCloseTo((4 / 3) * Math.PI * 27, 2);
    });
});

describe("sketch + extrude", () => {
    test("a sketched rectangle extrudes into a block; caps are queryable", () => {
        const { shapes, log } = build(`
            const sketch1 = newSketch(context, id + "sketch1", { "sketchPlane" : qCreatedBy(makeId("Top"), EntityType.FACE) });
            skRectangle(sketch1, "rect", { "firstCorner" : vector(0, 0) * mm, "secondCorner" : vector(20, 10) * mm });
            skSolve(sketch1);
            opExtrude(context, id + "extrude1", {
                "entities" : qSketchRegion(id + "sketch1"),
                "direction" : Z_DIRECTION,
                "endBound" : BoundingType.BLIND,
                "endDepth" : 5 * mm
            });
            println(size(evaluateQuery(context, qCapEntity(id + "extrude1", CapType.END, EntityType.FACE))));
            println(size(evaluateQuery(context, qCapEntity(id + "extrude1", CapType.START, EntityType.FACE))));
            println(size(evaluateQuery(context, qNonCapEntity(id + "extrude1", EntityType.FACE))));
            println(size(evaluateQuery(context, sketchEntityQuery(id + "sketch1", EntityType.EDGE, "rect.top"))));
            const top = evPlane(context, { "face" : qCapEntity(id + "extrude1", CapType.END, EntityType.FACE) });
            println(top.origin[2] / mm);
            opDeleteBodies(context, id + "del", { "entities" : qCreatedBy(id + "sketch1", EntityType.BODY) });`);
        expect(shapes).toHaveLength(1);
        expect(shapes[0].volume()).toBeCloseTo(1000, 6);
        expect(log).toEqual(["1", "1", "4", "1", "5"]);
    });

    test("the high-level extrude removes material from the host input", () => {
        const host = shapeFactory.box(Plane.XY, 30, 30, 10).value;
        const { shapes } = build(
            `
            const sketch1 = newSketchOnPlane(context, id + "sketch1", { "sketchPlane" : plane(vector(0, 0, 10) * mm, Z_DIRECTION) });
            skCircle(sketch1, "hole", { "center" : vector(15, 15) * mm, "radius" : 5 * mm });
            skSolve(sketch1);
            extrude(context, id + "cut", {
                "entities" : qSketchRegion(id + "sketch1"),
                "endBound" : BoundingType.THROUGH_ALL,
                "oppositeDirection" : true,
                "operationType" : NewBodyOperationType.REMOVE
            });`,
            host,
        );
        expect(shapes).toHaveLength(1);
        expect(shapes[0].volume()).toBeCloseTo(30 * 30 * 10 - Math.PI * 25 * 10, 2);
    });
});

describe("modifiers", () => {
    test("fillet edges by query; created-by survives the fillet", () => {
        const { shapes, log } = build(`
            fCuboid(context, id + "cube", { "corner1" : vector(0, 0, 0) * mm, "corner2" : vector(10, 10, 10) * mm });
            const before = size(evaluateQuery(context, qCreatedBy(id + "cube", EntityType.FACE)));
            opFillet(context, id + "fillet", { "entities" : qNthElement(qCreatedBy(id + "cube", EntityType.EDGE), 0), "radius" : 1 * mm });
            println(before);
            println(size(evaluateQuery(context, qCreatedBy(id + "cube", EntityType.FACE))));
            println(size(evaluateQuery(context, qCreatedBy(id + "fillet", EntityType.FACE))));`);
        expect(shapes).toHaveLength(1);
        expect(faceCount(shapes[0])).toBe(7);
        expect(log).toEqual(["6", "6", "1"]);
    });

    test("transient queries follow their entity through a modification", () => {
        const { log } = build(`
            fCuboid(context, id + "cube", { "corner1" : vector(0, 0, 0) * mm, "corner2" : vector(10, 10, 10) * mm });
            const top = evaluateQuery(context, qFarthestAlong(qCreatedBy(id + "cube", EntityType.FACE), Z_DIRECTION))[0];
            opChamfer(context, id + "chamfer", { "entities" : qEdgeAdjacent(qFarthestAlong(qCreatedBy(id + "cube", EntityType.FACE), -Z_DIRECTION), EntityType.EDGE), "width" : 1 * mm });
            println(evPlane(context, { "face" : top }).normal);
            println(size(evaluateQuery(context, top)));`);
        expect(log).toEqual(["[ 0, 0, 1 ]", "1"]);
    });

    test("boolean subtraction and union", () => {
        const { shapes } = build(`
            fCuboid(context, id + "a", { "corner1" : vector(0, 0, 0) * mm, "corner2" : vector(10, 10, 10) * mm });
            fCuboid(context, id + "b", { "corner1" : vector(5, 0, 0) * mm, "corner2" : vector(15, 10, 10) * mm });
            fCuboid(context, id + "c", { "corner1" : vector(2, 2, 8) * mm, "corner2" : vector(4, 4, 12) * mm });
            opBoolean(context, id + "union", { "tools" : qUnion([qCreatedBy(id + "a", EntityType.BODY), qCreatedBy(id + "b", EntityType.BODY)]), "operationType" : BooleanOperationType.UNION });
            opBoolean(context, id + "cut", { "targets" : qCreatedBy(id + "a", EntityType.BODY), "tools" : qCreatedBy(id + "c", EntityType.BODY), "operationType" : BooleanOperationType.SUBTRACTION });`);
        expect(shapes).toHaveLength(1);
        expect(shapes[0].volume()).toBeCloseTo(1500 - 8, 4);
    });

    // Onshape's opShell contract: negative thickness shells inward, positive grows outward.
    test.each([
        { thickness: -1, volume: 1000 - 8 * 8 * 9 },
        { thickness: 1, volume: 12 * 12 * 11 - 1000 },
    ])("shell with thickness $thickness mm removes a face and hollows the rest", ({ thickness, volume }) => {
        const { shapes } = build(`
            fCuboid(context, id + "cube", { "corner1" : vector(0, 0, 0) * mm, "corner2" : vector(10, 10, 10) * mm });
            opShell(context, id + "shell", { "entities" : qFarthestAlong(qCreatedBy(id + "cube", EntityType.FACE), Z_DIRECTION), "thickness" : ${thickness} * mm });`);
        expect(shapes).toHaveLength(1);
        expect(shapes[0].volume()).toBeCloseTo(volume, 2);
    });
});

describe("patterns and transforms", () => {
    test("circular pattern makes rotated copies", () => {
        const { shapes } = build(`
            fCylinder(context, id + "pin", { "bottomCenter" : vector(20, 0, 0) * mm, "topCenter" : vector(20, 0, 5) * mm, "radius" : 2 * mm });
            circularPattern(context, id + "pattern", {
                "entities" : qCreatedBy(id + "pin", EntityType.BODY),
                "axis" : line(WORLD_ORIGIN, Z_DIRECTION),
                "angle" : 360 * degree,
                "instanceCount" : 4,
                "equalSpace" : true
            });`);
        expect(shapes).toHaveLength(4);
        const centers = shapes.map((shape) => {
            const box = shape.boundingBox();
            return [Math.round((box.min.x + box.max.x) / 2), Math.round((box.min.y + box.max.y) / 2)];
        });
        expect(centers).toEqual([
            [20, 0],
            [0, 20],
            [-20, 0],
            [0, -20],
        ]);
    });

    test("opTransform moves a body", () => {
        const { shapes } = build(`
            fCuboid(context, id + "cube", { "corner1" : vector(0, 0, 0) * mm, "corner2" : vector(1, 1, 1) * mm });
            opTransform(context, id + "move", { "bodies" : qCreatedBy(id + "cube", EntityType.BODY), "transform" : transform(vector(10, 0, 0) * mm) });`);
        expect(shapes[0].boundingBox().min.x).toBeCloseTo(10, 6);
    });

    test("revolve a sketch profile about an axis", () => {
        const { shapes } = build(`
            const sketch1 = newSketch(context, id + "sketch1", { "sketchPlane" : qCreatedBy(makeId("Front"), EntityType.FACE) });
            skRectangle(sketch1, "rect", { "firstCorner" : vector(10, 0) * mm, "secondCorner" : vector(12, 5) * mm });
            skSolve(sketch1);
            revolve(context, id + "revolve", { "entities" : qSketchRegion(id + "sketch1"), "axis" : line(WORLD_ORIGIN, Z_DIRECTION) });`);
        expect(shapes).toHaveLength(1);
        expect(shapes[0].volume()).toBeCloseTo(Math.PI * (144 - 100) * 5, 2);
    });
});

describe("errors", () => {
    test("a regenError fails the run with its message", () => {
        expect(() => build('throw regenError("Pick a face");')).toThrow(/Pick a face/);
    });

    test("compile errors are reported as data", () => {
        const result = compileStudio({ path: "bad", source: `${HEADER}export const x = ;` });
        expect(result.error).toMatch(/Unexpected/);
        expect(result.line).toBe(3);
    });

    test("query printing is readable", () => {
        const interpreter = createInterpreter();
        const module = interpreter.load({
            path: "q",
            source: `${HEADER}export function main() { return qCreatedBy(makeId("Top"), EntityType.FACE); }`,
        });
        expect(toDisplayString(interpreter.callFunction(module.exports.get("main"), []))).toContain(
            "CREATED_BY",
        );
    });
});

test("edges count sanity", () => {
    const { shapes } = build(
        `fCuboid(context, id + "cube", { "corner1" : vector(0, 0, 0) * mm, "corner2" : vector(1, 1, 1) * mm });`,
    );
    expect(edgeCount(shapes[0])).toBe(12);
});
