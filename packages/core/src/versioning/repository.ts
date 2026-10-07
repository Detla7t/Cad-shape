// Part of the Chili3d Project, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

import { Result } from "../foundation/result";
import type { IObjectStore } from "./objectStore";
import type { CommitKind, CommitObj, ObjectHash } from "./objects";

export const DEFAULT_BRANCH = "Main";

/** A line of work: a movable head (Onshape's workspace). */
export interface BranchInfo {
    readonly name: string;
    readonly head: ObjectHash;
    /** The commit the branch was created from. */
    readonly base?: ObjectHash;
    readonly created: number;
}

/** A named, immutable snapshot (Onshape's version). */
export interface VersionInfo {
    readonly name: string;
    readonly commit: ObjectHash;
    readonly description: string;
    readonly created: number;
}

/** The mutable part of a history: which commits the names point at. */
export interface RefsData {
    readonly current: string;
    readonly branches: readonly BranchInfo[];
    readonly versions: readonly VersionInfo[];
}

export interface CommitInput {
    readonly tree: ObjectHash;
    readonly parents: readonly ObjectHash[];
    readonly kind: CommitKind;
    readonly message: string;
    readonly summary: readonly string[];
    readonly branch: string;
    readonly author?: string;
}

/** A commit with its id. */
export interface CommitEntry extends CommitObj {
    readonly id: ObjectHash;
}

/**
 * The commit graph and refs of one document: append-only commits in the object store, plus
 * branches (movable heads) and versions (immutable names).
 */
export class Repository {
    private readonly _branches = new Map<string, BranchInfo>();
    private readonly _versions = new Map<string, VersionInfo>();
    private _current = DEFAULT_BRANCH;
    /** Clock for commit times — replaceable so tests get deterministic ids. */
    now: () => number = () => Date.now();

    constructor(readonly store: IObjectStore) {}

    get current(): string {
        return this._current;
    }

    /** True once the repository has at least one branch (an initial commit was made or loaded). */
    get initialized(): boolean {
        return this._branches.size > 0;
    }

    commit(input: CommitInput): ObjectHash {
        let time = this.now();
        // Commit times never go backwards along the graph: the topological log and lane layout
        // read time as a tiebreaker, and a clock adjustment must not reorder history.
        for (const parent of input.parents) time = Math.max(time, this.getCommit(parent).time + 1);
        const commit: CommitObj = {
            t: "commit",
            tree: input.tree,
            parents: [...input.parents],
            time,
            kind: input.kind,
            message: input.message,
            summary: [...input.summary],
            branch: input.branch,
            ...(input.author === undefined ? {} : { author: input.author }),
        };
        return this.store.put(commit);
    }

    getCommit(id: ObjectHash): CommitObj {
        const commit = this.store.get(id);
        if (commit?.t !== "commit") throw new Error(`version store: ${id} is not a commit`);
        return commit;
    }

    hasCommit(id: ObjectHash): boolean {
        return this.store.get(id)?.t === "commit";
    }

    // ------------------------------------------------------------------ Branches

    branch(name: string): BranchInfo | undefined {
        return this._branches.get(name);
    }

    branches(): BranchInfo[] {
        return [...this._branches.values()].sort((a, b) =>
            a.name === DEFAULT_BRANCH ? -1 : b.name === DEFAULT_BRANCH ? 1 : a.created - b.created,
        );
    }

    /** The head of the current branch. */
    get head(): ObjectHash {
        const branch = this._branches.get(this._current);
        if (branch === undefined) throw new Error("version store: no current branch");
        return branch.head;
    }

    /** Creates the default branch at the first commit. */
    initialize(commit: ObjectHash): void {
        this._branches.clear();
        this._versions.clear();
        this._branches.set(DEFAULT_BRANCH, { name: DEFAULT_BRANCH, head: commit, created: this.now() });
        this._current = DEFAULT_BRANCH;
    }

    createBranch(name: string, from: ObjectHash): Result<BranchInfo> {
        const trimmed = name.trim();
        if (trimmed.length === 0) return Result.err("A branch needs a name");
        if (this._branches.has(trimmed)) return Result.err(`A branch named "${trimmed}" already exists`);
        if (!this.hasCommit(from)) return Result.err(`Unknown commit ${from}`);
        const branch: BranchInfo = { name: trimmed, head: from, base: from, created: this.now() };
        this._branches.set(trimmed, branch);
        return Result.ok(branch);
    }

    setHead(branch: string, commit: ObjectHash): void {
        const info = this._branches.get(branch);
        if (info === undefined) throw new Error(`version store: no branch ${branch}`);
        this._branches.set(branch, { ...info, head: commit });
    }

