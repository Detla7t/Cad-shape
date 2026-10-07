// Part of the Chili3d Project, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

import type { IShape, Result } from "@chili3d/core";
import { createMockDocument } from "@chili3d/core/test-utils";
import { type CamMesh, type CamOperationContext, machineProfile, type SetupData } from "../../src";

/** A printer operation context over meshes in the bed frame (no kernel needed). */
export function printerContext(
    machineId: string,
    mesh: CamMesh,
    options: { parts?: readonly { id: string; name: string; mesh: CamMesh }[] } = {},
): CamOperationContext {
    const machine = machineProfile(machineId);
    if (!machine) throw new Error(`no machine profile ${machineId}`);
    const parts = options.parts ?? [];
    const names = new Map(parts.map((part) => [part.id, part.name]));
    const document = createMockDocument({
        modelManager: {
            findNode: (predicate: (node: never) => boolean) => {
                for (const [id, name] of names) {
                    const node = { id, name } as never;
                    if (predicate(node)) return node;
                }
                return undefined;
            },
        } as never,
    });
    const setup: SetupData = {
        id: "setup-1",
        name: "Print job",
        machineId,
        wcs: { origin: [0, 0, 0], xAxis: [1, 0, 0], zAxis: [0, 0, 1] },
        stock: { kind: "box", margin: { x: 0, y: 0, zTop: 0, zBottom: 0 } },
        partIds: parts.length > 0 ? parts.map((part) => part.id) : ["part-1"],
        operations: [],
    };
    const shapes = parts.map(
        (part) =>
            ({
                mesh: { faces: { position: part.mesh.positions, index: part.mesh.indices } },
            }) as unknown as IShape,
    );
    return {
        document,
        setup,
        machine,
        tool: machine.tools?.[0] ?? {
            id: "nozzle",
            number: 0,
            name: "nozzle",
            kind: "nozzle",
            diameter: 0.4,
            cutting: { feed: 3600 },
        },
        parts: shapes,
        stock: { min: [0, 0, 0], max: [0, 0, 0] },
        partMesh: () => mesh,
        selectedFaces: () => [],
        selectedEdges: () => [],
        selectedLoops: () => [],
    };
}

/** The value of an ok result; fails the test with the error otherwise. */
export function ok<T>(result: Result<T>): T {
    if (!result.isOk) throw new Error(`expected ok, got: ${String(result.error)}`);
    return result.value;
}
