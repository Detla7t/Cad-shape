// Part of the Chili3d Project, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

import { ShapeTypes } from "@chili3d/core";
import {
    type BodyState,
    type ContextSnapshot,
    type EntityKind,
    entityAttr,
    FsContext,
} from "../context/fsContext";
import { resolveQuery } from "../context/queries";
import { FsSketch } from "../context/sketch";
import type { Interpreter } from "../lang/interpreter";
import {
    FsArray,
    FsMap,
    type FsValue,
    fail,
    fsArray,
    fsMap,
    isCallable,
    type NativeFunction,
} from "../lang/values";
import { createdByMatches, makeId } from "../std/feature";
import { type AffineData, composeAffine, IDENTITY, invertAffine, readTransform } from "../std/geometry";
import type { StdBridge } from "./bridge";
import type { BuiltinRegistry } from "./registry";

/**
 * What Onshape's context knows about the run that is building it: the operations
 * executed so far (each `op*` built-in, and each sketch, with the bodies before and
 * after), the features started and still active (`@startFeature` ... `@endFeature` /
 * `@abortFeature`), the stack of feature pattern instances, and the context's
 * FeatureScript version. `lastOperationId`, `lastModifyingOperationId`,
 * `getLastActiveId`, `valuesSortedById`, the feature pattern transforms and
 * `isInSheetMetalFeature` read it.
 */

interface OperationRecord {
    readonly id: readonly string[];
    readonly before: ContextSnapshot;
    readonly after: ContextSnapshot;
}

interface ActiveFeature {
    readonly id: readonly string[];
    readonly sheetMetal: boolean;
    /** Operations recorded before the feature started — what an abort rolls the log back to. */
    readonly operationCount: number;
}

interface PatternInstance {
    readonly id: readonly string[];
    readonly transform: AffineData;
}

interface Tracking {
    readonly operations: OperationRecord[];
    readonly features: ActiveFeature[];
    /** Start order of every feature id ever started. */
    readonly started: Map<string, number>;
    /** Ids of the sketches opened in this context. */
    readonly sketches: Set<string>;
    readonly patterns: PatternInstance[];
    version: number;
}

const trackings = new WeakMap<FsContext, Tracking>();

type NativeImpl = NativeFunction["impl"];

function trackingOf(context: FsContext, version: number): Tracking {
    let tracking = trackings.get(context);
    if (tracking === undefined) {
        tracking = {
            operations: [],
            features: [],
            started: new Map(),
            sketches: new Set(),
            patterns: [],
            version,
        };
        trackings.set(context, tracking);
    }
    return tracking;
}

/** The components of an Id, or undefined for anything else. */
function idParts(value: FsValue): string[] | undefined {
    if (!(value instanceof FsArray)) return undefined;
    const parts: string[] = [];
    for (const item of value.items) {
        if (typeof item !== "string") return undefined;
        parts.push(item);
    }
    return parts;
}

const joined = (parts: readonly string[]) => parts.join("/");

function contextOrUndefined(value: FsValue): FsContext | undefined {
    try {
        return FsContext.of(value);
    } catch {
        return undefined;
    }
}

