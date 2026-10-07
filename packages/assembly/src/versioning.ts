// Part of the Chili3d Project, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

import {
    formatNumber,
    isJsonObject,
    type JsonValue,
    registerPropertySplitter,
    seqItems,
    summarizeValue,
    VersioningRoles,
} from "@chili3d/core";

/**
 * How the version history sees assemblies and links: an assembly's instances and mates are
 * one object per instance / mate (inserting a part, moving one, adding a mate stores just that
 * item, and two branches editing different instances merge without a conflict); a linked
 * part's link is a JSON object diffed field by field, so updating it reads as
 * "version: V1 → V2" in the history.
 */

function listSplitter(className: string, property: string, role: string) {
    registerPropertySplitter({
        className,
        property,
        split(value) {
            if (typeof value !== "string") return undefined;
            const items = JSON.parse(value) as unknown;
            if (!Array.isArray(items)) return undefined;
            return { kind: "seq", role, items: seqItems(items, (x) => (x as { id?: string })?.id) };
        },
        join: (part) => JSON.stringify(part.kind === "seq" ? part.items.map((x) => x.value) : []),
    });
}

listSplitter("AssemblyNode", "instancesJson", "assemblyInstance");
listSplitter("AssemblyNode", "matesJson", "assemblyMate");

registerPropertySplitter({
    className: "LinkedPartNode",
    property: "linkJson",
    split(value) {
        if (typeof value !== "string") return undefined;
        const link = JSON.parse(value) as unknown;
        return isJsonObject(link) ? { kind: "json", role: "partLink", value: link } : undefined;
    },
    join: (part) => JSON.stringify(part.kind === "json" ? part.value : {}),
});

const nameOr = (value: JsonValue, fallback: string) =>
    isJsonObject(value) && typeof value["name"] === "string" && value["name"] !== ""
        ? value["name"]
        : fallback;

function linkField(path: string): string | undefined {
    const leaf = path.split(".").at(-1);
    if (leaf === "resolvedCommit") return "source commit";
    if (leaf === "versionLabel") return "version";
    if (path.endsWith("version.name") || path.endsWith("version.id") || path.endsWith("version.kind")) {
        return "linked version";
    }
    return undefined;
}

function linkHidden(path: string): boolean {
    const leaf = path.split(".").at(-1);
    return leaf === "documentName" || leaf === "nodeName";
}

function shortValue(path: string, value: JsonValue | undefined): string {
    if (typeof value === "string" && path.endsWith("resolvedCommit")) return value.slice(0, 7);
    return summarizeValue(value);
}

VersioningRoles.register("assemblyInstance", {
    itemLabel: (value, _items, index) => `Instance ${nameOr(value, String(index + 1))}`,
    fieldLabel(_item, path) {
        if (path === "transform") return "placement";
        if (path === "grounded") return "fixed";
        return linkField(path) ?? path;
    },
    formatValue(_item, path, value) {
        if (path === "transform" && Array.isArray(value)) {
            const t = value.slice(12, 15).map((x) => formatNumber(Number(Number(x).toFixed(3))));
            return `(${t.join(", ")})`;
        }
        return shortValue(path, value);
    },
    hiddenField: linkHidden,
});

VersioningRoles.register("assemblyMate", {
    itemLabel: (value, _items, index) => {
        const type = isJsonObject(value) && typeof value["type"] === "string" ? value["type"] : "mate";
        return `${type.charAt(0).toUpperCase()}${type.slice(1)} mate ${nameOr(value, String(index + 1))}`;
    },
    fieldLabel(_item, path) {
        if (path.startsWith("a.")) return "first connector";
        if (path.startsWith("b.")) return "second connector";
        return path;
    },
    formatValue: (_item, _path, value) =>
        Array.isArray(value)
            ? `(${value.map((x) => (typeof x === "number" ? formatNumber(Number(x.toFixed(3))) : String(x))).join(", ")})`
            : summarizeValue(value),
});

VersioningRoles.register("partLink", {
    fieldLabel: (_item, path) => linkField(path) ?? path,
    formatValue: (_item, path, value) => shortValue(path, value),
    hiddenField: linkHidden,
});
