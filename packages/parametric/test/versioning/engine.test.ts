// Part of the Chili3d Project, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

/**
 * The version store on snapshots given as data: structural sharing, text deltas, semantic
 * summaries and the three-way merge, with the parametric splitters (feature lists, sketches,
 * studio sources, variable tables) registered.
 */

import {
    type ConflictResolution,
    type DocumentSnapshot,
    diffTrees,
    I18n,
    type Locale,
    MemoryObjectStore,
    mergeTrees,
    type NodeSnapshot,
    readTree,
    type SeqItem,
    summarizeDiff,
    type VariableData,
    writeSnapshot,
} from "@chili3d/core";
import { en } from "@chili3d/i18n";
import type { FeatureData } from "../../src/features/feature";
import type { SketchData } from "../../src/sketch/sketchModel";
import "../../src/versioning";

// Summaries read in the user's language: assert them in English rather than the identity
// locale the test setup installs.
let identity: Locale | undefined;
beforeAll(() => {
    identity = I18n.getLanguages().find((x) => x.language === "en");
    I18n.addLanguage(en);
});
afterAll(() => {
    if (identity !== undefined) I18n.addLanguage(identity);
});

const EXTRUDE: FeatureData = { id: "f-extrude", type: "extrude", sketchId: "sketch1", depth: 10 };
const FILLET: FeatureData = { id: "f-fillet", type: "fillet", radius: 1, edges: [] };
const CHAMFER: FeatureData = { id: "f-chamfer", type: "chamfer", distance: 0.5, edges: [] };

const SKETCH: SketchData = {
    entities: [
        { id: 1, type: "line", params: [0, 0, 10, 0] },
        { id: 2, type: "line", params: [10, 0, 10, 10] },
        { id: 3, type: "line", params: [10, 10, 0, 10] },
        { id: 4, type: "line", params: [0, 10, 0, 0] },
    ],
    constraints: [{ id: 1, kind: 4, refs: [{ entityId: 1, pointIndex: 0 }] }],
    entityIdSeq: 5,
};

const SOURCE = Array.from({ length: 40 }, (_, i) => `const value${i} = ${i} * millimeter;\n`).join("");

const VARIABLES: VariableData[] = [
    { id: "v-w", name: "w", type: "length", expression: "10" },
    { id: "v-h", name: "h", type: "length", expression: "20" },
];

interface Fixture {
    features?: readonly FeatureData[];
    sketch?: SketchData;
    source?: string;
    variables?: readonly VariableData[];
    sketchName?: string;
    withSketch?: boolean;
    extra?: number;
}

/** A document: a sketch, a parametric body, a Feature Studio and `extra` plain boxes. */
function snapshot(fixture: Fixture = {}): DocumentSnapshot {
    const nodes = new Map<string, NodeSnapshot>();
    const children: string[] = [];
    if (fixture.withSketch !== false) {
        children.push("sketch1");
        nodes.set("sketch1", {
            cls: "SketchNode",
            props: {
                name: fixture.sketchName ?? "Sketch 1",
                visible: true,
                dataJson: JSON.stringify(fixture.sketch ?? SKETCH),
            },
        });
    }
    children.push("body1", "studio1");
    nodes.set("body1", {
        cls: "ParametricBodyNode",
        props: {
            name: "Part 1",
            visible: true,
            featuresJson: JSON.stringify(fixture.features ?? [EXTRUDE, FILLET]),
        },
        children: [],
    });
    nodes.set("studio1", {
        cls: "FeatureStudioNode",
        props: { name: "Feature Studio 1", source: fixture.source ?? SOURCE },
    });
    for (let i = 0; i < (fixture.extra ?? 0); i++) {
        children.push(`box${i}`);
        nodes.set(`box${i}`, { cls: "BoxNode", props: { name: `Box${i}`, dx: i + 1, dy: 2, dz: 3 } });
    }
    nodes.set("root", { cls: "FolderNode", props: { name: "Doc", visible: true }, children });
    const variables: SeqItem[] = (fixture.variables ?? VARIABLES).map((v) => ({ id: v.id, value: { ...v } }));
    return {
        meta: { name: "Doc", userData: {}, acts: [] },
        rootId: "root",
        nodes,
        variables,
        materials: [],
        components: [],
    };
}

