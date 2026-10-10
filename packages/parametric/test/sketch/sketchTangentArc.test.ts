// Part of the Chili3d Project, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

import { Plane, PubSub, XYZ } from "@chili3d/core";
import { rs } from "@rstest/core";
import type { DragSnap } from "../../src/sketch/autoConstraints";
import { SketchTangentArcCommand } from "../../src/sketch/commands/sketchArc";
import type { SketchPointSnapData } from "../../src/sketch/commands/sketchPointStep";
import { SketchEditor } from "../../src/sketch/editor/sketchEditor";
import { ConstraintKind, type SketchPointRef } from "../../src/sketch/sketchModel";
import { SketchSolver } from "../../src/sketch/solver";
import { endTangent, tangentArc } from "../../src/sketch/tangentArc";
import "./setup";

describe("tangent arc geometry", () => {
    test("a left turn keeps the start as the arc's start, its center on the left normal", () => {
        expect(tangentArc([0, 0], [1, 0], [10, 10])).toEqual({
            params: [0, 10, 0, 0, 10, 10],
            startIndex: 1,
        });
    });

    test("a right turn runs counter-clockwise from the end back to the start", () => {
        expect(tangentArc([0, 0], [1, 0], [10, -10])).toEqual({
            params: [0, -10, 10, -10, 0, 0],
            startIndex: 2,
        });
    });

    test("an end on the tangent line or on the start makes no arc", () => {
        expect(tangentArc([0, 0], [1, 0], [25, 0])).toBeUndefined();
        expect(tangentArc([0, 0], [1, 0], [0, 0])).toBeUndefined();
    });

    test("curve ends point away from their curve; centers and mid-curve points have none", () => {
        const line = { id: 1, type: "line" as const, params: [0, 0, 10, 0] };
        expect(endTangent(line, 1)).toEqual([1, 0]);
        expect(endTangent(line, 0)).toEqual([-1, 0]);
        // counter-clockwise quarter arc from (10, 0) to (0, 10) around the origin
        const arc = { id: 2, type: "arc" as const, params: [0, 0, 10, 0, 0, 10] };
        expect(endTangent(arc, 2)).toEqual([-1, 0]);
        expect(endTangent(arc, 1)).toEqual([0, -1]);
        expect(endTangent(arc, 0)).toBeUndefined();
        expect(endTangent({ id: 3, type: "circle", params: [0, 0, 5] }, 0)).toBeUndefined();
    });
});

function fakeEditor() {
    const solver = new SketchSolver(Plane.XY);
    return {
        node: { plane: Plane.XY },
        solver,
        solve: rs.fn((_fine: boolean) => {}),
        commit: rs.fn(() => {}),
        screenTolerance: () => 1,
    };
}

type FakeEditor = ReturnType<typeof fakeEditor>;

const pointSnap = (ref: SketchPointRef, position: [number, number]): DragSnap => ({
    kind: "point",
    point: ref,
    position,
});

/** Runs the steps' outcome: the start snapped onto `from`, the end at `end`. */
function drawTangentArc(editor: FakeEditor, from: SketchPointRef, end: [number, number], shift = false) {
    const command = new SketchTangentArcCommand();
    const start = editor.solver.pointOf(from);
    const getActive = rs.spyOn(SketchEditor, "getActive").mockReturnValue(editor as any);
    (command as any).stepDatas = [
        {
            point: new XYZ({ x: start[0], y: start[1], z: 0 }),
            sketchSnap: pointSnap(from, start),
            suppressInference: shift,
        },
        { point: new XYZ({ x: end[0], y: end[1], z: 0 }), suppressInference: shift },
    ];
    try {
        (command as any).executeMainTask();
    } finally {
        getActive.mockRestore();
    }
}

/** Step `index`'s snap data, read (closures included) while `editor` is the active sketch. */
function withStepData<T>(
    editor: FakeEditor,
    index: number,
    starts: object | undefined,
    read: (data: SketchPointSnapData) => T,
): T {
    const command = new SketchTangentArcCommand();
    const getActive = rs.spyOn(SketchEditor, "getActive").mockReturnValue(editor as any);
    try {
        (command as any).stepDatas = starts ? [starts] : [];
        return read((command as any).getSteps()[index].handleStepData());
    } finally {
        getActive.mockRestore();
    }
}

