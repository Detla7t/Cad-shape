// Part of the Chili3d Project, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

import {
    EditableShapeNode,
    FolderNode,
    type IDocument,
    Id,
    type IVariableFeatureNode,
    Node,
    type NodeDependencies,
    OriginNode,
    type VariableData,
} from "@chili3d/core";
import { createMockEdge, TestDocument } from "@chili3d/core/test-utils";
import {
    computeOwnership,
    joinOwnerBars,
    OWNER_PALETTE,
    ownerBars,
    ownerColors,
} from "../src/project/tree/ownerColors";

/** A variable feature, like `MeasuredVariableNode`: one named row, reading other variables. */
class VariableFeature extends Node implements IVariableFeatureNode {
    readonly variableSource = true as const;
    constructor(
        document: IDocument,
        readonly variable: string,
        readonly expression: string,
    ) {
        super(document, `#${variable}`, Id.generate());
    }
    get items(): readonly VariableData[] {
        return [{ id: this.id, name: this.variable, type: "length", expression: this.expression }];
    }
    get variablesJson(): string {
        return JSON.stringify(this.items);
    }
    dependencies(): NodeDependencies {
        return { nodeIds: [], variables: this.expression.match(/[A-Za-z_]\w*/g) ?? [] };
    }
    protected onVisibleChanged(): void {}
    protected onParentVisibleChanged(): void {}
}

/** A result (a sketch) that reads variables and a plane. */
class Result extends EditableShapeNode {
    deps: NodeDependencies = { nodeIds: [], variables: [] };
    constructor(document: IDocument, name: string) {
        super({ document, name, shape: createMockEdge() });
    }
    dependencies(): NodeDependencies {
        return this.deps;
    }
}

