// Part of the Chili3d Project, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

import { Plane, XYZ } from "@chili3d/core";
import { rs } from "@rstest/core";
import { SketchLineCommand } from "../../src/sketch/commands/sketchLine";
import { SketchRectangleCommand } from "../../src/sketch/commands/sketchRectangle";
import { SketchEditor } from "../../src/sketch/editor/sketchEditor";
import { ConstraintKind } from "../../src/sketch/sketchModel";
import { SketchSolver } from "../../src/sketch/solver";
import "./setup";

function fakeEditor() {
    const solver = new SketchSolver(Plane.XY);
    return {
        node: { plane: Plane.XY },
        solver,
        solve: rs.fn((_fine: boolean) => {}),
        commit: rs.fn(() => {}),
        screenTolerance: () => 0,
        registerTool: rs.fn(() => ({ dispose: rs.fn() })),
    };
}

const point = (x: number, y: number, extra: Record<string, unknown> = {}) => ({
    point: new XYZ({ x, y, z: 0 }),
    ...extra,
});

/** Completes one segment with the given step data, then restarts the tool the way `execute` does. */
function segment(command: SketchLineCommand, steps: object[]) {
    const c = command as any;
    c.stepDatas.push(...steps);
    c.executeMainTask();
    c.onRestarting();
}

function withEditor<T>(editor: object, run: () => T): T {
    const getActive = rs.spyOn(SketchEditor, "getActive").mockReturnValue(editor as any);
    try {
        return run();
    } finally {
        getActive.mockRestore();
    }
}

/** Keeps the fake editor active across the awaits of an async run. */
async function withEditorAsync<T>(editor: object, run: () => Promise<T>): Promise<T> {
    const getActive = rs.spyOn(SketchEditor, "getActive").mockReturnValue(editor as any);
    try {
        return await run();
    } finally {
        getActive.mockRestore();
    }
}

const joins = (solver: SketchSolver) =>
    solver.toData().constraints.filter((c) => c.kind === ConstraintKind.P2PCoincident);

describe("SketchLineCommand chaining", () => {
    test("the next segment starts at the previous end and is joined by a coincident constraint", () => {
        const editor = fakeEditor();
        const command = new SketchLineCommand();
        withEditor(editor, () => {
            segment(command, [point(0, 0), point(10, 0, { suppressInference: true })]);
            const c = command as any;
            expect(c.stepDatas).toHaveLength(1);
            expect(c.stepDatas[0].point).toEqual(new XYZ({ x: 10, y: 0, z: 0 }));
            expect(c.stepDatas[0].suppressInference).toBeUndefined();
            segment(command, [point(10, 10)]);
        });
        expect(editor.solver.entities().map((e) => e.params)).toEqual([
            [0, 0, 10, 0],
            [10, 0, 10, 10],
        ]);
        // inferred axis constraints aside, the only join is the structural one
        expect(joins(editor.solver)).toEqual([
            {
                id: 1,
                kind: ConstraintKind.P2PCoincident,
                refs: [
                    { entityId: 2, pointIndex: 0 },
                    { entityId: 1, pointIndex: 1 },
                ],
            },
        ]);
        expect(editor.commit).toHaveBeenCalledTimes(2);
        editor.solver.dispose();
    });

    test("closing the chain on its first point ends it", () => {
        const editor = fakeEditor();
        const command = new SketchLineCommand();
        withEditor(editor, () => {
            segment(command, [point(0, 0), point(10, 0)]);
            segment(command, [point(10, 10)]);
            segment(command, [point(0, 0)]);
            expect((command as any).stepDatas).toHaveLength(0);
            segment(command, [point(50, 50), point(60, 50)]);
        });
        expect(editor.solver.entities()).toHaveLength(4);
        // two joins inside the triangle; the fresh chain is not tied to it
        expect(joins(editor.solver).map((c) => c.refs.map((r) => r.entityId))).toEqual([
            [2, 1],
            [3, 2],
        ]);
        editor.solver.dispose();
    });

    test("a segment drawn by press-and-drag does not start a chain", () => {
        const editor = fakeEditor();
        const command = new SketchLineCommand();
        withEditor(editor, () => {
            segment(command, [point(0, 0), point(10, 0, { dragged: true })]);
            expect((command as any).stepDatas).toHaveLength(0);
        });
        editor.solver.dispose();
    });

    test("with Connected off every segment starts fresh", () => {
        const editor = fakeEditor();
        const command = new SketchLineCommand();
        command.isContinue = false;
        withEditor(editor, () => {
            segment(command, [point(0, 0), point(10, 0)]);
            expect((command as any).stepDatas).toHaveLength(0);
        });
        expect(joins(editor.solver)).toEqual([]);
        editor.solver.dispose();
    });
});

describe("sketch tools stay armed", () => {
    test.each([
        { name: "line", make: () => new SketchLineCommand() },
        { name: "rectangle", make: () => new SketchRectangleCommand() },
    ])("Escape with a $name in progress drops it and restarts the tool", async ({ make }) => {
        const editor = fakeEditor();
        const command = make() as any;
        rs.spyOn(command, "executeSteps").mockImplementation(async () => {
            command.stepDatas.push(point(0, 0));
            return false;
        });
        await withEditorAsync(editor, () => command.executeAsync());
        expect(command._isRestarting).toBe(true);
        expect(command.stepDatas).toHaveLength(0);
        expect(editor.solver.entities()).toEqual([]);
        expect(editor.registerTool).toHaveBeenCalledWith(command);
        editor.solver.dispose();
    });

    test("Escape with nothing in progress ends the tool", async () => {
        const editor = fakeEditor();
        const command = new SketchLineCommand() as any;
        rs.spyOn(command, "executeSteps").mockResolvedValue(false);
        await withEditorAsync(editor, () => command.executeAsync());
        expect(command._isRestarting).toBe(false);
        expect(command.repeatOperation).toBe(false);
        editor.solver.dispose();
    });

    test("a completed shape re-arms the tool", async () => {
        const editor = fakeEditor();
        const command = new SketchLineCommand() as any;
        rs.spyOn(command, "executeSteps").mockImplementation(async () => {
            command.stepDatas.push(point(0, 0), point(10, 0));
            return true;
        });
        await withEditorAsync(editor, () => command.executeAsync());
        expect(command.repeatOperation).toBe(true);
        expect(editor.solver.entities()).toHaveLength(1);
        editor.solver.dispose();
    });

    test("a cancelled tool (another tool chosen) does not restart", async () => {
        const editor = fakeEditor();
        const command = new SketchLineCommand() as any;
        rs.spyOn(command, "executeSteps").mockImplementation(async () => {
            command.stepDatas.push(point(0, 0));
            command._isCanceled = true;
            return false;
        });
        await withEditorAsync(editor, () => command.executeAsync());
        expect(command._isRestarting).toBe(false);
        editor.solver.dispose();
    });
});
