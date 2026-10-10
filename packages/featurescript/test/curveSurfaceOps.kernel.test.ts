// Part of the Chili3d Project, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

/**
 * Onshape's std (3083) running the curve and surface features whose host built-ins live
 * in `onshape/pathBuiltins.ts`, `onshape/patternBuiltins.ts`,
 * `context/surfaceOperations.ts` and `context/faceCurves.ts` — the std features
 * themselves (`curvePattern`, `ruledSurface`, `projectCurves`, `isoparametricCurve`,
 * `extendSurface`, `bsurf`, `fitSpline`), called the way the Part Studio calls them, each
 * checked against exact positions, lengths, areas, body kinds and queries.
 */

import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { initWasm, ShapeFactory } from "@chili3d/wasm";
import { FsContext } from "../src/context/fsContext";
import { analyzeFeature } from "../src/featureSpec";
import type { Interpreter } from "../src/lang/interpreter";
import { describeStatus, featureState } from "../src/onshape/featureBuiltins";
import { createOnshapeInterpreter } from "../src/onshape/onshapeStd";
import { ONSHAPE_STD, STD_BUNDLE } from "./_helpers/onshapeStd";
import { stdFeatures } from "./_helpers/stdLayers";
import "./_helpers/cadHost";

const WASM_BINARY = readFileSync(
    path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../wasm/lib/chili-wasm.wasm"),
);

/** Created up front: test cases render std feature calls from their preconditions when collected. */
const interpreter: Interpreter = createOnshapeInterpreter({ std: ONSHAPE_STD });

beforeAll(async () => {
    await initWasm({ wasmBinary: WASM_BINARY });
    Object.defineProperty(globalThis, "shapeFactory", {
        value: new ShapeFactory(),
        writable: true,
        configurable: true,
    });
});

interface StudioResult {
    readonly solids: number;
    readonly sheets: number;
    readonly wires: number;
    /** What the build function returned, converted to plain JSON (numbers, strings, arrays). */
    readonly value: unknown;
    /** Every top-level feature (or operation) that reported an ERROR status. */
    readonly errors: string[];
}

let studioCount = 0;

/** Runs `body` as a Part Studio's build function (`id` is the root Id); returns what it returns. */
function partStudio(body: string): StudioResult {
    const source = `FeatureScript 3083;
import(path : "onshape/std/geometry.fs", version : "3083.0");
export function build(context is Context)
{
    const id = newId();
${body}
}
`;
    const module = interpreter.load({ path: `curveSurfaceOps${studioCount++}`, source });
    const context = new FsContext();
    try {
        const value = interpreter.callFunction(module.env.lookup("build")?.value, [context.value]);
        const model = context.bodies.filter((b) => b.isModelGeometry);
        return {
            solids: model.filter((b) => b.kind === "SOLID").length,
            sheets: model.filter((b) => b.kind === "SHEET").length,
            wires: model.filter((b) => b.kind === "WIRE").length,
            value: plain(value),
            errors: featureErrors(context),
        };
    } finally {
        context.dispose();
    }
}

function plain(value: unknown): unknown {
    if (value === undefined || typeof value !== "object" || value === null) return value;
    const items = (value as { items?: unknown[] }).items;
    if (Array.isArray(items)) return items.map(plain);
    return String(value);
}

/** Top-level ids only: a sub-operation's error is the feature's own business. */
function featureErrors(context: FsContext): string[] {
    const errors: string[] = [];
    for (const [id, status] of featureState(context).status) {
        const { kind, message } = describeStatus(status);
        if (kind === "ERROR" && !id.includes("/")) errors.push(`${id}: ${message}`);
    }
    return errors;
}

/** Runs `body`, expects no feature errors, and returns what it returned with the body counts. */
function run(body: string): StudioResult {
    const result = partStudio(body);
    expect(result.errors).toEqual([]);
    return result;
}

/** Runs `body` and expects a feature error status (or a thrown op) mentioning `message`. */
function expectError(body: string, message: string): void {
    let errors: string[];
    try {
        errors = partStudio(body).errors;
    } catch (error) {
        errors = [error instanceof Error ? error.message : String(error)];
    }
    expect(errors.join("\n")).toContain(message);
}

/**
 * A call of std feature `name` (from std module `module`) with every parameter its
 * precondition declares at its default — as the Part Studio UI would pass them — and
 * `overrides` (FeatureScript expressions) on top.
 */
function featureCall(module: string, name: string, id: string, overrides: Record<string, string>): string {
    const instance = interpreter.load({ path: `onshape/std/${module}`, source: STD_BUNDLE.files[module] });
    const found = stdFeatures(interpreter, instance).find((entry) => entry.feature.name === name);
    if (found === undefined) throw new Error(`std ${module} has no feature ${name}`);
    const fields: Record<string, string> = {};
    for (const parameter of analyzeFeature(interpreter, found.feature).parameters) {
        const value = parameter.defaultValue;
        if (parameter.kind === "length") fields[parameter.key] = `${Number(value)} * millimeter`;
        else if (parameter.kind === "angle") fields[parameter.key] = `${Number(value)} * degree`;
        else if (parameter.kind === "integer" || parameter.kind === "real")
            fields[parameter.key] = `${Number(value)}`;
        else if (parameter.kind === "boolean") fields[parameter.key] = `${value === true}`;
        else if (parameter.kind === "string") fields[parameter.key] = JSON.stringify(String(value));
        else if (parameter.kind === "enum" && parameter.enumType !== undefined)
            fields[parameter.key] = `${parameter.enumType.name}.${String(value)}`;
        else if (parameter.kind === "query") fields[parameter.key] = "qNothing()";
    }
    Object.assign(fields, overrides);
    const entries = Object.entries(fields).map(([key, value]) => `"${key}" : ${value}`);
    return `${name}(context, id + "${id}", { ${entries.join(", ")} });`;
}

// ------------------------------------------------------------------ Part Studio snippets

