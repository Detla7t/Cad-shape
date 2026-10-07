// Part of the Chili3d Project, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

import {
    type CamLoop,
    passOffsets,
    type ToolpathData,
    type ToolpathMove,
    taperOffset,
    wireContourOperation,
} from "../src";
import { distanceToPolyline, type Point2, pointInPolygon } from "../src/geometry2d";
import { fakeContext, operation, rectLoop } from "./_helpers/context";

/**
 * Wire EDM on a 40×20 punch: Ø0.25 wire, 0.03 spark gap, program plane on the table and the
 * UV plane 40 above it. The rough pass runs wire radius + gap (+ skim stock) off the part,
 * skims step in, the tab is cut last after a stop, and a taper puts the upper guide exactly
 * tan(angle) · (uv − program) off every edge.
 */

const part = rectLoop(0, 0, 40, 20);
const loops: CamLoop[] = [{ points: part, closed: true, role: "sketch", z: 0 }];
const wire = { wireDiameter: 0.25, sparkGap: 0.03, maxTaper: 15, programPlaneHeight: 0, uvPlaneHeight: 40 };

function generate(params: Record<string, unknown>, loopSet = loops): ToolpathData {
    const context = fakeContext({
        machine: { kind: "wireEdm", wire },
        tool: { id: "wire", kind: "wire", diameter: 0.25, cutting: { feed: 5 } },
        loops: loopSet,
        stock: { min: [-10, -10, 0], max: [50, 30, 30] },
    });
    const result = wireContourOperation.generate(operation("wireContour", params), context);
    if (!("isOk" in result)) throw new Error("wire EDM is synchronous");
    if (!result.isOk) throw new Error(result.error);
    return result.value;
}

/** XY end points of the cutting moves between two comments (or to the end). */
function section(path: ToolpathData, from: string, to?: string): Point2[] {
    const start = path.moves.findIndex((m) => m.kind === "comment" && m.text.startsWith(from));
    expect(start).toBeGreaterThanOrEqual(0);
    const rest = path.moves.slice(start + 1);
    const end =
        to === undefined ? rest.length : rest.findIndex((m) => m.kind === "comment" && m.text.startsWith(to));
    return rest
        .slice(0, end < 0 ? rest.length : end)
        .filter((m) => m.kind === "linear" || m.kind === "arc" || m.kind === "taper")
        .map(
            (m) => [(m as { to: readonly number[] }).to[0], (m as { to: readonly number[] }).to[1]] as Point2,
        );
}

