// Part of the Chili3d Project, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

import { readFileSync } from "node:fs";
import path from "node:path";
import { EditableShapeNode, Matrix4, Plane, Result, Transaction } from "@chili3d/core";
import { createMockApplication, createMockVisualWithDocument, TestDocument } from "@chili3d/core/test-utils";
import { initGarlicSync, ParametricBodyNode, SketchNode } from "@chili3d/parametric";
import { initWasm, ShapeFactory } from "@chili3d/wasm";
import { rs } from "@rstest/core";
import {
    CamGenerator,
    type CamOperationHandler,
    CamStudioNode,
    type SetupData,
    type ToolpathData,
} from "../src";
import { registerCamOperation } from "../src/model/operation";

beforeAll(async () => {
    const root = path.resolve(import.meta.dirname, "../..");
    await initWasm({ wasmBinary: readFileSync(path.join(root, "wasm/lib/chili-wasm.wasm")) });
    rs.stubGlobal("shapeFactory", new ShapeFactory());
    initGarlicSync(readFileSync(path.join(root, "parametric/lib/garlic_bg.wasm")));
});

afterAll(() => {
    rs.unstubAllGlobals();
});

const cleanup: (() => void)[] = [];
afterEach(() => {
    for (const dispose of cleanup.splice(0).reverse()) dispose();
    rs.useRealTimers();
    rs.restoreAllMocks();
});

let nextType = 0;
function fixture(generate?: CamOperationHandler["generate"], autoRegenerate = false) {
    const document = new TestDocument({ application: createMockApplication() });
    document.visual = createMockVisualWithDocument(document);
    cleanup.push(() => document.dispose());
    const box = shapeFactory.box(Plane.XY, 10, 10, 10);
    expect(box.isOk).toBe(true);
    const part = new EditableShapeNode({ document, name: "Part", shape: box.value });
    document.modelManager.addNode(part);
    const type = `test.generator.${nextType++}`;
    registerCamOperation({
        type,
        label: "Test operation",
        category: "3d",
        machineKinds: ["mill"],
        defaults: () => ({}),
        parameters: () => [],
        generate:
            generate ??
            ((_operation, context) =>
                Result.ok({
                    toolId: context.tool.id,
                    moves: [{ kind: "rapid", to: [context.parts[0].boundingBox().max.x, 0, 5] }],
                })),
    });
    const setup: SetupData = {
        id: "setup",
        name: "Setup",
        machineId: "generic-3-axis",
        wcs: { origin: [0, 0, 0], xAxis: [1, 0, 0], zAxis: [0, 0, 1] },
        stock: { kind: "box", margin: { x: 0, y: 0, zTop: 0, zBottom: 0 } },
        partIds: [part.id],
        operations: [{ id: "op", type, name: "Operation", params: {} }],
    };
    const studio = new CamStudioNode({ document, setups: [setup] });
    document.modelManager.addNode(studio);
    const generator = new CamGenerator(studio, { autoRegenerate, debounceMs: 10 });
    cleanup.push(() => generator.dispose());
    const update = (patch: Partial<SetupData>) => studio.setSetups([{ ...studio.setups[0], ...patch }]);
    return { document, part, studio, generator, update };
}

function block(width: number) {
    const result = shapeFactory.box(Plane.XY, width, 10, 10);
    expect(result.isOk).toBe(true);
    return result;
}

function addBody(document: TestDocument) {
    const sketch = new SketchNode({
        document,
        plane: Plane.XY,
        data: {
            entities: [
                { id: 1, type: "line", params: [0, 0, 10, 0] },
                { id: 2, type: "line", params: [10, 0, 10, 10] },
                { id: 3, type: "line", params: [10, 10, 0, 10] },
                { id: 4, type: "line", params: [0, 10, 0, 0] },
            ],
            constraints: [],
        },
    });
    document.modelManager.addNode(sketch);
    const body = new ParametricBodyNode({
        document,
        features: [{ id: "extrude", type: "extrude", sketchId: sketch.id, depth: 10 }],
    });
    document.modelManager.addNode(body);
    expect(body.shape.isOk).toBe(true);
    return { body, sketch };
}

test("placement changes invalidate results and undo restores the matching result", async () => {
    const { document, part, generator } = fixture();
    expect((await generator.generateOperation("setup", "op")).state).toBe("ok");
    const original = generator.toolpath("op");
    expect(original?.moves).toHaveLength(1);
    Transaction.execute(document, "move", () => {
        part.transform = Matrix4.fromTranslation(100, 0, 0);
    });
    expect(generator.status("op").stale).toBe(true);
    expect(generator.toolpath("op")).toBeUndefined();
    expect(generator.lastToolpath("op")).toBe(original);
    expect(generator.post("setup").isOk).toBe(false);
    document.history.undo();
    expect(generator.toolpath("op")).toBe(original);
    expect(generator.post("setup").isOk).toBe(true);
});

