// Part of the Chili3d Project, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

import type {
    AssignmentExpression,
    BinaryOperator,
    Block,
    ConstDeclaration,
    EnumDeclaration,
    Expression,
    FunctionExpression,
    MapLiteral,
    Program,
    Statement,
    TypeReference,
} from "./ast";
import { FsAbort, FsError, FsRuntimeError, FsThrow, formatPosition, type SourcePosition } from "./errors";
import { applyBinary, applyNegate } from "./operators";
import { parseProgram } from "./parser";
import {
    cloneContainer,
    describeValue,
    type FeatureDefinition,
    FsArray,
    FsBox,
    type FsCallable,
    FsEnumType,
    FsEnumValue,
    FsMap,
    FsOpaque,
    FsQuantity,
    type FsValue,
    fail,
    freeze,
    fsMap,
    isCallable,
    isContainer,
    type NativeCallContext,
    type NativeFunction,
    type OverloadSet,
    toDisplayString,
    typeName,
    type UserFunction,
} from "./values";

// ------------------------------------------------------------------ Environments

interface Binding {
    value: FsValue;
    readonly constant: boolean;
}

export class Environment {
    readonly vars = new Map<string, Binding>();

    constructor(readonly parent?: Environment) {}

    lookup(name: string): Binding | undefined {
        let env: Environment | undefined = this;
        while (env !== undefined) {
            const binding = env.vars.get(name);
            if (binding !== undefined) return binding;
            env = env.parent;
        }
        return undefined;
    }

    declare(name: string, value: FsValue, constant: boolean, pos?: SourcePosition): void {
        if (this.vars.has(name)) throw new FsRuntimeError(`"${name}" is already defined in this scope`, pos);
        this.vars.set(name, { value, constant });
    }

    /** Std-library registration: overwrites, never throws. */
    define(name: string, value: FsValue): void {
        this.vars.set(name, { value, constant: true });
    }
}

// ------------------------------------------------------------------ Types

/** A type `is`/`as` can name: built-in, std (Query, Vector, ...) or user-declared. */
export interface TypeDefinition {
    readonly name: string;
    /** The tag `as` stamps on a container; undefined for types that are not tags (map, number). */
    readonly tag?: string;
    check(value: FsValue): boolean;
    /** Extra validation `as` runs before tagging (a user type's typecheck predicate). */
    validate?(value: FsValue): boolean;
}

const BUILTIN_TYPES: Record<string, (value: FsValue) => boolean> = {
    number: (v) => typeof v === "number",
    string: (v) => typeof v === "string",
    boolean: (v) => typeof v === "boolean",
    undefined: (v) => v === undefined,
    map: (v) => v instanceof FsMap,
    array: (v) => v instanceof FsArray,
    box: (v) => v instanceof FsBox,
    function: (v) => isCallable(v),
    builtin: (v) => isCallable(v) && v.kind === "native",
    ValueWithUnits: (v) => v instanceof FsQuantity,
};

export function typeValue(definition: TypeDefinition): FsOpaque {
    return new FsOpaque("type", definition);
}

function asTypeDefinition(value: FsValue): TypeDefinition | undefined {
    return value instanceof FsOpaque && value.typeName === "type"
        ? (value.payload as TypeDefinition)
        : undefined;
}

// ------------------------------------------------------------------ Modules

export interface ModuleSource {
    /** What `import(path : ...)` names — a Feature Studio's name. */
    readonly path: string;
    readonly source: string;
}

export type ModuleResolver = (path: string) => ModuleSource | undefined;

/** One custom feature a module exports through `defineFeature`. */
export interface FeatureExport {
    /** The exported constant's name — the feature's stable key. */
    readonly name: string;
    /** "Feature Type Name" from the annotation, falling back to `name`. */
    readonly displayName: string;
    readonly description?: string;
    readonly annotation: FsMap;
    readonly definition: FeatureDefinition;
    readonly module: ModuleInstance;
}

export class ModuleInstance {
    readonly exports = new Map<string, FsValue>();
    /** Names an `export import` passes on; exported with their final (merged) value. */
    readonly reexported = new Set<string>();
    readonly namespaces = new Map<string, ModuleInstance>();
    readonly features: FeatureExport[] = [];

    constructor(
        readonly path: string,
        readonly program: Program,
        readonly env: Environment,
    ) {}

    feature(name: string): FeatureExport | undefined {
        return this.features.find((feature) => feature.name === name);
    }
}

/** Std module paths resolve to the ambient std library — importing them is a no-op. */
export function isStdPath(path: string): boolean {
    return path.startsWith("onshape/std/") || path.startsWith("chili3d/std/") || path === "std";
}

/** A top-level constant not evaluated yet (see `Interpreter.force`). */
class LazyConst {
    state: "pending" | "evaluating" | "done" = "pending";
    value: FsValue;

    constructor(
        readonly module: ModuleInstance,
        readonly item: ConstDeclaration,
    ) {}
}

// ------------------------------------------------------------------ Control-flow signals

class ReturnSignal {
    constructor(readonly value: FsValue) {}
}
class PredicateFailure {
    constructor(
        readonly pos: SourcePosition,
        readonly value: FsValue,
    ) {}
}
const BREAK = Symbol("break");
const CONTINUE = Symbol("continue");
type Signal = undefined | ReturnSignal | PredicateFailure | typeof BREAK | typeof CONTINUE;

type Mode = "normal" | "predicate";

// ------------------------------------------------------------------ Interpreter

export interface InterpreterOptions {
    print?: (text: string) => void;
    /** Statement + call budget for one interpreter; exceeding it aborts the run. */
    maxSteps?: number;
    maxDepth?: number;
    resolveModule?: ModuleResolver;
    /**
     * True (the default): `onshape/std/...` imports name the ambient native std and are
     * no-ops. False: they resolve through `resolveModule` like any other module — for
     * running Onshape's own std source on the `@` builtins.
     */
    ambientStd?: boolean;
}

/** A native operator implementation keyed by the operand tags (`Transform * Vector`, ...). */
export type NativeOperator = (left: FsValue, right: FsValue) => FsValue | typeof NOT_HANDLED;
export const NOT_HANDLED = Symbol("not handled");

/**
 * A tree-walking evaluator for FeatureScript. One instance owns the std environment, the
 * module cache, the operator overload table and the step budget; modules are instantiated
 * once per interpreter and shared by everything that imports them.
 */
