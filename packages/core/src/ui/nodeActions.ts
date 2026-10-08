// Part of the Chili3d Project, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

import type { INode } from "../model";
export interface NodeMenuAction {
    id: string;
    label: string;
    order?: number;
    run?: () => void | Promise<void>;
    children?: NodeMenuAction[];
    disabled?: boolean;
}
const providers = new Set<(node: INode) => NodeMenuAction[]>();
export const NodeActions = {
    register(provider: (node: INode) => NodeMenuAction[]) {
        providers.add(provider);
    },
    forNode(node: INode): NodeMenuAction[] {
        return [...providers]
            .flatMap((provider) => provider(node))
            .sort((a, b) => (a.order ?? 0) - (b.order ?? 0));
    },
};
