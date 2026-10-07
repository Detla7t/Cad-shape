// Part of the Chili3d Project, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { type IEdge, type IFace, type IShape, ShapeTypes } from "@chili3d/core";
import { createMockDocument } from "@chili3d/core/test-utils";
import { initWasm, ShapeFactory } from "@chili3d/wasm";
import type { MachineProfileData } from "../../src/model/machine";
import type { CamMesh, CamOperationContext } from "../../src/model/operation";
import type { SetupData } from "../../src/model/setup";
import type { ToolData } from "../../src/model/tool";
import type { Vec3 } from "../../src/model/toolpath";
import { FaceSampler } from "../../src/ops5x/surface";
import { dot } from "../../src/ops5x/vec";

/** Kernel setup and a hand-built operation context (WCS = model coordinates). */

const WASM_BINARY = readFileSync(
    path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../wasm/lib/chili-wasm.wasm"),
);

export async function setupKernel(): Promise<void> {
    await initWasm({ wasmBinary: WASM_BINARY });
    Object.defineProperty(globalThis, "shapeFactory", {
        value: new ShapeFactory(),
        writable: true,
        configurable: true,
    });
}

export const TEST_SETUP: SetupData = {
    id: "setup",
    name: "Setup",
    machineId: "generic-5ax-ac-trunnion-kin",
    wcs: { origin: [0, 0, 0], xAxis: [1, 0, 0], zAxis: [0, 0, 1] },
    stock: { kind: "box", margin: { x: 0, y: 0, zTop: 0, zBottom: 0 } },
    partIds: [],
    operations: [],
};

export function meshOf(shapes: readonly IShape[]): CamMesh {
    const positions: number[] = [];
    const indices: number[] = [];
    for (const shape of shapes) {
        const faces = shape.mesh.faces;
        if (faces === undefined) continue;
        const offset = positions.length / 3;
        positions.push(...faces.position);
        for (const index of faces.index) indices.push(index + offset);
    }
    return { positions: new Float32Array(positions), indices: new Uint32Array(indices) };
}

export function fakeContext(options: {
    machine: MachineProfileData;
    tool: ToolData;
    parts: readonly IShape[];
    faces?: readonly IFace[];
    edges?: readonly IEdge[];
}): CamOperationContext {
    const boxes = options.parts.map((part) => part.boundingBox());
    const min: Vec3 = [
        Math.min(...boxes.map((b) => b.min.x)),
        Math.min(...boxes.map((b) => b.min.y)),
        Math.min(...boxes.map((b) => b.min.z)),
    ];
    const max: Vec3 = [
        Math.max(...boxes.map((b) => b.max.x)),
        Math.max(...boxes.map((b) => b.max.y)),
        Math.max(...boxes.map((b) => b.max.z)),
    ];
    let mesh: CamMesh | undefined;
    return {
        document: createMockDocument(),
        setup: TEST_SETUP,
        machine: options.machine,
        tool: options.tool,
        parts: options.parts,
        stock: { min, max },
        partMesh: () => {
            mesh ??= meshOf(options.parts);
            return mesh;
        },
        selectedFaces: () => [...(options.faces ?? [])],
        selectedEdges: () => [...(options.edges ?? [])],
        selectedLoops: () => [],
    };
}

/** The shape's faces. */
export function facesOf(shape: IShape): IFace[] {
    return shape.findSubShapes(ShapeTypes.face) as IFace[];
}

/** The face whose normal at its UV centre is closest to `normal`. */
export function faceFacing(shape: IShape, normal: Vec3): IFace {
    let best: { face: IFace; score: number } | undefined;
    for (const face of facesOf(shape)) {
        const sampler = new FaceSampler(face);
        const bounds = sampler.uvBounds().value;
        const at = sampler.at((bounds.u1 + bounds.u2) / 2, (bounds.v1 + bounds.v2) / 2);
        sampler.dispose();
        const score = dot(at.normal, normal);
        if (best === undefined || score > best.score) best = { face, score };
    }
    return best!.face;
}

/** The first face whose surface is not planar. */
export function curvedFace(shape: IShape): IFace {
    const face = facesOf(shape).find((candidate) => {
        const surface = candidate.surface();
        const planar = surface.isPlanar();
        surface.dispose();
        return !planar;
    });
    expect(face).not.toBeUndefined();
    return face!;
}