export class Interpreter {
    readonly std = new Environment();
    /** `@name` built-ins — the native layer Onshape's std source calls into. */
    readonly builtins = new Map<string, FsValue>();
    private readonly ambientStd: boolean;
    private readonly modules = new Map<string, ModuleInstance>();
    private readonly loading = new Set<string>();
    private readonly moduleByEnv = new WeakMap<Environment, ModuleInstance>();
    private readonly userOperators = new Map<string, UserFunction[]>();
    private readonly nativeOperators = new Map<string, NativeOperator[]>();
    private steps = 0;
    private depth = 0;
    private readonly maxSteps: number;
    private readonly maxDepth: number;
    private readonly printer: (text: string) => void;
    private readonly resolveModule?: ModuleResolver;

    constructor(options: InterpreterOptions = {}) {
        this.maxSteps = options.maxSteps ?? 50_000_000;
        this.maxDepth = options.maxDepth ?? 400;
        this.printer = options.print ?? (() => {});
        this.resolveModule = options.resolveModule;
        this.ambientStd = options.ambientStd ?? true;
        // Language-level constants, below every std.
        this.std.define("inf", Number.POSITIVE_INFINITY);
    }

    print(text: string): void {
        this.printer(text);
    }

    /** Starts a fresh step and depth budget — called before each feature run of a reused interpreter. */
    resetBudget(): void {
        this.steps = 0;
        this.depth = 0;
    }

    /** Registers a std operator for `left op right`; the first implementation that handles a pair wins. */
    defineOperator(op: string, impl: NativeOperator): void {
        const list = this.nativeOperators.get(op) ?? [];
        list.push(impl);
        this.nativeOperators.set(op, list);
    }

    // ------------------------------------------------------------------ Modules

    /**
     * An export of any loaded module, by name (first loaded wins) — how the native layer
     * reaches std's own enums and constants (`QueryType`, `EntityType`) to build values.
     */
    findExport(name: string): FsValue | undefined {
        for (const module of this.modules.values()) {
            if (!module.exports.has(name)) continue;
            const value = module.exports.get(name);
            return value instanceof LazyConst ? this.force(value) : value;
        }
        return undefined;
    }

    /** Parses and instantiates a module (cached by path + source). Throws FsError. */
    load(source: ModuleSource): ModuleInstance {
        const key = `${source.path}\u0000${source.source}`;
        const cached = this.modules.get(key);
        if (cached !== undefined) return cached;
        if (this.loading.has(source.path)) {
            throw new FsRuntimeError(`Circular import of "${source.path}"`);
        }
        this.loading.add(source.path);
        try {
            const program = parseProgram(source.source, source.path);
            const module = this.instantiate(source.path, program);
            this.modules.set(key, module);
            return module;
        } finally {
            this.loading.delete(source.path);
        }
    }

    private instantiate(path: string, program: Program): ModuleInstance {
        const env = new Environment(this.std);
        const module = new ModuleInstance(path, program, env);
        this.moduleByEnv.set(env, module);
        for (const item of program.body) {
            if (item.kind === "Import")
                this.importModule(module, item.path, item.namespace, item.exported, item.pos);
        }
        // Declarations are hoisted: every function, predicate, type and enum is visible
        // to every constant initializer, whatever the source order.
        for (const item of program.body) {
            switch (item.kind) {
                case "FunctionTop":
                    this.bindFunction(env, item.name, this.makeFunction(item.fn, env, item.name));
                    break;
                case "Predicate":
                    this.bindFunction(env, item.name, {
                        kind: "user",
                        name: item.name,
                        params: item.params,
                        precondition: item.precondition,
                        body: item.body,
                        pos: item.pos,
                        closure: env,
                        predicate: true,
                    });
                    break;
                case "Type":
                    env.declare(
                        item.name,
                        typeValue(this.userType(item.name, item.typecheck, env)),
                        true,
                        item.pos,
                    );
                    break;
                case "Enum":
                    env.declare(item.name, this.makeEnum(path, item), true, item.pos);
                    break;
                case "Operator": {
                    const list = this.userOperators.get(item.operator) ?? [];
                    list.push(this.makeFunction(item.fn, env, `operator${item.operator}`));
                    this.userOperators.set(item.operator, list);
                    break;
                }
                default:
                    break;
            }
        }
        // Top-level constants are lazy: each evaluates on first reference, so one may name a
        // later one, and a std table nothing uses is never built. A Feature Studio forces
        // them all here, so its mistakes surface when it compiles.
        for (const item of program.body) {
            if (item.kind === "Const")
                env.declare(item.name, new LazyConst(module, item) as never, true, item.pos);
        }
        if (!this.lazyModule(path)) {
            for (const item of program.body)
                if (item.kind === "Const") this.resolveName(item.name, undefined, env, item.pos);
        }
        for (const name of module.reexported) {
            const binding = env.vars.get(name);
            if (binding !== undefined) module.exports.set(name, binding.value);
        }
        for (const item of program.body) {
            if (!item.exported) continue;
            if (item.kind === "Import") continue;
            const name = item.kind === "Operator" ? undefined : item.name;
            if (name === undefined) continue;
            const binding = env.vars.get(name);
            if (binding !== undefined) module.exports.set(name, binding.value);
            if (item.kind === "Const")
                this.collectFeature(module, item.name, binding?.value, item.annotations, env);
        }
        return module;
    }

    /** Modules whose constants stay lazy after loading: the std source. */
    private lazyModule(path: string): boolean {
        return !this.ambientStd && isStdPath(path);
    }

    /** Evaluates a lazy constant once; later references read the cached value. */
    private force(lazy: LazyConst, pos?: SourcePosition): FsValue {
        if (lazy.state === "done") return lazy.value;
        if (lazy.state === "evaluating") {
            throw new FsRuntimeError(`Constant "${lazy.item.name}" refers to itself`, pos ?? lazy.item.pos);
        }
        lazy.state = "evaluating";
        try {
            const { item } = lazy;
            const env = lazy.module.env;
            const value = this.evaluateValue(item.value, env);
            if (item.type !== undefined) this.checkType(value, item.type, env, `Constant "${item.name}"`);
            if (isCallable(value) && value.kind === "native" && value.feature !== undefined) {
                // Name the feature after its constant so stack traces read naturally.
                (value as { name: string }).name = item.name;
            }
            lazy.value = value;
            lazy.state = "done";
            return value;
        } catch (error) {
            lazy.state = "pending";
            throw error;
        }
    }

