// Part of the Chili3d Project, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

import type { INode } from "./node";

/** What a node reads to rebuild: other nodes, and variables by name. */
export interface NodeDependencies {
    readonly nodeIds: readonly string[];
    readonly variables: readonly string[];
    /**
     * For a dependency on a node with a feature list (a body): how many of its features the
     * dependent was built against (a sketch's `refPositions`). Without one the dependent reads
     * the whole list. The Part Studio timeline places the dependent right after that feature.
     */
    readonly anchors?: Readonly<Record<string, number>>;
}

/**
 * A node that can say what it depends on — a sketch (its plane, its external references,
 * the variables its dimensions read), a body (the sketches and tools its features use, the
 * variables their parameters read), a variable feature (its sources, the variables its
 * expression reads). The model tree colours features by the results that use them from this.
 */
export interface IDependentNode extends INode {
    dependencies(): NodeDependencies;
}

export function isDependentNode(node: INode | undefined): node is IDependentNode {
    return typeof (node as Partial<IDependentNode> | undefined)?.dependencies === "function";
}
