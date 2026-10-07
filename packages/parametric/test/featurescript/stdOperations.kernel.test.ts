// Part of the Chili3d Project, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

/**
 * Onshape's std (3083) driving the splitting, direct-editing, enclosing, wire, composite,
 * hole and mate connector operations — through std's own features (`splitPart`,
 * `sectionPart`, `deleteFace`, `moveFace`, `replaceFace`, `enclose`, `intersectionCurve`,
 * `compositePart`, `mateConnector`, `hole`) and through the `op*` calls directly — each
 * case checked against an exact analytic volume, area, length, count or position.
 */

import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { initWasm, ShapeFactory } from "@chili3d/wasm";
import { FsContext } from "../../src/featurescript/context/fsContext";
import { analyzeFeature } from "../../src/featurescript/featureSpec";
import type { Interpreter } from "../../src/featurescript/lang/interpreter";
import { describeStatus, featureState } from "../../src/featurescript/onshape/featureBuiltins";
import { createOnshapeInterpreter } from "../../src/featurescript/onshape/onshapeStd";
import { ONSHAPE_STD, STD_BUNDLE } from "./_helpers/onshapeStd";
import { stdFeatures } from "./_helpers/stdLayers";

const WASM_BINARY = readFileSync(
    path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../wasm/lib/chili-wasm.wasm"),
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
    /** Total volume of the solid parts, mm³. */
    readonly volume: number;
    readonly solids: number;
    readonly sheets: number;
    readonly wires: number;
    /** Faces of the solid parts. */
    readonly faces: number;
    /** What the build function returned, when a number, boolean or string. */
    readonly value: number | boolean | string | undefined;
    /** Every top-level feature (or operation) that reported an ERROR status. */
    readonly errors: string[];
}

let studioCount = 0;