    private importModule(
        module: ModuleInstance,
        path: string,
        namespace: string | undefined,
        reexport: boolean,
        pos: SourcePosition,
    ): void {
        if (this.ambientStd && isStdPath(path)) return;
        const source = this.resolveModule?.(path);
        if (source === undefined) throw new FsRuntimeError(`Cannot find the module "${path}" to import`, pos);
        let imported: ModuleInstance;
        try {
            imported = this.load(source);
        } catch (error) {
            if (error instanceof FsError) {
                throw new FsRuntimeError(`Import of "${path}" failed: ${error.message}`, pos);
            }
            throw error;
        }
        if (namespace !== undefined) {
            module.namespaces.set(namespace, imported);
            return;
        }
        for (const [name, value] of imported.exports) {
            const own = module.env.vars.get(name);
            if (own === undefined) module.env.define(name, value);
            else if (own.value !== value) {
                // Overloads of one name spread over modules (`toString` for each type)
                // merge into one set; any other clash keeps the first import.
                const merged = mergeOverloads(own.value, value);
                if (merged !== undefined) own.value = merged;
            }
            if (reexport) module.reexported.add(name);
        }
        for (const [name, nested] of imported.namespaces) {
            if (!module.namespaces.has(name)) module.namespaces.set(name, nested);
        }
        if (reexport) module.features.push(...imported.features);
    }

    private collectFeature(
        module: ModuleInstance,
        name: string,
        value: FsValue,
        annotations: MapLiteral[],
        env: Environment,
    ): void {
        if (!isCallable(value) || value.kind !== "native" || value.feature === undefined) return;
        const annotation = this.evaluateAnnotations(annotations, env);
        const displayName = annotation.field("Feature Type Name");
        const description = annotation.field("Feature Type Description");
        module.features.push({
            name,
            displayName: typeof displayName === "string" ? displayName : name,
            description: typeof description === "string" ? description : undefined,
            annotation,
            definition: value.feature,
            module,
        });
    }

    /** Merges annotation maps (later keys win) into one evaluated map. */
    evaluateAnnotations(annotations: readonly MapLiteral[] | undefined, env: Environment): FsMap {
        const merged = new FsMap();
        for (const annotation of annotations ?? []) {
            const value = this.evaluateValue(annotation, env);
            if (value instanceof FsMap) for (const [key, item] of value.pairs()) merged.set(key, item);
        }
        return merged;
    }

    private makeEnum(path: string, item: EnumDeclaration): FsEnumType {
        return new FsEnumType(
            `${path}::${item.name}`,
            item.name,
            item.members.map((member) => {
                const display = member.annotations
                    .flatMap((map) => map.entries)
                    .find((entry) => entry.key.kind === "String" && entry.key.value === "Name");
                return {
                    name: member.name,
                    display: display?.value.kind === "String" ? display.value.value : undefined,
                };
            }),
        );
    }

    private userType(name: string, typecheck: TypeReference, env: Environment): TypeDefinition {
        const predicate = (value: FsValue): boolean => {
            const fn = this.resolveName(typecheck.name, typecheck.namespace, env, typecheck.pos);
            const result = this.callFunction(fn, [value], typecheck.pos);
            return result === true;
        };
        return {
            name,
            tag: name,
            check: (value) => (isContainer(value) ? value.tag === name : predicate(value)),
            validate: predicate,
        };
    }

    private makeFunction(node: FunctionExpression, env: Environment, name?: string): UserFunction {
        return {
            kind: "user",
            name: name ?? node.name ?? "<anonymous>",
            params: node.params,
            returns: node.returns,
            precondition: node.precondition,
            body: node.body,
            pos: node.pos,
            closure: env,
        };
    }

    /**
     * Declares a top-level function, merging same-named declarations into an overload set
     * dispatched on parameter types. A name the module shadows from std or an import is
     * kept as the set's fallback, so `toString(value is MyType)` extends std's `toString`.
     */
    private bindFunction(env: Environment, name: string, fn: UserFunction): void {
        const own = env.vars.get(name);
        if (own !== undefined) {
            const existing = own.value;
            if (isCallable(existing) && existing.kind === "overloads") {
                own.value = { ...existing, candidates: [...existing.candidates, fn] };
                return;
            }
            if (isCallable(existing) && existing.kind === "user") {
                own.value = { kind: "overloads", name, candidates: [existing, fn] };
                return;
            }
            throw new FsRuntimeError(`"${name}" is already defined`, fn.pos);
        }
        const outer = env.parent?.lookup(name)?.value;
        if (isCallable(outer)) {
            env.define(name, {
                kind: "overloads",
                name,
                candidates: [fn],
                fallback: outer,
            } satisfies OverloadSet);
            return;
        }
        env.declare(name, fn, true, fn.pos);
    }

    // ------------------------------------------------------------------ Calls

    callFunction(fn: FsValue, args: FsValue[], pos?: SourcePosition): FsValue {
        if (!isCallable(fn)) throw new FsRuntimeError(`Cannot call a ${describeValue(fn)}`, pos);
        this.tick(pos);
        switch (fn.kind) {
            case "native":
                return this.callNative(fn, args, pos);
            case "user":
                return this.callUser(fn, args, pos);
            case "overloads":
                return this.callOverloads(fn, args, pos);
        }
    }

    private callNative(fn: NativeFunction, args: FsValue[], pos?: SourcePosition): FsValue {
        const context: NativeCallContext = {
            pos,
            call: (callee, callArgs) => this.callFunction(callee, callArgs, pos),
            print: (text) => this.print(text),
            isType: (value, type) => this.isNamedType(value, type),
        };
        try {
            return fn.impl(args, context);
        } catch (error) {
            if (error instanceof FsError) throw error.locate(pos);
            const message = error instanceof Error ? error.message : String(error);
            throw new FsRuntimeError(`${fn.name}: ${message}`, pos);
        }
    }

    private callOverloads(fn: OverloadSet, args: FsValue[], pos?: SourcePosition): FsValue {
        const candidate = this.selectOverload(fn.candidates, args);
        if (candidate !== undefined) return this.callUser(candidate, args, pos);
        if (fn.fallback !== undefined) return this.callFunction(fn.fallback, args, pos);
        const types = args.map(describeValue).join(", ");
        throw new FsRuntimeError(`No overload of ${fn.name} accepts (${types})`, pos);
    }

