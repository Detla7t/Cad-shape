// Part of the Chili3d Project, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

import type { IShape } from "@chili3d/core";
import { installEvaluation } from "./context/evaluation";
import { type FsBody, FsContext } from "./context/fsContext";
import { installOperations } from "./context/operations";
import { installQueries } from "./context/queries";
import { installSketch } from "./context/sketch";
import { FsError, FsRuntimeError } from "./lang/errors";
import {
    type FeatureExport,
    Interpreter,
    type ModuleInstance,
    type ModuleResolver,
    type ModuleSource,
} from "./lang/interpreter";
import type { FsMap, FsValue } from "./lang/values";
import { installCore } from "./std/core";
import { installEnums } from "./std/enums";
import { installFeatureSupport, makeId } from "./std/feature";
import { installGeometry } from "./std/geometry";
import { StdBuilder } from "./std/registry";

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

/** An interpreter with every std module installed. */
export function createInterpreter(setup: InterpreterSetup = {}): Interpreter {
    const interpreter = new Interpreter({
        print: setup.print,
        resolveModule: setup.resolveModule,
        maxSteps: setup.maxSteps,
    });
    const std = new StdBuilder(interpreter);
    installEnums(std);
    installCore(std);
    installGeometry(std);
    installFeatureSupport(std);
    installQueries(std);
    installSketch(std);
    installOperations(std);
    installEvaluation(std);
    return interpreter;
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

export function describeError(error: unknown): { error: string; line?: number; column?: number } {
    if (error instanceof FsRuntimeError)
        return { error: error.describe(), line: error.pos?.line, column: error.pos?.column };
    if (error instanceof FsError)
        return { error: error.message, line: error.pos?.line, column: error.pos?.column };
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
        const definition = run.definition(context);
        const callable =
            run.feature.module.exports.get(run.feature.name) ??
            run.feature.module.env.lookup(run.feature.name)?.value;
        run.interpreter.callFunction(callable, [context.value, makeId([run.instanceId]), definition]);
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
