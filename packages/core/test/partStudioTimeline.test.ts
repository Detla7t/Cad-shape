// Part of the Chili3d Project, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

import {
    FolderNode,
    isHistoryHidden,
    OriginNode,
    orderRespectsDependencies,
    PartStudioTimeline,
    PubSub,
    TIMELINE_GROUPS_KEY,
    Transaction,
    timelineLanes,
} from "@chili3d/core";
import {
    TestFeatureListNode as BodyNode,
    TestStepNode as StepNode,
    TestDocument,
} from "@chili3d/core/test-utils";

const keys = (timeline: PartStudioTimeline) => timeline.entries.map((entry) => entry.key);

/** S1, Body(f1 ← S1, f2 ← S2), S2: S2 sits after the body in the tree but f2 consumes it. */
function fixture() {
    const document = new TestDocument();
    const s1 = new StepNode(document, "S1");
    const s2 = new StepNode(document, "S2");
    const body = new BodyNode(document, "B", [
        { id: "f1", nodeIds: ["S1"] },
        { id: "f2", nodeIds: ["S2"] },
    ]);
    document.modelManager.addNode(s1, body, s2);
    const timeline = PartStudioTimeline.of(document);
    timeline.refresh();
    return { document, s1, s2, body, timeline };
}

afterEach(() => {
    rs.restoreAllMocks();
});

describe("PartStudioTimeline order", () => {
    test("a sketch defined later in the tree but consumed earlier moves up to its consumer", () => {
        const { timeline } = fixture();
        expect(keys(timeline)).toEqual(["S1", "B/f1", "S2", "B/f2"]);
        expect(timeline.position).toBe(4);
    });

    test("the datum folder and its origin are not steps; other folders are flattened", () => {
        const document = new TestDocument();
        const datum = new FolderNode({ document, name: "Default geometry" });
        datum.add(new OriginNode({ document }), new StepNode(document, "Top"));
        const folder = new FolderNode({ document, name: "Sketches" });
        folder.add(new StepNode(document, "Inner"));
        document.modelManager.addNode(datum, folder, new StepNode(document, "After"));
        const timeline = PartStudioTimeline.of(document);
        timeline.refresh();
        expect(keys(timeline)).toEqual(["Inner", "After"]);
    });

    test("an anchored sketch follows the feature it was drawn on, before the feature consuming it", () => {
        const document = new TestDocument();
        const body = new BodyNode(document, "B", [{ id: "f1" }, { id: "f2", nodeIds: ["S"] }]);
        const sketch = new StepNode(document, "S");
        sketch.nodeIds = ["B"];
        sketch.anchors = { B: 1 };
        document.modelManager.addNode(body, sketch);
        expect(keys(PartStudioTimeline.of(document))).toEqual(["B/f1", "S", "B/f2"]);
    });

    test("an unanchored whole-body read that closes a cycle yields to the consumer", () => {
        const document = new TestDocument();
        const body = new BodyNode(document, "B", [{ id: "f1" }, { id: "f2", nodeIds: ["S"] }]);
        const sketch = new StepNode(document, "S");
        sketch.nodeIds = ["B"];
        document.modelManager.addNode(body, sketch);
        expect(keys(PartStudioTimeline.of(document))).toEqual(["B/f1", "S", "B/f2"]);
    });

    test("a boolean tool body's features come before the boolean consuming it", () => {
        const document = new TestDocument();
        const target = new BodyNode(document, "A", [{ id: "a1" }, { id: "cut", nodeIds: ["T"] }]);
        const tool = new BodyNode(document, "T", [{ id: "t1" }, { id: "t2" }]);
        document.modelManager.addNode(target, tool);
        expect(keys(PartStudioTimeline.of(document))).toEqual(["A/a1", "T/t1", "T/t2", "A/cut"]);
    });
});