export function installTrackingBuiltins(
    interpreter: Interpreter,
    define: BuiltinRegistry,
    bridge: StdBridge,
    version: number,
): void {
    const tracking = (value: FsValue) => trackingOf(FsContext.of(value), version);

    /** Re-registers an installed built-in with `around` wrapped about its implementation. */
    const wrap = (name: string, around: (impl: NativeImpl) => NativeImpl) => {
        const existing = interpreter.builtins.get(name);
        if (isCallable(existing) && existing.kind === "native") define(name, around(existing.impl));
    };

    /** Runs an operation, recording it (with the bodies around it) when it succeeds. */
    const record = (
        context: FsContext | undefined,
        id: string[] | undefined,
        run: () => FsValue,
    ): FsValue => {
        if (context === undefined || id === undefined) return run();
        const before = context.snapshot();
        const result = run();
        trackingOf(context, version).operations.push({ id, before, after: context.snapshot() });
        return result;
    };

    // Every operation built-in (installed before this one) records itself.
    for (const name of [...interpreter.builtins.keys()]) {
        if (!/^op[A-Z]/.test(name)) continue;
        wrap(
            name,
            (impl) => (args, site) =>
                record(contextOrUndefined(args[0]), idParts(args[1]), () => impl(args, site)),
        );
    }
    // A sketch is an operation too: `newSketch` names it, `skSolve` builds its bodies.
    wrap("newSketch", (impl) => (args, site) => {
        const context = contextOrUndefined(args[0]);
        const id = idParts(args[1]);
        if (context !== undefined && id !== undefined) trackingOf(context, version).sketches.add(joined(id));
        return record(context, id, () => impl(args, site));
    });
    wrap("skSolve", (impl) => (args, site) => {
        const sketch = args[0] === undefined ? undefined : sketchOrUndefined(args[0]);
        return record(sketch?.context, sketch?.id.split("/"), () => impl(args, site));
    });

    // The active feature stack.
    wrap("startFeature", (impl) => (args, site) => {
        const result = impl(args, site);
        const context = contextOrUndefined(args[0]);
        const id = idParts(args[1]);
        if (context !== undefined && id !== undefined) {
            const state = trackingOf(context, version);
            const definition = args[2];
            state.features.push({
                id,
                sheetMetal: definition instanceof FsMap && definition.field("isSheetMetal") === true,
                operationCount: state.operations.length,
            });
            if (!state.started.has(joined(id))) state.started.set(joined(id), state.started.size);
        }
        return result;
    });
    const finish =
        (aborted: boolean) =>
        (impl: NativeImpl): NativeImpl =>
        (args, site) => {
            const result = impl(args, site);
            const context = contextOrUndefined(args[0]);
            const id = idParts(args[1]);
            if (context !== undefined && id !== undefined) {
                const state = trackingOf(context, version);
                const key = joined(id);
                const index = state.features.findLastIndex((feature) => joined(feature.id) === key);
                if (index >= 0) {
                    // An aborted feature's operations were rolled back with its geometry.
                    if (aborted)
                        state.operations.length = Math.min(
                            state.operations.length,
                            state.features[index].operationCount,
                        );
                    state.features.length = index;
                }
                // Ending a feature pops the pattern instances it pushed.
                const nested = state.patterns.findIndex((instance) =>
                    joined(instance.id).startsWith(`${key}/`),
                );
                if (nested >= 0) state.patterns.length = nested;
            }
            return result;
        };
    wrap("endFeature", finish(false));
    wrap("abortFeature", finish(true));

    define("lastOperationId", (args) => {
        const operations = tracking(args[0]).operations;
        return makeId(operations.length === 0 ? [] : [...operations[operations.length - 1].id]);
    });
    define("lastModifyingOperationId", (args) => {
        const context = FsContext.of(args[0]);
        const definition = args[1];
        if (!(definition instanceof FsMap)) fail("lastModifyingOperationId needs { entity }");
        const ref = resolveQuery(context, bridge.toLocal(definition.field("entity")))[0];
        if (ref === undefined) fail("lastModifyingOperationId: the query resolves to nothing");
        const attr = entityAttr(ref);
        const operations = trackingOf(context, version).operations;
        for (let k = operations.length - 1; k >= 0; k--) {
            const operation = operations[k];
            const after = locate(operation.after, attr.serial, ref.kind);
            if (after === undefined) continue;
            const before = locate(operation.before, attr.serial, ref.kind);
            if (before === undefined || modified(before, after, ref.kind)) return makeId([...operation.id]);
        }
        return makeId(attr.createdBy.split("/"));
    });
    define("getLastActiveId", (args) => {
        const features = tracking(args[0]).features;
        return makeId(features.length === 0 ? [] : [...features[features.length - 1].id]);
    });
    define("valuesSortedById", (args) => {
        const started = tracking(args[0]).started;
        const map = args[1];
        if (!(map instanceof FsMap)) fail("valuesSortedById needs a map from Id");
        const order = (key: FsValue) => {
            const parts = idParts(key);
            return (parts === undefined ? undefined : started.get(joined(parts))) ?? Number.POSITIVE_INFINITY;
        };
        // Unstarted ids keep their map order after the started ones (the sort is stable).
        const entries = [...map.pairs()].sort((a, b) => order(a[0]) - order(b[0]));
        return fsArray(entries.map(([, value]) => value));
    });
    define("containsSketch", (args) => {
        const context = FsContext.of(args[0]);
        const map = args[1];
        if (!(map instanceof FsMap)) fail("containsSketch needs a map from Id");
        const sketches = [
            ...trackingOf(context, version).sketches,
            ...context.bodies.filter((body) => body.flags.sketch).map((body) => body.bodyAttr.createdBy),
        ];
        return map.pairs().some(([key]) => {
            const parts = idParts(key);
            return parts !== undefined && sketches.includes(joined(parts));
        });
    });
    // Feature names belong to the Part Studio's feature list, which a context does not
    // hold; Onshape answers "" for a feature it does not know.
    define("getFeatureName", () => "");

    const members = new Map<number, FsValue>();
    define("getCurrentVersion", (args) => {
        const current = tracking(args[0]).version;
        let member = members.get(current);
        if (member === undefined) {
            member = versionMember(bridge, current);
            members.set(current, member);
        }
        return member;
    });
    define("isInSheetMetalFeature", (args) =>
        tracking(args[0]).features.some((feature) => feature.sheetMetal),
    );
    // A context built elsewhere (a derived Part Studio) caps this context's version at its own.
    define("clampContextVersion", (args) => {
        const state = tracking(args[0]);
        const loaded =
            args[1] instanceof FsMap ? contextOrUndefined(args[1].field("loadedContext")) : undefined;
        if (loaded !== undefined)
            state.version = Math.min(state.version, trackingOf(loaded, version).version);
        return undefined;
    });
    // Every context here is built at the current version: there is nothing to upgrade.
    define("convert", (args) => args[0]);

    // Feature patterns: a stack of instance transforms, outermost first (these replace the
    // identity stand-ins of `modelingBuiltins.ts`, installed before).
    define("setFeaturePatternInstanceData", (args) => {
        const state = tracking(args[0]);
        const id = idParts(args[1]);
        const definition = args[2];
        if (id === undefined) fail("setFeaturePatternInstanceData needs an instance Id");
        if (!(definition instanceof FsMap)) fail("setFeaturePatternInstanceData needs { transform }");
        const transform = readTransform(bridge.toLocal(definition.field("transform")), "transform");
        state.patterns.push({ id, transform });
        return undefined;
    });
    define("unsetFeaturePatternInstanceData", (args) => {
        const state = tracking(args[0]);
        const id = idParts(args[1]);
        const top = state.patterns[state.patterns.length - 1];
        if (top === undefined || id === undefined || joined(top.id) !== joined(id))
            fail("unsetFeaturePatternInstanceData: the id is not the innermost pattern instance");
        state.patterns.pop();
        return undefined;
    });
    define("isInFeaturePattern", (args) => tracking(args[0]).patterns.length > 0);
    define("getFullPatternTransform", (args) => builtinTransform(fullTransform(tracking(args[0]).patterns)));
    define("getRemainderPatternTransform", (args) => {
        const context = FsContext.of(args[0]);
        const patterns = trackingOf(context, version).patterns;
        if (patterns.length === 0) return builtinTransform(IDENTITY);
        const full = fullTransform(patterns);
        const definition = args[1];
        let createdBy: string[] = [];
        try {
            const references = definition instanceof FsMap ? definition.field("references") : undefined;
            if (references !== undefined)
                createdBy = resolveQuery(context, bridge.toLocal(references)).map(
                    (ref) => entityAttr(ref).createdBy,
                );
        } catch {
            // A reference query this context cannot resolve references nothing patterned.
        }
        // The deepest instance any reference was created in has already moved them by S;
        // the rest of the full transform F remains: R * S = F.
        const deepest = patterns.findLastIndex((instance) =>
            createdBy.some((created) => createdByMatches(created, joined(instance.id))),
        );
        if (deepest < 0) return builtinTransform(full);
        const applied = fullTransform(patterns.slice(0, deepest + 1));
        return builtinTransform(composeAffine(full, invertAffine(applied)));
    });
}

