// Part of the Chili3d Project, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

import { Plane } from "@chili3d/core";
import { flatPatternOf } from "@chili3d/parametric/src/sheetMetal/flatPattern";
import type { Segment2, SheetMetalModel } from "@chili3d/parametric/src/sheetMetal/model";
import { treatmentElements } from "@chili3d/parametric/src/sheetMetal/treatments";
import {
    bounds,
    type CamLoop,
    distanceToPolyline,
    markOperation,
    type Point2,
    pointInPolygon,
    profileCutOperation,
    signedArea,
    type ToolpathData,
    type ToolpathMove,
    type Vec3,
} from "../src";
import { circleLoop, fakeContext, operation, rectLoop, segmentLoopPoints } from "./_helpers/context";

/**
 * Cutting an HVAC duct wrapper from its sheet metal flat pattern on a plasma table: the
 * blank with a Pittsburgh pocket and an easy edge unfolded, four bend lines, a Ø40 round
 * outlet, a rectangular access opening and a small Ø4 screw hole. Bend lines are etched
 * first, holes cut before the outline, every cut runs exactly half a kerf off the part
 * on the scrap side, and lead-ins start in the scrap (at corners for the outline, from the
 * centre for the small hole).
 */

const KERF = 1.5;
const T = 0.7;

const line = (a: Point2, b: Point2): Segment2 => ({ kind: "line", a, b });

function ductPattern() {
    const blank: Segment2[][] = [
        [
            line([0, 0], [860, 0]),
            line([860, 0], [860, 400]),
            line([860, 400], [0, 400]),
            line([0, 400], [0, 0]),
        ],
        [
            { kind: "arc", a: [80, 200], mid: [100, 220], b: [120, 200] },
            { kind: "arc", a: [120, 200], mid: [100, 180], b: [80, 200] },
        ],
        [
            line([500, 150], [560, 150]),
            line([560, 150], [560, 250]),
            line([560, 250], [500, 250]),
            line([500, 250], [500, 150]),
        ],
        [
            { kind: "arc", a: [298, 300], mid: [300, 302], b: [302, 300] },
            { kind: "arc", a: [302, 300], mid: [300, 298], b: [298, 300] },
        ],
    ];
    const model: SheetMetalModel = {
        plane: Plane.XY,
        thickness: T,
        radius: 1,
        kFactor: 0.5,
        blank,
        bends: [200, 430, 630, 830].map((x) => ({
            a: [x, -10] as Point2,
            b: [x, 410] as Point2,
            angle: 90,
            radius: 1,
        })),
        flanges: [
            {
                kind: "pittsburgh",
                a: [0, 0],
                b: [0, 400],
                elements: treatmentElements({
                    kind: "pittsburgh",
                    direction: 1,
                    length: 7.94,
                    height: 9.5,
                    clearance: 0.35,
                    angle: 0,
                    radius: 1,
                    thickness: T,
                }),
                seamDepth: 7.94,
            },
            {
                kind: "easyEdge",
                a: [860, 0],
                b: [860, 400],
                elements: treatmentElements({
                    kind: "easyEdge",
                    direction: 1,
                    length: 6.35,
                    height: 0,
                    clearance: 0,
                    angle: 90,
                    radius: 1,
                    thickness: T,
                }),
            },
        ],
        crimps: [],
        beads: [],
        flat: true,
    };
    const pattern = flatPatternOf(model);
    expect(pattern.isOk).toBe(true);
    return pattern.value;
}

function patternLoops(): { loops: CamLoop[]; outline: Point2[]; holes: Point2[][]; bends: number } {
    const pattern = ductPattern();
    const outline = segmentLoopPoints(pattern.outline[0] as never);
    const holes = pattern.outline.slice(1).map((loop) => segmentLoopPoints(loop as never));
    const loops: CamLoop[] = [
        { points: outline, closed: true, role: "outline", z: 0 },
        ...holes.map((points) => ({ points, closed: true, role: "hole" as const, z: 0 })),
        ...pattern.bendLines.map((b) => ({ points: [b.a, b.b], closed: false, role: "bend" as const, z: 0 })),
    ];
    return { loops, outline, holes, bends: pattern.bendLines.length };
}

const plasma = {
    kind: "plasma" as const,
    cutting: { kerf: KERF, pierceDelay: 0.5, pierceHeight: 3.8, cutHeight: 1.5 },
};

