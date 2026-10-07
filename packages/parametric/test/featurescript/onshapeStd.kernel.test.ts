// Part of the Chili3d Project, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

/**
 * The official FeatureScript slot tutorials (FsDoc tutorials 1-3, verbatim) and std's own
 * features, each run on BOTH standard libraries: Onshape's real std source (version 2960,
 * on the `@` built-ins) and the native std Feature Studios use. Every case checks the
 * resulting volume against the analytic value.
 */

import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { initWasm, ShapeFactory } from "@chili3d/wasm";
import { FsContext } from "../../src/featurescript/context/fsContext";
import type { Interpreter, ModuleResolver } from "../../src/featurescript/lang/interpreter";
import { toDisplayString } from "../../src/featurescript/lang/values";
import { reportedStatus } from "../../src/featurescript/onshape/featureBuiltins";
import { createOnshapeInterpreter } from "../../src/featurescript/onshape/onshapeStd";
import { createInterpreter } from "../../src/featurescript/runtime";
import { fixture, ONSHAPE_STD } from "./_helpers/onshapeStd";

const WASM_BINARY = readFileSync(
    path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../wasm/lib/chili-wasm.wasm"),
);

const IN3 = 25.4 ** 3;

const STUDIOS: Record<string, string> = {
    slotTutorial1: fixture("slotTutorial1.fs"),
    slotTutorial2: fixture("slotTutorial2.fs"),
    slotTutorial3: fixture("slotTutorial3.fs"),
    // Tutorial 3 imports tutorial 2 by its Onshape document id.
    "4f1bf66a78b8c01e6f1ea7f8": fixture("slotTutorial2.fs"),
};
const resolveModule: ModuleResolver = (name) =>
    STUDIOS[name] === undefined ? undefined : { path: name, source: STUDIOS[name] };

let interpreters: Record<"onshape" | "native", Interpreter>;

beforeAll(async () => {
    await initWasm({ wasmBinary: WASM_BINARY });
    Object.defineProperty(globalThis, "shapeFactory", {
        value: new ShapeFactory(),
        writable: true,
        configurable: true,
    });
    interpreters = {
        onshape: createOnshapeInterpreter({ std: ONSHAPE_STD, resolveModule }),
        native: createInterpreter({ resolveModule }),
    };
});

let studioCount = 0;

/** Runs `body` as a Part Studio's build function; returns the solid volume (mm³) and any feature errors. */
function partStudio(std: "onshape" | "native", imports: string, body: string) {
    const interpreter = interpreters[std];
    const source = `FeatureScript 2960;
import(path : "onshape/std/geometry.fs", version : "2960.0");
${imports}
export function build(context is Context)
{
${body}
}
`;
    const module = interpreter.load({ path: `partStudio${studioCount++}`, source });
    const context = new FsContext();
    try {
        interpreter.callFunction(module.env.lookup("build")?.value, [context.value]);
        const volume = context.bodies
            .filter((body) => body.isModelGeometry && body.kind === "SOLID")
            .reduce((sum, body) => sum + body.shape.volume(), 0);
        return { volume, errors: featureErrors(context) };
    } finally {
        context.dispose();
    }
}

/** Errors the top-level features reported (Onshape's std reports them as status instead of throwing). */
function featureErrors(context: FsContext): string[] {
    const errors: string[] = [];
    for (const id of ["slot1", "multi", "case"]) {
        const status = reportedStatus(context, id);
        if (status !== undefined && /statusType : "?ERROR/.test(toDisplayString(status))) {
            errors.push(`${id}: ${toDisplayString(status)}`);
        }
    }
    return errors;
}

const CUBE = `fCuboid(context, makeId("cube"), { "corner1" : vector(0, 0, 0) * inch, "corner2" : vector(4, 4, 1) * inch });`;
const SLOT_SKETCH = `${CUBE}
    const sketch = newSketchOnPlane(context, makeId("sketch1"), { "sketchPlane" : plane(vector(0, 0, 1) * inch, vector(0, 0, 1)) });
    skLineSegment(sketch, "line1", { "start" : vector(1, 2) * inch, "end" : vector(3, 2) * inch });
    skLineSegment(sketch, "line2", { "start" : vector(1, 3) * inch, "end" : vector(3, 3.5) * inch });
    skSolve(sketch);
    const part = qCreatedBy(makeId("cube"), EntityType.BODY);
    const line1 = sketchEntityQuery(makeId("sketch1"), EntityType.EDGE, "line1");`;

