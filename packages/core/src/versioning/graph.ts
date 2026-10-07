// Part of the Chili3d Project, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

import type { ObjectHash } from "./objects";
import type { CommitEntry } from "./repository";

/** A line segment of one graph row, between two lanes. */
export interface GraphEdge {
    readonly from: number;
    readonly to: number;
    readonly color: number;
}

/** One row of the version graph: the commit's lane and the lines crossing the row. */
export interface GraphRow {
    readonly commit: CommitEntry;
    readonly lane: number;
    readonly color: number;
    /** Lanes running straight through the row, top to bottom. */
    readonly through: readonly GraphEdge[];
    /** Lines from the top edge into the commit (its own lane, and children's lanes merging in). */
    readonly above: readonly GraphEdge[];
    /** Lines from the commit to the bottom edge, one per parent lane. */
    readonly below: readonly GraphEdge[];
}

/**
 * Lays a topologically sorted log (newest first) out in lanes, git-graph style: a commit's
 * first parent continues its lane, further parents (merges) open or join other lanes, lanes
 * meeting at a common parent close into it. Colors index `branchOrder` by the branch each commit
 * was made on, so a branch keeps one color down its lane. `heads` (the branch heads, in
 * `branchOrder`) reserve the first lanes, so the default branch is always the leftmost lane and
 * each branch keeps its own lane from the top.
 */
export function layoutGraph(
    commits: readonly CommitEntry[],
    branchOrder: readonly string[],
    heads: readonly ObjectHash[] = [],
): GraphRow[] {
    const byId = new Map<ObjectHash, CommitEntry>(commits.map((c) => [c.id, c]));
    const colorOf = (id: ObjectHash | undefined) => {
        const branch = id === undefined ? undefined : byId.get(id)?.branch;
        const index = branch === undefined ? -1 : branchOrder.indexOf(branch);
        return index < 0 ? branchOrder.length + (branch?.length ?? 0) : index;
    };
    const lanes: (ObjectHash | undefined)[] = [];
    /** The color each lane is drawn in — the branch of the commit that opened it. */
    const laneColors: number[] = [];
    /** False for a lane reserved for a branch head not reached yet — nothing is drawn above it. */
    const laneOpen: boolean[] = [];
    for (const head of heads) {
        if (!byId.has(head) || lanes.includes(head)) continue;
        lanes.push(head);
        laneColors.push(colorOf(head));
        laneOpen.push(false);
    }
    const rows: GraphRow[] = [];
    const freeLane = () => {
        const index = lanes.indexOf(undefined);
        return index < 0 ? lanes.length : index;
    };

    for (const commit of commits) {
        const color = colorOf(commit.id);
        let lane = lanes.indexOf(commit.id);
        if (lane < 0) lane = freeLane();

        const above: GraphEdge[] = [];
        const through: GraphEdge[] = [];
        lanes.forEach((expected, index) => {
            if (expected === undefined) return;
            if (expected === commit.id) {
                if (laneOpen[index]) above.push({ from: index, to: lane, color: laneColors[index] });
                if (index !== lane) lanes[index] = undefined;
            } else if (laneOpen[index]) {
                through.push({ from: index, to: index, color: laneColors[index] });
            }
        });

        const below: GraphEdge[] = [];
        const parents = commit.parents.filter((p) => byId.has(p));
        lanes[lane] = parents[0];
        laneColors[lane] = color;
        laneOpen[lane] = true;
        if (parents.length > 0) below.push({ from: lane, to: lane, color });
        for (const parent of parents.slice(1)) {
            let target = lanes.indexOf(parent);
            if (target < 0 || target === lane) {
                target = freeLane();
                lanes[target] = parent;
                laneColors[target] = colorOf(parent);
            }
            laneOpen[target] = true;
            below.push({ from: lane, to: target, color: laneColors[target] });
        }
        while (lanes.length > 0 && lanes[lanes.length - 1] === undefined) {
            lanes.pop();
            laneColors.pop();
            laneOpen.pop();
        }
        rows.push({ commit, lane, color, through, above, below });
    }
    return rows;
}

/** The widest row's lane count — the graph column width in lanes. */
export function graphWidth(rows: readonly GraphRow[]): number {
    let width = 1;
    for (const row of rows) {
        for (const edge of [...row.through, ...row.above, ...row.below])
            width = Math.max(width, edge.from + 1, edge.to + 1);
        width = Math.max(width, row.lane + 1);
    }
    return width;
}