describe("wire EDM contour", () => {
    test("pass offsets: rough with stock for the skims, skims decreasing to the finish gap", () => {
        const offsets = passOffsets({
            wireRadius: 0.125,
            sparkGap: 0.03,
            skims: 2,
            skimStock: 0.06,
            skimSparkGap: 0.015,
        });
        expect(offsets[0]).toBeCloseTo(0.125 + 0.03 + 0.06, 12);
        expect(offsets[1]).toBeCloseTo(0.125 + 0.015 + 0.03, 12);
        expect(offsets[2]).toBeCloseTo(0.125 + 0.015, 12);
    });

    test("a rough cut runs wire radius plus spark gap outside the punch and leaves the tab for last", () => {
        const path = generate({ skims: 0, tabLength: 3, approachLength: 4 });
        const rough = section(path, "Rough cut", "Stop");
        for (const p of rough) expect(distanceToPolyline(p, part, true)).toBeCloseTo(0.155, 3);
        // The threading point is 4 mm out in the scrap, and the approach goes straight in.
        const rapid = path.moves.find(
            (m): m is Extract<ToolpathMove, { kind: "rapid" }> => m.kind === "rapid",
        );
        expect(rapid).not.toBeUndefined();
        const threading: Point2 = [rapid!.to[0], rapid!.to[1]];
        expect(pointInPolygon(threading, part)).toBe(false);
        expect(distanceToPolyline(threading, part, true)).toBeCloseTo(4.155, 3);
        // Stop, then the separation cut covers the last 3 mm back to the start.
        const stop = path.moves.findIndex((m) => m.kind === "raw" && m.code === "M00");
        expect(stop).toBeGreaterThan(0);
        // From where the rough cut stopped, along the separation cut (arcs by their length).
        const index = path.moves.findIndex((m) => m.kind === "comment" && m.text === "Separation cut");
        let at: readonly number[] = [...rough[rough.length - 1], 0];
        let length = 0;
        for (const move of path.moves.slice(index + 1)) {
            if (move.kind === "linear") length += Math.hypot(move.to[0] - at[0], move.to[1] - at[1]);
            else if (move.kind === "arc") {
                const r = Math.hypot(at[0] - move.center[0], at[1] - move.center[1]);
                const a0 = Math.atan2(at[1] - move.center[1], at[0] - move.center[0]);
                const a1 = Math.atan2(move.to[1] - move.center[1], move.to[0] - move.center[0]);
                let sweep = move.clockwise ? a0 - a1 : a1 - a0;
                while (sweep <= 1e-12) sweep += 2 * Math.PI;
                length += r * sweep;
            } else continue;
            at = move.to;
        }
        expect(length).toBeCloseTo(3, 6);
        // ...ending where the approach reached the contour.
        const approach = path.moves[path.moves.findIndex((m) => m.kind === "rapid") + 1];
        expect(approach.kind).toBe("linear");
        const start = (approach as Extract<ToolpathMove, { kind: "linear" }>).to;
        expect(Math.hypot(at[0] - start[0], at[1] - start[1])).toBeLessThan(1e-6);
    });

    test("skims step in by their offsets and alternate direction", () => {
        const path = generate({ skims: 2, skimStock: 0.06, skimSparkGap: 0.015, tabLength: 3 });
        const rough = section(path, "Rough cut", "Skim 1");
        const skim1 = section(path, "Skim 1", "Skim 2");
        const skim2 = section(path, "Skim 2", "Stop");
        for (const p of rough) expect(distanceToPolyline(p, part, true)).toBeCloseTo(0.215, 3);
        for (const p of skim1) expect(distanceToPolyline(p, part, true)).toBeCloseTo(0.17, 3);
        for (const p of skim2) expect(distanceToPolyline(p, part, true)).toBeCloseTo(0.14, 3);
        // Signed turn of each pass: the first skim runs the other way round.
        const turn = (points: Point2[]) => {
            let area = 0;
            for (let i = 1; i < points.length; i++)
                area += points[i - 1][0] * points[i][1] - points[i][0] * points[i - 1][1];
            return Math.sign(area);
        };
        expect(turn(skim1)).toBe(-turn(rough));
        expect(turn(skim2)).toBe(turn(rough));
    });

    test("a die cuts inside the opening from a start hole inside it", () => {
        const path = generate({ cutType: "die", tabLength: 0, approachLength: 2 });
        const rough = section(path, "Rough cut");
        for (const p of rough) {
            expect(pointInPolygon(p, part)).toBe(true);
            expect(distanceToPolyline(p, part, true)).toBeCloseTo(0.155, 3);
        }
        const rapid = path.moves.find(
            (m): m is Extract<ToolpathMove, { kind: "rapid" }> => m.kind === "rapid",
        );
        expect(pointInPolygon([rapid!.to[0], rapid!.to[1]], part)).toBe(true);
        expect(path.moves.some((m) => m.kind === "raw")).toBe(false);
    });

    test("taper: the upper guide sits exactly tan(angle)·(uv − program) off every edge, on the scrap side", () => {
        const path = generate({ taperAngle: 2, taperLean: "scrap", tabLength: 0 });
        const d = taperOffset(2, 0, 40);
        expect(d).toBeCloseTo(Math.tan((2 * Math.PI) / 180) * 40, 12);
        const tapers = path.moves.filter(
            (m): m is Extract<ToolpathMove, { kind: "taper" }> => m.kind === "taper",
        );
        expect(tapers.length).toBeGreaterThan(20);
        // Skip the approach (from the vertical start hole); check each contour chord.
        const contour = tapers.slice(1);
        let edges = 0;
        for (let i = 1; i < contour.length; i++) {
            const a = contour[i - 1];
            const b = contour[i];
            expect(a.to[2]).toBe(0);
            expect(a.upper[2]).toBe(40);
            const ex = b.to[0] - a.to[0];
            const ey = b.to[1] - a.to[1];
            const length = Math.hypot(ex, ey);
            if (length < 1e-4) continue;
            // Distance of both upper points from the lower chord's line.
            const lineDistance = (u: readonly number[]) =>
                ((u[0] - a.to[0]) * ey - (u[1] - a.to[1]) * ex) / length;
            expect(Math.abs(lineDistance(a.upper))).toBeCloseTo(d, 9);
            expect(Math.abs(lineDistance(b.upper))).toBeCloseTo(d, 9);
            // Upper chord parallel to the lower one.
            expect(Math.sign(lineDistance(a.upper))).toBe(Math.sign(lineDistance(b.upper)));
            // Leaning away from the part: the upper point lies further out.
            expect(distanceToPolyline([a.upper[0], a.upper[1]], part, true)).toBeGreaterThan(
                distanceToPolyline([a.to[0], a.to[1]], part, true),
            );
            edges++;
        }
        expect(edges).toBeGreaterThan(20);
        // Along the bottom edge (y = −0.155) the upper guide is exactly d further down: V = −d.
        const bottom = contour.filter((m) => Math.abs(m.to[1] + 0.155) < 1e-9);
        expect(bottom.length).toBeGreaterThanOrEqual(2);
        for (const m of bottom) expect(m.upper[1] - m.to[1]).toBeCloseTo(-d, 9);
    });

    test("leaning to the part reverses the upper offset", () => {
        const path = generate({ taperAngle: 1.5, taperLean: "part", tabLength: 0 });
        const d = taperOffset(1.5, 0, 40);
        const bottom = path.moves.filter(
            (m): m is Extract<ToolpathMove, { kind: "taper" }> =>
                m.kind === "taper" && Math.abs(m.to[1] + 0.155) < 1e-9,
        );
        expect(bottom.length).toBeGreaterThanOrEqual(2);
        for (const m of bottom) expect(m.upper[1] - m.to[1]).toBeCloseTo(d, 9);
    });

    test("a taper beyond the machine's limit is an error", () => {
        const context = fakeContext({
            machine: { kind: "wireEdm", wire },
            tool: { id: "wire", kind: "wire", diameter: 0.25, cutting: { feed: 5 } },
            loops,
            stock: { min: [-10, -10, 0], max: [50, 30, 30] },
        });
        const result = wireContourOperation.generate(operation("wireContour", { taperAngle: 20 }), context);
        expect("isOk" in result && result.isOk).toBe(false);
    });
});
