// Part of the Chili3d Project, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

import type { ConfigurationInputData } from "./configuration";
import { isConfiguredValue } from "./configuredValue";
import { isConstantName, registeredExpressionFunctions } from "./expression";
import type { VariableLayer } from "./variableTable";

/**
 * Which values follow the configuration — Onshape marks them with a dotted outline in the
 * variable table and on sketch dimensions: a `configure(...)` value, a reference to a
 * configuration input, or a variable that (through any number of other variables) comes to
 * one of those.
 */

const IDENTIFIER = /[A-Za-z_]\w*/g;
const STRING_LITERAL = /"(?:[^"\\]|\\.)*"/g;

/**
 * The names an expression reads: identifiers outside string literals that are not followed
 * by `(` (function calls) and are not the built-in constants.
 */
export function expressionIdentifiers(expression: string): Set<string> {
    const names = new Set<string>();
    const text = expression.replace(STRING_LITERAL, (literal) => " ".repeat(literal.length));
    const functions = new Set(registeredExpressionFunctions());
    for (const match of text.matchAll(IDENTIFIER)) {
        const name = match[0];
        const after = text.slice(match.index + name.length).match(/^\s*\(/);
        if (after !== null || functions.has(name) || isConstantName(name)) continue;
        names.add(name);
    }
    return names;
}

/** Whether `expression` reads the configuration directly: `configure(...)` or an input's name. */
export function readsConfiguration(expression: string, inputNames: ReadonlySet<string>): boolean {
    if (isConfiguredValue(expression)) return true;
    for (const name of expressionIdentifiers(expression)) if (inputNames.has(name)) return true;
    return false;
}

/**
 * The variable names whose values depend on the configuration, directly or through other
 * variables. Layers are read in their scope order; a name defined twice counts once it
 * depends anywhere (the higher layer shadows, and its own expression is the one that holds).
 */
export function configurationDependentNames(
    inputs: readonly ConfigurationInputData[],
    layers: readonly VariableLayer[],
): Set<string> {
    const inputNames = new Set(inputs.map((input) => input.name));
    const dependent = new Set<string>(inputNames);
    const expressions = new Map<string, string>();
    for (const layer of layers) for (const item of layer.items) expressions.set(item.name, item.expression);
    // A fixed point over the variables: each pass adds the ones reading a dependent name.
    let grew = true;
    while (grew) {
        grew = false;
        for (const [name, expression] of expressions) {
            if (dependent.has(name)) continue;
            if (isConfiguredValue(expression)) {
                dependent.add(name);
                grew = true;
                continue;
            }
            for (const read of expressionIdentifiers(expression)) {
                if (dependent.has(read)) {
                    dependent.add(name);
                    grew = true;
                    break;
                }
            }
        }
    }
    return dependent;
}

/** Whether a value (a dimension's datum, a feature parameter) follows the configuration. */
export function dependsOnConfiguration(value: unknown, dependentNames: ReadonlySet<string>): boolean {
    if (typeof value !== "string") return false;
    if (isConfiguredValue(value)) return true;
    for (const name of expressionIdentifiers(value)) if (dependentNames.has(name)) return true;
    return false;
}