function featuresOf(store: MemoryObjectStore, tree: string): FeatureData[] {
    return JSON.parse(readTree(store, tree).nodes.get("body1")!.props["featuresJson"] as string);
}

function sketchOf(store: MemoryObjectStore, tree: string): SketchData {
    return JSON.parse(readTree(store, tree).nodes.get("sketch1")!.props["dataJson"] as string);
}

function sourceOf(store: MemoryObjectStore, tree: string): string {
    return readTree(store, tree).nodes.get("studio1")!.props["source"] as string;
}

const withDepth = (depth: number | string): FeatureData => ({ ...EXTRUDE, depth }) as FeatureData;
const withRadius = (radius: number): FeatureData => ({ ...FILLET, radius }) as FeatureData;
const moveLine = (sketch: SketchData, id: number, params: number[]): SketchData => ({
    ...sketch,
    entities: sketch.entities.map((e) => (e.id === id ? { ...e, params } : e)),
});
const editLine = (text: string, line: number, replacement: string) => {
    const lines = text.split("\n");
    lines[line] = replacement;
    return lines.join("\n");
};

describe("snapshots", () => {
    test("round-trip through the store", () => {
        const store = new MemoryObjectStore();
        const original = snapshot();
        const back = readTree(store, writeSnapshot(store, original));
        expect([...back.nodes.keys()].sort()).toEqual([...original.nodes.keys()].sort());
        expect(JSON.parse(back.nodes.get("body1")!.props["featuresJson"] as string)).toEqual([
            EXTRUDE,
            FILLET,
        ]);
        expect(JSON.parse(back.nodes.get("sketch1")!.props["dataJson"] as string)).toEqual(SKETCH);
        expect(back.nodes.get("studio1")!.props["source"]).toBe(SOURCE);
        expect(back.nodes.get("root")!.children).toEqual(["sketch1", "body1", "studio1"]);
    });

    test("are content addressed: equal documents give equal trees in any key order", () => {
        const store = new MemoryObjectStore();
        const reordered: FeatureData = {
            depth: 10,
            sketchId: "sketch1",
            type: "extrude",
            id: "f-extrude",
        } as FeatureData;
        expect(writeSnapshot(store, snapshot({ features: [reordered, FILLET] }))).toBe(
            writeSnapshot(store, snapshot()),
        );
    });

    test.each([0, 60])("a one-feature edit adds O(1) objects (%i other nodes)", (extra) => {
        const store = new MemoryObjectStore();
        const features = [
            EXTRUDE,
            FILLET,
            ...Array.from({ length: 30 }, (_, i) => ({ ...CHAMFER, id: `c${i}` })),
        ];
        writeSnapshot(store, snapshot({ features, extra }));
        const before = store.size;
        writeSnapshot(store, snapshot({ features: [withDepth(20), ...features.slice(1)], extra }));
        // The edited feature, the feature list, the body node, its index shard and the tree.
        expect(store.size - before).toBe(5);
    });

    test("a studio edit is stored as a delta of the changed line", () => {
        const store = new MemoryObjectStore();
        const source = Array.from(
            { length: 300 },
            (_, i) => `    var x${i} = ${i} * millimeter; // line ${i}\n`,
        ).join("");
        const first = writeSnapshot(store, snapshot({ source }));
        const firstText = store.get(readTreeNode(store, first, "studio1").parts["source"])!;
        expect(firstText.t).toBe("text");
        // The capture passes the previous version as the delta base; do the same here.
        const edited = editLine(source, 150, "    var x150 = 42 * millimeter; // edited");
        const previous = readTreeNode(store, first, "studio1").parts["source"];
        const hash = store.put({ t: "text", s: edited }, previous);
        expect(store.record(hash)).toHaveProperty("d");
        expect(store.recordSize(hash)).toBeLessThan(store.recordSize(previous) / 50);
        expect(store.get(hash)).toEqual({ t: "text", s: edited });
    });
});

function readTreeNode(store: MemoryObjectStore, tree: string, id: string) {
    const treeObj = store.get(tree) as unknown as { shards: string[] };
    for (const shard of treeObj.shards) {
        const node = (store.get(shard) as unknown as { n: Record<string, string> }).n[id];
        if (node !== undefined) return store.get(node) as unknown as { parts: Record<string, string> };
    }
    throw new Error(`no node ${id}`);
}

