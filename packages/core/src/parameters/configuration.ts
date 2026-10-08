// Part of the Chili3d Project, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

import { Logger } from "../foundation/logger";
import { Result } from "../foundation/result";
import { type EvaluatedValue, resolveUnitSpec, type Scope } from "./expression";
import { isVariableType, UNITLESS, unitSpecOfType, type VariableType } from "./unitSpec";

/**
 * CONFIGURATIONS — Onshape's way of making one Part Studio describe a family of parts.
 *
 * The document declares configuration INPUTS (`ConfigurationInputData`), and one choice per
 * input is ACTIVE at a time (`ActiveConfigurationData`):
 *
 * - a **list** input picks one of its named options (`Size`: S / M / L);
 * - a **checkbox** input is on or off (`Holes`);
 * - a **configuration variable** is a typed value (`Length`: 120 mm) set per configuration.
 *
 * The inputs are a layer of the document's variable scope, below the Variable Studios (see
 * `IVariableTable`): a list resolves to its option index and carries the option's name
 * (`EvaluatedValue.option`), a checkbox to 1 or 0 (`"true"`/`"false"`), a configuration
 * variable to its value. A parameter becomes configured by holding a `configure(…)` value
 * (`configuredValue.ts`) whose arm the active option selects.
 *
 * Editing the inputs is an edit of the document (recorded, undoable, versioned); switching
 * the active configuration is not — it is a view of the same document, like a camera move.
 */

/** One option of a list input. Its id is stable across renames; its name is what values select by. */
export interface ConfigurationOptionData {
    readonly id: string;
    readonly name: string;
    readonly visibility?: ConfigurationVisibility;
}

export interface ConfigurationVisibilityCondition {
    readonly inputId: string;
    readonly operator: "is" | "isNot" | "lt" | "lte" | "gt" | "gte";
    /** Stable option ids, checkbox states, or a numeric expression in the input's units. */
    readonly values: readonly (string | boolean)[];
}

export interface ConfigurationVisibility {
    readonly match: "all" | "any";
    readonly conditions: readonly ConfigurationVisibilityCondition[];
}

interface ConditionalInput {
    readonly visibility?: ConfigurationVisibility;
    /** Whether to show a numeric input's range hint. Does not change its allowed range. */
    readonly rangeVisibility?: ConfigurationVisibility;
}

export interface ConfigurationListInputData extends ConditionalInput {
    readonly kind: "list";
    readonly id: string;
    readonly name: string;
    readonly options: readonly ConfigurationOptionData[];
    /** The id of the option a document starts on (and falls back to); the first option when unset or stale. */
    readonly defaultOption?: string;
}

export interface ConfigurationCheckboxInputData extends ConditionalInput {
    readonly kind: "checkbox";
    readonly id: string;
    readonly name: string;
    readonly defaultValue: boolean;
}

export interface ConfigurationVariableInputData extends ConditionalInput {
    readonly kind: "variable";
    readonly id: string;
    readonly name: string;
    readonly type: VariableType;
    /** The value of a configuration that has not set one. */
    readonly defaultExpression: string;
    readonly min?: number;
    readonly max?: number;
}

export type ConfigurationInputData =
    | ConfigurationListInputData
    | ConfigurationCheckboxInputData
    | ConfigurationVariableInputData;

export type ConfigurationInputKind = ConfigurationInputData["kind"];

/**
 * The active configuration: input NAME → the chosen option's name (a list), the state (a
 * checkbox) or the expression (a configuration variable). An input left out — or holding a
 * value that no longer fits it (an option renamed away) — takes its default.
 */
export type ActiveConfigurationData = Readonly<Record<string, string | boolean>>;

/** The configuration as a document stores it (`Document.serialize`'s `configuration`). */
export interface ConfigurationData {
    readonly inputs: readonly ConfigurationInputData[];
    readonly active: ActiveConfigurationData;
}

function parseJson(json: string, owner: string): unknown {
    try {
        return JSON.parse(json);
    } catch (error) {
        Logger.error(`${owner}: the stored configuration is not readable`, error);
        return undefined;
    }
}

/** A stored input list as inputs; a corrupt one reads as empty rather than throwing out of every reader. */
export function parseConfigurationInputs(json: string): readonly ConfigurationInputData[] {
    const parsed = parseJson(json, "configuration inputs");
    return Array.isArray(parsed) ? (parsed as ConfigurationInputData[]) : [];
}

