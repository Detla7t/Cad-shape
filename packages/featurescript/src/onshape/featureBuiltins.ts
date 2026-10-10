// Part of the Chili3d Project, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

import { type ContextSnapshot, FsContext } from "../context/fsContext";
import { FsEnumValue, FsMap, type FsValue, fail, fsMap } from "../lang/values";
import { idString } from "../std/feature";
import type { StdBridge } from "./bridge";
import type { BuiltinRegistry } from "./registry";

/**
 * Feature bookkeeping: `defineFeature` brackets every feature with `@startFeature` and
 * `@endFeature` / `@abortFeature` (which rolls the context back to the start), and reports
 * failures through the feature status. The runner reads the top-level status afterwards.
 */

interface FeatureState {
    readonly snapshots: Map<string, ContextSnapshot>;
    readonly status: Map<string, FsMap>;
    readonly descriptions: Map<string, string>;
    readonly queryVariables: Map<string, FsValue>;
}

const states = new WeakMap<FsContext, FeatureState>();

export function featureState(context: FsContext): FeatureState {
    let state = states.get(context);
    if (state === undefined) {
        state = {
            snapshots: new Map(),
            status: new Map(),
            descriptions: new Map(),
            queryVariables: new Map(),
        };
        states.set(context, state);
    }
    return state;
}

/** The status a feature reported, undefined when it reported none (OK). */
export function reportedStatus(context: FsContext, id: string): FsMap | undefined {
    return states.get(context)?.status.get(id);
}

export type StatusKind = "OK" | "INFO" | "WARNING" | "ERROR";

/** A reported status as its kind and a readable message (the custom message, else the error enum). */
export function describeStatus(status: FsMap): { kind: StatusKind; message: string } {
    const name = (value: FsValue) =>
        value instanceof FsEnumValue ? value.name : typeof value === "string" ? value : "";
    const kind = (name(status.field("statusType")) || "OK") as StatusKind;
    const custom = status.field("statusMsg");
    if (typeof custom === "string" && custom !== "") return { kind, message: custom };
    const words = name(status.field("statusEnum")).toLowerCase().replace(/_/g, " ");
    return {
        kind,
        message: words === "" ? kind.toLowerCase() : words.charAt(0).toUpperCase() + words.slice(1),
    };
}

export function installFeatureBuiltins(define: BuiltinRegistry, bridge: StdBridge): void {
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
    // Variables: the document's (set by the runner) and those features attach.
    const variableArgs = (args: FsValue[]): [FsContext, FsMap] => {
        if (!(args[1] instanceof FsMap)) fail("Expected a variable definition map");
        return [FsContext.of(args[0]), args[1]];
    };
    define("setVariable", (args) => {
        const [context, definition] = variableArgs(args);
        const name = String(definition.field("name"));
        context.variables.set(name, definition.field("value"));
        const description = definition.field("description");
        if (typeof description === "string") featureState(context).descriptions.set(name, description);
        return undefined;
    });
    define("getVariable", (args) => {
        const [context, definition] = variableArgs(args);
        const name = String(definition.field("name"));
        if (context.variables.has(name)) return bridge.toStd(context.variables.get(name));
        if (definition.has("defaultValue")) return definition.field("defaultValue");
        fail(`Variable "${name}" not found`);
    });
    /**
     * Every variable on the context. Std's two-argument overloads pass
     * `{ includeConfiguration }`: false leaves the configuration variables out; the
     * one-argument form includes them, as Onshape's does.
     */
    const allVariables = (args: FsValue[], withDescriptions: boolean) => {
        const context = FsContext.of(args[0]);
        const options = args[1];
        const includeConfiguration =
            !(options instanceof FsMap) ||
            !options.has("includeConfiguration") ||
            options.field("includeConfiguration") !== false;
        const result = new FsMap();
        for (const [name, value] of context.variables) {
            if (!includeConfiguration && context.configurationVariables.has(name)) continue;
            const std = bridge.toStd(value);
            const description = featureState(context).descriptions.get(name) ?? "";
            result.set(name, withDescriptions ? fsMap({ value: std, description }) : std);
        }
        return result;
    };
    define("getAllVariables", (args) => allVariables(args, false));
    define("getAllVariablesAndDescriptions", (args) => allVariables(args, true));
    define("setQueryVariable", (args) => {
        const [context, definition] = variableArgs(args);
        featureState(context).queryVariables.set(String(definition.field("name")), definition.field("value"));
        return undefined;
    });
    define("getQueryVariable", (args) => {
        const [context, definition] = variableArgs(args);
        const name = String(definition.field("name"));
        const value = featureState(context).queryVariables.get(name);
        if (value !== undefined) return value;
        if (definition.has("defaultValue")) return definition.field("defaultValue");
        fail(`Query variable "${name}" not found`);
    });

    // There is no tolerance UI: no parameter is tolerant.
    define("getTolerantParameterIds", () => new FsMap());

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
