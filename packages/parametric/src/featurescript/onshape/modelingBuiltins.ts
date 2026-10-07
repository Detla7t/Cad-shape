// Part of the Chili3d Project, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

import { FsContext } from "../context/fsContext";
import { lastModifyingOperationIdOf, lastOperationIdOf } from "../context/queryTypes";
import { FsRuntimeError } from "../lang/errors";
import {
    FsArray,
    FsEnumValue,
    FsMap,
    FsOpaque,
    FsQuantity,
    type FsValue,
    fail,
    fsArray,
    fsMap,
    isCallable,
    LENGTH,
    type NativeFunction,
} from "../lang/values";
import { createNativeInterpreter } from "../nativeStd";
import { idString } from "../std/feature";
import { makePlane, makePlaneData, readPlane, type Vec3, vec } from "../std/geometry";
import type { StdBridge } from "./bridge";
import { featureState } from "./featureBuiltins";
import type { BuiltinRegistry } from "./registry";

/**
 * The modeling `@` built-ins — operations, sketches, queries, evaluation — forwarded to the
 * kernel layer (`context/`), which implements Onshape's operation signatures already:
 * each call translates its arguments with the bridge, runs the kernel implementation and
 * translates the result back.
 */
export function installModelingBuiltins(define: BuiltinRegistry, bridge: StdBridge): void {
    // The kernel implementations live in a native-std interpreter; only their functions are used.
    const kernelStd = createNativeInterpreter();
    const isType = (value: FsValue, type: string) => kernelStd.isNamedType(value, type);
    const kernel = (name: string): NativeFunction => {
        const fn = kernelStd.std.vars.get(name)?.value;
        if (!isCallable(fn) || fn.kind !== "native") fail(`No kernel implementation of ${name}`);
        return fn;
    };
    /** `@name(args)` → kernel `localName(args)`, with an optional rewrite of the translated arguments. */
    const forward = (name: string, localName = name, adapt?: (args: FsValue[]) => FsValue[]) => {
        const fn = kernel(localName);
        define(name, (args, site) => {
            const local = args.map((value) => bridge.toLocal(value));
            try {
                return bridge.toStd(fn.impl(adapt === undefined ? local : adapt(local), { ...site, isType }));
            } catch (error) {
                // As in Onshape, a failed operation leaves an ERROR status on its id: std's
                // `try(op(...))` + processSubfeatureStatus read it back.
                if (name.startsWith("op") && error instanceof FsRuntimeError)
                    reportOperationError(args, error);
                throw error;
            }
        });
    };
    /** Renames one field of the definition map (argument 1) — `{ "faces" : q }` → `{ "entities" : q }`. */
    const renameField = (from: string, to: string) => (args: FsValue[]) => {
        const definition = args[1];
        if (!(definition instanceof FsMap) || !definition.has(from)) return args;
        const copy = new FsMap(definition.pairs(), definition.tag);
        copy.set(to, definition.get(from));
        copy.delete(from);
        return [args[0], copy, ...args.slice(2)];
    };

    define("newContext", () => new FsContext().value);
    define("isContext", (args) => args[0] instanceof FsOpaque && args[0].typeName === "Context");
    define("isSketch", (args) => args[0] instanceof FsOpaque && args[0].typeName === "Sketch");
    // There is no sheet metal flat pattern in a context here.
    define("queryContainsFlattenedSheetMetal", () => false);

    // Operations.
    for (const name of [
        "opExtrude",
        "opRevolve",
        "opSweep",
        "opThicken",
        "opFillet",
        "opChamfer",
        "opShell",
        "opBoolean",
        "opTransform",
        "opPattern",
        "opDeleteBodies",
        "opPoint",
        "opPlane",
        "opHelix",
    ]) {
        forward(name);
    }

    forward("opSphere", "fSphere");
    // std's loft passes its ExtendedToolBodyType; the kernel reads SOLID / SURFACE by name.
    forward("opLoft", "opLoft", enumByName("bodyType"));

    // The frame a planar face coplanar with `plane` gets: world X projected into the plane,
    // world Y when the normal runs along X — the x axes of the default Top, Front and Right planes.
    define("alignCanonically", (args) => {
        const definition = bridge.toLocal(args[1]);
        if (!(definition instanceof FsMap)) fail("alignCanonically needs { plane }");
        const plane = readPlane(definition.field("plane"), "plane");
        const helper: Vec3 = Math.abs(plane.normal[0]) < 0.9 ? [1, 0, 0] : [0, 1, 0];
        const x = vec.sub(helper, vec.scale(plane.normal, vec.dot(helper, plane.normal)));
        return bridge.toStd(makePlane(makePlaneData(plane.origin, plane.normal, vec.normalize(x))));
    });

    // Feature patterns: no feature runs inside one here, so every remaining transform is identity.
    const identity = () =>
        fsMap({
            linear: fsArray([fsArray([1, 0, 0]), fsArray([0, 1, 0]), fsArray([0, 0, 1])]),
            translation: fsArray([0, 0, 0]),
        });
    define("getRemainderPatternTransform", identity);
    define("getFullPatternTransform", identity);
    define("isInFeaturePattern", () => false);

    // Queries: std passes `{ "query" : q }`.
    const unwrapQuery = (args: FsValue[]) => {
        const wrapper = args[1];
        return wrapper instanceof FsMap && wrapper.has("query") ? [args[0], wrapper.field("query")] : args;
    };
    forward("evaluateQuery", "evaluateQuery", unwrapQuery);
    forward("isQueryEmpty", "isQueryEmpty", unwrapQuery);
    define("evaluateQueryCount", (args, site) => {
        const result = kernel("evaluateQuery").impl(unwrapQuery(args.map((value) => bridge.toLocal(value))), {
            ...site,
            isType,
        });
        return result instanceof FsArray ? result.size : 0;
    });

    // Sketches: `@newSketch` receives the resolved plane (std's `newSketch` works it out).
    forward("newSketch", "newSketchOnPlane");
    for (const name of ["skLineSegment", "skCircle", "skEllipse", "skArc", "skPoint", "skBezier"]) {
        forward(name, name, sketchLengths);
    }
    forward("skConstraint");
    forward("skSetInitialGuess");
    forward("skSolve");

    // Evaluation.
    for (const name of [
        "evVertexPoint",
        "evPlane",
        "evLine",
        "evAxis",
        "evApproximateCentroid",
        "evDistance",
        "evCurveDefinition",
        "evSurfaceDefinition",
        "evOwnerSketchPlane",
        "evEdgeTangentLines",
        "evEdgeConvexity",
        "evFilletRadius",
    ]) {
        forward(name);
    }

    // Operation history: what `startTracking` and `lastModifyingOperationId` read.
    define("lastOperationId", (args) => lastOperationIdOf(FsContext.of(args[0])));
    define("lastModifyingOperationId", (args) => {
        const definition = args[1];
        if (!(definition instanceof FsMap)) fail("lastModifyingOperationId needs { entity }");
        return lastModifyingOperationIdOf(FsContext.of(args[0]), bridge.toLocal(definition.field("entity")));
    });
    // Transient ids are strings already.
    define("transientIdToString", (args) => String(args[0]));
    forward("evLength", "evLength", renameField("edges", "entities"));
    forward("evArea", "evArea", renameField("faces", "entities"));
    forward("evVolume", "evVolume", renameField("bodies", "entities"));
    forward("evBox", "evBox3d");
}

