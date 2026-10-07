// Part of the Chili3d Project, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

/**
 * The `@` built-ins behind Onshape's std, exercised through std's own public functions
 * on real geometry with analytic expectations: context and feature tracking, splines,
 * properties, the sheet metal stand-ins and the evaluation functions of `evaluate.fs`.
 */

import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { initWasm, ShapeFactory } from "@chili3d/wasm";
import { FsContext } from "../../src/featurescript/context/fsContext";
import type { Interpreter } from "../../src/featurescript/lang/interpreter";
import {
    FsArray,
    FsEnumValue,
    FsMap,
    type FsValue,
    isCallable,
    toDisplayString,
} from "../../src/featurescript/lang/values";
import { createOnshapeInterpreter } from "../../src/featurescript/onshape/onshapeStd";
import { ONSHAPE_STD } from "./_helpers/onshapeStd";

const WASM_BINARY = readFileSync(
    path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../wasm/lib/chili-wasm.wasm"),
);

const INCH = 0.0254;
const IN3 = INCH ** 3;

let interpreter: Interpreter;
const printed: string[] = [];

beforeAll(async () => {
    await initWasm({ wasmBinary: WASM_BINARY });
    Object.defineProperty(globalThis, "shapeFactory", {
        value: new ShapeFactory(),
        writable: true,
        configurable: true,
    });
    interpreter = createOnshapeInterpreter({ std: ONSHAPE_STD, print: (text) => printed.push(text) });
});

let studioCount = 0;

/** Runs `body` as a Part Studio build function on a fresh context and returns its result. */
function run(body: string, imports = ""): FsValue {
    const source = `FeatureScript 3083;
import(path : "onshape/std/geometry.fs", version : "3083.0");
${imports}
export function build(context is Context)
{
${body}
}
`;
    const module = interpreter.load({ path: `builtinStudio${studioCount++}`, source });
    const context = new FsContext();
    try {
        return interpreter.callFunction(module.env.lookup("build")?.value, [context.value]);
    } finally {
        context.dispose();
    }
}

/** A field (or array index) path into a result. */
function at(value: FsValue, ...path: (string | number)[]): FsValue {
    let current = value;
    for (const key of path) {
        if (typeof key === "number" && current instanceof FsArray) current = current.items[key];
        else if (typeof key === "string" && current instanceof FsMap) current = current.field(key);
        else throw new Error(`No ${key} in ${toDisplayString(current)}`);
    }
    return current;
}

/** A number, or the SI magnitude of a std ValueWithUnits. */
function num(value: FsValue): number {
    if (typeof value === "number") return value;
    if (value instanceof FsMap && typeof value.field("value") === "number")
        return value.field("value") as number;
    throw new Error(`Not a number: ${toDisplayString(value)}`);
}

function nums(value: FsValue): number[] {
    if (!(value instanceof FsArray)) throw new Error(`Not an array: ${toDisplayString(value)}`);
    return value.items.map(num);
}

/** Nested arrays of numbers as plain arrays. */
function nested(value: FsValue): unknown {
    return value instanceof FsArray ? value.items.map(nested) : value;
}

function name(value: FsValue): string {
    if (value instanceof FsEnumValue) return value.name;
    throw new Error(`Not an enum value: ${toDisplayString(value)}`);
}

function expectVector(actual: number[], expected: number[], digits = 9): void {
    expect(actual).toHaveLength(expected.length);
    for (let i = 0; i < actual.length; i++) expect(actual[i]).toBeCloseTo(expected[i], digits);
}

const CUBE = `fCuboid(context, makeId("cube"), { "corner1" : vector(0, 0, 0) * inch, "corner2" : vector(4, 4, 1) * inch });
    const cube = qCreatedBy(makeId("cube"), EntityType.BODY);`;
const CYLINDER = `fCylinder(context, makeId("cyl"), { "bottomCenter" : vector(0, 0, 0) * inch, "topCenter" : vector(0, 0, 2) * inch, "radius" : 1 * inch });
    const side = qGeometry(qCreatedBy(makeId("cyl"), EntityType.FACE), GeometryType.CYLINDER);
    const topCircle = qClosestTo(qGeometry(qCreatedBy(makeId("cyl"), EntityType.EDGE), GeometryType.CIRCLE), vector(0, 0, 2) * inch);`;
/** The cube's vertical edge at the origin, and faces next to it and away from it. */
const CORNER = `const corner = qClosestTo(qParallelEdges(qCreatedBy(makeId("cube"), EntityType.EDGE), Z_DIRECTION), vector(0, 0, 0.5) * inch);
    const nearFace = qClosestTo(qCreatedBy(makeId("cube"), EntityType.FACE), vector(0, 2, 0.5) * inch);
    const farFace = qClosestTo(qCreatedBy(makeId("cube"), EntityType.FACE), vector(4, 2, 0.5) * inch);
    const topFace = qClosestTo(qCreatedBy(makeId("cube"), EntityType.FACE), vector(2, 2, 1) * inch);`;

// ------------------------------------------------------------------ Context and features

