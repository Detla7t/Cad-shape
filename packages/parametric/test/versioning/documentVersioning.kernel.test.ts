// Part of the Chili3d Project, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

/**
 * Version control on live documents with real geometry: microversions per edit, branches,
 * a merge that combines a parameter edit with an added feature, restoring an old version, and
 * the history surviving a save and reopen.
 */

import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
    BoundingBox,
    DocumentVersionControl,
    FolderNode,
    type IEdge,
    type IFace,
    type IStorage,
    type IVisual,
    NodeUtils,
    Plane,
    readTree,
    Serializer,
    ShapeTypes,
    StorageHistoryPersistence,
    snapshotToSerialized,
    Transaction,
} from "@chili3d/core";
import { createMockApplication, createMockVisualWithDocument, TestDocument } from "@chili3d/core/test-utils";
import { initWasm, ShapeFactory } from "@chili3d/wasm";
import { captureEdgeRef } from "../../src/features/edgeRef";
import type { FeatureData } from "../../src/features/feature";
import { captureProfileRef } from "../../src/features/profileRef";
import { FeatureStudioNode } from "../../src/featurescript/featureStudioNode";
import { ParametricBodyNode } from "../../src/parametricBodyNode";
import { ConstraintKind, type SketchData } from "../../src/sketch/sketchModel";
import { SketchNode } from "../../src/sketch/sketchNode";
import "../../src/versioning";
import "../sketch/setup";

const WASM_BINARY = readFileSync(
    path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../wasm/lib/chili-wasm.wasm"),
);

beforeAll(async () => {
    await initWasm({ wasmBinary: WASM_BINARY });
    Object.defineProperty(globalThis, "shapeFactory", {
        value: new ShapeFactory(),
        writable: true,
        configurable: true,
    });
});

const SIZE = 40;
/** Area a radius-r fillet removes from a right-angle corner, per unit of edge length. */
const FILLET_LOSS = (r: number) => r * r - (Math.PI * r * r) / 4;
/** A box with one vertical edge filleted (r = 2) and optionally one top edge chamfered (d = 2). */
const expectedVolume = (depth: number, chamfered: boolean) =>
    SIZE * SIZE * depth - FILLET_LOSS(2) * depth - (chamfered ? 2 * SIZE : 0);

const rect = (size: number): SketchData => ({
    entities: [
        { id: 1, type: "line", params: [0, 0, size, 0] },
        { id: 2, type: "line", params: [size, 0, size, size] },
        { id: 3, type: "line", params: [size, size, 0, size] },
        { id: 4, type: "line", params: [0, size, 0, 0] },
    ],
    constraints: [],
    entityIdSeq: 5,
});

function newDoc(id: string): TestDocument {
    const doc = new TestDocument({ application: createMockApplication() });
    doc.id = id;
    doc.name = "Part Studio";
    doc.visual = createMockVisualWithDocument(doc) as unknown as IVisual;
    doc.modelManager.rootNode = new FolderNode({ document: doc, name: doc.name, id: `${id}-root` });
    return doc;
}

const settle = () => new Promise<void>((resolve) => setTimeout(resolve, 0));
const round = (x: number) => Math.round(x * 1e6) / 1e6;

function edgeAt(body: ParametricBodyNode, center: [number, number, number]): IEdge {
    const edges = body.shape.unchecked()!.findSubShapes(ShapeTypes.edge) as IEdge[];
    const edge = edges.find((e) => {
        const c = BoundingBox.center(e.boundingBox());
        return round(c.x) === center[0] && round(c.y) === center[1] && round(c.z) === center[2];
    });
    expect(edge).toBeDefined();
    return edge!;
}

function body(doc: TestDocument): ParametricBodyNode {
    return doc.modelManager.findNode((n) => n instanceof ParametricBodyNode) as ParametricBodyNode;
}

function volume(doc: TestDocument): number {
    return body(doc).shape.unchecked()!.volume();
}

function edit(doc: TestDocument, name: string, change: (features: FeatureData[]) => FeatureData[]) {
    const target = body(doc);
    Transaction.execute(doc, name, () => target.setFeaturesEmitShapeChanged(change(target.features)));
}

function expectClean(doc: TestDocument) {
    const errors = body(doc)
        .featureItems()
        .filter((x) => x.error !== undefined)
        .map((x) => `${x.id}: ${x.error}`);
    expect(errors).toEqual([]);
}

