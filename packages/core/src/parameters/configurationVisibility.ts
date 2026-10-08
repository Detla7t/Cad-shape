// Part of the Chili3d Project, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

import {
    type ActiveConfigurationData,
    activeInputValue,
    type ConfigurationInputData,
    type ConfigurationVisibility,
    configurationInputValue,
} from "./configuration";
import { type EvaluatedValue, resolveUnitSpec } from "./expression";
import { unitSpecOfType } from "./unitSpec";

/** Visibility only affects the controls; hidden inputs retain their values and model effects. */
export function configurationVisible(
    rule: ConfigurationVisibility | undefined,
    inputs: readonly ConfigurationInputData[],
    active: ActiveConfigurationData,
): boolean {
    if (!rule?.conditions.length) return true;
    const scope = new Map<string, EvaluatedValue>();
    for (const input of inputs) {
        const value = configurationInputValue(input, active, scope);
        if (value.isOk) scope.set(input.name, value.value);
    }
    const matches = rule.conditions.map((condition) => {
        const input = inputs.find((input) => input.id === condition.inputId);
        if (!input || !condition.values.length) return false;
        const value = activeInputValue(input, active);
        if (input.kind === "variable") {
            const actual = scope.get(input.name)?.value;
            const expected = resolveUnitSpec(String(condition.values[0]), scope, unitSpecOfType(input.type));
            if (actual === undefined || !expected.isOk) return false;
            const delta = actual - expected.value;
            const equal = Math.abs(delta) <= 1e-9 * Math.max(1, Math.abs(actual), Math.abs(expected.value));
            switch (condition.operator) {
                case "is":
                    return equal;
                case "isNot":
                    return !equal;
                case "lt":
                    return delta < 0 && !equal;
                case "lte":
                    return delta < 0 || equal;
                case "gt":
                    return delta > 0 && !equal;
                case "gte":
                    return delta > 0 || equal;
            }
        }
        if (
            input.kind === "list" &&
            condition.values.some((id) => !input.options.some((option) => option.id === id))
        )
            return false;
        const key = input.kind === "list" ? input.options.find((option) => option.name === value)?.id : value;
        const equal = condition.values.includes(key as string | boolean);
        return condition.operator === "is" ? equal : condition.operator === "isNot" && !equal;
    });
    return rule.match === "any" ? matches.some(Boolean) : matches.every(Boolean);
}