describe("context and feature tracking", () => {
    test("the context runs at the current FeatureScript version", () => {
        const result =
            run(`return { "current" : getCurrentVersion(context) == FeatureScriptVersionNumberCurrent,
            "version" : getCurrentVersion(context) };`);
        expect(at(result, "current")).toBe(true);
        expect(name(at(result, "version"))).toBe("V3083_BUMP");
    });

    test("isInSheetMetalFeature holds inside a sheet metal feature only", () => {
        const result = run(
            `const probe = defineSheetMetalFeature(function(context is Context, id is Id, definition is map)
            {
                setVariable(context, "inside", isInSheetMetalFeature(context));
                setVariable(context, "active", getLastActiveId(context));
            }, {});
            probe(context, makeId("sm1"), {});
            return { "outside" : isInSheetMetalFeature(context), "inside" : getVariable(context, "inside"),
                     "active" : getVariable(context, "active") };`,
            'import(path : "onshape/std/sheetMetalUtils.fs", version : "3083.0");',
        );
        expect(at(result, "outside")).toBe(false);
        expect(at(result, "inside")).toBe(true);
        expect(toDisplayString(at(result, "active"))).toBe(toDisplayString(new FsArray(["sm1"], "Id")));
    });

    test("valuesSortedById orders by feature start, containsSketch finds sketches", () => {
        const result =
            run(`fCuboid(context, makeId("b"), { "corner1" : vector(0, 0, 0) * inch, "corner2" : vector(1, 1, 1) * inch });
            fCuboid(context, makeId("a"), { "corner1" : vector(2, 0, 0) * inch, "corner2" : vector(3, 1, 1) * inch });
            const s = newSketchOnPlane(context, makeId("sk"), { "sketchPlane" : XY_PLANE });
            skCircle(s, "c", { "center" : vector(0, 0) * inch, "radius" : 1 * inch });
            skSolve(s);
            return { "sorted" : valuesSortedById(context, { (makeId("a")) : "A", (makeId("b")) : "B", (makeId("zz")) : "Z" }),
                     "sketch" : containsSketch(context, { (makeId("sk")) : 1 }),
                     "noSketch" : containsSketch(context, { (makeId("a")) : 1 }) };`);
        expect((at(result, "sorted") as FsArray).items).toEqual(["B", "A", "Z"]);
        expect(at(result, "sketch")).toBe(true);
        expect(at(result, "noSketch")).toBe(false);
    });

    test("lastOperationId and lastModifyingOperationId follow the operations run", () => {
        const result = run(`${CUBE}
            ${CORNER}
            const afterCube = startTracking(context, qNothing()).lastOperationId;
            fillet(context, makeId("fillet1"), { "entities" : corner, "radius" : 0.25 * inch });
            return { "afterCube" : afterCube,
                     "afterFillet" : startTracking(context, qNothing()).lastOperationId,
                     "near" : lastModifyingOperationId(context, nearFace),
                     "far" : lastModifyingOperationId(context, farFace),
                     "filletFace" : lastModifyingOperationId(context, qGeometry(qCreatedBy(makeId("fillet1"), EntityType.FACE), GeometryType.CYLINDER)) };`);
        const id = (value: FsValue) => (value as FsArray).items.join("/");
        expect(id(at(result, "afterCube"))).toBe("cube/deleteSketch");
        expect(id(at(result, "afterFillet"))).toBe("fillet1");
        expect(id(at(result, "near"))).toBe("fillet1");
        expect(id(at(result, "far"))).toBe("cube/extrude");
        expect(id(at(result, "filletFace"))).toBe("fillet1");
    });

    test("a feature pattern places each instance by the remainder of its transform", () => {
        // fSphere moves its result by the remainder transform (its center vertex is not patterned).
        const result = run(`opPoint(context, makeId("center"), { "point" : vector(0, 0, 0) * inch });
            const center = qCreatedBy(makeId("center"), EntityType.VERTEX);
            { const s = newSketchOnPlane(context, makeId("sk"), { "sketchPlane" : XY_PLANE });
              skLineSegment(s, "l", { "start" : vector(0, -3) * inch, "end" : vector(1, -3) * inch });
              skSolve(s); }
            const ball = function(id) { fSphere(context, id, { "center" : center, "radius" : 0.5 * inch }); };
            ball(makeId("ball"));
            linearPattern(context, makeId("pattern"), {
                "patternType" : PatternType.FEATURE,
                "instanceFunction" : featureList({ (makeId("ball")) : ball }),
                "directionOne" : qCreatedBy(makeId("sk"), EntityType.EDGE),
                "distance" : 2 * inch, "instanceCount" : 3, "fullFeaturePattern" : true });
            const balls = qUnion([qCreatedBy(makeId("ball"), EntityType.BODY), qCreatedBy(makeId("pattern"), EntityType.BODY)]);
            const centroid = function(q) { return evApproximateMassProperties(context, { "entities" : q, "density" : 1 * kilogram / meter ^ 3 }).centroid; };
            return { "volume" : evVolume(context, { "entities" : balls }), "bodies" : size(evaluateQuery(context, balls)),
                     "all" : centroid(balls), "last" : centroid(qCreatedBy(makeId("pattern") + "2", EntityType.BODY)),
                     "after" : isInFeaturePattern(context) };`);
        expect(num(at(result, "volume"))).toBeCloseTo(3 * (4 / 3) * Math.PI * (0.5 * INCH) ** 3, 12);
        expect(at(result, "bodies")).toBe(3);
        expectVector(
            nums(at(result, "all")).map((c) => c / INCH),
            [2, 0, 0],
        );
        expectVector(
            nums(at(result, "last")).map((c) => c / INCH),
            [4, 0, 0],
        );
        expect(at(result, "after")).toBe(false);
    });

    test("the feature pattern stack composes transforms and pops by instance id", () => {
        const result = run(`const instance = makeId("p") + "1";
            setFeaturePatternInstanceData(context, instance, { "transform" : transform(vector(1, 0, 0) * inch) });
            opPoint(context, instance + "outerPoint", { "point" : vector(0, 0, 0) * inch });
            setFeaturePatternInstanceData(context, instance + "inner", { "transform" : transform(vector(0, 2, 0) * inch) });
            opPoint(context, instance + "inner" + "innerPoint", { "point" : vector(0, 0, 0) * inch });
            const remainder = function(id) {
                return getRemainderPatternTransform(context, { "references" : qCreatedBy(id, EntityType.VERTEX) }).translation;
            };
            const result = { "full" : getFullPatternTransform(context).translation, "unpatterned" : remainder(makeId("none")),
                             "outer" : remainder(instance + "outerPoint"), "inner" : remainder(instance + "inner" + "innerPoint"),
                             "in" : isInFeaturePattern(context) };
            const wrongPop = try silent(unsetFeaturePatternInstanceData(context, instance));
            unsetFeaturePatternInstanceData(context, instance + "inner");
            unsetFeaturePatternInstanceData(context, instance);
            return mergeMaps(result, { "after" : isInFeaturePattern(context), "wrongPopFailed" : wrongPop == undefined });`);
        expectVector(nums(at(result, "full")), [INCH, 2 * INCH, 0]);
        // R * S = F: nothing patterned → F; made in the outer instance → the inner move; in the innermost → none.
        expectVector(nums(at(result, "unpatterned")), [INCH, 2 * INCH, 0]);
        expectVector(nums(at(result, "outer")), [0, 2 * INCH, 0]);
        expectVector(nums(at(result, "inner")), [0, 0, 0]);
        expect(at(result, "in")).toBe(true);
        expect(at(result, "after")).toBe(false);
        expect(at(result, "wrongPopFailed")).toBe(true);
    });

    test("getFeatureName knows no feature names, tolerances are absent", () => {
        const result = run(
            `return { "name" : getFeatureName(context, makeId("cube")),
                      "tolerance" : getToleranceInfo(context, makeId("f"), { "radius" : 1 * inch }, "radius", false),
                      "problems" : validate(context) };`,
            'import(path : "onshape/std/toleranceSchemaValidation.fs", version : "3083.0");',
        );
        expect(at(result, "name")).toBe("");
        expect(name(at(result, "tolerance", "toleranceType"))).toBe("NONE");
        expect((at(result, "problems") as FsArray).items).toEqual([]);
    });

    test("timers print elapsed milliseconds and an unstarted timer throws", () => {
        printed.length = 0;
        const result = run(`startTimer("t");
            printTimer("t");
            return try silent(printTimer("never started")) == undefined;`);
        expect(result).toBe(true);
        expect(printed).toHaveLength(1);
        expect(printed[0]).toMatch(/^Timer t: \d+\.\d{3} ms$/);
    });

    test("convert keeps a context, clampContextVersion leaves the current version", () => {
        const builtin = (key: string) => {
            const fn = interpreter.builtins.get(key);
            if (!isCallable(fn) || fn.kind !== "native") throw new Error(`No @${key}`);
            return fn.impl;
        };
        const site = { call: () => undefined, print: () => undefined, isType: () => false };
        const context = new FsContext();
        const loaded = new FsContext();
        try {
            expect(builtin("convert")([loaded.value, undefined], site)).toBe(loaded.value);
            builtin("clampContextVersion")(
                [context.value, new FsMap([["loadedContext", loaded.value]])],
                site,
            );
            expect(name(builtin("getCurrentVersion")([context.value], site))).toBe("V3083_BUMP");
        } finally {
            context.dispose();
            loaded.dispose();
        }
    });
});

