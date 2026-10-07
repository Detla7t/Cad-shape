// Part of the Chili3d Project, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

/**
 * Onshape's std (3083) running its own built-in 3D features the way Part Studio code calls
 * them — `extrude(context, id + "e1", { "entities" : qSketchRegion(id + "s1"), ... })` — on
 * the `@` built-ins, each case checked against an exact analytic volume (or area, length,
 * position). Calls the native std accepts as well run on both stds.
 *
 * The "known gaps" blocks assert the correct result of std features that are expected to
 * work but do not yet (bridge conversions, kernel ops, a missing bookkeeping built-in);
 * they fail until fixed. Splitting, direct-editing, hole and mate connector features are
 * covered by `stdOperations.kernel.test.ts`; features that are simply unimplemented (draft,
 * feature/face patterns, up-to bounds, sheet metal) are not tested here.
 */

import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { initWasm, ShapeFactory } from "@chili3d/wasm";
import { FsContext } from "../../src/featurescript/context/fsContext";
import type { Interpreter } from "../../src/featurescript/lang/interpreter";
import { describeStatus, featureState } from "../../src/featurescript/onshape/featureBuiltins";
import { createOnshapeInterpreter } from "../../src/featurescript/onshape/onshapeStd";
import { createInterpreter } from "../../src/featurescript/runtime";
import { ONSHAPE_STD } from "./_helpers/onshapeStd";

const WASM_BINARY = readFileSync(
    path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../wasm/lib/chili-wasm.wasm"),
);

type Std = "onshape" | "native";

let interpreters: Record<Std, Interpreter>;

beforeAll(async () => {
    await initWasm({ wasmBinary: WASM_BINARY });
    Object.defineProperty(globalThis, "shapeFactory", {
        value: new ShapeFactory(),
        writable: true,
        configurable: true,
    });
    interpreters = {
        onshape: createOnshapeInterpreter({ std: ONSHAPE_STD }),
        native: createInterpreter({}),
    };
});

interface StudioResult {
    /** Total volume of the solid parts, mm³. */
    readonly volume: number;
    readonly solids: number;
    /** What the build function returned (a measurement in mm units), when a number or boolean. */
    readonly value: number | boolean | undefined;
    /** Every top-level feature (or operation) that reported an ERROR status. */
    readonly errors: string[];
}

let studioCount = 0;

/** Runs `body` as a Part Studio's build function (`id` is the root Id). */
function partStudio(std: Std, body: string): StudioResult {
    const interpreter = interpreters[std];
    const source = `FeatureScript 3083;
import(path : "onshape/std/geometry.fs", version : "3083.0");
export function build(context is Context)
{
    const id = newId();
${body}
}
`;
    const module = interpreter.load({ path: `stdFeatures${studioCount++}`, source });
    const context = new FsContext();
    try {
        const value = interpreter.callFunction(module.env.lookup("build")?.value, [context.value]);
        const solids = context.bodies.filter((b) => b.isModelGeometry && b.kind === "SOLID");
        return {
            volume: solids.reduce((sum, b) => sum + b.shape.volume(), 0),
            solids: solids.length,
            value: typeof value === "number" || typeof value === "boolean" ? value : undefined,
            errors: featureErrors(context),
        };
    } finally {
        context.dispose();
    }
}

/** Top-level ids only: a sub-operation's error is the feature's own business (std may try one and recover). */
function featureErrors(context: FsContext): string[] {
    const errors: string[] = [];
    for (const [id, status] of featureState(context).status) {
        const { kind, message } = describeStatus(status);
        if (kind === "ERROR" && !id.includes("/")) errors.push(`${id}: ${message}`);
    }
    return errors;
}

// ------------------------------------------------------------------ Part Studio snippets

const mm = (...coordinates: number[]) => `vector(${coordinates.join(", ")}) * millimeter`;
const atZ = (z: number) => `plane(${mm(0, 0, z)}, vector(0, 0, 1))`;
/** The XZ plane: sketch x is world x, sketch y is world z. */
const XZ = "plane(vector(0, 0, 0) * meter, vector(0, -1, 0), vector(1, 0, 0))";

/** A sketch `id + name` on `plane` holding `entities` (sk* calls on `s`). */
const sketch = (name: string, plane: string, entities: string) =>
    `{ const s = newSketchOnPlane(context, id + "${name}", { "sketchPlane" : ${plane} });
       ${entities}
       skSolve(s); }`;
const rect = (x0: number, y0: number, x1: number, y1: number) =>
    `skRectangle(s, "rect", { "firstCorner" : ${mm(x0, y0)}, "secondCorner" : ${mm(x1, y1)} });`;
const circle = (x: number, y: number, r: number) =>
    `skCircle(s, "circle", { "center" : ${mm(x, y)}, "radius" : ${r} * millimeter });`;
const segment = (name: string, x0: number, y0: number, x1: number, y1: number) =>
    `skLineSegment(s, "${name}", { "start" : ${mm(x0, y0)}, "end" : ${mm(x1, y1)} });`;

const cuboid = (name: string, from: number[], to: number[]) =>
    `fCuboid(context, id + "${name}", { "corner1" : ${mm(...from)}, "corner2" : ${mm(...to)} });`;
