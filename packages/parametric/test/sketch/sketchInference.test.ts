// Part of the Chili3d Project, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

import { ObjectSnapTypes, Plane } from "@chili3d/core";
import {
    applyAutoConstraints,
    applyDragAutoConstraints,
    dragSnapPosition,
    snapPosition,
} from "../../src/sketch/autoConstraints";
import {
    appendSketchPrimitive,
    constrainSketchPrimitive,
    primitivePreview,
} from "../../src/sketch/commands/sketchTools";
import {
    axisLineRefs,
    ConstraintKind,
    originRef,
    SKETCH_Y_AXIS_ID,
    type SketchData,
} from "../../src/sketch/sketchModel";
import { SketchSolver } from "../../src/sketch/solver";
import "./setup";

function circleFixture() {
    const solver = new SketchSolver(Plane.XY);
    const circle = solver.addCircle(0, 0, 20);
    solver.addConstraint({
        kind: ConstraintKind.P2PCoincident,
        refs: [{ entityId: circle, pointIndex: 0 }, originRef()],
    });
    const radius = solver.addConstraint({
        kind: ConstraintKind.Radius,
        refs: [{ entityId: circle, pointIndex: 0 }],
        datums: [20],
    });
    expect(solver.solve(true).result).toMatch(/^Ok/);
    return { solver, circle, radius };
}

test("a vertical line from the origin snaps to the circle rim and follows a radius edit", () => {
    const { solver, circle, radius } = circleFixture();
    try {
        const options = { pointTolerance: 0.8 };
        const hit = snapPosition(solver, [0.2, 19.6], options, (p) => ({
            type: "line",
            params: [0, 0, ...p],
        }));
        expect(hit.snap?.kind).toBe("circle");
        expect(hit.position).toEqual([0, 20]);
        const line = solver.addLine(0, 0, ...hit.position);
        const added = applyAutoConstraints(solver, line, options);
        expect(added.map((c) => c.kind)).toContain(ConstraintKind.Vertical);
        expect(added).toContainEqual({
            kind: ConstraintKind.PointOnCircle,
            refs: [
                { entityId: line, pointIndex: 1 },
                { entityId: circle, pointIndex: 0 },
            ],
        });
        expect(solver.solve(true).result).toMatch(/^Ok/);
        solver.setDatum(radius, 30);
        expect(solver.solve(true).result).toMatch(/^Ok/);
        expect(solver.pointOf({ entityId: line, pointIndex: 1 })[1]).toBeCloseTo(30, 6);
        expect(solver.pointOf({ entityId: line, pointIndex: 1 })[0]).toBeCloseTo(0, 6);
    } finally {
        solver.dispose();
    }
});

test.each([
    false,
    true,
])("dragging a vertical endpoint attaches to the rim even with a prior axis incidence (%s)", (axis) => {
    const { solver, circle } = circleFixture();
    try {
        const line = solver.addLine(0, 0, 0, 10);
        const start = { entityId: line, pointIndex: 0 },
            end = { entityId: line, pointIndex: 1 };
        solver.addConstraint({ kind: ConstraintKind.P2PCoincident, refs: [start, originRef()] });
        solver.addConstraint(
            axis
                ? { kind: ConstraintKind.PointOnLine, refs: [end, ...axisLineRefs(SKETCH_Y_AXIS_ID)] }
                : { kind: ConstraintKind.Vertical, refs: [start, end] },
        );
        const hit = dragSnapPosition(solver, end, [0.2, 19.5], { pointTolerance: 0.8 });
        expect(hit.snap?.kind).toBe("circle");
        expect(hit.position).toEqual([0, 20]);
        solver.setPointPosition(end, ...hit.position);
        const added = applyDragAutoConstraints(solver, end, { pointTolerance: 0.8 });
        expect(added).toContainEqual({
            kind: ConstraintKind.PointOnCircle,
            refs: [end, { entityId: circle, pointIndex: 0 }],
        });
        expect(solver.solve(true).result).toMatch(/^Ok/);
        expect(solver.pointOf(end)[1]).toBeCloseTo(20, 6);
    } finally {
        solver.dispose();
    }
});

test.each([0.01, 0.1, 1, 10])("the rim snap aperture stays eight screen pixels at %s mm/pixel", (scale) => {
    const solver = new SketchSolver(Plane.XY);
    try {
        solver.addCircle(0, 0, 200 * scale);
        const options = { pointTolerance: 8 * scale, inferAxes: false };
        expect(snapPosition(solver, [0, 207.5 * scale], options).snap?.kind).toBe("circle");
        expect(snapPosition(solver, [0, 208.5 * scale], options).snap).toBeUndefined();
        expect(
            snapPosition(solver, [0, 201 * scale], { ...options, snapTypes: ObjectSnapTypes.endPoint }).snap,
        ).toBeUndefined();
    } finally {
        solver.dispose();
    }
});

test("midpoint lines preview both halves and retain their center attachment", () => {
    const data: SketchData = { entities: [], constraints: [] };
    appendSketchPrimitive(data, "midpointLine", [
        [0, 0],
        [12, 6],
    ]);
    const preview = primitivePreview("midpointLine", [[0, 0]], [12, 6]);
    expect(preview[0].params).toEqual([-12, -6, 12, 6]);
    const solver = new SketchSolver(Plane.XY, data);
    try {
        const center = data.entities.find((e) => e.type === "point")!;
        expect(center).not.toBeUndefined();
        applyAutoConstraints(solver, center.id, {
            pointTolerance: 0.5,
            excludeEntityIds: [data.entities[0].id],
        });
        expect(solver.solve(true).result).toMatch(/^Ok/);
        solver.setPointPosition({ entityId: data.entities[0].id, pointIndex: 1 }, 20, 10);
        expect(solver.solve(true).result).toMatch(/^Ok/);
        const a = solver.pointOf({ entityId: data.entities[0].id, pointIndex: 0 });
        const b = solver.pointOf({ entityId: data.entities[0].id, pointIndex: 1 });
        expect(a[0] + b[0]).toBeCloseTo(0, 6);
        expect(a[1] + b[1]).toBeCloseTo(0, 6);
    } finally {
        solver.dispose();
    }
});

