// Part of the Chili3d Project, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

import type { IFace } from "@chili3d/core";
import { createMockDocument } from "@chili3d/core/test-utils";
import type {
    CamOperationContext,
    CamOperationData,
    MachineProfileData,
    ToolData,
    ToolpathData,
    ToolpathMove,
    Vec3,
} from "../../src";
import { type TestMesh, toCamMesh } from "./meshes";

export const TEST_MILL: MachineProfileData = {
    id: "test-mill",
    name: "Test mill",
    kind: "mill",
    linearAxes: [
        { name: "X", min: -500, max: 500 },
        { name: "Y", min: -500, max: 500 },
        { name: "Z", min: -300, max: 300 },
    ],
    maxFeed: 10000,
    rapidFeed: 20000,
    post: { id: "test" },
};

export function testTool(kind: ToolData["kind"], diameter: number, extra: Partial<ToolData> = {}): ToolData {
    return {
        id: `${kind}-${diameter}`,
        number: 1,
        name: `${diameter} mm ${kind}`,
        kind,
        diameter,
        cutting: { feed: 1200, plungeFeed: 300, spindleRpm: 12000 },
        ...extra,
    };
}

/** A fake operation context over a test mesh: the stock box is given or the mesh bounds grown by `margin`. */
export function testContext(
    mesh: TestMesh,
    tool: ToolData,
    options: { stock?: { min: Vec3; max: Vec3 }; margin?: number; faces?: IFace[] } = {},
): CamOperationContext {
    const camMesh = toCamMesh(mesh);
    let stock = options.stock;
    if (!stock) {
        const min = [Infinity, Infinity, Infinity];
        const max = [-Infinity, -Infinity, -Infinity];
        for (let k = 0; k < mesh.positions.length; k += 3) {
            for (let a = 0; a < 3; a++) {
                min[a] = Math.min(min[a], mesh.positions[k + a]);
                max[a] = Math.max(max[a], mesh.positions[k + a]);
            }
        }
        const m = options.margin ?? 0;
        stock = { min: [min[0] - m, min[1] - m, min[2]], max: [max[0] + m, max[1] + m, max[2] + m] };
    }
    return {
        document: createMockDocument(),
        setup: {
            id: "setup",
            name: "Setup",
            machineId: TEST_MILL.id,
            wcs: { origin: [0, 0, 0], xAxis: [1, 0, 0], zAxis: [0, 0, 1] },
            stock: { kind: "box", margin: { x: 0, y: 0, zTop: 0, zBottom: 0 } },
            partIds: [],
            operations: [],
        },
        machine: TEST_MILL,
        tool,
        parts: [],
        stock,
        partMesh: () => camMesh,
        selectedFaces: () => options.faces ?? [],
        selectedEdges: () => [],
        selectedLoops: () => [],
    };
}

export function testOperation(type: string, params: Record<string, unknown>): CamOperationData {
    return { id: "op", type, name: type, params };
}

/** The cutting moves' end points (linear moves and arcs). */
export function cutPoints(path: ToolpathData): Vec3[] {
    return path.moves
        .filter(
            (move): move is Extract<ToolpathMove, { kind: "linear" | "arc" }> =>
                move.kind === "linear" || move.kind === "arc",
        )
        .map((move) => move.to);
}

/** Consecutive feed moves as segments [from, to] (the first move from wherever the tool was). */
export function cutSegments(path: ToolpathData): [Vec3, Vec3][] {
    const segments: [Vec3, Vec3][] = [];
    let at: Vec3 | undefined;
    for (const move of path.moves) {
        if (move.kind !== "rapid" && move.kind !== "linear") continue;
        if (move.kind === "linear" && at) segments.push([at, move.to]);
        at = move.to;
    }
    return segments;
}