// ------------------------------------------------------------------ Queries and points

describe("queries and points", () => {
    test("clusterPoints groups points within tolerance of each other", () => {
        const result =
            run(`return clusterPoints([vector(0, 0, 0) * meter, vector(1, 0, 0) * meter, vector(0.0005, 0, 0) * meter,
            vector(1.0004, 0, 0) * meter, vector(5, 5, 5) * meter, vector(0.0012, 0, 0) * meter], 0.001 * meter);`);
        expect(nested(result)).toEqual([[0, 2], [1, 3], [4], [5]]);
    });

    test("transient ids print as strings that resolve back to the entity", () => {
        const result = run(`${CUBE}
            const face = evaluateQuery(context, qCreatedBy(makeId("cube"), EntityType.FACE))[0];
            const text = transientQueriesToStrings(face);
            return { "text" : text, "same" : evaluateQuery(context, qTransient(text)) == [face] };`);
        expect(at(result, "text")).toMatch(/^T\d+$/);
        expect(at(result, "same")).toBe(true);
    });

    test("qCompressed decodes a compressed query", () => {
        const result = run(`${CUBE}
            const q = qCompressed(1, "%B5$QueryM2Sa$entityTypeBa$EntityTypeS4$FACES9$queryTypeSa$EVERYTHING", makeId("x"));
            return { "type" : q.queryType, "faces" : size(evaluateQuery(context, q)) };`);
        expect(name(at(result, "type"))).toBe("EVERYTHING");
        expect(at(result, "faces")).toBe(6);
    });
});

// ------------------------------------------------------------------ Splines

describe("splines", () => {
    test("approximateSpline reproduces a cubic, evaluateSpline returns its derivatives", () => {
        const result = run(`var points = [];
            var parameters = [];
            for (var i = 0; i <= 10; i += 1)
            {
                const x = i / 10;
                points = append(points, vector(x, x * x * x, 0) * meter);
                parameters = append(parameters, x);
            }
            const spline = approximateSpline(context, { "degree" : 3, "tolerance" : 1e-7 * meter, "isPeriodic" : false,
                "targets" : [approximationTarget({ "positions" : points })], "parameters" : parameters })[0];
            const values = evaluateSpline({ "spline" : spline, "parameters" : [0.5], "nDerivatives" : 2 });
            return { "isSpline" : spline is BSplineCurve, "count" : size(spline.controlPoints),
                     "p" : values[0][0], "d1" : values[1][0], "d2" : values[2][0] };`);
        expect(at(result, "isSpline")).toBe(true);
        expect(at(result, "count")).toBe(4);
        expectVector(nums(at(result, "p")), [0.5, 0.125, 0]);
        expectVector(nums(at(result, "d1")), [1, 0.75, 0]);
        expectVector(nums(at(result, "d2")), [0, 3, 0]);
    });

    test("a periodic approximation of a circle stays on it", () => {
        const result = run(`var points = [];
            for (var i = 0; i <= 36; i += 1)
                points = append(points, vector(cos(i * 10 * degree), sin(i * 10 * degree), 0) * meter);
            const spline = approximateSpline(context, { "degree" : 3, "tolerance" : 1e-5 * meter, "isPeriodic" : true,
                "targets" : [approximationTarget({ "positions" : points })] })[0];
            var parameters = [];
            for (var i = 0; i < 100; i += 1)
                parameters = append(parameters, i / 100);
            var worst = 0 * meter;
            for (var p in evaluateSpline({ "spline" : spline, "parameters" : parameters })[0])
                worst = max(worst, abs(norm(p) - 1 * meter));
            return { "periodic" : spline.isPeriodic, "worst" : worst };`);
        expect(at(result, "periodic")).toBe(true);
        expect(num(at(result, "worst"))).toBeLessThan(1e-4);
    });

    test("evApproximateBSplineCurve is exact for a circle, within tolerance when non-rational", () => {
        const result = run(`${CYLINDER}
            var radii = [];
            for (var options in [{}, { "forceNonRational" : true }])
            {
                const spline = evApproximateBSplineCurve(context, mergeMaps({ "edge" : topCircle }, options));
                var worst = 0 * meter;
                for (var p in evaluateSpline({ "spline" : spline, "parameters" : [0, 0.1, 0.25, 0.5, 0.8, 1] })[0])
                    worst = max(worst, abs(norm(p - vector(0, 0, 2) * inch) - 1 * inch));
                radii = append(radii, { "rational" : spline.isRational, "degree" : spline.degree, "worst" : worst });
            }
            return radii;`);
        expect(at(result, 0, "rational")).toBe(true);
        expect(at(result, 0, "degree")).toBe(2);
        expect(num(at(result, 0, "worst"))).toBeLessThan(1e-12);
        expect(at(result, 1, "rational")).toBe(false);
        expect(num(at(result, 1, "worst"))).toBeLessThan(1e-6);
    });

    test("evApproximateBSplineSurface spans a planar face bilinearly with its boundary", () => {
        const result = run(`${CUBE}
            ${CORNER}
            const result = evApproximateBSplineSurface(context, { "face" : topFace });
            var corners = [];
            for (var row in result.bSplineSurface.controlPoints)
                for (var p in row)
                    corners = append(corners, p);
            return { "isSurface" : result.bSplineSurface is BSplineSurface, "degree" : result.bSplineSurface.uDegree,
                     "corners" : corners, "boundary" : size(result.boundaryBSplineCurves), "inner" : size(result.innerLoopBSplineCurves) };`);
        expect(at(result, "isSurface")).toBe(true);
        expect(at(result, "degree")).toBe(1);
        const corners = (at(result, "corners") as FsArray).items.map((p) => nums(p).map((c) => c / INCH));
        expect(corners).toHaveLength(4);
        for (const corner of corners) {
            expect(corner[2]).toBeCloseTo(1, 5);
            expect([0, 4].some((x) => Math.abs(corner[0] - x) < 1e-5)).toBe(true);
            expect([0, 4].some((y) => Math.abs(corner[1] - y) < 1e-5)).toBe(true);
        }
        expect(at(result, "boundary")).toBe(4);
        expect(at(result, "inner")).toBe(0);
    });
});

