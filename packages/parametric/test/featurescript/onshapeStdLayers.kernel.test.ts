// Part of the Chili3d Project, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

/**
 * Onshape's std, verified bottom-up: modules in dependency order (layer 0 = the generated
 * enums, layer 25 = `geometry.fs`), each one loaded, every constant evaluated, every
 * exported function and feature exercised (see `_helpers/stdLayers.ts`). A fault — an
 * unknown `@` built-in, an undefined name, a JavaScript error inside a built-in — fails
 * the layer it first appears in, unless it is a built-in still listed in
 * `NOT_YET_IMPLEMENTED`; that list is exact, so implementing one means deleting it here.
 * Set STD_LAYER_REPORT=<file> to write every probe's outcome as JSON.
 */

import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { initWasm, ShapeFactory } from "@chili3d/wasm";
import { type ProbeResult, StdLayerProbe } from "./_helpers/stdLayers";

const WASM_BINARY = readFileSync(
    path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../wasm/lib/chili-wasm.wasm"),
);

/**
 * Std built-ins with no implementation yet, by the layer of the lowest module calling
 * them. Most of layer 12 are kernel operations needing OCCT bindings the WASM build
 * does not expose yet (drafts, filling surfaces, face offsets, wraps).
 */
const NOT_YET_IMPLEMENTED: Record<number, readonly string[]> = {
    2: ["getCurrentVersion", "isInSheetMetalFeature"],
    3: ["clusterPoints", "containsSketch", "valuesSortedById"],
    8: ["approximateSpline", "evaluateSpline"],
    9: ["transientIdToString", "unpackQuery"],
    10: ["getProperty", "setProperty", "sheetMetalApplyInFlat"],
    12: [
        "opBodyDraft",
        "opBooleanedPattern",
        "opBoundarySurface",
        "opConstrainedSurface",
        "opCreateBSplineCurve",
        "opCreateBSplineSurface",
        "opCreateCompositePart",
        "opCreateCurvesOnFace",
        "opCreateIsocline",
        "opCreateOutline",
        "opDeleteFace",
        "opDraft",
        "opDropCurve",
        "opEdgeChange",
        "opEditCurve",
        "opEnclose",
        "opExtendSheetBody",
        "opExtractSurface",
        "opExtractWires",
        "opFaceBlend",
        "opFillSurface",
        "opFitSpline",
        "opFlipOrientation",
        "opFullRoundFillet",
        "opHole",
        "opImportForeign",
        "opIntersectFaces",
        "opMateConnector",
        "opMergeContexts",
        "opModifyCompositePart",
        "opModifyFillet",
        "opMoveCurveBoundary",
        "opMoveFace",
        "opNameEntity",
        "opOffsetFace",
        "opOffsetWire",
        "opPolyline",
        "opReplaceFace",
        "opRuledSurface",
        "opSMFlatOperation",
        "opSplineThroughEdges",
        "opSplitByIsocline",
        "opSplitBySelfShadow",
        "opSplitEdges",
        "opSplitFace",
        "opSplitPart",
        "opTessellatedLoft",
        "opWrap",
    ],
    13: [
        "getFeatureName",
        "getLastActiveId",
        "getParameterToleranceInfo",
        "getTolerantParameterIds",
        "lastModifyingOperationId",
        "lastOperationId",
        "setFeaturePatternInstanceData",
        "unsetFeaturePatternInstanceData",
    ],
    14: [
        "evApproximateBSplineCurve",
        "evApproximateBSplineSurface",
        "evApproximateMassProperties",
        "evCollisionDetection",
        "evCornerType",
        "evEdgeConvexity",
        "evEdgeCurvatureDerivatives",
        "evEdgeCurvatures",
        "evFaceCurvatureDerivatives",
        "evFaceCurvatures",
        "evFacePeriodicity",
        "evFaceTangentPlanes",
        "evFaceTangentPlanesAtEdge",
        "evFaults",
        "evFilletRadius",
        "evMateConnector",
        "evMateConnectorCoordSystem",
        "evMaxPathDeviation",
        "evMaxTolerance",
        "evMeshPoints",
        "evOffsetDetection",
        "evPlanarEdge",
        "evPlanarEdges",
        "evPointsDeviation",
        "evRaycast",
        "evSheetMetalBendUp",
        "evSheetMetalFlatTransformation",
        "evSheetMetalFormToolBodies",
        "evSheetMetalHoleToolBodies",
        "evTessellatedLoftMatches",
        "evTolerances",
        "validateToleranceSchema",
    ],
    15: ["clusterBodies"],
    16: ["opDerip", "updateSheetMetalGeometry"],
    17: [
        "clampContextVersion",
        "convert",
        "skConicSegment",
        "skEllipticalArc",
        "skFitSpline",
        "skImage",
        "skInterpolatedSpline",
        "skInterpolatedSplineSegment",
        "skSpline",
        "skSplineSegment",
        "skText",
    ],
    19: ["addReferenceCSysFrame", "printTimer", "startTimer"],
    20: ["constructPaths"],
    21: ["evRuledSurfaceBases"],
    22: ["computeCurvePatternTransforms", "opOffsetCurveOnFace"],
    24: ["getHoleAttributes"],
};

