// Part of the Chili3d Project, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { IEdge, IFace, IShape, Plane } from "@chili3d/core";
import { initWasm, ShapeFactory } from "@chili3d/wasm";
import {
    fsModelingHost,
    type IFsModelingHost,
    KERNEL_ONLY_HOST,
    type SketchLoopAnalysis,
    setFsModelingHost,
} from "../src/context/modelingHost";
import { FsMap } from "../src/lang/values";
import { createInterpreter, runFeature } from "../src/runtime";

// No `_helpers/cadHost` here: these tests run the engine on its own.

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

afterEach(() => setFsModelingHost(undefined));

const HEADER = 'FeatureScript 2384;\nimport(path : "onshape/std/geometry.fs", version : "2384.0");\n';

/** Runs `body` as a feature on the native std; returns the model bodies' shapes. */
function build(body: string, print?: (text: string) => void): IShape[] {
    const source = `${HEADER}
annotation { "Feature Type Name" : "Test" }
export const testFeature = defineFeature(function(context is Context, id is Id, definition is map)
    precondition {}
    {
${body}
    });`;
    const interpreter = createInterpreter({ print });
    const feature = interpreter.load({ path: "host", source }).feature("testFeature");
    expect(feature).toBeDefined();
    const result = runFeature({
        interpreter,
        feature: feature!,
        definition: () => new FsMap(),
        instanceId: "F1",
    });
    const shapes = result.bodies.map((body) => body.shape);
    result.context.dispose([...shapes]);
    return shapes;
}

/** Runs `body` and returns what it printed. */
function buildLog(body: string): string[] {
    const log: string[] = [];
    build(body, (text) => log.push(text));
    return log;
}

const CIRCLE_EXTRUDE = `
    const sketch1 = newSketch(context, id + "sketch1", { "sketchPlane" : qCreatedBy(makeId("Top"), EntityType.FACE) });
    skCircle(sketch1, "disc", { "center" : vector(0, 0) * mm, "radius" : 5 * mm });
    skSolve(sketch1);
    opExtrude(context, id + "extrude1", {
        "entities" : qSketchRegion(id + "sketch1"),
        "direction" : Z_DIRECTION,
        "endBound" : BoundingType.BLIND,
        "endDepth" : 2 * mm
    });
    opDeleteBodies(context, id + "del", { "entities" : qCreatedBy(id + "sketch1", EntityType.BODY) });`;

describe("the engine without a CAD host", () => {
    test("uses the kernel-only host, which keeps the kernel's history as reported", () => {
        expect(fsModelingHost()).toBe(KERNEL_ONLY_HOST);
        const map = [1, -1, 0];
        const completed = KERNEL_ONLY_HOST.completeFaceHistory([], [], map);
        expect(completed).toEqual([1, -1, 0]);
        expect(completed).not.toBe(map);
        expect(KERNEL_ONLY_HOST.completeEdgeHistory([], [], [-1])).toEqual([-1]);
    });

    test("builds the regions of a sketched rectangle with the kernel's splitter", () => {
        const shapes = build(`
            const sketch1 = newSketch(context, id + "sketch1", { "sketchPlane" : qCreatedBy(makeId("Top"), EntityType.FACE) });
            skRectangle(sketch1, "rect", { "firstCorner" : vector(0, 0) * mm, "secondCorner" : vector(20, 10) * mm });
            skSolve(sketch1);
            opExtrude(context, id + "extrude1", {
                "entities" : qSketchRegion(id + "sketch1"),
                "direction" : Z_DIRECTION,
                "endBound" : BoundingType.BLIND,
                "endDepth" : 5 * mm
            });
            opDeleteBodies(context, id + "del", { "entities" : qCreatedBy(id + "sketch1", EntityType.BODY) });`);
        expect(shapes).toHaveLength(1);
        expect(shapes[0].volume()).toBeCloseTo(1000, 6);
    });

    test("reports a constrained sketch as needing the parametric solver", () => {
        expect(() =>
            build(`
            const sketch1 = newSketch(context, id + "sketch1", { "sketchPlane" : qCreatedBy(makeId("Top"), EntityType.FACE) });
            skLineSegment(sketch1, "line", { "start" : vector(0, 0) * mm, "end" : vector(10, 1) * mm });
            skConstraint(sketch1, "h", { "constraintType" : ConstraintType.HORIZONTAL, "localFirst" : "line" });
            skSolve(sketch1);`),
        ).toThrow(/parametric module's sketch solver/);
    });
});

describe("an installed modeling host", () => {
    test("decides the sketch's loops", () => {
        const loops = rs.fn(
            (edges: IEdge[], _plane: Plane): SketchLoopAnalysis => ({
                groups: [edges],
                contains: () => false,
            }),
        );
        const host: IFsModelingHost = { ...KERNEL_ONLY_HOST, analyzeSketchLoops: loops };
        setFsModelingHost(host);
        expect(fsModelingHost()).toBe(host);

        const shapes = build(CIRCLE_EXTRUDE);

        expect(loops).toHaveBeenCalledTimes(1);
        expect(loops.mock.calls[0][0]).toHaveLength(1);
        expect(shapes).toHaveLength(1);
        expect(shapes[0].volume()).toBeCloseTo(Math.PI * 25 * 2, 6);
    });

    test("completes the history an operation's outputs inherit their attributes by", () => {
        const FILLET = `
            fCuboid(context, id + "cube", { "corner1" : vector(0, 0, 0) * mm, "corner2" : vector(10, 10, 10) * mm });
            opFillet(context, id + "fillet", { "entities" : qNthElement(qCreatedBy(id + "cube", EntityType.EDGE), 0), "radius" : 1 * mm });
            println(size(evaluateQuery(context, qCreatedBy(id + "cube", EntityType.FACE))));`;
        expect(buildLog(FILLET)).toEqual(["6"]);

        // A host that recovers nothing: every output face is new, created by the fillet.
        const faces = rs.fn((_inputs: readonly IFace[], outputs: readonly IFace[], _map: readonly number[]) =>
            outputs.map(() => -1),
        );
        setFsModelingHost({ ...KERNEL_ONLY_HOST, completeFaceHistory: faces });
        expect(buildLog(FILLET)).toEqual(["0"]);
        expect(faces).toHaveBeenCalled();
    });

    test("solves the sketch's constraints in place of the engine", () => {
        const solve = rs.fn((_sketch: Parameters<IFsModelingHost["solveSketchConstraints"]>[0]) => {});
        setFsModelingHost({ ...KERNEL_ONLY_HOST, solveSketchConstraints: solve });
        build(`
            const sketch1 = newSketch(context, id + "sketch1", { "sketchPlane" : qCreatedBy(makeId("Top"), EntityType.FACE) });
            skLineSegment(sketch1, "line", { "start" : vector(0, 0) * mm, "end" : vector(10, 1) * mm });
            skConstraint(sketch1, "h", { "constraintType" : ConstraintType.HORIZONTAL, "localFirst" : "line" });
            skSolve(sketch1);`);
        expect(solve).toHaveBeenCalledTimes(1);
        expect(solve.mock.calls[0][0].constraints.map((constraint) => constraint.id)).toEqual(["h"]);
    });

    test("is replaced by the kernel-only host when cleared", () => {
        setFsModelingHost({ ...KERNEL_ONLY_HOST });
        setFsModelingHost(undefined);
        expect(fsModelingHost()).toBe(KERNEL_ONLY_HOST);
    });
});