// ------------------------------------------------------------------ Properties and sheet metal

describe("properties", () => {
    test("name, appearance and material survive a fillet; faces take only appearance and name", () => {
        const result = run(`${CUBE}
            ${CORNER}
            setProperty(context, { "entities" : cube, "propertyType" : PropertyType.NAME, "value" : "Block" });
            setProperty(context, { "entities" : cube, "propertyType" : PropertyType.APPEARANCE, "value" : color(1, 0, 0) });
            setProperty(context, { "entities" : cube, "propertyType" : PropertyType.MATERIAL, "value" : material("Steel", 7850 * kilogram / meter ^ 3) });
            setProperty(context, { "entities" : farFace, "propertyType" : PropertyType.APPEARANCE, "value" : color(0, 0, 1) });
            const faceMaterial = try silent(setProperty(context, { "entities" : farFace, "propertyType" : PropertyType.MATERIAL, "value" : material("Steel", 1 * kilogram / meter ^ 3) }));
            fillet(context, makeId("fillet1"), { "entities" : corner, "radius" : 0.25 * inch });
            fCuboid(context, makeId("other"), { "corner1" : vector(10, 0, 0) * inch, "corner2" : vector(11, 1, 1) * inch });
            const get = function(entity, kind) { return getProperty(context, { "entity" : entity, "propertyType" : kind }); };
            const steel = get(cube, PropertyType.MATERIAL);
            return { "name" : get(cube, PropertyType.NAME), "color" : get(cube, PropertyType.APPEARANCE),
                     "density" : steel.density, "isMaterial" : steel is Material,
                     "mass" : steel.density * evVolume(context, { "entities" : cube }),
                     "faceColor" : get(farFace, PropertyType.APPEARANCE), "otherFace" : get(nearFace, PropertyType.APPEARANCE),
                     "faceMaterialFailed" : faceMaterial == undefined,
                     "defaultName" : get(qCreatedBy(makeId("other"), EntityType.BODY), PropertyType.NAME),
                     "noMaterial" : get(qCreatedBy(makeId("other"), EntityType.BODY), PropertyType.MATERIAL) };`);
        expect(at(result, "name")).toBe("Block");
        expect(toDisplayString(at(result, "color"))).toBe(toDisplayString(at(result, "otherFace")));
        expect(num(at(result, "color", "red"))).toBe(1);
        expect(num(at(result, "faceColor", "blue"))).toBe(1);
        expect(num(at(result, "density"))).toBeCloseTo(7850, 9);
        expect(at(result, "isMaterial")).toBe(true);
        expect(num(at(result, "mass"))).toBeCloseTo(7850 * (16 - (1 - Math.PI / 4) * 0.0625) * IN3, 9);
        expect(at(result, "faceMaterialFailed")).toBe(true);
        expect(at(result, "defaultName")).toBe("Part 2");
        expect(at(result, "noMaterial")).toBeUndefined();
    });
});

describe("sheet metal stand-ins", () => {
    test("no entity is sheet metal", () => {
        const result = run(
            `${CUBE}
            var applyFailed = false;
            try silent { sheetMetalApplyInFlat(context, makeId("x"), { "entities" : qCreatedBy(makeId("cube"), EntityType.EDGE) }); }
            catch { applyFailed = true; }
            sheetMetalApplyInFlat(context, makeId("y"), { "entities" : qNothing() });
            const vertex = qNthElement(qCreatedBy(makeId("cube"), EntityType.VERTEX), 0);
            const corner = evCornerType(context, { "vertex" : vertex });
            return { "applyFailed" : applyFailed,
                     "holes" : evSheetMetalHoleToolBodies(context, { "sheetMetalHoleFaces" : qCreatedBy(makeId("cube"), EntityType.FACE) }),
                     "forms" : evSheetMetalFormToolBodies(context, { "sheetMetalFormFaces" : qCreatedBy(makeId("cube"), EntityType.FACE) }),
                     "flatFailed" : try silent(evSheetMetalFlatTransformation(context, { "face" : qNthElement(qCreatedBy(makeId("cube"), EntityType.FACE), 0) })) == undefined,
                     "bendFailed" : try silent(evSheetMetalBendUp(context, { "wireBody" : cube })) == undefined,
                     "cornerType" : corner.cornerType, "primary" : corner.primaryVertex == evaluateQuery(context, vertex)[0] };`,
            'import(path : "onshape/std/sheetMetalBuiltIns.fs", version : "3083.0");',
        );
        expect(at(result, "applyFailed")).toBe(true);
        expect(nested(at(result, "holes", "sheetMetalHoleToolBodies"))).toEqual([]);
        expect((at(result, "forms") as FsMap).size).toBe(0);
        expect(at(result, "flatFailed")).toBe(true);
        expect(at(result, "bendFailed")).toBe(true);
        expect(name(at(result, "cornerType"))).toBe("NOT_A_CORNER");
        expect(at(result, "primary")).toBe(true);
    });
});

