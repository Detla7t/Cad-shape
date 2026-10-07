// Part of the Chili3d Project, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

import {
    command,
    type IApplication,
    type ICommand,
    nextElementName,
    openElement,
    Transaction,
    VariableStudioNode,
} from "@chili3d/core";

/**
 * Adds a Variable Studio to the active document (one undo step) and switches to its tab.
 * The studio starts empty; its variables join the document scope as they are written.
 */
@command({ key: "variable.newStudio", icon: "icon-tag" })
export class NewVariableStudioCommand implements ICommand {
    async execute(application: IApplication): Promise<void> {
        const document = application.activeView?.document;
        if (document === undefined) return;
        const studio = new VariableStudioNode({
            document,
            name: nextElementName(document, "Variable Studio"),
        });
        Transaction.execute(document, "new variable studio", () => {
            document.modelManager.addNode(studio);
        });
        openElement(document, studio);
    }
}