function sketchOrUndefined(value: FsValue): FsSketch | undefined {
    try {
        return FsSketch.of(value);
    } catch {
        return undefined;
    }
}

/** The composition of the stacked instance transforms: an outer pattern moves the inner ones. */
function fullTransform(patterns: readonly PatternInstance[]): AffineData {
    return patterns.reduce((acc, instance) => composeAffine(acc, instance.transform), IDENTITY);
}

/** A transform the way the `@` built-ins return one (`transformFromBuiltin` adds the meters). */
function builtinTransform(affine: AffineData): FsMap {
    const m = affine.m;
    return fsMap({
        linear: fsArray([0, 1, 2].map((r) => fsArray([m[3 * r], m[3 * r + 1], m[3 * r + 2]]))),
        translation: fsArray([...affine.t]),
    });
}

/** The `FeatureScriptVersionNumber` member of a version: the newest one not after it. */
function versionMember(bridge: StdBridge, version: number): FsValue {
    let best: FsValue;
    let bestNumber = -1;
    for (const member of bridge.stdEnum("FeatureScriptVersionNumber").values.values()) {
        const match = /^V(\d+)/.exec(member.name);
        const number = match === null ? -1 : Number(match[1]);
        if (number <= version && number >= bestNumber) {
            best = member;
            bestNumber = number;
        }
    }
    if (best === undefined) fail(`No FeatureScript version member for ${version}`);
    return best;
}

/** Where an entity (by serial) sits in a snapshot: its body's state and its sub-shape index. */
function locate(
    snapshot: ContextSnapshot,
    serial: number,
    kind: EntityKind,
): { state: BodyState; index: number } | undefined {
    for (const { body, state } of snapshot.bodies) {
        if (kind === "BODY") {
            if (body.bodyAttr.serial === serial) return { state, index: -1 };
            continue;
        }
        const attrs =
            kind === "FACE" ? state.faceAttrs : kind === "EDGE" ? state.edgeAttrs : state.vertexAttrs;
        const index = attrs.findIndex((attr) => attr.serial === serial);
        if (index >= 0) return { state, index };
    }
    return undefined;
}

const SHAPE_TYPE = { FACE: ShapeTypes.face, EDGE: ShapeTypes.edge, VERTEX: ShapeTypes.vertex } as const;

/** Did the operation change the entity: new body geometry and, for a sub-shape, a different kernel shape. */
function modified(
    before: { state: BodyState; index: number },
    after: { state: BodyState; index: number },
    kind: EntityKind,
): boolean {
    if (before.state.shape === after.state.shape) return false;
    if (kind === "BODY") return true;
    const type = SHAPE_TYPE[kind];
    const old = before.state.shape.findSubShapes(type);
    const now = after.state.shape.findSubShapes(type);
    try {
        const a = old[before.index];
        const b = now[after.index];
        return a === undefined || b === undefined || !a.isSame(b);
    } finally {
        for (const shape of [...old, ...now]) shape.dispose();
    }
}
