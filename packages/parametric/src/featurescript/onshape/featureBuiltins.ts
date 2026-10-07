// Part of the Chili3d Project, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

import { type ContextSnapshot, FsContext } from "../context/fsContext";
import { FsMap, type FsValue, fsMap } from "../lang/values";
import { idString } from "../std/feature";
import type { BuiltinRegistry } from "./registry";

/**
 * Feature bookkeeping: `defineFeature` brackets every feature with `@startFeature` and
 * `@endFeature` / `@abortFeature` (which rolls the context back to the start), and reports
 * failures through the feature status. The runner reads the top-level status afterwards.
 */

interface FeatureState {
    readonly snapshots: Map<string, ContextSnapshot>;
    readonly status: Map<string, FsMap>;
}

const states = new WeakMap<FsContext, FeatureState>();

export function featureState(context: FsContext): FeatureState {
    let state = states.get(context);
    if (state === undefined) {
        state = { snapshots: new Map(), status: new Map() };
        states.set(context, state);
    }
    return state;
}

/** The status a feature reported, undefined when it reported none (OK). */
export function reportedStatus(context: FsContext, id: string): FsMap | undefined {
    return states.get(context)?.status.get(id);
}

export function installFeatureBuiltins(define: BuiltinRegistry): void {
    const target = (args: FsValue[]): [FeatureState, FsContext, string] => {
        const context = FsContext.of(args[0]);
        return [featureState(context), context, idString(args[1])];
    };
    define("startFeature", (args) => {
        const [state, context, id] = target(args);
        state.snapshots.set(id, context.snapshot());
        return fsMap({ id });
    });
    define("endFeature", (args) => {
        const [state, , id] = target(args);
        state.snapshots.delete(id);
        return undefined;
    });
    define("abortFeature", (args) => {
        const [state, context, id] = target(args);
        const snapshot = state.snapshots.get(id);
        if (snapshot !== undefined) context.restore(snapshot);
        state.snapshots.delete(id);
        return undefined;
    });
    define("functionReportFeatureStatus", (args) => {
        const [state, , id] = target(args);
        if (args[2] instanceof FsMap) state.status.set(id, args[2]);
        return undefined;
    });
    define("functionGetFeatureStatus", (args) => {
        const [state, , id] = target(args);
        const status = state.status.get(id);
        return status ?? fsMap({ statusType: "OK", statusEnum: "NO_ERROR" });
    });
    define("clearFeatureStatus", (args) => {
        const [state, , id] = target(args);
        state.status.delete(id);
        return undefined;
    });
    // Error highlighting and parameter bookkeeping have no UI here.
    for (const name of [
        "setErrorEntities",
        "recordQuery",
        "setPatternData",
        "setHighlightedEntities",
        "transferSubfeatureErrorDisplay",
        "setFeatureComputedParameter",
        "setFeatureHiddenParameters",
        "setDimensionedEntities",
        "setExternalDisambiguation",
        "skipOrderDisambiguation",
        "addManipulators",
        "addDebugEntities",
        "addAuxiliaryEntities",
    ]) {
        define(name, () => undefined);
    }
}
