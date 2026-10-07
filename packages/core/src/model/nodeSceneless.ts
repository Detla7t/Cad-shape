// Part of the Chili3d Project, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

/**
 * Implemented by nodes that live in the model tree but have nothing in the scene — a
 * Feature Studio holds code, not geometry. The tree drops their visibility toggle, which
 * would flip a flag with no visible effect. Opt-in, like `INodeIcon`: a node without it
 * keeps its row exactly as before.
 */
export interface INodeSceneless {
    readonly sceneless: true;
}

export function isNodeSceneless(node: unknown): node is INodeSceneless {
    return (node as INodeSceneless | undefined)?.sceneless === true;
}
