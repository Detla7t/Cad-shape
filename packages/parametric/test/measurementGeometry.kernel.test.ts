// Part of the Chili3d Project, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

import { readFileSync } from "node:fs";
import {
    AsyncController,
    EditableShapeNode,
    type FloatPanelOptions,
    type IFace,
    type IShape,
    type ISubFaceShape,
    Matrix4,
    Plane,
    PubSub,
    Result,
    ShapeTypes,
    Transaction,
    XYZ,
} from "@chili3d/core";
import {
    createMockApplication,
    createMockSelection,
    createMockVisualShapeData,
    TestDocument,
} from "@chili3d/core/test-utils";
import { initWasm, ShapeFactory } from "@chili3d/wasm";
import { rs } from "@rstest/core";
import { MeasuredVariableNode } from "../src/measurement/measuredVariableNode";
import {
    captureMeasurement,
    measureReferenceDetails,
    measureReferences,
} from "../src/measurement/measurement";
import { measurementDetails, measureShapes } from "../src/measurement/measurementGeometry";
import { measureSelection } from "../src/measurement/selectionMeasurement";
import { editMeasuredVariable } from "../src/measurement/variableEditor";
import { ParametricBodyNode } from "../src/parametricBodyNode";
import { SketchNode } from "../src/sketch/sketchNode";
import "./sketch/setup";

let factory: ShapeFactory;
const owned: IShape[] = [];
const own = <T extends IShape>(result: Result<T>) => {
    expect(result.isOk).toBe(true);
    owned.push(result.value);
    return result.value;
};
beforeAll(async () => {
    await initWasm({ wasmBinary: readFileSync("packages/wasm/lib/chili-wasm.wasm") });
    factory = new ShapeFactory();
    rs.stubGlobal("shapeFactory", factory);
});
afterEach(() => {
    for (const shape of owned.splice(0)) shape.dispose();
});
afterAll(() => {
    rs.unstubAllGlobals();
});

function verifyDistance(a: IShape, b: IShape, minimum: number, maximum: number) {
    for (const [mode, expected] of [
        ["distance", minimum],
        ["maxDistance", maximum],
    ] as const) {
        const result = measureShapes(mode, [a, b]);
        expect(result.isOk).toBe(true);
        expect(result.value.value).toBeCloseTo(expected, 5);
        const [first, second] = result.value.segments[0];
        expect(new XYZ(first).distanceTo(second)).toBeCloseTo(expected, 5);
        const p = own(factory.point(first)),
            q = own(factory.point(second));
        expect(p.extremaDistance(a)).toBeCloseTo(0, 5);
        expect(q.extremaDistance(b)).toBeCloseTo(0, 5);
    }
}

test("parallel bounded faces measure the gap and farthest corners, with witnesses on each face", () => {
    const box = own(factory.box(Plane.XY, 30, 40, 12));
    const faces = box.findSubShapes(ShapeTypes.face) as IFace[];
    owned.push(...faces);
    const pair = faces.filter((face) => Math.abs(face.area() - 1200) < 1e-6);
    expect(pair).toHaveLength(2);
    verifyDistance(pair[0], pair[1], 12, Math.hypot(30, 40, 12));
});

test("periodic circular edges measure the real farthest points, not tessellation vertices", () => {
    const a = own(factory.circle(XYZ.unitZ, XYZ.zero, 5));
    const b = own(factory.circle(XYZ.unitZ, new XYZ({ x: 0, y: 0, z: 12 }), 5));
    verifyDistance(a, b, 12, Math.hypot(10, 12));
});

test("separated spheres include curved interior extrema", () => {
    const a = own(factory.sphere(XYZ.zero, 3));
    const b = own(factory.sphere(new XYZ({ x: 8, y: 6, z: 0 }), 2));
    verifyDistance(a, b, 5, 15);
});

