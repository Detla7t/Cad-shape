// Part of the Chili3d Project, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

import type { I18nKeys } from "../i18n";
import { serializable } from "../serialize";
import { FolderNode } from "./folderNode";
import type { INode } from "./node";

/**
 * A component (Fusion's components): a folder a user added on purpose to work in. Only a
 * component takes the activate ring and becomes `ComponentContext`'s active component —
 * a plain folder merely groups. New parts made while it is active go into it. (`ComponentNode`
 * in `component.ts` is unrelated: a merged mesh instance.)
 */
@serializable({ id: "ComponentFolderNode" })
export class ComponentFolderNode extends FolderNode {
    override get icon(): string {
        return "icon-component";
    }

    display(): I18nKeys {
        return "body.component";
    }
}

export function isComponentFolder(node: INode | undefined): node is ComponentFolderNode {
    return node instanceof ComponentFolderNode;
}
