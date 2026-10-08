// Part of the Chili3d Project, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

import {
    addReviewComment,
    Constants,
    deleteReviewComment,
    findWhereUsed,
    MemoryObjectStore,
    Repository,
    referencesInSnapshot,
    reviewComments,
    StorageHistoryPersistence,
    type UsageSnapshot,
    updateReviewComment,
    writeSnapshot,
} from "../src";
import { createMockApplication, TestDocument } from "../test-utils";

test("review comments preserve target, tags, images and markup through undo/redo", () => {
    const doc = new TestDocument();
    doc.userData = { other: "kept" };
    const target = { documentId: doc.id, nodeId: "sketch", featureId: "dimension", name: "Sketch / Width" };
    const image = { name: "markup.png", dataUrl: "data:image/png;base64,aGVsbG8=", markup: true };
    try {
        const comment = addReviewComment(doc, {
            target,
            text: " Change this width ",
            tags: ["#review", "review", " machining "],
            images: [image],
        });
        expect(reviewComments(doc)[0]).toMatchObject({
            target,
            text: "Change this width",
            tags: ["review", "machining"],
            images: [image],
            resolved: false,
        });
        expect(doc.userData["other"]).toBe("kept");
        updateReviewComment(doc, comment.id, { resolved: true });
        expect(reviewComments(doc)[0].resolved).toBe(true);
        doc.history.undo();
        expect(reviewComments(doc)[0].resolved).toBe(false);
        deleteReviewComment(doc, comment.id);
        expect(reviewComments(doc)).toEqual([]);
        doc.history.undo();
        expect(reviewComments(doc)[0].id).toBe(comment.id);
        doc.history.undo();
        expect(reviewComments(doc)).toEqual([]);
        doc.history.redo();
        expect(reviewComments(doc)[0].images).toEqual([image]);
        const copy = reviewComments(doc);
        copy[0].text = "unrecorded";
        expect(reviewComments(doc)[0].text).toBe("Change this width");
    } finally {
        doc.dispose();
    }
});

const snapshot: UsageSnapshot = {
    documentId: "A",
    documentName: "Bracket",
    label: "Version V2",
    commit: "consumer-commit",
    nodes: [
        {
            id: "body",
            name: "Bracket",
            props: {
                featuresJson: JSON.stringify([
                    { id: "extrude", type: "extrude", sketchId: "sketch" },
                    { id: "fillet", type: "fillet", edges: [{ nodeId: "body", featureId: "extrude" }] },
                ]),
                comment: "sketch",
            },
        },
        {
            id: "assembly",
            name: "Assembly",
            props: {
                instancesJson: JSON.stringify([
                    {
                        id: "instance",
                        source: {
                            kind: "link",
                            link: {
                                documentId: "B",
                                nodeId: "sketch",
                                version: { kind: "version", name: "V3" },
                                resolvedCommit: "source-commit",
                            },
                        },
                    },
                ]),
            },
        },
    ],
};
test("where used identifies feature owners and separates source document/version from consumer history", () => {
    const local = referencesInSnapshot(snapshot, { documentId: "A", nodeId: "sketch", name: "Sketch" });
    expect(local).toHaveLength(1);
    expect(local[0]).toMatchObject({
        nodeId: "body",
        featureId: "extrude",
        featureName: "extrude",
        label: "Version V2",
        commit: "consumer-commit",
    });
    const linked = referencesInSnapshot(snapshot, { documentId: "B", nodeId: "sketch", name: "Linked part" });
    expect(linked).toHaveLength(1);
    expect(linked[0]).toMatchObject({
        nodeId: "assembly",
        sourceVersion: "version: V3",
        sourceCommit: "source-commit",
    });
});
test("where used follows the feature chain and does not invent references for missing features", () => {
    const rows = referencesInSnapshot(snapshot, {
        documentId: "A",
        nodeId: "body",
        featureId: "extrude",
        name: "Extrude",
    });
    expect(rows.map((row) => row.featureId)).toEqual(["fillet", "fillet"]);
    expect(rows.map((row) => row.path)).toContain("Previous feature in body");
    expect(
        referencesInSnapshot(snapshot, {
            documentId: "A",
            nodeId: "body",
            featureId: "absent",
            name: "Deleted",
        }),
    ).toEqual([]);
});

test("where used finds a historical sketch reference after it was removed from the saved workspace", async () => {
    const data = new Map<string, unknown>();
    const app = createMockApplication({
        storage: {
            get: async (_database, table, id) => data.get(`${table}/${id}`),
            put: async (_database, table, id, value) => {
                data.set(`${table}/${id}`, structuredClone(value));
                return true;
            },
            page: async (_database, table, page) =>
                page === 0
                    ? [...data.entries()]
                          .filter(([key]) => key.startsWith(`${table}/`))
                          .map(([, value]) => value)
                    : [],
        },
    });
    const store = new MemoryObjectStore(),
        repository = new Repository(store);
    const tree = writeSnapshot(store, {
        meta: { name: "Historical bracket", userData: {}, acts: [] },
        rootId: "root",
        nodes: new Map([
            ["root", { cls: "FolderNode", props: { name: "Root" }, children: ["body"] }],
            [
                "body",
                {
                    cls: "ParametricBodyNode",
                    props: {
                        name: "Bracket",
                        featuresJson: JSON.stringify([
                            { id: "extrude", type: "extrude", sketchId: "sketch" },
                        ]),
                    },
                },
            ],
        ]),
        variables: [],
        materials: [],
        components: [],
    });
    const commit = repository.commit({
        tree,
        parents: [],
        kind: "micro",
        message: "Extrude sketch",
        summary: [],
        branch: "Main",
    });
    repository.initialize(commit);
    expect(repository.createVersion("V1", commit).isOk).toBe(true);
    const all = () => [...store.hashes()].map((hash) => [hash, store.record(hash)!] as const);
    await new StorageHistoryPersistence(app.storage).save("consumer", repository.refs(), all(), all);
    await app.storage.put(Constants.DBName, Constants.DocumentTable, "consumer", {
        id: "consumer",
        name: "Historical bracket",
        models: { nodes: [] },
    });
    const target = { documentId: "consumer", nodeId: "sketch", name: "Sketch" };
    expect((await findWhereUsed(app, target, false)).references).toEqual([]);
    const result = await findWhereUsed(app, target, true);
    expect(result.warnings).toEqual([]);
    expect(result.references.map((row) => row.label)).toEqual(["Version V1", "Branch Main"]);
    expect(result.references.every((row) => row.commit === commit && row.featureId === "extrude")).toBe(true);
});