/** Area of the circular segment a bump arc cuts off (chord c, sagitta h), in². */
function segmentArea(c: number, h: number): number {
    const r = (c * c) / 4 / (2 * h) + h / 2;
    return r * r * Math.acos((r - h) / r) - (r - h) * Math.sqrt(2 * r * h - h * h);
}

const SLOT = 2 * 0.25 * 1;
const TUTORIALS = [
    {
        name: "tutorial 1: slot along a sketch line",
        imports: 'import(path : "slotTutorial1", version : "");',
        body: `${SLOT_SKETCH}
    slot(context, makeId("slot1"), { "slotPath" : line1, "partToCut" : part, "width" : 0.25 * inch });`,
        volume: (16 - SLOT) * IN3,
    },
    {
        name: "tutorial 2: slot from sketch geometry",
        imports: 'import(path : "slotTutorial2", version : "");',
        body: `${SLOT_SKETCH}
    slot(context, makeId("slot1"), { "slotPath" : line1, "partToCut" : part, "width" : 0.25 * inch, "addBumps" : false });`,
        volume: (16 - SLOT) * IN3,
    },
    {
        name: "tutorial 2: slot with bumps",
        imports: 'import(path : "slotTutorial2", version : "");',
        body: `${SLOT_SKETCH}
    slot(context, makeId("slot1"), { "slotPath" : line1, "partToCut" : part, "width" : 0.25 * inch, "addBumps" : true, "bumpHeight" : 0.01 * inch });`,
        // Four arcs (chord L/5, sagitta 0.01") bulge into the slot, leaving that much material.
        volume: (16 - SLOT + 4 * segmentArea(0.4, 0.01)) * IN3,
    },
    {
        name: "tutorial 3: one slot per selected line",
        imports: 'import(path : "slotTutorial3", version : "");',
        body: `${SLOT_SKETCH}
    multipleSlot(context, makeId("multi"), { "slotPath" : qCreatedBy(makeId("sketch1"), EntityType.EDGE), "partToCut" : part, "width" : 0.25 * inch, "addBumps" : false });`,
        volume: (16 - SLOT - Math.hypot(2, 0.5) * 0.25) * IN3,
    },
];

const STDS = ["onshape", "native"] as const;

describe.each(STDS)("official slot tutorials on the %s std", (std) => {
    test.each(TUTORIALS)("$name", ({ imports, body, volume }) => {
        const result = partStudio(std, imports, body);
        expect(result.errors).toEqual([]);
        expect(result.volume).toBeCloseTo(volume, 3);
    });
});

const RECT = (id: string, plane: string, x0: number, y0: number, x1: number, y1: number) =>
    `{ const s = newSketchOnPlane(context, makeId("${id}"), { "sketchPlane" : ${plane} });
       skRectangle(s, "r", { "firstCorner" : vector(${x0}, ${y0}) * inch, "secondCorner" : vector(${x1}, ${y1}) * inch });
       skSolve(s); }`;
const VERTICAL_EDGE = `qNthElement(qParallelEdges(qCreatedBy(makeId("cube"), EntityType.EDGE), Z_DIRECTION), 0)`;
const UNIT_CUBE = (x: number) =>
    `fCuboid(context, makeId("cube"), { "corner1" : vector(${x}, 0, 0) * inch, "corner2" : vector(${x + 1}, 1, 1) * inch });`;

