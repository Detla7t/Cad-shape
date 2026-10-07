// Part of the Chili3d Project, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

import {
    command,
    type IApplication,
    type ICommand,
    nextElementName,
    openElement,
    PubSub,
    Transaction,
} from "@chili3d/core";
import { FeatureStudioNode } from "../featurescript/featureStudioNode";
import { documentStudios } from "../featurescript/studioCompiler";
import { showInsertFeatureDialog } from "../featurescript/ui/featureStudioEditor";
// Registers the Feature Studio element kind and its view: double-clicking a studio in the
// model tree opens its tab through the element registry, not through a handler here.
import "../featurescript/ui/featureStudioElement";

/** Creates a Feature Studio (seeded with an example feature) and switches to its tab. */
@command({ key: "featurescript.newStudio", icon: "icon-file-plus" })
export class NewFeatureStudioCommand implements ICommand {
    async execute(application: IApplication): Promise<void> {
        const document = application.activeView?.document;
        if (document === undefined) return;
        const studio = new FeatureStudioNode({ document, name: nextElementName(document, "Feature Studio") });
        Transaction.execute(document, "new feature studio", () => {
            document.modelManager.addNode(studio);
        });
        openElement(document, studio);
    }
}

/** Switches to the selected Feature Studio's tab — or the document's first studio's. */
@command({ key: "featurescript.editStudio", icon: "icon-macro" })
export class EditFeatureStudioCommand implements ICommand {
    async execute(application: IApplication): Promise<void> {
        const document = application.activeView?.document;
        if (document === undefined) return;
        const selected = document.selection
            .getSelectedNodes()
            .find((node) => node instanceof FeatureStudioNode);
        const studios = documentStudios(document);
        const studio = selected ?? (studios.length > 0 ? studios[0] : undefined);
        if (studio === undefined) {
            PubSub.default.pub("executeCommand", "featurescript.newStudio");
            return;
        }
        openElement(document, studio);
    }
}

/** Inserts a custom feature from any of the document's studios into a body. */
@command({ key: "featurescript.insert", icon: "icon-visual-programming" })
export class InsertCustomFeatureCommand implements ICommand {
    async execute(application: IApplication): Promise<void> {
        const document = application.activeView?.document;
        if (document === undefined) return;
        showInsertFeatureDialog(document);
    }
}