test("3 point arc previews the same arc it commits, picking endpoints before the radius point", () => {
    const preview = primitivePreview(
        "arc3Point",
        [
            [-10, 0],
            [10, 0],
        ],
        [0, 10],
    );
    const data: SketchData = { entities: [], constraints: [] };
    appendSketchPrimitive(data, "arc3Point", [
        [-10, 0],
        [10, 0],
        [0, 10],
    ]);
    expect(preview[0]).toEqual(data.entities[0]);
    expect(data.entities[0].params[0]).toBeCloseTo(0);
    expect(data.entities[0].params[1]).toBeCloseTo(0);
    expect(data.entities[0].params.slice(2)).toEqual([10, 0, -10, expect.closeTo(0, 8)]);
});

test("a midpoint line retains both its picked center and rim when the circle radius changes", () => {
    const { solver, radius } = circleFixture();
    try {
        const data = solver.toData();
        appendSketchPrimitive(data, "midpointLine", [
            [0, 0],
            [20, 0],
        ]);
        const created = data.entities.filter((e) => e.type !== "circle");
        solver.reset(data);
        constrainSketchPrimitive(
            solver,
            "midpointLine",
            created.map((e) => e.id),
            { pointTolerance: 0.8, inferAxes: true },
        );
        expect(solver.solve(true).result).toMatch(/^Ok/);
        const contacts = solver.toData().constraints.filter((c) => c.kind === ConstraintKind.PointOnCircle);
        expect(contacts).toHaveLength(1);
        solver.setDatum(radius, 30);
        expect(solver.solve(true).result).toMatch(/^Ok/);
        const line = solver.entity(created.find((e) => e.type === "line")!.id)!;
        expect(line.params[0]).toBeCloseTo(-30, 6);
        expect(line.params[2]).toBeCloseTo(30, 6);
        expect(line.params[1]).toBeCloseTo(0, 6);
        expect(line.params[3]).toBeCloseTo(0, 6);
    } finally {
        solver.dispose();
    }
});

test.each([
    false,
    true,
])("two midpoint lines preserve the circle's origin attachment (radius dimensioned: %s)", (dimensioned) => {
    const { solver, circle, radius } = circleFixture();
    try {
        if (!dimensioned) solver.removeConstraint(radius);
        expect(solver.solve(true).dofs).toBe(dimensioned ? 0 : 1);
        const lines: number[] = [];
        for (const end of [
            [20, 0],
            [0, 20],
        ] as [number, number][]) {
            const data = solver.toData();
            const old = new Set(data.entities.map((e) => e.id));
            appendSketchPrimitive(data, "midpointLine", [[0, 0], end]);
            const added = data.entities.filter((e) => !old.has(e.id));
            lines.push(added.find((e) => e.type === "line")!.id);
            solver.reset(data);
            constrainSketchPrimitive(
                solver,
                "midpointLine",
                added.map((e) => e.id),
                { pointTolerance: 0.8, inferAxes: true },
            );
            const outcome = solver.solve(true);
            expect(outcome.result).toMatch(/^Ok/);
            expect(outcome.dofs).toBe(dimensioned ? 0 : 1);
            expect(solver.pointOf({ entityId: circle, pointIndex: 0 })).toEqual([0, 0]);
            expect(
                solver.hasConstraint(ConstraintKind.P2PCoincident, [
                    { entityId: circle, pointIndex: 0 },
                    originRef(),
                ]),
            ).toBe(true);
            expect(solver.fullyConstrainedEntities().has(circle)).toBe(dimensioned);
        }
        const end = { entityId: lines[0], pointIndex: 1 };
        solver.beginDrag([end]);
        solver.dragTo(end, 30, 4);
        solver.endDrag();
        expect(solver.solve(true).result).toMatch(/^Ok/);
        const center = solver.pointOf({ entityId: circle, pointIndex: 0 });
        expect(center[0]).toBeCloseTo(0, 8);
        expect(center[1]).toBeCloseTo(0, 8);
        if (dimensioned) solver.setDatum(radius, 30);
        else
            solver.addConstraint({
                kind: ConstraintKind.Radius,
                refs: [{ entityId: circle, pointIndex: 0 }],
                datum: 30,
            });
        expect(solver.solve(true).result).toMatch(/^Ok/);
        const r = solver.entity(circle)!.params[2];
        expect(r).toBeCloseTo(30, 5);
        for (const id of lines) {
            const a = solver.pointOf({ entityId: id, pointIndex: 0 });
            const b = solver.pointOf({ entityId: id, pointIndex: 1 });
            expect(a[0] + b[0]).toBeCloseTo(0, 6);
            expect(a[1] + b[1]).toBeCloseTo(0, 6);
            expect(Math.hypot(...a)).toBeCloseTo(r, 6);
            expect(Math.hypot(...b)).toBeCloseTo(r, 6);
        }
    } finally {
        solver.dispose();
    }
});
