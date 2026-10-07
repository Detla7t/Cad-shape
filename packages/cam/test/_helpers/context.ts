// Part of the Chili3d Project, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

import type { IEdge, IFace, IShape } from "@chili3d/core";
import { createMockDocument } from "@chili3d/core/test-utils";
import type {
    CamLoop,
    CamOperationContext,
    CamOperationData,
    MachineProfileData,
    StockData,
    ToolData,
    ToolpathData,
    ToolpathMove,
    Vec3,
} from "../../src";
import { arcPoints, circleThrough, type Point2 } from "../../src/geometry2d";

/** A CAM operation context built by hand: what the CAM Studio pipeline resolves for real. */
export interface FakeContextOptions {
    readonly machine?: Partial<MachineProfileData>;
    readonly tool?: Partial<ToolData>;
    readonly loops?: readonly CamLoop[];
    readonly faces?: readonly IFace[];
    readonly edges?: readonly IEdge[];
    readonly parts?: readonly IShape[];
    readonly stock: { readonly min: Vec3; readonly max: Vec3 };
    readonly setupStock?: StockData;
}

export function millTool(diameter: number, extra: Partial<ToolData> = {}): ToolData {
    return {
        id: `em${diameter}`,
        number: 1,
        name: `Ø${diameter} end mill`,
        kind: "flatEndmill",
        diameter,
        cutting: { feed: 1000, plungeFeed: 300, spindleRpm: 12000, stepdown: diameter / 2 },
        ...extra,
    };
}

export function fakeContext(options: FakeContextOptions): CamOperationContext {
    const machine: MachineProfileData = {
        id: "test-machine",
        name: "Test machine",
        kind: "mill",
        linearAxes: [
            { name: "X", min: -1000, max: 1000 },
            { name: "Y", min: -1000, max: 1000 },
            { name: "Z", min: -500, max: 500 },
        ],
        maxFeed: 20000,
        rapidFeed: 30000,
        post: { id: "test" },
        ...options.machine,
    };
    const tool: ToolData = { ...millTool(6), ...options.tool } as ToolData;
    return {
        document: createMockDocument(),
        setup: {
            id: "setup",
            name: "Setup",
            machineId: machine.id,
            wcs: { origin: [0, 0, 0], xAxis: [1, 0, 0], zAxis: [0, 0, 1] },
            stock: options.setupStock ?? { kind: "box", margin: { x: 0, y: 0, zTop: 0, zBottom: 0 } },
            partIds: [],
            operations: [],
        },
        machine,
        tool,
        parts: options.parts ?? [],
        stock: options.stock,
        partMesh: () => ({ positions: new Float32Array(), indices: new Uint32Array() }),
        selectedFaces: () => [...(options.faces ?? [])],
        selectedEdges: () => [...(options.edges ?? [])],
        selectedLoops: () => [...(options.loops ?? [])],
    };
}

export function operation(type: string, params: Record<string, unknown>, name = type): CamOperationData {
    return { id: `${type}-op`, type, name, params };
}

export const rectLoop = (x0: number, y0: number, x1: number, y1: number): Point2[] => [
    [x0, y0],
    [x1, y0],
    [x1, y1],
    [x0, y1],
];

export function circleLoop(center: Point2, radius: number, tolerance = 0.001, ccw = true): Point2[] {
    const points = arcPoints(center, radius, 0, ccw ? 2 * Math.PI : -2 * Math.PI, tolerance);
    points.pop();
    return points;
}

/** The XY point of a move, if it moves. */
export function moveXY(move: ToolpathMove): Point2 | undefined {
    switch (move.kind) {
        case "rapid":
        case "linear":
        case "arc":
        case "taper":
            return [move.to[0], move.to[1]];
        case "drill":
            return [move.at[0], move.at[1]];
        default:
            return undefined;
    }
}

/**
 * Points along the cutting moves (lines and arcs sampled every `step` mm) with their Z,
 * the start of each move included; rapids are skipped.
 */
export function cuttingSamples(path: ToolpathData, step = 0.25): { p: Point2; z: number }[] {
    const out: { p: Point2; z: number }[] = [];
    let at: Vec3 | undefined;
    for (const move of path.moves) {
        if (move.kind === "rapid") {
            at = move.to;
            continue;
        }
        if ((move.kind === "linear" || move.kind === "arc") && at !== undefined) {
            const from = at;
            const to = move.to;
            if (move.kind === "linear") {
                const length = Math.hypot(to[0] - from[0], to[1] - from[1]);
                const n = Math.max(1, Math.ceil(length / step));
                for (let i = 0; i <= n; i++) {
                    const t = i / n;
                    out.push({
                        p: [from[0] + (to[0] - from[0]) * t, from[1] + (to[1] - from[1]) * t],
                        z: from[2] + (to[2] - from[2]) * t,
                    });
                }
            } else {
                const c = move.center;
                const r = Math.hypot(from[0] - c[0], from[1] - c[1]);
                const a0 = Math.atan2(from[1] - c[1], from[0] - c[0]);
                const a1 = Math.atan2(to[1] - c[1], to[0] - c[0]);
                let sweep = move.clockwise ? a0 - a1 : a1 - a0;
                while (sweep <= 1e-12) sweep += 2 * Math.PI;
                const n = Math.max(2, Math.ceil((sweep * r) / step));
                for (let i = 0; i <= n; i++) {
                    const a = a0 + ((move.clockwise ? -1 : 1) * sweep * i) / n;
                    out.push({
                        p: [c[0] + r * Math.cos(a), c[1] + r * Math.sin(a)],
                        z: from[2] + ((to[2] - from[2]) * i) / n,
                    });
                }
            }
        }
        const end = "to" in move ? (move as { to: Vec3 }).to : undefined;
        if (end !== undefined) at = end;
    }
    return out;
}

/** CamLoops of a sheet metal flat pattern's segment loops (arcs flattened within 1 µm). */
export function segmentLoopPoints(
    loop: readonly (
        | { kind: "line"; a: Point2; b: Point2 }
        | { kind: "arc"; a: Point2; mid: Point2; b: Point2 }
    )[],
): Point2[] {
    const points: Point2[] = [];
    for (const segment of loop) {
        points.push(segment.a);
        if (segment.kind !== "arc") continue;
        const circle = circleThrough(segment.a, segment.mid, segment.b);
        if (circle === undefined) continue;
        const angle = (p: Point2) => Math.atan2(p[1] - circle.center[1], p[0] - circle.center[0]);
        const ccw =
            (segment.mid[0] - segment.a[0]) * (segment.b[1] - segment.mid[1]) -
                (segment.mid[1] - segment.a[1]) * (segment.b[0] - segment.mid[0]) >
            0;
        let sweep = angle(segment.b) - angle(segment.a);
        if (ccw && sweep <= 0) sweep += 2 * Math.PI;
        if (!ccw && sweep >= 0) sweep -= 2 * Math.PI;
        const arc = arcPoints(circle.center, circle.radius, angle(segment.a), sweep, 0.001);
        points.push(...arc.slice(1, -1));
    }
    return points;
}