/** Sketch + extrude (depth 10) + fillet on the vertical edge at the origin, one transaction each. */
async function buildPart(doc: TestDocument) {
    const sketch = new SketchNode({ document: doc, plane: Plane.XY, data: rect(SIZE) });
    Transaction.execute(doc, "create sketch", () => {
        sketch.name = "Sketch 1";
        doc.modelManager.addNode(sketch);
    });
    await settle();
    const profiles = sketch.mesh.faces?.range.filter((x) => x.shape.shapeType === ShapeTypes.face) ?? [];
    const part = new ParametricBodyNode({
        document: doc,
        id: "part",
        features: [
            {
                id: "e1",
                type: "extrude",
                sketchId: sketch.id,
                depth: 10,
                profiles: [captureProfileRef(profiles[0].shape as unknown as IFace)],
            },
        ],
    });
    Transaction.execute(doc, "extrude", () => {
        part.name = "Part 1";
        doc.modelManager.addNode(part);
    });
    await settle();
    const edge = edgeAt(part, [0, 0, 5]);
    edit(doc, "fillet", (features) => [
        ...features,
        { id: "f1", type: "fillet", radius: 2, edges: [captureEdgeRef(edge)] },
    ]);
    await settle();
    expectClean(doc);
    expect(volume(doc)).toBeCloseTo(expectedVolume(10, false), 1);
}