/** A 20 x 20 x 10 block (4000 mm³) at the origin. */
const BOX = cuboid("box", [0, 0, 0], [20, 20, 10]);
const bodyOf = (name: string) => `qCreatedBy(id + "${name}", EntityType.BODY)`;
const BOX_TOP = `qCoincidesWithPlane(qCreatedBy(id + "box", EntityType.FACE), ${atZ(10)})`;
const BOX_Z_EDGES = `qParallelEdges(qCreatedBy(id + "box", EntityType.EDGE), Z_DIRECTION)`;
const BOX_Z_EDGE = `qNthElement(${BOX_Z_EDGES}, 0)`;
const BOX_X_EDGE = `qNthElement(qParallelEdges(qCreatedBy(id + "box", EntityType.EDGE), X_DIRECTION), 0)`;
const BOX_Y_EDGE = `qNthElement(qParallelEdges(qCreatedBy(id + "box", EntityType.EDGE), Y_DIRECTION), 0)`;
/** A 10 mm sketch line along world Z, as a revolve / pattern / rotation axis. */
const Z_AXIS_SKETCH = sketch("axis", XZ, segment("axis", 0, 0, 0, 10));
const Z_AXIS = `qCreatedBy(id + "axis", EntityType.EDGE)`;
/** A 10 x 10 mm profile 10..20 mm off the Z axis, for revolves (a full turn: 3000π mm³). */
const RING_PROFILE = sketch("s1", XZ, rect(10, 0, 20, 10));
const FULL_RING = 3000 * Math.PI;

const minCorner = (axis: 0 | 1 | 2, query: string) =>
    `return evBox3d(context, { "topology" : ${query} }).minCorner[${axis}] / millimeter;`;
const maxCorner = (axis: 0 | 1 | 2, query: string) =>
    `return evBox3d(context, { "topology" : ${query} }).maxCorner[${axis}] / millimeter;`;
const extrude = (fields: string) =>
    `extrude(context, id + "e1", { "entities" : qSketchRegion(id + "s1"), ${fields} });`;
const regionArea = 'return evArea(context, { "entities" : qSketchRegion(id + "s1") }) / millimeter ^ 2;';

const FILLET_LOSS = (1 - Math.PI / 4) * 2 * 2 * 10;

interface FeatureCase {
    readonly name: string;
    readonly body: string;
    readonly volume: number;
    readonly solids?: number;
    readonly value?: number | boolean;
}

function expectStudio(std: Std, { body, volume, solids, value }: FeatureCase): void {
    const result = partStudio(std, body);
    expect(result.errors).toEqual([]);
    expect(result.volume).toBeCloseTo(volume, 3);
    // The part count and the returned measurement, where the case states them.
    expect(result).toMatchObject({
        ...(solids === undefined ? {} : { solids }),
        ...(value === undefined
            ? {}
            : { value: typeof value === "number" ? expect.closeTo(value, 3) : value }),
    });
}

const STDS = ["onshape", "native"] as const;

// ------------------------------------------------------------------ Both stds

