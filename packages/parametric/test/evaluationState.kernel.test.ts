// Part of the Chili3d Project, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

/**
 * The Part Studio evaluation adapter (core's `featureListEvaluation`) over a real body: a
 * failed rebuild is reported on its feature, the features after it are out of date, and the
 * body says it still shows the last successful result.
 */

import { readFileSync } from "node:fs";
import path from "node:path";
import { EVALUATION_READY, featureListEvaluation, nodeEvaluationState, Plane } from "@chili3d/core";
import { createMockApplication, createMockVisualWithDocument, TestDocument } from "@chili3d/core/test-utils";
import { initWasm, ShapeFactory } from "@chili3d/wasm";
import { rs } from "@rstest/core";
import { initGarlicSync, ParametricBodyNode, SketchNode } from "../src";

beforeAll(async () => {
    const root = path.resolve(import.meta.dirname, "../..");
    await initWasm({ wasmBinary: readFileSync(path.join(root, "wasm/lib/chili-wasm.wasm")) });
    rs.stubGlobal("shapeFactory", new ShapeFactory());
    initGarlicSync(readFileSync(path.join(root, "parametric/lib/garlic_bg.wasm")));
});

afterAll(() => {
    rs.unstubAllGlobals();
});

function square(document: TestDocument, size: number) {
    const sketch = new SketchNode({
        document,
        plane: Plane.XY,
        data: {
            entities: [
                { id: 1, type: "line", params: [0, 0, size, 0] },
                { id: 2, type: "line", params: [size, 0, size, size] },
                { id: 3, type: "line", params: [size, size, 0, size] },
                { id: 4, type: "line", params: [0, size, 0, 0] },
            ],
            constraints: [],
        },
    });
    document.modelManager.addNode(sketch);
    return sketch;
}

test("a failed feature, the features after it and the body's last good shape", () => {
    const document = new TestDocument({ application: createMockApplication() });
    document.visual = createMockVisualWithDocument(document);
    const base = square(document, 10);
    const boss = square(document, 4);
    const body = new ParametricBodyNode({
        document,
        features: [
            { id: "base", type: "extrude", sketchId: base.id, depth: 10 },
            { id: "boss", type: "extrude", sketchId: boss.id, depth: 20 },
        ],
    });
    document.modelManager.addNode(body);
    expect(body.shape.isOk).toBe(true);
    const healthy = featureListEvaluation(body);
    expect([...healthy.features.values()]).toEqual([EVALUATION_READY, EVALUATION_READY]);
    expect(healthy.node).toEqual(EVALUATION_READY);

    body.setFeatureParameter("base", "depth", "missingDepth");
    expect(body.showsLastGoodShape).toBe(true);
    const failed = featureListEvaluation(body, (item) => item.id);
    expect(failed.features.get("base")).toMatchObject({ kind: "failed", lastGoodShown: true, at: "base" });
    expect(failed.features.get("boss")?.kind).toBe("changed");
    expect(failed.node).toMatchObject({ kind: "failed", lastGoodShown: true, at: "base" });

    body.setFeatureParameter("base", "depth", 10);
    expect(body.showsLastGoodShape).toBe(false);
    expect(nodeEvaluationState(body)).toEqual(EVALUATION_READY);
    document.dispose();
});