    /**
     * The matching candidate with the most specific parameter types: a custom type or enum
     * beats a built-in type, which beats an untyped parameter (`toString(value is Vector)`
     * over `toString(value is array)` over `toString(value)`). Ties go to the first declared.
     */
    private selectOverload(candidates: readonly UserFunction[], args: FsValue[]): UserFunction | undefined {
        let best: UserFunction | undefined;
        let bestScore = -1;
        for (const candidate of candidates) {
            if (!this.matches(candidate, args)) continue;
            const score = this.specificity(candidate);
            if (score > bestScore) {
                best = candidate;
                bestScore = score;
            }
        }
        return best;
    }

    private specificity(fn: UserFunction): number {
        let score = 0;
        for (const param of fn.params) {
            if (param.type === undefined) continue;
            const builtin =
                BUILTIN_TYPES[param.type.name] !== undefined &&
                param.type.namespace === undefined &&
                !this.declaresType(param.type.name, fn.closure as Environment);
            score += builtin ? 1 : 2;
        }
        return score;
    }

    private matches(fn: UserFunction, args: FsValue[]): boolean {
        if (args.length !== fn.params.length) return false;
        const env = fn.closure as Environment;
        return fn.params.every(
            (param, i) => param.type === undefined || this.isType(args[i], param.type, env),
        );
    }

    private callUser(fn: UserFunction, args: FsValue[], pos?: SourcePosition): FsValue {
        if (++this.depth > this.maxDepth) {
            this.depth = 0;
            throw new FsAbort(`Call depth exceeded ${this.maxDepth} (infinite recursion?)`, pos);
        }
        try {
            if (args.length !== fn.params.length) {
                throw new FsRuntimeError(
                    `${fn.name} expects ${fn.params.length} argument${fn.params.length === 1 ? "" : "s"}, got ${args.length}`,
                    pos,
                );
            }
            const closure = fn.closure as Environment;
            const env = new Environment(closure);
            fn.params.forEach((param, i) => {
                if (param.type !== undefined && !this.isType(args[i], param.type, closure)) {
                    throw new FsRuntimeError(
                        `${fn.name}: argument "${param.name}" must be ${param.type.name}, got ${describeValue(args[i])}`,
                        pos,
                    );
                }
                env.declare(param.name, args[i], false, param.pos);
            });
            if (fn.precondition !== undefined) {
                const signal = this.execBlock(fn.precondition, env, "predicate");
                if (signal instanceof PredicateFailure) {
                    throw new FsRuntimeError(
                        `Precondition of ${fn.name} failed${signal.value === false ? "" : ` (got ${describeValue(signal.value)})`}`,
                        signal.pos,
                    );
                }
            }
            let result: FsValue;
            if (fn.predicate === true) {
                const signal = this.execStatements(fn.body.body, env, "predicate");
                result =
                    signal instanceof PredicateFailure
                        ? false
                        : signal instanceof ReturnSignal
                          ? signal.value
                          : true;
            } else {
                const signal = this.execStatements(fn.body.body, env, "normal");
                result = signal instanceof ReturnSignal ? signal.value : undefined;
            }
            if (fn.returns !== undefined && !this.isType(result, fn.returns, closure)) {
                throw new FsRuntimeError(
                    `${fn.name} must return ${fn.returns.name}, returned ${describeValue(result)}`,
                    fn.pos,
                );
            }
            return result;
        } catch (error) {
            if (error instanceof FsRuntimeError) {
                error.locate(pos);
                if (error.frames.length < 32) error.frames.push(`${fn.name} (${formatPosition(fn.pos)})`);
            }
            throw error;
        } finally {
            this.depth = Math.max(0, this.depth - 1);
        }
    }

    private tick(pos?: SourcePosition): void {
        if (++this.steps > this.maxSteps) {
            throw new FsAbort(`Execution limit of ${this.maxSteps} steps exceeded (infinite loop?)`, pos);
        }
    }

    // ------------------------------------------------------------------ Types

    private isType(value: FsValue, type: TypeReference, env: Environment): boolean {
        const builtin = BUILTIN_TYPES[type.name];
        if (builtin !== undefined && type.namespace === undefined && !this.declaresType(type.name, env)) {
            return builtin(value);
        }
        const resolved = this.resolveName(type.name, type.namespace, env, type.pos);
        if (resolved instanceof FsEnumType) return value instanceof FsEnumValue && value.type === resolved;
        const definition = asTypeDefinition(resolved);
        if (definition === undefined) throw new FsRuntimeError(`"${type.name}" is not a type`, type.pos);
        return definition.check(value);
    }

    /** True when `name` is declared as a type (or enum) in scope — it then shadows a built-in type name. */
    private declaresType(name: string, env: Environment): boolean {
        const declared = env.lookup(name)?.value;
        return declared instanceof FsEnumType || asTypeDefinition(declared) !== undefined;
    }

    /** `isType` by name against the std environment — for native code. */
    isNamedType(value: FsValue, name: string): boolean {
        return this.isType(value, { name, pos: { line: 0, column: 0, file: "<std>" } }, this.std);
    }

    private checkType(value: FsValue, type: TypeReference, env: Environment, what: string): void {
        if (!this.isType(value, type, env)) {
            throw new FsRuntimeError(`${what} must be ${type.name}, got ${describeValue(value)}`, type.pos);
        }
    }

    private castTo(value: FsValue, type: TypeReference, env: Environment, pos: SourcePosition): FsValue {
        const builtin = BUILTIN_TYPES[type.name];
        if (builtin !== undefined && type.namespace === undefined && !this.declaresType(type.name, env)) {
            if (!builtin(value))
                throw new FsRuntimeError(`Cannot convert ${describeValue(value)} to ${type.name}`, pos);
            // `as map` / `as array` drops a custom tag.
            if (isContainer(value) && value.tag !== undefined) {
                const copy = cloneContainer(value);
                copy.tag = undefined;
                return copy;
            }
            return value;
        }
        const resolved = this.resolveName(type.name, type.namespace, env, type.pos);
        if (resolved instanceof FsEnumType) {
            // Enum values are names tagged with their type: `"REGEN_ERROR" as ErrorStringEnum`.
            if (value instanceof FsEnumValue && value.type === resolved) return value;
            const name = value instanceof FsEnumValue ? value.name : value;
            const member = typeof name === "string" ? resolved.member(name) : undefined;
            if (member === undefined)
                throw new FsRuntimeError(`Cannot convert ${describeValue(value)} to ${type.name}`, pos);
            return member;
        }
        const definition = asTypeDefinition(resolved);
        if (definition === undefined) throw new FsRuntimeError(`"${type.name}" is not a type`, pos);
        const valid = definition.validate !== undefined ? definition.validate(value) : true;
        if (!valid) throw new FsRuntimeError(`Value does not satisfy the typecheck of ${type.name}`, pos);
        if (definition.tag === undefined || !isContainer(value)) return value;
        if (value.tag === definition.tag) return value;
        const copy = cloneContainer(value);
        copy.tag = definition.tag;
        return copy;
    }

