// Part of the Chili3d Project, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

import { readFileSync } from "node:fs";
import path from "node:path";
import { findDocumentTemplate, type INode, Serializer } from "@chili3d/core";
import { createMockApplication, createMockVisualWithDocument, TestDocument } from "@chili3d/core/test-utils";
import { DocumentFileNode } from "@chili3d/documents";
import { initWasm, ShapeFactory } from "@chili3d/wasm";
import { sketchProfiles } from "../../parametric/src/features/profileBuilder";
import "../../parametric/test/sketch/setup";
import {
    addConfiguredEndCap,
    END_CAP_TEMPLATE,
    EndCapSketchNode,
    endCapSketchData,
    END_CAP_INPUT_NAMES as N,
} from "../src/app";
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
    doc.visual = createMockVisualWithDocument(doc) as never;
    return doc;
}

function configure(doc: TestDocument, active: Record<string, string | boolean>) {
    doc.variables.setActiveConfiguration({ ...doc.variables.activeConfiguration, ...active });
}

const regions = (node: EndCapSketchNode) => {
    const profiles = sketchProfiles(node);
    expect(profiles.isOk).toBe(true);
    return profiles.value.outer.length;
};

const children = (doc: TestDocument) => {
    const nodes: INode[] = [];
    for (let node = doc.modelManager.rootNode.firstChild; node; node = node.nextSibling) nodes.push(node);
    return nodes;
};

describe("the configured end cap", () => {
    test('adds Onshape\'s configuration inputs and draws the default 9 5/8" x 6 5/8" reducer', () => {
        const doc = document();
        const node = addConfiguredEndCap(doc);
        expect(doc.variables.configurationInputs.map((input) => input.name)).toEqual([
            N.endcap,
            N.od,
            N.customOd,
            N.id,
            N.customId,
            N.wall,
            N.finishWall,
        ]);
        expect(node).toBeInstanceOf(EndCapSketchNode);
        expect(node.resolve().value).toEqual({ reducing: true, od: 9.625, id: 6.625, wallHeight: undefined });
        const expected = endCapSketchData({ reducing: true, od: 9.625, id: 6.625 });
        expect(node.data.entities).toEqual(expected.value.data.entities);
        expect(regions(node)).toBe(4);
        expect([node.size, node.outerDiameterLabel, node.innerDiameterLabel, node.wallHeightLabel]).toEqual([
            "9.63in x 6.63in Reducing End Cap",
            '9 5/8"',
            '6 5/8"',
            '2 7/8" (default)',
        ]);
    });

    test('follows the Configurations panel: Endcap and OD switch it to a plain 16" cap', () => {
        const doc = document();
        const node = addConfiguredEndCap(doc);
        configure(doc, { [N.endcap]: true, [N.od]: '16"' });
        expect(node.resolve().value).toEqual({ reducing: false, od: 16 });
        expect(regions(node)).toBe(2);
        expect([node.size, node.outerDiameterLabel, node.innerDiameterLabel, node.wallHeightLabel]).toEqual([
            "16in End Cap",
            '16"',
            "—",
            "—",
        ]);
        // The rim bend circle is the 16" duct: 203.2 mm in radius.
        const bend = node.data.entities.find((entity) => entity.construction);
        expect(bend?.type).toBe("arc");
        expect(bend && Math.abs(bend.params[2] + 203.2)).toBeLessThan(1e-9);
    });

    test("a second end cap reuses the inputs; one undo removes an insertion", () => {
        const doc = document();
        addConfiguredEndCap(doc);
        addConfiguredEndCap(doc);
        expect(doc.variables.configurationInputs).toHaveLength(7);
        expect(children(doc).filter((node) => node instanceof EndCapSketchNode)).toHaveLength(2);
        doc.history.undo();
        doc.history.undo();
        expect(children(doc)).toHaveLength(0);
        expect(doc.variables.configurationInputs).toHaveLength(0);
    });

    test("its values are editable expressions, undoable", () => {
        const doc = document();
        const node = addConfiguredEndCap(doc);
        node.innerDiameter = "4 in";
        expect(node.resolve().value).toMatchObject({ reducing: true, od: 9.625, id: 4 });
        expect(
            Math.min(
                ...node.data.entities
                    .filter((e) => e.type === "arc")
                    .map((e) => Math.hypot(e.params[2] - e.params[0], e.params[3] - e.params[1])),
            ),
        ).toBeCloseTo((2 - 3 / 32) * 25.4, 6);
        doc.history.undo();
        expect(node.resolve().value).toMatchObject({ id: 6.625 });
        expect(node.data.entities).toEqual(
            endCapSketchData({ reducing: true, od: 9.625, id: 6.625 }).value.data.entities,
        );
    });

    test("a configuration that cannot make a cap keeps the last drawing and flags the feature", () => {
        const doc = document();
        const node = addConfiguredEndCap(doc);
        const before = node.data.entities;
        configure(doc, { [N.od]: '5"', [N.id]: '9 5/8"' });
        expect(node.error).toContain("smaller than the outside diameter");
        expect(node.size).toMatch(/^⚠ .*smaller than the outside diameter/);
        expect(node.warningCount).toBe(1);
        expect(node.data.entities).toEqual(before);
        configure(doc, { [N.id]: '4"' });
        expect(node.error).toBeUndefined();
        expect(node.warningCount).toBe(0);
    });

    test("saves and reloads with its expressions, without redrawing", () => {
        const doc = document();
        const node = addConfiguredEndCap(doc);
        configure(doc, { [N.od]: '24"', [N.id]: '4"' });
        const restored = Serializer.deserializeObject(
            doc,
            Serializer.serializeObject(node),
        ) as EndCapSketchNode;
        expect(restored).toBeInstanceOf(EndCapSketchNode);
        expect(restored.values).toEqual(node.values);
        expect(restored.generatedFor).toBe(node.generatedFor);
        expect(restored.data).toEqual(node.data);
    });
});

describe("the public End Cap template", () => {
    test("is a configured Part Studio whose DXF drawing follows the configuration", async () => {
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
        expect(units).toMatchObject({ length: "in" });
        const doc = created!;
        const [cap, drawing] = children(doc);
        expect(cap).toBeInstanceOf(EndCapSketchNode);
        expect(drawing).toBeInstanceOf(DocumentFileNode);
        const file = drawing as DocumentFileNode;
        expect(file.fileName).toBe("9.63in x 6.63in Reducing End Cap.dxf");

        configure(doc, { [N.endcap]: true, [N.od]: '16"' });
        const expected = endCapDxf({ reducing: false, od: 16 });
        expect(file.fileName).toBe("16in End Cap.dxf");
        expect(file.text).toBe(expected.isOk ? expected.value.text : "");
    });
});
