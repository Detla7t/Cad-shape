// Part of the Chili3d Project, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

import {
    formatNumber,
    isJsonObject,
    type JsonValue,
    type Part,
    registerPropertySplitter,
    seqItems,
    summarizeValue,
    VersioningRoles,
} from "@chili3d/core";
import { camOperation } from "./model/operation";
import type { CamOperationData, SetupData } from "./model/setup";

/**
 * How the version history sees a CAM Studio: its setups are a record of collections — the
 * setups themselves (WCS, stock, parts, machine, post) one object each, and per setup its
 * operations and its tools one object each (`ops/<setup id>`, `tools/<setup id>`). Editing
 * one operation stores one operation; two branches editing different operations, or adding
 * operations to different setups, merge without a conflict. The document's machine
 * profiles are one object per profile.
 */

const OPERATIONS_PREFIX = "ops/";
const TOOLS_PREFIX = "tools/";

export function splitSetups(value: unknown): Part | undefined {
    if (typeof value !== "string") return undefined;
    const setups = JSON.parse(value) as unknown;
    if (!Array.isArray(setups)) return undefined;
    const fields: Record<string, Part> = {};
    const frames: JsonValue[] = [];
    for (const setup of setups as SetupData[]) {
        if (!isJsonObject(setup as unknown as JsonValue) || typeof setup.id !== "string") return undefined;
        const { operations, tools, ...frame } = setup;
        frames.push(frame as unknown as JsonValue);
        fields[`${OPERATIONS_PREFIX}${setup.id}`] = {
            kind: "seq",
            role: "camOperation",
            items: seqItems(operations ?? [], (operation) => (operation as CamOperationData)?.id),
        };
        if (tools !== undefined) {
            fields[`${TOOLS_PREFIX}${setup.id}`] = {
                kind: "seq",
                role: "camTool",
                items: seqItems(tools, (tool) => (tool as { id?: string })?.id),
            };
        }
    }
    fields["setups"] = {
        kind: "seq",
        role: "camSetup",
        items: seqItems(frames, (frame) => (frame as { id?: string })?.id),
    };
    return { kind: "rec", role: "camSetups", fields };
}

export function joinSetups(part: Part): string {
    if (part.kind !== "rec") return "[]";
    const frames = part.fields["setups"];
    if (frames?.kind !== "seq") return "[]";
    const setups = frames.items.map((item) => {
        const frame = item.value as unknown as Record<string, unknown>;
        const operations = part.fields[`${OPERATIONS_PREFIX}${item.id}`];
        const tools = part.fields[`${TOOLS_PREFIX}${item.id}`];
        const setup: Record<string, unknown> = { ...frame };
        setup["operations"] = operations?.kind === "seq" ? operations.items.map((x) => x.value) : [];
        if (tools?.kind === "seq") setup["tools"] = tools.items.map((x) => x.value);
        return setup;
    });
    return JSON.stringify(setups);
}

registerPropertySplitter({
    className: "CamStudioNode",
    property: "setupsJson",
    split: splitSetups,
    join: joinSetups,
});

registerPropertySplitter({
    className: "CamStudioNode",
    property: "machinesJson",
    split(value) {
        if (typeof value !== "string") return undefined;
        const machines = JSON.parse(value) as unknown;
        if (!Array.isArray(machines)) return undefined;
        return {
            kind: "seq",
            role: "camMachine",
            items: seqItems(machines, (m) => (m as { id?: string })?.id),
        };
    },
    join: (part) => JSON.stringify(part.kind === "seq" ? part.items.map((x) => x.value) : []),
});

const named = (value: JsonValue, fallback: string) =>
    isJsonObject(value) && typeof value["name"] === "string" && value["name"] !== ""
        ? value["name"]
        : fallback;

VersioningRoles.register("camSetup", {
    itemLabel: (value) => named(value, "Setup"),
    fieldLabel: (_item, path) => (path === "machineId" ? "machine" : path === "partIds" ? "parts" : path),
    formatValue: (_item, path, value) => {
        if (path === "partIds" && Array.isArray(value))
            return `${value.length} part${value.length === 1 ? "" : "s"}`;
        if (typeof value === "number" && (path.startsWith("stock.") || path.startsWith("wcs.origin"))) {
            return `${formatNumber(value)} mm`;
        }
        return summarizeValue(value);
    },
});

function operationParameter(item: JsonValue, path: string) {
    if (!isJsonObject(item) || typeof item["type"] !== "string" || !path.startsWith("params."))
        return undefined;
    const handler = camOperation(item["type"]);
    if (handler === undefined) return undefined;
    try {
        return handler.parameters(item as unknown as CamOperationData).find((p) => p.key === path.slice(7));
    } catch {
        return undefined;
    }
}

VersioningRoles.register("camOperation", {
    itemLabel(value, _items, index) {
        if (isJsonObject(value) && typeof value["name"] === "string" && value["name"] !== "")
            return value["name"];
        const type = isJsonObject(value) && typeof value["type"] === "string" ? value["type"] : "Operation";
        return `${camOperation(type)?.label ?? type} ${index + 1}`;
    },
    fieldLabel(item, path) {
        if (path === "toolId") return "tool";
        if (path === "selection") return "geometry";
        const parameter = operationParameter(item, path);
        if (parameter === undefined) return path.startsWith("params.") ? path.slice(7) : path;
        return parameter.label.charAt(0).toLocaleLowerCase() + parameter.label.slice(1);
    },
    formatValue(item, path, value) {
        if (path === "selection" && Array.isArray(value))
            return `${value.length} pick${value.length === 1 ? "" : "s"}`;
        const parameter = operationParameter(item, path);
        if (typeof value === "number" && parameter?.kind === "length") return `${formatNumber(value)} mm`;
        if (typeof value === "number" && parameter?.kind === "angle") return `${formatNumber(value)}°`;
        if (typeof value === "string" && parameter?.kind === "enum") {
            return parameter.options?.find((option) => option.value === value)?.label ?? value;
        }
        return summarizeValue(value);
    },
});

VersioningRoles.register("camTool", {
    itemLabel: (value) =>
        isJsonObject(value) ? `T${String(value["number"] ?? "?")} ${named(value, "Tool")}` : "Tool",
    formatValue: (_item, path, value) =>
        typeof value === "number" &&
        ["diameter", "cornerRadius", "fluteLength", "stickout", "overallLength"].includes(path)
            ? `${formatNumber(value)} mm`
            : summarizeValue(value),
});

VersioningRoles.register("camMachine", {
    itemLabel: (value) => named(value, "Machine"),
});
