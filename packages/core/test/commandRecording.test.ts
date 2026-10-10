// Part of the Chili3d Project, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

import {
    COMMAND_RECORDING_KEY,
    CommandRecorder,
    type CommandRecordingData,
    captureHistoryStep,
    clearRecording,
    FolderNode,
    type INode,
    NodeUtils,
    PmiNote,
    PropertyHistoryRecord,
    RECORDED_ROOT,
    readRecording,
    recordingToFeatureScript,
    replayRecording,
    Transaction,
    XYZ,
} from "@chili3d/core";
import { TestDocument } from "@chili3d/core/test-utils";

const recorders: CommandRecorder[] = [];

function recordedDocument() {
    const document = new TestDocument();
    const recorder = CommandRecorder.of(document);
    recorder.start();
    recorders.push(recorder);
    return { document, recorder };
}

afterEach(() => {
    for (const recorder of recorders.splice(0)) recorder.stop();
});

function note(document: TestDocument, text: string, x = 0) {
    return new PmiNote({ document, text, anchor: new XYZ(x, 0, 0), position: new XYZ(x, 10, 0) });
}

/** The model as plain data: class, name, the note text and anchor, and children. */
function outline(node: INode): unknown {
    const entry: Record<string, unknown> = { cls: node.constructor.name, name: node.name };
    if (node instanceof PmiNote) {
        entry["content"] = node.content;
        entry["anchor"] = node.anchor.toArray();
    }
    if (NodeUtils.isLinkedListNode(node)) {
        const children: unknown[] = [];
        for (let child = node.firstChild; child !== undefined; child = child.nextSibling) {
            children.push(outline(child));
        }
        entry["children"] = children;
    }
    return entry;
}

const model = (document: TestDocument) => outline(document.modelManager.rootNode);

/** Records create, edit, move, variables and remove steps in a fresh document. */
function recordSession() {
    const { document, recorder } = recordedDocument();
    const folder = new FolderNode({ document, name: "Notes" });
    const first = note(document, "DEBURR", 1);
    const second = note(document, "BREAK EDGES", 2);
    Transaction.execute(document, "create notes", () => {
        folder.add(first);
        document.modelManager.addNode(folder, second);
    });
    Transaction.execute(document, "edit note", () => {
        first.content = "DEBURR ALL EDGES";
    });
    Transaction.execute(document, "move note", () => {
        second.parent?.move(second, folder, first);
    });
    Transaction.execute(document, "variables", () => {
        document.variables.setItems([
            { id: "v1", name: "width", type: "length", expression: "25 mm" },
            { id: "v2", name: "depth", type: "length", expression: "width * 2" },
        ]);
    });
    const scrap = note(document, "SCRAP", 3);
    Transaction.execute(document, "add scrap", () => {
        document.modelManager.addNode(scrap);
    });
    Transaction.execute(document, "remove scrap", () => {
        scrap.parent?.remove(scrap);
    });
    return { document, recorder, folder, first, second };
}

describe("command recording capture", () => {
    test("each completed undo step becomes one step with its node changes", () => {
        const { document, first } = recordSession();
        const steps = readRecording(document).steps;
        expect(steps.map((step) => step.name)).toEqual([
            "create notes",
            "edit note",
            "move note",
            "variables",
            "add scrap",
            "remove scrap",
        ]);
        const [create, edit, move, variables, , remove] = steps;
        expect(create.changes).toHaveLength(2);
        const [addFolder, addNote] = create.changes;
        expect(addFolder.kind).toBe("add");
        expect(addFolder.kind === "add" && addFolder.parentId).toBe(RECORDED_ROOT);
        expect(addFolder.kind === "add" && addFolder.nodes.map((node) => node["name"])).toEqual([
            "Notes",
            "Note",
        ]);
        expect(addNote.kind === "add" && addNote.nodes[0]["content"]).toBe("BREAK EDGES");
        expect(edit.changes).toEqual([
            { kind: "set", nodeId: first.id, property: "content", value: "DEBURR ALL EDGES" },
        ]);
        expect(move.changes).toEqual([
            expect.objectContaining({
                kind: "move",
                parentId: expect.any(String),
                previousId: expect.any(String),
            }),
        ]);
        expect(variables.changes).toEqual([
            {
                kind: "variables",
                upserts: [
                    { id: "v1", name: "width", type: "length", expression: "25 mm" },
                    { id: "v2", name: "depth", type: "length", expression: "width * 2" },
                ],
                removed: [],
            },
        ]);
        expect(remove.changes).toEqual([{ kind: "remove", nodeId: expect.any(String) }]);
        expect(steps.every((step) => step.unsupported.length === 0)).toBe(true);
    });

    test("queries, undo, redo and selection are not recorded", () => {
        const { document } = recordedDocument();
        const folder = new FolderNode({ document, name: "F" });
        Transaction.execute(document, "add", () => document.modelManager.addNode(folder));
        // Queries read the model without an undo step.
        document.modelManager.findNode((node) => node.name === "F");
        readRecording(document);
        document.history.undo();
        document.history.redo();
        // Activating a component only says where new nodes go.
        Transaction.execute(document, "activate", () => {
            document.history.add(
                new PropertyHistoryRecord(document.modelManager, "currentNode", folder, undefined),
            );
        });
        expect(readRecording(document).steps.map((step) => step.name)).toEqual(["add"]);
    });

    test("selection, timeline and review leaves capture nothing", () => {
        const document = new TestDocument();
        const ignored = ["selection.clear", "timeline:group", "add review comment"].map((name) => ({
            name,
            undo() {},
            redo() {},
            dispose() {},
        }));
        for (const record of ignored) expect(captureHistoryStep(document, record)).toBeUndefined();
        const other = { name: "material.edit", undo() {}, redo() {}, dispose() {} };
        expect(captureHistoryStep(document, other)?.unsupported).toEqual(["material.edit"]);
    });

    test("with recording off, modeling still works and nothing is recorded", () => {
        const { document, recorder } = recordedDocument();
        recorder.stop();
        expect(recorder.recording).toBe(false);
        const folder = new FolderNode({ document, name: "Unrecorded" });
        Transaction.execute(document, "add", () => document.modelManager.addNode(folder));
        expect(document.modelManager.findNode((node) => node.name === "Unrecorded")).toBe(folder);
        expect(document.history.undoCount()).toBe(1);
        expect(readRecording(document).steps).toEqual([]);
        expect(document.userData?.[COMMAND_RECORDING_KEY]).toBeUndefined();
    });
});