const mm = (...coordinates: number[]) => `vector(${coordinates.join(", ")}) * millimeter`;
const TOP = `plane(${mm(0, 0, 0)}, vector(0, 0, 1))`;
const bodyOf = (name: string) => `qCreatedBy(id + "${name}", EntityType.BODY)`;
const edgesOf = (name: string) => `qCreatedBy(id + "${name}", EntityType.EDGE)`;
const facesOf = (name: string) => `qCreatedBy(id + "${name}", EntityType.FACE)`;
const cuboid = (name: string, from: number[], to: number[]) =>
    `fCuboid(context, id + "${name}", { "corner1" : ${mm(...from)}, "corner2" : ${mm(...to)} });`;
const sketch = (name: string, plane: string, entities: string) =>
    `{ const s = newSketchOnPlane(context, id + "${name}", { "sketchPlane" : ${plane} });
       ${entities}
       skSolve(s); }`;
const segment = (name: string, x0: number, y0: number, x1: number, y1: number) =>
    `skLineSegment(s, "${name}", { "start" : ${mm(x0, y0)}, "end" : ${mm(x1, y1)} });`;
const length = (query: string) => `evLength(context, { "entities" : ${query} }) / millimeter`;
const area = (query: string) => `evArea(context, { "entities" : ${query} }) / millimeter ^ 2`;
const count = (query: string) => `size(evaluateQuery(context, ${query}))`;
/** The centroid of each body a query names, in mm, in query order. */
const centroids = (query: string) =>
    `mapArray(evaluateQuery(context, ${query}), function(b) { return evApproximateCentroid(context, { "entities" : b }) / millimeter; })`;
/** The tight bounding box of a query: [min corner, max corner] in mm. */
const box = (query: string) =>
    `{ const bounds = evBox3d(context, { "topology" : ${query}, "tight" : true }); return [bounds.minCorner / millimeter, bounds.maxCorner / millimeter]; }`;

/** The tight bounding box of a query as an expression: [min corner, max corner] in mm. */
const boxOf = (query: string) =>
    `[evBox3d(context, { "topology" : ${query}, "tight" : true }).minCorner / millimeter, evBox3d(context, { "topology" : ${query}, "tight" : true }).maxCorner / millimeter]`;
const wireBodies = (name: string) => `qBodyType(${bodyOf(name)}, BodyType.WIRE)`;
const sheetBodies = (name: string) => `qBodyType(${bodyOf(name)}, BodyType.SHEET)`;

/** Rounds every number of a nested array to 1e-6 for exact comparisons. */
function rounded(value: unknown): unknown {
    if (typeof value === "number") return Math.round(value * 1e6) / 1e6 + 0;
    if (Array.isArray(value)) return value.map(rounded);
    return value;
}

// ------------------------------------------------------------------ Curve pattern

describe("curve pattern", () => {
    /** A 2 mm cube centred on (20, 0, 1) — the seed. */
    const SEED = cuboid("seed", [19, -1, 0], [21, 1, 2]);
    const curvePattern = (path: string, overrides: Record<string, string>) =>
        featureCall("curvePattern.fs", "curvePattern", "pattern", {
            entities: bodyOf("seed"),
            edges: path,
            ...overrides,
        });

    test("equal spacing along a straight edge places translated copies at its divisions", () => {
        const result = run(`${SEED}
            ${sketch("path", TOP, segment("line", 20, 0, 50, 0))}
            ${curvePattern(edgesOf("path"), { instanceCount: "4" })}
            return ${centroids(`qBodyType(qEverything(EntityType.BODY), BodyType.SOLID)`)};`);
        expect(result.solids).toBe(4);
        const xs = (result.value as number[][]).map((c) => rounded(c));
        expect(xs).toEqual([
            [20, 0, 1],
            [30, 0, 1],
            [40, 0, 1],
            [50, 0, 1],
        ]);
    });

    test("a distance spacing steps the copies by that arc length", () => {
        const result = run(`${SEED}
            ${sketch("path", TOP, segment("line", 20, 0, 50, 0))}
            ${curvePattern(edgesOf("path"), {
                instanceCount: "3",
                spacingType: "CurvePatternSpacingType.DISTANCE",
                distance: "7 * millimeter",
            })}
            return ${centroids(`qCreatedBy(id + "pattern", EntityType.BODY)`)};`);
        expect(rounded(result.value)).toEqual([
            [27, 0, 1],
            [34, 0, 1],
        ]);
    });

    test("along an arc the copies turn with the tangent; keep orientation only translates", () => {
        // A quarter circle of radius 20 about the origin, from (20, 0) to (0, 20).
        const arc = sketch(
            "path",
            TOP,
            `skArc(s, "arc", { "start" : ${mm(20, 0)}, "mid" : ${mm(20 * Math.SQRT1_2, 20 * Math.SQRT1_2)}, "end" : ${mm(0, 20)} });`,
        );
        const quarter = (orientation: string) =>
            run(`${SEED} ${arc}
                ${curvePattern(edgesOf("path"), { instanceCount: "3", orientationType: orientation })}
                const copies = evaluateQuery(context, qCreatedBy(id + "pattern", EntityType.BODY));
                return [${centroids(`qCreatedBy(id + "pattern", EntityType.BODY)`)},
                        mapArray(copies, function(b) ${box("b")})];`);
        const turned = quarter("CurvePatternOrientationType.DEFAULT").value as number[][][][];
        const halfDiagonal = Math.SQRT2;
        const at45 = 20 * Math.SQRT1_2;
        expect(rounded(turned[0])).toEqual(
            rounded([
                [at45, at45, 1],
                [0, 20, 1],
            ]),
        );
        // The 45° copy is the cube turned by 45° about Z: its box spans the half diagonal.
        expect(rounded(turned[1][0])).toEqual(
            rounded([
                [at45 - halfDiagonal, at45 - halfDiagonal, 0],
                [at45 + halfDiagonal, at45 + halfDiagonal, 2],
            ]),
        );
        const kept = quarter("CurvePatternOrientationType.KEEP_ORIENTATION").value as number[][][][];
        expect(rounded(kept[0])).toEqual(
            rounded([
                [at45, at45, 1],
                [0, 20, 1],
            ]),
        );
        expect(rounded(kept[1][0])).toEqual(
            rounded([
                [at45 - 1, at45 - 1, 0],
                [at45 + 1, at45 + 1, 2],
            ]),
        );
    });

    test("skipped instances are left out and keep the others' names", () => {
        const result = run(`${SEED}
            ${sketch("path", TOP, segment("line", 20, 0, 50, 0))}
            ${curvePattern(edgesOf("path"), {
                instanceCount: "4",
                skipInstances: "true",
                skippedInstances: `[{ "index" : 2 }]`,
            })}
            return ${centroids(`qCreatedBy(id + "pattern", EntityType.BODY)`)};`);
        expect(result.solids).toBe(3);
        expect(rounded(result.value)).toEqual([
            [30, 0, 1],
            [50, 0, 1],
        ]);
    });
});