describe("PartStudioTimeline rollback", () => {
    test("rolling into the middle of a body replays it there and hides what lies in the future", () => {
        const { s1, s2, body, timeline } = fixture();
        expect(timeline.rollTo(2)).toBe(true);
        expect(body.rollbackIndex).toBe(1);
        expect(isHistoryHidden(s1)).toBe(false);
        expect(isHistoryHidden(body)).toBe(false);
        expect(isHistoryHidden(s2)).toBe(true);
        expect(timeline.nodeState(body)).toBe("partial");
        expect(timeline.nodeState(s2)).toBe("future");
        expect(timeline.appliedFeatureCount(body)).toBe(1);

        // Nothing of the body applied: hidden whole, its list left complete.
        expect(timeline.rollTo(1)).toBe(true);
        expect(isHistoryHidden(body)).toBe(true);
        expect(body.rollbackIndex).toBeUndefined();

        expect(timeline.end()).toBe(true);
        expect([s1, s2, body].map(isHistoryHidden)).toEqual([false, false, false]);
        expect(body.rollbackIndex).toBeUndefined();
    });

    test("step, start and end move one marker and clamp at both ends", () => {
        const { timeline } = fixture();
        const positions: number[] = [];
        timeline.onPropertyChanged((property, source) => {
            if (property === "position") positions.push(source.position);
        });
        timeline.start();
        timeline.step(-1);
        timeline.step(1);
        timeline.step(2);
        timeline.end();
        timeline.step(1);
        expect(positions).toEqual([0, 1, 3, 4]);
        expect(timeline.isRolledBack).toBe(false);
    });

    test("every view reads and drives the same marker", () => {
        const { document, body, timeline } = fixture();
        const tree = PartStudioTimeline.of(document);
        expect(tree).toBe(timeline);
        let seen = -1;
        timeline.onPropertyChanged(() => {
            seen = timeline.position;
        });
        // A body's own bar: before its second feature.
        expect(tree.rollToFeature(body, 1)).toBe(true);
        expect(seen).toBe(3);
        expect(timeline.isFuture(3)).toBe(true);
        // Its end goes right after its last feature, and leaves a later marker alone.
        tree.start();
        expect(tree.rollToFeature(body, 2)).toBe(true);
        expect(timeline.position).toBe(4);
        // The tree's document bar: before a row.
        expect(tree.rollBefore([body])).toBe(true);
        expect(timeline.position).toBe(1);
    });

    test("opening a step pulls the marker to right after it: the model with that step just applied", () => {
        const { document, s1, s2, body, timeline } = fixture();
        // S1, B/f1, S2, B/f2
        expect(timeline.rollAfter(body, "f1")).toBe(true);
        expect(timeline.position).toBe(2);
        expect(timeline.isFuture(2)).toBe(true);
        expect(timeline.rollAfter(s1)).toBe(true);
        expect(timeline.position).toBe(1);
        // forward as well as back
        expect(timeline.rollAfter(body, "f2")).toBe(true);
        expect(timeline.position).toBe(4);
        expect(timeline.rollAfter(s2)).toBe(true);
        expect(timeline.position).toBe(3);
        // a node without an entry (a folder) leaves the marker alone
        const other = new StepNode(document, "Loose");
        expect(timeline.rollAfter(other)).toBe(false);
        expect(timeline.position).toBe(3);
    });

    test("a position the kernel cannot rebuild restores the previous one and reports it", () => {
        const { body, timeline } = fixture();
        const errors: string[] = [];
        const pub = rs.spyOn(PubSub.default, "pub").mockImplementation(((topic: string, message: string) => {
            if (topic === "displayError") errors.push(message);
        }) as typeof PubSub.default.pub);
        try {
            body.failing.add(1);
            expect(timeline.rollTo(2)).toBe(false);
            expect(timeline.position).toBe(4);
            expect(body.rollbackIndex).toBeUndefined();
            expect(errors).toEqual(["timeline.rollbackFailed"]);
        } finally {
            pub.mockRestore();
        }
    });

    test("rolling is view state: no undo step, nothing saved changes, undo keeps the marker", () => {
        const { document, s1, s2, body, timeline } = fixture();
        const before = document.history.undoCount();
        timeline.rollTo(2);
        expect(document.history.undoCount()).toBe(before);
        expect([s1.visible, s2.visible, body.visible]).toEqual([true, true, true]);
        expect(body.featuresJson).toBe(JSON.stringify(body.features));

        Transaction.execute(document, "rename", () => {
            s1.name = "Renamed";
        });
        document.history.undo();
        timeline.refresh();
        expect(s1.name).toBe("S1");
        expect(timeline.position).toBe(2);
        expect(body.rollbackIndex).toBe(1);
        expect(isHistoryHidden(s2)).toBe(true);
    });
});