describe("semantic diff", () => {
    test.each([
        [
            "a parameter edit",
            { features: [withDepth(20), FILLET] },
            "Part 1 › Extrude 1: depth 10 mm → 20 mm",
        ],
        ["an added feature", { features: [EXTRUDE, FILLET, CHAMFER] }, "Part 1 › Added Chamfer 1"],
        ["a removed feature", { features: [EXTRUDE] }, "Part 1 › Removed Fillet 1"],
        ["a reorder", { features: [FILLET, EXTRUDE] }, "Part 1 › Reordered"],
        [
            "an expression",
            { features: [withDepth("w * 2"), FILLET] },
            "Part 1 › Extrude 1: depth 10 mm → w * 2",
        ],
        ["a sketch edit", { sketch: moveLine(SKETCH, 2, [10, 0, 12, 10]) }, "Sketch 1 › Line 2: geometry"],
        ["a studio edit", { source: editLine(SOURCE, 3, "const x = 1;") }, "Feature Studio 1: +1 −1 lines"],
        [
            "a variable edit",
            { variables: [{ ...VARIABLES[0], expression: "15" }, VARIABLES[1]] },
            "Variables › Variable w: expression 10 → 15",
        ],
        ["a rename", { sketchName: "Profile" }, "Renamed Sketch 1 → Profile"],
        ["a removed node", { withSketch: false }, "Removed Sketch 1"],
    ] as const)("summarizes %s", (_name, fixture, expected) => {
        const store = new MemoryObjectStore();
        const a = writeSnapshot(store, snapshot());
        const b = writeSnapshot(store, snapshot(fixture as Fixture));
        const lines = summarizeDiff(diffTrees(store, a, b));
        const prefix = new RegExp(`^${expected.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`);
        expect(lines).toEqual(expect.arrayContaining([expect.stringMatching(prefix)]));
    });

    test("an unchanged document has an empty diff", () => {
        const store = new MemoryObjectStore();
        const a = writeSnapshot(store, snapshot());
        expect(summarizeDiff(diffTrees(store, a, a))).toEqual([]);
    });

    test("text changes carry both versions for the diff view", () => {
        const store = new MemoryObjectStore();
        const a = writeSnapshot(store, snapshot());
        const edited = editLine(SOURCE, 3, "const x = 1;");
        const diff = diffTrees(store, a, writeSnapshot(store, snapshot({ source: edited })));
        const studio = diff.nodes.find((n) => n.id === "studio1")!;
        expect(studio.changes).toEqual([
            { kind: "text", property: "source", added: 1, removed: 1, before: SOURCE, after: edited },
        ]);
    });
});