// ------------------------------------------------------------------ Paths

describe("constructPaths", () => {
    /** [path count, then per path: edge count, closed, every edge leaving where the next one starts]. */
    const describePaths = (edges: string, options = "{}") => `
        const paths = constructPaths(context, ${edges}, ${options});
        var result = [size(paths)];
        for (var path in paths)
        {
            var joined = true;
            for (var i = 0; i + 1 < size(path.edges); i += 1)
            {
                const leaving = edgeEndTangentLine(context, path, i, true).origin;
                const entering = edgeEndTangentLine(context, path, i + 1, false).origin;
                joined = joined && tolerantEquals(leaving, entering);
            }
            if (path.closed)
            {
                joined = joined && tolerantEquals(edgeEndTangentLine(context, path, size(path.edges) - 1, true).origin,
                    edgeEndTangentLine(context, path, 0, false).origin);
            }
            result = append(result, [size(path.edges), path.closed, joined]);
        }
        return result;`;

    test("scrambled and reversed segments chain into one open path from a free end", () => {
        const result = run(`
            ${sketch(
                "s1",
                TOP,
                `${segment("b", 10, 0, 10, 10)} ${segment("c", 0, 10, 10, 10)} ${segment("a", 0, 0, 10, 0)}`,
            )}
            ${describePaths(edgesOf("s1"))}`);
        expect(result.value).toEqual([1, [3, false, true]]);
    });

    test("a rectangle is one closed path; disjoint chains are separate paths", () => {
        const rectangle = run(`
            ${sketch("s1", TOP, `skRectangle(s, "r", { "firstCorner" : ${mm(0, 0)}, "secondCorner" : ${mm(10, 5)} });`)}
            ${describePaths(edgesOf("s1"))}`);
        expect(rectangle.value).toEqual([1, [4, true, true]]);
        const apart = run(`
            ${sketch("s1", TOP, `${segment("a", 0, 0, 10, 0)} ${segment("b", 0, 5, 10, 5)} ${segment("c", 10, 5, 10, 9)}`)}
            ${describePaths(edgesOf("s1"))}`);
        expect(apart.value).toEqual([2, [1, false, true], [2, false, true]]);
    });

    test("three edges meeting at a point are not a path", () => {
        expectError(
            `${sketch("s1", TOP, `${segment("a", 0, 0, 10, 0)} ${segment("b", 10, 0, 20, 0)} ${segment("c", 10, 0, 10, 10)}`)}
             constructPaths(context, ${edgesOf("s1")}, {});`,
            "CONSTRUCT_PATH_NOT_MANIFOLD",
        );
    });

    test("seed faces come back as the faces the path bounds", () => {
        const result = run(`${cuboid("box", [0, 0, 0], [20, 20, 10])}
            const top = qCoincidesWithPlane(${facesOf("box")}, plane(${mm(0, 0, 10)}, vector(0, 0, 1)));
            const paths = constructPaths(context, qAdjacent(top, AdjacencyType.EDGE, EntityType.EDGE), { "adjacentSeedFaces" : top });
            return [size(paths), paths[0].closed, size(paths[0].edges), ${count("paths[0].adjacentFaces")},
                    ${count("qIntersection([paths[0].adjacentFaces, top])")}];`);
        expect(result.value).toEqual([1, true, 4, 1, 1]);
    });
});

// ------------------------------------------------------------------ Ruled surface

describe("ruled surface", () => {
    /** An L of two segments (20 + 10 mm) and an arc on the Top plane. */
    const PATH = sketch(
        "path",
        TOP,
        `${segment("a", 0, 0, 20, 0)} ${segment("b", 20, 0, 20, 10)}
         skArc(s, "arc", { "start" : ${mm(40, 0)}, "mid" : ${mm(45, 5)}, "end" : ${mm(50, 0)} });`,
    );
    /** The Z axis as a direction pick: a vertical sketch line on the Front plane. */
    const AXIS = sketch(
        "axis",
        `plane(${mm(0, 0, 0)}, vector(0, -1, 0), vector(1, 0, 0))`,
        segment("z", -5, 0, -5, 1),
    );
    const ruled = (overrides: Record<string, string>) =>
        featureCall("ruledSurface.fs", "ruledSurface", "ruled", {
            edges: edgesOf("path"),
            ruledType: "RuledSurfaceInterfaceType.ALIGNED_WITH_VECTOR",
            axis: edgesOf("axis"),
            distance: "5 * millimeter",
            ...overrides,
        });

    test("aligned with a vector, each path chain becomes one sheet of the path's length times the distance", () => {
        const result = run(`${PATH} ${AXIS} ${ruled({})}
            return [${count(sheetBodies("ruled"))}, ${area(facesOf("ruled"))}, ${boxOf(sheetBodies("ruled"))},
                    ${count(`qGeometry(${facesOf("ruled")}, GeometryType.PLANE)`)},
                    ${count(`qGeometry(${facesOf("ruled")}, GeometryType.CYLINDER)`)}];`);
        expect(result.sheets).toBe(2);
        const [sheets, faceArea, bounds, planes, cylinders] = result.value as [
            number,
            number,
            number[][],
            number,
            number,
        ];
        expect(sheets).toBe(2);
        expect(faceArea).toBeCloseTo((30 + 5 * Math.PI) * 5, 6);
        expect(rounded(bounds)).toEqual([
            [0, 0, 0],
            [50, 10, 5],
        ]);
        expect([planes, cylinders]).toEqual([2, 1]);
    });

    test("the opposite direction rules the other way", () => {
        const result = run(`${PATH} ${AXIS} ${ruled({ oppositeDirection: "true" })}
            return ${boxOf(sheetBodies("ruled"))};`);
        expect(rounded(result.value)).toEqual([
            [0, 0, -5],
            [50, 10, 0],
        ]);
    });

    test("a path that does not run across the direction, and the face-referenced types, are refused", () => {
        expectError(
            `${PATH} ${AXIS} ${ruled({ axis: edgesOf("path") })}`,
            "the path must run perpendicular to ruledDirection",
        );
        expectError(
            `${PATH} ${AXIS} ${ruled({ ruledType: "RuledSurfaceInterfaceType.NORMAL", referenceFaces: "qNothing()" })}`,
            "ANGLE_FROM_FACE ruled surfaces are not supported yet",
        );
    });
});

