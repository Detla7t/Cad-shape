// Part of the Chili3d Project, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

import { Plane } from "@chili3d/core";
import { ConstraintKind, entityRadius, originRef, type SketchData } from "../../src/sketch/sketchModel";
import { trimOrSplit, trimPreview } from "../../src/sketch/sketchOperations";
import { SketchSolver } from "../../src/sketch/solver";
import { tangentConstraintFor } from "../../src/sketch/solverEntities";
import "./setup";

const ref = (entityId: number, pointIndex = 0) => ({ entityId, pointIndex });

function dimensionedCircle() {
    const solver = new SketchSolver(Plane.XY);
    const circle = solver.addCircle(0, 0, 10);
    solver.addConstraint({ kind: ConstraintKind.P2PCoincident, refs: [ref(circle), originRef()] });
    const radius = solver.addConstraint({ kind: ConstraintKind.Radius, refs: [ref(circle)], datum: 10 });
    return { solver, circle, radius };
}

test.each([
    false,
    true,
])("trim an attached horizontal chord (fixed height: %s) without adding freedom", (fixedHeight) => {
    const { solver, circle, radius } = dimensionedCircle();
    try {
        const line = solver.addLine(-10, 0, 10, 0);
        solver.addConstraint({ kind: ConstraintKind.Horizontal, refs: [ref(line), ref(line, 1)] });
        for (const pointIndex of [0, 1])
            solver.addConstraint({
                kind: ConstraintKind.PointOnCircle,
                refs: [ref(line, pointIndex), ref(circle)],
            });
        if (fixedHeight)
            solver.addConstraint({
                kind: ConstraintKind.PointOnLine,
                refs: [originRef(), ref(line), ref(line, 1)],
            });
        expect(solver.solve(true).result).toMatch(/^Ok/);
        const freedomBeforeTrim = solver.dofs();
        expect(freedomBeforeTrim).toBe(fixedHeight ? 0 : 1);
        const before = solver.toData();
        const data = structuredClone(before);
        const preview = trimPreview(data, circle, [0, 10])!;
        expect(preview.type).toBe("arc");
        expect(data).toEqual(before);
        trimOrSplit(data, circle, [0, 10], "trim");
        solver.reset(data);
        expect(solver.solve(true).result).toMatch(/^Ok/);
        expect(solver.dofs()).toBe(freedomBeforeTrim);
        expect(solver.entity(circle)!.type).toBe("arc");
        expect(solver.entity(circle)!.params[2]).toBeCloseTo(-10);
        expect(solver.entity(circle)!.params[4]).toBeCloseTo(10);
        expect(
            solver.toData().constraints.filter((c) => c.kind === ConstraintKind.PointOnCircle),
        ).toHaveLength(0);
        solver.setDatum(radius, 15);
        expect(solver.solve(true).result).toMatch(/^Ok/);
        expect(entityRadius(solver.entity(circle)!)).toBeCloseTo(15, 5);
        expect(solver.pointOf(ref(circle))[0]).toBeCloseTo(0);
        expect(solver.pointOf(ref(circle))[1]).toBeCloseTo(0);
        for (const pointIndex of [0, 1])
            expect(Math.hypot(...solver.pointOf(ref(line, pointIndex)))).toBeCloseTo(15, 5);
        for (const [a, b] of [
            [0, 1],
            [1, 2],
        ]) {
            const point = solver.pointOf(ref(line, a));
            const endpoint = solver.pointOf(ref(circle, b));
            expect(point[0]).toBeCloseTo(endpoint[0], 5);
            expect(point[1]).toBeCloseTo(endpoint[1], 5);
        }
        expect(solver.dofs()).toBe(freedomBeforeTrim);
        const saved = solver.toData();
        solver.reset(saved);
        expect(solver.solve(true).result).toMatch(/^Ok/);
        solver.reset(before);
        expect(solver.entity(circle)!.type).toBe("circle");
        expect(solver.toData()).toEqual(before);
    } finally {
        solver.dispose();
    }
});

test("an interior point attachment stays free to slide along a trimmed arc", () => {
    const { solver, circle } = dimensionedCircle();
    try {
        solver.addLine(-20, 0, 20, 0);
        const point = solver.addEntity("point", [0, -10]);
        const attachment = solver.addConstraint({
            kind: ConstraintKind.PointOnCircle,
            refs: [ref(point), ref(circle)],
        });
        const data = solver.toData();
        trimOrSplit(data, circle, [0, 10], "trim");
        const retained = data.constraints.find((c) => c.id === attachment)!;
        expect(retained.kind).toBe(ConstraintKind.PointOnArc);
        expect(retained.refs).toEqual([ref(point), ref(circle), ref(circle, 1)]);
        solver.reset(data);
        expect(solver.solve(true).result).toMatch(/^Ok/);
    } finally {
        solver.dispose();
    }
});

test.each(["line", "circle", "arc"] as const)("trimming preserves a %s tangency with the new arc", (type) => {
    const { solver, circle } = dimensionedCircle();
    try {
        solver.addLine(-20, 0, 20, 0);
        const other =
            type === "line"
                ? solver.addLine(-20, -10, 20, -10)
                : type === "circle"
                  ? solver.addCircle(0, -20, 10)
                  : solver.addArc(0, -20, 10, -20, 0, -10);
        const tangent = solver.addConstraint(tangentConstraintFor("circle", circle, type, other)!);
        expect(solver.solve(true).result).toMatch(/^Ok/);
        const data = solver.toData();
        trimOrSplit(data, circle, [0, 10], "trim");
        solver.reset(data);
        expect(solver.solve(true).result).toMatch(/^Ok/);
        const restored = solver.toData().constraints.find((c) => c.id === tangent)!;
        expect(restored.kind).toBe(
            type === "line"
                ? ConstraintKind.TangentLineArc
                : type === "circle"
                  ? ConstraintKind.TangentCircleArc
                  : ConstraintKind.TangentArcArc,
        );
        expect(restored.refs.some((r) => r.entityId === circle && r.pointIndex === 1)).toBe(true);
    } finally {
        solver.dispose();
    }
});

test("equal radii remain linked after trimming either or both circles", () => {
    const { solver, circle, radius } = dimensionedCircle();
    try {
        const other = solver.addCircle(30, 0, 10);
        solver.addLine(-20, 0, 50, 0);
        const equal = solver.addConstraint({
            kind: ConstraintKind.EqualRadius,
            refs: [ref(circle), ref(other)],
        });
        for (const id of [circle, other]) {
            const data: SketchData = solver.toData();
            trimOrSplit(data, id, [id === circle ? 0 : 30, 10], "trim");
            solver.reset(data);
            expect(solver.solve(true).result).toMatch(/^Ok/);
            solver.setDatum(radius, id === circle ? 12 : 15);
            expect(solver.solve(true).result).toMatch(/^Ok/);
            expect(entityRadius(solver.entity(other)!)).toBeCloseTo(entityRadius(solver.entity(circle)!), 5);
            expect(solver.toData().constraints.find((c) => c.id === equal)?.kind).toBe(
                ConstraintKind.EqualRadius,
            );
        }
    } finally {
        solver.dispose();
    }
});
