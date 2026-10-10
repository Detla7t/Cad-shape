// Part of the Chili3d Project, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

import {
    ComponentContext,
    ComponentFolderNode,
    command,
    I18n,
    type IApplication,
    type ICommand,
    NodeUtils,
    Transaction,
} from "@chili3d/core";

/**
 * Fusion's New Component: adds a component to the Part Studio — inside the active component,
 * if any — and activates it, so the parts made next belong to it.
 */
@command({
    key: "create.component",
    icon: "icon-component",
})
export class NewComponent implements ICommand {
    async execute(app: IApplication): Promise<void> {
        const document = app.activeView?.document;
        if (document === undefined) return;
        const name = NodeUtils.generateName(document, I18n.translate("body.component"));
        const component = new ComponentFolderNode({ document, name });
        Transaction.execute(document, "create.component", () => {
            document.modelManager.addNode(component);
        });
        ComponentContext.activate(document, component);
    }
}