    // ------------------------------------------------------------------ Names

    private resolveName(
        name: string,
        namespace: string | undefined,
        env: Environment,
        pos: SourcePosition,
    ): FsValue {
        if (namespace !== undefined) {
            const module = this.moduleOf(env)?.namespaces.get(namespace);
            if (module === undefined) throw new FsRuntimeError(`Unknown namespace "${namespace}"`, pos);
            if (!module.exports.has(name))
                throw new FsRuntimeError(`"${namespace}::${name}" is not exported`, pos);
            const exported = module.exports.get(name);
            return exported instanceof LazyConst ? this.force(exported, pos) : exported;
        }
        const binding = env.lookup(name);
        if (binding === undefined) throw new FsRuntimeError(`"${name}" is not defined`, pos);
        if (binding.value instanceof LazyConst) binding.value = this.force(binding.value, pos);
        return binding.value;
    }

    /** The module whose top-level environment `env` descends from. */
    private moduleOf(env: Environment): ModuleInstance | undefined {
        let current: Environment | undefined = env;
        while (current !== undefined) {
            const module = this.moduleByEnv.get(current);
            if (module !== undefined) return module;
            current = current.parent;
        }
        return undefined;
    }

    // ------------------------------------------------------------------ Statements

    private execBlock(block: Block, env: Environment, mode: Mode): Signal {
        return this.execStatements(block.body, new Environment(env), mode);
    }

    private execStatements(statements: readonly Statement[], env: Environment, mode: Mode): Signal {
        for (const statement of statements) {
            const signal = this.execStatement(statement, env, mode);
            if (signal !== undefined) return signal;
        }
        return undefined;
    }

    private execStatement(statement: Statement, env: Environment, mode: Mode): Signal {
        this.tick(statement.pos);
        switch (statement.kind) {
            case "Block":
                return this.execBlock(statement, env, mode);
            case "Empty":
                return undefined;
            case "ExpressionStatement": {
                const expression = statement.expression;
                if (expression.kind === "Assignment") {
                    this.assign(expression, env);
                    return undefined;
                }
                const value = this.evaluate(expression, env);
                if (mode === "predicate" && value !== true) return new PredicateFailure(statement.pos, value);
                return undefined;
            }
            case "VariableDeclaration":
                for (const declaration of statement.declarations) {
                    const value =
                        declaration.init === undefined
                            ? undefined
                            : this.evaluateValue(declaration.init, env);
                    if (
                        declaration.type !== undefined &&
                        (declaration.init !== undefined || statement.constant)
                    ) {
                        this.checkType(value, declaration.type, env, `"${declaration.name}"`);
                    }
                    env.declare(declaration.name, value, statement.constant, declaration.pos);
                }
                return undefined;
            case "If": {
                const test = this.condition(statement.test, env, "if");
                if (test) return this.execStatement(statement.consequent, new Environment(env), mode);
                if (statement.alternate !== undefined) {
                    return this.execStatement(statement.alternate, new Environment(env), mode);
                }
                return undefined;
            }
            case "For":
                return this.execFor(statement, env, mode);
            case "ForIn":
                return this.execForIn(statement, env, mode);
            case "While":
                while (this.condition(statement.test, env, "while")) {
                    const signal = this.execStatement(statement.body, new Environment(env), mode);
                    if (signal === BREAK) break;
                    if (signal === CONTINUE) continue;
                    if (signal !== undefined) return signal;
                }
                return undefined;
            case "DoWhile":
                do {
                    const signal = this.execStatement(statement.body, new Environment(env), mode);
                    if (signal === BREAK) break;
                    if (signal === CONTINUE) continue;
                    if (signal !== undefined) return signal;
                } while (this.condition(statement.test, env, "while"));
                return undefined;
            case "Return":
                return new ReturnSignal(
                    statement.value === undefined ? undefined : this.evaluateValue(statement.value, env),
                );
            case "Break":
                return BREAK;
            case "Continue":
                return CONTINUE;
            case "Throw": {
                const value = this.evaluateValue(statement.value, env);
                throw new FsThrow(value, thrownMessage(value), statement.pos);
            }
            case "Try":
                return this.execTry(statement, env, mode);
            case "FunctionDeclaration":
                env.declare(
                    statement.name,
                    this.makeFunction(statement.fn, env, statement.name),
                    true,
                    statement.pos,
                );
                return undefined;
        }
    }

    private execFor(statement: Extract<Statement, { kind: "For" }>, env: Environment, mode: Mode): Signal {
        const loopEnv = new Environment(env);
        if (statement.init !== undefined) this.execStatement(statement.init, loopEnv, "normal");
        for (;;) {
            if (statement.test !== undefined && !this.condition(statement.test, loopEnv, "for")) break;
            const signal = this.execStatement(statement.body, new Environment(loopEnv), mode);
            if (signal === BREAK) break;
            if (signal !== undefined && signal !== CONTINUE) return signal;
            if (statement.update !== undefined) {
                if (statement.update.kind === "Assignment") this.assign(statement.update, loopEnv);
                else this.evaluate(statement.update, loopEnv);
            }
        }
        return undefined;
    }