// ------------------------------------------------------------------ Boundary surface

describe("boundary surface", () => {
    const profile = (uv: string, query: string) =>
        `{ "${uv}ProfileEntities" : ${query}, "${uv}Condition" : BSurfEndDerivativeType.DEFAULT, "${uv}Magnitude" : 1 }`;
    const edgeNamed = (sketchName: string, entity: string) =>
        `sketchEntityQuery(id + "${sketchName}", EntityType.EDGE, "${entity}")`;

    test("two u profiles interpolate linearly between them", () => {
        const result = run(`
            ${sketch("s1", TOP, `${segment("a", 0, 0, 20, 0)} ${segment("b", 0, 10, 20, 10)}`)}
            ${featureCall("bsurf.fs", "boundarySurface", "bsurf", {
                uProfilesArray: `[${profile("u", edgeNamed("s1", "a"))}, ${profile("u", edgeNamed("s1", "b"))}]`,
                vProfilesArray: "[]",
            })}
            return [${count(sheetBodies("bsurf"))}, ${area(facesOf("bsurf"))}, ${boxOf(sheetBodies("bsurf"))}];`);
        const [sheets, faceArea, bounds] = result.value as [number, number, number[][]];
        expect(sheets).toBe(1);
        expect(faceArea).toBeCloseTo(200, 6);
        expect(rounded(bounds)).toEqual([
            [0, 0, 0],
            [20, 10, 0],
        ]);
    });

    /** Four boundary lines through `corners` (in loop order) as wire bodies u0, v1, u1, v0, then the boundary surface. */
    const coons = (corners: number[][]) => {
        const [a, b, c, d] = corners.map((p) => mm(...p));
        return `
            opPolyline(context, id + "u0", { "points" : [${a}, ${b}] });
            opPolyline(context, id + "v1", { "points" : [${b}, ${c}] });
            opPolyline(context, id + "u1", { "points" : [${d}, ${c}] });
            opPolyline(context, id + "v0", { "points" : [${a}, ${d}] });
            ${featureCall("bsurf.fs", "boundarySurface", "bsurf", {
                uProfilesArray: `[${profile("u", bodyOf("u0"))}, ${profile("u", bodyOf("u1"))}]`,
                vProfilesArray: `[${profile("v", bodyOf("v0"))}, ${profile("v", bodyOf("v1"))}]`,
            })}`;
    };

    test("two u and two v coplanar profiles bound the planar patch between them", () => {
        const result = run(`${coons([
            [0, 0, 0],
            [10, 0, 0],
            [10, 10, 0],
            [0, 10, 0],
        ])}
            return [${count(sheetBodies("bsurf"))}, ${area(facesOf("bsurf"))}, ${boxOf(facesOf("bsurf"))},
                    ${count(`qOwnedByBody(${sheetBodies("bsurf")}, EntityType.EDGE)`)}];`);
        const [sheets, faceArea, bounds, edges] = result.value as [number, number, number[][], number];
        expect([sheets, edges]).toEqual([1, 4]);
        expect(faceArea).toBeCloseTo(100, 6);
        expect(rounded(bounds)).toEqual([
            [0, 0, 0],
            [10, 10, 0],
        ]);
    });

    test("a twisted four-sided boundary: the patch runs through every boundary and the blended center", () => {
        // Corners (0,0,0), (10,0,0), (10,10,5), (0,10,0): every boundary blend meets (5, 5, 1.25) at its center.
        const onFace = (x: number, y: number, z: number) => count(`qContainsPoint(face, ${mm(x, y, z)})`);
        const result = run(`${coons([
            [0, 0, 0],
            [10, 0, 0],
            [10, 10, 5],
            [0, 10, 0],
        ])}
            const face = ${facesOf("bsurf")};
            return [${count(sheetBodies("bsurf"))}, ${onFace(5, 5, 1.25)}, ${onFace(3, 0, 0)}, ${onFace(10, 3, 1.5)},
                    ${onFace(3, 10, 1.5)}, ${onFace(0, 7, 0)}, ${count(`qGeometry(face, GeometryType.PLANE)`)}];`);
        expect(result.value).toEqual([1, 1, 1, 1, 1, 1, 0]);
    });

    test("boundary conditions are refused", () => {
        expectError(
            `${sketch("s1", TOP, `${segment("a", 0, 0, 20, 0)} ${segment("b", 0, 10, 20, 10)}`)}
            opBoundarySurface(context, id + "bsurf", {
                "uProfileSubqueries" : [${edgeNamed("s1", "a")}, ${edgeNamed("s1", "b")}],
                "uDerivativeInfo" : [{ "profileIndex" : 0, "vector" : vector(0, 0, 1), "magnitude" : 1 }] });`,
            "boundary conditions are not supported yet",
        );
    });
});