function cut(params: Record<string, unknown>, loops: CamLoop[], sheet = { w: 1200, h: 600 }): ToolpathData {
    const context = fakeContext({
        machine: plasma,
        tool: { id: "torch", kind: "jet", diameter: KERF, cutting: { feed: 3000 } },
        loops,
        stock: { min: [-50, -50, -T], max: [sheet.w - 50, sheet.h - 50, 0] },
        setupStock: { kind: "sheet", width: sheet.w, height: sheet.h, thickness: T },
    });
    const result = profileCutOperation.generate(operation("profileCut", params), context);
    if (!("isOk" in result)) throw new Error("cutting is synchronous");
    if (!result.isOk) throw new Error(result.error);
    return result.value;
}

interface CutRun {
    readonly mode: "cut" | "mark";
    readonly pierce: Point2;
    readonly pierceDelay?: number;
    /** Cutting points at cut height (lines and arcs sampled), lead-ins included. */
    readonly points: Point2[];
    readonly moves: ToolpathMove[];
}

/** The beam-on stretches of a cutting program. */
function runs(path: ToolpathData, step = 0.2): CutRun[] {
    const out: CutRun[] = [];
    let at: Vec3 | undefined;
    let current:
        | {
              mode: "cut" | "mark";
              pierce: Point2;
              pierceDelay?: number;
              points: Point2[];
              moves: ToolpathMove[];
          }
        | undefined;
    for (const move of path.moves) {
        if (move.kind === "cutterOn") {
            if (current === undefined && at !== undefined) {
                current = {
                    mode: move.mode ?? "cut",
                    pierce: [at[0], at[1]],
                    ...(move.pierceDelay !== undefined ? { pierceDelay: move.pierceDelay } : {}),
                    points: [],
                    moves: [],
                };
            }
            continue;
        }
        if (move.kind === "cutterOff") {
            continue;
        }
        if (move.kind === "rapid" && current !== undefined && move.to[2] > 5) {
            out.push(current);
            current = undefined;
        }
        if (current !== undefined && at !== undefined && (move.kind === "linear" || move.kind === "arc")) {
            current.moves.push(move);
            const from = at;
            const to = move.to;
            if (move.kind === "linear") {
                const n = Math.max(1, Math.ceil(Math.hypot(to[0] - from[0], to[1] - from[1]) / step));
                for (let i = 1; i <= n; i++)
                    current.points.push([
                        from[0] + ((to[0] - from[0]) * i) / n,
                        from[1] + ((to[1] - from[1]) * i) / n,
                    ]);
            } else {
                const c = move.center;
                const r = Math.hypot(from[0] - c[0], from[1] - c[1]);
                const a0 = Math.atan2(from[1] - c[1], from[0] - c[0]);
                const a1 = Math.atan2(to[1] - c[1], to[0] - c[0]);
                let sweep = move.clockwise ? a0 - a1 : a1 - a0;
                while (sweep <= 1e-12) sweep += 2 * Math.PI;
                const n = Math.max(2, Math.ceil((sweep * r) / step));
                for (let i = 1; i <= n; i++) {
                    const a = a0 + ((move.clockwise ? -1 : 1) * sweep * i) / n;
                    current.points.push([c[0] + r * Math.cos(a), c[1] + r * Math.sin(a)]);
                }
            }
        }
        if ("to" in move) at = (move as { to: Vec3 }).to;
    }
    if (current !== undefined) out.push(current);
    return out;
}

