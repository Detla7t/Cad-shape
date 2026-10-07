// Part of the Chili3d Project, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

import {
    type CamLoop,
    contourOperation,
    distanceToLoops,
    distanceToPolyline,
    type Point2,
    pointInLoops,
    signedArea,
    type ToolpathData,
    type ToolpathMove,
} from "../src";
import { cuttingSamples, fakeContext, millTool, operation, rectLoop } from "./_helpers/context";

/**
 * A 50×30 rectangle contoured outside, 6 deep in two 3 mm steps with a Ø6 end mill:
 * the path runs exactly one radius off the profile, enters on a tangent arc from the free
 * side in the middle of a long edge, and four 4 mm tabs, 2 mm high, lift the last level.
 */

const part = rectLoop(0, 0, 50, 30);
const loops: CamLoop[] = [{ points: part, closed: true, role: "sketch", z: 0 }];

function generate(params: Record<string, unknown>, loopSet = loops): ToolpathData {
    const context = fakeContext({
        tool: millTool(6),
        loops: loopSet,
        stock: { min: [-10, -10, -10], max: [60, 40, 0] },
    });
    const result = contourOperation.generate(operation("contour2d", params), context);
    if (!("isOk" in result)) throw new Error("contour generation is synchronous");
    if (!result.isOk) throw new Error(result.error);
    return result.value;
}

const base = {
    side: "outside",
    bottomFrom: "depth",
    depth: 6,
    stepdown: 3,
    leadIn: "arc",
    leadOut: "arc",
    leadRadius: 3,
};

/** Arc-length position of a point along the rounded-rectangle tool path, from its start. */
function cutting(path: ToolpathData) {
    return cuttingSamples(path, 0.1).filter((s) => s.z < -1e-6);
}