// ------------------------------------------------------------------ Faces

describe("face evaluation", () => {
    test("principal curvatures of a cylinder, a sphere, a hole and a plane", () => {
        const result = run(`${CYLINDER}
            fSphere(context, makeId("sphere"), { "radius" : 2 * inch });
            ${CUBE.replace('vector(0, 0, 0) * inch, "corner2" : vector(4, 4, 1)', 'vector(10, 0, 0) * inch, "corner2" : vector(14, 4, 1)')}
            { const s = newSketchOnPlane(context, makeId("hole"), { "sketchPlane" : plane(vector(0, 0, 1) * inch, vector(0, 0, 1)) });
              skCircle(s, "c", { "center" : vector(12, 2) * inch, "radius" : 0.5 * inch }); skSolve(s); }
            extrude(context, makeId("cut"), { "entities" : qSketchRegion(makeId("hole")), "endBound" : BoundingType.THROUGH_ALL,
                "operationType" : NewBodyOperationType.REMOVE, "oppositeDirection" : true, "defaultScope" : false, "booleanScope" : cube });
            const at = function(face) { return evFaceCurvature(context, { "face" : face, "parameter" : vector(0.5, 0.5) }); };
            return { "cylinder" : at(side), "sphere" : at(qCreatedBy(makeId("sphere"), EntityType.FACE)),
                     "hole" : at(qGeometry(qCreatedBy(makeId("cut"), EntityType.FACE), GeometryType.CYLINDER)),
                     "plane" : at(qClosestTo(qCreatedBy(makeId("cube"), EntityType.FACE), vector(11, 2, 1) * inch)) };`);
        expect(num(at(result, "cylinder", "maxCurvature"))).toBeCloseTo(1 / INCH, 9);
        expect(num(at(result, "cylinder", "minCurvature"))).toBeCloseTo(0, 9);
        expect(Math.abs(nums(at(result, "cylinder", "minDirection"))[2])).toBeCloseTo(1, 12);
        expect(nums(at(result, "cylinder", "maxDirection"))[2]).toBeCloseTo(0, 12);
        expect(num(at(result, "sphere", "minCurvature"))).toBeCloseTo(1 / (2 * INCH), 9);
        expect(num(at(result, "sphere", "maxCurvature"))).toBeCloseTo(1 / (2 * INCH), 9);
        expect(num(at(result, "hole", "minCurvature"))).toBeCloseTo(-1 / (0.5 * INCH), 9);
        expect(num(at(result, "hole", "maxCurvature"))).toBeCloseTo(0, 9);
        expect(num(at(result, "plane", "minCurvature"))).toBe(0);
        expect(num(at(result, "plane", "maxCurvature"))).toBe(0);
    });

    test("the derivative of the second fundamental form: constant along a cylinder, turning on a sphere", () => {
        // Through the built-in: std's wrapper casts `meter ^ -2 as MatrixWithUnits`, which this interpreter rejects.
        const result = run(`${CYLINDER}
            fSphere(context, makeId("sphere"), { "radius" : 2 * inch });
            const sphere = qCreatedBy(makeId("sphere"), EntityType.FACE);
            return { "cylinder" : @evFaceCurvatureDerivatives(context, { "face" : side, "parameters" : [vector(0.3, 0.6)], "directions" : [vector(0, 0, 1)] })[0],
                     "sphere" : @evFaceCurvatureDerivatives(context, { "face" : sphere, "parameters" : [vector(0.5, 0.5)], "directions" : [vector(0, 0, 1)] })[0],
                     "plane" : evFaceTangentPlane(context, { "face" : sphere, "parameter" : vector(0.5, 0.5) }) };`);
        const matrix = (key: string) =>
            (at(result, key) as FsArray).items.map((row) => (row as FsArray).items as number[]);
        for (const row of matrix("cylinder")) for (const value of row) expect(value).toBeCloseTo(0, 6);
        // II = -(I - n nᵀ) / r on a sphere, so along a unit tangent t: d II / ds = (t nᵀ + n tᵀ) / r².
        const n = nums(at(result, "plane", "normal"));
        const t = [0, 0, 1];
        const r2 = (2 * INCH) ** 2;
        expect(Math.abs(n[2])).toBeCloseTo(0, 6);
        const sphere = matrix("sphere");
        for (let i = 0; i < 3; i++)
            for (let j = 0; j < 3; j++) expect(sphere[i][j] * r2).toBeCloseTo(t[i] * n[j] + n[i] * t[j], 5);
    });

    test("periodicity and tangent planes", () => {
        const result = run(`${CYLINDER}
            ${CUBE.replace('vector(0, 0, 0) * inch, "corner2" : vector(4, 4, 1)', 'vector(10, 0, 0) * inch, "corner2" : vector(14, 4, 1)')}
            const top = qClosestTo(qCreatedBy(makeId("cube"), EntityType.FACE), vector(12, 2, 1) * inch);
            const frontEdge = qClosestTo(qCreatedBy(makeId("cube"), EntityType.EDGE), vector(12, 0, 1) * inch);
            return { "sidePeriodic" : evFacePeriodicity(context, { "face" : side }),
                     "topPeriodic" : evFacePeriodicity(context, { "face" : top }),
                     "topPlane" : evFaceTangentPlane(context, { "face" : top, "parameter" : vector(0.5, 0.5) }),
                     "sidePlane" : evFaceTangentPlane(context, { "face" : side, "parameter" : vector(0.25, 0.5) }),
                     "edgePlane" : evFaceTangentPlaneAtEdge(context, { "edge" : frontEdge, "face" : top, "parameter" : 0.5, "usingFaceOrientation" : true }) };`);
        expect((at(result, "sidePeriodic") as FsArray).items).toEqual([true, false]);
        expect((at(result, "topPeriodic") as FsArray).items).toEqual([false, false]);
        expectVector(
            nums(at(result, "topPlane", "origin")).map((c) => c / INCH),
            [12, 2, 1],
            5,
        );
        expectVector(nums(at(result, "topPlane", "normal")), [0, 0, 1]);
        const sideOrigin = nums(at(result, "sidePlane", "origin"));
        const sideNormal = nums(at(result, "sidePlane", "normal"));
        expect(Math.hypot(sideOrigin[0], sideOrigin[1])).toBeCloseTo(INCH, 9);
        expect(sideOrigin[2]).toBeCloseTo(INCH, 9);
        expectVector(sideNormal, [sideOrigin[0] / INCH, sideOrigin[1] / INCH, 0]);
        expectVector(
            nums(at(result, "edgePlane", "origin")).map((c) => c / INCH),
            [12, 0, 1],
            9,
        );
        expectVector(nums(at(result, "edgePlane", "normal")), [0, 0, 1]);
        expectVector(nums(at(result, "edgePlane", "x")), [1, 0, 0]);
    });

    test("evFilletRadius reads the radius of a fillet face", () => {
        const result = run(`${CUBE}
            ${CORNER}
            fillet(context, makeId("fillet1"), { "entities" : corner, "radius" : 0.25 * inch });
            return evFilletRadius(context, { "face" : qGeometry(qCreatedBy(makeId("fillet1"), EntityType.FACE), GeometryType.CYLINDER) });`);
        expect(num(result)).toBeCloseTo(0.25 * INCH, 12);
    });
});