describe("SketchTangentArcCommand", () => {
    test("leaves a line end tangentially: coincident start, line-arc tangency, solved in place", () => {
        const editor = fakeEditor();
        try {
            const line = editor.solver.addLine(-20, 0, 0, 0);
            drawTangentArc(editor, { entityId: line, pointIndex: 1 }, [10, 10]);

            const arc = editor.solver.entities().find((entity) => entity.type === "arc")!;
            expect(arc.params).toEqual([0, 10, 0, 0, 10, 10]);
            const constraints = editor.solver.toData().constraints;
            expect(constraints).toContainEqual(
                expect.objectContaining({
                    kind: ConstraintKind.P2PCoincident,
                    refs: [
                        { entityId: arc.id, pointIndex: 1 },
                        { entityId: line, pointIndex: 1 },
                    ],
                }),
            );
            expect(constraints.filter((c) => c.kind === ConstraintKind.TangentLineArc)).toHaveLength(1);
            expect(editor.commit).toHaveBeenCalledTimes(1);
            expect(editor.solver.solve(true).result).toMatch(/^Ok/);
            expect(editor.solver.entity(arc.id)!.params.map((v) => Math.round(v * 1e6) / 1e6)).toEqual([
                0, 10, 0, 0, 10, 10,
            ]);
            // dragging the line keeps the arc attached and tangent: its center stays on the line's normal
            editor.solver.beginDrag([{ entityId: line, pointIndex: 0 }]);
            editor.solver.dragTo({ entityId: line, pointIndex: 0 }, -20, -8);
            editor.solver.endDrag();
            expect(editor.solver.solve(true).result).toMatch(/^Ok/);
            const [x1, y1, x2, y2] = editor.solver.entity(line)!.params;
            const [cx, cy] = editor.solver.entity(arc.id)!.params;
            const cosine =
                ((cx - x2) * (x2 - x1) + (cy - y2) * (y2 - y1)) /
                (Math.hypot(cx - x2, cy - y2) * Math.hypot(x2 - x1, y2 - y1));
            expect(y1).toBeLessThan(-4); // the line did turn
            expect(cosine).toBeCloseTo(0, 4);
        } finally {
            editor.solver.dispose();
        }
    });

    test("continues an arc's end on the same circle (arc-arc tangency), even under Shift", () => {
        const editor = fakeEditor();
        try {
            const first = editor.solver.addArc(0, 0, 10, 0, 0, 10);
            drawTangentArc(editor, { entityId: first, pointIndex: 2 }, [-10, 0], true);

            const arc = editor.solver.entities().find((entity) => entity.id !== first)!;
            expect(arc.params).toEqual([0, 0, 0, 10, -10, 0]);
            const kinds = editor.solver.toData().constraints.map((c) => c.kind);
            expect(kinds).toContain(ConstraintKind.TangentArcArc);
            expect(kinds).toContain(ConstraintKind.P2PCoincident);
            expect(editor.solver.solve(true).result).toMatch(/^Ok/);
        } finally {
            editor.solver.dispose();
        }
    });

    test("an end on the tangent line is refused with a message and nothing added", () => {
        const editor = fakeEditor();
        const pub = rs.spyOn(PubSub.default, "pub").mockImplementation(() => {});
        try {
            const line = editor.solver.addLine(-20, 0, 0, 0);
            drawTangentArc(editor, { entityId: line, pointIndex: 1 }, [30, 0]);
            expect(pub).toHaveBeenCalledWith("displayError", expect.any(String));
            expect(editor.solver.entities()).toHaveLength(1);
            expect(editor.commit).not.toHaveBeenCalled();
        } finally {
            pub.mockRestore();
            editor.solver.dispose();
        }
    });

    test("the start pick only lands on the end of a line or arc", () => {
        const editor = fakeEditor();
        try {
            const line = editor.solver.addLine(-20, 0, 0, 0);
            const circle = editor.solver.addCircle(40, 0, 5);
            const arc = editor.solver.addArc(0, 30, 10, 30, 0, 40);
            withStepData(editor, 0, undefined, (data) => {
                const accept = data.acceptSnap!;
                expect(accept(undefined)).toBe(false);
                expect(accept(pointSnap({ entityId: line, pointIndex: 0 }, [-20, 0]))).toBe(true);
                expect(accept(pointSnap({ entityId: arc, pointIndex: 1 }, [10, 30]))).toBe(true);
                expect(accept(pointSnap({ entityId: arc, pointIndex: 0 }, [0, 30]))).toBe(false);
                expect(accept(pointSnap({ entityId: circle, pointIndex: 0 }, [40, 0]))).toBe(false);
                expect(
                    accept({
                        kind: "line",
                        lineRefs: [
                            { entityId: line, pointIndex: 0 },
                            { entityId: line, pointIndex: 1 },
                        ],
                        position: [-10, 0],
                    }),
                ).toBe(false);
            });
        } finally {
            editor.solver.dispose();
        }
    });

    test("the end step previews (and judges) the tangent arc the probe would complete", () => {
        const editor = fakeEditor();
        try {
            const line = editor.solver.addLine(-20, 0, 0, 0);
            const start = {
                point: new XYZ({ x: 0, y: 0, z: 0 }),
                sketchSnap: pointSnap({ entityId: line, pointIndex: 1 }, [0, 0]),
            };
            const [turn, straight] = withStepData(editor, 1, start, (data) => [
                data.tentative?.([10, -10]),
                data.tentative?.([30, 0]),
            ]);
            expect(turn).toEqual({ type: "arc", params: [0, -10, 10, -10, 0, 0] });
            expect(straight).toBeUndefined();
        } finally {
            editor.solver.dispose();
        }
    });
});
