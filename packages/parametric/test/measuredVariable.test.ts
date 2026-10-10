// Part of the Chili3d Project, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

import { readFileSync } from "node:fs";
import { EditableShapeNode, Plane, Serializer, Transaction, XYZ } from "@chili3d/core";
import { createMockApplication, TestDocument } from "@chili3d/core/test-utils";
import { initWasm, ShapeFactory } from "@chili3d/wasm";
import { rs } from "@rstest/core";
import { MeasuredVariableNode } from "../src/measurement/measuredVariableNode";
import { type MeasurementReference, measureReferences } from "../src/measurement/measurement";
import { ConstraintKind } from "../src/sketch/sketchModel";
import { SketchNode } from "../src/sketch/sketchNode";
import "./sketch/setup";

let factory: ShapeFactory;
beforeAll(async () => {
    await initWasm({ wasmBinary: readFileSync("packages/wasm/lib/chili-wasm.wasm") });
    factory = new ShapeFactory();
    rs.stubGlobal("shapeFactory", factory);
});
afterAll(() => {
    rs.unstubAllGlobals();
});
function setup() {
    const model = new TestDocument({ application: createMockApplication({ shapeProvider: { factory } }) });
    const sketch = new SketchNode({
        document: model,
        plane: Plane.XY,
        data: {
            entities: [
                { id: 1, type: "line", params: [0, 0, 30, 40] },
                { id: 2, type: "circle", params: [100, 0, 10] },
            ],
            constraints: [],
        },
    });
    model.modelManager.addNode(sketch);
    const ref: MeasurementReference = { kind: "entity", nodeId: sketch.id, entityId: 1, label: "Line" };
    const measured = new MeasuredVariableNode({
        document: model,
        definition: { name: "Wall_Length", source: "measured", mode: "length", entities: [ref] },
    });
    model.modelManager.addNode(measured);
    return { model, sketch, ref, measured };
}

test("a measured sketch length feeds expressions and follows edits, undo, and redo", () => {
    const { model, sketch, measured } = setup();
    expect(measured.result.unchecked()).toBeCloseTo(50);
    expect(model.variables.scope.get("Wall_Length")?.value).toBeCloseTo(50);
    model.variables.setItems([
        { id: "twice", name: "Twice", type: "length", expression: "#Wall_Length * 2" },
    ]);
    expect(model.variables.scope.get("Twice")?.value).toBeCloseTo(100);
    Transaction.execute(model, "drag line", () => {
        const data = sketch.data;
        data.entities[0].params = [0, 0, 60, 80];
        sketch.setDataEmitShapeChanged(data);
    });
    expect(model.variables.scope.get("Twice")?.value).toBeCloseTo(200);
    model.history.undo();
    expect(model.variables.scope.get("Twice")?.value).toBeCloseTo(100);
    model.history.redo();
    expect(model.variables.scope.get("Twice")?.value).toBeCloseTo(200);
});

test("stable sketch ids survive reordering and lost entities do not expose stale values", () => {
    const { model, sketch, measured } = setup();
    const data = sketch.data;
    data.entities.reverse();
    sketch.setDataEmitShapeChanged(data);
    expect(measured.result.unchecked()).toBeCloseTo(50);
    Transaction.execute(model, "delete source", () => {
        const next = sketch.data;
        next.entities = next.entities.filter((entity) => entity.id !== 1);
        sketch.setDataEmitShapeChanged(next);
    });
    expect(measured.result.isOk).toBe(false);
    expect(model.variables.scope.has("Wall_Length")).toBe(false);
    expect(model.variables.evaluate().errors.get(measured.id)).toContain("missing");
    model.history.undo();
    expect(model.variables.scope.get("Wall_Length")?.value).toBeCloseTo(50);
});

test("distance uses actual entities; diameter and invalid combinations are validated", () => {
    const { model, sketch, ref } = setup();
    const circle: MeasurementReference = { kind: "entity", nodeId: sketch.id, entityId: 2, label: "Circle" };
    expect(measureReferences(model, "diameter", [circle]).unchecked()).toBeCloseTo(20);
    expect(measureReferences(model, "length", [circle]).unchecked()).toBeCloseTo(20 * Math.PI);
    expect(measureReferences(model, "diameter", [ref]).isOk).toBe(false);
    expect(measureReferences(model, "distance", [ref]).isOk).toBe(false);
    const p0: MeasurementReference = { ...ref, kind: "entity", entityId: 1, pointIndex: 0 };
    const p1: MeasurementReference = { ...p0, kind: "entity", entityId: 1, pointIndex: 1 };
    expect(measureReferences(model, "distance", [p0, p1]).unchecked()).toBeCloseTo(50);
});

test("suppression removes a variable from scope and follows a configuration checkbox", () => {
    const { model, measured } = setup();
    model.variables.setConfigurationInputs([
        { kind: "checkbox", id: "hide", name: "Hide", defaultValue: false },
    ]);
    measured.definition = { ...measured.definition, suppression: "#Hide" };
    expect(model.variables.scope.has("Wall_Length")).toBe(true);
    model.variables.setActiveConfiguration({ Hide: true });
    expect(measured.isSuppressed).toBe(true);
    expect(model.variables.scope.has("Wall_Length")).toBe(false);
    model.variables.setActiveConfiguration({ Hide: false });
    expect(model.variables.scope.get("Wall_Length")?.value).toBeCloseTo(50);
});

