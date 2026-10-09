// Part of the Chili3d Project, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

import { type ICommand, Plane } from "@chili3d/core";
import { rs } from "@rstest/core";
import {
    CoincidentConstraintCommand,
    FixConstraintCommand,
    HorizontalConstraintCommand,
    VerticalAlignConstraintCommand,
} from "../../src/sketch/commands/sketchConstraints";
import { SketchEditor, type SketchPickTarget } from "../../src/sketch/editor/sketchEditor";
import { ConstraintKind, originRef, type SketchPointRef } from "../../src/sketch/sketchModel";
import { SketchSolver } from "../../src/sketch/solver";
import "./setup";

function harness(solver: SketchSolver, picks: SketchPickTarget[] = []) {
    return {
        solver,
        selectedWholeEntityIds: [] as number[],
        beginConstraintSelection: rs.fn(),
        registerTool: () => ({ dispose() {} }),
        selectedEntityIds: [] as number[],
        pickSequence: 0,
        lastPickCancelled: false,
        endConstraintSelection: rs.fn(),
        solve: (fine: boolean) => solver.solve(fine),
        commit: rs.fn(),
        pickPointOrEntity: async () => picks.shift(),
        pickEntity: async () => {
            const pick = picks.shift();
            return pick?.kind === "entity" ? pick.entityId : undefined;
        },
    };
}

async function run(command: ICommand, editor: ReturnType<typeof harness>) {
    const spy = rs.spyOn(SketchEditor, "getActive").mockReturnValue(editor as unknown as SketchEditor);
    try {
        await command.execute({ activeView: { document: {} } } as never);
    } finally {
        spy.mockRestore();
    }
}

const point = (entityId: number, pointIndex: number): SketchPointRef => ({ entityId, pointIndex });

test("resizing a circle preserves a driving radius dimension", () => {
    const solver = new SketchSolver(Plane.XY);
    try {
        const circle = solver.addCircle(50, 10, 8);
        solver.addConstraint({ kind: ConstraintKind.Radius, refs: [point(circle, 0)], datum: 8 });
        solver.solve(true);
        const constraints = solver.toData().constraints;
        solver.beginDrag([point(circle, 0)]);
        const result = solver.dragCircleRadiusTo(circle, 30);
        expect(result.result).toMatch(/^Ok/);
        expect(solver.entity(circle)!.params).toEqual([50, 10, 8]);
        solver.endDrag();
        expect(solver.toData().constraints).toEqual(constraints);
    } finally {
        solver.dispose();
    }
});

test.each([
    false,
    true,
])("Coincident attaches a line to a point in either pick order (curve first: %s)", async (curveFirst) => {
    const solver = new SketchSolver(Plane.XY);
    try {
        const fixed = solver.addLine(20, 10, 30, 10);
        solver.addConstraint({ kind: ConstraintKind.Fix, refs: [point(fixed, 0)], datums: [20, 10] });
        const moving = solver.addLine(0, 0, 40, 0);
        const picks: SketchPickTarget[] = [
            { kind: "point", ref: point(fixed, 0) },
            { kind: "entity", entityId: moving },
        ];
        if (curveFirst) picks.reverse();
        const editor = harness(solver, picks);
        await run(new CoincidentConstraintCommand(), editor);
        const p = solver.entity(moving)!.params;
        const distance =
            Math.abs((p[2] - p[0]) * (10 - p[1]) - (p[3] - p[1]) * (20 - p[0])) /
            Math.hypot(p[2] - p[0], p[3] - p[1]);
        expect(distance).toBeLessThan(1e-5);
        expect(solver.pointOf(point(fixed, 0))).toEqual([20, 10]);
        expect(editor.commit).toHaveBeenCalledTimes(1);
    } finally {
        solver.dispose();
    }
});

test("Fix applies to selected whole geometry and reaches zero degrees of freedom", async () => {
    const solver = new SketchSolver(Plane.XY);
    try {
        const line = solver.addLine(0, 0, 40, 12);
        const circle = solver.addCircle(50, 10, 8);
        const editor = harness(solver);
        editor.selectedWholeEntityIds = [line, circle];
        await run(new FixConstraintCommand(), editor);
        expect(solver.dofs()).toBe(0);
        expect(solver.entity(line)!.params).toEqual([0, 0, 40, 12]);
        expect(solver.entity(circle)!.params).toEqual([50, 10, 8]);
        expect(editor.commit).toHaveBeenCalledTimes(1);
    } finally {
        solver.dispose();
    }
});

test("an incompatible constraint restores geometry and constraints without committing", async () => {
    const solver = new SketchSolver(Plane.XY);
    try {
        const line = solver.addLine(0, 0, 30, 15);
        for (const i of [0, 1])
            solver.addConstraint({
                kind: ConstraintKind.Fix,
                refs: [point(line, i)],
                datums: solver.pointOf(point(line, i)),
            });
        solver.solve(true);
        const before = solver.toData();
        const editor = harness(solver, [{ kind: "entity", entityId: line }]);
        await run(new HorizontalConstraintCommand(), editor);
        expect(solver.toData()).toEqual(before);
        expect(editor.commit).not.toHaveBeenCalled();
    } finally {
        solver.dispose();
    }
});

test("Vertical Align applies to a selected whole line, then an endpoint attaches to the origin", async () => {
    const solver = new SketchSolver(Plane.XY);
    try {
        const id = solver.addLine(20, 10, 40, 80);
        const editor = harness(solver);
        editor.selectedWholeEntityIds = [id];
        await run(new VerticalAlignConstraintCommand(), editor);
        expect(solver.entity(id)!.params[0]).toBeCloseTo(solver.entity(id)!.params[2], 7);
        const attach = harness(solver, [
            { kind: "point", ref: point(id, 0) },
            { kind: "point", ref: originRef() },
        ]);
        await run(new CoincidentConstraintCommand(), attach);
        expect(solver.pointOf(point(id, 0))[0]).toBeCloseTo(0, 7);
        expect(solver.pointOf(point(id, 0))[1]).toBeCloseTo(0, 7);
        expect(solver.entity(id)!.params[2]).toBeCloseTo(0, 7);
        expect(solver.dofs()).toBe(1);
    } finally {
        solver.dispose();
    }
});