describe("owner colours", () => {
    test("each result colours what it reads, shared features carry both colours, folders their contents", () => {
        const doc = new TestDocument();
        const folder = new FolderNode({ document: doc, name: "Variables" });
        const od = new VariableFeature(doc, "duct_od", "9.625 in");
        const bend = new VariableFeature(doc, "bend_radius", "duct_od / 2");
        const seam = new VariableFeature(doc, "seam_tab", "1 in");
        const hole = new VariableFeature(doc, "hole_radius", "duct_id / 2");
        const id = new VariableFeature(doc, "duct_id", "6.625 in");
        doc.modelManager.addNode(folder);
        for (const node of [od, bend, seam, hole, id]) folder.add(node);
        const plain = new Result(doc, "End Cap");
        plain.deps = { nodeIds: [], variables: ["bend_radius", "seam_tab"] };
        const reducing = new Result(doc, "Reducing End Cap");
        reducing.deps = { nodeIds: [], variables: ["bend_radius", "hole_radius"] };
        doc.modelManager.addNode(plain);
        doc.modelManager.addNode(reducing);
        try {
            const ownership = computeOwnership(doc);
            expect(ownership.owners).toEqual([plain, reducing]);
            expect(ownerColors(ownership, plain)).toEqual([OWNER_PALETTE[0]]);
            expect(ownerColors(ownership, reducing)).toEqual([OWNER_PALETTE[1]]);
            // bend_radius (and duct_od through it) serve both; seam_tab the plain cap only; the hole the reducer only.
            expect(ownerColors(ownership, bend)).toEqual([OWNER_PALETTE[0], OWNER_PALETTE[1]]);
            expect(ownerColors(ownership, od)).toEqual([OWNER_PALETTE[0], OWNER_PALETTE[1]]);
            expect(ownerColors(ownership, seam)).toEqual([OWNER_PALETTE[0]]);
            expect(ownerColors(ownership, hole)).toEqual([OWNER_PALETTE[1]]);
            expect(ownerColors(ownership, id)).toEqual([OWNER_PALETTE[1]]);
            expect(ownerColors(ownership, folder)).toEqual([OWNER_PALETTE[0], OWNER_PALETTE[1]]);
            // Lanes: an owner's bar always sits in its own lane; empty lanes stay empty.
            expect(ownerBars(ownership, seam)).toEqual({
                lanes: [OWNER_PALETTE[0], undefined, undefined],
                many: false,
            });
            expect(ownerBars(ownership, hole)).toEqual({
                lanes: [undefined, OWNER_PALETTE[1], undefined],
                many: false,
            });
            expect(ownerBars(ownership, bend)).toEqual({
                lanes: [OWNER_PALETTE[0], OWNER_PALETTE[1], undefined],
                many: false,
            });
            expect(ownerBars(ownership, new Result(doc, "stray"))).toEqual({ lanes: [], many: false });
            // Per part: each top-level node holding a result is an owner of everything inside
            // it; the folder of variables is nobody's and takes the colours of its readers.
            const byPart = computeOwnership(doc, "part");
            expect(byPart.owners).toEqual([plain, reducing]);
            expect(ownerBars(byPart, od)).toEqual({
                lanes: [OWNER_PALETTE[0], OWNER_PALETTE[1], undefined],
                many: false,
            });
            expect(ownerBars(byPart, seam)).toEqual({
                lanes: [OWNER_PALETTE[0], undefined, undefined],
                many: false,
            });
            expect(computeOwnership(doc, "off").owners).toEqual([]);
        } finally {
            doc.history.disabled = true;
        }
    });

    test("datums are nobody's: the origin takes no lane and default geometry no colour", () => {
        const doc = new TestDocument();
        const datums = new FolderNode({ document: doc, name: "Default geometry" });
        const origin = new OriginNode({ document: doc });
        doc.modelManager.addNode(datums);
        datums.add(origin);
        const a = new Result(doc, "A");
        const b = new Result(doc, "B");
        doc.modelManager.addNode(a);
        doc.modelManager.addNode(b);
        try {
            for (const mode of ["solid", "part"] as const) {
                const ownership = computeOwnership(doc, mode);
                expect(ownership.owners).toEqual([a, b]);
                expect(ownerBars(ownership, origin)).toEqual({ lanes: [], many: false });
                expect(ownerBars(ownership, datums)).toEqual({ lanes: [], many: false });
                expect(ownerBars(ownership, b)).toEqual({
                    lanes: [undefined, OWNER_PALETTE[1], undefined],
                    many: false,
                });
            }
        } finally {
            doc.history.disabled = true;
        }
    });

    test("past three owners the lanes repeat; only a row with more than three owners stripes", () => {
        const doc = new TestDocument();
        const shared = new VariableFeature(doc, "w", "10 mm");
        const pair = new VariableFeature(doc, "h", "20 mm");
        const quad = new VariableFeature(doc, "t", "2 mm");
        doc.modelManager.addNode(shared);
        doc.modelManager.addNode(pair);
        doc.modelManager.addNode(quad);
        const results = ["A", "B", "C", "D", "E"].map((name) => new Result(doc, name));
        for (const result of results) doc.modelManager.addNode(result);
        // w is read by A and D (lanes 0 and 3 → 0 would meet), h by B and E, t by all but E.
        results[0].deps = { nodeIds: [], variables: ["w", "t"] };
        results[1].deps = { nodeIds: [], variables: ["h", "t"] };
        results[2].deps = { nodeIds: [], variables: ["t"] };
        results[3].deps = { nodeIds: [], variables: ["w", "t"] };
        results[4].deps = { nodeIds: [], variables: ["h"] };
        try {
            const ownership = computeOwnership(doc);
            expect(ownership.owners).toEqual(results);
            // The fourth and fifth owners are ordinary owners in their own colours, lanes 0 and 1 again.
            expect(ownerBars(ownership, results[3])).toEqual({
                lanes: [OWNER_PALETTE[3], undefined, undefined],
                many: false,
            });
            expect(ownerBars(ownership, results[4])).toEqual({
                lanes: [undefined, OWNER_PALETTE[4], undefined],
                many: false,
            });
            // Owners that would meet in a lane are packed in owner order.
            expect(ownerBars(ownership, shared)).toEqual({
                lanes: [OWNER_PALETTE[0], OWNER_PALETTE[3], undefined],
                many: false,
            });
            expect(ownerBars(ownership, pair)).toEqual({
                lanes: [OWNER_PALETTE[1], OWNER_PALETTE[4], undefined],
                many: false,
            });
            // More than three owners is the special bar.
            expect(ownerColors(ownership, quad)).toHaveLength(4);
            expect(ownerBars(ownership, quad)).toEqual({ lanes: [], many: true });
        } finally {
            doc.history.disabled = true;
        }
    });

    test("one result colours nothing", () => {
        const doc = new TestDocument();
        const only = new Result(doc, "Body");
        doc.modelManager.addNode(only);
        try {
            expect(computeOwnership(doc).owners).toEqual([]);
            expect(ownerColors(computeOwnership(doc), only)).toEqual([]);
        } finally {
            doc.history.disabled = true;
        }
    });
});

describe("owner bar joins", () => {
    const bars = (...lanes: (string | undefined)[]) => ({ lanes, many: false });

    test("consecutive rows with the same owner in a lane join into one strip; a gap or a depth change breaks it", () => {
        const g = "#9bd36a";
        const r = "#f28c7a";
        const joins = joinOwnerBars([
            { bars: bars(g, r, undefined), depth: 2 }, // 0: both start
            { bars: bars(g, r, undefined), depth: 2 }, // 1: both continue
            { bars: bars(undefined, r, undefined), depth: 2 }, // 2: green breaks, red continues
            { bars: bars(g, r, undefined), depth: 2 }, // 3: green starts again
            { bars: bars(g, r, undefined), depth: 1 }, // 4: a shallower row: nothing joins across
            { bars: { lanes: [], many: true }, depth: 1 }, // 5: a striped row never joins
        ]);
        expect(joins.map((j) => j.up)).toEqual([
            [false, false, false],
            [true, true, false],
            [false, true, false],
            [false, true, false],
            [false, false, false],
            [false, false, false],
        ]);
        expect(joins.map((j) => j.down)).toEqual([
            [true, true, false],
            [false, true, false],
            [false, true, false],
            [false, false, false],
            [false, false, false],
            [false, false, false],
        ]);
        expect(joinOwnerBars([])).toEqual([]);
    });
});