// ------------------------------------------------------------------ Move boundary (extend surface)

describe("move boundary", () => {
    /** A vertical 20 x 10 sheet: the segment (0,0)-(20,0) on Top, extruded 10 up. */
    const WALL = `${sketch("s1", TOP, segment("a", 0, 0, 20, 0))}
        opExtrude(context, id + "wall", { "entities" : ${edgesOf("s1")}, "direction" : vector(0, 0, 1),
            "endBound" : BoundingType.BLIND, "endDepth" : 10 * millimeter });`;
    const extend = (entities: string, distance: number, overrides: Record<string, string> = {}) =>
        featureCall("extend.fs", "extendSurface", "extend", {
            entities,
            endCondition: "ExtendBoundingType.BLIND",
            extendDistance: `${distance} * millimeter`,
            ...overrides,
        });
    const TOP_EDGE = `qCoincidesWithPlane(qCreatedBy(id + "wall", EntityType.EDGE), plane(${mm(0, 0, 10)}, vector(0, 0, 1)))`;

    test("one boundary edge moves out in the sheet's plane; its neighbours lengthen with it", () => {
        const result = run(`${WALL}
            const sideEdges = qParallelEdges(qCreatedBy(id + "wall", EntityType.EDGE), vector(0, 0, 1));
            ${extend(TOP_EDGE, 5)}
            return [${area(sheetBodies("wall"))}, ${boxOf(sheetBodies("wall"))}, ${count(`qOwnedByBody(${bodyOf("wall")}, EntityType.EDGE)`)},
                    ${length("sideEdges")}];`);
        expect(result.sheets).toBe(1);
        const [sheetArea, bounds, edges, sides] = result.value as [number, number[][], number, number];
        expect(sheetArea).toBeCloseTo(300, 6);
        expect(rounded(bounds)).toEqual([
            [0, 0, 0],
            [20, 0, 15],
        ]);
        expect(edges).toBe(4);
        // The two vertical edges keep their identity and now run 15 each.
        expect(sides).toBeCloseTo(30, 6);
    });

    test("picking the sheet moves every boundary edge", () => {
        const result = run(`${WALL} ${extend(sheetBodies("wall"), 2)}
            return [${area(sheetBodies("wall"))}, ${boxOf(sheetBodies("wall"))}];`);
        const [sheetArea, bounds] = result.value as [number, number[][]];
        expect(sheetArea).toBeCloseTo(24 * 14, 6);
        expect(rounded(bounds)).toEqual([
            [-2, 0, -2],
            [22, 0, 12],
        ]);
    });

    test("up-to-target extension and curved sheets are refused", () => {
        expectError(
            `${sketch("s1", TOP, `skArc(s, "arc", { "start" : ${mm(0, 0)}, "mid" : ${mm(5, 5)}, "end" : ${mm(10, 0)} });`)}
             opExtrude(context, id + "wall", { "entities" : ${edgesOf("s1")}, "direction" : vector(0, 0, 1),
                "endBound" : BoundingType.BLIND, "endDepth" : 10 * millimeter });
             ${extend(TOP_EDGE, 5)}`,
            "only planar sheets are supported yet",
        );
    });
});

// ------------------------------------------------------------------ Projected curves

describe("projected curve onto faces", () => {
    const BOX = cuboid("box", [0, 0, 0], [20, 20, 10]);
    const BOX_TOP = `qCoincidesWithPlane(${facesOf("box")}, plane(${mm(0, 0, 10)}, vector(0, 0, 1)))`;
    /** A circle of radius 4 about (10, 10) at z = 20. */
    const CIRCLE = sketch(
        "s1",
        `plane(${mm(0, 0, 20)}, vector(0, 0, 1))`,
        `skCircle(s, "c", { "center" : ${mm(10, 10)}, "radius" : 4 * millimeter });`,
    );
    const project = (overrides: Record<string, string>) =>
        featureCall("projectCurves.fs", "projectCurves", "drop", {
            curveProjectionType: "CurveProjectionType.CURVE_TO_FACE",
            dropTools: edgesOf("s1"),
            targets: BOX_TOP,
            ...overrides,
        });
    const measured = `return [${count(wireBodies("drop"))}, ${length(wireBodies("drop"))}, ${boxOf(wireBodies("drop"))}];`;

    test("along a direction: the circle lands on the top face", () => {
        const result = run(`${BOX} ${CIRCLE}
            ${project({ projectionType: "ProjectionType.DIRECTION", directionQuery: BOX_TOP, oppositeDirection: "true" })}
            ${measured}`);
        const [wires, curveLength, bounds] = result.value as [number, number, number[][]];
        expect(wires).toBe(1);
        expect(curveLength).toBeCloseTo(8 * Math.PI, 6);
        expect(rounded(bounds)).toEqual([
            [6, 6, 10],
            [14, 14, 10],
        ]);
    });

    test("normal to the target: the same circle, within the kernel's approximation", () => {
        const result = run(`${BOX} ${CIRCLE} ${project({ projectionType: "ProjectionType.NORMAL_TO_TARGET" })}
            ${measured}`);
        const [wires, curveLength, bounds] = result.value as [number, number, number[][]];
        expect(wires).toBe(1);
        expect(curveLength).toBeCloseTo(8 * Math.PI, 3);
        expect(bounds[0][2]).toBeCloseTo(10, 6);
        expect(bounds[1][2]).toBeCloseTo(10, 6);
    });

    test("projecting along a direction keeps only what lies ahead of the curve", () => {
        // The circle at z = 20 between two plates (z = 0..1 and z = 30..31): down only reaches the lower one.
        const result =
            run(`${cuboid("low", [0, 0, 0], [20, 20, 1])} ${cuboid("high", [0, 0, 30], [20, 20, 31])} ${CIRCLE}
            ${featureCall("projectCurves.fs", "projectCurves", "drop", {
                curveProjectionType: "CurveProjectionType.CURVE_TO_FACE",
                dropTools: edgesOf("s1"),
                targets: `qUnion([${bodyOf("low")}, ${bodyOf("high")}])`,
                projectionType: "ProjectionType.DIRECTION",
                directionQuery: `qCoincidesWithPlane(${facesOf("low")}, plane(${mm(0, 0, 1)}, vector(0, 0, 1)))`,
                oppositeDirection: "true",
            })}
            ${measured}`);
        const [wires, curveLength, bounds] = result.value as [number, number, number[][]];
        // Both faces of the lower plate (z = 1 and z = 0) lie ahead; the upper plate does not.
        expect(wires).toBe(2);
        expect(curveLength).toBeCloseTo(16 * Math.PI, 6);
        expect(rounded([bounds[0][2], bounds[1][2]])).toEqual([0, 1]);
    });
});