const SHARED: FeatureCase[] = [
    {
        name: "extrude blind",
        body: `${sketch("s1", atZ(0), rect(0, 0, 20, 10))}
            ${extrude(`"endBound" : BoundingType.BLIND, "depth" : 5 * millimeter`)}`,
        volume: 1000,
        solids: 1,
    },
    {
        name: "extrude in the opposite direction",
        body: `${sketch("s1", atZ(0), rect(0, 0, 20, 10))}
            ${extrude(`"endBound" : BoundingType.BLIND, "depth" : 5 * millimeter, "oppositeDirection" : true`)}
            ${minCorner(2, bodyOf("e1"))}`,
        volume: 1000,
        value: -5,
    },
    {
        name: "extrude with a second direction",
        body: `${sketch("s1", atZ(0), rect(0, 0, 20, 10))}
            ${extrude(`"endBound" : BoundingType.BLIND, "depth" : 5 * millimeter, "hasSecondDirection" : true,
                "secondDirectionBound" : BoundingType.BLIND, "secondDirectionDepth" : 3 * millimeter`)}
            ${minCorner(2, bodyOf("e1"))}`,
        volume: 1600,
        value: -3,
    },
    {
        name: "extrude through all, removing",
        body: `${BOX} ${sketch("s1", atZ(10), circle(10, 10, 3))}
            ${extrude(`"endBound" : BoundingType.THROUGH_ALL, "oppositeDirection" : true,
                "operationType" : NewBodyOperationType.REMOVE`)}`,
        volume: 4000 - 90 * Math.PI,
        solids: 1,
    },
    {
        name: "extrude blind, removing from a chosen part",
        body: `${BOX} ${sketch("s1", atZ(10), rect(5, 5, 15, 15))}
            ${extrude(`"endBound" : BoundingType.BLIND, "depth" : 4 * millimeter, "oppositeDirection" : true,
                "operationType" : NewBodyOperationType.REMOVE, "defaultScope" : false, "booleanScope" : ${bodyOf("box")}`)}`,
        volume: 3600,
        solids: 1,
    },
    {
        name: "revolve a full turn",
        body: `${RING_PROFILE} ${Z_AXIS_SKETCH}
            revolve(context, id + "r1", { "entities" : qSketchRegion(id + "s1"), "axis" : ${Z_AXIS} });`,
        volume: FULL_RING,
    },
    {
        name: "revolve, removing",
        body: `fCylinder(context, id + "cyl", { "bottomCenter" : ${mm(0, 0, 0)}, "topCenter" : ${mm(0, 0, 10)}, "radius" : 30 * millimeter });
            ${RING_PROFILE} ${Z_AXIS_SKETCH}
            revolve(context, id + "r1", { "entities" : qSketchRegion(id + "s1"), "axis" : ${Z_AXIS},
                "operationType" : NewBodyOperationType.REMOVE, "defaultScope" : false, "booleanScope" : ${bodyOf("cyl")} });`,
        volume: 9000 * Math.PI - FULL_RING,
        solids: 1,
    },
    {
        name: "fillet one edge",
        body: `${BOX} fillet(context, id + "f1", { "entities" : ${BOX_Z_EDGE}, "radius" : 2 * millimeter });`,
        volume: 4000 - FILLET_LOSS,
    },
    {
        name: "fillet several edges",
        body: `${BOX} fillet(context, id + "f1", { "entities" : ${BOX_Z_EDGES}, "radius" : 2 * millimeter });`,
        volume: 4000 - 4 * FILLET_LOSS,
    },
    {
        name: "chamfer",
        body: `${BOX} chamfer(context, id + "c1", { "entities" : ${BOX_Z_EDGE}, "width" : 2 * millimeter });`,
        volume: 4000 - 0.5 * 2 * 2 * 10,
    },
    {
        name: "shell inward, removing the top face",
        body: `${BOX} shell(context, id + "sh", { "entities" : ${BOX_TOP}, "thickness" : 1 * millimeter });`,
        volume: 4000 - 18 * 18 * 9,
    },
    {
        name: "shell outward",
        body: `${BOX} shell(context, id + "sh", { "entities" : ${BOX_TOP}, "thickness" : 1 * millimeter, "oppositeDirection" : true });`,
        volume: 22 * 22 * 11 - 4000,
    },
    {
        name: "mirror a part",
        body: `${cuboid("box", [5, 0, 0], [20, 10, 10])}
            mirror(context, id + "m1", { "patternType" : MirrorType.PART, "entities" : ${bodyOf("box")},
                "mirrorPlane" : qCreatedBy(makeId("Right"), EntityType.FACE) });`,
        volume: 3000,
        solids: 2,
    },
    {
        name: "mirror a part, merging",
        body: `${cuboid("box", [0, 0, 0], [20, 10, 10])}
            mirror(context, id + "m1", { "patternType" : MirrorType.PART, "entities" : ${bodyOf("box")},
                "mirrorPlane" : qCreatedBy(makeId("Right"), EntityType.FACE), "operationType" : NewBodyOperationType.ADD });`,
        volume: 4000,
        solids: 1,
    },
    {
        name: "linear part pattern",
        body: `${cuboid("box", [0, 0, 0], [10, 10, 10])}
            linearPattern(context, id + "lp", { "patternType" : PatternType.PART, "entities" : ${bodyOf("box")},
                "directionOne" : ${BOX_X_EDGE}, "distance" : 15 * millimeter, "instanceCount" : 3 });`,
        volume: 3000,
        solids: 3,
    },
    {
        name: "circular part pattern",
        body: `${cuboid("box", [20, 0, 0], [30, 5, 10])} ${Z_AXIS_SKETCH}
            circularPattern(context, id + "cp", { "patternType" : PatternType.PART, "entities" : ${bodyOf("box")},
                "axis" : ${Z_AXIS}, "angle" : 360 * degree, "instanceCount" : 4, "equalSpace" : true });`,
        volume: 2000,
        solids: 4,
    },
    {
        name: "boolean union",
        body: `${cuboid("a", [0, 0, 0], [20, 20, 10])} ${cuboid("b", [10, 10, 0], [30, 30, 10])}
            booleanBodies(context, id + "b1", { "tools" : qUnion([${bodyOf("a")}, ${bodyOf("b")}]), "operationType" : BooleanOperationType.UNION });`,
        volume: 7000,
        solids: 1,
    },
    {
        name: "boolean subtraction",
        body: `${cuboid("a", [0, 0, 0], [20, 20, 10])} ${cuboid("b", [10, 10, 0], [30, 30, 10])}
            booleanBodies(context, id + "b1", { "targets" : ${bodyOf("a")}, "tools" : ${bodyOf("b")}, "operationType" : BooleanOperationType.SUBTRACTION });`,
        volume: 3000,
        solids: 1,
    },
    {
        name: "boolean subtraction keeping the tools",
        body: `${cuboid("a", [0, 0, 0], [20, 20, 10])} ${cuboid("b", [10, 10, 0], [30, 30, 10])}
            booleanBodies(context, id + "b1", { "targets" : ${bodyOf("a")}, "tools" : ${bodyOf("b")}, "operationType" : BooleanOperationType.SUBTRACTION, "keepTools" : true });`,
        volume: 7000,
        solids: 2,
    },
    {
        name: "boolean intersection",
        body: `${cuboid("a", [0, 0, 0], [20, 20, 10])} ${cuboid("b", [10, 10, 0], [30, 30, 10])}
            booleanBodies(context, id + "b1", { "tools" : qUnion([${bodyOf("a")}, ${bodyOf("b")}]), "operationType" : BooleanOperationType.INTERSECTION });`,
        volume: 1000,
        solids: 1,
    },
    {
        name: "opPlane, sketched on and extruded from",
        body: `opPlane(context, id + "p1", { "plane" : ${atZ(5)} });
            { const s = newSketch(context, id + "s1", { "sketchPlane" : qCreatedBy(id + "p1", EntityType.FACE) }); ${rect(0, 0, 20, 10)} skSolve(s); }
            ${extrude(`"depth" : 5 * millimeter`)}
            ${minCorner(2, bodyOf("e1"))}`,
        volume: 1000,
        value: 5,
    },
];

