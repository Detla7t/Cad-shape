// Part of the Chili3d Project, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

import { Plane } from "@chili3d/core";
import { roundCorner } from "../../src/sketch/commands/sketchTools";
import { curvePoles, evaluateBezier } from "../../src/sketch/curveGeometry";
import { openEndpoints } from "../../src/sketch/editor/sketchDiagnostics";
import { appendSketch, copySketch, sketchClipboard } from "../../src/sketch/sketchClipboard";
import { ConstraintKind, type SketchData } from "../../src/sketch/sketchModel";
import {
    appendEntity,
    copyEntities,
    intersections,
    trimOrSplit,
    trimPreview,
} from "../../src/sketch/sketchOperations";
import { SketchSolver } from "../../src/sketch/solver";
import { appendText } from "../../src/sketch/textGeometry";
import "./setup";

const blank = (): SketchData => ({ entities: [], constraints: [] });
const line = (data: SketchData, p: number[]) => appendEntity(data, "line", p);

describe("sketch editing operations", () => {
    test("trim removes only the clicked interval and preserves unrelated constraints", () => {
        const d = blank(),
            id = line(d, [0, 0, 30, 0]),
            a = line(d, [10, -10, 10, 10]),
            b = line(d, [20, -10, 20, 10]);
        d.constraints.push({
            id: 1,
            kind: ConstraintKind.Vertical,
            refs: [
                { entityId: a, pointIndex: 0 },
                { entityId: a, pointIndex: 1 },
            ],
        });
        trimOrSplit(d, id, [15, 0], "trim");
        expect(d.entities.find((e) => e.id === id)?.params[2]).toBeCloseTo(10, 8);
        const horizontal = d.entities.filter((e) => e.id !== a && e.id !== b);
        expect(horizontal).toHaveLength(2);
        expect(horizontal[1].params[0]).toBeCloseTo(20, 6);
        expect(horizontal[1].params[2]).toBe(30);
        // the unrelated Vertical survives, and each new end is attached to the line that cut it
        expect(d.constraints[0]).toMatchObject({
            kind: ConstraintKind.Vertical,
            refs: [{ entityId: a }, { entityId: a }],
        });
        const attachments = d.constraints.slice(1).map((c) => [c.kind, c.refs[0], c.refs[1].entityId]);
        expect(attachments).toEqual([
            [ConstraintKind.PointOnLine, { entityId: id, pointIndex: 1 }, a],
            [ConstraintKind.PointOnLine, { entityId: horizontal[1].id, pointIndex: 0 }, b],
        ]);
    });
    test("trim a circle across its angle wrap leaves the opposite semicircle", () => {
        const d = blank(),
            id = appendEntity(d, "circle", [0, 0, 10]);
        line(d, [0, -20, 0, 20]);
        trimOrSplit(d, id, [10, 0], "trim");
        const arc = d.entities.find((e) => e.id === id)!;
        expect(arc.type).toBe("arc");
        expect(arc.params[3]).toBeCloseTo(10);
        expect(arc.params[5]).toBeCloseTo(-10);
        expect(d.constraints.some((c) => c.kind === ConstraintKind.PointOnArc)).toBe(true);
    });
    test("split a line adds two pieces without changing its total length", () => {
        const d = blank(),
            id = line(d, [0, 0, 20, 0]);
        trimOrSplit(d, id, [7, 0], "split");
        expect(d.entities.map((e) => e.params)).toEqual([
            [0, 0, 7, 0],
            [7, 0, 20, 0],
        ]);
        expect(new Set(d.entities.map((e) => e.id)).size).toBe(2);
    });
    test("extend chooses the nearest boundary beyond the clicked end", () => {
        const d = blank(),
            id = line(d, [0, 0, 10, 0]);
        line(d, [15, -4, 15, 4]);
        line(d, [30, -4, 30, 4]);
        trimOrSplit(d, id, [9, 0], "extend");
        expect(d.entities.find((e) => e.id === id)?.params).toEqual([0, 0, 15, 0]);
        // the extended end stays on the boundary it reached; the untouched end gains nothing
        expect(d.constraints).toEqual([
            {
                id: 1,
                kind: ConstraintKind.PointOnLine,
                refs: [
                    { entityId: id, pointIndex: 1 },
                    { entityId: 2, pointIndex: 0 },
                    { entityId: 2, pointIndex: 1 },
                ],
            },
        ]);
    });
    test("trim accepts line-circle intersections and removes an unbounded curve", () => {
        const d = blank(),
            id = line(d, [-20, 0, 20, 0]),
            circle = appendEntity(d, "circle", [0, 0, 5]);
        expect(intersections(d.entities[0], d.entities[1])).toHaveLength(2);
        trimOrSplit(d, id, [0, 0], "trim");
        expect(d.entities.filter((e) => e.id !== circle)).toHaveLength(2);
        const single = blank(),
            lonely = line(single, [0, 0, 4, 3]);
        trimOrSplit(single, lonely, [2, 1.5], "trim");
        expect(single.entities).toEqual([]);
    });
    test.each([true, false])("corner operation fillet=%s produces a closed joined corner", (fillet) => {
        const d = blank(),
            a = line(d, [10, 0, 0, 0]),
            b = line(d, [0, 0, 0, 10]);
        roundCorner(d, a, b, 2, fillet);
        expect(d.entities).toHaveLength(3);
        expect(d.entities[0].params[2]).toBeCloseTo(2);
        expect(d.entities[1].params[1]).toBeCloseTo(2);
        const added = d.entities[2];
        expect(added.type).toBe(fillet ? "arc" : "line");
        if (fillet) {
            expect(added.params[0]).toBeCloseTo(2);
            expect(added.params[1]).toBeCloseTo(2);
        }
        expect(openEndpoints(d)).toHaveLength(2);
    });
    test("mirrored arcs preserve sweep and remap endpoint constraints", () => {
        const d = blank(),
            a = appendEntity(d, "arc", [0, 0, 10, 0, 0, 10]);
        const ids = copyEntities(d, [a], (p) => [-p[0], p[1]], 1, true),
            arc = d.entities.find((e) => e.id === ids[0])!;
        expect(arc.params).toEqual([-0, 0, -0, 10, -10, 0]);
        expect(d.constraints.filter((c) => c.refs[0].entityId === ids[0])).toHaveLength(1);
        const solver = new SketchSolver(Plane.XY, d);
        try {
            expect(solver.solve(true).result.startsWith("Ok")).toBe(true);
        } finally {
            solver.dispose();
        }
    });
    test("patterned fixed points move their absolute constraints with the copies", () => {
        const d = blank(),
            id = appendEntity(d, "point", [2, 3]);
        d.constraints.push({
            id: 1,
            kind: ConstraintKind.Fix,
            refs: [{ entityId: id, pointIndex: 0 }],
            datums: [2, 3],
        });
        const [copy] = copyEntities(d, [id], (p) => [p[0] + 10, p[1] + 20]);
        const solver = new SketchSolver(Plane.XY, d);
        try {
            expect(solver.solve(true).result.startsWith("Ok")).toBe(true);
            expect(solver.pointOf({ entityId: copy, pointIndex: 0 })).toEqual([12, 23]);
        } finally {
            solver.dispose();
        }
    });
    test("clipboard remaps entities and internal constraints across sketch planes", () => {
        const d = blank(),
            a = line(d, [0, 0, 10, 0]),
            b = line(d, [10, 0, 10, 10]);
        d.constraints.push({
            id: 1,
            kind: ConstraintKind.P2PCoincident,
            refs: [
                { entityId: a, pointIndex: 1 },
                { entityId: b, pointIndex: 0 },
            ],
        });
        copySketch(d, [a, b]);
        const target = blank();
        line(target, [50, 0, 60, 0]);
        appendSketch(target, sketchClipboard()!);
        expect(target.entities.map((e) => e.id)).toEqual([1, 2, 3]);
        expect(target.constraints[0].refs.map((r) => r.entityId)).toEqual([2, 3]);
        copySketch(d, [a]);
        expect(sketchClipboard()?.constraints).toEqual([]);
    });
    test("Bezier control points and spline interpolation remain editable and round-trip", () => {
        const d = blank(),
            id = appendEntity(d, "bezier", [0, 0, 3, 6, 7, 6, 10, 0]);
        appendEntity(d, "point", [20, 10]);
        const spline = { id: 3, type: "spline" as const, params: [0, 0, 5, 8, 10, 0] },
            poles = curvePoles(spline);
        expect(poles).toEqual([
            [0, 0],
            [5, 8],
            [10, 0],
        ]);
        const solver = new SketchSolver(Plane.XY, d);
        try {
            expect(solver.dofs()).toBe(10);
            solver.setPointPosition({ entityId: id, pointIndex: 3 }, 12, 0);
            expect(solver.toData().entities[0].params.slice(-2)).toEqual([12, 0]);
            const restored = new SketchSolver(Plane.YZ, solver.toData());
            try {
                expect(restored.toData().entities).toEqual(solver.toData().entities);
            } finally {
                restored.dispose();
            }
        } finally {
            solver.dispose();
        }
    });
    test("font outlines have closed contours including holes", () => {
        const d = blank();
        appendText(d, "BO", 12, [5, 7]);
        expect(d.entities.length).toBeGreaterThan(10);
        expect(d.entities.some((e) => e.type === "bezier")).toBe(true);
        expect(openEndpoints(d)).toEqual([]);
    });
    test("reference images survive solver edits and serialization", () => {
        const d = blank();
        d.images = [
            {
                id: "image",
                name: "outline.png",
                dataUrl: "data:image/png;base64,a",
                x: 2,
                y: 3,
                width: 40,
                height: 20,
            },
        ];
        const solver = new SketchSolver(Plane.XY, d);
        try {
            solver.addLine(0, 0, 10, 0);
            expect(solver.toData().images).toEqual(d.images);
        } finally {
            solver.dispose();
        }
    });
});