// ------------------------------------------------------------------ Isoparametric curves

describe("isoparametric curve", () => {
    const CYLINDER = `fCylinder(context, id + "cyl", { "bottomCenter" : ${mm(0, 0, 0)}, "topCenter" : ${mm(0, 0, 10)}, "radius" : 5 * millimeter });`;
    const SIDE = `qGeometry(${facesOf("cyl")}, GeometryType.CYLINDER)`;
    const iso = (direction: string, values: number[]) =>
        featureCall("isoparametricCurve.fs", "isoparametricCurve", "iso", {
            face: SIDE,
            directionType: `DirectionType.${direction}`,
            equalSpacing: "false",
            uvParamList: `[${values.map((v) => `{ "selectPoint" : false, "uvValue" : ${v} }`).join(", ")}]`,
        });

    test("constant height on a cylinder is a circle at that fraction of its height", () => {
        // Symmetric fractions: the kernel's cylinder parameter may run either way along the axis.
        const result = run(`${CYLINDER} ${iso("V_DIRECTION", [0.25, 0.75])}
            return [${count(wireBodies("iso"))}, ${length(wireBodies("iso"))}, ${boxOf(wireBodies("iso"))}];`);
        const [wires, curveLength, bounds] = result.value as [number, number, number[][]];
        expect(wires).toBe(2);
        expect(curveLength).toBeCloseTo(2 * 10 * Math.PI, 6);
        expect(rounded(bounds)).toEqual([
            [-5, -5, 2.5],
            [5, 5, 7.5],
        ]);
    });

    test("constant angle on a cylinder is a straight line along its full height", () => {
        const result = run(`${CYLINDER} ${iso("U_DIRECTION", [0.25])}
            const wire = ${wireBodies("iso")};
            return [${count("wire")}, ${length("wire")}, ${count(`qGeometry(qOwnedByBody(wire, EntityType.EDGE), GeometryType.LINE)`)},
                    ${count(`qContainsPoint(${SIDE}, evVertexPoint(context, { "vertex" : qNthElement(qOwnedByBody(wire, EntityType.VERTEX), 0) }))`)}];`);
        expect(result.value).toEqual([1, 10, 1, 1]);
    });

    test("equal spacing is refused until its parameter rule is known", () => {
        expectError(
            `${CYLINDER} ${featureCall("isoparametricCurve.fs", "isoparametricCurve", "iso", {
                face: SIDE,
                directionType: "DirectionType.U_DIRECTION",
                equalSpacing: "true",
                nCurves: "3",
            })}`,
            "AUTO_SPACED_ISO curves are not supported yet",
        );
    });
});

// ------------------------------------------------------------------ Offset curve

describe("offset curve on faces", () => {
    const BOX = cuboid("box", [0, 0, 0], [20, 20, 10]);
    const offset = (edges: string, distance: number, overrides: Record<string, string> = {}) =>
        featureCall("offsetCurveOnFace.fs", "offsetCurveOnFace", "offset", {
            edges,
            distance: `${distance} * millimeter`,
            ...overrides,
        });
    const measured = `return [${count(wireBodies("offset"))}, ${length(wireBodies("offset"))}, ${boxOf(wireBodies("offset"))}];`;
    /** The box's top edge along y = 0. */
    const FRONT_TOP = `qCoincidesWithPlane(qCoincidesWithPlane(${edgesOf("box")}, plane(${mm(0, 0, 10)}, vector(0, 0, 1))), plane(${mm(0, 0, 0)}, vector(0, 1, 0)))`;
    const TOP_FACE = `qCoincidesWithPlane(${facesOf("box")}, plane(${mm(0, 0, 10)}, vector(0, 0, 1)))`;

    test("a straight edge moves across its face into a parallel line of the same length", () => {
        const result = run(`${BOX} ${offset(FRONT_TOP, 3, { targets: TOP_FACE })} ${measured}`);
        const [wires, curveLength, bounds] = result.value as [number, number, number[][]];
        expect(wires).toBe(1);
        expect(curveLength).toBeCloseTo(20, 9);
        expect(rounded(bounds)).toEqual([
            [0, 3, 10],
            [20, 3, 10],
        ]);
    });

    test("a circular edge offsets into a concentric circle", () => {
        const result =
            run(`fCylinder(context, id + "cyl", { "bottomCenter" : ${mm(0, 0, 0)}, "topCenter" : ${mm(0, 0, 10)}, "radius" : 5 * millimeter });
            const top = qCoincidesWithPlane(${facesOf("cyl")}, plane(${mm(0, 0, 10)}, vector(0, 0, 1)));
            ${offset("qAdjacent(top, AdjacencyType.EDGE, EntityType.EDGE)", 2, { targets: "top" })} ${measured}`);
        const [wires, curveLength, bounds] = result.value as [number, number, number[][]];
        expect(wires).toBe(1);
        expect(curveLength).toBeCloseTo(6 * Math.PI, 6);
        expect(rounded(bounds)).toEqual([
            [-3, -3, 10],
            [3, 3, 10],
        ]);
    });

    test("offset and extend runs a straight offset on to the face's boundary", () => {
        // A right triangle (0,0)-(20,0)-(0,20) extruded 10: at y = 4 its top face spans x = 0..16.
        const result = run(`
            ${sketch("tri", TOP, `${segment("a", 0, 0, 20, 0)} ${segment("b", 20, 0, 0, 20)} ${segment("c", 0, 20, 0, 0)}`)}
            extrude(context, id + "prism", { "entities" : qSketchRegion(id + "tri"), "endBound" : BoundingType.BLIND, "depth" : 10 * millimeter });
            const top = qCoincidesWithPlane(${facesOf("prism")}, plane(${mm(0, 0, 10)}, vector(0, 0, 1)));
            const edge = qCoincidesWithPlane(qAdjacent(top, AdjacencyType.EDGE, EntityType.EDGE), plane(${mm(0, 0, 0)}, vector(0, 1, 0)));
            ${offset("edge", 4, { targets: "top", scope: "OffsetCurveScope.OFFSET_AND_EXTEND" })} ${measured}`);
        const [wires, curveLength, bounds] = result.value as [number, number, number[][]];
        expect(wires).toBe(1);
        expect(curveLength).toBeCloseTo(16, 6);
        expect(rounded(bounds)).toEqual([
            [0, 4, 10],
            [16, 4, 10],
        ]);
    });

    test("an offset leaving its face, corners and splitting are refused", () => {
        expectError(
            `${BOX} ${offset(FRONT_TOP, 3, { targets: TOP_FACE, oppositeDirection: "true" })}`,
            "the offset curve leaves the face",
        );
        expectError(
            `${BOX} ${offset(`qAdjacent(${TOP_FACE}, AdjacencyType.EDGE, EntityType.EDGE)`, 3, { targets: TOP_FACE })}`,
            "offsetting corners between edges is not supported yet",
        );
        expectError(
            `${BOX} ${offset(FRONT_TOP, 3, { targets: TOP_FACE, scope: "OffsetCurveScope.OFFSET_EXTEND_AND_SPLIT" })}`,
            "splitting the faces is not supported yet",
        );
    });
});

