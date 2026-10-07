// Part of the Chili3d Project, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

import { FsContext } from "../../../src/featurescript/context/fsContext";
import { analyzeFeature, type FsParameterSpec } from "../../../src/featurescript/featureSpec";
import type { TypeReference } from "../../../src/featurescript/lang/ast";
import { FsAbort, FsError, FsThrow } from "../../../src/featurescript/lang/errors";
import {
    type FeatureExport,
    Interpreter,
    type ModuleInstance,
} from "../../../src/featurescript/lang/interpreter";
import { parseExpression } from "../../../src/featurescript/lang/parser";
import {
    type FeatureDefinition,
    FsEnumType,
    FsMap,
    type FsValue,
    isCallable,
    type UserFunction,
} from "../../../src/featurescript/lang/values";
import { describeStatus, reportedStatus } from "../../../src/featurescript/onshape/featureBuiltins";
import { createOnshapeInterpreter } from "../../../src/featurescript/onshape/onshapeStd";
import { ONSHAPE_STD, STD_BUNDLE } from "./onshapeStd";

/**
 * Walks Onshape's std bottom-up — modules in dependency order (a module's layer is one
 * more than its deepest import) — and exercises everything each module defines: it
 * loads on its own, every top-level constant evaluates, every exported function (each
 * overload separately) is called with type-directed arguments, and every feature runs
 * with the defaults its precondition implies. Outcomes separate the input domain (std
 * rejecting an argument: a thrown regen error, a failed precondition) from faults of
 * this implementation (an unknown `@` built-in, an undefined name, a JavaScript error
 * inside a built-in, a runaway loop) — recorded wherever they are raised, even when
 * std's own `try` swallows them into a feature status.
 */

interface InterpreterInternals {
    isType(value: FsValue, type: TypeReference, env: unknown): boolean;
}

export type Outcome = "ok" | "domain" | "fault" | "untested";

export interface ProbeResult {
    readonly module: string;
    readonly layer: number;
    readonly kind: "load" | "constant" | "function" | "feature";
    readonly name: string;
    readonly outcome: Outcome;
    readonly detail?: string;
    readonly faults: readonly string[];
}

export interface StdGraph {
    readonly deps: Readonly<Record<string, readonly string[]>>;
    readonly layer: Readonly<Record<string, number>>;
    /** Modules ordered by layer, then name. */
    readonly order: readonly string[];
}

export function stdGraph(files: Readonly<Record<string, string>> = STD_BUNDLE.files): StdGraph {
    const deps: Record<string, string[]> = {};
    for (const [name, source] of Object.entries(files)) {
        deps[name] = [...source.matchAll(/import\s*\(\s*path\s*:\s*"onshape\/std\/([^"]+)"/g)].map(
            (match) => match[1],
        );
    }
    const layer: Record<string, number> = {};
    const visit = (name: string, stack: Set<string>): number => {
        if (layer[name] !== undefined) return layer[name];
        if (stack.has(name)) return 0;
        stack.add(name);
        const imports = deps[name] ?? [];
        layer[name] = imports.length === 0 ? 0 : 1 + Math.max(...imports.map((d) => visit(d, stack)));
        stack.delete(name);
        return layer[name];
    };
    for (const name of Object.keys(files)) visit(name, new Set());
    const order = Object.keys(files).sort((a, b) => layer[a] - layer[b] || a.localeCompare(b));
    return { deps, layer, order };
}

