// Part of the Chili3d Project, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

import { readFileSync } from "node:fs";
import path from "node:path";
import { Document } from "@chili3d/app";
import { AssemblyNode, DetachedDocument } from "@chili3d/assembly";
import { Matrix4, MultiShapeNode, Plane } from "@chili3d/core";
import { createMockApplication } from "@chili3d/core/test-utils";
import {
    ConstraintKind,
    FeatureStudioNode,
    initGarlicSync,
    ParametricBodyNode,
    SketchNode,
} from "@chili3d/parametric";
import { initWasm, ShapeFactory } from "@chili3d/wasm";
import { rs } from "@rstest/core";
import { validateModel } from "../src/modelValidation";

const documents: Document[] = [];

beforeAll(async () => {
    initGarlicSync(readFileSync(path.resolve(import.meta.dirname, "../../parametric/lib/garlic_bg.wasm")));
    await initWasm({
        wasmBinary: readFileSync(path.resolve(import.meta.dirname, "../../wasm/lib/chili-wasm.wasm")),
    });
    rs.stubGlobal("shapeFactory", new ShapeFactory());
});

afterEach(() => {
    for (const document of documents.splice(0)) document.dispose();
    rs.restoreAllMocks();
});

afterAll(() => {
    rs.unstubAllGlobals();
});

function model(depth: number | string = 10) {
    const document = new Document(createMockApplication(), "Validation fixture");
    documents.push(document);
    const sketch = new SketchNode({
        document,
        plane: Plane.XY,
        data: {
            entities: [{ id: 1, type: "circle", params: [0, 0, 2] }],
            constraints: [],
        },
    });
    document.modelManager.addNode(sketch);
    const body = new ParametricBodyNode({
        document,
        features: [{ id: "extrude", type: "extrude", sketchId: sketch.id, depth }],
    });
    document.modelManager.addNode(body);
    return { document, sketch, body };
}

test("cold rebuild and save/reopen checks preserve the live model, native shapes and history", async () => {
    const { document, body } = model();
    const shape = body.shape.value;
    expect(shape.volume()).toBeCloseTo(40 * Math.PI, 6);
    const dispose = rs.spyOn(shape, "dispose");
    const before = structuredClone(document.serialize());
    const report = await validateModel(document);
    expect(report.status).toBe("passed");
    expect(report.sourceChanged).toBe(false);
    expect(report.cases).toHaveLength(1);
    expect(report.cases[0].roundTripChecked).toBe(true);
    expect(report.cases[0].shapes.find((item) => item.nodeId === body.id)?.volume).toBeCloseTo(
        40 * Math.PI,
        6,
    );
    expect(report.cases[0].issues.some((issue) => issue.code === "sketch-dof")).toBe(true);
    expect(document.serialize()).toEqual(before);
    expect(body.shape.value).toBe(shape);
    expect(dispose).not.toHaveBeenCalled();
});

test("checks every discrete configuration and exposes a failure hidden by the current one", async () => {
    const { document, body } = model('configure(Size, "Small": 10)');
    document.variables.setConfigurationInputs(
        [
            {
                kind: "list",
                id: "size",
                name: "Size",
                options: [
                    { id: "small", name: "Small" },
                    { id: "large", name: "Large" },
                ],
            },
        ],
        { Size: "Small" },
    );
    expect(body.shape.isOk).toBe(true);
    expect(body.evaluationError).toBeUndefined();
    const report = await validateModel(document);
    expect(report.status).toBe("failed");
    expect(report.coverage).toBe("discrete");
    expect(report.cases).toHaveLength(2);
    const large = report.cases.find((item) => item.configuration["Size"] === "Large");
    expect(large?.issues.some((issue) => issue.severity === "error" && issue.nodeId === body.id)).toBe(true);
    expect(document.variables.activeConfiguration).toEqual({ Size: "Small" });
    expect(body.evaluationError).toBeUndefined();
});

test("detached linked-source loading retains saved configuration inputs and active values", async () => {
    const { document, body } = model("Thickness");
    document.variables.setConfigurationInputs(
        [{ kind: "variable", id: "thickness", name: "Thickness", type: "length", defaultExpression: "4" }],
        { Thickness: "12" },
    );
    expect(body.shape.value.volume()).toBeCloseTo(48 * Math.PI, 6);
    const copy = await DetachedDocument.load(document.application, structuredClone(document.serialize()));
    try {
        const rebuilt = copy.modelManager.findNode((node) => node.id === body.id) as ParametricBodyNode;
        expect(rebuilt.shape.value.volume()).toBeCloseTo(48 * Math.PI, 6);
        expect(copy.serialize()["configuration"]).toEqual(document.serialize()["configuration"]);
    } finally {
        copy.dispose();
    }
});

test("re-solves stored sketch coordinates before accepting downstream geometry", async () => {
    const { document, sketch, body } = model();
    sketch.setDataEmitShapeChanged({
        entities: [{ id: 1, type: "circle", params: [0, 0, 2] }],
        constraints: [
            { id: 2, kind: ConstraintKind.Radius, refs: [{ entityId: 1, pointIndex: 0 }], datum: 3 },
        ],
    });
    const before = structuredClone(document.serialize());
    const report = await validateModel(document);
    expect(report.status).toBe("passed");
    expect(report.cases[0].shapes.find((item) => item.nodeId === body.id)?.volume).toBeCloseTo(
        90 * Math.PI,
        5,
    );
    expect(document.serialize()).toEqual(before);
});

