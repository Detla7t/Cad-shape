// Part of the Chili3d Project, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

import type { Block, Expression, MapLiteral, Statement } from "./lang/ast";
import { Environment, type FeatureExport, type Interpreter, type TableExport } from "./lang/interpreter";
import {
    ANGLE,
    FsArray,
    FsEnumType,
    FsEnumValue,
    FsMap,
    FsQuantity,
    type FsValue,
    LENGTH,
    type Units,
    unitsEqual,
} from "./lang/values";

/**
 * Reads a custom feature's `precondition` the way Onshape's feature dialog does: every
 * annotated predicate on a `definition` field becomes one parameter.
 *
 * | Precondition statement                    | Parameter                         |
 * |-------------------------------------------|-----------------------------------|
 * | `isLength(definition.x, BOUNDS)`          | length (mm), default/min/max      |
 * | `isAngle(definition.x, BOUNDS)`           | angle (degrees)                   |
 * | `isInteger(definition.x, BOUNDS)`         | integer count                     |
 * | `isReal(definition.x, BOUNDS)`            | unitless real                     |
 * | `definition.x is boolean`                 | checkbox                          |
 * | `definition.x is string`                  | text                              |
 * | `definition.x is SomeEnum`                | dropdown of the enum members      |
 * | `definition.x is Query`                   | entity pick on the host body      |
 *
 * Statements nested in `if (cond)` (or its `else`) carry the condition, so the panel only
 * shows a parameter while the current values satisfy it — Onshape's conditional
 * visibility. Defaults come from the annotation's `"Default"`, then the `defineFeature`
 * defaults map, then the bound spec, then a per-kind fallback.
 *
 * Values are stored in app units (mm, degrees) as `ParameterValue`s, so they can be
 * expressions over the document's variables like every other feature parameter.
 */

export type FsParameterKind =
    | "length"
    | "angle"
    | "integer"
    | "real"
    | "boolean"
    | "string"
    | "enum"
    | "query";

export type QueryEntityKind = "FACE" | "EDGE" | "VERTEX" | "BODY";

export interface VisibilityCondition {
    readonly expression: Expression;
    readonly negate: boolean;
}

export interface FsParameterSpec {
    readonly key: string;
    readonly kind: FsParameterKind;
    readonly label: string;
    readonly description?: string;
    /** In app units: mm for lengths, degrees for angles. */
    readonly defaultValue: number | string | boolean;
    readonly min?: number;
    readonly max?: number;
    /** Enum members (value = member name). */
    readonly options?: readonly { value: string; label: string }[];
    readonly enumType?: FsEnumType;
    /** Entity kinds a query parameter accepts (from the annotation's `"Filter"`). */
    readonly filter?: readonly QueryEntityKind[];
    readonly maxPicks?: number;
    readonly conditions: readonly VisibilityCondition[];
}

export interface FeatureSpec {
    /** The interpreter and export the spec was read from — visibility conditions evaluate there. */
    readonly interpreter: Interpreter;
    /** The custom feature — or custom table, whose precondition declares parameters the same way. */
    readonly feature: FeatureExport | TableExport;
    readonly name: string;
    readonly displayName: string;
    readonly description?: string;
    readonly parameters: readonly FsParameterSpec[];
    /** The name the feature function gives its definition parameter (usually `definition`). */
    readonly definitionName: string;
}

const MM_PER_M = 1000;
const DEG_PER_RAD = 180 / Math.PI;

/**
 * The parameter spec of a custom feature's precondition. `definitionIndex` is where the
 * function takes its `definition`: 2 for a feature `(context, id, definition)`, 1 for a
 * table `(context, definition)` (see `analyzeTable`).
 */
export function analyzeFeature(
    interpreter: Interpreter,
    feature: FeatureExport | TableExport,
    definitionIndex = 2,
): FeatureSpec {
    const fn = feature.definition.fn;
    const definitionName = fn.params[definitionIndex]?.name ?? "definition";
    const env = feature.module.env;
    const parameters: FsParameterSpec[] = [];
    const seen = new Set<string>();
    const analyzer = new PreconditionAnalyzer(interpreter, env, definitionName, feature.definition.defaults);
    if (fn.precondition !== undefined) {
        for (const spec of analyzer.block(fn.precondition, [])) {
            if (seen.has(spec.key)) continue;
            seen.add(spec.key);
            parameters.push(spec);
        }
    }
    return {
        interpreter,
        feature,
        name: feature.name,
        displayName: feature.displayName,
        description: feature.description,
        parameters,
        definitionName,
    };
}

