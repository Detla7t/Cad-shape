// Part of the Chili3d Project, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

import {
    type IDocument,
    type INode,
    isDependentNode,
    isVariableFeatureNode,
    isVariableStudioNode,
    NodeUtils,
    OriginNode,
    ShapeNode,
} from "@chili3d/core";

/**
 * Which results own which features — Fusion's component colour cycling, in the tree. The
 * owners are either every solid result (a sketch, a body) or every top-level part (an
 * imported or linked part and all it holds), by preference; datums (the origin, the
 * planes) and variables are nobody's. Each owner takes a colour and a LANE: a row shows a
 * bar in the lane of every owner that uses it — the owner itself, what it depends on (its
 * plane, its sketches and tools, the variables its dimensions read, and theirs), and a
 * folder the lanes of what it holds. Bars of different owners therefore never share a
 * lane; only the same owner's bars line up. Three lanes: past the third owner the lanes
 * repeat (the colour still tells the owners apart) and a row whose owners would meet in
 * one lane packs them in owner order; a row owned by more than three draws the striped
 * "many" bar instead. One owner, or none, means no colouring.
 */

export type OwnerMode = "off" | "solid" | "part";

/** The lanes a row's bars may take. */
export const OWNER_LANES = 3;

/** Sixteen distinct, mid-saturation colours that read on light and dark panels. */
export const OWNER_PALETTE: readonly string[] = [
    "#9bd36a",
    "#f28c7a",
    "#6c86e8",
    "#6fd9a4",
    "#f49ac1",
    "#f5c35a",
    "#7fd3e8",
    "#c39be0",
    "#ff9f5a",
    "#8fdc8f",
    "#e07a9b",
    "#5fb8d8",
    "#d4c35a",
    "#b58cff",
    "#f0a86e",
    "#7ab8a0",
];

export interface Ownership {
    /** Palette index per owning result, by node id — every owner's own id included. */
    readonly ownersOf: ReadonlyMap<string, readonly number[]>;
    /** The results, in tree order: palette index → node. */
    readonly owners: readonly INode[];
}

const NO_OWNERSHIP: Ownership = { ownersOf: new Map(), owners: [] };

/** A result: a shape-bearing node that is not a datum, a variable or a studio. */
function isResult(node: INode): boolean {
    return (
        node instanceof ShapeNode &&
        !(node instanceof OriginNode) &&
        !isVariableFeatureNode(node) &&
        !isVariableStudioNode(node)
    );
}

/** Variables by name → the node defining them (the last definition wins, as the scope's does). */
function variableOwners(nodes: readonly INode[]): Map<string, INode> {
    const byName = new Map<string, INode>();
    for (const node of nodes) {
        if (!isVariableFeatureNode(node) && !isVariableStudioNode(node)) continue;
        for (const item of (node as { items: readonly { name: string }[] }).items)
            byName.set(item.name, node);
    }
    return byName;
}

/**
 * A part: a top-level node of the model tree that is a result or holds one (an imported
 * part's folder, a linked part, a body). Default geometry and a folder of variables are not.
 */
function partOwners(document: IDocument): INode[] {
    const root = document.modelManager.rootNode;
    return NodeUtils.findNodes(root).filter(
        (node) =>
            node.parent === root &&
            node !== root &&
            (isResult(node) ||
                (NodeUtils.isLinkedListNode(node) &&
                    NodeUtils.findNodes(node).some((inner) => inner !== node && isResult(inner)))),
    );
}