test("rejects conflicting sketch constraints even when their stored coordinates make a solid", async () => {
    const { document, sketch, body } = model();
    sketch.setDataEmitShapeChanged({
        entities: [{ id: 1, type: "circle", params: [0, 0, 2] }],
        constraints: [
            { id: 2, kind: ConstraintKind.Radius, refs: [{ entityId: 1, pointIndex: 0 }], datum: 2 },
            { id: 3, kind: ConstraintKind.Radius, refs: [{ entityId: 1, pointIndex: 0 }], datum: 4 },
        ],
    });
    expect(body.shape.isOk).toBe(true);
    const report = await validateModel(document);
    expect(report.status).toBe("failed");
    expect(
        report.cases[0].issues.some((issue) => issue.code === "sketch-solve" && issue.severity === "error"),
    ).toBe(true);
});

test("rejects unresolved dimension expressions instead of accepting their previous numeric geometry", async () => {
    const { document, sketch } = model();
    sketch.setDataEmitShapeChanged({
        entities: [{ id: 1, type: "circle", params: [0, 0, 2] }],
        constraints: [
            {
                id: 2,
                kind: ConstraintKind.Radius,
                refs: [{ entityId: 1, pointIndex: 0 }],
                datum: "MissingRadius",
            },
        ],
    });
    const report = await validateModel(document);
    expect(report.status).toBe("failed");
    expect(
        report.cases[0].issues.some((issue) => issue.code === "sketch-datum" && issue.itemId === "2"),
    ).toBe(true);
});

test("samples numeric configuration boundaries and reports their coverage honestly", async () => {
    const { document } = model("Thickness");
    document.variables.setConfigurationInputs(
        [
            {
                kind: "variable",
                id: "thickness",
                name: "Thickness",
                type: "length",
                defaultExpression: "4",
                min: 0,
                max: 20,
            },
        ],
        { Thickness: "4" },
    );
    const report = await validateModel(document);
    expect(report.status).toBe("failed");
    expect(report.coverage).toBe("sampled");
    expect(report.cases.map((item) => item.configuration["Thickness"])).toEqual(["4", "0", "20"]);
    expect(report.cases[1].issues.some((issue) => issue.severity === "error")).toBe(true);
});

test("a case limit is incomplete rather than a passing full validation", async () => {
    const { document } = model();
    document.variables.setConfigurationInputs(
        [{ kind: "checkbox", id: "extra", name: "Extra", defaultValue: false }],
        { Extra: false },
    );
    const report = await validateModel(document, { maxCases: 1 });
    expect(report.status).toBe("incomplete");
    expect(report.cases).toHaveLength(1);
    expect(report.issues.map((issue) => issue.code)).toContain("case-limit");
});

test("cancelled validation cannot pass", async () => {
    const { document } = model();
    const controller = new AbortController();
    controller.abort();
    const report = await validateModel(document, { signal: controller.signal });
    expect(report.status).toBe("incomplete");
    expect(report.cases).toHaveLength(0);
    expect(report.issues.map((issue) => issue.code)).toContain("cancelled");
});

test.each([
    false,
    true,
])("re-solves assembly mates with both instances grounded: %s", async (bothGrounded) => {
    const { document, body } = model();
    const assembly = new AssemblyNode({
        document,
        instances: [
            {
                id: "a",
                name: "Fixed",
                source: { kind: "part", nodeId: body.id },
                transform: Matrix4.identity().toArray(),
                grounded: true,
            },
            {
                id: "b",
                name: "Moved",
                source: { kind: "part", nodeId: body.id },
                transform: Matrix4.fromTranslation(10, 0, 0).toArray(),
                grounded: bothGrounded,
            },
        ],
        mates: [
            {
                id: "mate",
                name: "Fastened",
                type: "fastened",
                flipped: true,
                a: { instanceId: "a", origin: [0, 0, 0], zAxis: [0, 0, 1], xAxis: [1, 0, 0] },
                b: { instanceId: "b", origin: [0, 0, 0], zAxis: [0, 0, 1], xAxis: [1, 0, 0] },
            },
        ],
    });
    document.modelManager.addNode(assembly);
    const before = assembly.instancesJson;
    const report = await validateModel(document);
    expect(report.status).toBe(bothGrounded ? "failed" : "passed");
    expect(report.cases[0].issues.some((issue) => issue.code === "assembly-solve")).toBe(bothGrounded);
    expect(assembly.instancesJson).toBe(before);
});

test("compiles Feature Studios afresh, including a broken studio not yet used by a body", async () => {
    const { document } = model();
    const studio = new FeatureStudioNode({ document, source: "export const broken = missingFunction();" });
    document.modelManager.addNode(studio);
    const report = await validateModel(document);
    expect(report.status).toBe("failed");
    expect(
        report.cases[0].issues.some((issue) => issue.code === "featurescript" && issue.nodeId === studio.id),
    ).toBe(true);
});

test("edits during validation make the captured report incomplete for the live model", async () => {
    const { document } = model();
    const validating = validateModel(document);
    document.name = "Edited while checking";
    const report = await validating;
    expect(report.status).toBe("incomplete");
    expect(report.sourceChanged).toBe(true);
    expect(report.issues.map((issue) => issue.code)).toContain("source-changed");
});

test("unsupported geometry is reported instead of being silently counted as validated", async () => {
    const { document } = model();
    document.modelManager.addNode(
        new MultiShapeNode({ document, name: "Unsupported shape group", shapes: [] }),
    );
    const report = await validateModel(document);
    expect(report.status).toBe("incomplete");
    expect(report.cases[0].issues.some((issue) => issue.code === "unsupported-geometry")).toBe(true);
});