test("trim preview highlights only the interval that the cut removes", () => {
    const d = blank(),
        circle = appendEntity(d, "circle", [0, 0, 10]);
    line(d, [0, -20, 0, 20]);
    const before = structuredClone(d),
        preview = trimPreview(d, circle, [10, 0])!;
    expect(d).toEqual(before);
    expect(preview.type).toBe("arc");
    expect(preview.params[3]).toBeCloseTo(-10);
    expect(preview.params[5]).toBeCloseTo(10);
    trimOrSplit(d, circle, [10, 0], "trim");
    const kept = d.entities.find((e) => e.id === circle)!;
    expect(kept.params.slice(2, 4)).toEqual(preview.params.slice(4, 6));
    expect(kept.params[4]).toBeCloseTo(preview.params[2]);
    expect(kept.params[5]).toBeCloseTo(preview.params[3]);
});

test("pasting an arc installs its structural constraint only once", () => {
    const source = blank(),
        target = blank();
    appendEntity(source, "arc", [0, 0, 10, 0, 0, 10]);
    appendSketch(target, source);
    expect(target.constraints).toHaveLength(1);
    const solver = new SketchSolver(Plane.XY, target);
    try {
        expect(solver.solve(true).result.startsWith("Ok")).toBe(true);
    } finally {
        solver.dispose();
    }
});