/** A custom table's parameters — read from its precondition exactly like a feature's. */
export function analyzeTable(interpreter: Interpreter, table: TableExport): FeatureSpec {
    return analyzeFeature(interpreter, table, 1);
}

class PreconditionAnalyzer {
    constructor(
        private readonly interpreter: Interpreter,
        private readonly env: Environment,
        private readonly definitionName: string,
        private readonly defaults: FsMap | undefined,
    ) {}

    block(block: Block, conditions: VisibilityCondition[]): FsParameterSpec[] {
        return block.body.flatMap((statement) => this.statement(statement, conditions));
    }

    private statement(statement: Statement, conditions: VisibilityCondition[]): FsParameterSpec[] {
        switch (statement.kind) {
            case "Block":
                return this.block(statement, conditions);
            case "If": {
                const whenTrue = [...conditions, { expression: statement.test, negate: false }];
                const whenFalse = [...conditions, { expression: statement.test, negate: true }];
                return [
                    ...this.statement(statement.consequent, whenTrue),
                    ...(statement.alternate === undefined
                        ? []
                        : this.statement(statement.alternate, whenFalse)),
                ];
            }
            case "ExpressionStatement": {
                const spec = this.parameter(statement.expression, statement.annotations ?? [], conditions);
                return spec === undefined ? [] : [spec];
            }
            default:
                return [];
        }
    }

    /** The definition field an expression reads (`definition.x` / `definition["x"]`), if any. */
    private field(expression: Expression | undefined): string | undefined {
        if (expression === undefined) return undefined;
        if (
            expression.kind === "Member" &&
            expression.object.kind === "Identifier" &&
            expression.object.name === this.definitionName
        ) {
            return expression.property;
        }
        if (
            expression.kind === "Index" &&
            expression.object.kind === "Identifier" &&
            expression.object.name === this.definitionName &&
            expression.index.kind === "String"
        ) {
            return expression.index.value;
        }
        return undefined;
    }

    private parameter(
        expression: Expression,
        annotations: readonly MapLiteral[],
        conditions: VisibilityCondition[],
    ): FsParameterSpec | undefined {
        const annotation = this.annotation(annotations);
        if (expression.kind === "Call" && expression.callee.kind === "Identifier") {
            const key = this.field(expression.args[0]);
            if (key === undefined) return undefined;
            const bounds =
                expression.args[1] === undefined ? undefined : this.tryEvaluate(expression.args[1]);
            switch (expression.callee.name) {
                case "isLength":
                    return this.numeric(key, "length", annotation, conditions, bounds, 25);
                case "isAngle":
                    return this.numeric(key, "angle", annotation, conditions, bounds, 30);
                case "isInteger":
                    return this.numeric(key, "integer", annotation, conditions, bounds, 1);
                case "isReal":
                    return this.numeric(key, "real", annotation, conditions, bounds, 1);
                default:
                    return undefined;
            }
        }
        if (expression.kind === "Is") {
            const key = this.field(expression.value);
            if (key === undefined) return undefined;
            return this.typed(key, expression.type.name, expression.type.namespace, annotation, conditions);
        }
        return undefined;
    }

    private typed(
        key: string,
        type: string,
        namespace: string | undefined,
        annotation: AnnotationInfo,
        conditions: VisibilityCondition[],
    ): FsParameterSpec | undefined {
        const base = { key, label: annotation.name ?? key, description: annotation.description, conditions };
        switch (type) {
            case "boolean":
                return {
                    ...base,
                    kind: "boolean",
                    defaultValue:
                        this.defaultOf(key, annotation, (v) => (typeof v === "boolean" ? v : undefined)) ??
                        false,
                };
            case "string":
                return {
                    ...base,
                    kind: "string",
                    defaultValue:
                        this.defaultOf(key, annotation, (v) => (typeof v === "string" ? v : undefined)) ?? "",
                };
            case "number":
                return {
                    ...base,
                    kind: "real",
                    defaultValue:
                        this.defaultOf(key, annotation, (v) => (typeof v === "number" ? v : undefined)) ?? 0,
                };
            case "Query":
                return {
                    ...base,
                    kind: "query",
                    defaultValue: "",
                    filter: annotation.filter,
                    maxPicks: annotation.maxPicks,
                };
            case "ValueWithUnits":
                return this.numeric(key, "length", annotation, conditions, undefined, 25);
            default:
                break;
        }
        const resolved = namespace === undefined ? this.env.lookup(type)?.value : undefined;
        if (!(resolved instanceof FsEnumType)) return undefined;
        const options = [...resolved.values.values()].map((member) => ({
            value: member.name,
            label: member.display ?? member.name,
        }));
        const first = options[0]?.value ?? "";
        const defaultValue =
            this.defaultOf(key, annotation, (v) =>
                v instanceof FsEnumValue && v.type === resolved ? v.name : undefined,
            ) ?? first;
        return { ...base, kind: "enum", defaultValue, options, enumType: resolved };
    }