/** Argument candidates, evaluated in a module that imports all of std. */
const POOL_SOURCES = [
    "1.5",
    "2",
    "0",
    "-1",
    "true",
    "false",
    '"abc"',
    '""',
    "[1, 2, 3]",
    "[]",
    "{}",
    '{ "a" : 1 }',
    "1 * meter",
    "0.5 * meter",
    "-0.25 * meter",
    "30 * degree",
    "1 * radian",
    "2 * meter ^ 2",
    "3 * meter ^ 3",
    "1 * kilogram",
    "2 * second",
    "vector(1, 2, 3)",
    "vector(0, 0, 1)",
    "vector(1, 2)",
    "vector(1, 2, 3) * meter",
    "vector(1, 0) * meter",
    "[vector(0, 0, 0) * meter, vector(1, 0, 0) * meter, vector(1, 1, 0) * meter]",
    "[vector(0, 0) * meter, vector(1, 0) * meter, vector(1, 1) * meter]",
    "identityMatrix(3)",
    "identityMatrix(2)",
    "identityMatrix(4)",
    "identityTransform()",
    "transform(vector(1, 0, 0) * meter)",
    "rotationAround(line(vector(0, 0, 0) * meter, vector(0, 0, 1)), 90 * degree)",
    "XY_PLANE",
    "plane(vector(0, 0, 1) * meter, vector(0, 0, 1), vector(1, 0, 0))",
    "line(vector(0, 0, 0) * meter, vector(1, 0, 0))",
    "WORLD_COORD_SYSTEM",
    "coordSystem(vector(1, 0, 0) * meter, vector(1, 0, 0), vector(0, 0, 1))",
    "circle(WORLD_COORD_SYSTEM, 1 * meter)",
    "ellipse(WORLD_COORD_SYSTEM, 2 * meter, 1 * meter)",
    "box3d(vector(0, 0, 0) * meter, vector(1, 1, 1) * meter)",
    "cylinder(WORLD_COORD_SYSTEM, 1 * meter)",
    "cone(WORLD_COORD_SYSTEM, 30 * degree)",
    "sphere(WORLD_COORD_SYSTEM, 1 * meter)",
    "torus(WORLD_COORD_SYSTEM, 0.2 * meter, 1 * meter)",
    "qEverything()",
    "qNothing()",
    "qEverything(EntityType.FACE)",
    "qEverything(EntityType.EDGE)",
    "qEverything(EntityType.BODY)",
    "qEverything(EntityType.VERTEX)",
    'makeId("probe")',
    "function(x) { return x; }",
];

const UNTYPED = ["1.5", "vector(1, 2, 3) * meter", '"abc"', "qEverything(EntityType.FACE)", "{}"];

const PROBE_SOURCE = `FeatureScript ${STD_BUNDLE.version};
import(path : "onshape/std/geometry.fs", version : "${STD_BUNDLE.version}.0");
export function freshContext() returns Context
{
    var context = newContext();
    fCuboid(context, makeId("box"), { "corner1" : vector(0, 0, 0) * meter, "corner2" : vector(1, 1, 1) * meter });
    return context;
}
`;

/** Messages of this implementation failing, as opposed to std rejecting its input. */
const FAULT_PATTERN =
    /Unknown built-in|is not defined|is not a function|undefined is not|Maximum call stack|No kernel implementation|not implemented|Unsupported/i;

export class StdLayerProbe {
    readonly interpreter: Interpreter;
    readonly graph = stdGraph();
    readonly results: ProbeResult[] = [];
    private faults: string[] = [];
    private muted = 0;
    private readonly seen = new WeakSet<object>();
    private probe!: ModuleInstance;
    private pool: FsValue[] = [];
    private readonly contexts: FsContext[] = [];
    private readonly featureValues = new Map<string, FsValue>();
    private readonly restore: (() => void)[] = [];

    constructor(maxSteps = 3_000_000) {
        this.interpreter = createOnshapeInterpreter({ std: ONSHAPE_STD, maxSteps });
        this.instrument();
    }

    dispose(): void {
        for (const undo of this.restore.splice(0)) undo();
        this.disposeContexts();
    }

    // ------------------------------------------------------------------ Fault recording

    /** Records implementation faults where they are raised, before any `try` can swallow them. */
    private instrument(): void {
        const proto = Interpreter.prototype as unknown as Record<string, (...args: unknown[]) => unknown>;
        const record = (error: unknown) => {
            if (this.muted > 0) return;
            if (typeof error !== "object" || error === null || this.seen.has(error)) return;
            this.seen.add(error);
            const message = error instanceof Error ? error.message : String(error);
            if (!(error instanceof FsError)) this.faults.push(`JS ${message}`);
            else if (error instanceof FsAbort) this.faults.push(`ABORT ${message}`);
            else if (!(error instanceof FsThrow) && FAULT_PATTERN.test(message)) this.faults.push(message);
        };
        for (const method of ["evaluate", "callNative", "resolveName"]) {
            const original = proto[method];
            proto[method] = function (this: unknown, ...args: unknown[]) {
                try {
                    return original.apply(this, args);
                } catch (error) {
                    record(error);
                    throw error;
                }
            };
            this.restore.push(() => {
                proto[method] = original;
            });
        }
    }

    private takeFaults(): string[] {
        const faults = [...new Set(this.faults)];
        this.faults = [];
        return faults;
    }