test("trimming a dimensioned circle preserves its radius and fixed center", () => {
    const data = blank(),
        id = appendEntity(data, "circle", [0, 0, 10]);
    line(data, [0, -20, 0, 20]);
    data.constraints.push(
        { id: 1, kind: ConstraintKind.Fix, refs: [{ entityId: id, pointIndex: 0 }], datums: [0, 0] },
        { id: 2, kind: ConstraintKind.Radius, refs: [{ entityId: id, pointIndex: 0 }], datum: 10 },
    );
    trimOrSplit(data, id, [10, 0], "trim");
    expect(data.constraints.filter((c) => c.kind === ConstraintKind.Radius)).toHaveLength(1);
    const solver = new SketchSolver(Plane.XY, data);
    try {
        expect(solver.solve(true).result.startsWith("Ok")).toBe(true);
        expect(solver.entity(id)?.params[3]).toBeCloseTo(10);
    } finally {
        solver.dispose();
    }
});
test("a fillet remains tangent and connected when its radius is edited", () => {
    const data = blank(),
        a = line(data, [0, 0, 40, 0]),
        b = line(data, [40, 0, 40, 30]);
    roundCorner(data, a, b, 5, true);
    const radius = data.constraints.find((c) => c.kind === ConstraintKind.Radius)!;
    expect(radius).not.toBeUndefined();
    const solver = new SketchSolver(Plane.XY, data);
    try {
        solver.setDatumSource(radius.id, 8);
        expect(solver.solve(true).result.startsWith("Ok")).toBe(true);
        const arc = solver.entity(radius.refs[0].entityId)!;
        expect(Math.hypot(arc.params[2] - arc.params[0], arc.params[3] - arc.params[1])).toBeCloseTo(8, 4);
        const end = solver.entity(a)!.params.slice(2);
        expect(
            Math.min(
                Math.hypot(end[0] - arc.params[2], end[1] - arc.params[3]),
                Math.hypot(end[0] - arc.params[4], end[1] - arc.params[5]),
            ),
        ).toBeLessThan(1e-5);
    } finally {
        solver.dispose();
    }
});