test("ancestor placement changes are watched and trigger regeneration", async () => {
    rs.useFakeTimers();
    const { document, part, generator } = fixture(undefined, true);
    const parent = new ParametricBodyNode({ document, features: [] });
    document.modelManager.addNode(parent);
    part.parent?.transfer(part);
    parent.add(part);
    await generator.generateOperation("setup", "op");
    parent.transform = Matrix4.fromTranslation(30, 0, 0);
    expect(generator.status("op").stale).toBe(true);
    await rs.advanceTimersByTimeAsync(20);
    expect(generator.status("op").state).toBe("ok");
    expect(generator.status("op").stale).toBeUndefined();
});

test("deleted nodes and replacement instances update dependencies and watches", async () => {
    rs.useFakeTimers();
    const { document, part, generator } = fixture(undefined, true);
    await generator.generateOperation("setup", "op");
    part.parent?.remove(part);
    expect(generator.status("op").stale).toBe(true);
    expect(generator.post("setup").isOk).toBe(false);
    await rs.advanceTimersByTimeAsync(20);
    expect(generator.status("op").error).toContain("no longer in the document");
    const replacement = new EditableShapeNode({
        document,
        id: part.id,
        name: "Replacement",
        shape: block(20),
    });
    document.modelManager.addNode(replacement);
    await rs.advanceTimersByTimeAsync(20);
    expect(generator.status("op").state).toBe("ok");
    expect(generator.toolpath("op")?.moves[0]).toEqual({ kind: "rapid", to: [20, 0, 5] });
    replacement.transform = Matrix4.fromTranslation(1, 0, 0);
    expect(generator.status("op").stale).toBe(true);
    await rs.advanceTimersByTimeAsync(20);
    expect(generator.status("op").stale).toBeUndefined();
});

test("stock and picked-node placements invalidate the operation", async () => {
    const { document, generator, studio, update } = fixture();
    const stock = new EditableShapeNode({ document, name: "Stock", shape: block(30) });
    document.modelManager.addNode(stock);
    update({ stock: { kind: "body", nodeId: stock.id } });
    await generator.generateOperation("setup", "op");
    stock.transform = Matrix4.fromTranslation(1, 0, 0);
    expect(generator.post("setup").isOk).toBe(false);
    await generator.regenerateStale();
    update({
        operations: [
            { ...studio.setups[0].operations[0], selection: [{ kind: "face", nodeId: stock.id, index: 0 }] },
        ],
    });
    await generator.generateOperation("setup", "op");
    stock.transform = Matrix4.fromTranslation(2, 0, 0);
    expect(generator.status("op").stale).toBe(true);
});

test("a missing stock body fails instead of silently using the part bounds", async () => {
    const { generator, update } = fixture();
    update({ stock: { kind: "body", nodeId: "missing-stock" } });
    expect((await generator.generateOperation("setup", "op")).error).toContain("Stock missing-stock");
    expect(generator.post("setup").isOk).toBe(false);
});

test.each(["parameter", "upstream"])("a failed %s rebuild blocks last-good geometry", async (cause) => {
    const { document, generator, update } = fixture();
    const { body } = addBody(document);
    update({ partIds: [body.id] });
    await generator.generateOperation("setup", "op");
    if (cause === "parameter") body.setFeatureParameter("extrude", "depth", "missingDepth");
    else {
        document.variables.setItems([{ id: "depth", name: "depth", type: "length", expression: "10 mm" }]);
        body.setFeatureParameter("extrude", "depth", "depth");
        await generator.generateOperation("setup", "op");
        document.variables.setItems([]);
        body.applyVariables();
    }
    expect(body.featureItems()[0].error).toContain("Unknown identifier");
    expect(body.shape.isOk).toBe(true);
    expect(body.evaluationError).toContain("Unknown identifier");
    expect(generator.post("setup").isOk).toBe(false);
    const failed = await generator.generateOperation("setup", "op");
    expect(failed.state).toBe("error");
    expect(failed.error).toContain("failed to rebuild");
    body.setFeatureParameter("extrude", "depth", 10);
    expect(body.evaluationError).toBeUndefined();
    expect(body.shape.isOk).toBe(true);
    await generator.regenerateStale();
    expect(generator.post("setup").isOk).toBe(true);
});

test("temporary feature rollback cannot generate a manufacturing result", async () => {
    const { document, generator, update } = fixture();
    const { body } = addBody(document);
    update({ partIds: [body.id] });
    await generator.generateOperation("setup", "op");
    expect(body.setRollbackIndex(0)).toBe(true);
    expect(generator.post("setup").isOk).toBe(false);
    expect((await generator.generateOperation("setup", "op")).error).toContain("temporary feature rollback");
    expect(body.setRollbackIndex(undefined)).toBe(true);
    await generator.regenerateStale();
    expect(generator.post("setup").isOk).toBe(true);
});

