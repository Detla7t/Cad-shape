// Part of the Chili3d Project, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

import {
    type INode,
    type IShape,
    Matrix4,
    PmiDatum,
    PmiDimension,
    PmiFeatureControlFrame,
    PmiFlag,
    PmiNote,
    PubSub,
    ShapeTypes,
    type SnapResult,
    type VisualShapeData,
    XYZ,
} from "@chili3d/core";
import { afterAll, beforeAll, describe, expect, rs, test } from "@rstest/core";
import {
    circleOfEdge,
    generalNoteText,
    PmiDatumCommand,
    PmiDiameterCommand,
    PmiDimensionCommand,
    PmiFeatureControlFrameCommand,
    PmiFlagCommand,
    PmiGeneralNoteCommand,
    PmiNoteCommand,
    PmiSelectAllCommand,
} from "../../../src/commands/annotation/pmiCommands";
import {
    ensureGlobalStubApp,
    pointStepResult,
    seedStepDatas,
    stubTransactionRun,
    wireCommand,
} from "../commandTestUtils";

const p = (x: number, y: number, z: number) => new XYZ({ x, y, z });

let restoreApp: () => void;
let restoreTransaction: () => void;
beforeAll(() => {
    restoreApp = ensureGlobalStubApp();
    restoreTransaction = stubTransactionRun();
});
afterAll(() => {
    restoreApp();
    restoreTransaction();
});

/** A pick on a shape: the hit point rides on `shapes[0].point`. */
function shapeStepResult(
    point: XYZ,
    shape: Partial<IShape> = {},
    transform = Matrix4.identity(),
): SnapResult {
    const data = pointStepResult();
    const picked = { point, shape, transform, owner: {}, indexes: [] } as unknown as VisualShapeData;
    return { ...data, type: "shape", shapes: [picked] };
}

function wire<C>(cmd: C, existing: INode[] = []) {
    const wired = wireCommand(cmd);
    const setSelectedNodes = rs.fn((_nodes: INode[], _toggle: boolean) => 1);
    (wired.doc.selection as { setSelectedNodes: unknown }).setSelectedNodes = setSelectedNodes;
    (wired.doc.modelManager as { findNodes: unknown }).findNodes = (predicate?: (node: INode) => boolean) =>
        predicate ? existing.filter(predicate) : existing;
    return { ...wired, setSelectedNodes };
}

