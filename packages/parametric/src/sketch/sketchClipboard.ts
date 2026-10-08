// Part of the Chili3d Project, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

import type { SketchData } from "./sketchModel";
import { appendEntity } from "./sketchOperations";

const KEY = "chili.sketchClipboard.v1";
let memory: SketchData | undefined;
export function copySketch(data: SketchData, selection: number[]): void {
    const ids = new Set(selection.length ? selection : data.entities.map((e) => e.id));
    memory = structuredClone({
        ...data,
        entities: data.entities.filter((e) => ids.has(e.id)),
        constraints: data.constraints.filter((c) => c.refs.every((r) => ids.has(r.entityId))),
        externalRefs: undefined,
    });
    try {
        localStorage.setItem(KEY, JSON.stringify(memory));
    } catch {
        /* In-memory clipboard remains usable. */
    }
}
export function sketchClipboard(): SketchData | undefined {
    try {
        const stored = JSON.parse(localStorage.getItem(KEY) ?? "null");
        if (stored && Array.isArray(stored.entities) && Array.isArray(stored.constraints)) memory = stored;
    } catch {
        /* Keep the last valid sketch clipboard. */
    }
    return memory && structuredClone(memory);
}
/** Coordinates are local to the receiving sketch plane; all entity and constraint ids are remapped. */
export function appendSketch(target: SketchData, source: SketchData): void {
    if (source.images?.length) {
        target.images ??= [];
        target.images.push(...source.images.map((i) => ({ ...i, id: crypto.randomUUID() })));
    }
    const ids = new Map(source.entities.map((e) => [e.id, appendEntity(target, e.type, [...e.params], e)]));
    let next = Math.max(0, ...target.constraints.map((c) => c.id)) + 1;
    for (const c of source.constraints) {
        if (c.refs.every((r) => ids.has(r.entityId)))
            target.constraints.push({
                ...structuredClone(c),
                id: next++,
                refs: c.refs.map((r) => ({ ...r, entityId: ids.get(r.entityId)! })),
            });
    }
    const layers = target.layers ?? [];
    for (const layer of source.layers ?? [])
        if (!layers.some((l) => l.id === layer.id)) layers.push({ ...layer });
    if (layers.length) target.layers = layers;
}
