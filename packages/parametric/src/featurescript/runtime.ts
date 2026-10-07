// Part of the Chili3d Project, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

import type { IShape } from "@chili3d/core";
import { type FsBody, FsContext } from "./context/fsContext";
import { FsError, FsRuntimeError } from "./lang/errors";
import type {
    FeatureExport,
    Interpreter,
    ModuleInstance,
    ModuleResolver,
    ModuleSource,
} from "./lang/interpreter";
import type { FsMap, FsValue } from "./lang/values";
import { createNativeInterpreter } from "./nativeStd";
import { describeStatus, reportedStatus } from "./onshape/featureBuiltins";
import { createOnshapeInterpreter, type OnshapeStdSource } from "./onshape/onshapeStd";
import { makeId } from "./std/feature";

/**
 * The FeatureScript runtime surface the rest of the app uses: build an interpreter with
 * the full std library, compile a studio, and run one of its features against a body's
 * input shape.
 */

export interface InterpreterSetup {
    readonly print?: (text: string) => void;
    readonly resolveModule?: ModuleResolver;
    readonly maxSteps?: number;
}

// ------------------------------------------------------------------ The std library

let onshapeStd: OnshapeStdSource | undefined;
let onshapeBase: Interpreter | undefined;

/**
 * Makes Onshape's own std library (`@chili3d/onshape-std`) the FeatureScript std: from now
 * on every interpreter is a fork of one interpreter that loads the std modules once. Until
 * it is provided (and in tests that never provide it) studios run on the native std.
 */
export function provideOnshapeStd(source: OnshapeStdSource | undefined): void {
    onshapeStd = source;
    onshapeBase = undefined;
}

export function onshapeStdVersion(): number | undefined {
    return onshapeStd?.version;
}

/** The std source provided by `provideOnshapeStd` — what the editor indexes for completion and docs. */
export function providedOnshapeStd(): OnshapeStdSource | undefined {
    return onshapeStd;
}

function onshapeInterpreter(source: OnshapeStdSource): Interpreter {
    onshapeBase ??= createOnshapeInterpreter({ std: source });
    return onshapeBase;
}

/**
 * Loads (parses and instantiates) the std modules behind `geometry.fs` now, so the first
 * studio compile does not pay for it. A no-op on the native std.
 */
export function warmUpStd(): void {
    if (onshapeStd === undefined) return;
    onshapeInterpreter(onshapeStd).load({
        path: "std-warm-up",
        source: `FeatureScript ${onshapeStd.version};\nimport(path : "onshape/std/geometry.fs", version : "");\n`,
    });
}

/** An interpreter on the current std: a fork over Onshape's std once provided, else the native std. */
export function createInterpreter(setup: InterpreterSetup = {}): Interpreter {
    if (onshapeStd === undefined) return createNativeInterpreter(setup);
    return onshapeInterpreter(onshapeStd).fork({
        print: setup.print,
        resolveModule: setup.resolveModule,
        maxSteps: setup.maxSteps,
    });
}

export interface CompileResult {
    readonly module?: ModuleInstance;
    readonly features: readonly FeatureExport[];
    readonly error?: string;
    /** 1-based line of the error, when known — for editor gutters. */
    readonly line?: number;
    readonly column?: number;
}

/** Parses and instantiates a studio; failures come back as data, never thrown. */
export function compileStudio(source: ModuleSource, setup: InterpreterSetup = {}): CompileResult {
    const interpreter = createInterpreter(setup);
    try {
        const module = interpreter.load(source);
        return { module, features: module.features };
    } catch (error) {
        return { features: [], ...describeError(error) };
    }
}

/** An error as data: the message, and where it happened (`file` is the module the position is in). */
export function describeError(error: unknown): {
    error: string;
    line?: number;
    column?: number;
    file?: string;
} {
    if (error instanceof FsRuntimeError)
        return {
            error: error.describe(),
            line: error.pos?.line,
            column: error.pos?.column,
            file: error.pos?.file,
        };
    if (error instanceof FsError)
        return {
            error: error.message,
            line: error.pos?.line,
            column: error.pos?.column,
            file: error.pos?.file,
        };
    return { error: error instanceof Error ? error.message : String(error) };
}

export interface FeatureRun {
    readonly interpreter: Interpreter;
    readonly feature: FeatureExport;
    /** Builds the `definition` map (needs the run's context to resolve picked entities). */
    definition(context: FsContext): FsMap;
    /** The body's chain input; undefined for a first feature. */
    readonly input?: IShape;
    /** The root Id of this feature instance (the feature's id in the body). */
    readonly instanceId: string;
    readonly variables?: ReadonlyMap<string, FsValue>;
}

export interface FeatureRunResult {
    readonly context: FsContext;
    /** The model bodies the run left, in creation order. */
    readonly bodies: readonly FsBody[];
    readonly warnings: readonly string[];
    readonly infos: readonly string[];
}

/**
 * Executes a custom feature. The caller owns the returned context and must `dispose` it
 * (keeping whatever shapes it hands on). Throws FsError on failure — after disposing
 * everything the run created.
 */
export function runFeature(run: FeatureRun): FeatureRunResult {
    const context = new FsContext();
    try {
        if (run.input !== undefined) context.addHostBody(run.input);
        for (const [name, value] of run.variables ?? []) context.variables.set(name, value);
        const definition = run.interpreter.adaptHostValue(run.definition(context));
        const callable =
            run.feature.module.exports.get(run.feature.name) ??
            run.feature.module.env.lookup(run.feature.name)?.value;
        run.interpreter.callFunction(callable, [context.value, makeId([run.instanceId]), definition]);
        // Onshape's std reports a top-level feature's failure as its status instead of throwing.
        const status = reportedStatus(context, run.instanceId);
        if (status !== undefined) {
            const { kind, message } = describeStatus(status);
            if (kind === "ERROR") throw new FsRuntimeError(message);
            if (kind === "WARNING") context.notes.warnings.push(message);
            if (kind === "INFO") context.notes.infos.push(message);
        }
        return {
            context,
            bodies: context.bodies.filter((body) => body.isModelGeometry),
            warnings: context.notes.warnings,
            infos: context.notes.infos,
        };
    } catch (error) {
        context.dispose();
        throw error;
    }
}