describe("three-way merge", () => {
    function merge(
        base: Fixture,
        ours: Fixture,
        theirs: Fixture,
        resolutions?: Map<string, ConflictResolution>,
    ) {
        const store = new MemoryObjectStore();
        const b = writeSnapshot(store, snapshot(base));
        const o = writeSnapshot(store, snapshot(ours));
        const t = writeSnapshot(store, snapshot(theirs));
        const result = mergeTrees(store, b, o, t, resolutions);
        return { store, ...result };
    }

    describe("merges cleanly", () => {
        test("edits to different features of one body", () => {
            const { store, tree, conflicts } = merge(
                {},
                { features: [withDepth(20), FILLET] },
                { features: [EXTRUDE, withRadius(2)] },
            );
            expect(conflicts).toEqual([]);
            expect(featuresOf(store, tree)).toEqual([withDepth(20), withRadius(2)]);
        });

        test("features added on both sides, each after its anchor", () => {
            const blend: FeatureData = { ...FILLET, id: "f-blend", radius: 3 } as FeatureData;
            const { store, tree, conflicts } = merge(
                {},
                { features: [EXTRUDE, CHAMFER, FILLET] },
                { features: [EXTRUDE, FILLET, blend] },
            );
            expect(conflicts).toEqual([]);
            expect(featuresOf(store, tree).map((f) => f.id)).toEqual([
                "f-extrude",
                "f-chamfer",
                "f-fillet",
                "f-blend",
            ]);
        });

        test("edits to different sketch entities", () => {
            const { store, tree, conflicts } = merge(
                {},
                { sketch: moveLine(SKETCH, 1, [0, 0, 20, 0]) },
                { sketch: moveLine(SKETCH, 3, [20, 10, 0, 10]) },
            );
            expect(conflicts).toEqual([]);
            const entities = sketchOf(store, tree).entities;
            expect(entities.find((e) => e.id === 1)!.params).toEqual([0, 0, 20, 0]);
            expect(entities.find((e) => e.id === 3)!.params).toEqual([20, 10, 0, 10]);
        });

        test("edits to different variables, and a variable added on each side", () => {
            const d: VariableData = { id: "v-d", name: "d", type: "length", expression: "5" };
            const t: VariableData = { id: "v-t", name: "t", type: "length", expression: "2" };
            const { store, tree, conflicts } = merge(
                {},
                { variables: [{ ...VARIABLES[0], expression: "11" }, VARIABLES[1], d] },
                { variables: [VARIABLES[0], { ...VARIABLES[1], expression: "22" }, t] },
            );
            expect(conflicts).toEqual([]);
            const merged = readTree(store, tree).variables.map((x) => x.value as unknown as VariableData);
            expect(merged.map((v) => `${v.name}=${v.expression}`)).toEqual(["w=11", "h=22", "d=5", "t=2"]);
        });

        test("edits to different lines of a studio", () => {
            const ours = editLine(SOURCE, 2, "const a = 1;");
            const theirs = editLine(SOURCE, 30, "const b = 2;");
            const { store, tree, conflicts } = merge({}, { source: ours }, { source: theirs });
            expect(conflicts).toEqual([]);
            expect(sourceOf(store, tree)).toBe(editLine(ours, 30, "const b = 2;"));
        });

        test("one side deleting a feature the other left alone", () => {
            const { store, tree, conflicts } = merge(
                {},
                { features: [EXTRUDE] },
                { features: [withDepth(30), FILLET] },
            );
            expect(conflicts).toEqual([]);
            expect(featuresOf(store, tree)).toEqual([withDepth(30)]);
        });
    });

    describe("conflicts", () => {
        test("the same feature parameter changed differently", () => {
            const ours = { features: [withDepth(20), FILLET] };
            const theirs = { features: [withDepth(30), FILLET] };
            const { store, tree, conflicts } = merge({}, ours, theirs);
            expect(conflicts).toHaveLength(1);
            expect(conflicts[0]).toMatchObject({
                kind: "value",
                location: "Part 1 › Extrude 1",
                field: "depth",
                base: "10 mm",
                ours: "20 mm",
                theirs: "30 mm",
            });
            expect(featuresOf(store, tree)[0]).toMatchObject({ depth: 20 });
            const id = conflicts[0].id;
            const asTheirs = merge({}, ours, theirs, new Map([[id, "theirs"]]));
            expect(featuresOf(asTheirs.store, asTheirs.tree)[0]).toMatchObject({ depth: 30 });
            const manual = merge({}, ours, theirs, new Map([[id, { value: 25 }]]));
            expect(featuresOf(manual.store, manual.tree)[0]).toMatchObject({ depth: 25 });
        });

        test("overlapping studio lines, resolved per hunk or as a whole", () => {
            const ours = editLine(SOURCE, 5, "const ours = 1;");
            const theirs = editLine(SOURCE, 5, "const theirs = 2;");
            const { store, tree, conflicts } = merge({}, { source: ours }, { source: theirs });
            expect(conflicts).toHaveLength(1);
            expect(conflicts[0]).toMatchObject({
                kind: "text",
                ours: "const ours = 1;\n",
                theirs: "const theirs = 2;\n",
            });
            expect(sourceOf(store, tree)).toBe(ours);
            const asTheirs = merge(
                {},
                { source: ours },
                { source: theirs },
                new Map([[conflicts[0].id, "theirs"]]),
            );
            expect(sourceOf(asTheirs.store, asTheirs.tree)).toBe(theirs);
            const both = merge(
                {},
                { source: ours },
                { source: theirs },
                new Map([[conflicts[0].id, "both"]]),
            );
            expect(sourceOf(both.store, both.tree)).toBe(
                editLine(ours, 5, "const ours = 1;\nconst theirs = 2;"),
            );
            const textId = conflicts[0].textId!;
            const manual = merge(
                {},
                { source: ours },
                { source: theirs },
                new Map([[textId, { text: "custom" }]]),
            );
            expect(sourceOf(manual.store, manual.tree)).toBe("custom");
        });

        test("a feature deleted on one side and modified on the other", () => {
            const ours = { features: [EXTRUDE] };
            const theirs = { features: [EXTRUDE, withRadius(4)] };
            const { store, tree, conflicts } = merge({}, ours, theirs);
            expect(conflicts).toHaveLength(1);
            expect(conflicts[0]).toMatchObject({
                kind: "delete-modify",
                ours: "Deleted",
                theirs: "Modified",
            });
            expect(featuresOf(store, tree).map((f) => f.id)).toEqual(["f-extrude"]);
            const kept = merge({}, ours, theirs, new Map([[conflicts[0].id, "theirs"]]));
            expect(featuresOf(kept.store, kept.tree)).toEqual([EXTRUDE, withRadius(4)]);
        });

        test("a node deleted on one side and modified on the other", () => {
            const { store, tree, conflicts } = merge({}, { withSketch: false }, { sketchName: "Profile" });
            expect(conflicts).toEqual([
                expect.objectContaining({ id: "node/sketch1", kind: "delete-modify" }),
            ]);
            expect(readTree(store, tree).nodes.has("sketch1")).toBe(false);
            const kept = merge(
                {},
                { withSketch: false },
                { sketchName: "Profile" },
                new Map([["node/sketch1", "theirs"]]),
            );
            const merged = readTree(kept.store, kept.tree);
            expect(merged.nodes.get("sketch1")!.props["name"]).toBe("Profile");
            // The kept node is hung back where it was.
            expect(merged.nodes.get("root")!.children).toEqual(["sketch1", "body1", "studio1"]);
        });

        test("different reorders of the same features", () => {
            const base = { features: [EXTRUDE, FILLET, CHAMFER] };
            const ours = { features: [FILLET, EXTRUDE, CHAMFER] };
            const theirs = { features: [EXTRUDE, CHAMFER, FILLET] };
            const { store, tree, conflicts } = merge(base, ours, theirs);
            expect(conflicts.map((c) => c.kind)).toEqual(["order"]);
            expect(featuresOf(store, tree).map((f) => f.id)).toEqual(["f-fillet", "f-extrude", "f-chamfer"]);
            const asTheirs = merge(base, ours, theirs, new Map([[conflicts[0].id, "theirs"]]));
            expect(featuresOf(asTheirs.store, asTheirs.tree).map((f) => f.id)).toEqual([
                "f-extrude",
                "f-chamfer",
                "f-fillet",
            ]);
        });

        test("a reorder on one side only is not a conflict", () => {
            const base = { features: [EXTRUDE, FILLET, CHAMFER] };
            const { store, tree, conflicts } = merge(
                base,
                { features: [EXTRUDE, CHAMFER, FILLET] },
                { features: [withDepth(12), FILLET, CHAMFER] },
            );
            expect(conflicts).toEqual([]);
            expect(featuresOf(store, tree).map((f) => f.id)).toEqual(["f-extrude", "f-chamfer", "f-fillet"]);
            expect(featuresOf(store, tree)[0]).toMatchObject({ depth: 12 });
        });
    });

    test("entities drawn on both sides with the same id both survive", () => {
        const ours = {
            sketch: {
                ...SKETCH,
                entities: [...SKETCH.entities, { id: 5, type: "circle", params: [5, 5, 1] }],
                entityIdSeq: 6,
            },
        };
        const theirs = {
            sketch: {
                ...SKETCH,
                entities: [...SKETCH.entities, { id: 5, type: "circle", params: [2, 2, 0.5] }],
                constraints: [
                    ...SKETCH.constraints,
                    { id: 2, kind: 1, refs: [{ entityId: 5, pointIndex: 0 }] },
                ],
                entityIdSeq: 6,
            },
        } as Fixture;
        const { store, tree, conflicts } = merge({}, ours as Fixture, theirs);
        expect(conflicts).toEqual([]);
        const sketch = sketchOf(store, tree);
        const circles = sketch.entities.filter((e) => e.type === "circle");
        expect(circles.map((c) => c.params)).toEqual([
            [5, 5, 1],
            [2, 2, 0.5],
        ]);
        const renumbered = circles[1].id;
        expect(renumbered).not.toBe(5);
        // The incoming constraint follows its renumbered entity, and the counter moves past both.
        expect(sketch.constraints.find((c) => c.id === 2)!.refs[0].entityId).toBe(renumbered);
        expect(sketch.entityIdSeq).toBeGreaterThan(renumbered);
    });
});