    private execForIn(
        statement: Extract<Statement, { kind: "ForIn" }>,
        env: Environment,
        mode: Mode,
    ): Signal {
        // The loop walks a snapshot: writes to the iterated variable inside the body
        // clone it (it is frozen here) instead of disturbing the iteration.
        const iterable = freeze(this.evaluate(statement.iterable, env));
        const pairs: [FsValue, FsValue][] = [];
        if (iterable instanceof FsArray) {
            iterable.items.forEach((item, i) => {
                pairs.push(statement.second === undefined ? [item, undefined] : [i, item]);
            });
        } else if (iterable instanceof FsMap) {
            for (const [key, value] of iterable.pairs()) {
                // One loop variable walks `{ "key" : k, "value" : v }` entries.
                pairs.push(
                    statement.second === undefined ? [fsMap({ key, value }), undefined] : [key, value],
                );
            }
        } else {
            throw new FsRuntimeError(
                `Cannot iterate over a ${describeValue(iterable)}`,
                statement.iterable.pos,
            );
        }
        for (const [first, second] of pairs) {
            const loopEnv = new Environment(env);
            if (statement.declares) {
                loopEnv.declare(statement.first, freeze(first), statement.constant, statement.pos);
                if (statement.second !== undefined) {
                    loopEnv.declare(statement.second, freeze(second), statement.constant, statement.pos);
                }
            } else {
                this.assignName(statement.first, freeze(first), env, statement.pos);
                if (statement.second !== undefined)
                    this.assignName(statement.second, freeze(second), env, statement.pos);
            }
            const signal = this.execStatement(statement.body, loopEnv, mode);
            if (signal === BREAK) break;
            if (signal !== undefined && signal !== CONTINUE) return signal;
        }
        return undefined;
    }

    private execTry(statement: Extract<Statement, { kind: "Try" }>, env: Environment, mode: Mode): Signal {
        try {
            return this.execBlock(statement.block, env, mode);
        } catch (error) {
            if (!(error instanceof FsRuntimeError) || error instanceof FsAbort) throw error;
            if (!statement.silent && statement.handler === undefined) this.print(`Caught: ${error.message}`);
            if (statement.handler === undefined) return undefined;
            const handlerEnv = new Environment(env);
            if (statement.param !== undefined) {
                handlerEnv.declare(statement.param, caughtValue(error), false, statement.pos);
            }
            return this.execStatements(statement.handler.body, handlerEnv, mode);
        }
    }

    private condition(expression: Expression, env: Environment, what: string): boolean {
        const value = this.evaluate(expression, env);
        if (typeof value !== "boolean") {
            throw new FsRuntimeError(
                `The ${what} condition must be a boolean, got ${describeValue(value)}`,
                expression.pos,
            );
        }
        return value;
    }

    // ------------------------------------------------------------------ Expressions

    /**
     * Evaluates an expression whose result will be held somewhere else — a variable, an
     * argument, an element. The container is frozen: from now on two owners exist.
     */
    evaluateValue(expression: Expression, env: Environment): FsValue {
        return freeze(this.evaluate(expression, env));
    }

    evaluate(expression: Expression, env: Environment): FsValue {
        switch (expression.kind) {
            case "Number":
            case "String":
            case "Boolean":
                return expression.value;
            case "Undefined":
                return undefined;
            case "Identifier":
                return freeze(this.resolveName(expression.name, expression.namespace, env, expression.pos));
            case "Builtin": {
                const builtin =
                    this.builtins.get(expression.name) ?? this.std.vars.get(expression.name)?.value;
                if (builtin === undefined)
                    throw new FsRuntimeError(`Unknown built-in @${expression.name}`, expression.pos);
                return builtin;
            }
            case "Array":
                return new FsArray(expression.elements.map((element) => this.evaluateValue(element, env)));
            case "Map": {
                const map = new FsMap();
                for (const entry of expression.entries) {
                    // A map never holds undefined: `{ "a" : undefined }` is empty.
                    const value = this.evaluateValue(entry.value, env);
                    if (value !== undefined) map.set(this.evaluateValue(entry.key, env), value);
                }
                return map;
            }
            case "Function":
                return this.makeFunction(expression, env);
            case "Unary":
                return this.unary(
                    expression.operator,
                    this.evaluate(expression.operand, env),
                    expression.pos,
                );
            case "Binary":
                return this.binary(
                    expression.operator,
                    this.evaluate(expression.left, env),
                    this.evaluate(expression.right, env),
                    expression.pos,
                );
            case "Logical": {
                const left = this.evaluate(expression.left, env);
                if (expression.operator === "??") {
                    return left !== undefined ? left : this.evaluate(expression.right, env);
                }
                if (typeof left !== "boolean") {
                    throw new FsRuntimeError(
                        `${expression.operator} needs booleans, got ${describeValue(left)}`,
                        expression.pos,
                    );
                }
                if (expression.operator === "&&" ? !left : left) return left;
                const right = this.evaluate(expression.right, env);
                if (typeof right !== "boolean") {
                    throw new FsRuntimeError(
                        `${expression.operator} needs booleans, got ${describeValue(right)}`,
                        expression.pos,
                    );
                }
                return right;
            }
            case "Switch": {
                const subject = this.evaluate(expression.subject, env);
                for (const entry of expression.cases) {
                    const key = this.evaluate(entry.key, env);
                    if (this.binary("==", subject, key, expression.pos) === true) {
                        return this.evaluate(entry.value, env);
                    }
                }
                return undefined;
            }
            case "Conditional":
                return this.condition(expression.test, env, "?:")
                    ? this.evaluate(expression.consequent, env)
                    : this.evaluate(expression.alternate, env);
            case "Is":
                return this.isType(this.evaluate(expression.value, env), expression.type, env);
            case "As":
                return this.castTo(
                    this.evaluate(expression.value, env),
                    expression.type,
                    env,
                    expression.pos,
                );
            case "Call": {
                const callee = this.evaluate(expression.callee, env);
                const args = expression.args.map((arg) => this.evaluateValue(arg, env));
                return this.callFunction(callee, args, expression.pos);
            }
            case "Member":
            case "Index":
            case "BoxDeref":
                return freeze(this.access(expression, env));
            case "NewBox":
                return new FsBox(this.evaluateValue(expression.value, env));
            case "Assignment":
                return freeze(this.assign(expression, env));
            case "TryExpression":
                try {
                    return this.evaluate(expression.value, env);
                } catch (error) {
                    if (!(error instanceof FsRuntimeError) || error instanceof FsAbort) throw error;
                    if (!expression.silent) this.print(`Caught: ${error.message}`);
                    return undefined;
                }
        }
    }

