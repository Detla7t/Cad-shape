// Part of the Chili3d Project, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

import { isJsonObject, type JsonValue } from "./hash";
import { VersioningRoles } from "./parts";

/**
 * Summary labels for the collections every document has. Feature lists, sketches and studios
 * register theirs from the parametric package.
 */

const nameLabel = (fallback: string) => (value: JsonValue, _items: unknown, index: number) =>
    isJsonObject(value) && typeof value["name"] === "string" && value["name"] !== ""
        ? (value["name"] as string)
        : `${fallback} ${index + 1}`;

VersioningRoles.register("variable", {
    itemLabel: (value, items, index) => `Variable ${nameLabel("#")(value, items, index)}`,
    fieldLabel: (_item, path) => path,
});

VersioningRoles.register("configurationInput", {
    itemLabel: (value, items, index) => `Input ${nameLabel("#")(value, items, index)}`,
    fieldLabel: (_item, path) => path,
    formatValue: (_item, _path, value) =>
        value !== null && typeof value === "object" ? JSON.stringify(value) : String(value ?? "—"),
});

VersioningRoles.register("material", {
    itemLabel: (value, items, index) => `Material ${nameLabel("#")(value, items, index)}`,
    formatValue: (_item, path, value) =>
        path === "color" && typeof value === "number"
            ? `#${value.toString(16).padStart(6, "0")}`
            : String(value ?? "—"),
});

VersioningRoles.register("component", {
    itemLabel: (value, items, index) => `Component ${nameLabel("#")(value, items, index)}`,
});
