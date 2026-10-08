// Part of the Chili3d Project, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

import { DocumentVersionControl, FolderNode, readTree, Transaction, treeChanges } from "../../src";
import { TestDocument } from "../../test-utils";

describe("selected commit changes", () => {
    let document: TestDocument;
    let control: DocumentVersionControl;
    let node: FolderNode;
    beforeEach(() => {
        document = new TestDocument();
        node = new FolderNode({ document, name: "Original" });
        document.modelManager.rootNode.add(node);
        control = DocumentVersionControl.create(document);
    });
    afterEach(() => {
        control.dispose();
        document.dispose();
    });

    const edit = (fn: () => void) => {
        Transaction.execute(document, "Edit folder", fn);
        control.flush();
        return control.head;
    };

    test("revert one field, keep unrelated changes, and undo the revert", () => {
        const source = edit(() => {
            node.name = "Renamed";
            node.visible = false;
        });
        const rename = control.changes(source).find((c) => c.label.endsWith(" › name"))!;
        expect(rename).toMatchObject({ before: "Original", after: "Renamed" });
        const preview = control.previewChanges(source, [rename.id], "revert");
        expect(preview.isOk).toBe(true);
        expect(preview.value.conflicts).toHaveLength(0);
        expect(node.name).toBe("Renamed");
        expect(control.applyChanges(preview.value).isOk).toBe(true);
        expect(node.name).toBe("Original");
        expect(node.visible).toBe(false);
        expect(control.commit(source).tree).not.toBe(control.headCommit().tree);
        document.history.undo();
        expect(node.name).toBe("Renamed");
        expect(node.visible).toBe(false);
    });

    test("applying selected changes uses a three-way conflict review", () => {
        const base = control.head;
        const source = edit(() => {
            node.name = "Incoming";
            node.visible = false;
        });
        const selected = control
            .changes(source)
            .filter((c) => c.label.endsWith(" › name"))
            .map((c) => c.id);
        expect(control.createBranch("Target", base).isOk).toBe(true);
        edit(() => {
            node.name = "Local";
        });
        const preview = control.previewChanges(source, selected, "apply");
        expect(preview.isOk).toBe(true);
        expect(preview.value.conflicts).toHaveLength(1);
        expect(control.applyChanges(preview.value).isOk).toBe(false);
        expect(node.name).toBe("Local");
        expect(
            control.applyChanges(preview.value, new Map([[preview.value.conflicts[0].id, "theirs"]])).isOk,
        ).toBe(true);
        expect(node.name).toBe("Incoming");
        expect(node.visible).toBe(true);
    });

    test("a preview cannot overwrite edits made after it", () => {
        const source = edit(() => {
            node.name = "Incoming";
        });
        const preview = control.previewChanges(
            source,
            control.changes(source).map((c) => c.id),
            "revert",
        );
        expect(preview.isOk).toBe(true);
        edit(() => {
            node.visible = false;
        });
        expect(control.applyChanges(preview.value).isOk).toBe(false);
        expect(node.name).toBe("Incoming");
        expect(node.visible).toBe(false);
    });

    test("rebase omits one change, replays later commits, and preserves the source branch", () => {
        const base = control.head;
        const source = edit(() => {
            node.name = "Renamed";
            node.visible = false;
        });
        const omitted = control
            .changes(source)
            .filter((c) => c.label.endsWith(" › visible"))
            .map((c) => c.id);
        const head = edit(() => {
            node.name = "Later";
        });
        const preview = control.previewRebase(source, omitted, base);
        expect(preview.isOk).toBe(true);
        expect(preview.value.steps).toHaveLength(2);
        expect(preview.value.conflicts).toHaveLength(0);
        expect(control.rebase(preview.value, "Without hiding").isOk).toBe(true);
        expect(control.currentBranch).toBe("Without hiding");
        expect(node.name).toBe("Later");
        expect(node.visible).toBe(true);
        expect(control.repository.branch("Main")?.head).toBe(head);
        expect(control.switchBranch("Main").isOk).toBe(true);
        expect(node.name).toBe("Later");
        expect(node.visible).toBe(false);
    });

    test("rebase detects a later edit depending on an omitted field", () => {
        const base = control.head;
        const source = edit(() => {
            node.name = "First";
        });
        const omitted = control.changes(source).map((c) => c.id);
        edit(() => {
            node.name = "Second";
        });
        const preview = control.previewRebase(source, omitted, base);
        expect(preview.isOk).toBe(true);
        expect(preview.value.conflicts).toHaveLength(1);
        expect(control.rebase(preview.value, "Rebased").isOk).toBe(false);
        expect(control.branches()).toHaveLength(1);
        const resolutions = new Map([[preview.value.conflicts[0].id, "ours" as const]]);
        expect(control.rebase(preview.value, "Rebased", resolutions).isOk).toBe(true);
        expect(node.name).toBe("Original");
    });

    test("explicit commits have a message and retain the operation history", () => {
        const previous = edit(() => {
            node.name = "Edited";
        });
        const created = control.createCommit("Ready to review");
        expect(created.isOk).toBe(true);
        expect(control.headCommit()).toMatchObject({ message: "Ready to review", parents: [previous] });
        expect(control.createCommit(" ").isOk).toBe(false);
    });

    test("selecting a delta repeatedly does not carry changes from the previous selection", () => {
        const before = control.headCommit().tree;
        edit(() => {
            node.name = "Renamed";
            node.visible = false;
        });
        const delta = treeChanges(control.store, before, control.headCommit().tree);
        expect(delta.select(delta.changes.map((c) => c.id)).value).toBe(control.headCommit().tree);
        expect(delta.select([]).value).toBe(before);
        expect(delta.select(["not-a-change"]).isOk).toBe(false);
    });

    test("new parents and children can be selected together and incomplete structures are rejected", () => {
        const before = control.headCommit().tree;
        const child = new FolderNode({ document, name: "Child", id: "a-child" });
        const parent = new FolderNode({ document, name: "Parent", id: "z-parent" });
        edit(() => {
            parent.add(child);
            node.add(parent);
        });
        const delta = treeChanges(control.store, before, control.headCommit().tree);
        expect(delta.changes).toHaveLength(2);
        const both = delta.select(delta.changes.map((c) => c.id));
        expect(both.isOk).toBe(true);
        expect(readTree(control.store, both.value).nodes.get(parent.id)?.children).toEqual([child.id]);
        const justChild = delta.changes.filter((c) => c.label === "Child").map((c) => c.id);
        expect(delta.select(justChild).isOk).toBe(false);
    });
});
