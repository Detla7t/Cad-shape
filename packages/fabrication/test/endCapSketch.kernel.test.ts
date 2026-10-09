// Part of the Chili3d Project, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

import { readFileSync } from "node:fs";
import path from "node:path";
import { FolderNode, findDocumentTemplate, type INode, Plane, Serializer } from "@chili3d/core";
import { createMockApplication, createMockVisualWithDocument, TestDocument } from "@chili3d/core/test-utils";
import { readDxf } from "@chili3d/drawing";
import type { SketchNode } from "@chili3d/parametric";
import { initWasm, ShapeFactory } from "@chili3d/wasm";
import { sketchProfiles } from "../../parametric/src/features/profileBuilder";
import { SketchSolver } from "../../parametric/src/sketch/solver";
import "../../parametric/test/sketch/setup";
import {
    addConfiguredEndCap,
    addEndCap,
    END_CAP_TEMPLATE,
    END_CAP_VARIABLES,
    EndCapDrawingNode,
    EndCapSketchNode,
    endCapSketchData,
    END_CAP_INPUT_NAMES as N,
    sketchFlatPattern,
} from "../src/app";
import { type EndCapParams, endCapPattern } from "../src/endcap/endCap";
import { sameGeometry } from "../src/geometry";

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

const regions = (node: SketchNode) => {
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

const flats = (node: SketchNode) => sketchFlatPattern(node.data, node.name).parts[0];
const matches = (node: SketchNode, params: EndCapParams) => {
    const pattern = endCapPattern(params);
    expect(pattern.isOk).toBe(true);
    if (!pattern.isOk) return false;
    const part = flats(node);
    return sameGeometry(
        [...part.outline, ...part.bendLines],
        pattern.value.parts.flatMap((p) => [...p.outline, ...p.bendLines]),
    );
};
const dofs = (doc: TestDocument, node: SketchNode) =>
    new SketchSolver(Plane.XY, node.data, doc.variables.evaluate().scope).dofs();

describe("the native End Cap Configurator", () => {
    test("adds the inputs, a Variables folder and two fully constrained sketches, one suppressed", () => {
        const doc = document();
        const cap = addEndCap(doc);
        expect(doc.variables.configurationInputs.map((input) => input.name)).toEqual([
            N.endcap,
            N.od,
            N.customOd,
            N.id,
            N.customId,
            N.wall,
            N.finishWall,
        ]);
        const [folder, plain, reducing] = children(doc);
        expect(folder).toBeInstanceOf(FolderNode);
        expect(folder.name).toBe("Variables");
        expect(cap.variables.map((v) => v.definition.name)).toEqual(END_CAP_VARIABLES.map((v) => v.name));
        expect(cap.variables.every((v) => v.parent === folder)).toBe(true);
        expect(cap.variables[0].name).toMatch(/^#duct_od = configure\(OD, .*…$/);
        expect(cap.variables[0].name.length).toBeLessThan(60);
        expect(cap.variables[2].name).toBe("#bend_radius = duct_od / 2");
        expect([plain, reducing]).toEqual([cap.plain, cap.reducing]);
        expect([cap.plain.name, cap.reducing.name]).toEqual(["End Cap", "Reducing End Cap"]);
        expect([cap.plain.suppressed, cap.reducing.suppressed]).toEqual([true, false]);
        expect([...doc.variables.evaluate().errors]).toEqual([]);
        expect([...doc.variables.evaluate().warnings]).toEqual([]);
        expect(doc.variables.evaluate().scope.get("duct_od")?.value).toBeCloseTo(9.625 * 25.4, 9);
        expect([dofs(doc, cap.plain), dofs(doc, cap.reducing)]).toEqual([0, 0]);
        expect(matches(cap.reducing, { reducing: true, od: 9.625, id: 6.625 })).toBe(true);
        expect(regions(cap.reducing)).toBe(4);
    });

    test("the Configurations panel switches sketches and re-solves them to every size asked", () => {
        const doc = document();
        const cap = addEndCap(doc);
        configure(doc, { [N.endcap]: true, [N.od]: '16"' });
        expect([cap.plain.suppressed, cap.reducing.suppressed]).toEqual([false, true]);
        expect(matches(cap.plain, { reducing: false, od: 16 })).toBe(true);
        expect(regions(cap.plain)).toBe(2);
        // Away and back with a large jump: the suppressed sketch waited where it was.
        configure(doc, { [N.endcap]: false, [N.od]: '24"', [N.id]: '4"' });
        expect(matches(cap.reducing, { reducing: true, od: 24, id: 4 })).toBe(true);
        configure(doc, { [N.wall]: true, [N.finishWall]: "1.5 in" });
        expect(matches(cap.reducing, { reducing: true, od: 24, id: 4, wallHeight: 1.5 })).toBe(true);
        configure(doc, { [N.od]: "Custom", [N.customOd]: "30 in", [N.id]: '23"' });
        expect(matches(cap.reducing, { reducing: true, od: 30, id: 23, wallHeight: 1.5 })).toBe(true);
    });

    test("a second end cap reuses the variables; one undo removes an insertion", () => {
        const doc = document();
        addEndCap(doc);
        const second = addEndCap(doc);
        expect(second.variables).toHaveLength(0);
        expect([...doc.variables.evaluate().warnings]).toEqual([]);
        expect(children(doc)).toHaveLength(5);
        doc.history.undo();
        expect(children(doc)).toHaveLength(3);
        doc.history.undo();
        expect(children(doc)).toHaveLength(0);
        expect(doc.variables.configurationInputs).toHaveLength(0);
    });

    test("saves and reloads its sketches with their expressions", () => {
        const doc = document();
        const cap = addEndCap(doc);
        configure(doc, { [N.od]: '24"', [N.id]: '4"' });
        const restored = Serializer.deserializeObject(
            doc,
            Serializer.serializeObject(cap.reducing),
        ) as SketchNode;
        expect(restored.data).toEqual(cap.reducing.data);
        expect(restored.suppression).toBe(cap.reducing.suppression);
        expect(restored.data.constraints.filter((c) => typeof c.datum === "string").length).toBeGreaterThan(
            20,
        );
    });
});

describe("the public End Cap template", () => {
    test("is the native Part Studio plus a DXF drawing of the sketch the configuration shows", async () => {
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
        const [, plain, reducing, drawing] = children(doc);
        expect(drawing).toBeInstanceOf(EndCapDrawingNode);
        const file = drawing as EndCapDrawingNode;
        expect(file.fileName).toBe("9.63in x 6.63in Reducing End Cap.dxf");
        expect(file.activeSketch()).toBe(reducing);

        configure(doc, { [N.endcap]: true, [N.od]: '16"' });
        expect(file.fileName).toBe("16in End Cap.dxf");
        expect(file.activeSketch()).toBe(plain);
        expect(matches(plain as SketchNode, { reducing: false, od: 16 })).toBe(true);
        // The file is the shown sketch's cut outline (the bend arc is construction).
        expect(readDxf(file.text).entities).toHaveLength(flats(plain as SketchNode).outline.length);
        const restored = Serializer.deserializeObject(
            doc,
            Serializer.serializeObject(file),
        ) as EndCapDrawingNode;
        expect(restored).toBeInstanceOf(EndCapDrawingNode);
        expect(restored.sketchIds).toBe(file.sketchIds);
    });
});