describe("PartStudioTimeline edits while rolled back", () => {
    test("a node created while rolled back is placed at the marker and stays applied", () => {
        const { document, timeline } = fixture();
        timeline.rollTo(2);
        const created = new StepNode(document, "S3");
        document.modelManager.addNode(created);
        timeline.refresh();
        expect(keys(timeline)).toEqual(["S1", "B/f1", "S3", "S2", "B/f2"]);
        expect(timeline.position).toBe(3);
        expect(isHistoryHidden(created)).toBe(false);
    });

    test("removing the entry after the marker keeps the marker before the next survivor", () => {
        const { s2, body, timeline } = fixture();
        timeline.rollTo(2);
        body.setFeatures([{ id: "f1", nodeIds: ["S1"] }, { id: "f2" }]);
        s2.parent?.remove(s2);
        timeline.refresh();
        expect(keys(timeline)).toEqual(["S1", "B/f1", "B/f2"]);
        expect(timeline.position).toBe(2);
        expect(body.rollbackIndex).toBe(1);
    });

    test("a body a session restored to its full list follows the marker again", async () => {
        const { body, timeline } = fixture();
        timeline.rollTo(3);
        expect(body.rollbackIndex).toBe(1);
        // A sketch session ends: it releases the body it had rolled back.
        body.setRollbackIndex(undefined);
        await Promise.resolve();
        await Promise.resolve();
        expect(body.rollbackIndex).toBe(1);
        expect(timeline.position).toBe(3);
        // A feature dialog's numeric rollback is left alone.
        body.setRollbackIndex(2);
        await Promise.resolve();
        await Promise.resolve();
        expect(body.rollbackIndex).toBe(2);
    });
});

/** A node with nothing in the scene (a variable, a studio). */
class SilentNode extends StepNode {
    readonly sceneless = true as const;
}

describe("PartStudioTimeline steps", () => {
    test("sceneless nodes — variables, studios — are not steps", () => {
        const document = new TestDocument();
        const variables = new FolderNode({ document, name: "Variables" });
        variables.add(new SilentNode(document, "Width"), new SilentNode(document, "Height"));
        document.modelManager.addNode(
            new StepNode(document, "S1"),
            variables,
            new SilentNode(document, "Feature Studio 1"),
            new BodyNode(document, "B", [{ id: "f1", nodeIds: ["S1"] }]),
        );
        const timeline = PartStudioTimeline.of(document);
        timeline.refresh();
        expect(keys(timeline)).toEqual(["S1", "B/f1"]);
    });
});

