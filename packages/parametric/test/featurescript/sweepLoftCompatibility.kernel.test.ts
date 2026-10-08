// Part of the Chili3d Project, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { initWasm, ShapeFactory } from "@chili3d/wasm";
import { FsContext } from "../../src/featurescript/context/fsContext";
import { describeStatus, featureState } from "../../src/featurescript/onshape/featureBuiltins";
import { createOnshapeInterpreter } from "../../src/featurescript/onshape/onshapeStd";
import { ONSHAPE_STD } from "./_helpers/onshapeStd";

const originalFactory = Object.getOwnPropertyDescriptor(globalThis, "shapeFactory");
beforeAll(async () => {
    await initWasm({
        wasmBinary: readFileSync(
            path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../wasm/lib/chili-wasm.wasm"),
        ),
    });
    Object.defineProperty(globalThis, "shapeFactory", {
        value: new ShapeFactory(),
        writable: true,
        configurable: true,
    });
});
afterAll(() => {
    if (originalFactory) Object.defineProperty(globalThis, "shapeFactory", originalFactory);
});

/** A fresh interpreter and Context on every call: no cached geometry or previous successful shape. */
function rebuild(source: string) {
    const interpreter = createOnshapeInterpreter({ std: ONSHAPE_STD });
    const studio = interpreter.load({
        path: "compatibility",
        source: `FeatureScript 3083;
        import(path : "onshape/std/geometry.fs", version : "3083.0");
        export function build(context is Context) { const id = newId(); ${source} }`,
    });
    const context = new FsContext();
    try {
        interpreter.callFunction(studio.env.lookup("build")?.value, [context.value]);
        const errors = [...featureState(context).status.values()]
            .map(describeStatus)
            .filter((s) => s.kind === "ERROR");
        const model = context.bodies.filter((body) => body.isModelGeometry);
        const solids = model.filter((body) => body.kind === "SOLID");
        return {
            errors: errors.map((s) => s.message),
            solids: solids.length,
            sheets: model.filter((body) => body.kind === "SHEET").length,
            volume: solids.reduce((sum, body) => sum + body.shape.volume(), 0),
            valid: model.every((body) => body.shape.checkShape()),
        };
    } finally {
        context.dispose();
    }
}

const sketch = (name: string, plane: string, content: string) => `{
    const s = newSketchOnPlane(context, id + "${name}", { "sketchPlane" : ${plane} });
    ${content} skSolve(s);
}`;
const atZ = (z: number) => `plane(vector(0, 0, ${z}) * millimeter, vector(0, 0, 1))`;
const circle = (name: string, radius: number, x = 0) =>
    `skCircle(s, "${name}", { "center" : vector(${x}, 0) * millimeter, "radius" : ${radius} * millimeter });`;
const sweepPath = (length: number) =>
    sketch(
        "path",
        "plane(vector(0, 0, 0) * millimeter, vector(0, -1, 0), vector(1, 0, 0))",
        `skLineSegment(s, "l", { "start" : vector(0, 0) * millimeter, "end" : vector(0, ${length}) * millimeter });`,
    );
const region = (name: string) => `qSketchRegion(id + "${name}", true)`;
const sweep = (extra = "") => `opSweep(context, id + "sweep", { "profiles" : ${region("profile")},
    "path" : qCreatedBy(id + "path", EntityType.EDGE) ${extra} });`;
const loft = (extra = "") => `opLoft(context, id + "loft", {
    "profileSubqueries" : [${region("a")}, ${region("b")}] ${extra} });`;