// ------------------------------------------------------------------ Edges

describe("edge evaluation", () => {
    test("curvature frames and the curvature derivative of a circle; a straight edge has none", () => {
        const result = run(`${CYLINDER}
            return { "circle" : evEdgeCurvature(context, { "edge" : topCircle, "parameter" : 0.25 }),
                     "line" : evEdgeCurvature(context, { "edge" : qGeometry(qCreatedBy(makeId("cyl"), EntityType.EDGE), GeometryType.LINE), "parameter" : 0.5 }),
                     "derivative" : evEdgeCurvatureDerivative(context, { "edge" : topCircle, "parameter" : 0.25 }) };`);
        expect(num(at(result, "circle", "curvature"))).toBeCloseTo(1 / INCH, 9);
        const origin = nums(at(result, "circle", "frame", "origin"));
        const normal = nums(at(result, "circle", "frame", "xAxis"));
        const tangent = nums(at(result, "circle", "frame", "zAxis"));
        expect(Math.hypot(origin[0], origin[1])).toBeCloseTo(INCH, 12);
        expect(origin[2]).toBeCloseTo(2 * INCH, 12);
        expectVector(normal, [-origin[0] / INCH, -origin[1] / INCH, 0]);
        expect(tangent[0] * origin[0] + tangent[1] * origin[1]).toBeCloseTo(0, 12);
        expect(num(at(result, "line", "curvature"))).toBe(0);
        // d³C/ds³ = -κ² T on a circle.
        const derivative = nums(at(result, "derivative"));
        expectVector(
            derivative.map((c) => c * INCH * INCH),
            tangent.map((c) => -c),
            6,
        );
    });

    test("edge convexity: convex box edges, a concave inner corner, smooth fillet and seam edges", () => {
        const result = run(`${CUBE}
            ${CORNER}
            fCuboid(context, makeId("a"), { "corner1" : vector(10, 0, 0) * inch, "corner2" : vector(12, 1, 1) * inch });
            fCuboid(context, makeId("b"), { "corner1" : vector(10, 0, 0) * inch, "corner2" : vector(11, 2, 1) * inch });
            booleanBodies(context, makeId("union"), { "tools" : qUnion([qCreatedBy(makeId("a"), EntityType.BODY), qCreatedBy(makeId("b"), EntityType.BODY)]),
                "operationType" : BooleanOperationType.UNION });
            const convex = evEdgeConvexity(context, { "edge" : qClosestTo(qParallelEdges(qCreatedBy(makeId("cube"), EntityType.EDGE), Z_DIRECTION), vector(4, 4, 0.5) * inch) });
            fillet(context, makeId("fillet1"), { "entities" : corner, "radius" : 0.25 * inch });
            fCylinder(context, makeId("cyl"), { "bottomCenter" : vector(20, 0, 0) * inch, "topCenter" : vector(20, 0, 2) * inch, "radius" : 1 * inch });
            const filletFace = qGeometry(qCreatedBy(makeId("fillet1"), EntityType.FACE), GeometryType.CYLINDER);
            return { "convex" : convex,
                     "concave" : evEdgeConvexity(context, { "edge" : qClosestTo(qParallelEdges(qEverything(EntityType.EDGE), Z_DIRECTION), vector(11, 1, 0.5) * inch) }),
                     "smooth" : evEdgeConvexity(context, { "edge" : qNthElement(qParallelEdges(qAdjacent(filletFace, AdjacencyType.EDGE, EntityType.EDGE), Z_DIRECTION), 0) }),
                     "seam" : evEdgeConvexity(context, { "edge" : qGeometry(qCreatedBy(makeId("cyl"), EntityType.EDGE), GeometryType.LINE) }) };`);
        expect(name(at(result, "convex"))).toBe("CONVEX");
        expect(name(at(result, "concave"))).toBe("CONCAVE");
        expect(name(at(result, "smooth"))).toBe("SMOOTH");
        expect(name(at(result, "seam"))).toBe("SMOOTH");
    });

    test("planes of planar edges", () => {
        const result = run(`${CYLINDER}
            ${CUBE.replace('vector(0, 0, 0) * inch, "corner2" : vector(4, 4, 1)', 'vector(10, 0, 0) * inch, "corner2" : vector(14, 4, 1)')}
            const top = qClosestTo(qCreatedBy(makeId("cube"), EntityType.FACE), vector(12, 2, 1) * inch);
            const straight = try silent(evPlanarEdge(context, { "edge" : qNthElement(qCreatedBy(makeId("cube"), EntityType.EDGE), 0) }));
            return { "circle" : evPlanarEdge(context, { "edge" : topCircle }),
                     "loop" : evPlanarEdges(context, { "edges" : qAdjacent(top, AdjacencyType.EDGE, EntityType.EDGE) }),
                     "straightFailed" : straight == undefined };`);
        expectVector(nums(at(result, "circle", "origin")), [0, 0, 2 * INCH]);
        expect(Math.abs(nums(at(result, "circle", "normal"))[2])).toBeCloseTo(1, 12);
        expect(nums(at(result, "loop", "origin"))[2]).toBeCloseTo(INCH, 12);
        expect(Math.abs(nums(at(result, "loop", "normal"))[2])).toBeCloseTo(1, 12);
        expect(at(result, "straightFailed")).toBe(true);
    });
});

