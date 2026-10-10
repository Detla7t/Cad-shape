// Part of the Chili3d Project, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

/**
 * A recorded box (created, then edited) saved with the document, reloaded and replayed into
 * another document rebuilds the same solid on the real OCCT kernel.
 */

import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
    CommandRecorder,
    type IShape,
    Plane,
    type Result,
    readRecording,
    replayRecording,
    ShapeTypes,
    Transaction,
} from "@chili3d/core";
import { TestDocument } from "@chili3d/core/test-utils";
import { initWasm, ShapeFactory } from "@chili3d/wasm";
import { BoxNode } from "../src/bodys/box";

const WASM_BINARY = readFileSync(
    path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../wasm/lib/chili-wasm.wasm"),
);

beforeAll(async () => {
    await initWasm({ wasmBinary: WASM_BINARY });
    Object.defineProperty(globalThis, "shapeFactory", {
        value: new ShapeFactory(),
        writable: true,
        configurable: true,
    });
});

function ok<T>(result: Result<T>): T {
    expect(result.isOk ? "ok" : result.error).toBe("ok");
    return result.unchecked()!;
}

function extent(shape: IShape): number[] {
    const box = shape.boundingBox();
    return [box.min.x, box.min.y, box.min.z, box.max.x, box.max.y, box.max.z];
}

function boxes(document: TestDocument): BoxNode[] {
    return document.modelManager.findNodes((node) => node instanceof BoxNode) as BoxNode[];
}

describe("command recording on the kernel", () => {
    test("a recorded box create and edit replays to the same solid after a save round trip", () => {
        const source = new TestDocument();
        const recorder = CommandRecorder.of(source);
        recorder.start();
        try {
            const box = new BoxNode({ document: source, plane: Plane.XY, dx: 10, dy: 20, dz: 30 });
            Transaction.execute(source, "create.box", () => source.modelManager.addNode(box));
            Transaction.execute(source, "change dx property", () => {
                box.dx = 15;
            });
        } finally {
            recorder.stop();
        }
        expect(readRecording(source).steps.map((step) => step.name)).toEqual([
            "create.box",
            "change dx property",
        ]);
        const sourceShape = ok(boxes(source)[0].generateShape());
        expect(sourceShape.volume()).toBeCloseTo(15 * 20 * 30, 6);

        const target = new TestDocument();
        target.userData = JSON.parse(JSON.stringify(source.userData));
        const summary = ok(replayRecording(target));
        expect(summary.added).toBe(1);
        expect(summary.edited).toBe(1);
        expect(summary.skipped).toEqual([]);

        const [replayed] = boxes(target);
        expect(boxes(target)).toHaveLength(1);
        expect(replayed.dx).toBe(15);
        const shape = ok(replayed.generateShape());
        expect(shape.findSubShapes(ShapeTypes.solid)).toHaveLength(1);
        expect(shape.volume()).toBeCloseTo(sourceShape.volume(), 6);
        const expected = extent(sourceShape);
        for (const [index, value] of extent(shape).entries()) expect(value).toBeCloseTo(expected[index], 6);

        target.history.undo();
        expect(boxes(target)).toHaveLength(0);
        target.history.redo();
        expect(boxes(target)).toHaveLength(1);
        expect(ok(boxes(target)[0].generateShape()).volume()).toBeCloseTo(15 * 20 * 30, 6);
    });
});