/**
 * Constants std declares but Onshape never evaluates: `defineTolerance(f)` calls a
 * one-parameter function with no argument to package its precondition for the UI.
 */
const NEVER_EVALUATED = ["lengthTolerance", "diameterTolerance", "angleTolerance"];

const KNOWN = new Set(Object.values(NOT_YET_IMPLEMENTED).flat());
const LAYERS = [...Array(26).keys()];

let probe: StdLayerProbe;
let results: ProbeResult[];

beforeAll(async () => {
    await initWasm({ wasmBinary: WASM_BINARY });
    Object.defineProperty(globalThis, "shapeFactory", {
        value: new ShapeFactory(),
        writable: true,
        configurable: true,
    });
    probe = new StdLayerProbe();
    probe.loadAll();
    probe.constantsAll();
    probe.functionsAll();
    probe.featuresAll();
    results = probe.results;
    const { STD_LAYER_REPORT } = process.env;
    if (STD_LAYER_REPORT) writeFileSync(STD_LAYER_REPORT, JSON.stringify(results, null, 1));
}, 600_000);

afterAll(() => probe.dispose());

/** Faults that are not a still-missing built-in. */
function unexpectedFaults(result: ProbeResult): string[] {
    const faults =
        result.faults.length > 0 ? result.faults : result.outcome === "fault" ? [result.detail ?? ""] : [];
    return faults.filter((fault) => {
        const builtin = /^Unknown built-in @(\w+)/.exec(fault)?.[1];
        return builtin === undefined || !KNOWN.has(builtin);
    });
}

test("the std has 26 dependency layers over 276 modules", () => {
    expect(probe.graph.order).toHaveLength(276);
    expect(Math.max(...Object.values(probe.graph.layer))).toBe(25);
    expect(probe.graph.order[probe.graph.order.length - 1]).toBe("geometry.fs");
});

test("the not-yet-implemented list is exactly the built-ins std calls that are missing", () => {
    const byLayer: Record<number, string[]> = {};
    for (const { name, layer } of probe.missingBuiltins()) {
        byLayer[layer] = [...(byLayer[layer] ?? []), name];
    }
    expect(byLayer).toEqual(NOT_YET_IMPLEMENTED);
});

test("every module loads on its own", () => {
    expect(results.filter((r) => r.kind === "load" && r.outcome !== "ok").map((r) => r.module)).toEqual([]);
});

test("every top-level constant evaluates", () => {
    const failing = results.filter((r) => r.kind === "constant" && r.outcome !== "ok").map((r) => r.name);
    expect(failing.sort()).toEqual([...NEVER_EVALUATED].sort());
});

test.each(LAYERS)("layer %i: functions and features run without implementation faults", (layer) => {
    const faults = results
        .filter((r) => r.layer === layer && (r.kind === "function" || r.kind === "feature"))
        .flatMap((r) => unexpectedFaults(r).map((fault) => `${r.module} ${r.name}: ${fault}`));
    expect(faults).toEqual([]);
});

test("most exported functions are exercised", () => {
    const functions = results.filter((r) => r.kind === "function");
    const exercised = functions.filter((r) => r.outcome !== "untested");
    expect(functions.length).toBeGreaterThan(1300);
    expect(exercised.length / functions.length).toBeGreaterThan(0.9);
});