test("cylindrical faces switch diameter to radius with a center-to-wall guide", () => {
    const cylinder = own(factory.cylinder(XYZ.unitZ, XYZ.zero, 7, 20));
    const faces = cylinder.findSubShapes(ShapeTypes.face) as IFace[];
    owned.push(...faces);
    const side = faces.find((face) => {
        const surface = face.surface();
        try {
            return !surface.isPlanar();
        } finally {
            surface.dispose();
        }
    });
    expect(side).not.toBeUndefined();
    for (const [mode, expected] of [
        ["diameter", 14],
        ["radius", 7],
    ] as const) {
        const measured = measureShapes(mode, [side!]);
        expect(measured.isOk).toBe(true);
        expect(measured.value.value).toBeCloseTo(expected, 6);
        const [a, b] = measured.value.segments[0];
        expect(new XYZ(a).distanceTo(b)).toBeCloseTo(expected, 6);
        expect(a.z).toBeCloseTo(10);
        expect(b.z).toBeCloseTo(10);
    }
});

test("quick measurement and a saved radius variable agree and survive source transforms and undo", () => {
    const model = new TestDocument({
        application: createMockApplication({ shapeProvider: { factory } }),
        selection: createMockSelection(),
    });
    const circle = own(factory.circle(XYZ.unitZ, XYZ.zero, 9));
    const node = new EditableShapeNode({ document: model, name: "Circle", shape: Result.ok(circle) });
    model.modelManager.addNode(node);
    const pick = createMockVisualShapeData();
    pick.owner = { ...pick.owner, node };
    pick.shape = circle;
    pick.indexes = [0];
    model.selection.getSelectedShapes = () => [pick];
    const quick = measureSelection(model);
    expect(quick.isOk).toBe(true);
    expect(quick.value.measurement!.mode).toBe("diameter");
    expect(quick.value.measurement!.value).toBeCloseTo(18);
    const radius = measureSelection(model, "radius");
    expect(radius.isOk).toBe(true);
    expect(radius.value.measurement!.value).toBeCloseTo(9);
    const ref = captureMeasurement(pick);
    expect(ref.isOk).toBe(true);
    const measured = new MeasuredVariableNode({
        document: model,
        definition: { name: "RoundRadius", source: "measured", mode: "radius", entities: [ref.value] },
    });
    model.modelManager.addNode(measured);
    expect(model.variables.scope.get("RoundRadius")?.value).toBeCloseTo(9);
    Transaction.execute(model, "move", () => {
        node.transform = Matrix4.fromTranslation(25, 10, 4);
    });
    const moved = measureReferenceDetails(model, "radius", [ref.value]);
    expect(moved.isOk).toBe(true);
    expect(moved.value.segments[0][0]).toMatchObject({ x: 25, y: 10, z: 4 });
    expect(measureReferences(model, "radius", [ref.value]).value).toBeCloseTo(9);
    model.history.undo();
    expect(measureReferenceDetails(model, "radius", [ref.value]).value.segments[0][0]).toMatchObject({
        x: 0,
        y: 0,
        z: 0,
    });
});