// ------------------------------------------------------------------ Trim curve

describe("trim curve", () => {
    /** A straight wire from the origin to (10, 0, 0). */
    const WIRE = `opPolyline(context, id + "w", { "points" : [${mm(0, 0, 0)}, ${mm(10, 0, 0)}] });`;
    const vertexAt = (x: number) =>
        `qContainsPoint(qOwnedByBody(${bodyOf("w")}, EntityType.VERTEX), ${mm(x, 0, 0)})`;
    const planeAt = (name: string, x: number) =>
        `opPlane(context, id + "${name}", { "plane" : plane(${mm(x, 0, 0)}, vector(1, 0, 0)) });`;
    const trim = (overrides: Record<string, string>) =>
        featureCall("moveCurveBoundary.fs", "trimCurve", "trim", { wires: bodyOf("w"), ...overrides });
    const measured = `return [${length(bodyOf("w"))}, ${boxOf(bodyOf("w"))}, ${count(`qOwnedByBody(${bodyOf("w")}, EntityType.EDGE)`)},
        ${count(`qCreatedBy(id + "w", EntityType.EDGE)`)}];`;

    test.each([
        { name: "extends the end nearest the help point by a distance", flip: false, bounds: [0, 15] },
        { name: "extends the other end when flipped", flip: true, bounds: [-5, 10] },
    ])("$name", ({ flip, bounds }) => {
        const result = run(
            `${WIRE} ${trim({
                moveBoundaryType: "MoveCurveBoundaryType.EXTEND",
                endCondition: "CurveExtensionEndCondition.BLIND",
                extensionDistance: "5 * millimeter",
                helpPoint: vertexAt(10),
                flipHeuristics: `${flip}`,
            })} ${measured}`,
        );
        const [wireLength, box, edges, kept] = result.value as [number, number[][], number, number];
        expect(wireLength).toBeCloseTo(15, 9);
        expect(rounded([box[0][0], box[1][0]])).toEqual(bounds);
        // The wire keeps its one edge, still created by the polyline.
        expect([edges, kept]).toEqual([1, 1]);
    });

    test("extends up to a plane ahead of the nearest end", () => {
        const result = run(
            `${WIRE} ${planeAt("p", 14)} ${trim({
                moveBoundaryType: "MoveCurveBoundaryType.EXTEND",
                endCondition: "CurveExtensionEndCondition.UP_TO_ENTITY",
                extendTo: bodyOf("p"),
            })} ${measured}`,
        );
        const [wireLength, box] = result.value as [number, number[][]];
        expect(wireLength).toBeCloseTo(14, 9);
        expect(rounded([box[0][0], box[1][0]])).toEqual([0, 14]);
    });

    test("trims back to a crossing plane: the nearest end by default, the help point's end when given", () => {
        const nearest = run(`${WIRE} ${planeAt("p", 7)} ${trim({ trimTo: bodyOf("p") })} ${measured}`);
        expect(rounded([(nearest.value as number[])[0]])).toEqual([7]);
        const helped = run(
            `${WIRE} ${planeAt("p", 7)} ${trim({ trimTo: bodyOf("p"), helpPoint: vertexAt(0) })} ${measured}`,
        );
        const [wireLength, box] = helped.value as [number, number[][]];
        expect(wireLength).toBeCloseTo(3, 9);
        expect(rounded([box[0][0], box[1][0]])).toEqual([7, 10]);
    });

    test("a curved end and a plane missing the wire are refused", () => {
        expectError(
            `${WIRE} ${planeAt("p", 20)} ${trim({ trimTo: bodyOf("p") })}`,
            "does not cross the wire's end edge",
        );
        expectError(
            `${sketch("s1", TOP, `skArc(s, "arc", { "start" : ${mm(0, 0)}, "mid" : ${mm(5, 5)}, "end" : ${mm(10, 0)} });`)}
             opExtractWires(context, id + "w", { "edges" : ${edgesOf("s1")} });
             ${trim({
                 moveBoundaryType: "MoveCurveBoundaryType.EXTEND",
                 endCondition: "CurveExtensionEndCondition.BLIND",
                 extensionDistance: "5 * millimeter",
                 helpPoint: `qContainsPoint(qOwnedByBody(${bodyOf("w")}, EntityType.VERTEX), ${mm(10, 0, 0)})`,
             })}`,
            "only straight wire ends can move yet",
        );
    });
});