describe.each(STDS)("std features on the %s std", (std) => {
    test.each(SHARED)("$name", (featureCase) => expectStudio(std, featureCase));
});

const SKETCHES = [
    { name: "skRectangle", entities: rect(0, 0, 20, 10), area: 200 },
    { name: "skCircle", entities: circle(0, 0, 5), area: 25 * Math.PI },
    {
        name: "skEllipse",
        entities: `skEllipse(s, "e", { "center" : ${mm(0, 0)}, "majorRadius" : 6 * millimeter, "minorRadius" : 3 * millimeter });`,
        area: 18 * Math.PI,
    },
    {
        name: "skRegularPolygon",
        entities: `skRegularPolygon(s, "p", { "center" : ${mm(0, 0)}, "firstVertex" : ${mm(10, 0)}, "sides" : 6 });`,
        area: 150 * Math.sqrt(3),
    },
    {
        name: "skPolyline",
        entities: `skPolyline(s, "p", { "points" : [${mm(0, 0)}, ${mm(10, 0)}, ${mm(0, 10)}, ${mm(0, 0)}] });`,
        area: 50,
    },
    {
        name: "skLineSegment and skArc",
        entities: `${segment("l", -5, 0, 5, 0)} skArc(s, "a", { "start" : ${mm(5, 0)}, "mid" : ${mm(0, 5)}, "end" : ${mm(-5, 0)} });`,
        area: 12.5 * Math.PI,
    },
];

describe.each(STDS)("sketch regions on the %s std", (std) => {
    test.each(SKETCHES)("$name", ({ entities, area }) => {
        const result = partStudio(std, `${sketch("s1", atZ(0), entities)} ${regionArea}`);
        expect(result.errors).toEqual([]);
        expect(result.value).toBeCloseTo(area, 6);
    });

    test("a circle inside a rectangle splits it into two regions", () => {
        const result = partStudio(
            std,
            `${sketch("s1", atZ(0), rect(0, 0, 20, 20) + circle(10, 10, 5))}
            return size(evaluateQuery(context, qSketchRegion(id + "s1")));`,
        );
        expect(result.value).toBe(2);
    });
});

// ------------------------------------------------------------------ Onshape std only