describe("Onshape sweep / loft compatibility and cold parameter rebuilds", () => {
    test.each([
        8, 20, 35,
    ])("sweeps an annulus without filling its hole after rebuilding at length %i", (length) => {
        const result = rebuild(
            sketch("profile", atZ(0), circle("outer", 5) + circle("inner", 2)) + sweepPath(length) + sweep(),
        );
        expect(result.errors).toEqual([]);
        expect(result.valid).toBe(true);
        expect(result.solids).toBe(1);
        expect(result.volume).toBeCloseTo(Math.PI * (25 - 4) * length, 4);
    });
    test("independent profile regions produce independent solids", () => {
        const result = rebuild(
            sketch("profile", atZ(0), circle("left", 2, -5) + circle("right", 3, 5)) +
                sweepPath(12) +
                sweep(),
        );
        expect(result.errors).toEqual([]);
        expect(result.valid).toBe(true);
        expect(result.solids).toBe(2);
        expect(result.volume).toBeCloseTo(Math.PI * 13 * 12, 4);
    });
    test("a closed edge profile creates a surface, without solid end caps", () => {
        const result = rebuild(
            sketch("profile", atZ(0), circle("circle", 3)) +
                sweepPath(12) +
                `opSweep(context, id + "sweep", { "profiles" : qCreatedBy(id + "profile", EntityType.EDGE),
                "path" : qCreatedBy(id + "path", EntityType.EDGE) });`,
        );
        expect(result).toMatchObject({ errors: [], valid: true, solids: 0, sheets: 1, volume: 0 });
    });
    test.each([false, true])("curved sweep respects keepProfileOrientation=%s", (keep) => {
        const endX = 10 * (1 - Math.SQRT1_2);
        const endZ = 20 + 10 * Math.SQRT1_2;
        const curvedPath = sketch(
            "path",
            "plane(vector(0, 0, 0) * millimeter, vector(0, -1, 0), vector(1, 0, 0))",
            `
            skLineSegment(s, "line", { "start" : vector(0, 0) * millimeter, "end" : vector(0, 20) * millimeter });
            skArc(s, "arc", { "start" : vector(0, 20) * millimeter,
                "mid" : vector(${10 * (1 - Math.cos(Math.PI / 8))}, ${20 + 10 * Math.sin(Math.PI / 8)}) * millimeter,
                "end" : vector(${endX}, ${endZ}) * millimeter });`,
        );
        const result = rebuild(
            sketch("profile", atZ(0), circle("circle", 2)) +
                curvedPath +
                sweep(`, "keepProfileOrientation" : ${keep}`),
        );
        expect(result.errors).toEqual([]);
        expect(result.valid).toBe(true);
        expect(result.solids).toBe(1);
        // A fixed XY section integrates area * dz; a normal section integrates area * arc length.
        expect(result.volume).toBeCloseTo(4 * Math.PI * (keep ? endZ : 20 + 2.5 * Math.PI), 2);
    });
    test.each([5, 12, 30])("loft cold-rebuilds a conical frustum at height %i", (height) => {
        const result = rebuild(
            sketch("a", atZ(0), circle("circle", 5)) + sketch("b", atZ(height), circle("circle", 2)) + loft(),
        );
        expect(result.errors).toEqual([]);
        expect(result.valid).toBe(true);
        expect(result.solids).toBe(1);
        expect(result.volume).toBeCloseTo((Math.PI * height * (25 + 10 + 4)) / 3, 4);
    });
    test.each([
        ["twist", ', "hasTwist" : true', "hasTwist"],
        ["scale", ', "hasScale" : true', "hasScale"],
        ["locked direction", ', "profileControl" : ProfileControlMode.LOCK_DIRECTION', "LOCK_DIRECTION"],
    ])("sweep rejects unsupported %s instead of silently changing the design", (_label, extra, message) => {
        expect(() =>
            rebuild(sketch("profile", atZ(0), circle("circle", 3)) + sweepPath(12) + sweep(extra)),
        ).toThrow(message);
    });
    test.each([
        ["guides", ', "guideSubqueries" : [qNothing()]', "guideSubqueries"],
        [
            "end conditions",
            ', "derivativeInfo" : [{ "profileIndex" : 0, "matchCurvature" : true }]',
            "derivativeInfo",
        ],
        ["connections", ', "connections" : [{}]', "connections"],
        ["closed loft", ', "makePeriodic" : true', "makePeriodic"],
        ["path", ', "addSections" : true', "addSections"],
    ])("loft rejects unsupported %s", (_label, extra, message) => {
        expect(() =>
            rebuild(
                sketch("a", atZ(0), circle("circle", 5)) +
                    sketch("b", atZ(12), circle("circle", 2)) +
                    loft(extra),
            ),
        ).toThrow(message);
    });
    test("loft refuses a holed region instead of discarding its inner boundary", () => {
        expect(() =>
            rebuild(
                sketch("a", atZ(0), circle("outer", 5) + circle("inner", 2)) +
                    sketch("b", atZ(12), circle("outer", 5) + circle("inner", 2)) +
                    loft(),
            ),
        ).toThrow("profiles with holes");
    });
    test.each([true, false])("thicken respects keepTools=%s for an entire sheet body", (keepTools) => {
        const result = rebuild(`${sketch("profile", atZ(0), circle("circle", 3))}
            opExtractSurface(context, id + "surface", { "faces" : ${region("profile")} });
            opThicken(context, id + "thicken", { "entities" : qCreatedBy(id + "surface", EntityType.BODY),
                "thickness1" : 2 * millimeter, "thickness2" : 1 * millimeter, "keepTools" : ${keepTools} });`);
        expect(result.errors).toEqual([]);
        expect(result.valid).toBe(true);
        expect(result.solids).toBe(1);
        expect(result.sheets).toBe(keepTools ? 1 : 0);
        expect(result.volume).toBeCloseTo(27 * Math.PI, 4);
    });
    test("thicken rejects an empty query instead of succeeding with no result", () => {
        expect(() =>
            rebuild(
                `opThicken(context, id + "thicken", { "entities" : qNothing(), "thickness1" : 2 * millimeter });`,
            ),
        ).toThrow("needs sheet bodies or faces");
    });
    test("thicken refuses multi-face bodies instead of returning overlapping independent slabs", () => {
        expect(() =>
            rebuild(`
            fCuboid(context, id + "box", { "corner1" : vector(0,0,0) * millimeter, "corner2" : vector(10,10,10) * millimeter });
            opThicken(context, id + "thicken", { "entities" : qCreatedBy(id + "box", EntityType.FACE), "thickness1" : 1 * millimeter });
        `),
        ).toThrow("multiple faces of one body");
    });
    test("std sweep reports unsupported twist as a failed feature with no output solid", () => {
        const result = rebuild(`${sketch("profile", atZ(0), circle("circle", 3)) + sweepPath(12)}
            sweep(context, id + "sweep", { "profiles" : ${region("profile")},
                "path" : qCreatedBy(id + "path", EntityType.EDGE), "hasTwist" : true,
                "twistType" : SweepTwistType.TURNS, "turns" : 1, "ccw" : false });`);
        expect(result.solids).toBe(0);
        expect(result.errors.some((message) => message.includes("hasTwist is not supported yet"))).toBe(true);
    });
});