export function computeOwnership(document: IDocument, mode: OwnerMode = "solid"): Ownership {
    if (mode === "off") return NO_OWNERSHIP;
    const nodes = document.modelManager.findNodes();
    const owners = mode === "part" ? partOwners(document) : nodes.filter(isResult);
    if (owners.length < 2) return NO_OWNERSHIP;
    const byId = new Map(nodes.map((node) => [node.id, node]));
    const variables = variableOwners(nodes);
    const ownersOf = new Map<string, number[]>();
    const mark = (node: INode, owner: number) => {
        const list = ownersOf.get(node.id) ?? [];
        if (list.includes(owner)) return false;
        list.push(owner);
        ownersOf.set(node.id, list);
        return true;
    };
    owners.forEach((owner, index) => {
        // A part owns everything it holds; a solid owns itself. Both own what they depend on.
        const stack: INode[] =
            mode === "part" && NodeUtils.isLinkedListNode(owner)
                ? [owner, ...NodeUtils.findNodes(owner)]
                : [owner];
        while (stack.length > 0) {
            const node = stack.pop()!;
            if (!mark(node, index)) continue;
            if (!isDependentNode(node)) continue;
            const { nodeIds, variables: names } = node.dependencies();
            for (const id of nodeIds) {
                const target = byId.get(id);
                if (target !== undefined) stack.push(target);
            }
            for (const name of names) {
                const target = variables.get(name);
                if (target !== undefined) stack.push(target);
            }
        }
    });
    // A folder carries the colours of what it holds.
    for (const node of nodes) {
        if (!NodeUtils.isLinkedListNode(node) || node instanceof ShapeNode) continue;
        const inside = new Set<number>();
        for (const child of NodeUtils.findNodes(node))
            for (const owner of ownersOf.get(child.id) ?? []) inside.add(owner);
        if (inside.size > 0)
            ownersOf.set(
                node.id,
                [...inside].sort((a, b) => a - b),
            );
    }
    return { ownersOf, owners };
}

/** The colours of a row's owners, palette order. */
export function ownerColors(ownership: Ownership, node: INode): string[] {
    return (ownership.ownersOf.get(node.id) ?? []).map(
        (index) => OWNER_PALETTE[index % OWNER_PALETTE.length],
    );
}

/** A row's bars: its owners' colours in their lanes (empty lanes undefined), or "many". */
export interface OwnerBars {
    readonly lanes: readonly (string | undefined)[];
    readonly many: boolean;
}

/** Per lane, whether a row's bar continues into the row above (`up`) and below (`down`). */
export interface OwnerJoins {
    readonly up: readonly boolean[];
    readonly down: readonly boolean[];
}

/**
 * Where the bars of consecutive rows (in visible order) join into one continuous strip: a
 * lane joins across a row boundary when both rows carry the same owner's colour in it at
 * the same depth. A row the owner has no part in breaks the strip, as does a change of
 * depth (a folder's row and its contents are drawn at different indents).
 */
export function joinOwnerBars(rows: readonly { bars: OwnerBars; depth: number }[]): OwnerJoins[] {
    const sameLane = (
        a: { bars: OwnerBars; depth: number },
        b: { bars: OwnerBars; depth: number },
        lane: number,
    ) =>
        a.depth === b.depth &&
        !a.bars.many &&
        !b.bars.many &&
        a.bars.lanes[lane] !== undefined &&
        a.bars.lanes[lane] === b.bars.lanes[lane];
    return rows.map((row, index) => {
        const previous = rows[index - 1];
        const next = rows[index + 1];
        const lanes = Array.from({ length: OWNER_LANES }, (_, lane) => lane);
        return {
            up: lanes.map((lane) => previous !== undefined && sameLane(previous, row, lane)),
            down: lanes.map((lane) => next !== undefined && sameLane(row, next, lane)),
        };
    });
}

export function ownerBars(ownership: Ownership, node: INode): OwnerBars {
    const owners = ownership.ownersOf.get(node.id) ?? [];
    if (owners.length === 0) return { lanes: [], many: false };
    if (owners.length > OWNER_LANES) return { lanes: [], many: true };
    const lanes: (string | undefined)[] = Array.from({ length: OWNER_LANES }, () => undefined);
    // An owner's lane is its index; past the third owner the lanes repeat, and a row whose
    // owners would meet in one lane packs them in owner order instead.
    const home = owners.map((index) => index % OWNER_LANES);
    const distinct = new Set(home).size === owners.length;
    owners.forEach((index, i) => {
        lanes[distinct ? home[i] : i] = OWNER_PALETTE[index % OWNER_PALETTE.length];
    });
    return { lanes, many: false };
}