describe("timelineLanes", () => {
    test("a feature belongs to its body; a shared sketch, a tool body and a body drawn on carry the other parts", () => {
        const document = new TestDocument();
        const s1 = new StepNode(document, "S1");
        const s2 = new StepNode(document, "S2");
        // S2 is drawn on A after its first feature.
        s2.nodeIds = ["A"];
        s2.anchors = { A: 1 };
        const a = new BodyNode(document, "A", [{ id: "f1", nodeIds: ["S1"] }, { id: "f2" }]);
        const b = new BodyNode(document, "B", [
            { id: "g1", nodeIds: ["S1"] },
            { id: "g2", nodeIds: ["A"] },
        ]);
        const c = new BodyNode(document, "C", [{ id: "h1", nodeIds: ["S2"] }]);
        document.modelManager.addNode(s1, a, b, s2, c);
        const timeline = PartStudioTimeline.of(document);
        timeline.refresh();
        expect(keys(timeline)).toEqual(["S1", "A/f1", "A/f2", "B/g1", "B/g2", "S2", "C/h1"]);
        const lanes = timelineLanes(timeline.entries);
        const named = Object.fromEntries(
            timeline.entries.map((entry, i) => [
                entry.key,
                { owner: lanes[i].owner?.name, users: lanes[i].users.map((part) => part.name) },
            ]),
        );
        expect(named).toEqual({
            S1: { owner: "A", users: ["B"] },
            "A/f1": { owner: "A", users: ["B", "C"] },
            "A/f2": { owner: "A", users: ["B"] },
            "B/g1": { owner: "B", users: [] },
            "B/g2": { owner: "B", users: [] },
            S2: { owner: "C", users: [] },
            "C/h1": { owner: "C", users: [] },
        });
    });

    test("a step no part reads has no owner", () => {
        const document = new TestDocument();
        document.modelManager.addNode(
            new StepNode(document, "Plane"),
            new BodyNode(document, "B", [{ id: "f1" }]),
        );
        const timeline = PartStudioTimeline.of(document);
        timeline.refresh();
        expect(timelineLanes(timeline.entries).map((lane) => lane.owner?.name)).toEqual([undefined, "B"]);
    });
});

describe("PartStudioTimeline groups", () => {
    test("grouping spans the picked steps, is saved with the document and is one undo step", () => {
        const { document, timeline } = fixture();
        const group = timeline.group(["B/f2", "B/f1"], "Base")!;
        expect(group).toBeDefined();
        expect(group.keys).toEqual(["B/f1", "S2", "B/f2"]);
        expect(group.collapsed).toBe(true);
        expect(timeline.groups).toEqual([group]);
        expect(timeline.groupOf("S2")).toBe(group);
        expect(timeline.groupOf("S1")).toBeUndefined();
        expect(document.userData?.[TIMELINE_GROUPS_KEY]).toEqual([
            { id: group.id, name: "Base", keys: ["B/f1", "S2", "B/f2"], collapsed: true },
        ]);

        document.history.undo();
        expect(timeline.groups).toEqual([]);
        expect(document.userData?.[TIMELINE_GROUPS_KEY]).toBeUndefined();
        document.history.redo();
        expect(timeline.groups).toEqual([group]);

        timeline.renameGroup(group.id, "  Body  ");
        expect(timeline.groups[0].name).toBe("Body");
        timeline.renameGroup(group.id, "   ");
        expect(timeline.groups[0].name).toBe("Body");
        const undos = document.history.undoCount();
        timeline.setGroupCollapsed(group.id, false);
        expect(timeline.groups[0].collapsed).toBe(false);
        expect(document.history.undoCount()).toBe(undos);
        timeline.ungroup(group.id);
        expect(timeline.groups).toEqual([]);
        document.history.undo();
        expect(timeline.groups[0]?.name).toBe("Body");
    });

    test("groups are numbered by default, a new group takes steps from an old one, vanished steps leave", () => {
        const { timeline, body } = fixture();
        const first = timeline.group(["S1"])!;
        expect(first.name).toBe("timeline.groupName1");
        const second = timeline.group(["S1", "B/f1"])!;
        expect(second.name).toBe("timeline.groupName2");
        // The first group lost its only step.
        expect(timeline.groups.map((group) => group.id)).toEqual([second.id]);
        expect(timeline.group(["nope"])).toBeUndefined();

        body.setFeatures([{ id: "f2", nodeIds: ["S2"] }]);
        timeline.refresh();
        expect(keys(timeline)).toEqual(["S1", "S2", "B/f2"]);
        expect(timeline.groups[0].keys).toEqual(["S1"]);
        body.setFeatures([]);
        timeline.refresh();
        expect(timeline.groups[0].keys).toEqual(["S1"]);
        timeline.ungroup(second.id);
        expect(timeline.groups).toEqual([]);
    });

    test("groups are read back from the document; malformed entries are dropped", () => {
        const document = new TestDocument();
        document.userData = {
            [TIMELINE_GROUPS_KEY]: [
                { id: "g1", name: "Kept", keys: ["S1", 7], collapsed: false },
                { id: "g2", name: "Empty", keys: [] },
                { id: 3, name: "Bad", keys: ["S1"] },
                "nonsense",
            ],
        };
        document.modelManager.addNode(new StepNode(document, "S1"));
        const timeline = PartStudioTimeline.of(document);
        timeline.refresh();
        expect(timeline.groups).toEqual([{ id: "g1", name: "Kept", keys: ["S1"], collapsed: false }]);
    });
});

