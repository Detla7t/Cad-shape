// Part of the Chili3d Project, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

import type { IDocument } from "../document";
import type { ExportNameResolver } from "../userPreferences";
import { activeInputValue } from "./configuration";
import { formatDocumentValue } from "./documentUnits";
import { UNITLESS, unitSpecEquals } from "./unitSpec";

/**
 * The placeholders a document fills into an export name: `{document}` (its name),
 * `{#OD}` (a variable, in the document's units, spaces dropped: `9.625in`),
 * `{config:OD}` (the active option of a configuration input) and `{config}` (every input's
 * active value, `Endcap=false OD=9 5_8"`).
 */
export function documentExportNameResolver(document: IDocument): ExportNameResolver {
    return (placeholder) => {
        if (placeholder === "document") return document.name;
        if (placeholder.startsWith("#")) {
            const entry = document.variables.evaluate().scope.get(placeholder.slice(1));
            if (entry === undefined || !Number.isFinite(entry.value)) return undefined;
            if (entry.option !== undefined) return entry.option;
            const text = unitSpecEquals(entry.unit, UNITLESS)
                ? String(Math.round(entry.value * 1e6) / 1e6)
                : formatDocumentValue(entry.value, document, entry.unit);
            return text.replace(/\s+/g, "");
        }
        if (placeholder === "config") {
            const inputs = document.variables.configurationInputs;
            if (inputs.length === 0) return "";
            return inputs
                .map(
                    (input) =>
                        `${input.name}=${String(activeInputValue(input, document.variables.activeConfiguration))}`,
                )
                .join(" ");
        }
        if (placeholder.startsWith("config:")) {
            const name = placeholder.slice("config:".length);
            const input = document.variables.configurationInputs.find((input) => input.name === name);
            return input === undefined
                ? undefined
                : String(activeInputValue(input, document.variables.activeConfiguration));
        }
        return undefined;
    };
}