test("serialization retains the measurement definition and rebuilt values", () => {
    const { model, measured } = setup();
    const serialized = Serializer.serializeObject(measured);
    const restored = Serializer.deserializeObject(model, serialized) as MeasuredVariableNode;
    model.modelManager.rootNode.remove(measured);
    model.modelManager.addNode(restored);
    expect(restored.definition).toEqual(measured.definition);
    expect(model.variables.scope.get("Wall_Length")?.value).toBeCloseTo(50);
});

test("a measurement does not accept a source which depends on its own value through an alias", () => {
    const { model, sketch, measured } = setup();
    model.variables.setItems([{ id: "alias", name: "Alias", type: "length", expression: "#Wall_Length" }]);
    const data = sketch.data;
    data.constraints.push({
        id: 1,
        kind: ConstraintKind.P2PDistance,
        refs: [
            { entityId: 1, pointIndex: 0 },
            { entityId: 1, pointIndex: 1 },
        ],
        datum: "#Alias",
    });
    sketch.setDataEmitShapeChanged(data);
    expect(measured.result.isOk).toBe(false);
    expect(model.variables.evaluate().errors.get(measured.id)).toContain("Circular dependency");
    expect(model.variables.scope.has("Wall_Length")).toBe(false);
});

test("a measured solid boundary uses the kernel and follows deletion and undo", () => {
    const { model } = setup();
    const box = new EditableShapeNode({
        document: model,
        name: "Box",
        shape: factory.box(Plane.XY, 10, 20, 30),
    });
    model.modelManager.addNode(box);
    const measured = new MeasuredVariableNode({
        document: model,
        definition: {
            name: "Boundary",
            source: "measured",
            mode: "length",
            entities: [{ kind: "node", nodeId: box.id, label: "Box" }],
        },
    });
    model.modelManager.addNode(measured);
    expect(measured.result.unchecked()).toBeCloseTo(240);
    Transaction.execute(model, "delete box", () => model.modelManager.rootNode.remove(box));
    expect(model.variables.scope.has("Boundary")).toBe(false);
    model.history.undo();
    expect(model.variables.scope.get("Boundary")?.value).toBeCloseTo(240);
});

test("an angle variable is an angle in degrees and an area variable a plain number of mm²", () => {
    const { model, sketch } = setup();
    Transaction.execute(model, "add a perpendicular", () => {
        const data = sketch.data;
        data.entities.push({ id: 3, type: "line", params: [0, 0, -40, 30] });
        sketch.setDataEmitShapeChanged(data);
    });
    const refs: MeasurementReference[] = [
        { kind: "entity", nodeId: sketch.id, entityId: 1, label: "Edge of Sketch" },
        { kind: "entity", nodeId: sketch.id, entityId: 3, label: "Edge of Sketch" },
    ];
    const angle = new MeasuredVariableNode({
        document: model,
        definition: { name: "Corner", source: "measured", mode: "angle", entities: refs },
    });
    model.modelManager.addNode(angle);
    expect(angle.items[0]).toMatchObject({ type: "angle", expression: "90 deg" });
    expect(model.variables.scope.get("Corner")?.value).toBeCloseTo(90, 9);
    expect(angle.name).toBe("#Corner = 90 deg");

    const rect = factory.rect(Plane.XY, 20, 10);
    expect(rect.isOk).toBe(true);
    const face = new EditableShapeNode({ document: model, name: "Plate", shape: rect });
    model.modelManager.addNode(face);
    const area = new MeasuredVariableNode({
        document: model,
        definition: {
            name: "Plate_Area",
            source: "measured",
            mode: "area",
            entities: [{ kind: "node", nodeId: face.id, label: "Plate" }],
        },
    });
    model.modelManager.addNode(area);
    expect(area.items[0].type).toBe("unitless");
    expect(Number(area.items[0].expression)).toBeCloseTo(200, 6);
    expect(model.variables.scope.get("Plate_Area")?.value).toBeCloseTo(200, 9);

    // a component read in a frame follows that frame
    const point = new EditableShapeNode({
        document: model,
        name: "Pin",
        shape: factory.point(new XYZ(3, 4, 5)),
    });
    model.modelManager.addNode(point);
    const along = new MeasuredVariableNode({
        document: model,
        definition: {
            name: "Pin_Up",
            source: "measured",
            mode: "positionX",
            entities: [{ kind: "node", nodeId: point.id, label: "Pin" }],
            frame: { origin: XYZ.zero, xvec: XYZ.unitZ, yvec: XYZ.unitX, zvec: XYZ.unitY },
        },
    });
    model.modelManager.addNode(along);
    expect(model.variables.scope.get("Pin_Up")?.value).toBeCloseTo(5, 9);
    expect(
        JSON.parse(Serializer.serializeObject(along)["definitionJson"] as string).frame.xvec,
    ).toMatchObject({
        z: 1,
    });
});
