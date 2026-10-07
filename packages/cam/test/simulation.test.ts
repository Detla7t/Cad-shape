// Part of the Chili3d Project, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

import {
    CHIP_BREAK_RETRACT,
    defaultCellSize,
    flattenToolpaths,
    moveEndPoint,
    moveStart,
    PECK_CLEARANCE,
    type SimulationToolpath,
    simulateToolpaths,
    stockToolFor,
    type ToolData,
    type ToolpathMove,
} from "../src";
import { millTool } from "./_helpers/context";

const flat10 = millTool(10, { id: "t1" });
const drill8: ToolData = {
    id: "t4",
    number: 4,
    name: "Ø8 drill",
    kind: "drill",
    diameter: 8,
    tipAngle: 118,
    fluteLength: 50,
    cutting: { feed: 200 },
};

function entry(tool: ToolData, moves: ToolpathMove[], id = tool.id): SimulationToolpath {
    return { tool, id, toolpath: { toolId: tool.id, moves } };
}

/** A box as 12 triangles. */
function boxMesh(min: readonly number[], max: readonly number[]) {
    const positions: number[] = [];
    for (let k = 0; k < 8; k++) {
        positions.push(k & 1 ? max[0] : min[0], k & 2 ? max[1] : min[1], k & 4 ? max[2] : min[2]);
    }
    const faces = [
        [0, 2, 3, 1],
        [4, 5, 7, 6],
        [0, 1, 5, 4],
        [2, 6, 7, 3],
        [0, 4, 6, 2],
        [1, 3, 7, 5],
    ];
    const indices = faces.flatMap((f) => [f[0], f[1], f[2], f[0], f[2], f[3]]);
    return { positions: new Float32Array(positions), indices: new Uint32Array(indices) };
}

/** Horizontal rectangles [x0, y0, x1, y1, z] as triangles: a part's top surfaces. */
function tops(rects: readonly (readonly number[])[]) {
    const positions: number[] = [];
    const indices: number[] = [];
    for (const [x0, y0, x1, y1, z] of rects) {
        const k = positions.length / 3;
        positions.push(x0, y0, z, x1, y0, z, x1, y1, z, x0, y1, z);
        indices.push(k, k + 1, k + 2, k, k + 2, k + 3);
    }
    return { positions: new Float32Array(positions), indices: new Uint32Array(indices) };
}

const ends = (moves: ReturnType<typeof flattenToolpaths>) =>
    Array.from({ length: moves.rapid.length }, (_, k) => moveEndPoint(moves, k));