    // ------------------------------------------------------------------ Phases

    /** Phase 1: every module loads (bottom-up, so the first failure is the most fundamental). */
    loadAll(): void {
        for (const name of this.graph.order) {
            const layer = this.graph.layer[name];
            try {
                this.load(name);
                this.push(name, layer, "load", name, "ok");
            } catch (error) {
                this.push(name, layer, "load", name, "fault", message(error));
            }
        }
        this.probe = this.interpreter.load({ path: "std-layer-probe", source: PROBE_SOURCE });
        this.pool = this.buildPool();
    }

    /** Phase 2: every top-level constant of every module evaluates. */
    constantsAll(): void {
        for (const name of this.graph.order) {
            const module = this.moduleOf(name);
            if (module === undefined) continue;
            for (const item of module.program.body) {
                if (item.kind !== "Const") continue;
                this.interpreter.resetBudget();
                try {
                    this.interpreter.evaluate(parseExpression(item.name), module.env);
                    this.push(name, this.graph.layer[name], "constant", item.name, "ok");
                } catch (error) {
                    this.push(
                        name,
                        this.graph.layer[name],
                        "constant",
                        item.name,
                        classify(error),
                        message(error),
                    );
                }
            }
        }
    }

    /** Phase 3: every function a module declares and exports, each overload on its own. */
    functionsAll(filter?: (module: string) => boolean): void {
        for (const name of this.graph.order) {
            if (filter !== undefined && !filter(name)) continue;
            const module = this.moduleOf(name);
            if (module === undefined) continue;
            const featureNames = new Set(module.features.map((feature) => feature.name));
            for (const [exported, value] of module.exports) {
                if (featureNames.has(exported) || !isCallable(value)) continue;
                const candidates =
                    value.kind === "user" ? [value] : value.kind === "overloads" ? value.candidates : [];
                candidates.forEach((fn, index) => {
                    if (fn.pos.file !== module.path) return; // declared elsewhere, probed there
                    const label = candidates.length > 1 ? `${exported}#${index}` : exported;
                    this.probeFunction(name, label, fn);
                });
            }
        }
    }

    /** Phase 4: every feature, with its precondition's defaults and plausible selections. */
    featuresAll(filter?: (module: string) => boolean): void {
        for (const name of this.graph.order) {
            if (filter !== undefined && !filter(name)) continue;
            const module = this.moduleOf(name);
            if (module === undefined) continue;
            for (const feature of this.featuresOf(module)) this.probeFeature(name, feature, module);
        }
    }