describe("profile cutting a duct flat pattern", () => {
    const { loops, outline, holes, bends } = patternLoops();

    test("the flat pattern has the unfolded seams, four holes' worth of loops and seven bend lines", () => {
        const box = bounds(outline);
        expect(box.min[0]).toBeLessThan(-7.9);
        expect(box.max[0]).toBeGreaterThan(866);
        expect(holes).toHaveLength(3);
        expect(bends).toBe(4 + 2 + 1);
    });

    test("bend lines are etched first, holes are cut before the outline", () => {
        const all = runs(cut({}, loops));
        const marks = all.filter((r) => r.mode === "mark");
        const cuts = all.filter((r) => r.mode === "cut");
        expect(marks).toHaveLength(bends);
        expect(cuts).toHaveLength(4);
        // Marks before every cut.
        expect(all.findIndex((r) => r.mode === "cut")).toBe(bends);
        // The outline (the run reaching furthest left) comes last.
        const outlineRun = cuts[cuts.length - 1];
        expect(Math.min(...outlineRun.points.map((p) => p[0]))).toBeLessThan(-7);
        for (const hole of cuts.slice(0, -1))
            expect(Math.min(...hole.points.map((p) => p[0]))).toBeGreaterThan(70);
        // Every cut pierces after the machine's pierce delay; marks do not pierce.
        for (const run of cuts) expect(run.pierceDelay).toBe(0.5);
        for (const run of marks) expect(run.pierceDelay).toBeUndefined();
    });

    test("skipping marks leaves only the cuts", () => {
        const all = runs(cut({ marks: "skip" }, loops));
        expect(all.every((r) => r.mode === "cut")).toBe(true);
        expect(all).toHaveLength(4);
    });

    test("every cut runs exactly half a kerf off the part on the scrap side", () => {
        const cuts = runs(cut({}, loops)).filter((r) => r.mode === "cut");
        const loopsOfPart = [outline, ...holes];
        const half = KERF / 2;
        for (const run of cuts) {
            let onPath = 0;
            for (const p of run.points) {
                const d = Math.min(...loopsOfPart.map((loop) => distanceToPolyline(p, loop, true)));
                // Never into the material: outside the outline or inside a hole, at least half a kerf off.
                const inMaterial = pointInPolygon(p, outline) && !holes.some((h) => pointInPolygon(p, h));
                expect(inMaterial).toBe(false);
                // Within 2 µm: the loops themselves are arcs flattened to 1 µm chords.
                expect(d).toBeGreaterThanOrEqual(half - 2e-3);
                if (Math.abs(d - half) < 2e-3) onPath++;
            }
            // Leads aside, the whole run is the kerf path.
            expect(onPath / run.points.length).toBeGreaterThan(0.8);
        }
        // The outline's kerf path (no leads): the perimeter plus a half-kerf round per corner.
        const bare = runs(cut({ leadIn: 0, leadOut: 0, marks: "skip" }, loops)).filter(
            (r) => r.mode === "cut",
        );
        const outlineRun = bare[bare.length - 1];
        const box = bounds(outline);
        const perimeter = 2 * (box.max[0] - box.min[0] + box.max[1] - box.min[1]);
        let length = 0;
        let at: readonly number[] = [outlineRun.pierce[0], outlineRun.pierce[1]];
        for (const move of outlineRun.moves) {
            if (move.kind === "arc") {
                const r = Math.hypot(at[0] - move.center[0], at[1] - move.center[1]);
                const a0 = Math.atan2(at[1] - move.center[1], at[0] - move.center[0]);
                const a1 = Math.atan2(move.to[1] - move.center[1], move.to[0] - move.center[0]);
                let sweep = move.clockwise ? a0 - a1 : a1 - a0;
                while (sweep <= 1e-12) sweep += 2 * Math.PI;
                length += r * sweep;
            } else if (move.kind === "linear") {
                length += Math.hypot(move.to[0] - at[0], move.to[1] - at[1]);
            }
            if (move.kind === "arc" || move.kind === "linear") at = move.to;
        }
        expect(length).toBeCloseTo(perimeter + Math.PI * KERF, 2);
    });

    test("lead-ins start in the scrap: outline at a corner, holes inside, the small hole at its centre", () => {
        const cuts = runs(cut({ leadIn: 5 }, loops)).filter((r) => r.mode === "cut");
        const outlineRun = cuts[cuts.length - 1];
        expect(pointInPolygon(outlineRun.pierce, outline)).toBe(false);
        // At a corner, on its bisector: half a kerf plus the lead from the corner point.
        const corner = outline.reduce((best, p) =>
            Math.hypot(p[0] - outlineRun.pierce[0], p[1] - outlineRun.pierce[1]) <
            Math.hypot(best[0] - outlineRun.pierce[0], best[1] - outlineRun.pierce[1])
                ? p
                : best,
        );
        expect(Math.hypot(corner[0] - outlineRun.pierce[0], corner[1] - outlineRun.pierce[1])).toBeCloseTo(
            KERF / 2 + 5,
            3,
        );
        for (const run of cuts.slice(0, -1)) {
            const hole = holes.find((h) => pointInPolygon(run.pierce, h));
            expect(hole).not.toBeUndefined();
        }
        // The Ø4 hole is small: pierced at its centre.
        const small = cuts.find((r) => Math.hypot(r.pierce[0] - 300, r.pierce[1] - 300) < 3);
        expect(small).not.toBeUndefined();
        expect(small!.pierce[0]).toBeCloseTo(300, 3);
        expect(small!.pierce[1]).toBeCloseTo(300, 3);
        // ...and cut slower (60 % of the feed).
        const feeds = small!.moves
            .filter((m) => m.kind === "linear" || m.kind === "arc")
            .map((m) => ("feed" in m ? m.feed : 0));
        expect(Math.max(...feeds)).toBeCloseTo(1800, 6);
    });

    test("the outline runs clockwise and holes counter-clockwise (part on the right)", () => {
        const cuts = runs(cut({ leadIn: 0, leadOut: 0 }, loops)).filter((r) => r.mode === "cut");
        expect(signedArea(cuts[cuts.length - 1].points)).toBeLessThan(0);
        const rect = cuts.find((r) => r.points.every((p) => p[0] > 490 && p[0] < 570));
        expect(rect).not.toBeUndefined();
        expect(signedArea(rect!.points)).toBeGreaterThan(0);
    });

    test("three nested copies fit the sheet without overlapping", () => {
        const all = runs(
            cut(
                {
                    nest: true,
                    copies: 3,
                    partSpacing: 10,
                    sheetMargin: 10,
                    marks: "skip",
                    leadIn: 0,
                    leadOut: 0,
                },
                loops,
                { w: 1000, h: 1400 },
            ),
        );
        const outlines = all.filter(
            (r) => Math.max(...r.points.map((p) => p[0])) - Math.min(...r.points.map((p) => p[0])) > 380,
        );
        expect(outlines).toHaveLength(3);
        const boxes = outlines.map((r) => bounds(r.points));
        for (const box of boxes) {
            expect(box.min[0]).toBeGreaterThanOrEqual(-50 + 10 - 1e-6);
            expect(box.min[1]).toBeGreaterThanOrEqual(-50 + 10 - 1e-6);
            expect(box.max[0]).toBeLessThanOrEqual(950 - 10 + 1e-6);
            expect(box.max[1]).toBeLessThanOrEqual(1350 - 10 + 1e-6);
        }
        for (let i = 0; i < boxes.length; i++) {
            for (let j = i + 1; j < boxes.length; j++) {
                const a = boxes[i];
                const b = boxes[j];
                const apart =
                    a.max[0] < b.min[0] || b.max[0] < a.min[0] || a.max[1] < b.min[1] || b.max[1] < a.min[1];
                expect(apart).toBe(true);
            }
        }
        // Each copy keeps its holes inside its outline (12 holes in all).
        expect(all).toHaveLength(12);
        for (const run of all.filter((r) => !outlines.includes(r))) {
            expect(outlines.filter((o) => pointInPolygon(run.pierce, o.points))).toHaveLength(1);
        }
    });
});