describe("flattening a program into straight moves", () => {
    test("starts above the first point, chords arcs within the tolerance and keeps their sources", () => {
        const moves = flattenToolpaths(
            [
                entry(flat10, [
                    { kind: "rapid", to: [10, 0, 5] },
                    { kind: "linear", to: [10, 0, -1], feed: 300 },
                    {
                        kind: "arc",
                        to: [-10, 0, -1],
                        center: [0, 0, -1],
                        clockwise: false,
                        plane: "XY",
                        feed: 900,
                    },
                    { kind: "comment", text: "done" },
                    { kind: "rapid", to: [-10, 0, 5] },
                ]),
            ],
            { arcTolerance: 0.01, homeZ: 50 },
        );
        expect(moves.start).toEqual([10, 0, 50]);
        expect(moves.homeZ).toBe(50);
        const points = ends(moves);
        expect(points[0]).toEqual([10, 0, 5]);
        expect(points[1]).toEqual([10, 0, -1]);
        const arc = points.slice(2, -1);
        expect(arc.length).toBeGreaterThan(10);
        for (const [k, p] of arc.entries()) {
            expect(Math.hypot(p[0], p[1])).toBeCloseTo(10, 9);
            expect(p[1]).toBeGreaterThanOrEqual(0);
            // Each chord's sagitta stays within the tolerance.
            const q = k === 0 ? points[1] : arc[k - 1];
            const mid = Math.hypot((p[0] + q[0]) / 2, (p[1] + q[1]) / 2);
            expect(10 - mid).toBeLessThanOrEqual(0.01 + 1e-12);
        }
        expect([...moves.source]).toEqual([0, 1, ...arc.map(() => 2), 4]);
        expect([...moves.rapid]).toEqual([1, 0, ...arc.map(() => 0), 1]);
    });

    test("expands drill cycles as the mill post does", () => {
        const drill = (cycle: "drill" | "peck" | "chipBreak" | "tap") =>
            flattenToolpaths(
                [
                    entry(drill8, [
                        { kind: "rapid", to: [0, 0, 10] },
                        { kind: "drill", at: [5, 5, 0], depth: 5, retract: 2, cycle, peck: 2, feed: 200 },
                    ]),
                ],
                { homeZ: 50 },
            );
        const plain = drill("drill");
        expect(ends(plain)).toEqual([
            [0, 0, 10],
            [5, 5, 10],
            [5, 5, 2],
            [5, 5, -5],
            [5, 5, 10],
        ]);
        expect([...plain.rapid]).toEqual([1, 1, 1, 0, 1]);
        const peck = drill("peck");
        const z = ends(peck).map((p) => p[2]);
        expect(z).toEqual([
            10,
            10,
            2,
            0,
            2,
            PECK_CLEARANCE,
            -2,
            2,
            -2 + PECK_CLEARANCE,
            -4,
            2,
            -4 + PECK_CLEARANCE,
            -5,
            2,
            10,
        ]);
        expect([...peck.source].slice(2)).toEqual(z.slice(2).map(() => 1));
        const chip = drill("chipBreak");
        expect(ends(chip).map((p) => p[2])).toEqual([
            10,
            10,
            2,
            0,
            CHIP_BREAK_RETRACT,
            -2,
            -2 + CHIP_BREAK_RETRACT,
            -4,
            -4 + CHIP_BREAK_RETRACT,
            -5,
            10,
        ]);
        const tap = drill("tap");
        expect(ends(tap).map((p) => p[2])).toEqual([10, 10, 2, -5, 2, 10]);
        expect([...tap.rapid]).toEqual([1, 1, 1, 0, 0, 1]);
    });

    test("changes tools at the home height: up with the old tool, across and down with the new", () => {
        const moves = flattenToolpaths(
            [
                entry(flat10, [
                    { kind: "rapid", to: [0, 0, 5] },
                    { kind: "linear", to: [20, 0, -1], feed: 300 },
                ]),
                entry(flat10, [{ kind: "linear", to: [20, 10, -1], feed: 300 }], "same tool"),
                entry(drill8, [{ kind: "rapid", to: [30, 30, 5] }]),
            ],
            { homeZ: 40 },
        );
        expect(ends(moves)).toEqual([
            [0, 0, 5],
            [20, 0, -1],
            [20, 10, -1],
            [20, 10, 40],
            [30, 30, 40],
            [30, 30, 5],
        ]);
        expect([...moves.toolpath]).toEqual([0, 0, 1, 1, 2, 2]);
        expect(moveStart(moves, 4)).toEqual([20, 10, 40]);
    });

    test("leaves out tilted toolpaths and starts the next one afresh", () => {
        const moves = flattenToolpaths(
            [
                entry(flat10, [{ kind: "rapid", to: [0, 0, 5] }]),
                entry(flat10, [{ kind: "linear", to: [5, 0, 0], feed: 100, axis: [0, 0.6, 0.8] }]),
                entry(flat10, [{ kind: "rapid", to: [9, 9, 5] }]),
            ],
            { homeZ: 30 },
        );
        expect(moves.skipped).toEqual([1]);
        expect(ends(moves)).toEqual([
            [0, 0, 5],
            [0, 0, 30],
            [9, 9, 30],
            [9, 9, 5],
        ]);
    });
});