/** Calls whose fields (or features) the native std does not have. */
const ONSHAPE_ONLY: FeatureCase[] = [
    {
        name: "extrude symmetric through all, removing",
        body: `${cuboid("box", [0, 0, -5], [20, 20, 10])} ${sketch("s1", atZ(0), circle(10, 10, 3))}
            ${extrude(`"endBound" : BoundingType.THROUGH_ALL, "symmetric" : true, "operationType" : NewBodyOperationType.REMOVE`)}`,
        volume: 6000 - 9 * Math.PI * 15,
        solids: 1,
    },
    {
        name: "revolve symmetric",
        body: `${RING_PROFILE} ${Z_AXIS_SKETCH}
            revolve(context, id + "r1", { "entities" : qSketchRegion(id + "s1"), "axis" : ${Z_AXIS},
                "fullRevolve" : false, "angle" : 90 * degree, "symmetric" : true });
            ${minCorner(1, bodyOf("r1"))}`,
        volume: FULL_RING / 4,
        value: -20 * Math.SQRT1_2,
    },
    {
        name: "thicken a sketch region",
        body: `${sketch("s1", atZ(0), rect(0, 0, 20, 10))}
            thicken(context, id + "t1", { "entities" : qSketchRegion(id + "s1"), "thickness1" : 2 * millimeter, "thickness2" : 0 * millimeter });`,
        volume: 400,
        solids: 1,
    },
    {
        name: "thicken about the mid plane",
        body: `${sketch("s1", atZ(0), rect(0, 0, 20, 10))}
            thicken(context, id + "t1", { "entities" : qSketchRegion(id + "s1"), "midplane" : true, "thickness" : 2 * millimeter });
            ${minCorner(2, bodyOf("t1"))}`,
        volume: 400,
        value: -1,
    },
    {
        name: "linear part pattern in two directions",
        body: `${cuboid("box", [0, 0, 0], [10, 10, 10])}
            linearPattern(context, id + "lp", { "patternType" : PatternType.PART, "entities" : ${bodyOf("box")},
                "directionOne" : ${BOX_X_EDGE}, "distance" : 15 * millimeter, "instanceCount" : 3,
                "hasSecondDir" : true, "directionTwo" : ${BOX_Y_EDGE}, "distanceTwo" : 15 * millimeter, "instanceCountTwo" : 2 });`,
        volume: 6000,
        solids: 6,
    },
    {
        name: "delete bodies",
        body: `${BOX} ${cuboid("b", [25, 25, 0], [30, 30, 10])} deleteBodies(context, id + "d1", { "entities" : ${bodyOf("b")} });`,
        volume: 4000,
        solids: 1,
    },
    {
        name: "transform: translate by XYZ",
        body: `${BOX} transform(context, id + "t1", { "entities" : ${bodyOf("box")}, "transformType" : TransformType.TRANSLATION_3D,
                "dx" : 5 * millimeter, "dy" : 0 * millimeter, "dz" : 7 * millimeter, "makeCopy" : false });
            ${minCorner(2, bodyOf("box"))}`,
        volume: 4000,
        value: 7,
    },
    {
        name: "transform: translate by distance",
        body: `${BOX} transform(context, id + "t1", { "entities" : ${bodyOf("box")}, "transformType" : TransformType.TRANSLATION_DISTANCE,
                "transformDirection" : ${BOX_Z_EDGE}, "distance" : 4 * millimeter, "makeCopy" : false });
            ${minCorner(2, bodyOf("box"))}`,
        volume: 4000,
        value: 4,
    },
    {
        name: "transform: translate by a line",
        body: `${BOX} transform(context, id + "t1", { "entities" : ${bodyOf("box")}, "transformType" : TransformType.TRANSLATION_ENTITY,
                "transformLine" : ${BOX_Z_EDGE}, "oppositeDirectionEntity" : false, "makeCopy" : false });
            ${minCorner(2, bodyOf("box"))}`,
        volume: 4000,
        value: 10,
    },
    {
        name: "transform: rotate",
        body: `${BOX} ${Z_AXIS_SKETCH} transform(context, id + "t1", { "entities" : ${bodyOf("box")}, "transformType" : TransformType.ROTATION,
                "transformAxis" : ${Z_AXIS}, "angle" : 90 * degree, "makeCopy" : false });
            ${minCorner(0, bodyOf("box"))}`,
        volume: 4000,
        value: -20,
    },
    {
        name: "transform: scale uniformly",
        body: `${BOX} opPoint(context, id + "pt", { "point" : ${mm(0, 0, 0)} });
            transform(context, id + "t1", { "entities" : ${bodyOf("box")}, "transformType" : TransformType.SCALE_UNIFORMLY,
                "scalePoint" : qCreatedBy(id + "pt", EntityType.VERTEX), "scale" : 2, "makeCopy" : false });`,
        volume: 32000,
    },
    {
        name: "transform: translate a copy",
        body: `${BOX} transform(context, id + "t1", { "entities" : ${bodyOf("box")}, "transformType" : TransformType.TRANSLATION_3D,
                "dx" : 30 * millimeter, "dy" : 0 * millimeter, "dz" : 0 * millimeter, "makeCopy" : true });`,
        volume: 8000,
        solids: 2,
    },
    {
        name: "transform: copy in place",
        body: `${BOX} transform(context, id + "t1", { "entities" : ${bodyOf("box")}, "transformType" : TransformType.COPY });`,
        volume: 8000,
        solids: 2,
    },
    {
        name: "cPlane offset",
        body: `cPlane(context, id + "p1", { "cplaneType" : CPlaneType.OFFSET, "entities" : qCreatedBy(makeId("Top"), EntityType.FACE), "offset" : 10 * millimeter });
            return evPlane(context, { "face" : qCreatedBy(id + "p1", EntityType.FACE) }).origin[2] / millimeter;`,
        volume: 0,
        value: 10,
    },
    {
        name: "cPlane offset, sketched on and extruded from",
        body: `cPlane(context, id + "p1", { "cplaneType" : CPlaneType.OFFSET, "entities" : qCreatedBy(makeId("Top"), EntityType.FACE), "offset" : 10 * millimeter });
            { const s = newSketch(context, id + "s1", { "sketchPlane" : qCreatedBy(id + "p1", EntityType.FACE) }); ${rect(0, 0, 20, 10)} skSolve(s); }
            ${extrude(`"depth" : 5 * millimeter`)}
            ${minCorner(2, bodyOf("e1"))}`,
        volume: 1000,
        value: 10,
    },
    {
        name: "cPlane mid plane",
        body: `${BOX} cPlane(context, id + "p1", { "cplaneType" : CPlaneType.MID_PLANE, "entities" : qParallelPlanes(qCreatedBy(id + "box", EntityType.FACE), Z_DIRECTION) });
            return evPlane(context, { "face" : qCreatedBy(id + "p1", EntityType.FACE) }).origin[2] / millimeter;`,
        volume: 4000,
        value: 5,
    },
    {
        name: "cube",
        body: `cube(context, id + "c1", { "sideLength" : 7 * millimeter });`,
        volume: 343,
        solids: 1,
    },
    {
        name: "sphere",
        body: `sphere(context, id + "s1", { "radius" : 5 * millimeter });`,
        volume: (4 / 3) * Math.PI * 125,
        solids: 1,
    },
    {
        name: "sphere about a vertex",
        // Centered on x = 10 mm, the sphere is cut in half by a block ending there.
        body: `opPoint(context, id + "pt", { "point" : ${mm(10, 0, 0)} });
            sphere(context, id + "s1", { "center" : qCreatedBy(id + "pt", EntityType.VERTEX), "radius" : 5 * millimeter });
            ${cuboid("half", [0, -10, -10], [10, 10, 10])}
            booleanBodies(context, id + "b1", { "tools" : qUnion([${bodyOf("s1")}, ${bodyOf("half")}]), "operationType" : BooleanOperationType.INTERSECTION });`,
        volume: (2 / 3) * Math.PI * 125,
        solids: 1,
    },
];