    private numeric(
        key: string,
        kind: "length" | "angle" | "integer" | "real",
        annotation: AnnotationInfo,
        conditions: VisibilityCondition[],
        bounds: FsValue,
        fallback: number,
    ): FsParameterSpec {
        const range = bounds === undefined ? undefined : boundRange(bounds);
        const scale = kind === "length" ? MM_PER_M : kind === "angle" ? DEG_PER_RAD : 1;
        const fromBounds = boundDefault(bounds, kind);
        const defaultValue =
            this.defaultOf(key, annotation, (v) => appValue(v, kind)) ?? fromBounds ?? fallback;
        return {
            key,
            kind,
            label: annotation.name ?? key,
            description: annotation.description,
            defaultValue,
            min: range === undefined ? undefined : round(range.min * scale),
            max: range === undefined ? undefined : round(range.max * scale),
            conditions,
        };
    }

    /** Annotation `"Default"`, else the `defineFeature` defaults map, converted to app units. */
    private defaultOf<T>(
        key: string,
        annotation: AnnotationInfo,
        convert: (value: FsValue) => T | undefined,
    ): T | undefined {
        if (annotation.defaultValue !== undefined) {
            const converted = convert(annotation.defaultValue);
            if (converted !== undefined) return converted;
        }
        const fromMap = this.defaults?.field(key);
        return fromMap === undefined ? undefined : convert(fromMap);
    }

    private annotation(annotations: readonly MapLiteral[]): AnnotationInfo {
        const info: AnnotationInfo = {};
        for (const map of annotations) {
            for (const entry of map.entries) {
                if (entry.key.kind !== "String") continue;
                switch (entry.key.value) {
                    case "Name": {
                        const value = this.tryEvaluate(entry.value);
                        if (typeof value === "string") info.name = value;
                        break;
                    }
                    case "Description": {
                        const value = this.tryEvaluate(entry.value);
                        if (typeof value === "string") info.description = value;
                        break;
                    }
                    case "Default":
                        info.defaultValue = this.tryEvaluate(entry.value);
                        break;
                    case "MaxNumberOfPicks": {
                        const value = this.tryEvaluate(entry.value);
                        if (typeof value === "number") info.maxPicks = value;
                        break;
                    }
                    case "Filter":
                        info.filter = filterKinds(entry.value);
                        break;
                    default:
                        break;
                }
            }
        }
        return info;
    }

    private tryEvaluate(expression: Expression): FsValue {
        try {
            return this.interpreter.evaluate(expression, this.env);
        } catch {
            return undefined;
        }
    }
}

interface AnnotationInfo {
    name?: string;
    description?: string;
    defaultValue?: FsValue;
    maxPicks?: number;
    filter?: QueryEntityKind[];
}

/**
 * The entity kinds a `"Filter"` mentions. Filters are a small boolean language over enum
 * values (`EntityType.EDGE && GeometryType.LINE`); only the `EntityType` members matter
 * for picking, so they are collected syntactically.
 */
function filterKinds(expression: Expression): QueryEntityKind[] | undefined {
    const kinds = new Set<QueryEntityKind>();
    const walk = (node: Expression) => {
        switch (node.kind) {
            case "Member":
                if (node.object.kind === "Identifier" && node.object.name === "EntityType") {
                    const kind = node.property as QueryEntityKind;
                    if (kind === "FACE" || kind === "EDGE" || kind === "VERTEX" || kind === "BODY")
                        kinds.add(kind);
                }
                break;
            case "Logical":
            case "Binary":
                walk(node.left);
                walk(node.right);
                break;
            case "Unary":
                walk(node.operand);
                break;
            default:
                break;
        }
    };
    walk(expression);
    return kinds.size === 0 ? undefined : [...kinds];
}