// ------------------------------------------------------------------ Spline through edges

describe("fit spline through edges", () => {
    /** A 10 mm line into a tangent quarter arc of radius 5: 10 + 2.5π long. */
    const CHAIN = sketch(
        "s1",
        TOP,
        `${segment("a", 0, 0, 10, 0)}
         skArc(s, "b", { "start" : ${mm(10, 0)}, "mid" : ${mm(10 + 5 * Math.SQRT1_2, 5 - 5 * Math.SQRT1_2)}, "end" : ${mm(15, 5)} });`,
    );
    const fit = (edges: string) =>
        featureCall("fitSpline.fs", "fitSpline", "fit", { fitType: "FitSplineType.EDGES", edges });

    test("a tangent chain becomes one spline edge running exactly along it", () => {
        const result = run(`${CHAIN} ${fit(edgesOf("s1"))}
            const edges = qOwnedByBody(${wireBodies("fit")}, EntityType.EDGE);
            return [${count(wireBodies("fit"))}, ${count("edges")}, ${length("edges")},
                    ${count(`qGeometry(edges, GeometryType.OTHER_CURVE)`)},
                    evDistance(context, { "side0" : edges, "side1" : ${mm(10 + 5 * Math.SQRT1_2, 5 - 5 * Math.SQRT1_2, 0)} }).distance / millimeter];`);
        const [wires, edges, curveLength, splines, offCurve] = result.value as number[];
        expect([wires, edges, splines]).toEqual([1, 1, 1]);
        expect(curveLength).toBeCloseTo(10 + 2.5 * Math.PI, 6);
        expect(offCurve).toBeCloseTo(0, 6);
    });

    test("a corner between the edges is refused", () => {
        expectError(
            `${sketch("s1", TOP, `${segment("a", 0, 0, 10, 0)} ${segment("b", 10, 0, 10, 10)}`)} ${fit(edgesOf("s1"))}`,
            "not tangent-continuous",
        );
    });
});

// ------------------------------------------------------------------ evDistance sides

describe("evDistance sides", () => {
    test("each side reports the winning candidate's index, witness point and parameter", () => {
        const result = run(`${sketch("s1", TOP, `${segment("a", 0, 0, 10, 0)} ${segment("b", 0, 5, 10, 5)}`)}
            const d = evDistance(context, { "side0" : [${mm(3, 9, 0)}, ${mm(4, 6, 0)}], "side1" : ${edgesOf("s1")} });
            return [d.distance / millimeter, d.sides[0].index, d.sides[0].point / millimeter, d.sides[0].parameter,
                    d.sides[1].point / millimeter, d.sides[1].parameter,
                    ${count(`qIntersection([qNthElement(${edgesOf("s1")}, d.sides[1].index), sketchEntityQuery(id + "s1", EntityType.EDGE, "b")])`)}];`);
        expect(rounded(result.value)).toEqual([1, 1, [4, 6, 0], 0, [4, 5, 0], 0.4, 1]);
    });

    test("the maximum distance between two parts", () => {
        const result = run(`${cuboid("a", [0, 0, 0], [1, 1, 1])} ${cuboid("b", [5, 0, 0], [6, 1, 1])}
            return evDistance(context, { "side0" : ${bodyOf("a")}, "side1" : ${bodyOf("b")}, "maximum" : true }).distance / millimeter;`);
        expect(result.value).toBeCloseTo(Math.sqrt(36 + 1 + 1), 6);
    });
});

// ------------------------------------------------------------------ Curve approximation

describe("composite curve approximation", () => {
    /** A 10 mm line into a tangent quarter arc of radius 5. */
    const CHAIN = sketch(
        "s1",
        TOP,
        `${segment("a", 0, 0, 10, 0)}
         skArc(s, "b", { "start" : ${mm(10, 0)}, "mid" : ${mm(10 + 5 * Math.SQRT1_2, 5 - 5 * Math.SQRT1_2)}, "end" : ${mm(15, 5)} });`,
    );

    test("the composite wire is replaced by the fitted B-spline, close to the chain", () => {
        const result = run(`${CHAIN}
            ${featureCall("compositeCurve.fs", "compositeCurve", "composite", {
                edges: `qOwnedByBody(qBodyType(${bodyOf("s1")}, BodyType.WIRE), EntityType.EDGE)`,
                approximate: "true",
                approximationDegree: "3",
                approximationMaxCPs: "30",
                approximationTolerance: "0.001 * millimeter",
                keepStartDerivative: "true",
                keepEndDerivative: "true",
                approximationShowDeviation: "true",
            })}
            const wire = qBodyType(qCreatedBy(id + "composite", EntityType.BODY), BodyType.WIRE);
            const edges = qOwnedByBody(wire, EntityType.EDGE);
            return [${count("wire")}, ${count(`qGeometry(edges, GeometryType.OTHER_CURVE)`)} == ${count("edges")},
                    ${length("edges")},
                    evMaxPathDeviation(context, { "side1" : edges, "side2" : qOwnedByBody(qBodyType(${bodyOf("s1")}, BodyType.WIRE), EntityType.EDGE) }).deviation / millimeter];`);
        const [wires, allSplines, curveLength, deviation] = result.value as [number, boolean, number, number];
        expect(wires).toBe(1);
        expect(allSplines).toBe(true);
        expect(curveLength).toBeCloseTo(10 + 2.5 * Math.PI, 2);
        // approximateSpline fits sampled positions to the tolerance; between them it may stray a little more.
        expect(deviation).toBeLessThan(0.005);
    });
});