test("the variable editor refines a captured diameter into a persistent radius and Cancel leaves it alone", async () => {
    const model = new TestDocument({
        application: createMockApplication({ shapeProvider: { factory } }),
        selection: createMockSelection(),
    });
    const circle = own(factory.circle(XYZ.unitZ, XYZ.zero, 9));
    const node = new EditableShapeNode({ document: model, name: "Circle", shape: Result.ok(circle) });
    model.modelManager.addNode(node);
    const original = createMockVisualShapeData();
    const picked = { ...original, shape: circle, owner: { ...original.owner, node }, indexes: [0] };
    const ref = captureMeasurement(picked);
    expect(ref.isOk).toBe(true);
    let panel: FloatPanelOptions | undefined;
    const show = (options: FloatPanelOptions) => {
        panel = options;
    };
    PubSub.default.sub("showFloatPanel", show);
    const controller = new AsyncController();
    try {
        const pending = editMeasuredVariable(model, controller, undefined, {
            mode: "diameter",
            entities: [ref.value],
        });
        expect(panel).not.toBeUndefined();
        expect(panel!.content.textContent).toContain("18.00 mm");
        const method = panel!.content.querySelector<HTMLSelectElement>('[aria-label="Measurement method"]');
        expect(method).not.toBeNull();
        method!.value = "radius";
        method!.dispatchEvent(new Event("change"));
        expect(panel!.content.textContent).toContain("9.00 mm");
        const accept = panel!.content.querySelector<HTMLButtonElement>('[aria-label="Accept variable"]');
        expect(accept).not.toBeNull();
        expect(accept!.disabled).toBe(false);
        const undo = model.history.undoCount();
        accept!.click();
        await pending;
        const saved = model.modelManager
            .findNodes()
            .find((node) => node instanceof MeasuredVariableNode) as MeasuredVariableNode;
        expect(saved.definition).toMatchObject({
            mode: "radius",
            entities: [JSON.parse(JSON.stringify(ref.value))],
        });
        expect(saved.result.value).toBeCloseTo(9);
        expect(model.history.undoCount()).toBe(undo + 1);
        const originalDefinition = saved.definitionJson;
        const reopened = editMeasuredVariable(model, controller, saved);
        const reopenedMethod = panel!.content.querySelector<HTMLSelectElement>(
            '[aria-label="Measurement method"]',
        );
        expect(reopenedMethod).not.toBeNull();
        expect(reopenedMethod!.value).toBe("radius");
        reopenedMethod!.value = "diameter";
        reopenedMethod!.dispatchEvent(new Event("change"));
        const cancel = panel!.content.querySelector<HTMLButtonElement>('[aria-label="Cancel variable"]');
        expect(cancel).not.toBeNull();
        cancel!.click();
        await reopened;
        expect(saved.definitionJson).toBe(originalDefinition);
        expect(model.history.undoCount()).toBe(undo + 1);
    } finally {
        controller.cancel();
        controller.dispose();
        PubSub.default.remove("showFloatPanel", show);
    }
});

test("an unchanged face selection resolves fresh tracked geometry after its old mesh was disposed", () => {
    const model = new TestDocument({
        application: createMockApplication({ shapeProvider: { factory } }),
        selection: createMockSelection(),
    });
    const sketch = new SketchNode({
        document: model,
        plane: Plane.XY,
        data: { entities: [{ id: 1, type: "circle", params: [0, 0, 15] }], constraints: [] },
    });
    model.modelManager.addNode(sketch);
    const body = new ParametricBodyNode({
        document: model,
        features: [{ id: "e", type: "extrude", sketchId: sketch.id, depth: 40 }],
    });
    model.modelManager.addNode(body);
    const ranges = body.mesh.faces!.range;
    const side = ranges.findIndex((range) => {
        const surface = (range.shape as ISubFaceShape).surface();
        try {
            return !surface.isPlanar();
        } finally {
            surface.dispose();
        }
    });
    expect(side).toBeGreaterThanOrEqual(0);
    const original = createMockVisualShapeData();
    const pick = {
        ...original,
        shape: ranges[side].shape,
        owner: { ...original.owner, node: body },
        indexes: [side],
    };
    model.selection.getSelectedShapes = () => [pick];
    expect(measureSelection(model).value.measurement!.value).toBeCloseTo(30);
    const data = sketch.data;
    data.entities[0].params[2] = 18;
    sketch.setDataEmitShapeChanged(data);
    const refreshed = measureSelection(model, "radius");
    expect(refreshed.isOk).toBe(true);
    expect(refreshed.value.measurement!.value).toBeCloseTo(18);
    const fresh = body.mesh.faces!.range;
    const caps = fresh.flatMap((range, i) => {
        const surface = (range.shape as ISubFaceShape).surface();
        try {
            return surface.isPlanar() ? [i] : [];
        } finally {
            surface.dispose();
        }
    });
    expect(caps).toHaveLength(2);
    model.selection.getSelectedShapes = () =>
        caps.map((i) => ({ ...pick, shape: fresh[i].shape, indexes: [i] }));
    body.transform = Matrix4.fromTranslation(5, -2, 10);
    const gap = measureSelection(model, "distance"),
        farthest = measureSelection(model, "maxDistance");
    expect(gap.isOk).toBe(true);
    expect(farthest.isOk).toBe(true);
    expect(gap.value.measurement!.value).toBeCloseTo(40, 5);
    expect(farthest.value.measurement!.value).toBeCloseTo(Math.hypot(36, 40), 5);
    expect(gap.value.measurement!.segments[0].map((point) => point.z).sort((a, b) => a - b)).toEqual([
        10, 50,
    ]);
});

