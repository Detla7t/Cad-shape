// Part of the Chili3d Project, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
    type AsyncController,
    type I18nKeys,
    type IFace,
    type INode,
    type INodeVisual,
    Plane,
    ShapeTypes,
    type VisualShapeData,
    XYZ,
} from "@chili3d/core";
import { createMockApplication, createMockVisualWithDocument, TestDocument } from "@chili3d/core/test-utils";
import { initWasm, ShapeFactory } from "@chili3d/wasm";
import { rs } from "@rstest/core";
import { LoftFeatureCommand } from "../src/commands/loftCommand";
import type { LoftFeatureData } from "../src/features/feature";
import { ParametricBodyNode } from "../src/parametricBodyNode";
import type { SketchData } from "../src/sketch/sketchModel";
import { SketchNode } from "../src/sketch/sketchNode";
import "./sketch/setup";

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

const circle = (r: number): SketchData => ({
    entities: [{ id: 1, type: "circle", params: [0, 0, r] }],
    constraints: [],
});
const square = (half: number): SketchData => ({
    entities: [
        { id: 1, type: "line", params: [-half, -half, half, -half] },
        { id: 2, type: "line", params: [half, -half, half, half] },
        { id: 3, type: "line", params: [half, half, -half, half] },
        { id: 4, type: "line", params: [-half, half, -half, -half] },
    ],
    constraints: [],
});

function setup() {
    const app = createMockApplication();
    const doc = new TestDocument({ application: app });
    doc.visual = createMockVisualWithDocument(doc) as any;
    (app as any).activeView = { document: doc, dom: document.createElement("div") };
    const bottom = new SketchNode({ document: doc, plane: Plane.XY, data: circle(20) });
    const top = new SketchNode({
        document: doc,
        plane: new Plane({ origin: new XYZ({ x: 0, y: 0, z: 50 }), normal: XYZ.unitZ, xvec: XYZ.unitX }),
        data: square(15),
    });
    doc.modelManager.addNode(bottom);
    doc.modelManager.addNode(top);
    return { app, doc, bottom, top };
}

function faceOf(doc: TestDocument, sketch: SketchNode): VisualShapeData {
    const range = sketch.mesh.faces!.range.find((x) => x.shape.shapeType === ShapeTypes.face)!;
    return {
        shape: range.shape as unknown as IFace,
        owner: { node: sketch } as unknown as INodeVisual,
        transform: sketch.worldTransform(),
        indexes: [0],
    };
}

const tick = () => new Promise<void>((resolve) => setTimeout(resolve, 0));
const panel = () => document.querySelector<HTMLElement>('[aria-label="Loft feature"]');
const labels = () =>
    [...(panel()?.querySelectorAll('[role="listitem"] > span') ?? [])].map((x) => x.textContent);

function loftBodies(doc: TestDocument): ParametricBodyNode[] {
    return doc.modelManager
        .findNodes()
        .filter((n): n is ParametricBodyNode => n instanceof ParametricBodyNode);
}

describe("LoftFeatureCommand", () => {
    afterEach(() => {
        document.body.replaceChildren();
    });

    test("profiles picked in the viewport build an editable loft feature on accept", async () => {
        const { app, doc, bottom, top } = setup();
        const faces = [faceOf(doc, bottom), faceOf(doc, top)];
        let controller: AsyncController | undefined;
        doc.picker.pickShape = rs.fn((_prompt: I18nKeys, c: AsyncController) => {
            controller = c;
            const next = faces.shift();
            if (next) {
                c.success();
                return Promise.resolve([next]);
            }
            return new Promise<VisualShapeData[]>((resolve) => {
                c.onCompleted(() => resolve([]));
                c.onCancelled(() => resolve([]));
            });
        });
        const command = new LoftFeatureCommand();
        const run = command.execute(app as any);
        await tick();
        await tick();
        expect(labels()).toEqual([`Face of ${bottom.name}`, `Face of ${top.name}`]);
        const accept = panel()!.querySelector<HTMLButtonElement>('[aria-label="Accept loft"]')!;
        expect(accept.disabled).toBe(false);
        accept.click();
        await run;
        expect(controller?.result?.status).toBe("success");
        const [body] = loftBodies(doc);
        expect(body).not.toBeUndefined();
        const feature = body.features[0] as LoftFeatureData;
        expect(feature.type).toBe("loft");
        expect(feature.sections.map((s) => s.sketchId)).toEqual([bottom.id, top.id]);
        expect(feature.sections.every((s) => s.profile !== undefined)).toBe(true);
        expect(body.shape.isOk).toBe(true);
        expect(body.shape.value.volume()).toBeGreaterThan(900 * 50);
        expect(bottom.visible).toBe(false);
        expect(top.visible).toBe(false);
        expect(panel()).toBeNull();
    });

    test("pre-selected sketches seed the profiles; cancel leaves no body", async () => {
        const { app, doc, bottom, top } = setup();
        doc.selection.getSelectedNodes = () => [bottom, top];
        let controller: AsyncController | undefined;
        doc.picker.pickShape = rs.fn((_prompt: I18nKeys, c: AsyncController) => {
            controller = c;
            return new Promise<VisualShapeData[]>((resolve) => {
                c.onCancelled(() => resolve([]));
                c.onCompleted(() => resolve([]));
            });
        });
        const command = new LoftFeatureCommand();
        const run = command.execute(app as any);
        await tick();
        expect(labels()).toHaveLength(2);
        controller!.cancel();
        await run;
        expect(loftBodies(doc)).toHaveLength(0);
        expect(bottom.visible).toBe(true);
        expect(panel()).toBeNull();
    });

    test("sketches clicked in the feature tree join the list; reorder and remove controls work", async () => {
        const { app, doc, bottom, top } = setup();
        let controller: AsyncController | undefined;
        doc.picker.pickShape = rs.fn((_prompt: I18nKeys, c: AsyncController) => {
            controller = c;
            return new Promise<VisualShapeData[]>((resolve) => {
                c.onCancelled(() => resolve([]));
                c.onCompleted(() => resolve([]));
            });
        });
        const command = new LoftFeatureCommand();
        const run = command.execute(app as any);
        await tick();
        expect(panel()!.querySelector<HTMLButtonElement>('[aria-label="Accept loft"]')!.disabled).toBe(true);
        doc.selection.onNodeChanged.emit([bottom as INode]);
        doc.selection.onNodeChanged.emit([top as INode]);
        // a second click on the same sketch is not a second section
        doc.selection.onNodeChanged.emit([top as INode]);
        expect(command.sectionLabels).toHaveLength(2);
        expect(command.previewError).toBe("");
        panel()!.querySelector<HTMLButtonElement>('[aria-label="Reverse profile order"]')!.click();
        const feature = () => (command as any).buildFeature() as LoftFeatureData;
        expect(feature().sections.map((s) => s.sketchId)).toEqual([top.id, bottom.id]);
        panel()!.querySelector<HTMLButtonElement>(`[aria-label="Move Face of ${top.name} down"]`)!.click();
        expect(feature().sections.map((s) => s.sketchId)).toEqual([bottom.id, top.id]);
        panel()!.querySelector<HTMLButtonElement>(`[aria-label="Remove Face of ${top.name}"]`)!.click();
        expect(command.sectionLabels).toHaveLength(1);
        expect(panel()!.querySelector<HTMLButtonElement>('[aria-label="Accept loft"]')!.disabled).toBe(true);
        controller!.cancel();
        await run;
        expect(loftBodies(doc)).toHaveLength(0);
    });
});