/**
 * A quantity in either std: a native one, or Onshape's std `ValueWithUnits` map
 * (`{ "value" : 0.0254, "unit" : { "meter" : 1 } }`).
 */
function quantityOf(value: FsValue): { value: number; units: Units } | undefined {
    if (value instanceof FsQuantity) return value;
    if (!(value instanceof FsMap)) return undefined;
    const magnitude = value.field("value");
    const unit = value.field("unit");
    if (typeof magnitude !== "number" || !(unit instanceof FsMap)) return undefined;
    const exponent = (key: string) => {
        const e = unit.field(key);
        return typeof e === "number" ? e : 0;
    };
    return {
        value: magnitude,
        units: {
            meter: exponent("meter"),
            radian: exponent("radian"),
            kilogram: exponent("kilogram"),
            second: exponent("second"),
        },
    };
}

/** The SI factor a bound-spec key stands for: `(millimeter)` → 0.001; a bare number is itself. */
function unitFactor(key: FsValue): number | undefined {
    return typeof key === "number" ? key : quantityOf(key)?.value;
}

/** `[min, ..., max]` of a bound spec in SI units (map specs: the entry holding the range). */
function boundRange(spec: FsValue): { min: number; max: number } | undefined {
    const range = (values: FsArray, factor: number) => {
        const min = values.items[0];
        const max = values.items[values.items.length - 1];
        return typeof min === "number" && typeof max === "number"
            ? { min: min * factor, max: max * factor }
            : undefined;
    };
    if (spec instanceof FsArray) return range(spec, 1);
    if (!(spec instanceof FsMap)) return undefined;
    for (const [key, value] of spec.pairs()) {
        if (value instanceof FsArray) return range(value, unitFactor(key) ?? 1);
    }
    return undefined;
}

/** A FeatureScript default in app units for a numeric kind. */
function appValue(value: FsValue, kind: "length" | "angle" | "integer" | "real"): number | undefined {
    const q = quantityOf(value);
    if (kind === "length")
        return q !== undefined && unitsEqual(q.units, LENGTH) ? round(q.value * MM_PER_M) : undefined;
    if (kind === "angle")
        return q !== undefined && unitsEqual(q.units, ANGLE) ? round(q.value * DEG_PER_RAD) : undefined;
    return typeof value === "number" ? value : undefined;
}

/**
 * The default a bound spec suggests. Map specs are keyed by unit: the millimeter (length)
 * or degree (angle) entry wins, else the first `[min, default, max]` entry, converted.
 * Array specs (Integer/Real) are `[min, default, max]` directly.
 */
function boundDefault(spec: FsValue, kind: "length" | "angle" | "integer" | "real"): number | undefined {
    if (spec instanceof FsArray) {
        const value = spec.items[1];
        return typeof value === "number" ? value : undefined;
    }
    if (!(spec instanceof FsMap)) return undefined;
    const preferred = kind === "length" ? 0.001 : kind === "angle" ? Math.PI / 180 : 1;
    const scale = kind === "length" ? MM_PER_M : kind === "angle" ? DEG_PER_RAD : 1;
    let fallback: number | undefined;
    for (const [key, value] of spec.pairs()) {
        const unit = unitFactor(key);
        if (unit === undefined) continue;
        const local = value instanceof FsArray ? value.items[1] : value;
        if (typeof local !== "number") continue;
        if (Math.abs(unit - preferred) < 1e-12) return round(local);
        fallback ??= round(local * unit * scale);
    }
    return fallback;
}

function round(value: number): number {
    return Math.round(value * 1e9) / 1e9;
}

/**
 * True when every visibility condition holds for `definition`. A condition that cannot be
 * evaluated (it reads a field not set yet) counts as not holding — the parameter stays
 * hidden until its controlling value exists, as in Onshape's dialog.
 */
export function isParameterVisible(
    spec: FeatureSpec,
    parameter: FsParameterSpec,
    definition: FsMap,
): boolean {
    if (parameter.conditions.length === 0) return true;
    const env = new Environment(spec.feature.module.env);
    env.define(spec.definitionName, spec.interpreter.adaptHostValue(definition));
    return parameter.conditions.every((condition) => {
        try {
            const value = spec.interpreter.evaluate(condition.expression, env);
            return typeof value === "boolean" && value !== condition.negate;
        } catch {
            return false;
        }
    });
}
