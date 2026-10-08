// Part of the Chili3d Project, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

import type { INode } from "../model";
import type { IView, VisualShapeData } from "../visual";
export interface NodeMenuContext {
    view: IView;
    picks: VisualShapeData[];
}
export interface NodeMenuAction {
    id: string;
    label: string;
    order?: number;
    run?: () => void | Promise<void>;
    children?: NodeMenuAction[];
    disabled?: boolean;
    icon?: string;
    separatorBefore?: boolean;
}
const providers = new Set<(node: INode, context?: NodeMenuContext) => NodeMenuAction[]>();
export const NodeActions = {
    register(provider: (node: INode, context?: NodeMenuContext) => NodeMenuAction[]) {
        providers.add(provider);
    },
    forNode(node: INode, context?: NodeMenuContext): NodeMenuAction[] {
        return [...providers]
            .flatMap((provider) => provider(node, context))
            .sort((a, b) => (a.order ?? 0) - (b.order ?? 0));
    },
};