describe("PMI annotation commands", () => {
    test("command metadata and step counts", () => {
        const expected: [new () => object, string, number][] = [
            [PmiNoteCommand, "annotation.note", 2],
            [PmiGeneralNoteCommand, "annotation.generalNote", 1],
            [PmiFlagCommand, "annotation.flag", 2],
            [PmiDimensionCommand, "annotation.dimension", 3],
            [PmiDiameterCommand, "annotation.diameter", 2],
            [PmiFeatureControlFrameCommand, "annotation.gdt", 2],
            [PmiDatumCommand, "annotation.datum", 2],
        ];
        for (const [ctor, key, steps] of expected) {
            expect((ctor as any).prototype.data.key).toBe(key);
            expect((new ctor() as any).getSteps()).toHaveLength(steps);
        }
    });

    test("a note leads from the picked point on the model to the placed frame and is selected for editing", () => {
        const cmd = new PmiNoteCommand();
        const { addedNodes, setSelectedNodes, doc } = wire(cmd);
        seedStepDatas(cmd, [shapeStepResult(p(1, 2, 3)), pointStepResult({ point: p(10, 2, 3) })]);
        (cmd as any).executeMainTask();
        expect(addedNodes).toHaveLength(1);
        const note = addedNodes[0] as PmiNote;
        expect(note).toBeInstanceOf(PmiNote);
        expect(note.anchor.isEqualTo(p(1, 2, 3))).toBe(true);
        expect(note.position.isEqualTo(p(10, 2, 3))).toBe(true);
        expect(note.content).toBe("NOTE");
        expect(note.hasLeader).toBe(true);
        expect(setSelectedNodes).toHaveBeenCalledWith([note], false);
        expect(doc.visual.update).toHaveBeenCalled();
    });

    test("a general note sits at one point without a leader and states the document's unit", () => {
        const cmd = new PmiGeneralNoteCommand();
        const { addedNodes, doc } = wire(cmd);
        (doc as { userData?: unknown }).userData = { displayUnits: { length: "in", lengthPrecision: 3 } };
        seedStepDatas(cmd, [pointStepResult({ point: p(0, 50, 0) })]);
        (cmd as any).executeMainTask();
        const note = addedNodes[0] as PmiNote;
        expect(note.hasLeader).toBe(false);
        expect(note.anchor.isEqualTo(note.position)).toBe(true);
        expect(note.lines()).toEqual(["UNLESS OTHERWISE SPECIFIED:", "ALL DIMENSIONS ARE IN INCHES"]);
        expect(generalNoteText("mm")).toContain("MILLIMETERS");
    });

    test("flag notes number on from the highest flag and datums take the next free letter", () => {
        const doc0 = wire(new PmiFlagCommand()).doc;
        const flags = [
            new PmiFlag({ document: doc0, anchor: p(0, 0, 0), position: p(1, 1, 1), text: "2" }),
            new PmiDatum({ document: doc0, anchor: p(0, 0, 0), position: p(1, 1, 1), label: "A" }),
        ];
        const flag = new PmiFlagCommand();
        const flagWired = wire(flag, flags);
        seedStepDatas(flag, [shapeStepResult(p(0, 0, 0)), pointStepResult({ point: p(5, 5, 5) })]);
        (flag as any).executeMainTask();
        expect((flagWired.addedNodes[0] as PmiFlag).content).toBe("3");

        const datum = new PmiDatumCommand();
        const datumWired = wire(datum, flags);
        seedStepDatas(datum, [shapeStepResult(p(0, 0, 0)), pointStepResult({ point: p(5, 5, 5) })]);
        (datum as any).executeMainTask();
        const added = datumWired.addedNodes[0] as PmiDatum;
        expect(added).toBeInstanceOf(PmiDatum);
        expect(added.label).toBe("B");
        expect(added.name).toBe("Datum B");
    });

    test("a feature control frame starts as a position tolerance to datums A and B", () => {
        const cmd = new PmiFeatureControlFrameCommand();
        const { addedNodes } = wire(cmd);
        seedStepDatas(cmd, [shapeStepResult(p(0, 0, 5)), pointStepResult({ point: p(0, 10, 15) })]);
        (cmd as any).executeMainTask();
        const frame = addedNodes[0] as PmiFeatureControlFrame;
        expect(frame).toBeInstanceOf(PmiFeatureControlFrame);
        expect(frame.cells()).toEqual(["⌖", "⌀0.1", "A", "B"]);
        expect(frame.anchor.isEqualTo(p(0, 0, 5))).toBe(true);
    });

    test("a dimension measures between its two points; the third pick places the dimension line", () => {
        const cmd = new PmiDimensionCommand();
        const { addedNodes } = wire(cmd);
        seedStepDatas(cmd, [
            pointStepResult({ point: p(0, 0, 0) }),
            pointStepResult({ point: p(3, 4, 0) }),
            pointStepResult({ point: p(1, 6, 0) }),
        ]);
        (cmd as any).executeMainTask();
        const dimension = addedNodes[0] as PmiDimension;
        expect(dimension).toBeInstanceOf(PmiDimension);
        expect(dimension.dimensionType).toBe("linear");
        expect(dimension.value).toBe(5);
        expect(dimension.anchor2.isEqualTo(p(3, 4, 0))).toBe(true);
        expect(dimension.position.isEqualTo(p(1, 6, 0))).toBe(true);
    });

    test("a diameter reads the circle behind the picked edge, in world coordinates", () => {
        const circleEdge = {
            shapeType: ShapeTypes.edge,
            curve: { basisCurve: { curveType: "circle", center: p(1, 2, 0), radius: 5, axis: XYZ.unitZ } },
        } as unknown as IShape;
        expect(circleOfEdge(circleEdge)?.radius).toBe(5);
        expect(
            circleOfEdge({
                shapeType: ShapeTypes.edge,
                curve: { basisCurve: { curveType: "line" } },
            } as never),
        ).toBeUndefined();
        expect(circleOfEdge({ shapeType: ShapeTypes.face } as never)).toBeUndefined();
        const steps = (new PmiDiameterCommand() as any).getSteps();
        expect(steps[0].options.shapeFilter.allow(circleEdge)).toBe(true);
        expect(steps[0].options.shapeFilter.allow({ shapeType: ShapeTypes.face })).toBe(false);

        const cmd = new PmiDiameterCommand();
        const { addedNodes } = wire(cmd);
        const lifted = Matrix4.fromTranslation(0, 0, 7);
        seedStepDatas(cmd, [
            shapeStepResult(p(6, 2, 7), circleEdge, lifted),
            pointStepResult({ point: p(20, 2, 7) }),
        ]);
        (cmd as any).executeMainTask();
        const dimension = addedNodes[0] as PmiDimension;
        expect(dimension.dimensionType).toBe("diameter");
        expect(dimension.value).toBe(10);
        expect(dimension.anchor.isEqualTo(p(1, 2, 7))).toBe(true);
        expect(dimension.axis.isEqualTo(XYZ.unitZ)).toBe(true);
        expect(dimension.text()).toBe("⌀10.00");
    });

    test("a diameter on an edge that is not circular reports a toast and adds nothing", () => {
        const cmd = new PmiDiameterCommand();
        const { addedNodes } = wire(cmd);
        const lineEdge = {
            shapeType: ShapeTypes.edge,
            curve: { basisCurve: { curveType: "line" } },
        } as unknown as IShape;
        seedStepDatas(cmd, [shapeStepResult(p(0, 0, 0), lineEdge), pointStepResult({ point: p(1, 1, 1) })]);
        const toasts: unknown[] = [];
        const original = PubSub.default.pub;
        PubSub.default.pub = ((channel: string, ...args: unknown[]) => {
            if (channel === "showToast") toasts.push(args[0]);
        }) as typeof PubSub.default.pub;
        try {
            (cmd as any).executeMainTask();
        } finally {
            PubSub.default.pub = original;
        }
        expect(toasts).toEqual(["toast.annotation.notCircular"]);
        expect(addedNodes).toHaveLength(0);
    });

    test("Select all annotations selects every annotation of the document and nothing else", async () => {
        const cmd = new PmiSelectAllCommand();
        const { doc, setSelectedNodes } = wire(cmd);
        const note = new PmiNote({ document: doc, anchor: p(0, 0, 0), position: p(1, 1, 1), text: "A" });
        const flag = new PmiFlag({ document: doc, anchor: p(0, 0, 0), position: p(1, 1, 1), text: "1" });
        const other = { id: "x", name: "box" } as unknown as INode;
        (doc.modelManager as { findNodes: unknown }).findNodes = (predicate?: (node: INode) => boolean) =>
            [note, other, flag].filter((node) => (predicate ? predicate(node) : true));
        const clearSelection = rs.fn();
        (doc.selection as { clearSelection: unknown }).clearSelection = clearSelection;
        await cmd.execute({ activeView: { document: doc } } as never);
        expect(clearSelection).toHaveBeenCalledTimes(1);
        expect(setSelectedNodes).toHaveBeenCalledWith([note, flag], false);
    });
});