describe("simulating toolpaths", () => {
    test("maps CAM tools onto stock profiles", () => {
        const flat = stockToolFor(flat10);
        expect(flat.isOk).toBe(true);
        expect(flat.value).toEqual({ kind: "flat", diameter: 10, fluteLength: undefined, holder: undefined });
        const bull = stockToolFor({
            ...flat10,
            kind: "bullNose",
            cornerRadius: 1,
            fluteLength: 20,
            stickout: 30,
            holder: { diameter: 32, length: 50 },
        });
        expect(bull.isOk && bull.value).toEqual({
            kind: "bull",
            diameter: 10,
            cornerRadius: 1,
            fluteLength: 20,
            holder: { diameter: 32, length: 50, stickout: 30 },
        });
        const chamfer = stockToolFor({ ...flat10, kind: "chamfer", tipAngle: 90 });
        expect(chamfer.isOk && chamfer.value.kind).toBe("cone");
        expect(stockToolFor(drill8).isOk && stockToolFor(drill8).value).toMatchObject({
            kind: "drill",
            angle: 118,
        });
        expect(stockToolFor({ ...flat10, kind: "jet" }).isOk).toBe(false);
    });

    test("picks a cell size of about 600 000 cells, rounded", () => {
        expect(defaultCellSize({ min: [0, 0, 0], max: [100, 60, 10] })).toBe(0.1);
        expect(defaultCellSize({ min: [0, 0, 0], max: [200, 200, 10] })).toBe(0.3);
    });

    test("faces and drills a block: volumes, no warnings, a mesh coloured by the part", async () => {
        const stock = { min: [0, 0, -20], max: [60, 40, 1] } as const;
        // The part's top: the block faced to z = 0 around a square hole 10.5 deep.
        const part = tops([
            [0, 0, 26, 40, 0],
            [34, 0, 60, 40, 0],
            [26, 0, 34, 16, 0],
            [26, 24, 34, 40, 0],
            [26, 16, 34, 24, -10.5],
        ]);
        const face: ToolpathMove[] = [{ kind: "rapid", to: [-6, 0, 5] }];
        for (let y = 0; y <= 40; y += 8) {
            face.push(
                { kind: "linear", to: [-6, y, 0], feed: 1000 },
                { kind: "linear", to: [66, y, 0], feed: 1000 },
            );
            face.push(
                { kind: "linear", to: [66, y + 4, 0], feed: 1000 },
                { kind: "linear", to: [-6, y + 4, 0], feed: 1000 },
            );
        }
        face.push({ kind: "rapid", to: [-6, 44, 10] });
        const drill: ToolpathMove[] = [
            { kind: "rapid", to: [30, 20, 10] },
            { kind: "drill", at: [30, 20, 0], depth: 10, retract: 2, cycle: "peck", peck: 3, feed: 200 },
        ];
        const progress: number[] = [];
        const result = await simulateToolpaths(
            { toolpaths: [entry(flat10, face, "face"), entry(drill8, drill, "drill")], stock, part },
            { cellSize: 0.25, onProgress: (cut) => progress.push(cut) },
        );
        expect(result.isOk).toBe(true);
        const simulation = result.value;
        expect(simulation.warnings).toEqual([]);
        expect(progress.at(-1)).toBe(simulation.moveCount);
        expect(simulation.cursor).toBe(simulation.moveCount);
        const cone = 4 / Math.tan((59 * Math.PI) / 180);
        const hole = Math.PI * 16 * (10 - cone) + (Math.PI * 16 * cone) / 3;
        const faced = 60 * 40 * 1;
        expect(simulation.initialVolume).toBeCloseTo(60 * 40 * 21, 3);
        expect(Math.abs(simulation.totalRemoved - faced - hole) / hole).toBeLessThan(0.02);
        const comparison = simulation.comparison();
        expect(comparison?.gougeCells).toBe(0);
        // What is left: the square hole's corners around the round one, down to its floor.
        expect(comparison?.maxExcess).toBeCloseTo(10.5, 4);
        const mesh = simulation.mesh();
        expect(mesh.deviation).toHaveLength(mesh.positions.length / 3);
        const onPart = [...(mesh.deviation ?? [])].filter((d) => Math.abs(d) <= 0.01);
        expect(onPart.length).toBeGreaterThan(0);
        // Seeking back to the end of the facing pass shows the stock without the hole.
        const lastFace = simulation.firstMoveOf(1);
        expect(simulation.move(lastFace).id).toBe("drill");
        simulation.seek(lastFace);
        expect(simulation.volume()).toBeCloseTo(simulation.initialVolume - faced, 1);
        simulation.dispose();
        expect(simulation.disposed).toBe(true);
    });

    test("groups warnings into runs and traces them to their toolpath move", async () => {
        const stock = { min: [0, 0, -10], max: [50, 50, 0] } as const;
        const part = boxMesh([0, 0, -10], [50, 50, -3]);
        const moves: ToolpathMove[] = [
            { kind: "rapid", to: [10, 10, 5] },
            // A rapid straight down into the stock…
            { kind: "rapid", to: [10, 10, -1] },
            { kind: "rapid", to: [10, 10, 5] },
            // …and a pass 1 below the part, in three pieces.
            { kind: "rapid", to: [-6, 25, 5] },
            { kind: "linear", to: [-6, 25, -4], feed: 300 },
            { kind: "linear", to: [10, 25, -4], feed: 900 },
            { kind: "linear", to: [30, 25, -4], feed: 900 },
            { kind: "linear", to: [56, 25, -4], feed: 900 },
        ];
        const result = await simulateToolpaths(
            {
                toolpaths: [
                    entry(flat10, moves, "pocket"),
                    entry({ ...flat10, id: "jet", kind: "jet" }, [{ kind: "rapid", to: [0, 0, 0] }], "cut"),
                ],
                stock,
                part,
            },
            { cellSize: 0.5 },
        );
        expect(result.isOk).toBe(true);
        const simulation = result.value;
        const summary = simulation.warnings.map((w) => [
            w.kind,
            w.id,
            w.sourceMove,
            w.lastMove - w.firstMove + 1,
        ]);
        expect(summary).toEqual([
            ["rapidInStock", "pocket", 1, 1],
            ["gouge", "pocket", 5, 3],
            ["unsupported", "cut", 0, 1],
        ]);
        const gouge = simulation.warnings[1];
        expect(gouge.depth).toBeCloseTo(1, 5);
        expect(simulation.move(gouge.firstMove).sourceMove).toBe(5);
        expect(simulation.move(gouge.lastMove).sourceMove).toBe(7);
        expect(gouge.amount).toBeGreaterThan(0);
        simulation.dispose();
    });

    test("a cancelled simulation is an error and an unusable stock box is reported", async () => {
        const controller = new AbortController();
        controller.abort();
        const cancelled = await simulateToolpaths(
            {
                toolpaths: [
                    entry(flat10, [
                        { kind: "rapid", to: [0, 0, 5] },
                        { kind: "linear", to: [9, 9, -1], feed: 100 },
                    ]),
                ],
                stock: { min: [0, 0, -5], max: [10, 10, 0] },
            },
            { signal: controller.signal },
        );
        expect(cancelled.isOk).toBe(false);
        expect(cancelled.error).toContain("cancelled");
        const empty = await simulateToolpaths({ toolpaths: [], stock: { min: [0, 0, 0], max: [0, 10, 10] } });
        expect(empty.isOk).toBe(false);
        expect(empty.error).toContain("empty");
    });

    test("a bar of stock holds material only inside its circle", async () => {
        const result = await simulateToolpaths(
            {
                toolpaths: [],
                stock: { min: [0, 0, -10], max: [20, 20, 0], cylinder: { center: [10, 10], radius: 10 } },
            },
            { cellSize: 0.1 },
        );
        expect(result.isOk).toBe(true);
        expect(Math.abs(result.value.volume() - Math.PI * 100 * 10) / (Math.PI * 1000)).toBeLessThan(0.005);
        result.value.dispose();
    });
});