    /**
     * Every `@name` std's source refers to that no installer registered, with the
     * lowest layer that refers to it and how many modules do.
     */
    missingBuiltins(): { name: string; layer: number; modules: string[] }[] {
        const missing = new Map<string, { name: string; layer: number; modules: string[] }>();
        for (const name of this.graph.order) {
            const source = STD_BUNDLE.files[name].replace(/\/\/[^\n]*|\/\*[\s\S]*?\*\//g, "");
            for (const match of source.matchAll(/@([A-Za-z_]\w*)\s*\(/g)) {
                const builtin = match[1];
                if (this.interpreter.builtins.has(builtin) || this.interpreter.std.vars.has(builtin))
                    continue;
                const entry = missing.get(builtin) ?? {
                    name: builtin,
                    layer: this.graph.layer[name],
                    modules: [],
                };
                if (!entry.modules.includes(name)) entry.modules.push(name);
                missing.set(builtin, entry);
            }
        }
        return [...missing.values()].sort((a, b) => a.layer - b.layer || a.name.localeCompare(b.name));
    }

    // ------------------------------------------------------------------ Probes

    private probeFunction(module: string, label: string, fn: UserFunction): void {
        const layer = this.graph.layer[module];
        const choices: (FsValue[] | "context")[] = [];
        for (const param of fn.params) {
            const typeRef = param.type;
            const type = typeRef?.name;
            if (type === "Context" || (type === undefined && param.name === "context")) {
                choices.push("context");
                continue;
            }
            const values =
                typeRef === undefined
                    ? UNTYPED.map((source) => this.evalProbe(source))
                    : this.pool.filter((value) => this.matches(value, typeRef, fn.closure));
            if (values.length === 0) {
                this.push(module, layer, "function", label, "untested", `no value of type ${type}`);
                return;
            }
            choices.push(values.slice(0, 8));
        }
        // One factor at a time: all first candidates, then vary each parameter alone.
        const attempts: number[][] = [choices.map(() => 0)];
        choices.forEach((choice, i) => {
            if (choice === "context") return;
            for (let k = 1; k < choice.length; k++) attempts.push(choices.map((_, j) => (j === i ? k : 0)));
        });
        let best: { outcome: Outcome; detail?: string } = { outcome: "fault", detail: "not run" };
        const faults = new Set<string>();
        for (const attempt of attempts.slice(0, 40)) {
            const args = choices.map((choice, i) =>
                choice === "context" ? this.freshContext() : choice[attempt[i]],
            );
            this.interpreter.resetBudget();
            let outcome: Outcome;
            let detail: string | undefined;
            try {
                this.interpreter.callFunction(fn, args);
                outcome = "ok";
            } catch (error) {
                outcome = classify(error);
                detail = message(error);
            }
            for (const fault of this.takeFaults()) faults.add(fault);
            this.disposeContexts();
            if (rank(outcome) > rank(best.outcome) || best.detail === "not run") best = { outcome, detail };
            if (outcome === "ok") break;
        }
        this.push(module, layer, "function", label, faults.size > 0 ? "fault" : best.outcome, best.detail, [
            ...faults,
        ]);
    }

    /**
     * The features a std module exports: annotated (`"Feature Type Name"`) constants made by
     * `defineFeature` (their closure holds the feature function and defaults) and annotated
     * plain functions of `(context, id, definition)`. Std constants stay lazy, so the
     * interpreter's own feature list never sees them.
     */
    featuresOf(module: ModuleInstance): FeatureExport[] {
        return stdFeatures(this.interpreter, module).map(({ feature, wrapper }) => {
            this.featureValues.set(`${module.path}#${feature.name}`, wrapper);
            return feature;
        });
    }

    private probeFeature(module: string, feature: FeatureExport, instance: ModuleInstance): void {
        const layer = this.graph.layer[module];
        const name = feature.name;
        const wrapper = this.featureValues.get(`${instance.path}#${name}`);
        if (wrapper === undefined) return;
        let parameters: readonly FsParameterSpec[];
        try {
            parameters = analyzeFeature(this.interpreter, feature).parameters;
        } catch (error) {
            this.push(module, layer, "feature", name, "fault", `spec: ${message(error)}`, this.takeFaults());
            return;
        }
        let best: { outcome: Outcome; detail?: string } = { outcome: "fault", detail: "not run" };
        const faults = new Set<string>();
        for (const selections of ["empty", "everything"] as const) {
            const definition = new FsMap();
            for (const parameter of parameters) {
                const value = this.parameterValue(parameter, selections);
                if (value !== undefined) definition.set(parameter.key, value);
            }
            const context = this.freshContext();
            this.interpreter.resetBudget();
            let outcome: Outcome;
            let detail: string | undefined;
            try {
                this.interpreter.callFunction(wrapper, [
                    context,
                    this.evalProbe('makeId("probe")'),
                    definition,
                ]);
                const status = reportedStatus(FsContext.of(context), "probe");
                const described = status === undefined ? undefined : describeStatus(status);
                outcome = described?.kind === "ERROR" ? "domain" : "ok";
                detail = described === undefined || described.kind === "OK" ? undefined : described.message;
            } catch (error) {
                outcome = classify(error);
                detail = message(error);
            }
            for (const fault of this.takeFaults()) faults.add(fault);
            this.disposeContexts();
            if (rank(outcome) > rank(best.outcome) || best.detail === "not run") best = { outcome, detail };
            if (outcome === "ok") break;
        }
        this.push(module, layer, "feature", name, faults.size > 0 ? "fault" : best.outcome, best.detail, [
            ...faults,
        ]);
    }

    private parameterValue(parameter: FsParameterSpec, selections: "empty" | "everything"): FsValue {
        const value = parameter.defaultValue;
        switch (parameter.kind) {
            case "length":
                return this.evalProbe(`${Number(value)} * millimeter`);
            case "angle":
                return this.evalProbe(`${Number(value)} * degree`);
            case "integer":
            case "real":
                return Number(value);
            case "boolean":
                return value === true;
            case "string":
                return String(value);
            case "enum":
                return parameter.enumType?.values.get(String(value));
            case "query": {
                if (selections === "empty") return this.evalProbe("qNothing()");
                const kind = parameter.filter?.[0] ?? "BODY";
                return this.evalProbe(`qEverything(EntityType.${kind.toUpperCase()})`);
            }
            default:
                return undefined;
        }
    }

    // ------------------------------------------------------------------ Helpers

    private load(name: string): ModuleInstance {
        return this.interpreter.load({ path: `onshape/std/${name}`, source: STD_BUNDLE.files[name] });
    }

    moduleOf(name: string): ModuleInstance | undefined {
        try {
            return this.load(name);
        } catch {
            return undefined;
        }
    }

    private buildPool(): FsValue[] {
        const pool: FsValue[] = [];
        for (const source of POOL_SOURCES) {
            try {
                pool.push(this.evalProbe(source));
            } catch {
                // a constructor this std lacks: the pool just has one value fewer
            }
        }
        // The first member of every enum std declares.
        for (const name of this.graph.order) {
            const module = this.moduleOf(name);
            for (const value of module?.exports.values() ?? []) {
                if (value instanceof FsEnumType) {
                    const first = value.values.values().next().value;
                    if (first !== undefined) pool.push(first);
                }
            }
        }
        this.takeFaults();
        return pool;
    }

    private evalProbe(source: string): FsValue {
        return this.interpreter.evaluate(parseExpression(source), this.probe.env);
    }

    private freshContext(): FsValue {
        this.interpreter.resetBudget();
        const context = this.interpreter.callFunction(this.probe.env.lookup("freshContext")?.value, []);
        this.contexts.push(FsContext.of(context));
        return context;
    }

    private disposeContexts(): void {
        for (const context of this.contexts.splice(0)) context.dispose();
    }

    /** `value is type`, resolving the type where the function was declared. */
    private matches(value: FsValue, type: TypeReference, scope: unknown): boolean {
        const isType = (this.interpreter as unknown as InterpreterInternals).isType;
        this.muted++;
        try {
            return isType.call(this.interpreter, value, type, scope);
        } catch {
            return false;
        } finally {
            this.muted--;
        }
    }

    private push(
        module: string,
        layer: number,
        kind: ProbeResult["kind"],
        name: string,
        outcome: Outcome,
        detail?: string,
        faults: readonly string[] = [],
    ): void {
        this.results.push({ module, layer, kind, name, outcome, detail, faults });
    }
}

/**
 * The features a loaded std module exports, each with the value Part Studio code calls:
 * annotated (`"Feature Type Name"`) constants made by `defineFeature` (their closure holds
 * the feature function and defaults) and annotated plain functions of `(context, id,
 * definition)`.
 */
export function stdFeatures(
    interpreter: Interpreter,
    module: ModuleInstance,
): { feature: FeatureExport; wrapper: FsValue }[] {
    const features: { feature: FeatureExport; wrapper: FsValue }[] = [];
    for (const item of module.program.body) {
        if (!item.exported || (item.kind !== "Const" && item.kind !== "FunctionTop")) continue;
        const annotations = item.annotations ?? [];
        if (annotations.length === 0) continue;
        let annotation: FsMap;
        let value: FsValue;
        try {
            annotation = interpreter.evaluateAnnotations(annotations, module.env);
            value = interpreter.evaluate(parseExpression(item.name), module.env);
        } catch {
            continue;
        }
        const displayName = annotation.field("Feature Type Name");
        if (typeof displayName !== "string" || !isCallable(value) || value.kind !== "user") continue;
        let definition: FeatureDefinition | undefined;
        if (item.kind === "FunctionTop") {
            if (value.params.length === 3) definition = { fn: value };
        } else {
            const scope = value.closure as { vars: Map<string, { value: FsValue }> };
            const fn = scope.vars.get("feature")?.value;
            const defaults = scope.vars.get("defaults")?.value;
            if (isCallable(fn) && fn.kind === "user" && fn.params.length === 3)
                definition = defaults instanceof FsMap ? { fn, defaults } : { fn };
        }
        if (definition === undefined) continue;
        features.push({
            feature: { name: item.name, displayName, annotation, definition, module },
            wrapper: value,
        });
    }
    return features;
}

function message(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
}

function classify(error: unknown): Outcome {
    if (!(error instanceof FsError) || error instanceof FsAbort) return "fault";
    if (error instanceof FsThrow) return "domain";
    return FAULT_PATTERN.test(error.message) ? "fault" : "domain";
}

function rank(outcome: Outcome): number {
    return { fault: 0, untested: 1, domain: 2, ok: 3 }[outcome];
}