describe("document version control (kernel)", () => {
    let doc: TestDocument;
    let vc: DocumentVersionControl;

    beforeEach(async () => {
        doc = newDoc("kernel-doc");
        vc = await DocumentVersionControl.attach(doc);
    });

    afterEach(() => {
        vc.dispose();
        doc.dispose();
    });

    test("each sketch commit exposes dimensions, constraint changes, deletion and dragged geometry", async () => {
        const sketch = new SketchNode({
            document: doc,
            plane: Plane.XY,
            data: {
                entities: [
                    { id: 1, type: "circle", params: [0, 0, 10] },
                    { id: 2, type: "line", params: [30, 0, 30, 20] },
                ],
                constraints: [
                    { id: 1, kind: ConstraintKind.Radius, refs: [{ entityId: 1, pointIndex: 0 }], datum: 10 },
                    { id: 2, kind: ConstraintKind.Vertical, refs: [{ entityId: 2, pointIndex: 0 }] },
                ],
            },
        });
        Transaction.execute(doc, "create sketch", () => doc.modelManager.addNode(sketch));
        await settle();
        const initial = sketch.data;
        const originalCommit = vc.head;
        const change = async (name: string, edit: (data: SketchData) => void) => {
            const data = sketch.data;
            edit(data);
            Transaction.execute(doc, name, () => sketch.setDataEmitShapeChanged(data));
            await settle();
            const commit = vc.headCommit();
            return vc.diff(commit.parents[0], vc.head).nodes.find((n) => n.id === sketch.id)!.changes;
        };
        const dimension = await change("edit radius", (data) => {
            data.constraints[0].datum = 12;
            data.entities[0].params[2] = 12;
        });
        expect(dimension).toEqual(
            expect.arrayContaining([
                expect.objectContaining({ kind: "changed", id: "1", label: "Radius constraint 1" }),
            ]),
        );
        const constraint = await change("change constraint", (data) => {
            data.constraints[1].kind = ConstraintKind.Horizontal;
            data.entities[1].params = [30, 0, 50, 0];
        });
        expect(constraint).toEqual(
            expect.arrayContaining([
                expect.objectContaining({ kind: "changed", id: "2", label: "Horizontal constraint 2" }),
            ]),
        );
        const removed = await change("delete constraint", (data) => {
            data.constraints.pop();
        });
        expect(removed).toEqual(
            expect.arrayContaining([
                expect.objectContaining({ kind: "removed", id: "2", label: "Horizontal constraint 2" }),
            ]),
        );
        const dragged = await change("drag endpoint", (data) => {
            data.entities[1].params = [30, 0, 45, 20];
        });
        expect(dragged).toEqual(
            expect.arrayContaining([expect.objectContaining({ kind: "changed", id: "2", label: "Line 2" })]),
        );
        const final = sketch.data;
        expect(vc.restore(originalCommit).errors).toEqual([]);
        expect(sketch.data).toEqual(initial);
        doc.history.undo();
        await settle();
        expect(sketch.data).toEqual(final);
    });

    test("records a microversion per edit, and per undo and redo", async () => {
        await buildPart(doc);
        const log = vc.log();
        expect(log.map((c) => c.message)).toEqual(["Fillet", "Extrude", "Create sketch", "Document created"]);
        expect(log[0].summary).toEqual(["Part 1 › Added command.feature.fillet 1"]);

        edit(doc, "depth", (features) =>
            features.map((f) => (f.id === "e1" ? ({ ...f, depth: 20 } as FeatureData) : f)),
        );
        await settle();
        expect(vc.headCommit().summary).toEqual([
            "Part 1 › command.feature.extrude 1: option.command.depth 10 mm → 20 mm",
        ]);
        expect(volume(doc)).toBeCloseTo(expectedVolume(20, false), 1);

        doc.history.undo();
        await settle();
        expect(vc.headCommit().message).toBe("Undo depth");
        expect(vc.headCommit().tree).toBe(log[0].tree);
        expect(volume(doc)).toBeCloseTo(expectedVolume(10, false), 1);

        doc.history.redo();
        await settle();
        expect(vc.headCommit().message).toBe("Redo depth");
        expect(volume(doc)).toBeCloseTo(expectedVolume(20, false), 1);
        expect(vc.log()).toHaveLength(7);
    });

    test("merges a depth edit from one branch with a chamfer added on the other", async () => {
        await buildPart(doc);
        expect(vc.createVersion("V1", "filleted block").isOk).toBe(true);

        expect(vc.createBranch("Deeper").isOk).toBe(true);
        edit(doc, "depth", (features) =>
            features.map((f) => (f.id === "e1" ? ({ ...f, depth: 20 } as FeatureData) : f)),
        );
        await settle();
        expect(volume(doc)).toBeCloseTo(expectedVolume(20, false), 1);
        const deeper = vc.head;

        expect(vc.switchBranch("Main").isOk).toBe(true);
        expectClean(doc);
        expect(volume(doc)).toBeCloseTo(expectedVolume(10, false), 1);
        const top = edgeAt(body(doc), [SIZE / 2, SIZE, 10]);
        edit(doc, "chamfer", (features) => [
            ...features,
            { id: "c1", type: "chamfer", distance: 2, edges: [captureEdgeRef(top)] },
        ]);
        await settle();
        expect(volume(doc)).toBeCloseTo(expectedVolume(10, true), 1);

        const preview = vc.previewMerge(deeper);
        expect(preview.conflicts).toEqual([]);
        const outcome = vc.merge(preview);
        expect(outcome.isOk).toBe(true);
        expect(outcome.unchecked()!.errors).toEqual([]);
        expectClean(doc);
        expect(body(doc).features.map((f) => f.id)).toEqual(["e1", "f1", "c1"]);
        expect(body(doc).features[0]).toMatchObject({ depth: 20 });
        expect(volume(doc)).toBeCloseTo(expectedVolume(20, true), 1);
        expect(vc.headCommit()).toMatchObject({ kind: "merge", message: "Merged Deeper into Main" });
    });

    test("restoring an old version brings its geometry back, as one undoable step", async () => {
        await buildPart(doc);
        vc.createVersion("V1");
        const v1 = vc.versions()[0].commit;
        const before = body(doc);
        edit(doc, "depth", (features) =>
            features.map((f) => (f.id === "e1" ? ({ ...f, depth: 25 } as FeatureData) : f)),
        );
        edit(doc, "drop fillet", (features) => features.filter((f) => f.id !== "f1"));
        await settle();
        expect(volume(doc)).toBeCloseTo(SIZE * SIZE * 25, 1);

        const outcome = vc.restore(v1);
        expect(outcome.errors).toEqual([]);
        expect(body(doc)).toBe(before);
        expectClean(doc);
        expect(volume(doc)).toBeCloseTo(expectedVolume(10, false), 1);
        expect(vc.headCommit().message).toBe("Restored to V1");

        doc.history.undo();
        await settle();
        expect(volume(doc)).toBeCloseTo(SIZE * SIZE * 25, 1);
    });

    test("surfaces the feature errors a merge produces", async () => {
        await buildPart(doc);
        vc.createBranch("Broken");
        edit(doc, "depth", (features) =>
            features.map((f) => (f.id === "e1" ? ({ ...f, depth: "missing * 2" } as FeatureData) : f)),
        );
        await settle();
        const broken = vc.head;
        vc.switchBranch("Main");
        const outcome = vc.merge(vc.previewMerge(broken)).unchecked()!;
        expect(outcome.errors.map((e) => [e.nodeName, e.feature])).toEqual([
            ["Part 1", "command.feature.extrude"],
        ]);
        expect(outcome.errors[0].message).toContain("missing");
    });

    test("the history survives a save and a reopen of the document", async () => {
        const storage = new Map<string, unknown>();
        const memory: IStorage = {
            createDBIfNeeded: async () => {},
            get: async (_db, table, id) => structuredClone(storage.get(`${table}/${id}`)),
            put: async (_db, table, id, value) => {
                storage.set(`${table}/${id}`, structuredClone(value));
                return true;
            },
            delete: async (_db, table, id) => storage.delete(`${table}/${id}`),
            page: async () => [],
        };
        const persistence = new StorageHistoryPersistence(memory);
        const saved = newDoc("saved-doc");
        const control = await DocumentVersionControl.attach(saved, { persistence });
        await buildPart(saved);
        control.createVersion("V1");
        await control.persist();

        // Reopen the way Document.load does: deserialize the saved nodes into a fresh document.
        const data = snapshotToSerialized(
            readTree(control.store, control.headCommit().tree),
            saved.id,
            "test",
        );
        const reopened = newDoc("saved-doc");
        reopened.history.disabled = true;
        await reopened.modelManager.deserialize(data["models"]);
        reopened.history.disabled = false;
        expect(volume(reopened)).toBeCloseTo(expectedVolume(10, false), 1);
        expect(NodeUtils.serializeNode(reopened.modelManager.rootNode).length).toBe(3);

        const loaded = await DocumentVersionControl.attach(reopened, { persistence });
        expect(loaded.log().map((c) => c.id)).toEqual(control.log().map((c) => c.id));
        expect(loaded.versions().map((v) => v.name)).toEqual(["V1"]);
        // The rebuilt document normalizes to exactly the saved head: no synchronization commit.
        expect(loaded.head).toBe(control.head);
        expect(JSON.parse(Serializer.serializeObject(body(reopened))["featuresJson"])).toEqual(
            JSON.parse(Serializer.serializeObject(body(saved))["featuresJson"]),
        );
        loaded.dispose();
        control.dispose();
        reopened.dispose();
        saved.dispose();
    });

    test("merges Feature Studio edits line by line and variable edits by id", async () => {
        const lines = Array.from({ length: 20 }, (_, i) => `const v${i} = ${i} * millimeter;`);
        const studio = new FeatureStudioNode({
            document: doc,
            name: "Feature Studio 1",
            source: lines.join("\n"),
        });
        Transaction.execute(doc, "add studio", () => {
            doc.modelManager.addNode(studio);
            doc.variables.setItems([
                { id: "w", name: "w", type: "length", expression: "10" },
                { id: "h", name: "h", type: "length", expression: "20" },
            ]);
        });
        await settle();

        vc.createBranch("Studio work");
        Transaction.execute(doc, "edit", () => {
            studio.source = studio.source.replace("const v3 = 3", "const v3 = 30");
            doc.variables.setItems(
                doc.variables.items.map((v) => (v.id === "h" ? { ...v, expression: "25" } : v)),
            );
        });
        await settle();
        const work = vc.head;
        expect(vc.headCommit().summary).toEqual([
            "Feature Studio 1: +1 −1 lines",
            "Variables › Variable h: expression 20 → 25",
        ]);

        vc.switchBranch("Main");
        expect(studio.source).toBe(lines.join("\n"));
        Transaction.execute(doc, "edit", () => {
            studio.source = studio.source.replace("const v15 = 15", "const v15 = 150");
            doc.variables.setItems(
                doc.variables.items.map((v) => (v.id === "w" ? { ...v, expression: "12" } : v)),
            );
        });
        await settle();

        const preview = vc.previewMerge(work);
        expect(preview.conflicts).toEqual([]);
        expect(vc.merge(preview).isOk).toBe(true);
        // The studio node is patched in place — its id and identity survive the merge.
        expect(doc.modelManager.findNode((n) => n.id === studio.id)).toBe(studio);
        expect(studio.source).toContain("const v3 = 30 * millimeter;");
        expect(studio.source).toContain("const v15 = 150 * millimeter;");
        expect(doc.variables.items.map((v) => `${v.name}=${v.expression}`)).toEqual(["w=12", "h=25"]);

        doc.history.undo();
        expect(studio.source).not.toContain("const v3 = 30");
        expect(doc.variables.items.map((v) => v.expression)).toEqual(["12", "20"]);
    });
});