const FEATURES = [
    {
        name: "fCylinder",
        body: `fCylinder(context, makeId("case"), { "bottomCenter" : vector(0, 0, 0) * inch, "topCenter" : vector(0, 0, 2) * inch, "radius" : 1 * inch });`,
        volume: 2 * Math.PI * IN3,
    },
    {
        name: "fSphere",
        body: `fSphere(context, makeId("case"), { "radius" : 1 * inch });`,
        volume: (4 / 3) * Math.PI * IN3,
    },
    {
        name: "extrude a new body",
        body: `${RECT("sk", "plane(vector(0, 0, 0) * inch, vector(0, 0, 1))", 0, 0, 2, 1)}
    extrude(context, makeId("case"), { "entities" : qSketchRegion(makeId("sk")), "endBound" : BoundingType.BLIND, "depth" : 0.5 * inch });`,
        volume: 1 * IN3,
    },
    {
        name: "extrude remove through all",
        body: `${CUBE}
    { const s = newSketchOnPlane(context, makeId("sk"), { "sketchPlane" : plane(vector(0, 0, 1) * inch, vector(0, 0, 1)) });
      skCircle(s, "c", { "center" : vector(2, 2) * inch, "radius" : 0.5 * inch }); skSolve(s); }
    extrude(context, makeId("case"), { "entities" : qSketchRegion(makeId("sk")), "endBound" : BoundingType.THROUGH_ALL, "operationType" : NewBodyOperationType.REMOVE,
        "oppositeDirection" : true, "defaultScope" : false, "booleanScope" : qCreatedBy(makeId("cube"), EntityType.BODY) });`,
        volume: (16 - Math.PI * 0.25) * IN3,
    },
    {
        name: "fillet",
        body: `${CUBE} fillet(context, makeId("case"), { "entities" : ${VERTICAL_EDGE}, "radius" : 0.25 * inch });`,
        volume: (16 - (1 - Math.PI / 4) * 0.0625) * IN3,
    },
    {
        name: "chamfer",
        body: `${CUBE} chamfer(context, makeId("case"), { "entities" : ${VERTICAL_EDGE}, "width" : 0.25 * inch });`,
        volume: (16 - 0.25 * 0.25 * 0.5) * IN3,
    },
    {
        name: "revolve",
        body: `${RECT("sk", "plane(vector(0, 0, 0) * inch, vector(0, -1, 0), vector(1, 0, 0))", 1, 0, 2, 1)}
    fCylinder(context, makeId("axis"), { "bottomCenter" : vector(0, 0, -1) * inch, "topCenter" : vector(0, 0, 0) * inch, "radius" : 0.1 * inch });
    revolve(context, makeId("case"), { "entities" : qSketchRegion(makeId("sk")), "axis" : qNthElement(qGeometry(qCreatedBy(makeId("axis"), EntityType.FACE), GeometryType.CYLINDER), 0) });
    opDeleteBodies(context, makeId("deleteAxis"), { "entities" : qCreatedBy(makeId("axis"), EntityType.BODY) });`,
        volume: Math.PI * (2 * 2 - 1) * IN3,
    },
    {
        name: "shell",
        body: `${CUBE}
    shell(context, makeId("case"), { "entities" : qNthElement(qParallelPlanes(qCreatedBy(makeId("cube"), EntityType.FACE), plane(vector(0, 0, 1) * inch, vector(0, 0, 1)), false), 0), "thickness" : 0.1 * inch });`,
        volume: (16 - 3.8 * 3.8 * 0.9) * IN3,
    },
    {
        name: "boolean union",
        body: `${CUBE} fCuboid(context, makeId("cube2"), { "corner1" : vector(3, 3, 0) * inch, "corner2" : vector(5, 5, 1) * inch });
    booleanBodies(context, makeId("case"), { "tools" : qUnion([qCreatedBy(makeId("cube"), EntityType.BODY), qCreatedBy(makeId("cube2"), EntityType.BODY)]), "operationType" : BooleanOperationType.UNION });`,
        volume: (16 + 4 - 1) * IN3,
    },
    {
        name: "linear pattern",
        body: `${UNIT_CUBE(0)}
    linearPattern(context, makeId("case"), { "patternType" : PatternType.PART, "entities" : qCreatedBy(makeId("cube"), EntityType.BODY),
        "directionOne" : qNthElement(qParallelEdges(qCreatedBy(makeId("cube"), EntityType.EDGE), X_DIRECTION), 0), "distance" : 2 * inch, "instanceCount" : 3 });`,
        volume: 3 * IN3,
    },
    {
        name: "circular pattern",
        body: `${UNIT_CUBE(2)}
    fCylinder(context, makeId("axis"), { "bottomCenter" : vector(0, 0, -2) * inch, "topCenter" : vector(0, 0, -1) * inch, "radius" : 0.1 * inch });
    circularPattern(context, makeId("case"), { "patternType" : PatternType.PART, "entities" : qCreatedBy(makeId("cube"), EntityType.BODY),
        "axis" : qNthElement(qGeometry(qCreatedBy(makeId("axis"), EntityType.FACE), GeometryType.CYLINDER), 0), "angle" : 360 * degree, "instanceCount" : 4, "equalSpace" : true });
    opDeleteBodies(context, makeId("deleteAxis"), { "entities" : qCreatedBy(makeId("axis"), EntityType.BODY) });`,
        volume: 4 * IN3,
    },
    {
        name: "mirror",
        body: `${UNIT_CUBE(1)}
    mirror(context, makeId("case"), { "patternType" : MirrorType.PART, "entities" : qCreatedBy(makeId("cube"), EntityType.BODY), "mirrorPlane" : qCreatedBy(makeId("Right"), EntityType.FACE) });`,
        volume: 2 * IN3,
    },
];

describe.each(STDS)("std features on the %s std", (std) => {
    test.each(FEATURES)("$name", ({ body, volume }) => {
        const result = partStudio(std, "", body);
        expect(result.errors).toEqual([]);
        expect(result.volume).toBeCloseTo(volume, 3);
    });
});