test("a failed referenced body invalidates its downstream body and CAM", async () => {
    const { document, generator, update } = fixture();
    const { body: source, sketch } = addBody(document);
    const downstream = new ParametricBodyNode({
        document,
        features: [
            { id: "base", type: "extrude", sketchId: sketch.id, depth: 5 },
            { id: "copy", type: "boolean", operation: "fuse", toolIds: [source.id], consumeTools: false },
        ],
    });
    document.modelManager.addNode(downstream);
    expect(downstream.shape.isOk).toBe(true);
    update({ partIds: [downstream.id] });
    expect((await generator.generateOperation("setup", "op")).state).toBe("ok");
    source.setFeatureParameter("extrude", "depth", "missingDepth");
    expect(source.evaluationError).toContain("Unknown identifier");
    expect(downstream.evaluationError).toContain("failed to rebuild");
    expect(generator.post("setup").isOk).toBe(false);
    source.setFeatureParameter("extrude", "depth", 10);
    expect(downstream.evaluationError).toBeUndefined();
    await generator.regenerateStale();
    expect(generator.post("setup").isOk).toBe(true);
});

test("lost tracked picks never fall back to a different face at the previous index", async () => {
    const { document, generator, studio, update } = fixture();
    const { body } = addBody(document);
    update({
        partIds: [body.id],
        operations: [
            {
                ...studio.setups[0].operations[0],
                selection: [{ kind: "face", nodeId: body.id, id: "deleted-face", index: 0 }],
            },
        ],
    });
    expect((await generator.generateOperation("setup", "op")).error).toContain("no longer exists");
    expect(generator.post("setup").isOk).toBe(false);
});

test("an edit during async generation cannot publish old output as current", async () => {
    const entered = Promise.withResolvers<void>();
    const resume = Promise.withResolvers<void>();
    let signal: AbortSignal | undefined;
    const { part, generator } = fixture(async (_operation, context) => {
        signal = context.signal;
        const x = context.parts[0].boundingBox().max.x;
        entered.resolve();
        await resume.promise;
        return Result.ok({ toolId: context.tool.id, moves: [{ kind: "rapid", to: [x, 0, 5] }] });
    });
    const running = generator.generateOperation("setup", "op");
    await entered.promise;
    part.shape = block(20);
    expect(signal?.aborted).toBe(true);
    resume.resolve();
    const status = await running;
    expect(status.stale).toBe(true);
    expect(generator.toolpath("op")).toBeUndefined();
    expect(generator.lastToolpath("op")).toBeUndefined();
    expect(generator.post("setup").isOk).toBe(false);
    await generator.regenerateStale();
    expect(generator.post("setup").isOk).toBe(true);
});

test("lazy selected geometry is captured before an asynchronous handler yields", async () => {
    const entered = Promise.withResolvers<void>();
    const resume = Promise.withResolvers<void>();
    let afterYield = Number.NaN;
    const { document, generator, studio, update } = fixture(async (_operation, context) => {
        entered.resolve();
        await resume.promise;
        afterYield = context.selectedFaces()[0].boundingBox().max.x;
        return Result.ok({ toolId: context.tool.id, moves: [] });
    });
    const picked = new EditableShapeNode({ document, name: "Picked", shape: block(10) });
    document.modelManager.addNode(picked);
    update({
        operations: [{ ...studio.setups[0].operations[0], selection: [{ kind: "body", nodeId: picked.id }] }],
    });
    const running = generator.generateOperation("setup", "op");
    await entered.promise;
    picked.transform = Matrix4.fromTranslation(100, 0, 0);
    resume.resolve();
    await running;
    expect(afterYield).toBeLessThan(11);
    expect(generator.post("setup").isOk).toBe(false);
});

test.each([
    "cancel",
    "dispose",
    "studio",
    "delete",
    "suppress",
])("%s prevents a pending job publishing", async (action) => {
    const entered = Promise.withResolvers<void>();
    const resume = Promise.withResolvers<void>();
    let signal: AbortSignal | undefined;
    const { studio, generator, update } = fixture(async (_operation, context) => {
        signal = context.signal;
        entered.resolve();
        await resume.promise;
        return Result.ok({ toolId: context.tool.id, moves: [] });
    });
    const running = generator.generateOperation("setup", "op");
    await entered.promise;
    if (action === "cancel") generator.cancelOperation("op");
    if (action === "dispose") generator.dispose();
    if (action === "studio") studio.dispose();
    if (action === "delete") update({ operations: [] });
    if (action === "suppress")
        update({ operations: [{ ...studio.setups[0].operations[0], suppressed: true }] });
    expect(signal?.aborted).toBe(true);
    resume.resolve();
    await running;
    expect(generator.lastToolpath("op")).toBeUndefined();
    expect(generator.post("setup").isOk).toBe(false);
});

test("a superseded job cannot overwrite the newer successful generation", async () => {
    const first = Promise.withResolvers<Result<ToolpathData>>();
    let calls = 0;
    const { generator } = fixture((_operation, context) =>
        ++calls === 1
            ? first.promise
            : Result.ok({
                  toolId: context.tool.id,
                  moves: [{ kind: "rapid", to: [20, 0, 5] }],
              }),
    );
    const older = generator.generateOperation("setup", "op");
    await generator.generateOperation("setup", "op");
    first.resolve(Result.ok({ toolId: "default", moves: [{ kind: "rapid", to: [10, 0, 5] }] }));
    await older;
    expect(generator.toolpath("op")?.moves).toEqual([{ kind: "rapid", to: [20, 0, 5] }]);
    expect(generator.status("op").state).toBe("ok");
});