describe("PartStudioTimeline reordering", () => {
    test("a feature moves inside its body and a sketch among its siblings (an undo step)", () => {
        const { document, timeline, body } = fixture();
        const names = () => {
            const result: string[] = [];
            for (let child = document.modelManager.rootNode.firstChild; child; child = child.nextSibling)
                result.push(child.name);
            return result;
        };
        // S1, B/f1, S2, B/f2 — f1 after f2 inside the body (f1 reads S1, which stays ahead).
        expect(timeline.move(["B/f1"], 3)).toBe(true);
        expect(body.features.map((feature) => feature.id)).toEqual(["f2", "f1"]);
        expect(keys(timeline)).toEqual(["S1", "S2", "B/f2", "B/f1"]);
        // S2 up front of the body: the document order becomes S1, S2, B.
        expect(timeline.move(["S2"], 1)).toBe(true);
        expect(names()).toEqual(["S1", "S2", "B"]);
        expect(keys(timeline)).toEqual(["S1", "S2", "B/f2", "B/f1"]);
        document.history.undo();
        expect(names()).toEqual(["S1", "B", "S2"]);
    });

    test("a step cannot move before what it reads; a group's steps move as a block", () => {
        const { document, timeline } = fixture();
        // f1 reads S1: before S1 is refused, nothing changes.
        expect(timeline.canMove(["B/f1"], 0)).toBe(false);
        expect(timeline.move(["B/f1"], 0)).toBe(false);
        expect(keys(timeline)).toEqual(["S1", "B/f1", "S2", "B/f2"]);
        // A sketch cannot pass the feature reading it.
        expect(timeline.canMove(["S1"], 3)).toBe(false);
        // The group S2 + f2 moves together before f1 — f1 does not read them, f2 still follows S2.
        timeline.group(["S2", "B/f2"], "Tail");
        expect(timeline.move(["S2", "B/f2"], 1)).toBe(true);
        expect(keys(timeline)).toEqual(["S1", "S2", "B/f2", "B/f1"]);
        expect(timeline.groups[0].keys).toEqual(["S2", "B/f2"]);
        expect(timeline.move(["nope"], 0)).toBe(false);
        // A sketch nothing later reads cannot sit between two features of one body.
        document.modelManager.addNode(new StepNode(document, "S3"));
        timeline.refresh();
        expect(keys(timeline)).toEqual(["S1", "S2", "B/f2", "B/f1", "S3"]);
        expect(timeline.canMove(["S3"], 3)).toBe(false);
        expect(timeline.canMove(["S3"], 2)).toBe(true);
    });

    test("orderRespectsDependencies checks features' sources and anchored sketches", () => {
        const document = new TestDocument();
        const s = new StepNode(document, "S");
        s.nodeIds = ["B"];
        s.anchors = { B: 1 };
        const body = new BodyNode(document, "B", [{ id: "f1" }, { id: "f2", nodeIds: ["S"] }]);
        document.modelManager.addNode(body, s);
        const timeline = PartStudioTimeline.of(document);
        timeline.refresh();
        const [f1, sketch, f2] = timeline.entries;
        expect(keys(timeline)).toEqual(["B/f1", "S", "B/f2"]);
        expect(orderRespectsDependencies([f1, sketch, f2])).toBe(true);
        // The sketch is drawn on f1: it cannot come first.
        expect(orderRespectsDependencies([sketch, f1, f2])).toBe(false);
        // f2 reads the sketch.
        expect(orderRespectsDependencies([f1, f2, sketch])).toBe(false);
    });
});