    /**
     * Reads a member/index/box path WITHOUT freezing the containers along the way —
     * `arr[i]` must not mark `arr` shared, or every later `arr[j] = x` would copy it.
     */
    private peek(expression: Expression, env: Environment): FsValue {
        if (expression.kind === "Identifier")
            return this.resolveName(expression.name, expression.namespace, env, expression.pos);
        if (expression.kind === "Member" || expression.kind === "Index" || expression.kind === "BoxDeref") {
            return this.access(expression, env);
        }
        return this.evaluate(expression, env);
    }

    private access(
        expression: Extract<Expression, { kind: "Member" | "Index" | "BoxDeref" }>,
        env: Environment,
    ): FsValue {
        const object = this.peek(expression.object, env);
        if (object === undefined && expression.kind !== "BoxDeref" && inOptionalChain(expression))
            return undefined;
        if (expression.kind === "BoxDeref") {
            if (!(object instanceof FsBox))
                throw new FsRuntimeError(`Cannot dereference a ${describeValue(object)}`, expression.pos);
            return object.value;
        }
        if (expression.kind === "Member") return this.member(object, expression.property, expression.pos);
        const index = this.evaluate(expression.index, env);
        return this.index(object, index, expression.pos);
    }

    private member(object: FsValue, property: string, pos: SourcePosition): FsValue {
        if (object instanceof FsMap) return object.field(property);
        if (object instanceof FsEnumType) {
            const value = object.member(property);
            if (value === undefined) throw new FsRuntimeError(`${object.name} has no value ${property}`, pos);
            return value;
        }
        if (object instanceof FsQuantity) {
            if (property === "value") return object.value;
            if (property === "unit") {
                return fsMap({
                    meter: object.units.meter || undefined,
                    radian: object.units.radian || undefined,
                    kilogram: object.units.kilogram || undefined,
                    second: object.units.second || undefined,
                });
            }
        }
        throw new FsRuntimeError(`Cannot read member "${property}" of ${describeValue(object)}`, pos);
    }

    private index(object: FsValue, index: FsValue, pos: SourcePosition): FsValue {
        if (object instanceof FsArray) {
            if (typeof index !== "number" || !Number.isInteger(index)) {
                throw new FsRuntimeError(`Array index must be an integer, got ${describeValue(index)}`, pos);
            }
            if (index < 0 || index >= object.items.length) {
                throw new FsRuntimeError(
                    `Array index ${index} is out of bounds (size ${object.items.length})`,
                    pos,
                );
            }
            return object.items[index];
        }
        if (object instanceof FsMap) return object.get(index);
        // `ErrorStringEnum[name]`: the member of that name, or undefined.
        if (object instanceof FsEnumType) return typeof index === "string" ? object.member(index) : undefined;
        throw new FsRuntimeError(`Cannot index a ${describeValue(object)}`, pos);
    }

    private unary(operator: "-" | "+" | "!", value: FsValue, pos: SourcePosition): FsValue {
        if (operator === "!") {
            const overloaded = this.tryUserOperator("!", [value], pos);
            if (overloaded !== NOT_HANDLED) return overloaded;
            if (typeof value !== "boolean")
                throw new FsRuntimeError(`! needs a boolean, got ${describeValue(value)}`, pos);
            return !value;
        }
        if (operator === "+") return value;
        const overloaded = this.tryUserOperator("-", [value], pos);
        if (overloaded !== NOT_HANDLED) return overloaded;
        try {
            return applyNegate(value);
        } catch (error) {
            if (error instanceof FsError) throw error.locate(pos);
            throw error;
        }
    }

    binary(operator: BinaryOperator, left: FsValue, right: FsValue, pos?: SourcePosition): FsValue {
        // Overloads are keyed on the language's overloadable set; derived comparisons
        // (`>`, `<=`, `>=`, `!=`) follow from `<` and `==` when a type defines those.
        const user = this.userBinary(operator, left, right, pos);
        if (user !== NOT_HANDLED) return user;
        for (const impl of this.nativeOperators.get(operator) ?? []) {
            const result = impl(left, right);
            if (result !== NOT_HANDLED) return result;
        }
        try {
            return applyBinary(operator, left, right);
        } catch (error) {
            if (error instanceof FsError) throw error.locate(pos);
            throw error;
        }
    }

    private userBinary(
        operator: BinaryOperator,
        left: FsValue,
        right: FsValue,
        pos?: SourcePosition,
    ): FsValue | typeof NOT_HANDLED {
        if (this.userOperators.size === 0) return NOT_HANDLED;
        switch (operator) {
            case ">":
                return this.tryUserOperator("<", [right, left], pos);
            case "<=": {
                const greater = this.tryUserOperator("<", [right, left], pos);
                return greater === NOT_HANDLED ? NOT_HANDLED : greater !== true;
            }
            case ">=": {
                const less = this.tryUserOperator("<", [left, right], pos);
                return less === NOT_HANDLED ? NOT_HANDLED : less !== true;
            }
            case "!=": {
                const equal = this.tryUserOperator("==", [left, right], pos);
                return equal === NOT_HANDLED ? NOT_HANDLED : equal !== true;
            }
            default:
                return this.tryUserOperator(operator, [left, right], pos);
        }
    }

    private tryUserOperator(
        operator: string,
        args: FsValue[],
        pos?: SourcePosition,
    ): FsValue | typeof NOT_HANDLED {
        const candidates = this.userOperators.get(operator);
        if (candidates === undefined) return NOT_HANDLED;
        // Only values carrying a custom tag can reach a user overload — plain numbers and
        // strings never pay for the dispatch.
        if (!args.some((arg) => isContainer(arg) && arg.tag !== undefined)) return NOT_HANDLED;
        const candidate = this.selectOverload(candidates, args);
        return candidate === undefined ? NOT_HANDLED : this.callUser(candidate, args, pos);
    }

    // ------------------------------------------------------------------ Assignment

    /** Executes an assignment; returns the stored value (frozen by the caller when it escapes). */
    private assign(expression: AssignmentExpression, env: Environment): FsValue {
        let value = this.evaluateValue(expression.value, env);
        if (expression.operator !== "=") {
            const current = this.peek(expression.target, env);
            value = this.compound(expression.operator, current, value, expression.pos);
        }
        this.store(expression.target, value, env, expression.pos);
        return value;
    }

    private compound(
        operator: AssignmentExpression["operator"],
        current: FsValue,
        value: FsValue,
        pos: SourcePosition,
    ): FsValue {
        if (operator === "||=" || operator === "&&=") {
            if (typeof current !== "boolean" || typeof value !== "boolean") {
                throw new FsRuntimeError(`${operator} needs booleans`, pos);
            }
            return operator === "||=" ? current || value : current && value;
        }
        return this.binary(operator.slice(0, -1) as BinaryOperator, freeze(current), value, pos);
    }

