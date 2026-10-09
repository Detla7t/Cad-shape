// Part of the Chili3d Project, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

import { DocumentVersionControl, FolderNode, type INode, Transaction } from "../../src";
import { TestDocument } from "../../test-utils";

function newDocument(id = "doc-squash") {
    const document = new TestDocument();
    document.id = id;
    document.name = "Doc";
    document.modelManager.rootNode = new FolderNode({ document, name: "Doc", id: `${id}-root` });
    return document;
}

function add(document: TestDocument, ...nodes: INode[]) {
    Transaction.execute(document, "add nodes", () => document.modelManager.rootNode.add(...nodes));
}

function names(document: TestDocument) {
    return document.modelManager.findNodes().map((x) => x.name);
}

describe("uncommitted work and squashing", () => {
    let document: TestDocument;
    let vc: DocumentVersionControl;

    beforeEach(() => {
        document = newDocument();
        vc = DocumentVersionControl.create(document);
        created = 0;
    });

    afterEach(() => {
        vc.dispose();
        document.dispose();
    });

    let created = 0;
    function edits(count: number) {
        for (let i = 0; i < count; i++) {
            add(document, new FolderNode({ document, name: `N${created++}` }));
            vc.flush();
        }
    }

    test("the operations since the last named commit are the pending work, newest first", () => {
        // the initial commit is the document itself, not work waiting to be named
        expect(vc.pendingOperations()).toEqual([]);
        edits(3);
        expect(vc.pendingOperations().map((c) => c.message)).toEqual(["Add nodes", "Add nodes", "Add nodes"]);
        expect(vc.createCommit("First").isOk).toBe(true);
        expect(vc.pendingOperations()).toEqual([]);
        edits(1);
        expect(vc.pendingOperations()).toHaveLength(1);
        // a version is a boundary too
        expect(vc.createVersion("V1").isOk).toBe(true);
        expect(vc.pendingOperations()).toEqual([]);
    });

    test("committing with squash folds the pending operations into one commit", () => {
        expect(vc.createCommit("Start").isOk).toBe(true);
        edits(3);
        const before = vc.log().length;
        const commit = vc.createCommit("Three folders", { squash: true });
        expect(commit.isOk).toBe(true);
        const log = vc.log();
        expect(log).toHaveLength(before - 3 + 1);
        expect(log[0]).toMatchObject({ id: commit.value, kind: "checkpoint", message: "Three folders" });
        expect(log[0].summary).toEqual(["Added N0", "Added N1", "Added N2"]);
        expect(log[1].message).toBe("Start");
        expect(vc.operations(commit.value)).toEqual([]);
        expect(vc.pendingOperations()).toEqual([]);
        expect(names(document)).toEqual(["N0", "N1", "N2"]);
        // a plain commit keeps its operations beneath it
        edits(2);
        const kept = vc.createCommit("Two more");
        expect(kept.isOk).toBe(true);
        expect(vc.operations(kept.value)).toHaveLength(2);
    });

    test("squash to an earlier commit replaces everything after it with one commit", () => {
        edits(2);
        const base = vc.createCommit("Base");
        expect(base.isOk).toBe(true);
        edits(2);
        expect(vc.createCommit("Middle").isOk).toBe(true);
        edits(1);
        const headTree = vc.headCommit().tree;
        const squashed = vc.squash(base.value, "Everything since base");
        expect(squashed.isOk).toBe(true);
        expect(vc.head).toBe(squashed.value);
        expect(vc.headCommit()).toMatchObject({
            tree: headTree,
            parents: [base.value],
            kind: "checkpoint",
            message: "Everything since base",
        });
        expect(vc.log().map((c) => c.message)).toEqual([
            "Everything since base",
            "Base",
            "Add nodes",
            "Add nodes",
            "Document created",
        ]);
        // the squashed commits are no longer reachable, so they are not persisted
        const reachable = new Set(vc.reachableRecords().map(([hash]) => hash));
        expect(reachable.has(squashed.value)).toBe(true);
        expect(vc.log().some((c) => c.message === "Middle")).toBe(false);
        expect(names(document)).toEqual(["N0", "N1", "N2", "N3", "N4"]);
    });

    test("squash refuses ranges that a version or another branch still points into", () => {
        edits(1);
        const base = vc.head;
        edits(1);
        expect(vc.createVersion("Tagged").isOk).toBe(true);
        edits(1);
        const blocked = vc.squash(base, "Nope");
        expect(blocked.isOk).toBe(false);
        expect(blocked.error).toMatch(/Version Tagged/);

        const other = vc.head;
        edits(1);
        expect(vc.createBranch("Side", other, false).isOk).toBe(true);
        const branchBlocked = vc.squash(other, "Nope");
        expect(branchBlocked.isOk).toBe(true);
        edits(1);
        const branched = vc.squash(base, "Nope");
        expect(branched.isOk).toBe(false);
        expect(branched.error).toMatch(/Side/);
    });

    test("squash needs a commit on the first-parent history with something after it", () => {
        expect(vc.squash(vc.head, "Same").isOk).toBe(false);
        expect(vc.squash("not-a-commit", "Same").isOk).toBe(false);
        expect(vc.squash(vc.head, "").isOk).toBe(false);
        edits(1);
        const branchPoint = vc.head;
        expect(vc.createBranch("Elsewhere", branchPoint, true).isOk).toBe(true);
        edits(1);
        const elsewhere = vc.head;
        expect(vc.switchBranch("Main").isOk).toBe(true);
        edits(1);
        const offChain = vc.squash(elsewhere, "Off chain");
        expect(offChain.isOk).toBe(false);
        expect(offChain.error).toMatch(/first-parent/);
    });
});