describe("std features on the onshape std", () => {
    test.each(ONSHAPE_ONLY)("$name", (featureCase) => expectStudio("onshape", featureCase));
});

// ------------------------------------------------------------------ Known gaps (failing until fixed)

/** Std features that should already work; each asserts the correct result. */
const GAPS_BOTH: FeatureCase[] = [
    {
        // Onshape: opRevolve turns the wrong way (left-handed about its axis), so every one-direction
        // revolve comes out mirrored through the profile plane: y in [-20, 0] instead of [0, 20].
        name: "revolve one direction by an angle",
        body: `${RING_PROFILE} ${Z_AXIS_SKETCH}
            revolve(context, id + "r1", { "entities" : qSketchRegion(id + "s1"), "axis" : ${Z_AXIS},
                "fullRevolve" : false, "angle" : 90 * degree });
            ${maxCorner(1, bodyOf("r1"))}`,
        volume: FULL_RING / 4,
        value: 20,
    },
    {
        // Both: the operation itself, right-handed about +Z from the profile on +X.
        name: "opRevolve by a forward angle",
        body: `${RING_PROFILE}
            opRevolve(context, id + "r1", { "entities" : qSketchRegion(id + "s1"), "axis" : line(vector(0, 0, 0) * meter, vector(0, 0, 1)),
                "angleForward" : 90 * degree });
            ${maxCorner(1, bodyOf("r1"))}`,
        volume: FULL_RING / 4,
        value: 20,
    },
    {
        // Onshape: `@getTolerantParameterIds` is not installed (std's chamfer calls it once chamferType is set).
        name: "chamfer with an explicit chamfer type",
        body: `${BOX} chamfer(context, id + "c1", { "entities" : ${BOX_Z_EDGE}, "chamferType" : ChamferType.EQUAL_OFFSETS, "width" : 2 * millimeter });`,
        volume: 4000 - 0.5 * 2 * 2 * 10,
    },
    {
        // Onshape: std's qAllModifiableSolidBodies() folds the body type into its EVERYTHING query, which
        // the bridge drops — the union then also targets the sketch bodies, fails, and is swallowed.
        name: "extrude, adding to every part",
        body: `${BOX} ${sketch("s1", atZ(10), rect(5, 5, 15, 15))}
            ${extrude(`"endBound" : BoundingType.BLIND, "depth" : 4 * millimeter, "operationType" : NewBodyOperationType.ADD`)}`,
        volume: 4400,
        solids: 1,
    },
    {
        // Onshape: INTERSECT becomes BooleanOperationType.SUBTRACT_COMPLEMENT, which the kernel rejects —
        // and the error is swallowed, leaving both bodies.
        name: "extrude, intersecting",
        body: `${BOX} ${sketch("s1", atZ(0), circle(10, 10, 5))}
            ${extrude(`"endBound" : BoundingType.BLIND, "depth" : 30 * millimeter, "operationType" : NewBodyOperationType.INTERSECT,
                "defaultScope" : false, "booleanScope" : ${bodyOf("box")}`)}`,
        volume: 250 * Math.PI,
        solids: 1,
    },
    {
        // Onshape: `qOwnedByBody(face)` resolves to the owner's faces, so evArea measures the whole part.
        name: "evArea of one face",
        body: `${BOX} return evArea(context, { "entities" : ${BOX_TOP} }) / millimeter ^ 2;`,
        volume: 4000,
        value: 400,
    },
    {
        name: "evLength of one edge",
        body: `${BOX} return evLength(context, { "entities" : ${BOX_Z_EDGE} }) / millimeter;`,
        volume: 4000,
        value: 10,
    },
    {
        name: "evArea of the outer sketch regions only",
        body: `${sketch("s1", atZ(0), rect(0, 0, 20, 20) + circle(10, 10, 5))}
            return evArea(context, { "entities" : qSketchRegion(id + "s1", true) }) / millimeter ^ 2;`,
        volume: 0,
        value: 400 - 25 * Math.PI,
    },
    {
        // Onshape: std's fCone takes its axis from `sketchEntityQuery(sketchId + "wireOp", ...)` and passes
        // `"angleForward" : 2 * PI` (a bare number of radians) — the bridge handles neither.
        name: "fCone",
        body: `fCone(context, id + "c1", { "bottomCenter" : ${mm(0, 0, 0)}, "topCenter" : ${mm(0, 0, 10)}, "bottomRadius" : 5 * millimeter, "topRadius" : 2 * millimeter });`,
        volume: (Math.PI * 10 * (25 + 10 + 4)) / 3,
        solids: 1,
    },
    {
        // Both: Onshape's opHelix signature (direction, axisStart, interval, helicalPitch) — the kernel reads
        // { axis, turns, pitch } instead. Four turns of radius 10 mm, pitch 5 mm.
        name: "opHelix",
        body: `opHelix(context, id + "h1", { "direction" : vector(0, 0, 1), "axisStart" : ${mm(0, 0, 0)}, "startPoint" : ${mm(10, 0, 0)},
                "interval" : [0, 4], "clockwise" : false, "helicalPitch" : 5 * millimeter, "spiralPitch" : 0 * meter });
            return evLength(context, { "entities" : qCreatedBy(id + "h1", EntityType.EDGE) }) / millimeter;`,
        volume: 0,
        value: 4 * Math.hypot(20 * Math.PI, 5),
    },
];