    private assignName(name: string, value: FsValue, env: Environment, pos: SourcePosition): void {
        const binding = env.lookup(name);
        if (binding === undefined) throw new FsRuntimeError(`"${name}" is not defined`, pos);
        if (binding.constant) throw new FsRuntimeError(`Cannot assign to constant "${name}"`, pos);
        binding.value = value;
    }

    private store(target: Expression, value: FsValue, env: Environment, pos: SourcePosition): void {
        switch (target.kind) {
            case "Identifier":
                this.assignName(target.name, value, env, pos);
                return;
            case "BoxDeref": {
                const box = this.peek(target.object, env);
                if (!(box instanceof FsBox))
                    throw new FsRuntimeError(`Cannot assign through a ${describeValue(box)}`, pos);
                box.value = value;
                return;
            }
            case "Member": {
                const container = this.writable(target.object, env, pos);
                if (!(container instanceof FsMap)) {
                    throw new FsRuntimeError(
                        `Cannot set member "${target.property}" of ${describeValue(container)}`,
                        pos,
                    );
                }
                // Storing undefined removes the key: `unit[key] = undefined` cancels a unit.
                if (value === undefined) container.delete(target.property);
                else container.set(target.property, value);
                return;
            }
            case "Index": {
                const container = this.writable(target.object, env, pos);
                const index = this.evaluateValue(target.index, env);
                if (container instanceof FsMap) {
                    if (value === undefined) container.delete(index);
                    else container.set(index, value);
                    return;
                }
                if (container instanceof FsArray) {
                    if (
                        typeof index !== "number" ||
                        !Number.isInteger(index) ||
                        index < 0 ||
                        index >= container.items.length
                    ) {
                        throw new FsRuntimeError(
                            `Array index ${toDisplayString(index)} is out of bounds (size ${container.items.length})`,
                            pos,
                        );
                    }
                    container.items[index] = value;
                    return;
                }
                throw new FsRuntimeError(`Cannot index a ${describeValue(container)}`, pos);
            }
            default:
                throw new FsRuntimeError("Invalid assignment target", pos);
        }
    }

    /**
     * The container at `expression`, made exclusively owned by its location (cloned and
     * written back when it was shared) so it can be mutated in place.
     */
    private writable(expression: Expression, env: Environment, pos: SourcePosition): FsValue {
        switch (expression.kind) {
            case "Identifier": {
                const binding = env.lookup(expression.name);
                if (binding === undefined)
                    throw new FsRuntimeError(`"${expression.name}" is not defined`, pos);
                if (binding.constant)
                    throw new FsRuntimeError(`Cannot modify constant "${expression.name}"`, pos);
                if (isContainer(binding.value) && binding.value.frozen)
                    binding.value = cloneContainer(binding.value);
                return binding.value;
            }
            case "BoxDeref": {
                const box = this.peek(expression.object, env);
                if (!(box instanceof FsBox))
                    throw new FsRuntimeError(`Cannot dereference a ${describeValue(box)}`, pos);
                if (isContainer(box.value) && box.value.frozen) box.value = cloneContainer(box.value);
                return box.value;
            }
            case "Member":
            case "Index": {
                const parent = this.writable(expression.object, env, pos);
                const key: FsValue =
                    expression.kind === "Member"
                        ? expression.property
                        : this.evaluateValue(expression.index, env);
                let child: FsValue;
                if (parent instanceof FsMap) child = parent.get(key);
                else if (parent instanceof FsArray) child = this.index(parent, key, expression.pos);
                else throw new FsRuntimeError(`Cannot modify a member of ${describeValue(parent)}`, pos);
                if (isContainer(child) && child.frozen) {
                    child = cloneContainer(child);
                    if (parent instanceof FsMap) parent.set(key, child);
                    else (parent as FsArray).items[key as number] = child;
                }
                return child;
            }
            default:
                throw new FsRuntimeError("Invalid assignment target", pos);
        }
    }
}

// ------------------------------------------------------------------ Thrown values

/** The message a thrown value reads as: a regenError's `message`, a string, or its rendering. */
export function thrownMessage(value: FsValue): string {
    if (typeof value === "string") return value;
    if (value instanceof FsMap) {
        const message = value.field("message");
        if (typeof message === "string") return message;
    }
    return toDisplayString(value);
}

/** What `catch (e)` binds: the thrown value itself, or a regenError-shaped map for internal errors. */
function caughtValue(error: FsRuntimeError): FsValue {
    if (error instanceof FsThrow) return error.value as FsValue;
    // `customMessage` is what std's `processError` reports as the feature's status text.
    return fsMap({ message: error.detail, customMessage: error.detail }, "RegenError");
}

export type { FsCallable };
export { fail, typeName };

/** True when `expression` follows a `?.` in its member/index chain (`a?.b.c`, `a?.b[0]`). */
function inOptionalChain(expression: Expression): boolean {
    for (let node: Expression = expression; ; ) {
        if (node.kind === "Member") {
            if (node.optional) return true;
            node = node.object;
        } else if (node.kind === "Index") {
            node = node.object;
        } else {
            return false;
        }
    }
}

/** Merges two callables of one name into an overload set; undefined when either is not a user function or set. */
function mergeOverloads(a: FsValue, b: FsValue): OverloadSet | undefined {
    const candidatesOf = (value: FsValue): readonly UserFunction[] | undefined => {
        if (!isCallable(value)) return undefined;
        if (value.kind === "user") return [value];
        if (value.kind === "overloads") return value.candidates;
        return undefined;
    };
    const first = candidatesOf(a);
    const second = candidatesOf(b);
    if (first === undefined || second === undefined) return undefined;
    const candidates = [...first];
    for (const candidate of second) if (!candidates.includes(candidate)) candidates.push(candidate);
    const fallback =
        (isCallable(a) && a.kind === "overloads" ? a.fallback : undefined) ??
        (isCallable(b) && b.kind === "overloads" ? b.fallback : undefined);
    const name = (a as UserFunction | OverloadSet).name;
    return fallback === undefined
        ? { kind: "overloads", name, candidates }
        : { kind: "overloads", name, candidates, fallback };
}