    setCurrent(branch: string): void {
        if (!this._branches.has(branch)) throw new Error(`version store: no branch ${branch}`);
        this._current = branch;
    }

    // ------------------------------------------------------------------ Versions

    versions(): VersionInfo[] {
        return [...this._versions.values()].sort((a, b) => a.created - b.created);
    }

    version(name: string): VersionInfo | undefined {
        return this._versions.get(name);
    }

    /** Names a commit. Versions are immutable: a name is never moved or reused. */
    createVersion(name: string, commit: ObjectHash, description = ""): Result<VersionInfo> {
        const trimmed = name.trim();
        if (trimmed.length === 0) return Result.err("A version needs a name");
        if (this._versions.has(trimmed)) return Result.err(`A version named "${trimmed}" already exists`);
        if (!this.hasCommit(commit)) return Result.err(`Unknown commit ${commit}`);
        const version: VersionInfo = { name: trimmed, commit, description, created: this.now() };
        this._versions.set(trimmed, version);
        return Result.ok(version);
    }

    versionsAt(commit: ObjectHash): VersionInfo[] {
        return this.versions().filter((x) => x.commit === commit);
    }

    // ------------------------------------------------------------------ Graph queries

    /** `commit` and every commit it descends from. */
    ancestors(commit: ObjectHash): Set<ObjectHash> {
        const seen = new Set<ObjectHash>();
        const stack = [commit];
        while (stack.length > 0) {
            const id = stack.pop()!;
            if (seen.has(id)) continue;
            seen.add(id);
            stack.push(...this.getCommit(id).parents);
        }
        return seen;
    }

    /** True when `ancestor` is `commit` or one of its ancestors. */
    isAncestor(ancestor: ObjectHash, commit: ObjectHash): boolean {
        return this.ancestors(commit).has(ancestor);
    }

    /**
     * The best common ancestors of two commits: common ancestors that are not ancestors of
     * another common ancestor. One in ordinary histories; several after criss-cross merges.
     * Sorted newest first.
     */
    mergeBases(a: ObjectHash, b: ObjectHash): ObjectHash[] {
        const fromA = this.ancestors(a);
        const common = [...this.ancestors(b)].filter((id) => fromA.has(id));
        const commonSet = new Set(common);
        const dominated = new Set<ObjectHash>();
        for (const id of common) {
            for (const ancestor of this.ancestors(id)) {
                if (ancestor !== id && commonSet.has(ancestor)) dominated.add(ancestor);
            }
        }
        return common
            .filter((id) => !dominated.has(id))
            .sort((x, y) => this.getCommit(y).time - this.getCommit(x).time || (x < y ? -1 : 1));
    }

    /**
     * Every commit reachable from a branch or version, newest first in topological order —
     * a commit is always listed before its parents.
     */
    log(): CommitEntry[] {
        const roots = [
            ...[...this._branches.values()].map((x) => x.head),
            ...[...this._versions.values()].map((x) => x.commit),
        ];
        const commits = new Map<ObjectHash, CommitObj>();
        const stack = [...roots];
        while (stack.length > 0) {
            const id = stack.pop()!;
            if (commits.has(id) || !this.hasCommit(id)) continue;
            const commit = this.getCommit(id);
            commits.set(id, commit);
            stack.push(...commit.parents);
        }
        // Kahn's algorithm over child → parent edges, newest ready commit first.
        const children = new Map<ObjectHash, number>();
        for (const commit of commits.values()) {
            for (const parent of commit.parents) children.set(parent, (children.get(parent) ?? 0) + 1);
        }
        const ready = [...commits.keys()].filter((id) => !children.has(id));
        const out: CommitEntry[] = [];
        const byTime = (x: ObjectHash, y: ObjectHash) =>
            commits.get(x)!.time - commits.get(y)!.time || (x < y ? -1 : 1);
        while (ready.length > 0) {
            ready.sort(byTime);
            const id = ready.pop()!;
            const commit = commits.get(id)!;
            out.push({ ...commit, id });
            for (const parent of commit.parents) {
                if (!commits.has(parent)) continue;
                const left = children.get(parent)! - 1;
                children.set(parent, left);
                if (left === 0) ready.push(parent);
            }
        }
        return out;
    }

    // ------------------------------------------------------------------ Persistence

    refs(): RefsData {
        return { current: this._current, branches: this.branches(), versions: this.versions() };
    }

    loadRefs(refs: RefsData): void {
        this._branches.clear();
        this._versions.clear();
        for (const branch of refs.branches) this._branches.set(branch.name, { ...branch });
        for (const version of refs.versions) this._versions.set(version.name, { ...version });
        this._current = this._branches.has(refs.current) ? refs.current : DEFAULT_BRANCH;
    }
}