/** Runs `body` as a Part Studio's build function (`id` is the root Id). */
function partStudio(body: string): StudioResult {
    const source = `FeatureScript 3083;
import(path : "onshape/std/geometry.fs", version : "3083.0");
export function build(context is Context)
{
    const id = newId();
${body}
}
`;
    const module = interpreter.load({ path: `stdOperations${studioCount++}`, source });
    const context = new FsContext();
    try {
        const value = interpreter.callFunction(module.env.lookup("build")?.value, [context.value]);
        const model = context.bodies.filter((b) => b.isModelGeometry);
        const solids = model.filter((b) => b.kind === "SOLID");
        return {
            volume: solids.reduce((sum, b) => sum + b.shape.volume(), 0),
            solids: solids.length,
            sheets: model.filter((b) => b.kind === "SHEET").length,
            wires: model.filter((b) => b.kind === "WIRE").length,
            faces: solids.reduce((sum, b) => sum + b.faces().length, 0),
            value:
                typeof value === "number" || typeof value === "boolean" || typeof value === "string"
                    ? value
                    : undefined,
            errors: featureErrors(context),
        };
    } finally {
        context.dispose();
    }
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

interface Case {
    readonly name: string;
    readonly body: string;
    readonly volume?: number;
    readonly solids?: number;
    readonly sheets?: number;
    readonly wires?: number;
    readonly faces?: number;
    readonly value?: number | boolean | string;
}

function expectStudio({ name: _name, body, volume, value, ...counts }: Case): void {
    const result = partStudio(body);
    expect(result.errors).toEqual([]);
    expect(result).toMatchObject({
        ...counts,
        ...(volume === undefined ? {} : { volume: expect.closeTo(volume, 3) }),
        ...(value === undefined
            ? {}
            : { value: typeof value === "number" ? expect.closeTo(value, 4) : value }),
    });
}

/** Runs `body` and expects it to fail — a feature's error status, or an op* call throwing — with `message`. */
function expectError(body: string, message: string): void {
    let errors: string[];
    try {
        errors = partStudio(body).errors;
    } catch (error) {
        errors = [error instanceof Error ? error.message : String(error)];
    }
    expect(errors).toHaveLength(1);
    expect(errors[0]).toContain(message);
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
const atZ = (z: number) => `plane(${mm(0, 0, z)}, vector(0, 0, 1))`;
const cuboid = (name: string, from: number[], to: number[]) =>
    `fCuboid(context, id + "${name}", { "corner1" : ${mm(...from)}, "corner2" : ${mm(...to)} });`;
/** A 20 x 20 x 10 block (4000 mm³) at the origin. */
const BOX = cuboid("box", [0, 0, 0], [20, 20, 10]);
const bodyOf = (name: string) => `qCreatedBy(id + "${name}", EntityType.BODY)`;
const facesOf = (name: string) => `qCreatedBy(id + "${name}", EntityType.FACE)`;
const faceOn = (name: string, plane: string) => `qCoincidesWithPlane(${facesOf(name)}, ${plane})`;
const BOX_TOP = faceOn("box", atZ(10));
/** The box's face at x = 20. */
const BOX_SIDE = faceOn("box", `plane(${mm(20, 0, 0)}, vector(1, 0, 0))`);
const count = (query: string) => `size(evaluateQuery(context, ${query}))`;
const area = (query: string) => `evArea(context, { "entities" : ${query} }) / millimeter ^ 2`;
const length = (query: string) => `evLength(context, { "entities" : ${query} }) / millimeter`;
const volume = (query: string) => `evVolume(context, { "entities" : ${query} }) / millimeter ^ 3`;
const sketch = (name: string, plane: string, entities: string) =>
    `{ const s = newSketchOnPlane(context, id + "${name}", { "sketchPlane" : ${plane} });
       ${entities}
       skSolve(s); }`;
const segment = (name: string, x0: number, y0: number, x1: number, y1: number) =>
    `skLineSegment(s, "${name}", { "start" : ${mm(x0, y0)}, "end" : ${mm(x1, y1)} });`;
/** A cylinder of radius `r` along Z, from z0 to z1, centred on (x, y). */
const cylinder = (name: string, x: number, y: number, z0: number, z1: number, r: number) =>
    `fCylinder(context, id + "${name}", { "bottomCenter" : ${mm(x, y, z0)}, "topCenter" : ${mm(x, y, z1)}, "radius" : ${r} * millimeter });`;
const union = (...names: string[]) =>
    `booleanBodies(context, id + "union", { "tools" : qUnion([${names.map(bodyOf).join(", ")}]), "operationType" : BooleanOperationType.UNION });`;
const subtract = (target: string, tool: string) =>
    `booleanBodies(context, id + "cut", { "targets" : ${bodyOf(target)}, "tools" : ${bodyOf(tool)}, "operationType" : BooleanOperationType.SUBTRACTION });`;
/** The box with a boss of radius 3 rising 5 above its top center (4000 + 45π mm³). */
const BOSSED = `${BOX} ${cylinder("boss", 10, 10, 10, 15, 3)} ${union("box", "boss")}`;
/** The box with a through hole of radius 3 at its center (4000 - 90π mm³). */
const HOLED = `${BOX} ${cylinder("drill", 10, 10, -1, 11, 3)} ${subtract("box", "drill")}`;

// ------------------------------------------------------------------ Split part

describe("split part", () => {
    const splitAt = (z: number) =>
        `opPlane(context, id + "p", { "plane" : ${atZ(z)} });
         splitPart(context, id + "split", { "targets" : ${bodyOf("box")}, "tool" : ${bodyOf("p")} });`;

    test.each<Case>([
        {
            name: "splitPart by a construction plane keeps both sides",
            body: `${BOX} ${splitAt(4)} return ${count(bodyOf("split"))};`,
            volume: 4000,
            solids: 2,
            faces: 12,
            value: 1,
        },
        {
            name: "splitPart by a planar face extends the face's plane",
            body: `${BOX} ${cuboid("cutter", [30, 0, 0], [40, 5, 6])}
                splitPart(context, id + "split", { "targets" : ${bodyOf("box")}, "tool" : ${faceOn("cutter", atZ(6))} });`,
            volume: 4300,
            solids: 3,
        },
        {
            name: "splitPart keeping the front only",
            body: `${BOX} opPlane(context, id + "p", { "plane" : ${atZ(4)} });
                splitPart(context, id + "split", { "targets" : ${bodyOf("box")}, "tool" : ${bodyOf("p")},
                    "keepBothSides" : false, "keepFront" : true });`,
            volume: 2400,
            solids: 1,
        },
        {
            name: "splitPart keeping the back only",
            body: `${BOX} opPlane(context, id + "p", { "plane" : ${atZ(4)} });
                splitPart(context, id + "split", { "targets" : ${bodyOf("box")}, "tool" : ${bodyOf("p")},
                    "keepBothSides" : false, "keepFront" : false });`,
            volume: 1600,
            solids: 1,
        },
        {
            name: "splitPart by a mate connector cuts along its XY plane",
            body: `${BOX} ${featureCall("mateConnector.fs", "mateConnector", "mc", {
                originQuery: BOX_TOP,
                entityInferenceType: "EntityInferenceType.CENTROID",
                ownerPart: bodyOf("box"),
                transform: "true",
                translationZ: "-4 * millimeter",
            })}
                splitPart(context, id + "split", { "targets" : ${bodyOf("box")}, "tool" : ${bodyOf("mc")} });
                return ${volume(`qSplitBy(id + "split", EntityType.BODY, false)`)};`,
            volume: 4000,
            solids: 2,
            value: 1600,
        },
        {
            name: "sectionPart keeps what lies behind the plane",
            body: `${BOX} sectionPart(context, id + "section", { "targets" : ${bodyOf("box")}, "plane" : ${atZ(4)} });`,
            volume: 1600,
            solids: 1,
        },
    ])("$name", (featureCase) => expectStudio(featureCase));

    test("qSplitBy names the pieces on each side and the faces that were split", () => {
        const split = `${BOX} opSplitPart(context, id + "split", { "targets" : ${bodyOf("box")}, "tool" : ${atZ(4)} });`;
        const side = (kind: string, back: boolean) => `qSplitBy(id + "split", EntityType.${kind}, ${back})`;
        expect(partStudio(`${split} return ${volume(side("BODY", false))};`).value).toBeCloseTo(2400, 6);
        expect(partStudio(`${split} return ${volume(side("BODY", true))};`).value).toBeCloseTo(1600, 6);
        // The four side faces were split; the caps and the new cut faces were not.
        expect(partStudio(`${split} return ${area(side("FACE", false))};`).value).toBeCloseTo(480, 6);
        expect(partStudio(`${split} return ${area(side("FACE", true))};`).value).toBeCloseTo(320, 6);
        expect(partStudio(`${split} return ${count(side("EDGE", true))};`).value).toBe(4);
    });

    test("the pieces keep the target's faces; only the cut faces are new", () => {
        const result = partStudio(`${BOX}
            opSplitPart(context, id + "split", { "targets" : ${bodyOf("box")}, "tool" : ${atZ(4)} });
            return ${count(facesOf("box"))} * 100 + ${count(facesOf("split"))};`);
        expect(result.value).toBe(1000 + 2);
    });

    test("a plane missing the part leaves it whole and qSplitBy empty", () => {
        const result = partStudio(`${BOX}
            opSplitPart(context, id + "split", { "targets" : ${bodyOf("box")}, "tool" : ${atZ(40)} });
            return ${count(`qSplitBy(id + "split", EntityType.BODY, true)`)};`);
        expect(result).toMatchObject({ errors: [], solids: 1, value: 0, volume: expect.closeTo(4000, 6) });
    });

    test("a sheet tool cuts a solid along its own surface and is consumed", () => {
        // The side face of a cylinder (r = 5) around the box's center, as a sheet.
        const result = partStudio(`${BOX} ${cylinder("cyl", 10, 10, -5, 15, 5)}
            opExtractSurface(context, id + "wall", { "faces" : qGeometry(${facesOf("cyl")}, GeometryType.CYLINDER) });
            opDeleteBodies(context, id + "delete", { "entities" : ${bodyOf("cyl")} });
            splitPart(context, id + "split", { "targets" : ${bodyOf("box")}, "tool" : ${bodyOf("wall")} });
            return ${volume(`qSplitBy(id + "split", EntityType.BODY, false)`)};`);
        expect(result).toMatchObject({ errors: [], solids: 2, sheets: 0 });
        expect(result.volume).toBeCloseTo(4000, 4);
        // The cylinder's normal points away from its axis: the part outside is in front.
        expect(result.value).toBeCloseTo(4000 - 250 * Math.PI, 4);
    });

    test("opSplitPart splits sheets and wires by a plane", () => {
        const sheet = partStudio(`${sketch("s1", atZ(0), segment("l", 0, 0, 20, 0))}
            opExtrude(context, id + "wall", { "entities" : qCreatedBy(id + "s1", EntityType.EDGE),
                "direction" : vector(0, 0, 1), "endBound" : BoundingType.BLIND, "endDepth" : 10 * millimeter });
            opSplitPart(context, id + "split", { "targets" : ${bodyOf("wall")}, "tool" : plane(${mm(5, 0, 0)}, vector(1, 0, 0)) });
            return ${area(`qSplitBy(id + "split", EntityType.BODY, true)`)};`);
        expect(sheet).toMatchObject({ errors: [], sheets: 2, value: expect.closeTo(50, 6) });
        const wire =
            partStudio(`opPolyline(context, id + "line", { "points" : [${mm(0, 0, 0)}, ${mm(10, 0, 0)}, ${mm(10, 10, 0)}] });
            opSplitPart(context, id + "split", { "targets" : ${bodyOf("line")}, "tool" : plane(${mm(4, 0, 0)}, vector(1, 0, 0)) });
            return ${length(`qSplitBy(id + "split", EntityType.BODY, false)`)};`);
        expect(wire).toMatchObject({ errors: [], wires: 2, value: expect.closeTo(16, 6) });
    });

    test("a sheet tool cannot split a sheet", () => {
        expectError(
            `${sketch("s1", atZ(0), segment("l", 0, 0, 20, 0))}
            opExtrude(context, id + "wall", { "entities" : qCreatedBy(id + "s1", EntityType.EDGE),
                "direction" : vector(0, 0, 1), "endBound" : BoundingType.BLIND, "endDepth" : 10 * millimeter });
            ${cylinder("cyl", 10, 0, -5, 15, 5)}
            opExtractSurface(context, id + "tool", { "faces" : qGeometry(${facesOf("cyl")}, GeometryType.CYLINDER) });
            opSplitPart(context, id + "split", { "targets" : ${bodyOf("wall")}, "tool" : ${bodyOf("tool")} });`,
            "splits sheet and wire bodies by planes only",
        );
    });
});

// ------------------------------------------------------------------ Split faces and edges

describe("split faces and edges", () => {
    const X_EDGES = `qParallelEdges(qCreatedBy(id + "box", EntityType.EDGE), X_DIRECTION)`;
    const boxCount = (kind: string) => count(`qOwnedByBody(${bodyOf("box")}, EntityType.${kind})`);

    test.each<Case>([
        {
            name: "splitPart splits a face where a plane crosses it",
            body: `${BOX} opPlane(context, id + "p", { "plane" : plane(${mm(5, 0, 0)}, vector(1, 0, 0)) });
                splitPart(context, id + "split", { "splitType" : SplitType.FACE, "faceTargets" : ${BOX_TOP}, "faceTools" : ${facesOf("p")} });
                return ${boxCount("FACE")} * 1e6 + ${area(`qSplitBy(id + "split", EntityType.FACE, false)`)} * 1e3
                    + ${area(`qSplitBy(id + "split", EntityType.FACE, true)`)};`,
            volume: 4000,
            faces: 7,
            value: 7e6 + 300e3 + 100,
        },
        {
            name: "opSplitFace imprints a sketch circle and returns the splitting edge",
            body: `${BOX} ${sketch("s1", atZ(10), `skCircle(s, "c", { "center" : ${mm(10, 10)}, "radius" : 4 * millimeter });`)}
                const r = opSplitFace(context, id + "split", { "faceTargets" : ${BOX_TOP},
                    "edgeTools" : qBodyType(qCreatedBy(id + "s1", EntityType.EDGE), BodyType.WIRE) });
                return ${area(`qContainsPoint(${BOX_TOP}, ${mm(10, 10, 10)})`)} + size(r.splittingEdges) * 1e3;`,
            faces: 7,
            // Both pieces of the top remain the box's faces (the disc is the one at the center).
            value: 16 * Math.PI + 1e3,
        },
        {
            name: "opSplitEdges cuts an edge at fractions of its length",
            body: `${BOX} opSplitEdges(context, id + "split", { "edges" : qNthElement(${X_EDGES}, 0), "parameters" : [[0.25, 0.5]] });
                return ${boxCount("EDGE")} * 100 + ${count(`qWithinRadius(qOwnedByBody(${bodyOf("box")}, EntityType.VERTEX), ${mm(5, 0, 0)}, 1e-3 * millimeter)`)};`,
            faces: 6,
            value: 14 * 100 + 1,
        },
        {
            name: "opSplitEdges cuts edges where a plane crosses them",
            body: `${BOX} opSplitEdges(context, id + "split", { "edges" : ${X_EDGES}, "splittingSurface" : plane(${mm(5, 0, 0)}, vector(1, 0, 0)) });
                return ${boxCount("EDGE")};`,
            value: 16,
        },
    ])("$name", (featureCase) => expectStudio(featureCase));
});

// ------------------------------------------------------------------ Modify fillet

describe("modify fillet", () => {
    const FILLETED = `${BOX} fillet(context, id + "f", { "entities" : qNthElement(qParallelEdges(qCreatedBy(id + "box", EntityType.EDGE), Z_DIRECTION), 0), "radius" : 2 * millimeter });`;
    const FILLET_FACE = `qGeometry(${facesOf("f")}, GeometryType.CYLINDER)`;
    /** The material a fillet of radius r takes off a 10 mm tall edge. */
    const loss = (r: number) => (1 - Math.PI / 4) * r * r * 10;

    test.each<Case>([
        {
            name: "removing a fillet restores the sharp edge",
            body: `${FILLETED} modifyFillet(context, id + "modify", { "faces" : ${FILLET_FACE}, "modifyFilletType" : ModifyFilletType.REMOVE_FILLET });`,
            volume: 4000,
            faces: 6,
        },
        {
            name: "changing a fillet's radius keeps the fillet face",
            body: `${FILLETED} modifyFillet(context, id + "modify", { "faces" : ${FILLET_FACE}, "modifyFilletType" : ModifyFilletType.CHANGE_RADIUS,
                    "radius" : 3 * millimeter, "reFillet" : false });
                return evFilletRadius(context, { "face" : ${FILLET_FACE} }) / millimeter;`,
            volume: 4000 - loss(3),
            faces: 7,
            value: 3,
        },
    ])("$name", (featureCase) => expectStudio(featureCase));

    test("a face that is not a fillet is refused", () => {
        expectError(
            `${BOX} opModifyFillet(context, id + "modify", { "faces" : ${BOX_TOP}, "modifyFilletType" : ModifyFilletType.REMOVE_FILLET });`,
            "fillet faces only",
        );
    });
});

// ------------------------------------------------------------------ Delete face

describe("delete face", () => {
    const deleteFace = (faces: string, healType: string, includeFillet = false) =>
        `deleteFace(context, id + "delete", { "deleteFaces" : ${faces}, "healType" : DeleteFaceType.${healType}, "includeFillet" : ${includeFillet} });`;

    test.each<Case>([
        {
            name: "healing removes a boss: the top face extends over it",
            body: `${BOSSED} ${deleteFace(facesOf("boss"), "HEAL")} return ${count(facesOf("box"))};`,
            volume: 4000,
            faces: 6,
            value: 6,
        },
        {
            name: "healing fills a through hole",
            body: `${HOLED} ${deleteFace(`qGeometry(qOwnedByBody(${bodyOf("box")}, EntityType.FACE), GeometryType.CYLINDER)`, "HEAL")}`,
            volume: 4000,
            faces: 6,
        },
        {
            name: "healing removes a fillet",
            body: `${BOX} fillet(context, id + "f", { "entities" : qNthElement(qParallelEdges(qCreatedBy(id + "box", EntityType.EDGE), Z_DIRECTION), 0), "radius" : 2 * millimeter });
                ${deleteFace(`qGeometry(qOwnedByBody(${bodyOf("box")}, EntityType.FACE), GeometryType.CYLINDER)`, "HEAL")}`,
            volume: 4000,
            faces: 6,
        },
        {
            name: "deleting a boss with a fillet at its foot deletes the fillet too",
            body: `${BOSSED} fillet(context, id + "f", { "entities" : qGeometry(qCoincidesWithPlane(qOwnedByBody(${bodyOf("box")}, EntityType.EDGE), ${atZ(10)}), GeometryType.CIRCLE), "radius" : 1 * millimeter });
                ${deleteFace(facesOf("boss"), "HEAL", true)}`,
            volume: 4000,
            faces: 6,
        },
        {
            name: "capping replaces the boss top that cannot heal with a plane",
            body: `${BOSSED} ${deleteFace(faceOn("boss", atZ(15)), "CAP")}`,
            volume: 4000 + 45 * Math.PI,
            faces: 8,
        },
        {
            name: "leaving the void open makes the part a surface",
            body: `${BOX} ${deleteFace(BOX_TOP, "VOID")} return ${area(bodyOf("box"))};`,
            solids: 0,
            sheets: 1,
            value: 1200,
        },
    ])("$name", (featureCase) => expectStudio(featureCase));

    test("a face that neither heals nor caps is an error", () => {
        expectError(`${BOX} ${deleteFace(BOX_TOP, "HEAL")}`, "could not heal");
    });
});

// ------------------------------------------------------------------ Extract, enclose, flip

describe("extract surface, enclose and flip orientation", () => {
    test.each<Case>([
        {
            name: "opExtractSurface copies a face into a new sheet body",
            body: `${BOX} opExtractSurface(context, id + "ex", { "faces" : ${BOX_TOP} }); return ${area(bodyOf("ex"))};`,
            volume: 4000,
            sheets: 1,
            value: 400,
        },
        {
            name: "opExtractSurface makes one sheet per connected set of faces",
            body: `${BOX} opExtractSurface(context, id + "ex", { "faces" : qUnion([${BOX_TOP}, ${faceOn("box", atZ(0))}]) });
                return ${count(bodyOf("ex"))};`,
            sheets: 2,
            value: 2,
        },
        {
            name: "opExtractSurface offsets planar faces along their normal",
            body: `${BOX} opExtractSurface(context, id + "ex", { "faces" : ${BOX_TOP}, "offset" : 5 * millimeter });
                return evBox3d(context, { "topology" : ${bodyOf("ex")} }).minCorner[2] / millimeter;`,
            value: 15,
        },
        {
            name: "enclose turns a closed set of sheets into a part, consuming them",
            body: `${BOX} opExtractSurface(context, id + "ex", { "faces" : ${facesOf("box")} });
                opDeleteBodies(context, id + "delete", { "entities" : ${bodyOf("box")} });
                enclose(context, id + "enclose", { "entities" : ${bodyOf("ex")} });`,
            volume: 4000,
            solids: 1,
            sheets: 0,
        },
        {
            name: "enclose trims crossing sheets to the region they bound",
            // Four walls in a # pattern and two plates, all overhanging the 20 x 20 x 10 cell.
            body: `${sketch(
                "walls",
                atZ(-5),
                segment("a", -10, 0, 30, 0) +
                    segment("b", -10, 20, 30, 20) +
                    segment("c", 0, -10, 0, 30) +
                    segment("d", 20, -10, 20, 30),
            )}
                opExtrude(context, id + "w", { "entities" : qBodyType(qCreatedBy(id + "walls", EntityType.EDGE), BodyType.WIRE),
                    "direction" : vector(0, 0, 1), "endBound" : BoundingType.BLIND, "endDepth" : 20 * millimeter });
                ${cuboid("plate", [-10, -10, 0], [30, 30, 10])}
                opExtractSurface(context, id + "plates", { "faces" : qParallelPlanes(${facesOf("plate")}, Z_DIRECTION) });
                opDeleteBodies(context, id + "delete", { "entities" : ${bodyOf("plate")} });
                enclose(context, id + "enclose", { "entities" : qUnion([${bodyOf("w")}, ${bodyOf("plates")}]), "keepTools" : true });`,
            volume: 4000,
            solids: 1,
            sheets: 6,
        },
    ])("$name", (featureCase) => expectStudio(featureCase));

    test("opExtractSurface refuses an offset of curved faces", () => {
        expectError(
            `${cylinder("cyl", 0, 0, 0, 10, 5)} opExtractSurface(context, id + "ex", { "faces" : ${facesOf("cyl")}, "offset" : 1 * millimeter });`,
            "offsets planar faces sharing one normal only",
        );
    });

    test("opFlipOrientation reverses a sheet's normal", () => {
        const normal = (flip: boolean) =>
            partStudio(`${BOX} opExtractSurface(context, id + "ex", { "faces" : ${BOX_TOP} });
                ${flip ? `opFlipOrientation(context, id + "flip", { "bodies" : ${bodyOf("ex")} });` : ""}
                return evFaceTangentPlane(context, { "face" : ${facesOf("ex")}, "parameter" : vector(0.5, 0.5) }).normal[2];`)
                .value;
        expect(normal(false)).toBeCloseTo(1, 9);
        expect(normal(true)).toBeCloseTo(-1, 9);
    });
});

// ------------------------------------------------------------------ Move, offset and replace faces

describe("move, offset and replace faces", () => {
    const moveFace = (fields: string) =>
        `moveFace(context, id + "move", { "moveFaces" : ${BOX_TOP}, ${fields} });`;

    test.each<Case>([
        {
            name: "moveFace offsets the top face outward, keeping it the box's",
            body: `${BOX} ${moveFace(`"moveFaceType" : MoveFaceType.OFFSET, "offsetDistance" : 3 * millimeter`)}
                return ${count(facesOf("box"))};`,
            volume: 5200,
            faces: 6,
            value: 6,
        },
        {
            name: "moveFace offsets in the opposite direction",
            body: `${BOX} ${moveFace(`"moveFaceType" : MoveFaceType.OFFSET, "offsetDistance" : 3 * millimeter, "oppositeDirection" : true`)}`,
            volume: 2800,
            faces: 6,
        },
        {
            name: "moveFace translates the top face along a direction",
            body: `${BOX} ${moveFace(`"moveFaceType" : MoveFaceType.TRANSLATE, "direction" : ${BOX_TOP}, "translationDistance" : 3 * millimeter`)}`,
            volume: 5200,
            faces: 6,
        },
        {
            name: "a face translated along itself does not move",
            body: `${BOX} opMoveFace(context, id + "move", { "moveFaces" : ${BOX_TOP}, "transform" : transform(${mm(5, 2, 0)}) });`,
            volume: 4000,
            faces: 6,
        },
        {
            name: "opOffsetFace inward keeps the face (now at z = 6) the box's",
            body: `${BOX} opOffsetFace(context, id + "offset", { "moveFaces" : ${BOX_TOP}, "offsetDistance" : -4 * millimeter });
                return ${count(faceOn("box", atZ(6)))};`,
            volume: 2400,
            faces: 6,
            value: 1,
        },
        {
            name: "opOffsetFace of two adjacent faces fills the corner",
            body: `${BOX} opOffsetFace(context, id + "offset", { "moveFaces" : qUnion([${BOX_TOP}, ${BOX_SIDE}]), "offsetDistance" : 2 * millimeter });`,
            volume: 22 * 20 * 12,
            faces: 6,
        },
        {
            // The hole wall stays in two faces: the kernel's face unification does not merge
            // two full cylinders meeting along a circle.
            name: "opOffsetFace extends a hole through the moved face",
            body: `${HOLED} opOffsetFace(context, id + "offset", { "moveFaces" : ${BOX_TOP}, "offsetDistance" : 5 * millimeter });`,
            volume: (400 - 9 * Math.PI) * 15,
            faces: 8,
        },
        {
            name: "replaceFace moves the top face onto a parallel template",
            body: `${BOX} ${cuboid("template", [30, 0, 0], [40, 5, 14])}
                replaceFace(context, id + "replace", { "replaceFaces" : ${BOX_TOP}, "templateFace" : ${faceOn("template", atZ(14))},
                    "offset" : 1 * millimeter, "oppositeSense" : false });`,
            volume: 6000 + 700,
            solids: 2,
        },
    ])("$name", (featureCase) => expectStudio(featureCase));

    test.each([
        {
            name: "a rotation",
            body: `opMoveFace(context, id + "move", { "moveFaces" : ${BOX_TOP}, "transform" : rotationAround(line(${mm(0, 0, 10)}, vector(1, 0, 0)), 5 * degree) });`,
            message: "translations only",
        },
        {
            name: "a face beside a chamfer",
            body: `chamfer(context, id + "c", { "entities" : qNthElement(qParallelEdges(qAdjacent(${BOX_TOP}, AdjacencyType.EDGE, EntityType.EDGE), X_DIRECTION), 0), "width" : 2 * millimeter });
                opOffsetFace(context, id + "offset", { "moveFaces" : ${BOX_TOP}, "offsetDistance" : 1 * millimeter });`,
            message: "neighbours of a moved face to extend along its normal",
        },
        {
            name: "a curved face",
            body: `${cylinder("cyl", 10, 10, 10, 15, 3)} opOffsetFace(context, id + "offset", { "moveFaces" : qGeometry(${facesOf("cyl")}, GeometryType.CYLINDER), "offsetDistance" : 1 * millimeter });`,
            message: "planar faces only",
        },
    ])("moving $name is refused", ({ body, message }) => expectError(`${BOX} ${body}`, message));
});

// ------------------------------------------------------------------ Wires

describe("wire operations", () => {
    test.each<Case>([
        {
            name: "opPolyline with a bend",
            body: `opPolyline(context, id + "line", { "points" : [${mm(0, 0, 0)}, ${mm(10, 0, 0)}, ${mm(10, 10, 0)}], "bendRadii" : [2 * millimeter] });
                return ${length(bodyOf("line"))};`,
            wires: 1,
            value: 16 + Math.PI,
        },
        {
            name: "a closed opPolyline bent at every corner",
            body: `opPolyline(context, id + "line", { "points" : [${mm(0, 0, 0)}, ${mm(20, 0, 0)}, ${mm(20, 20, 0)}, ${mm(0, 20, 0)}, ${mm(0, 0, 0)}],
                    "bendRadii" : [2 * millimeter, 2 * millimeter, 2 * millimeter, 2 * millimeter] });
                return ${length(bodyOf("line"))} * 100 + ${count(`qCreatedBy(id + "line", EntityType.EDGE)`)};`,
            wires: 1,
            value: (64 + 4 * Math.PI) * 100 + 8,
        },
        {
            name: "opExtractWires chains a face's edges into one wire",
            body: `${BOX} opExtractWires(context, id + "w", { "edges" : qAdjacent(${BOX_TOP}, AdjacencyType.EDGE, EntityType.EDGE) });
                return ${length(bodyOf("w"))};`,
            wires: 1,
            value: 80,
        },
        {
            name: "opExtractWires makes one wire per disjoint chain",
            body: `${BOX} opExtractWires(context, id + "w", { "edges" : qParallelEdges(${`qCreatedBy(id + "box", EntityType.EDGE)`}, Z_DIRECTION) });
                return ${count(bodyOf("w"))};`,
            wires: 4,
            value: 4,
        },
        {
            name: "the intersection curve feature",
            body: `${BOX} ${cuboid("b2", [10, 10, 5], [30, 30, 20])}
                intersectionCurve(context, id + "i", { "group1" : ${bodyOf("box")}, "group2" : ${bodyOf("b2")} });
                return ${length(bodyOf("i"))};`,
            wires: 1,
            value: 50,
        },
        {
            name: "a bridging curve between two points is a straight Bézier",
            body: `${sketch("s1", atZ(0), segment("a", 0, 0, 10, 0) + segment("b", 20, 5, 30, 5))}
                ${featureCall("bridgingCurve.fs", "bridgingCurve", "bridge", {
                    side1: `qContainsPoint(qBodyType(qCreatedBy(id + "s1", EntityType.VERTEX), BodyType.WIRE), ${mm(10, 0, 0)})`,
                    side2: `qContainsPoint(qBodyType(qCreatedBy(id + "s1", EntityType.VERTEX), BodyType.WIRE), ${mm(20, 5, 0)})`,
                    match1: "BridgingCurveMatchType.POSITION",
                    match2: "BridgingCurveMatchType.POSITION",
                })}
                return ${length(bodyOf("bridge"))};`,
            wires: 1,
            value: Math.hypot(10, 5),
        },
        {
            name: "opCreateBSplineCurve of degree 1 is the control polygon, one edge per span",
            body: `opCreateBSplineCurve(context, id + "c", { "bSplineCurve" : bSplineCurve({ "degree" : 1, "isPeriodic" : false,
                    "controlPoints" : [${mm(0, 0, 0)}, ${mm(10, 0, 0)}, ${mm(10, 10, 0)}] }) });
                return ${length(bodyOf("c"))} * 100 + ${count(`qCreatedBy(id + "c", EntityType.EDGE)`)};`,
            wires: 1,
            value: 2000 + 2,
        },
        {
            name: "a rational opCreateBSplineCurve is an exact quarter circle",
            body: `opCreateBSplineCurve(context, id + "c", { "bSplineCurve" : bSplineCurve({ "degree" : 2, "isPeriodic" : false,
                    "controlPoints" : [${mm(10, 0, 0)}, ${mm(10, 10, 0)}, ${mm(0, 10, 0)}], "weights" : [1, ${Math.SQRT1_2}, 1] }) });
                return ${length(bodyOf("c"))};`,
            wires: 1,
            value: 5 * Math.PI,
        },
    ])("$name", (featureCase) => expectStudio(featureCase));

    test("a periodic opCreateBSplineCurve runs through the spline's own points, one edge per span", () => {
        const result = partStudio(`const c = bSplineCurve({ "degree" : 3, "isPeriodic" : true,
                "controlPoints" : [${mm(0, 0, 0)}, ${mm(10, 0, 0)}, ${mm(10, 10, 0)}, ${mm(0, 10, 5)}, ${mm(-5, 5, 2)}] });
            opCreateBSplineCurve(context, id + "c", { "bSplineCurve" : c });
            const lo = c.knots[c.degree];
            const hi = c.knots[size(c.knots) - 1 - c.degree];
            var on = 0;
            for (var f in [0.05, 0.3, 0.55, 0.8, 0.95])
            {
                const p = evaluateSpline({ "spline" : c, "parameters" : [lo + f * (hi - lo)] })[0][0];
                if (!isQueryEmpty(context, qContainsPoint(qCreatedBy(id + "c", EntityType.EDGE), p)))
                    on += 1;
            }
            return on * 100 + ${count(`qCreatedBy(id + "c", EntityType.EDGE)`)};`);
        expect(result).toMatchObject({ errors: [], wires: 1, value: 5 * 100 + 5 });
    });

    test("opExtractWires refuses a branching chain", () => {
        expectError(
            `${BOX} opExtractWires(context, id + "w", { "edges" : qAdjacent(qNthElement(qCreatedBy(id + "box", EntityType.VERTEX), 0), AdjacencyType.VERTEX, EntityType.EDGE) });`,
            "more than two edges meet",
        );
    });
});

// ------------------------------------------------------------------ Composite parts and names

describe("composite parts and named entities", () => {
    const parts = `${BOX} ${cuboid("b2", [30, 0, 0], [40, 10, 10])} ${cuboid("b3", [50, 0, 0], [60, 10, 10])}`;
    const composite = (closed: boolean) =>
        `compositePart(context, id + "comp", { "bodies" : qUnion([${bodyOf("box")}, ${bodyOf("b2")}]), "closed" : ${closed} });`;
    const COMPOSITE = bodyOf("comp");

    test.each<Case>([
        {
            name: "a composite part groups its constituents",
            body: `${parts} ${composite(false)} return ${count(`qContainedInCompositeParts(${COMPOSITE})`)};`,
            volume: 6000,
            solids: 3,
            value: 2,
        },
        {
            name: "a composite part is a body of type COMPOSITE",
            body: `${parts} ${composite(false)} return ${count(`qBodyType(qEverything(EntityType.BODY), BodyType.COMPOSITE)`)};`,
            value: 1,
        },
        {
            name: "a closed composite consumes its constituents",
            body: `${parts} ${composite(true)} return ${count(`qConsumed(qEverything(EntityType.BODY), Consumed.YES)`)} * 10
                + ${count(`qConsumed(qBodyType(qEverything(EntityType.BODY), BodyType.SOLID), Consumed.NO)`)};`,
            value: 21,
        },
        {
            name: "an open composite consumes nothing",
            body: `${parts} ${composite(false)} return ${count(`qConsumed(qEverything(EntityType.BODY), Consumed.YES)`)};`,
            value: 0,
        },
        {
            name: "qCompositePartsContaining finds the composite of a constituent, by type",
            body: `${parts} ${composite(true)} return ${count(`qCompositePartsContaining(${bodyOf("b2")})`)} * 100
                + ${count(`qCompositePartsContaining(${bodyOf("b2")}, CompositePartType.OPEN)`)} * 10
                + ${count(`qCompositePartsContaining(${bodyOf("b3")})`)};`,
            value: 100,
        },
        {
            name: "qCompositePartTypeFilter tells closed from open",
            body: `${parts} ${composite(true)} return ${count(`qCompositePartTypeFilter(qEverything(EntityType.BODY), CompositePartType.CLOSED)`)};`,
            value: 1,
        },
        {
            name: "flattening a composite yields its constituents",
            body: `${parts} ${composite(false)} return ${volume(`qFlattenedCompositeParts(${COMPOSITE})`)};`,
            value: 5000,
        },
        {
            name: "opModifyCompositePart adds and removes constituents",
            body: `${parts} ${composite(false)}
                opModifyCompositePart(context, id + "modify", { "composite" : ${COMPOSITE}, "toAdd" : ${bodyOf("b3")}, "toRemove" : ${bodyOf("box")} });
                return ${volume(`qContainedInCompositeParts(${COMPOSITE})`)};`,
            value: 2000,
        },
        {
            name: "opNameEntity names a face for qNamed",
            body: `${BOX} opNameEntity(context, id + "name", { "entity" : ${BOX_TOP}, "entityName" : "lid" });
                opOffsetFace(context, id + "offset", { "moveFaces" : ${BOX_TOP}, "offsetDistance" : 2 * millimeter });
                return evBox3d(context, { "topology" : qNamed("lid") }).minCorner[2] / millimeter;`,
            value: 12,
        },
    ])("$name", (featureCase) => expectStudio(featureCase));
});

// ------------------------------------------------------------------ Merging contexts

describe("merging contexts", () => {
    test("opMergeContexts copies another context's parts and tracks queries through the merge", () => {
        const result = partStudio(`${BOX}
            var other = newContext();
            fCuboid(other, makeId("part"), { "corner1" : ${mm(30, 0, 0)}, "corner2" : ${mm(40, 10, 10)} });
            fCuboid(other, makeId("small"), { "corner1" : ${mm(50, 0, 0)}, "corner2" : ${mm(51, 1, 1)} });
            const tracked = opMergeContexts(context, id + "merge", { "contextFrom" : other,
                "trackThroughMerge" : [qCreatedBy(makeId("part"), EntityType.BODY), qCreatedBy(makeId("small"), EntityType.FACE)] });
            return ${volume(`qUnion(tracked[0])`)} * 100 + size(tracked[1]);`);
        expect(result).toMatchObject({ errors: [], solids: 3, value: expect.closeTo(1000 * 100 + 6, 6) });
        expect(result.volume).toBeCloseTo(4000 + 1000 + 1, 6);
    });
});

// ------------------------------------------------------------------ Mate connectors

describe("mate connectors", () => {
    const connector = (overrides: Record<string, string>) =>
        featureCall("mateConnector.fs", "mateConnector", "mc", {
            originQuery: BOX_TOP,
            entityInferenceType: "EntityInferenceType.CENTROID",
            ownerPart: bodyOf("box"),
            ...overrides,
        });
    const cs = `evMateConnector(context, { "mateConnector" : ${bodyOf("mc")} })`;
    /** The coordinate system: origin (mm), x axis, z axis. */
    const report = `const c = ${cs};
        return [c.origin[0] / millimeter, c.origin[1] / millimeter, c.origin[2] / millimeter,
            c.xAxis[0], c.xAxis[1], c.xAxis[2], c.zAxis[0], c.zAxis[1], c.zAxis[2]];`;
    const frame = (body: string): number[] => {
        const source = `FeatureScript 3083;
import(path : "onshape/std/geometry.fs", version : "3083.0");
export function build(context is Context)
{
    const id = newId();
    ${body}
}
`;
        const module = interpreter.load({ path: `stdOperations${studioCount++}`, source });
        const context = new FsContext();
        try {
            const value = interpreter.callFunction(module.env.lookup("build")?.value, [context.value]);
            expect(featureErrors(context)).toEqual([]);
            return (value as unknown as { items: number[] }).items.map((n) => Math.round(n * 1e9) / 1e9);
        } finally {
            context.dispose();
        }
    };

    test("a mate connector on a face sits at its centroid, along its normal", () => {
        expect(frame(`${BOX} ${connector({})} ${report}`)).toEqual([10, 10, 10, 1, 0, 0, 0, 0, 1]);
    });

    test("a mate connector is a body of type MATE_CONNECTOR, owned by its part, not a part", () => {
        const result = partStudio(`${BOX} ${connector({})}
            return ${count(`qBodyType(qEverything(EntityType.BODY), BodyType.MATE_CONNECTOR)`)} * 10
                + ${count(`qMateConnectorsOfParts(${bodyOf("box")})`)};`);
        expect(result).toMatchObject({ errors: [], solids: 1, value: 11 });
    });

    test("the move step translates along the connector's axes, then turns it", () => {
        const body = `${BOX} ${connector({
            transform: "true",
            translationX: "2 * millimeter",
            translationZ: "5 * millimeter",
            rotation: "90 * degree",
        })} ${report}`;
        expect(frame(body)).toEqual([12, 10, 15, 0, 1, 0, 0, 0, 1]);
    });

    test("flipping the primary axis and reorienting the secondary one", () => {
        const body = `${BOX} ${connector({ flipPrimary: "true", secondaryAxisType: "MateConnectorAxisType.PLUS_Y" })} ${report}`;
        // Flipped about x: z = -Z, y = -Y; then the secondary axis takes the (new) +Y.
        expect(frame(body)).toEqual([10, 10, 10, 0, -1, 0, 0, 0, -1]);
    });

    test("a mate connector on a cylinder sits on its axis", () => {
        const body = `${cylinder("cyl", 3, 4, 0, 10, 5)} ${featureCall(
            "mateConnector.fs",
            "mateConnector",
            "mc",
            {
                originQuery: `qGeometry(${facesOf("cyl")}, GeometryType.CYLINDER)`,
                entityInferenceType: "EntityInferenceType.MID_AXIS_POINT",
                ownerPart: bodyOf("cyl"),
            },
        )} ${report}`;
        expect(frame(body).slice(0, 3)).toEqual([3, 4, 5]);
    });

    test("a mate connector attached to a part follows it", () => {
        const body = `${BOX} opMateConnector(context, id + "mc", { "coordSystem" : coordSystem(${mm(1, 2, 3)}, vector(1, 0, 0), vector(0, 0, 1)),
                "owner" : ${bodyOf("box")}, "attachTo" : ${bodyOf("box")} });
            opTransform(context, id + "move", { "bodies" : ${bodyOf("box")}, "transform" : transform(${mm(0, 0, 7)}) });
            ${report}`;
        expect(frame(body)).toEqual([1, 2, 10, 1, 0, 0, 0, 0, 1]);
    });

    test("evMateConnector fails for anything that is not a mate connector", () => {
        const result = partStudio(
            `${BOX} return try silent(${cs.replace(bodyOf("mc"), bodyOf("box"))}) == undefined;`,
        );
        expect(result.value).toBe(true);
    });
});

// ------------------------------------------------------------------ Holes

describe("holes", () => {
    /** Sketch points on the box top at (5, 5) and (15, 15). */
    const POINTS = `{ const s = newSketchOnPlane(context, id + "points", { "sketchPlane" : ${atZ(10)} });
        skPoint(s, "p1", { "position" : ${mm(5, 5)} }); skPoint(s, "p2", { "position" : ${mm(15, 15)} }); skSolve(s); }`;
    const hole = (overrides: Record<string, string>) =>
        featureCall("hole.fs", "hole", "hole", {
            isV2: "false",
            holeVersion: "HoleVersion.LEGACY",
            locations: `qCreatedBy(id + "points", EntityType.VERTEX)`,
            scope: bodyOf("box"),
            holeDiameter: "4 * millimeter",
            ...overrides,
        });
    /** The 118° drill point of a hole of radius r: a cone of height r / tan(59°). */
    const tip = (r: number) => (Math.PI * r * r * (r / Math.tan((59 * Math.PI) / 180))) / 3;

    test.each<Case>([
        {
            name: "a simple blind hole at each sketch point",
            body: `${BOX} ${POINTS} ${hole({ style: "HoleStyle.SIMPLE", endStyle: "HoleEndStyle.BLIND", holeDepth: "6 * millimeter" })}`,
            volume: 4000 - 2 * (24 * Math.PI + tip(2)),
            solids: 1,
            faces: 6 + 2 * 2,
        },
        {
            name: "a counterbored blind hole",
            body: `${BOX} ${POINTS} ${hole({
                style: "HoleStyle.C_BORE",
                endStyle: "HoleEndStyle.BLIND",
                cBoreDiameter: "8 * millimeter",
                cBoreDepth: "3 * millimeter",
                holeDepth: "8 * millimeter",
            })}`,
            volume: 4000 - 2 * (48 * Math.PI + 20 * Math.PI + tip(2)),
            solids: 1,
            faces: 6 + 2 * 4,
        },
        {
            // A 90° countersink of radius 4 meets the radius-2 shaft 2 mm down.
            name: "a countersunk blind hole",
            body: `${BOX} ${POINTS} ${hole({
                style: "HoleStyle.C_SINK",
                endStyle: "HoleEndStyle.BLIND",
                cSinkDiameter: "8 * millimeter",
                cSinkAngle: "90 * degree",
                holeDepth: "6 * millimeter",
            })}`,
            volume: 4000 - 2 * ((56 * Math.PI) / 3 + 16 * Math.PI + tip(2)),
            solids: 1,
            faces: 6 + 2 * 3,
        },
        {
            name: "a through hole",
            body: `${BOX} ${POINTS} ${hole({ style: "HoleStyle.SIMPLE", endStyle: "HoleEndStyle.THROUGH" })}`,
            volume: 4000 - 2 * 40 * Math.PI,
            solids: 1,
            faces: 6 + 2,
        },
    ])("$name", (featureCase) => expectStudio(featureCase));

    const OP_HOLE = `opHole(context, id + "hole", { "holeDefinition" : holeDefinition([
            holeProfileBeforeReference(HolePositionReference.TARGET_START, 0 * meter, 2 * millimeter),
            holeProfile(HolePositionReference.TARGET_START, 6 * millimeter, 2 * millimeter, { "name" : "bottom" }),
            holeProfile(HolePositionReference.TARGET_START, 6 * millimeter, 0 * millimeter)],
            { "faceNames" : ["cap", "shaft", "floor"] }),
        "axes" : [line(${mm(5, 5, 20)}, vector(0, 0, -1)), line(${mm(15, 15, 20)}, vector(0, 0, -1))],
        "identities" : [qNthElement(qCreatedBy(id + "points", EntityType.VERTEX), 0), qNthElement(qCreatedBy(id + "points", EntityType.VERTEX), 1)],
        "targets" : ${bodyOf("box")} })`;

    test("opHole reports where each hole enters and leaves its targets", () => {
        const result = partStudio(`${BOX} ${POINTS} const r = ${OP_HOLE};
            const extremes = r[0].targetToDepthExtremes[evaluateQuery(context, ${bodyOf("box")})[0]];
            const start = r[1].positionReferenceInfo[HolePositionReference.TARGET_START];
            return extremes.firstEntrance / millimeter * 1e6 + extremes.fullExit / millimeter * 1e3 + start.referenceRootEnd / millimeter;`);
        // The axes start 10 above the box: they enter it after 10 and leave it after 20.
        expect(result).toMatchObject({ errors: [], value: expect.closeTo(10e6 + 20e3 + 10, 6) });
        expect(result.volume).toBeCloseTo(4000 - 2 * 24 * Math.PI, 6);
    });

    test("qOpHoleFace and qOpHoleProfile find each hole's faces and profiles by name and identity", () => {
        const faces = (filters: string) => count(`qOpHoleFace(id + "hole", ${filters})`);
        const result = partStudio(`${BOX} ${POINTS} ${OP_HOLE};
            return ${faces("{}")} * 1000 + ${faces(`{ "name" : "shaft" }`)} * 100
                + ${faces(`{ "name" : "floor", "identity" : qNthElement(qCreatedBy(id + "points", EntityType.VERTEX), 1) }`)} * 10
                + ${count(`qOpHoleProfile(id + "hole", { "name" : "bottom" })`)};`);
        // Two shafts and two floors (the caps lie on the box top, cut away); the floor circles are profiles.
        expect(result).toMatchObject({ errors: [], value: 4000 + 200 + 10 + 2 });
    });

    test("opHole measures a slanted entry: the hole cylinder enters over a range", () => {
        const result =
            partStudio(`${BOX} const r = opHole(context, id + "hole", { "holeDefinition" : holeDefinition([
                holeProfileBeforeReference(HolePositionReference.TARGET_START, 0 * meter, 2 * millimeter),
                holeProfile(HolePositionReference.TARGET_START, 3 * millimeter, 2 * millimeter),
                holeProfile(HolePositionReference.TARGET_START, 3 * millimeter, 0 * millimeter)]),
            "axes" : [line(${mm(0, 10, 20)}, normalize(vector(1, 0, -1)))], "targets" : ${bodyOf("box")} });
            const reference = r[0].positionReferenceInfo[HolePositionReference.TARGET_START];
            return reference.referenceRootStart / millimeter * 1000 + reference.referenceRootEnd / millimeter;`);
        // The axis meets z = 10 after 10√2; a 45° cut spreads the r = 2 circle over ±2 along it.
        expect(result.errors).toEqual([]);
        expect(result.value).toBeCloseTo((10 * Math.SQRT2 - 2) * 1000 + 10 * Math.SQRT2 + 2, 6);
    });

    test("opHole without any target in the way fails", () => {
        expectError(
            `${BOX} opHole(context, id + "hole", { "holeDefinition" : holeDefinition([
                holeProfileBeforeReference(HolePositionReference.TARGET_START, 0 * meter, 2 * millimeter),
                holeProfile(HolePositionReference.TARGET_START, 3 * millimeter, 0 * millimeter)]),
            "axes" : [line(${mm(50, 50, 20)}, vector(0, 0, -1))], "targets" : ${bodyOf("box")} });`,
            "could not build any hole: no target is in the way",
        );
    });
});