// ------------------------------------------------------------------ Whole entities

describe("rays, mass properties and collisions", () => {
    test("rays hit a box's faces and a cylinder's side", () => {
        const result = run(`${CUBE}
            ${CYLINDER.replace(/vector\(0, 0, ([02])\) \* inch/g, "vector(10, 0, $1) * inch")}
            const down = line(vector(1, 3, 5) * inch, vector(0, 0, -1));
            return { "closest" : evRaycast(context, { "entities" : cube, "ray" : down }),
                     "all" : evRaycast(context, { "entities" : cube, "ray" : down, "closest" : false }),
                     "cylinder" : evRaycast(context, { "entities" : side, "ray" : line(vector(5, 0, 1) * inch, vector(1, 0, 0)), "closest" : false }),
                     "miss" : evRaycast(context, { "entities" : cube, "ray" : line(vector(1, 3, 5) * inch, vector(0, 0, 1)) }),
                     "back" : evFaceTangentPlane(context, { "face" : evRaycast(context, { "entities" : cube, "ray" : down })[0].entity,
                                                            "parameter" : evRaycast(context, { "entities" : cube, "ray" : down })[0].parameter }) };`);
        expect(at(result, "closest") instanceof FsArray && (at(result, "closest") as FsArray).size).toBe(1);
        expect(name(at(result, "closest", 0, "entityType"))).toBe("FACE");
        expect(num(at(result, "closest", 0, "distance"))).toBeCloseTo(4 * INCH, 12);
        expectVector(
            nums(at(result, "closest", 0, "intersection")).map((c) => c / INCH),
            [1, 3, 1],
            9,
        );
        expectVector(
            nums(at(result, "back", "origin")).map((c) => c / INCH),
            [1, 3, 1],
            5,
        );
        expect((at(result, "all") as FsArray).items.map((hit) => num(at(hit, "distance")) / INCH)).toEqual([
            expect.closeTo(4, 9),
            expect.closeTo(5, 9),
        ]);
        expect(
            (at(result, "cylinder") as FsArray).items.map((hit) => num(at(hit, "distance")) / INCH),
        ).toEqual([expect.closeTo(4, 9), expect.closeTo(6, 9)]);
        expect((at(result, "miss") as FsArray).size).toBe(0);
    });

    test("mass properties of a box, its faces, edges and vertices, and of a cylinder", () => {
        const result = run(`${CUBE}
            ${CYLINDER.replace(/vector\(0, 0, ([02])\) \* inch/g, "vector(10, 0, $1) * inch")}
            const density = 2 * kilogram / meter ^ 3;
            return { "box" : evApproximateMassProperties(context, { "entities" : cube, "density" : density }),
                     "framed" : evApproximateMassProperties(context, { "entities" : cube, "density" : density, "referenceFrame" : WORLD_COORD_SYSTEM }),
                     "faces" : evApproximateMassProperties(context, { "entities" : qCreatedBy(makeId("cube"), EntityType.FACE), "density" : 1 * kilogram / meter ^ 2 }),
                     "edges" : evApproximateMassProperties(context, { "entities" : qCreatedBy(makeId("cube"), EntityType.EDGE), "density" : 1 * kilogram / meter }),
                     "vertices" : evApproximateMassProperties(context, { "entities" : qCreatedBy(makeId("cube"), EntityType.VERTEX), "density" : 1 * kilogram }),
                     "cylinder" : evApproximateMassProperties(context, { "entities" : qCreatedBy(makeId("cyl"), EntityType.BODY), "density" : 1 * kilogram / meter ^ 3 }) };`);
        const mass = 2 * 16 * IN3;
        expect(num(at(result, "box", "volume"))).toBeCloseTo(16 * IN3, 15);
        expect(num(at(result, "box", "mass"))).toBeCloseTo(mass, 15);
        expectVector(
            nums(at(result, "box", "centroid")).map((c) => c / INCH),
            [2, 2, 0.5],
            9,
        );
        const inertia = (key: string) =>
            (at(result, key, "inertia", "value") as FsArray).items.map(
                (row) => (row as FsArray).items as number[],
            );
        const i2 = INCH ** 2;
        expect(inertia("box")[0][0]).toBeCloseTo((mass * (16 + 1) * i2) / 12, 15);
        expect(inertia("box")[2][2]).toBeCloseTo((mass * (16 + 16) * i2) / 12, 15);
        expect(inertia("box")[0][1]).toBeCloseTo(0, 15);
        // About the world origin: ∫(y² + z²) = m (4² + 1²) / 3, products -m (2 * 2).
        expect(inertia("framed")[0][0]).toBeCloseTo((mass * 17 * i2) / 3, 15);
        expect(inertia("framed")[0][1]).toBeCloseTo(-mass * 4 * i2, 15);
        expect(num(at(result, "faces", "area"))).toBeCloseTo(48 * i2, 13);
        expect(num(at(result, "edges", "length"))).toBeCloseTo(36 * INCH, 12);
        expect(at(result, "vertices", "count")).toBe(8);
        expectVector(
            nums(at(result, "vertices", "centroid")).map((c) => c / INCH),
            [2, 2, 0.5],
            9,
        );
        const cylinderMass = Math.PI * 2 * IN3;
        expect(num(at(result, "cylinder", "volume"))).toBeCloseTo(cylinderMass, 15);
        expectVector(
            nums(at(result, "cylinder", "centroid")).map((c) => c / INCH),
            [10, 0, 1],
            9,
        );
        expect(inertia("cylinder")[2][2]).toBeCloseTo((cylinderMass * i2) / 2, 15);
        expect(inertia("cylinder")[0][0]).toBeCloseTo((cylinderMass * (3 + 4) * i2) / 12, 15);
    });

    test("collision classes between solids", () => {
        const result = run(`${CUBE}
            const box = function(key, a, b) { fCuboid(context, makeId(key), { "corner1" : a * inch, "corner2" : b * inch }); return qCreatedBy(makeId(key), EntityType.BODY); };
            const overlapping = box("overlap", vector(3, 3, 0), vector(5, 5, 1));
            const touching = box("touch", vector(4, 0, 0), vector(6, 1, 1));
            const inside = box("inside", vector(1, 1, 0.25), vector(2, 2, 0.75));
            const apart = box("apart", vector(10, 10, 10), vector(11, 11, 11));
            const clash = function(tool) { return evCollision(context, { "tools" : tool, "targets" : cube }); };
            return { "overlap" : clash(overlapping)[0]["type"], "touch" : clash(touching)[0]["type"],
                     "inside" : clash(inside)[0]["type"], "contains" : evCollision(context, { "tools" : cube, "targets" : inside })[0]["type"],
                     "apart" : clash(apart), "targetBody" : clash(overlapping)[0].targetBody == evaluateQuery(context, cube)[0] };`);
        expect(name(at(result, "overlap"))).toBe("INTERFERE");
        expect(name(at(result, "touch"))).toBe("ABUT_TOOL_OUT_TARGET");
        expect(name(at(result, "inside"))).toBe("TOOL_IN_TARGET");
        expect(name(at(result, "contains"))).toBe("TARGET_IN_TOOL");
        expect((at(result, "apart") as FsArray).size).toBe(0);
        expect(at(result, "targetBody")).toBe(true);
    });

    test("deviations between paths and from points", () => {
        const result = run(`${CUBE}
            ${CORNER}
            const topEdge = qClosestTo(qCreatedBy(makeId("cube"), EntityType.EDGE), vector(2, 0, 1) * inch);
            const bottomEdge = qClosestTo(qCreatedBy(makeId("cube"), EntityType.EDGE), vector(2, 0, 0) * inch);
            return { "path" : evMaxPathDeviation(context, { "side1" : topEdge, "side2" : bottomEdge }),
                     "points" : evPointsDeviation(context, { "points" : [vector(2, 2, 3) * inch, vector(1, 1, 1.5) * inch], "topologies" : topFace, "allDeviations" : true }),
                     "max" : evPointsDeviation(context, { "points" : [vector(2, 2, 3) * inch, vector(1, 1, 1.5) * inch], "topologies" : topFace }) };`);
        expect(num(at(result, "path", "deviation"))).toBeCloseTo(INCH, 12);
        expect(nums(at(result, "path", "side1Point"))[2]).toBeCloseTo(INCH, 12);
        expect(nums(at(result, "path", "side2Point"))[2]).toBeCloseTo(0, 12);
        expect(num(at(result, "points", 0, "deviation"))).toBeCloseTo(2 * INCH, 12);
        expect(num(at(result, "points", 1, "deviation"))).toBeCloseTo(0.5 * INCH, 12);
        expectVector(
            nums(at(result, "points", 1, "topologyPoint")).map((c) => c / INCH),
            [1, 1, 1],
            9,
        );
        expect((at(result, "max") as FsArray).size).toBe(1);
        expect(num(at(result, "max", 0, "deviation"))).toBeCloseTo(2 * INCH, 12);
    });

    test("offset face pairs of a box", () => {
        const result = run(`${CUBE}
            var offsets = [];
            for (var group in evOffsetDetection(context, { "bodies" : cube }))
                offsets = append(offsets, { "low" : group.offsetLow, "pairs" : size(group.side0) });
            return offsets;`);
        const groups = (result as FsArray).items.map((group) => [
            num(at(group, "low")) / INCH,
            at(group, "pairs"),
        ]);
        expect(groups.sort((a, b) => (a[0] as number) - (b[0] as number))).toEqual([
            [expect.closeTo(1, 9), 1],
            [expect.closeTo(4, 9), 2],
        ]);
    });

    test("clusterBodies matches rotated copies but not mirror images", () => {
        const result =
            run(`fCuboid(context, makeId("x"), { "corner1" : vector(0, 0, 0) * inch, "corner2" : vector(3, 1, 1) * inch });
            fCuboid(context, makeId("y"), { "corner1" : vector(0, 0, 0) * inch, "corner2" : vector(1, 2, 1) * inch });
            fCuboid(context, makeId("z"), { "corner1" : vector(0, 0, 0) * inch, "corner2" : vector(1, 1, 4) * inch });
            booleanBodies(context, makeId("union"), { "tools" : qUnion([qCreatedBy(makeId("x"), EntityType.BODY), qCreatedBy(makeId("y"), EntityType.BODY), qCreatedBy(makeId("z"), EntityType.BODY)]),
                "operationType" : BooleanOperationType.UNION });
            const original = qCreatedBy(makeId("x"), EntityType.BODY);
            mirror(context, makeId("mirror"), { "patternType" : MirrorType.PART, "entities" : original, "mirrorPlane" : qCreatedBy(makeId("Right"), EntityType.FACE) });
            opPattern(context, makeId("rotated"), { "entities" : original, "transforms" : [rotationAround(line(vector(10, 0, 0) * inch, vector(0, 1, 1)), 70 * degree)], "instanceNames" : ["1"] });
            fCuboid(context, makeId("plain"), { "corner1" : vector(20, 0, 0) * inch, "corner2" : vector(21, 1, 1) * inch });
            return clusterBodies(context, { "bodies" : qUnion([original, qCreatedBy(makeId("mirror"), EntityType.BODY), qCreatedBy(makeId("rotated"), EntityType.BODY), qCreatedBy(makeId("plain"), EntityType.BODY)]),
                "relativeTolerance" : 0.001 });`);
        expect(nested(result)).toEqual([[0, 2], [1], [3]]);
    });

    test("B-rep geometry has no mesh points, no faults and the kernel tolerance", () => {
        const result = run(`${CUBE}
            return { "mesh" : evMeshPoints(context, { "meshes" : cube }), "faults" : evFaults(context, { "entities" : cube }),
                     "max" : evMaxTolerance(context, { "entities" : cube }),
                     "tolerances" : evTolerances(context, { "entities" : qCreatedBy(makeId("cube"), EntityType.EDGE) }) };`);
        expect((at(result, "mesh") as FsArray).size).toBe(0);
        expect((at(result, "faults") as FsArray).size).toBe(0);
        expect(num(at(result, "max"))).toBe(1e-10);
        const tolerances = at(result, "tolerances") as FsMap;
        expect(tolerances.size).toBe(12);
        for (const [, value] of tolerances.pairs()) expect(num(value)).toBe(1e-10);
    });

    test("addReferenceCSysFrame draws nothing during a run", () => {
        const result =
            run(`addReferenceCSysFrame(context, makeId("frame"), vector(0, 0, 0) * inch, vector(1, 0, 0), vector(0, 0, 1));
            return size(evaluateQuery(context, qEverything(EntityType.BODY)));`);
        expect(result).toBe(0);
    });
});
