// Part of the Chili3d Project, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

import { readFileSync } from "node:fs";
import path from "node:path";
import { findDocumentTemplate, type INode } from "@chili3d/core";
import { createMockApplication, createMockVisualWithDocument, TestDocument } from "@chili3d/core/test-utils";
import { DocumentFileNode } from "@chili3d/documents";
import { SketchNode } from "@chili3d/parametric";
import { initWasm, ShapeFactory } from "@chili3d/wasm";
import { sketchProfiles } from "../../parametric/src/features/profileBuilder";
import "../../parametric/test/sketch/setup";
import { END_CAP_TEMPLATE } from "../src/app";
import { addEndCapSketch, endCapSketchData } from "../src/app/endCapSketch";
import { endCapDxf } from "../src/endcap/batch";

beforeAll(async () => {
    await initWasm({
        wasmBinary: readFileSync(path.resolve(import.meta.dirname, "../../wasm/lib/chili-wasm.wasm")),
    });
    Object.defineProperty(globalThis, "shapeFactory", {
        value: new ShapeFactory(),
        writable: true,
        configurable: true,
    });
});

function document() {
    const doc = new TestDocument({ application: createMockApplication() });
    doc.visual = createMockVisualWithDocument(doc) as any;
    return doc;
}

describe("end cap sketches", () => {
    test.each([
        [{ reducing: false, od: 16 }, "16in End Cap", 2],
        [{ reducing: true, od: 9.625, id: 6.625 }, "9.63in x 6.63in Reducing End Cap", 4],
        [{ reducing: true, od: 5, id: 4 }, "5in x 4in Reducing End Cap", 4],
    ])("%o closes into one region per part", (params, name, parts) => {
        const doc = document();
        const sketch = addEndCapSketch(doc, params);
        expect(sketch.isOk).toBe(true);
        const node = sketch.value;
        expect(node).toBeInstanceOf(SketchNode);
        expect(node.name).toBe(name);
        expect(node.parent).toBe(doc.modelManager.rootNode);
        const profiles = sketchProfiles(node);
        expect(profiles.isOk).toBe(true);
        expect(profiles.value.outer).toHaveLength(parts);
    });

    test("is drawn in millimetres with the rim bend lines as construction", () => {
        const sketch = endCapSketchData({ reducing: false, od: 16 });
        expect(sketch.isOk).toBe(true);
        const { data } = sketch.value;
        const construction = data.entities.filter((e) => e.construction);
        expect(construction).toHaveLength(2);
        // [cx, cy, sx, sy, ex, ey]: the bend circle is the 16" duct, 203.2 mm in radius.
        expect(construction.every((e) => e.type === "arc" && Math.abs(e.params[2] + 203.2) < 1e-9)).toBe(
            true,
        );
        expect(data.entities.filter((e) => !e.construction)).toHaveLength(11);
    });

    test("an invalid cap adds nothing", () => {
        const doc = document();
        const result = addEndCapSketch(doc, { reducing: true, od: 6, id: 8 });
        expect(result.isOk).toBe(false);
        expect(doc.modelManager.rootNode.size()).toBe(0);
    });
});

describe("the public End Cap template", () => {
    test("is published and builds both sketches plus the reducer's DXF drawing", async () => {
        const app = createMockApplication();
        let created: TestDocument | undefined;
        let units: unknown;
        app.newDocument = async (_name, requested) => {
            units = requested;
            created = document();
            return created;
        };
        expect(findDocumentTemplate("end-cap-configurator")).toBe(END_CAP_TEMPLATE);
        expect(END_CAP_TEMPLATE.thumbnail).toMatch(/^data:image\/svg\+xml/);

        const result = await END_CAP_TEMPLATE.create(app);
        expect(result.isOk).toBe(true);
        expect(result.value).toBe(created);
        expect(units).toMatchObject({ length: "in" });
        const nodes: INode[] = [];
        for (let node = created!.modelManager.rootNode.firstChild; node; node = node.nextSibling)
            nodes.push(node);
        expect(nodes.map((node) => [node.name, node.visible])).toEqual([
            ["9.63in End Cap", false],
            ["9.63in x 6.63in Reducing End Cap", true],
            ["Reducing End Cap Drawing", true],
        ]);
        const drawing = nodes[2] as DocumentFileNode;
        expect(drawing).toBeInstanceOf(DocumentFileNode);
        expect(drawing.fileName).toBe("9.63in x 6.63in Reducing End Cap.dxf");
        const expected = endCapDxf({ reducing: true, od: 9.625, id: 6.625 });
        expect(expected.isOk).toBe(true);
        expect(drawing.text).toBe(expected.isOk ? expected.value.text : "");
    });
});