describe("cutting details", () => {
    const square: CamLoop[] = [{ points: rectLoop(0, 0, 100, 60), closed: true, role: "outline", z: 0 }];

    test("micro-joints leave bridges of their width (plus the kerf) uncut", () => {
        const path = cut({ tabCount: 2, tabWidth: 1, leadIn: 3, leadOut: 0 }, square);
        const offs = path.moves.filter((m) => m.kind === "cutterOff").length;
        const ons = path.moves.filter((m) => m.kind === "cutterOn").length;
        expect(ons).toBe(3);
        expect(offs).toBe(3);
        // Each gap is traversed with the beam off.
        let on = false;
        let at: Vec3 | undefined;
        const gaps: number[] = [];
        for (const move of path.moves) {
            if (move.kind === "cutterOn") on = true;
            if (move.kind === "cutterOff") on = false;
            if (
                move.kind === "rapid" &&
                !on &&
                at !== undefined &&
                Math.abs(move.to[2] - at[2]) < 1e-9 &&
                at[2] < 2
            ) {
                gaps.push(Math.hypot(move.to[0] - at[0], move.to[1] - at[1]));
            }
            if ("to" in move) at = (move as { to: Vec3 }).to;
        }
        expect(gaps).toHaveLength(2);
        for (const gap of gaps) expect(gap).toBeCloseTo(1 + KERF, 6);
    });

    test("waterjet corner slowdown lowers the feed near sharp corners", () => {
        const context = fakeContext({
            machine: { kind: "waterjet", cutting: { kerf: 0.8 } },
            tool: { id: "jet", kind: "jet", diameter: 0.8, cutting: { feed: 1000 } },
            loops: [{ points: rectLoop(0, 0, 50, 50), closed: true, role: "outline", z: 0 }],
            stock: { min: [-20, -20, -10], max: [100, 100, 0] },
        });
        const result = profileCutOperation.generate(
            operation("profileCut", {
                cornerMode: "slowdown",
                cornerFeed: 40,
                cornerDistance: 3,
                leadIn: 2,
                leadOut: 0,
            }),
            context,
        );
        expect("isOk" in result && result.isOk).toBe(true);
        if (!("isOk" in result) || !result.isOk) return;
        const feeds = result.value.moves
            .filter((m) => m.kind === "linear" || m.kind === "arc")
            .map((m) => ("feed" in m ? m.feed : 0));
        expect(feeds.filter((f) => Math.abs(f - 400) < 1e-9).length).toBeGreaterThanOrEqual(8);
        expect(feeds.some((f) => Math.abs(f - 1000) < 1e-9)).toBe(true);
    });

    test("laser corner loops turn outside corners in the scrap", () => {
        const context = fakeContext({
            machine: { kind: "laser", cutting: { kerf: 0.2 } },
            tool: { id: "beam", kind: "jet", diameter: 0.2, cutting: { feed: 2000 } },
            loops: [{ points: rectLoop(0, 0, 40, 20), closed: true, role: "outline", z: 0 }],
            stock: { min: [-20, -20, -2], max: [100, 100, 0] },
        });
        const result = profileCutOperation.generate(
            operation("profileCut", { cornerMode: "loop", loopRadius: 1, leadIn: 2, leadOut: 0 }),
            context,
        );
        expect("isOk" in result && result.isOk).toBe(true);
        if (!("isOk" in result) || !result.isOk) return;
        const loopArcs = result.value.moves.filter(
            (m): m is Extract<ToolpathMove, { kind: "arc" }> =>
                m.kind === "arc" &&
                Math.abs(Math.hypot(m.to[0] - m.center[0], m.to[1] - m.center[1]) - 1) < 1e-6,
        );
        // The lead-in enters at one corner; the other three get a loop, each as two arcs.
        expect(loopArcs).toHaveLength(6);
        const part = rectLoop(0, 0, 40, 20);
        const all = runs(result.value).flatMap((r) => r.points);
        for (const p of all) expect(pointInPolygon(p, part)).toBe(false);
    });

    test("a separate marking operation etches the bend lines only", () => {
        const { loops } = patternLoops();
        const context = fakeContext({
            machine: plasma,
            tool: { id: "torch", kind: "jet", diameter: KERF, cutting: { feed: 3000 } },
            loops,
            stock: { min: [-50, -50, -T], max: [1150, 550, 0] },
        });
        const result = markOperation.generate(operation("mark", {}), context);
        expect("isOk" in result && result.isOk).toBe(true);
        if (!("isOk" in result) || !result.isOk) return;
        const ons = result.value.moves.filter((m) => m.kind === "cutterOn");
        expect(ons).toHaveLength(7);
        expect(ons.every((m) => m.kind === "cutterOn" && m.mode === "mark")).toBe(true);
    });

    test("holes smaller than the kerf are skipped with a note", () => {
        const loopsWithTiny: CamLoop[] = [
            ...square,
            { points: circleLoop([50, 30], 0.5), closed: true, role: "hole", z: 0 },
        ];
        const path = cut({}, loopsWithTiny);
        expect(path.moves.some((m) => m.kind === "comment" && m.text.includes("smaller than the kerf"))).toBe(
            true,
        );
        expect(runs(path)).toHaveLength(1);
    });

    test("a part inside another part's hole is cut before that hole", () => {
        const nested: CamLoop[] = [
            { points: rectLoop(0, 0, 200, 200), closed: true, role: "sketch", z: 0 },
            { points: rectLoop(50, 50, 150, 150), closed: true, role: "sketch", z: 0 },
            { points: rectLoop(80, 80, 120, 120), closed: true, role: "sketch", z: 0 },
        ];
        const cuts = runs(cut({ leadIn: 3 }, nested)).filter((r) => r.mode === "cut");
        expect(cuts).toHaveLength(3);
        const size = (r: CutRun) => {
            const box = bounds(r.points);
            return box.max[0] - box.min[0];
        };
        // Inner part (40 + kerf) first, then the host's hole (100 - kerf), then the host outline.
        expect(size(cuts[0])).toBeLessThan(45);
        expect(size(cuts[1])).toBeGreaterThan(95);
        expect(size(cuts[1])).toBeLessThan(105);
        expect(size(cuts[2])).toBeGreaterThan(200);
        // The inner part is an outline (clockwise), the hole runs counter-clockwise.
        expect(signedArea(cuts[0].points)).toBeLessThan(0);
        expect(signedArea(cuts[1].points)).toBeGreaterThan(0);
    });
});
