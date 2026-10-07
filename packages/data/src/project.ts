// Part of the Chili3d Project, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

import {
    isJsonObject,
    type JsonValue,
    registerProjectSourceElement,
    registerPropertySplitter,
    VersioningRoles,
} from "@chili3d/core";
import { fileExtension, parseDefinition } from "./model/definition";

/**
 * How Data Sources persist beyond `document.json`:
 *
 * - in a `.chili3d` project, the cached tables and the attached file are files of their own
 *   under `data/` — `data/Prices.snapshot.json` (one table row per line) and `data/Prices.xlsx`
 *   (the attachment's real bytes, extension from its file name) — so the document stays small
 *   and both open in other tools; secrets are never written (the node serializes them only when
 *   the source opted in);
 * - in the version history, the definition merges field by field, and the snapshot and a text
 *   attachment diff and merge line by line, i.e. row by row.
 */

export const DATA_SOURCE_CLASS = "DataSourceNode";
export const DATA_SOURCE_KIND = "dataSource";
export const DATA_PROJECT_FOLDER = "data/";

const attachmentExtension = (node: Readonly<Record<string, unknown>>) => {
    const json = node["definitionJson"];
    const definition = typeof json === "string" ? parseDefinition(json) : undefined;
    const fileName = definition !== undefined && "fileName" in definition ? definition.fileName : undefined;
    const extension = fileExtension(fileName);
    return extension === "" ? undefined : `.${extension}`;
};

registerProjectSourceElement({
    className: DATA_SOURCE_CLASS,
    kind: DATA_SOURCE_KIND,
    field: "snapshotJson",
    folder: DATA_PROJECT_FOLDER,
    extension: ".snapshot.json",
});
registerProjectSourceElement({
    className: DATA_SOURCE_CLASS,
    kind: DATA_SOURCE_KIND,
    field: "fileText",
    folder: DATA_PROJECT_FOLDER,
    extension: ".txt",
    extensionOf: attachmentExtension,
    skipEmpty: true,
});
registerProjectSourceElement({
    className: DATA_SOURCE_CLASS,
    kind: DATA_SOURCE_KIND,
    field: "fileBase64",
    folder: DATA_PROJECT_FOLDER,
    extension: ".bin",
    extensionOf: attachmentExtension,
    encoding: "base64",
    skipEmpty: true,
});

registerPropertySplitter({
    className: DATA_SOURCE_CLASS,
    property: "definitionJson",
    split(value) {
        if (typeof value !== "string") return undefined;
        const parsed = JSON.parse(value) as JsonValue;
        return isJsonObject(parsed)
            ? { kind: "json", role: "dataSourceDefinition", value: parsed }
            : undefined;
    },
    join: (part) => JSON.stringify(part.kind === "json" ? part.value : {}),
});

for (const property of ["snapshotJson", "fileText"]) {
    registerPropertySplitter({
        className: DATA_SOURCE_CLASS,
        property,
        split: (value) => (typeof value === "string" ? { kind: "text", text: value } : undefined),
        join: (part) => (part.kind === "text" ? part.text : ""),
    });
}

VersioningRoles.register("dataSourceDefinition", {
    fieldLabel: (_item, path) => (path === "jsonPath" ? "JSON path" : path),
    // The query list and headers are long; their summary is their count.
    formatValue: (_item, _path, value) =>
        Array.isArray(value)
            ? `${value.length} item${value.length === 1 ? "" : "s"}`
            : JSON.stringify(value ?? null),
});