describe.each(STDS)("known gaps on the %s std", (std) => {
    test.each(GAPS_BOTH)("$name", (featureCase) => expectStudio(std, featureCase));
});

const GAPS_ONSHAPE: FeatureCase[] = [
    {
        // The start angle is measured forward too: 315° starts the revolve 45° behind the profile,
        // so it spans [-45°, 90°] — mirrored by opRevolve (see "revolve one direction by an angle").
        name: "revolve to a second end position",
        body: `${RING_PROFILE} ${Z_AXIS_SKETCH}
            revolve(context, id + "r1", { "entities" : qSketchRegion(id + "s1"), "axis" : ${Z_AXIS}, "fullRevolve" : false,
                "angle" : 90 * degree, "hasStartBound" : true, "startBound" : RevolveBoundingType.BLIND, "angleBack" : 315 * degree });
            ${minCorner(1, bodyOf("r1"))}`,
        volume: (FULL_RING * 3) / 8,
        value: -20 * Math.SQRT1_2,
    },
    {
        // opExtrude ignores `isStartBoundOpposite`: std passes the symmetric start as `startDepth : -depth / 2`
        // measured along the extrude direction, which the kernel reads as backwards.
        name: "extrude symmetric",
        body: `${sketch("s1", atZ(0), rect(0, 0, 20, 10))}
            ${extrude(`"endBound" : BoundingType.BLIND, "symmetric" : true, "depth" : 6 * millimeter`)}
            ${minCorner(2, bodyOf("e1"))}`,
        volume: 1200,
        value: -3,
    },
    {
        // The same: a second direction flipped to run with the first starts 3 mm up, ending at 5 mm.
        name: "extrude with a second direction running the same way",
        body: `${sketch("s1", atZ(0), rect(0, 0, 20, 10))}
            ${extrude(`"endBound" : BoundingType.BLIND, "depth" : 5 * millimeter, "hasSecondDirection" : true,
                "secondDirectionBound" : BoundingType.BLIND, "secondDirectionDepth" : 3 * millimeter, "secondDirectionOppositeDirection" : false`)}
            ${minCorner(2, bodyOf("e1"))}`,
        volume: 400,
        value: 3,
    },
    {
        // opLoft rejects std's `bodyType : ExtendedToolBodyType.SOLID` (it wants a ToolBodyType).
        name: "loft between two squares",
        body: `${sketch("p1", atZ(0), rect(-10, -10, 10, 10))} ${sketch("p2", atZ(10), rect(-5, -5, 5, 5))}
            loft(context, id + "lo", { "sheetProfilesArray" : [{ "sheetProfileEntities" : qSketchRegion(id + "p1") },
                { "sheetProfileEntities" : qSketchRegion(id + "p2") }] });`,
        volume: (10 / 3) * (400 + 100 + 200),
        solids: 1,
    },
    {
        name: "loft between two circles",
        body: `${sketch("p1", atZ(0), circle(0, 0, 10))} ${sketch("p2", atZ(10), circle(0, 0, 5))}
            loft(context, id + "lo", { "sheetProfilesArray" : [{ "sheetProfileEntities" : qSketchRegion(id + "p1") },
                { "sheetProfileEntities" : qSketchRegion(id + "p2") }] });`,
        volume: ((Math.PI * 10) / 3) * (100 + 50 + 25),
        solids: 1,
    },
    {
        // std's helix computes Onshape's opHelix definition (see "opHelix" above).
        name: "helix around a cylinder",
        body: `fCylinder(context, id + "cyl", { "bottomCenter" : ${mm(0, 0, 0)}, "topCenter" : ${mm(0, 0, 20)}, "radius" : 10 * millimeter });
            helix(context, id + "h1", { "initEntities" : qNothing(), "axisType" : AxisType.SURFACE,
                "entities" : qGeometry(qCreatedBy(id + "cyl", EntityType.FACE), GeometryType.CYLINDER),
                "pathType" : PathType.TURNS, "revolutions" : 4, "oppositeDirection" : false, "startType" : StartType.START_ANGLE,
                "startAngle" : 0 * degree, "endType" : EndType.HEIGHT, "handedness" : Direction.CCW, "showStartEndProfiles" : false });
            return evLength(context, { "entities" : qCreatedBy(id + "h1", EntityType.EDGE) }) / millimeter;`,
        volume: 2000 * Math.PI,
        value: 4 * Math.hypot(20 * Math.PI, 5),
    },
    {
        // std's fEllipsoid revolves with `"angleForward" : 2 * PI` (a bare number of radians).
        name: "fEllipsoid",
        body: `fEllipsoid(context, id + "e1", { "center" : ${mm(0, 0, 0)}, "radius" : ${mm(3, 4, 5)} });`,
        volume: (4 / 3) * Math.PI * 60,
        solids: 1,
    },
];