/** A stored active configuration; anything but an object reads as "every input at its default". */
export function parseActiveConfiguration(json: string): ActiveConfigurationData {
    const parsed = parseJson(json, "active configuration");
    return parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)
        ? (parsed as ActiveConfigurationData)
        : {};
}

/** The option a list falls back to: the default by id (or, leniently, by name), else the first. */
export function defaultListOption(input: ConfigurationListInputData): ConfigurationOptionData | undefined {
    const options = Array.isArray(input.options) ? input.options : [];
    return (
        options.find((x) => x.id === input.defaultOption) ??
        options.find((x) => x.name === input.defaultOption) ??
        options[0]
    );
}

/**
 * What `input` is set to in `active` — the option name (a list; undefined when it has no
 * options), the state (a checkbox) or the expression (a configuration variable) — the
 * input's default when `active` has nothing that fits.
 */
export function activeInputValue(
    input: ConfigurationInputData,
    active: ActiveConfigurationData,
): string | boolean | undefined {
    const chosen = Object.hasOwn(active, input.name) ? active[input.name] : undefined;
    switch (input.kind) {
        case "list": {
            const options = Array.isArray(input.options) ? input.options : [];
            if (typeof chosen === "string" && options.some((x) => x.name === chosen)) return chosen;
            return defaultListOption(input)?.name;
        }
        case "checkbox":
            if (typeof chosen === "boolean") return chosen;
            if (chosen === "true" || chosen === "false") return chosen === "true";
            return input.defaultValue === true;
        case "variable":
            return typeof chosen === "string" && chosen.trim() !== "" ? chosen : input.defaultExpression;
    }
}

/**
 * The scope entry of one input in the active configuration, resolved against `scope` (the
 * inputs above it — a configuration variable may use them). Pure: the configuration panel
 * previews a draft through it.
 */
export function configurationInputValue(
    input: ConfigurationInputData,
    active: ActiveConfigurationData,
    scope: Scope,
): Result<EvaluatedValue> {
    switch (input.kind) {
        case "list": {
            const options = Array.isArray(input.options) ? input.options : [];
            if (options.length === 0) return Result.err(`${input.name} has no options`);
            const option = activeInputValue(input, active) as string;
            const index = options.findIndex((x) => x.name === option);
            return Result.ok({ value: index, unit: UNITLESS, option, configuration: true });
        }
        case "checkbox": {
            const on = activeInputValue(input, active) === true;
            return Result.ok({
                value: on ? 1 : 0,
                unit: UNITLESS,
                option: on ? "true" : "false",
                configuration: true,
            });
        }
        case "variable": {
            if (!isVariableType(input.type))
                return Result.err(`Unknown variable type: ${String(input.type)}`);
            const expression = activeInputValue(input, active);
            if (typeof expression !== "string") return Result.err(`Missing expression: ${input.name}`);
            const unit = unitSpecOfType(input.type);
            const resolved = resolveUnitSpec(expression, scope, unit);
            if (!resolved.isOk) return Result.err(resolved.error);
            const value = resolved.value;
            const tolerance = 1e-9 * Math.max(1, Math.abs(value));
            if (typeof input.min === "number" && value < input.min - tolerance) {
                return Result.err(`${input.name} must be at least ${input.min}`);
            }
            if (typeof input.max === "number" && value > input.max + tolerance) {
                return Result.err(`${input.name} must be at most ${input.max}`);
            }
            return Result.ok({ value, unit, configuration: true });
        }
        default:
            return Result.err(
                `Unknown configuration input kind: ${String((input as { kind?: unknown }).kind)}`,
            );
    }
}

/** The names a configured value can switch on: the list and checkbox inputs. */
export function isSelectorInput(
    input: ConfigurationInputData,
): input is ConfigurationListInputData | ConfigurationCheckboxInputData {
    return input.kind === "list" || input.kind === "checkbox";
}

/** The option names of a selector input, in order: a list's options, or `true`/`false`. */
export function selectorOptions(
    input: ConfigurationListInputData | ConfigurationCheckboxInputData,
): string[] {
    if (input.kind === "checkbox") return ["true", "false"];
    return (Array.isArray(input.options) ? input.options : []).map((x) => x.name);
}
