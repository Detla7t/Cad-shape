// Part of the Chili3d Project, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

import { arrayToRigid, makeFrame, rigidToArray } from "../math/rigid";
import {
    type DragTarget,
    type SolveResult,
    type SolverInstance,
    type SolverMate,
    solveMates,
} from "../solver/mateSolver";
import { AssemblyNode } from "./assemblyNode";
import type { MateConnectorData, MateData } from "./assemblyTypes";
import { reanchorConnector } from "./connectors";
import { type AssemblyEvaluation, evaluateAssembly } from "./evaluate";

/** The bridge between an assembly's stored data and the pure solver. */

const DEG = Math.PI / 180;

function solverConnector(connector: MateConnectorData) {
    return {
        instanceId: connector.instanceId,
        frame: makeFrame(connector.origin, connector.zAxis, connector.xAxis),
    };
}

export function solverMates(mates: readonly MateData[]): SolverMate[] {
    return mates
        .filter((m) => !m.suppressed)
        .map((m) => ({
            id: m.id,
            type: m.type,
            a: solverConnector(m.a),
            b: solverConnector(m.b),
            flipped: m.flipped,
            offset:
                m.offset === undefined
                    ? undefined
                    : { x: m.offset.x, y: m.offset.y, z: m.offset.z, angle: (m.offset.angle ?? 0) * DEG },
            limits:
                m.limits === undefined
                    ? undefined
                    : m.type === "revolute"
                      ? {
                            min: m.limits.min === undefined ? undefined : m.limits.min * DEG,
                            max: m.limits.max === undefined ? undefined : m.limits.max * DEG,
                        }
                      : m.limits,
        }));
}

export function solverInstances(assembly: AssemblyNode): SolverInstance[] {
    return assembly.instances
        .filter((x) => !x.suppressed)
        .map((x) => ({ id: x.id, transform: arrayToRigid(x.transform), grounded: x.grounded === true }));
}

export interface AssemblySolveOptions {
    readonly drag?: DragTarget;
    /** Write the solved placements to the assembly (one undo step); default true. */
    readonly apply?: boolean;
    readonly noSnap?: boolean;
    readonly name?: string;
}

/** Solves an assembly's mates and (by default) writes the new placements back. */
export function solveAssembly(assembly: AssemblyNode, options: AssemblySolveOptions = {}): SolveResult {
    const result = solveMates(solverInstances(assembly), solverMates(assembly.mates), {
        drag: options.drag,
        noSnap: options.noSnap,
    });
    if (options.apply !== false) {
        const transforms = new Map<string, readonly number[]>();
        for (const [id, transform] of result.transforms) transforms.set(id, rigidToArray(transform));
        assembly.setTransforms(transforms, options.name);
    }
    return result;
}

// A linked instance moved to a new version: its connectors follow the new geometry, then the
// mates re-solve — in the same undo step as the update.
AssemblyNode.linkFollowUp = (assembly) => {
    reanchorMates(assembly, evaluateAssembly(assembly.document, assembly));
    solveAssembly(assembly, { name: "update linked part" });
};

/**
 * Re-infers every mate connector whose part changed shape (by stable id where the part tracks
 * ids) and stores the moved ones as one step. Returns how many connectors moved.
 */
export function reanchorMates(assembly: AssemblyNode, evaluation: AssemblyEvaluation): number {
    let moved = 0;
    const mates = assembly.mates.map((mate) => {
        const a = reanchorConnector(mate.a, evaluation.parts);
        const b = reanchorConnector(mate.b, evaluation.parts);
        if (a === undefined && b === undefined) return mate;
        moved += (a === undefined ? 0 : 1) + (b === undefined ? 0 : 1);
        return { ...mate, a: a ?? mate.a, b: b ?? mate.b };
    });
    if (moved > 0) assembly.setMates(mates, "re-anchor mates");
    return moved;
}