/**
 * Still failing: std's evDistance needs the nearest points and parameters on both sides,
 * which the kernel does not expose yet (a BRepExtrema_DistShapeShape binding in the WASM
 * build). `test.fails` turns red once it is implemented, so the case moves up then.
 */
const EV_DISTANCE: FeatureCase = {
    // Onshape: the kernel's evDistance returns only { distance }, and std's DistanceResult return
    // type also needs `sides` (index, point, parameter per side), so std's evDistance throws.
    name: "evDistance from a point to a part",
    body: `opPoint(context, id + "pt", { "point" : ${mm(10, 0, 0)} });
            fSphere(context, id + "s1", { "center" : qCreatedBy(id + "pt", EntityType.VERTEX), "radius" : 5 * millimeter });
            return evDistance(context, { "side0" : ${mm(0, 0, 0)}, "side1" : ${bodyOf("s1")} }).distance / millimeter;`,
    volume: (4 / 3) * Math.PI * 125,
    value: 5,
};

describe("std behaviours fixed by the verification pass (onshape std)", () => {
    test.each(GAPS_ONSHAPE)("$name", (featureCase) => expectStudio("onshape", featureCase));

    test.fails("evDistance from a point to a part (needs a kernel binding)", () =>
        expectStudio("onshape", EV_DISTANCE));

    // As in Onshape, a failed operation leaves an ERROR status on its id: std's `try(op(...))` +
    // processSubfeatureStatus rely on it to surface kernel errors, which are swallowed without it.
    test("a failed operation reports its error status", () => {
        const result = partStudio(
            "onshape",
            `${sketch("s1", atZ(0), rect(0, 0, 20, 10))}
            try silent(opExtrude(context, id + "e1", { "entities" : qSketchRegion(id + "s1"), "direction" : vector(0, 0, 1),
                "endBound" : BoundingType.BLIND, "endDepth" : 0 * meter }));
            return getFeatureError(context, id + "e1") != undefined;`,
        );
        expect(result.value).toBe(true);
    });
});

// Last: a face profile currently aborts the kernel's pipe-shell sweep (BRepOffsetAPI_MakePipeShell
// takes wires, not faces), so these run after everything else.
const SWEEP_PROFILE = sketch("prof", atZ(0), circle(0, 0, 2));
const SWEEP_PATH_LINE = sketch("path", XZ, segment("l", 0, 0, 0, 30));

describe.each(STDS)("known gaps on the %s std: sweep", (std) => {
    test("opSweep a sketch region along a line", () => {
        expectStudio(std, {
            name: "opSweep",
            body: `${SWEEP_PROFILE} ${SWEEP_PATH_LINE}
                opSweep(context, id + "sw", { "profiles" : qSketchRegion(id + "prof"), "path" : qCreatedBy(id + "path", EntityType.EDGE) });`,
            volume: 4 * Math.PI * 30,
            solids: 1,
        });
    });
});

describe("std behaviours fixed by the verification pass (onshape std): sweep", () => {
    // std's sweep also follows the path's wire edges to their laminar source (qLaminarDependency),
    // a query type the bridge does not translate.
    test.each([
        { name: "sweep along a line", path: SWEEP_PATH_LINE, length: 30 },
        {
            name: "sweep along a line and a quarter arc",
            path: sketch(
                "path",
                XZ,
                `${segment("l", 0, 0, 0, 20)}
                skArc(s, "a", { "start" : ${mm(0, 20)}, "mid" : ${mm(10 - 10 * Math.SQRT1_2, 20 + 10 * Math.SQRT1_2)}, "end" : ${mm(10, 30)} });`,
            ),
            length: 20 + 5 * Math.PI,
        },
    ])("$name", ({ name, path, length }) => {
        expectStudio("onshape", {
            name,
            body: `${SWEEP_PROFILE} ${path}
                sweep(context, id + "sw", { "profiles" : qSketchRegion(id + "prof"), "path" : qCreatedBy(id + "path", EntityType.EDGE) });`,
            // Pappus: profile area times the length of the path its centroid follows.
            volume: 4 * Math.PI * length,
            solids: 1,
        });
    });
});
