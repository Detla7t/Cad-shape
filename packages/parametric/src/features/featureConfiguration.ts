// Part of the Chili3d Project, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

import {
    type FeatureParameter,
    type IDocument,
    isConfiguredValue,
    type ParameterValue,
    Result,
    selectConfiguredArm,
    selectConfiguredBoolean,
} from "@chili3d/core";
import type { FeatureData, FeatureHandler } from "./feature";

/** Configuration bindings use each handler's ordinary typed setter before geometry is evaluated. */
export function resolveFeatureConfiguration(
    feature: FeatureData,
    handler: FeatureHandler,
    document: IDocument,
): Result<FeatureData> {
    if (!feature.configuredParameters) return Result.ok(feature);
    let resolved = feature;
    const scope = document.variables.evaluate().scope;
    for (const [key, source] of Object.entries(feature.configuredParameters ?? {})) {
        const parameter = handler.parameters(feature, document).find((p) => p.key === key);
        if (!parameter || parameter.pick || parameter.configurable === false)
            return Result.err(`Configured parameter is unavailable: ${key}`);
        const selected = selectConfiguredArm(source, scope);
        if (!selected.isOk) return Result.err(`${parameter.label ?? key}: ${selected.error}`);
        let value: ParameterValue | boolean = selected.value;
        if (typeof parameter.value === "boolean") {
            const boolean = selectConfiguredBoolean(value, scope);
            if (!boolean.isOk) return Result.err(`${parameter.label ?? key}: ${boolean.error}`);
            value = boolean.value;
        } else if (parameter.options && !parameter.options.some((p) => p.value === String(value))) {
            return Result.err(`${parameter.label ?? key}: unknown option ${String(value)}`);
        }
        resolved = handler.setParameter(resolved, key, value, document);
    }
    return Result.ok(resolved);
}

export function configuredFeatureParameters(
    feature: FeatureData,
    handler: FeatureHandler,
    document: IDocument,
): FeatureParameter[] {
    const resolved = resolveFeatureConfiguration(feature, handler, document);
    return handler.parameters(resolved.isOk ? resolved.value : feature, document).map((parameter) => ({
        ...parameter,
        configurable: parameter.pick ? false : (parameter.configurable ?? true),
        ...(feature.configuredParameters?.[parameter.key] === undefined
            ? {}
            : { configured: feature.configuredParameters[parameter.key] }),
    }));
}

export function setConfiguredFeatureParameter(
    feature: FeatureData,
    handler: FeatureHandler,
    key: string,
    value: ParameterValue | boolean,
    document: IDocument,
): FeatureData {
    const parameter = handler.parameters(feature, document).find((p) => p.key === key);
    const native =
        parameter?.configurable === true || (parameter?.unit && !parameter.options && !parameter.text);
    if (
        isConfiguredValue(value) &&
        parameter &&
        !native &&
        !parameter.pick &&
        parameter.configurable !== false
    ) {
        return { ...feature, configuredParameters: { ...feature.configuredParameters, [key]: value } };
    }
    const { [key]: _removed, ...bindings } = feature.configuredParameters ?? {};
    const next = handler.setParameter(feature, key, value, document);
    return Object.keys(bindings).length ? { ...next, configuredParameters: bindings } : withoutBindings(next);
}

function withoutBindings(feature: FeatureData): FeatureData {
    const { configuredParameters: _removed, ...rest } = feature;
    return rest;
}