test("circle split waits for two chosen points and keeps their exact angular positions", () => {
    const data = blank(),
        id = appendEntity(data, "circle", [0, 0, 10]);
    expect(() => trimOrSplit(data, id, [10, 0], "split")).toThrow(/two points/);
    expect(data.entities[0].type).toBe("circle");
    trimOrSplit(data, id, [10, 0], "split", [0, 10]);
    expect(data.entities).toHaveLength(2);
    expect(data.entities.every((e) => e.type === "arc")).toBe(true);
    expect(data.entities[0].params[2]).toBeCloseTo(10);
    expect(data.entities[0].params[5]).toBeCloseTo(10);
    const solver = new SketchSolver(Plane.XY, data);
    try {
        expect(solver.solve(true).result.startsWith("Ok")).toBe(true);
    } finally {
        solver.dispose();
    }
});
test("Bezier split preserves degree and the exact original shape", () => {
    const data = blank(),
        poles: [number, number][] = [
            [0, 0],
            [3, 8],
            [12, -4],
            [20, 0],
        ],
        id = appendEntity(data, "bezier", poles.flat()),
        t = 0.37;
    trimOrSplit(data, id, evaluateBezier(poles, t), "split");
    expect(data.entities).toHaveLength(2);
    for (const e of data.entities) expect(e.params).toHaveLength(8);
    const [left, right] = data.entities.map(curvePoles);
    for (const u of [0, 0.25, 0.5, 0.75, 1]) {
        const a = evaluateBezier(left, u),
            b = evaluateBezier(poles, u * t),
            c = evaluateBezier(right, u),
            d = evaluateBezier(poles, t + u * (1 - t));
        expect(Math.hypot(a[0] - b[0], a[1] - b[1])).toBeLessThan(1e-6);
        expect(Math.hypot(c[0] - d[0], c[1] - d[1])).toBeLessThan(1e-6);
    }
    expect(data.constraints[0].kind).toBe(ConstraintKind.P2PCoincident);
});
