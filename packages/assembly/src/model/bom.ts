// Part of the Chili3d Project, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

import { linkCacheKey } from "../link/linkTypes";
import { type AssemblyEvaluation, LOCAL_SOURCE_LABEL } from "./evaluate";

/**
 * Bill of materials. FLATTENED (the default) counts solids: every placed part, also the ones
 * inside sub-assemblies and linked assemblies, grouped by what they are — the same part of the
 * same document at the same version is one item. STRUCTURED counts the assembly's own
 * instances: a sub-assembly is one item.
 */

export interface BomRow {
    readonly item: number;
    readonly name: string;
    /** "This document", or "<document> @ <version>" for a linked source. */
    readonly source: string;
    readonly quantity: number;
    /** The instance names behind the row. */
    readonly instances: readonly string[];
    readonly key: string;
}

export interface BomOptions {
    readonly structured?: boolean;
}

export function buildBom(evaluation: AssemblyEvaluation, options: BomOptions = {}): BomRow[] {
    const rows = new Map<string, { name: string; source: string; quantity: number; instances: string[] }>();
    const add = (key: string, name: string, source: string, instance: string) => {
        const row = rows.get(key);
        if (row === undefined) {
            rows.set(key, { name, source, quantity: 1, instances: [instance] });
        } else {
            row.quantity++;
            row.instances.push(instance);
        }
    };
    if (options.structured) {
        for (const { instance, parts } of evaluation.instances) {
            if (instance.suppressed) continue;
            const source = instance.source;
            if (source.kind === "part") {
                add(
                    `local:${source.nodeId}`,
                    parts[0]?.name ?? instance.name,
                    LOCAL_SOURCE_LABEL,
                    instance.name,
                );
            } else if (source.kind === "assembly") {
                add(
                    `assembly:${source.nodeId}`,
                    instance.name.replace(/ <\d+>$/, ""),
                    LOCAL_SOURCE_LABEL,
                    instance.name,
                );
            } else {
                const link = source.link;
                const key = linkCacheKey(link.documentId, link.resolvedCommit ?? "?", link.nodeId);
                const label = `${link.documentName ?? link.documentId} @ ${link.versionLabel ?? link.resolvedCommit?.slice(0, 7) ?? "?"}`;
                add(key, link.nodeName ?? instance.name, label, instance.name);
            }
        }
    } else {
        for (const part of evaluation.parts) {
            const name = part.name.split(" › ").at(-1) ?? part.name;
            add(part.bomKey, name, part.sourceLabel, part.instanceName);
        }
    }
    return [...rows.entries()].map(([key, row], index) => ({ item: index + 1, key, ...row }));
}

function csvField(value: string | number): string {
    const text = String(value);
    return /[",\n\r]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

/** The BOM as CSV (RFC 4180): item, name, source, quantity. */
export function bomToCsv(rows: readonly BomRow[]): string {
    const lines = [["Item", "Name", "Source", "Quantity"].join(",")];
    for (const row of rows)
        lines.push([row.item, row.name, row.source, row.quantity].map(csvField).join(","));
    return `${lines.join("\r\n")}\r\n`;
}