describe("Onshape-style measurement details", () => {
    test("a distance reports its ΔX/ΔY/ΔZ as an axis staircase between the witness points", () => {
        const a = own(factory.point(new XYZ(1, 2, 3)));
        const b = own(factory.point(new XYZ(4, -2, 15)));
        const distance = measureShapes("distance", [a, b]);
        expect(distance.value.value).toBeCloseTo(13, 9);
        const details = measurementDetails([a, b], distance.value);
        expect(details.map((d) => [d.label, d.axis, d.value])).toEqual([
            ["ΔX", "x", 3],
            ["ΔY", "y", 4],
            ["ΔZ", "z", 12],
        ]);
        // the legs chain from the first point to the second
        const legs = details.map((d) => d.segments![0]);
        expect(new XYZ(legs[0][0]).isEqualTo(new XYZ(1, 2, 3))).toBe(true);
        expect(new XYZ(legs[2][1]).isEqualTo(new XYZ(4, -2, 15))).toBe(true);
    });

    test("two straight edges report the angle between them; a lone face its area; a point its coordinates", () => {
        const l1 = own(factory.line(new XYZ(0, 0, 0), new XYZ(10, 0, 0)));
        const l2 = own(factory.line(new XYZ(0, 0, 0), new XYZ(10, 10, 0)));
        expect(measurementDetails([l1, l2]).find((d) => d.label === "Angle")?.value).toBeCloseTo(45, 9);

        const box = own(factory.box(Plane.XY, 10, 20, 30));
        const faces = box.findSubShapes(ShapeTypes.face) as IFace[];
        try {
            const areas = faces.map(
                (face) => measurementDetails([face]).find((d) => d.label === "Area")!.value,
            );
            expect(areas.sort((x, y) => x - y)).toEqual(
                [200, 200, 300, 300, 600, 600].map((v) => expect.closeTo(v, 6)) as unknown as number[],
            );
            // one face against the other five: its opposite face is parallel, the four around it square
            const angles = faces
                .slice(1)
                .map((face) =>
                    Math.round(measurementDetails([faces[0], face]).find((d) => d.label === "Angle")!.value),
                );
            expect(angles.sort((x, y) => x - y)).toEqual([0, 90, 90, 90, 90]);
        } finally {
            faces.forEach((face) => face.dispose());
        }

        const point = own(factory.point(new XYZ(1, 2, 3)));
        expect(measurementDetails([point]).map((d) => [d.label, d.value])).toEqual([
            ["X", 1],
            ["Y", 2],
            ["Z", 3],
        ]);
    });

    test("Center measures between the centers of two circles", () => {
        const c1 = own(factory.circle(XYZ.unitZ, new XYZ(0, 0, 0), 5));
        const c2 = own(factory.circle(XYZ.unitZ, new XYZ(30, 40, 0), 10));
        expect(measureShapes("centerDistance", [c1, c2]).value.value).toBeCloseTo(50, 9);
        // minimum distance between the circles themselves is center distance minus both radii
        expect(measureShapes("distance", [c1, c2]).value.value).toBeCloseTo(35, 6);
    });
});
