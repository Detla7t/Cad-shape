// Part of the Chili3d Project, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

import {
    type IDocument,
    type INode,
    InternalClassName,
    isDataTableNode,
    resolveDataTableReference,
    Serializer,
} from "@chili3d/core";
import { type DataReference, extractDataReferences, extractFeatureScriptReferences } from "./resolver";

/** One place in the document that reads a data table. */
export interface DataDependency {
    readonly reference: DataReference;
    /** The node holding the expression; undefined for the document's parameter table. */
    readonly nodeId?: string;
    readonly nodeName: string;
    /** Where in the node: `Extrude 1 › depth`, a variable's name, a sketch dimension. */
    readonly location: string;
    /** The expression (or FeatureScript call) as written. */
    readonly expression: string;
}

const SKIPPED_KEYS = new Set([InternalClassName, "id", "parentId", "visible", "name"]);
const TRANSPARENT_KEYS = new Set(["expression", "definition"]);

function labelOf(value: unknown, index: number): string {
    if (value !== null && typeof value === "object" && !Array.isArray(value)) {
        const record = value as Record<string, unknown>;
        if (typeof record["name"] === "string" && record["name"] !== "") return record["name"];
        if (typeof record["type"] === "string") {
            const type = record["type"];
            return type.charAt(0).toUpperCase() + type.slice(1);
        }
    }
    return String(index + 1);
}

/** The JSON a string property holds (feature lists, sketch data, variable rows), if it is JSON. */
function embeddedJson(text: string): unknown {
    const first = text.trimStart()[0];
    if (first !== "[" && first !== "{") return undefined;
    try {
        return JSON.parse(text);
    } catch {
        return undefined;
    }
}

/**
 * Walks a serialized node for strings that read data — expressions with `data(…)`, `lookup(…)`,
 * `count(…)`, `sum(…)`, FeatureScript with `getDataTable(…)` — descending into JSON-valued
 * properties, and labels each by the path to it.
 */
function scan(
    value: unknown,
    path: readonly string[],
    found: (expression: string, path: readonly string[], refs: DataReference[]) => void,
): void {
    if (typeof value === "string") {
        const json = embeddedJson(value);
        if (json !== undefined) {
            scan(json, path, found);
            return;
        }
        const refs = [...extractDataReferences(value), ...extractFeatureScriptReferences(value)];
        if (refs.length > 0) found(value, path, refs);
        return;
    }
    if (Array.isArray(value)) {
        for (const [index, item] of value.entries()) scan(item, [...path, labelOf(item, index)], found);
        return;
    }
    if (value !== null && typeof value === "object") {
        for (const [key, item] of Object.entries(value)) {
            if (SKIPPED_KEYS.has(key)) continue;
            // `featuresJson`, `variablesJson`, `dataJson`, a row's `expression`, a custom feature's
            // `definition` are containers, not places a user names.
            scan(item, TRANSPARENT_KEYS.has(key) || key.endsWith("Json") ? path : [...path, key], found);
        }
    }
}

/** Every reference to a data table in the document: its parameters, studios, features, sketches. */
export function collectDataDependencies(document: IDocument): DataDependency[] {
    const dependencies: DataDependency[] = [];
    for (const item of document.variables.items) {
        if (item === null || typeof item !== "object" || typeof item.expression !== "string") continue;
        for (const reference of extractDataReferences(item.expression)) {
            dependencies.push({
                reference,
                nodeName: "Parameters",
                location: String(item.name),
                expression: item.expression,
            });
        }
    }
    for (const node of document.modelManager.findNodes()) {
        // A data source's cached rows are data, not expressions.
        if (isDataTableNode(node)) continue;
        let serialized: unknown;
        try {
            serialized = Serializer.serializeObject(node);
        } catch {
            continue;
        }
        scan(serialized, [], (expression, path, refs) => {
            for (const reference of refs) {
                dependencies.push({
                    reference,
                    nodeId: node.id,
                    nodeName: node.name,
                    location: path.join(" › "),
                    expression,
                });
            }
        });
    }
    return dependencies;
}

/** The dependencies whose table reference resolves to `source`. */
export function dependenciesOn(document: IDocument, source: INode): DataDependency[] {
    return collectDataDependencies(document).filter((dependency) => {
        const target = resolveDataTableReference(document, dependency.reference.table);
        return target.isOk && target.value.source.node === source;
    });
}