describe("2D contour", () => {
    test("runs one tool radius outside the profile at each level", () => {
        const path = generate({ ...base, tabCount: 0 });
        const samples = cutting(path);
        const onPath = samples.filter((s) => Math.abs(distanceToLoops(s.p, [part]) - 3) < 1e-3);
        expect(onPath.length).toBeGreaterThan(samples.length * 0.8);
        for (const s of samples) {
            expect(pointInLoops(s.p, [part])).toBe(false);
            expect(distanceToLoops(s.p, [part])).toBeGreaterThanOrEqual(3 - 1e-3);
        }
        const levels = [...new Set(onPath.map((s) => Math.round(s.z * 1e6) / 1e6))].sort((a, b) => a - b);
        expect(levels).toEqual([-6, -3]);
        // Corners come out as G2/G3 arcs of the tool radius.
        const arcs = path.moves.filter((m): m is Extract<ToolpathMove, { kind: "arc" }> => m.kind === "arc");
        expect(
            arcs.some((a) => Math.abs(Math.hypot(a.to[0] - a.center[0], a.to[1] - a.center[1]) - 3) < 1e-3),
        ).toBe(true);
    });

    test("climb milling an outside contour runs clockwise", () => {
        const path = generate({ ...base, leadIn: "none", leadOut: "none" });
        const level = cutting(path)
            .filter((s) => Math.abs(s.z + 3) < 1e-9)
            .map((s) => s.p);
        expect(signedArea(level)).toBeLessThan(0);
        const conventional = generate({
            ...base,
            leadIn: "none",
            leadOut: "none",
            direction: "conventional",
        });
        const other = cutting(conventional)
            .filter((s) => Math.abs(s.z + 3) < 1e-9)
            .map((s) => s.p);
        expect(signedArea(other)).toBeGreaterThan(0);
    });

    test("leads in on a tangent arc from outside, in the middle of a long edge", () => {
        const path = generate({ ...base });
        const plunge = path.moves.findIndex((m) => m.kind === "linear" && m.to[2] === -3);
        expect(plunge).toBeGreaterThan(0);
        const entry = path.moves[plunge] as Extract<ToolpathMove, { kind: "linear" }>;
        const lead = path.moves[plunge + 1];
        expect(lead.kind).toBe("arc");
        if (lead.kind !== "arc") return;
        // The arc ends on the path at the middle of a 50 mm edge, tangent to it.
        expect(lead.to[0]).toBeCloseTo(25, 6);
        expect(Math.abs(lead.to[1] - 15)).toBeCloseTo(18, 6);
        expect(Math.hypot(lead.to[0] - lead.center[0], lead.to[1] - lead.center[1])).toBeCloseTo(3, 6);
        expect(lead.center[0]).toBeCloseTo(25, 6);
        // It starts outside the cut, 3 + 3 from the edge, a radius back along it.
        const start: Point2 = [entry.to[0], entry.to[1]];
        expect(distanceToLoops(start, [part])).toBeCloseTo(6, 6);
        expect(Math.abs(start[0] - 25)).toBeCloseTo(3, 6);
    });

    test("tabs lift the last level over four evenly spaced stretches", () => {
        const path = generate({
            ...base,
            tabCount: 4,
            tabWidth: 4,
            tabHeight: 2,
            leadIn: "none",
            leadOut: "none",
        });
        const total = 2 * (56 + 36) - 8 * 3 + 2 * Math.PI * 3;
        // Walk the last level (from the plunge to -6) and measure lifted stretches by length.
        const moves = path.moves;
        const plunge = moves.findIndex((m) => m.kind === "linear" && m.to[2] === -6);
        expect(plunge).toBeGreaterThan(0);
        const level = cuttingSamples({ ...path, moves: moves.slice(plunge) }, 0.01).filter(
            (s) => Math.abs(distanceToLoops(s.p, [part]) - 3) < 1e-3,
        );
        const zs = new Set(level.map((s) => Math.round(s.z * 1e6) / 1e6));
        expect([...zs].sort((a, b) => a - b)).toEqual([-6, -4]);
        // Lifted runs along the path.
        const runs: { start: number; length: number }[] = [];
        let s = 0;
        for (let i = 1; i < level.length; i++) {
            const step = Math.hypot(level[i].p[0] - level[i - 1].p[0], level[i].p[1] - level[i - 1].p[1]);
            if (step > 0.5) continue;
            if (Math.abs(level[i].z + 4) < 1e-9 && Math.abs(level[i - 1].z + 4) < 1e-9) {
                const last = runs[runs.length - 1];
                if (last !== undefined && Math.abs(last.start + last.length - s) < 1e-6) last.length += step;
                else runs.push({ start: s, length: step });
            }
            s += step;
        }
        expect(runs).toHaveLength(4);
        for (const run of runs) expect(run.length).toBeCloseTo(4 + 6, 1);
        // Centres a quarter of the contour apart.
        const centers = runs.map((run) => run.start + run.length / 2);
        for (let i = 1; i < centers.length; i++)
            expect(centers[i] - centers[i - 1]).toBeCloseTo(total / 4, 1);
        // The level above the tab top (-3) is not lifted.
        const upper = cuttingSamples({ ...path, moves: moves.slice(0, plunge) }, 0.05).filter(
            (x) => x.z < -1e-6,
        );
        expect(
            upper.every((x) => Math.abs(x.z + 3) < 1e-9 || Math.abs(distanceToLoops(x.p, [part]) - 3) > 1e-3),
        ).toBe(true);
    });

    test("an inside contour stays inside and climbs counter-clockwise", () => {
        const path = generate({ ...base, side: "inside", leadIn: "none", leadOut: "none" });
        const level = cutting(path).filter((s) => Math.abs(s.z + 3) < 1e-9);
        for (const s of level) {
            expect(pointInLoops(s.p, [part])).toBe(true);
            expect(distanceToLoops(s.p, [part])).toBeCloseTo(3, 3);
        }
        expect(signedArea(level.map((s) => s.p))).toBeGreaterThan(0);
    });

    test("finishing pass at the radius after roughing with finishing stock", () => {
        const path = generate({
            ...base,
            finishPass: true,
            finishStock: 0.4,
            stockToLeave: 0.1,
            leadIn: "none",
            leadOut: "none",
        });
        const index = path.moves.findIndex((m) => m.kind === "comment" && m.text === "Finishing pass");
        const rough = cutting({ ...path, moves: path.moves.slice(0, index) });
        const finish = cutting({ ...path, moves: path.moves.slice(index) }).filter(
            (s) => Math.abs(s.z + 6) < 1e-9,
        );
        expect(Math.min(...rough.map((s) => distanceToLoops(s.p, [part])))).toBeCloseTo(3.5, 3);
        expect(Math.min(...finish.map((s) => distanceToLoops(s.p, [part])))).toBeCloseTo(3.1, 3);
    });

    test("ramp entry descends along the contour no steeper than the ramp angle", () => {
        const path = generate({ ...base, entry: "ramp", rampAngle: 2, leadIn: "none", leadOut: "none" });
        const samples = cuttingSamples(path, 0.05);
        let steepest = 0;
        for (let i = 1; i < samples.length; i++) {
            const run = Math.hypot(
                samples[i].p[0] - samples[i - 1].p[0],
                samples[i].p[1] - samples[i - 1].p[1],
            );
            const drop = samples[i - 1].z - samples[i].z;
            if (run > 1e-6 && drop > 1e-9 && samples[i].z < 0) steepest = Math.max(steepest, drop / run);
        }
        expect(steepest).toBeGreaterThan(0);
        expect(steepest).toBeLessThanOrEqual(Math.tan((2 * Math.PI) / 180) + 1e-6);
        expect(Math.min(...samples.map((s) => s.z))).toBeCloseTo(-6, 9);
    });

    test("control compensation cuts on the profile and notes G41", () => {
        const path = generate({ ...base, compensation: "control", leadIn: "line", leadRadius: 5 });
        expect(path.moves.some((m) => m.kind === "comment" && m.text.includes("G41"))).toBe(true);
        const level = cutting(path).filter(
            (s) => Math.abs(s.z + 3) < 1e-9 && distanceToLoops(s.p, [part]) < 1e-6,
        );
        expect(level.length).toBeGreaterThan(100);
    });

    test("the profile's own level as the floor needs a lower profile", () => {
        const context = fakeContext({
            tool: millTool(6),
            loops,
            stock: { min: [-10, -10, -10], max: [60, 40, 0] },
        });
        const result = contourOperation.generate(operation("contour2d", { bottomFrom: "geometry" }), context);
        expect("isOk" in result && result.isOk).toBe(false);
        const lowered = generate({ ...base, bottomFrom: "geometry" }, [{ ...loops[0], z: -4 }]);
        expect(Math.min(...cutting(lowered).map((s) => s.z))).toBeCloseTo(-4, 9);
    });

    test("an open chain is offset to the chosen side, its corners rounded on the outside", () => {
        const chain: Point2[] = [
            [0, 0],
            [30, 0],
            [30, 20],
        ];
        const path = generate({ ...base, chainSide: "right", leadIn: "none", leadOut: "none" }, [
            { points: chain, closed: false, role: "sketch", z: 0 },
        ]);
        const samples = cutting(path).filter((s) => Math.abs(s.z + 6) < 1e-9);
        expect(samples.length).toBeGreaterThan(50);
        for (const s of samples) {
            expect(distanceToPolyline(s.p, chain, false)).toBeCloseTo(3, 3);
            // Right of the chain going (0,0)→(30,0)→(30,20): below the first leg, right of the second.
            expect(s.p[1] < 0 || s.p[0] > 30).toBe(true);
        }
        // The outside corner comes out as a G2/G3 of the tool radius around (30, 0).
        const corner = path.moves.find(
            (m): m is Extract<ToolpathMove, { kind: "arc" }> =>
                m.kind === "arc" && Math.hypot(m.center[0] - 30, m.center[1]) < 1e-3,
        );
        expect(corner).not.toBeUndefined();
    });

    test("contouring holes too: the outline from outside, the hole from inside", () => {
        const hole = rectLoop(20, 10, 30, 20).reverse();
        const path = generate({ ...base, includeHoles: true, leadIn: "none", leadOut: "none" }, [
            { points: part, closed: true, role: "outline", z: 0 },
            { points: hole, closed: true, role: "hole", z: 0 },
        ]);
        const samples = cutting(path).filter((s) => Math.abs(s.z + 6) < 1e-9);
        const inHole = samples.filter((s) => pointInLoops(s.p, [hole]));
        const outside = samples.filter((s) => !pointInLoops(s.p, [part]));
        expect(inHole.length).toBeGreaterThan(20);
        expect(outside.length).toBeGreaterThan(100);
        expect(inHole.length + outside.length).toBe(samples.length);
        for (const s of inHole) expect(distanceToLoops(s.p, [hole])).toBeCloseTo(3, 3);
        for (const s of outside) expect(distanceToLoops(s.p, [part])).toBeCloseTo(3, 3);
    });
});
