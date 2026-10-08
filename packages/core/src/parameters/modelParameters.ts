// Part of the Chili3d Project, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

import type { IDocument } from "../document";
import { Result, Transaction } from "../foundation";
import { I18n } from "../i18n";
import { type INode, isFeatureListNode } from "../model";
import type { ParameterValue } from "./expression";
import type { UnitSpec } from "./unitSpec";
import { UNITLESS } from "./unitSpec";

/** Numeric model slots shared by configuration grids and inspection tables. Values use display units. */
export interface ModelParameter {
    id: string;
    node: INode;
    label: string;
    value: ParameterValue;
    unit: UnitSpec;
    /** Checkbox cells, optionally displayed as the inverse (Unsuppressed). */
    boolean?: boolean;
    inverted?: boolean;
    apply(value: ParameterValue): Result<void>;
}
const providers = new Set<(document: IDocument) => ModelParameter[]>();
export function registerModelParameters(provider: (document: IDocument) => ModelParameter[]): void {
    providers.add(provider);
}
export function modelParameters(document: IDocument): ModelParameter[] {
    const result: ModelParameter[] = [];
    for (const node of document.modelManager.findNodes()) {
        if (!isFeatureListNode(node)) continue;
        for (const feature of node.featureItems()) {
            result.push({
                id: `${node.id}:${feature.id}:suppressed`,
                node,
                label: `${feature.name ?? I18n.translate(feature.display)} / Unsuppressed`,
                value: feature.suppressionConfigured ?? String(feature.suppressed ?? false),
                unit: UNITLESS,
                boolean: true,
                inverted: true,
                apply(value) {
                    Transaction.execute(document, "Configure feature suppression", () =>
                        node.setFeatureSuppressed(
                            feature.id,
                            value === "true" ? true : value === "false" ? false : String(value),
                        ),
                    );
                    return Result.ok(undefined);
                },
            });
            for (const parameter of feature.parameters) {
                const boolean = typeof parameter.value === "boolean";
                if (
                    (!parameter.unit && !boolean) ||
                    parameter.options ||
                    parameter.text ||
                    parameter.pick ||
                    parameter.configurable === false
                )
                    continue;
                result.push({
                    id: `${node.id}:${feature.id}:${parameter.key}`,
                    node,
                    label: `${feature.name ?? I18n.translate(feature.display)} / ${parameter.label ?? I18n.translate(parameter.display)}`,
                    value:
                        parameter.configured ??
                        (boolean ? String(parameter.value) : (parameter.value as ParameterValue)),
                    unit: parameter.unit ?? UNITLESS,
                    boolean,
                    apply(value) {
                        Transaction.execute(document, "Edit configured parameter", () =>
                            node.setFeatureParameter(
                                feature.id,
                                parameter.key,
                                boolean && value === "true"
                                    ? true
                                    : boolean && value === "false"
                                      ? false
                                      : value,
                            ),
                        );
                        return Result.ok(undefined);
                    },
                });
            }
        }
    }
    for (const provider of providers) result.push(...provider(document));
    return result;
}