describe("command recording replay", () => {
    test("a recording survives JSON and replays into another document with the same model", () => {
        const { document: source } = recordSession();
        const saved = JSON.parse(JSON.stringify(source.userData)) as Record<string, unknown>;
        const target = new TestDocument();
        target.userData = saved;
        expect(readRecording(target).steps).toHaveLength(6);

        const result = replayRecording(target);
        expect(result.isOk).toBe(true);
        expect(result.value).toEqual({
            steps: 6,
            added: 4,
            edited: 1,
            moved: 1,
            removed: 1,
            variables: 1,
            skipped: [],
        });
        expect(model(target)).toEqual(model(source));
        expect(
            target.variables.items.map(({ name, type, expression }) => ({ name, type, expression })),
        ).toEqual([
            { name: "width", type: "length", expression: "25 mm" },
            { name: "depth", type: "length", expression: "width * 2" },
        ]);
        const sourceIds = new Set(source.modelManager.findNodes(() => true).map((node) => node.id));
        const targetIds = target.modelManager.findNodes(() => true).map((node) => node.id);
        expect(targetIds.length).toBe(sourceIds.size);
        expect(targetIds.some((id) => sourceIds.has(id))).toBe(false);
    });

    test("replay is one undo step that undoes and redoes as a whole", () => {
        const { document: source } = recordSession();
        const target = new TestDocument();
        const empty = model(target);
        const result = replayRecording(target, readRecording(source).steps);
        expect(result.isOk).toBe(true);
        expect(target.history.undoCount()).toBe(1);
        const replayed = model(target);
        expect(replayed).toEqual(model(source));

        target.history.undo();
        expect(model(target)).toEqual(empty);
        expect(target.variables.items).toEqual([]);

        target.history.redo();
        expect(model(target)).toEqual(replayed);
        expect(target.variables.items.map((item) => item.name)).toEqual(["width", "depth"]);
    });

    test("replaying into the recording document adds fresh copies and is not recorded again", () => {
        const { document } = recordedDocument();
        const folder = new FolderNode({ document, name: "Once" });
        Transaction.execute(document, "add", () => document.modelManager.addNode(folder));
        const result = replayRecording(document);
        expect(result.isOk).toBe(true);
        const copies = document.modelManager.findNodes((node) => node.name === "Once");
        expect(copies).toHaveLength(2);
        expect(copies[0].id).not.toBe(copies[1].id);
        expect(readRecording(document).steps).toHaveLength(1);
    });

    test("changes to nodes the target lacks are skipped and reported", () => {
        const target = new TestDocument();
        const result = replayRecording(target, [
            {
                name: "edit",
                time: 0,
                changes: [{ kind: "set", nodeId: "missing", property: "name", value: "X" }],
                unsupported: ["Material.color"],
            },
        ]);
        expect(result.isOk).toBe(true);
        expect(result.value.edited).toBe(0);
        expect(result.value.skipped).toEqual(["edit: Material.color", "edit: set failed (no node missing)"]);
    });

    test("an empty recording does not replay", () => {
        const document = new TestDocument();
        const result = replayRecording(document);
        expect(result.isOk).toBe(false);
        expect(result.error).toBe("The recording is empty.");
        expect(document.history.undoCount()).toBe(0);
    });

    test("clearing empties the stored recording", () => {
        const { document } = recordSession();
        clearRecording(document);
        expect(document.userData?.[COMMAND_RECORDING_KEY]).toEqual({
            version: 1,
            steps: [],
        } satisfies CommandRecordingData);
    });
});

describe("recording to FeatureScript", () => {
    test("plain variables become setVariable calls; node changes are reported as not expressible", () => {
        const { document } = recordSession();
        const { source, unsupported } = recordingToFeatureScript(readRecording(document).steps);
        expect(source.startsWith("FeatureScript 3083;\n")).toBe(true);
        expect(source).toContain('setVariable(context, "width", 25 * millimeter);');
        expect(source).toContain("// not expressible: #depth = width * 2");
        expect(unsupported).toContain("variables: variable depth = width * 2");
        expect(unsupported).toContain('create notes: add FolderNode "Notes", PmiNote "Note"');
        expect(unsupported.some((line) => line.startsWith("edit note: set content of "))).toBe(true);
        expect(unsupported.filter((line) => line.startsWith("remove scrap: remove "))).toHaveLength(1);
    });
});