/** An enum field of an operation's definition (argument 2) by member name: `ExtendedToolBodyType.SOLID` → "SOLID". */
function enumByName(field: string) {
    return (args: FsValue[]): FsValue[] => {
        const definition = args[2];
        const value = definition instanceof FsMap ? definition.field(field) : undefined;
        if (!(definition instanceof FsMap) || !(value instanceof FsEnumValue)) return args;
        const copy = new FsMap(definition.pairs(), definition.tag);
        copy.set(field, value.name);
        return [args[0], args[1], copy, ...args.slice(3)];
    };
}

function reportOperationError(args: FsValue[], error: FsRuntimeError): void {
    if (!(args[0] instanceof FsOpaque) || !(args[1] instanceof FsArray)) return;
    featureState(FsContext.of(args[0])).status.set(
        idString(args[1]),
        fsMap({ statusType: "ERROR", statusEnum: "CUSTOM_ERROR", statusMsg: error.message }),
    );
}

/** Sketch built-ins take raw numbers as meters (`skRectangle` passes stripped values). */
const POINT_FIELDS = ["start", "end", "mid", "center", "point", "firstCorner", "secondCorner"];
const LENGTH_FIELDS = ["radius", "majorRadius", "minorRadius"];

function sketchLengths(args: FsValue[]): FsValue[] {
    const value = args[2];
    if (!(value instanceof FsMap)) return args;
    const copy = new FsMap(value.pairs(), value.tag);
    for (const field of POINT_FIELDS) {
        const point = copy.field(field);
        if (point instanceof FsArray && point.items.every((item) => typeof item === "number")) {
            copy.set(
                field,
                new FsArray(
                    point.items.map((item) => new FsQuantity(item as number, LENGTH)),
                    "Vector",
                ),
            );
        }
    }
    for (const field of LENGTH_FIELDS) {
        const length = copy.field(field);
        if (typeof length === "number") copy.set(field, new FsQuantity(length, LENGTH));
    }
    return [args[0], args[1], copy, ...args.slice(3)];
}
