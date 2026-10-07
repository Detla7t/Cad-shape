// Part of the Chili3d Project, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

import { type CommitKind, layoutGraph, MemoryObjectStore, Repository } from "../../src";

function repo() {
    const repository = new Repository(new MemoryObjectStore());
    let clock = 1000;
    repository.now = () => clock++;
    const tree = (n: number) => repository.store.put({ t: "json", v: n });
    const commit = (parents: string[], branch = "Main", kind: CommitKind = "micro", label = "") =>
        repository.commit({ tree: tree(parents.length), parents, kind, message: label, summary: [], branch });
    return { repository, commit };
}

describe("Repository", () => {
    test("names branches and versions; versions are immutable", () => {
        const { repository, commit } = repo();
        const root = commit([]);
        repository.initialize(root);
        expect(repository.current).toBe("Main");
        expect(repository.head).toBe(root);
        const feature = repository.createBranch("Feature", root);
        expect(feature.isOk).toBe(true);
        expect(repository.createBranch("Feature", root).isOk).toBe(false);
        expect(repository.createBranch("  ", root).isOk).toBe(false);
        expect(repository.createVersion("V1", root, "first").isOk).toBe(true);
        expect(repository.createVersion("V1", root).isOk).toBe(false);
        expect(repository.versionsAt(root).map((v) => v.name)).toEqual(["V1"]);
    });

    test("commit times never run backwards along the graph", () => {
        const { repository } = repo();
        repository.now = () => 5;
        const tree = repository.store.put({ t: "json", v: 0 });
        const a = repository.commit({
            tree,
            parents: [],
            kind: "micro",
            message: "",
            summary: [],
            branch: "Main",
        });
        const b = repository.commit({
            tree,
            parents: [a],
            kind: "micro",
            message: "b",
            summary: [],
            branch: "Main",
        });
        expect(repository.getCommit(b).time).toBeGreaterThan(repository.getCommit(a).time);
    });

    test("finds the merge base of diverged branches", () => {
        const { repository, commit } = repo();
        const root = commit([]);
        const base = commit([root]);
        const ours = commit([commit([base])]);
        const theirs = commit([base], "Feature");
        repository.initialize(ours);
        expect(repository.mergeBases(ours, theirs)).toEqual([base]);
        expect(repository.isAncestor(base, ours)).toBe(true);
        expect(repository.isAncestor(theirs, ours)).toBe(false);
    });

    test("reports both best bases of a criss-cross history", () => {
        // a ─ b ─ m1 (merges c)        b and c are both best common ancestors of m1 and m2:
        //   ╲ c ─ m2 (merges b)        neither is an ancestor of the other.
        const { repository, commit } = repo();
        const a = commit([]);
        const b = commit([a]);
        const c = commit([a], "Feature");
        const m1 = commit([b, c], "Main", "merge");
        const m2 = commit([c, b], "Feature", "merge");
        repository.initialize(m1);
        expect(new Set(repository.mergeBases(m1, m2))).toEqual(new Set([b, c]));
        // A later commit on one side keeps the same two bases.
        const m1b = commit([m1]);
        expect(new Set(repository.mergeBases(m1b, m2))).toEqual(new Set([b, c]));
    });

    test("logs every reachable commit, children before parents", () => {
        const { repository, commit } = repo();
        const a = commit([]);
        const b = commit([a]);
        const c = commit([a], "Feature");
        const m = commit([b, c], "Main", "merge");
        repository.initialize(m);
        expect(repository.createBranch("Feature", c).isOk).toBe(true);
        const log = repository.log().map((x) => x.id);
        expect(log).toHaveLength(4);
        expect(log[0]).toBe(m);
        expect(log.at(-1)).toBe(a);
        expect(log.indexOf(c)).toBeLessThan(log.indexOf(a));
        expect(log.indexOf(b)).toBeLessThan(log.indexOf(a));
    });

    test("round-trips refs", () => {
        const { repository, commit } = repo();
        const a = commit([]);
        repository.initialize(a);
        repository.createBranch("B", a);
        repository.createVersion("V", a, "d");
        repository.setCurrent("B");
        const copy = new Repository(repository.store);
        copy.loadRefs(structuredClone(repository.refs()));
        expect(copy.refs()).toEqual(repository.refs());
        expect(copy.current).toBe("B");
    });
});

describe("layoutGraph", () => {
    test("keeps each branch in its own lane and draws the merge edge", () => {
        const { repository, commit } = repo();
        const a = commit([]);
        const b = commit([a]);
        const f1 = commit([b], "Feature");
        const c = commit([b]);
        const f2 = commit([f1], "Feature");
        const m = commit([c, f2], "Main", "merge");
        repository.initialize(m);
        repository.createBranch("Feature", f2);
        const rows = layoutGraph(repository.log(), ["Main", "Feature"], [m, f2]);
        const lane = (id: string) => rows.find((r) => r.commit.id === id)!.lane;
        expect([m, c, b, a].map(lane)).toEqual([0, 0, 0, 0]);
        expect([f2, f1].map(lane)).toEqual([1, 1]);
        const merge = rows.find((r) => r.commit.id === m)!;
        expect(merge.below).toEqual([
            { from: 0, to: 0, color: 0 },
            { from: 0, to: 1, color: 1 },
        ]);
        // The feature lane is not drawn above its head, and closes into its fork point.
        expect(rows[0].through).toEqual([]);
        const fork = rows.find((r) => r.commit.id === b)!;
        expect(fork.above).toEqual(
            expect.arrayContaining([
                { from: 0, to: 0, color: 0 },
                { from: 1, to: 0, color: 1 },
            ]),
        );
    });
});
