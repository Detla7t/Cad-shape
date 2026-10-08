// Part of the Chili3d Project, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

import type { IDocument } from "../document";
import { Result, Transaction } from "../foundation";
import { I18n } from "../i18n";
import { type INode, isFeatureListNode } from "../model";
import type { ParameterValue } from "./expression";
import type { UnitSpec } from "./unitSpec";

/** Numeric model slots shared by configuration grids and inspection tables. Values use display units. */
export interface ModelParameter {
    id: string;
    node: INode;
    label: string;
    value: ParameterValue;
    unit: UnitSpec;
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
        for (const feature of node.featureItems())
            for (const parameter of feature.parameters) {
                if (
                    !parameter.unit ||
                    parameter.options ||
                    parameter.text ||
                    parameter.pick ||
                    typeof parameter.value === "boolean" ||
                    parameter.configurable === false
                )
                    continue;
                result.push({
                    id: `${node.id}:${feature.id}:${parameter.key}`,
                    node,
                    label: `${feature.name ?? I18n.translate(feature.display)} / ${parameter.label ?? I18n.translate(parameter.display)}`,
                    value: parameter.configured ?? parameter.value,
                    unit: parameter.unit,
                    apply(value) {
                        Transaction.execute(document, "Edit configured parameter", () =>
                            node.setFeatureParameter(feature.id, parameter.key, value),
                        );
                        return Result.ok(undefined);
                    },
                });
            }
    }
    for (const provider of providers) result.push(...provider(document));
    return result;
}
