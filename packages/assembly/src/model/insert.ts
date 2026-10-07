// Part of the Chili3d Project, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

import { Id } from "@chili3d/core";
import type { AssemblyNode } from "./assemblyNode";
import { type AssemblyInstanceData, IDENTITY_TRANSFORM, type InstanceSourceData } from "./assemblyTypes";
import { evaluateAssembly } from "./evaluate";

const GAP = 10;

function sameSource(a: InstanceSourceData, b: InstanceSourceData): boolean {
    if (a.kind !== b.kind) return false;
    if (a.kind === "link" && b.kind === "link") {
        return a.link.documentId === b.link.documentId && a.link.nodeId === b.link.nodeId;
    }
    return (a as { nodeId: string }).nodeId === (b as { nodeId: string }).nodeId;
}

/**
 * Inserts an instance of `source` (one undo step), named "<name> <n>" as Onshape numbers them.
 * The first instance of an assembly is fixed; repeated instances of one source are placed side
 * by side along X rather than on top of each other.
 */
export function insertInstance(
    assembly: AssemblyNode,
    source: InstanceSourceData,
    name: string,
    options: { transform?: readonly number[]; grounded?: boolean } = {},
): AssemblyInstanceData {
    const existing = assembly.instances.filter((x) => sameSource(x.source, source));
    const number = assembly.instances.filter((x) => x.name.replace(/ <\d+>$/, "") === name).length + 1;
    let transform = options.transform ?? IDENTITY_TRANSFORM;
    if (options.transform === undefined && existing.length > 0) {
        const parts = evaluateAssembly(assembly.document, assembly).parts.filter((p) =>
            existing.some((x) => x.id === p.instanceId),
        );
        let width = 0;
        for (const part of parts) {
            const box = part.shape.boundingBox();
            width = Math.max(width, box.max.x - box.min.x);
        }
        const step = (width + GAP) * existing.length;
        transform = [...IDENTITY_TRANSFORM.slice(0, 12), step, 0, 0, 1];
    }
    const instance: AssemblyInstanceData = {
        id: Id.generate(),
        name: `${name} <${number}>`,
        source,
        transform: [...transform],
        ...((options.grounded ?? assembly.instances.length === 0) ? { grounded: true } : {}),
    };
    assembly.addInstances([instance]);
    return instance;
}
