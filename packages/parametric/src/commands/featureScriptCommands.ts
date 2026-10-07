// Part of the Chili3d Project, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

import { command, type IApplication, type ICommand, PubSub, Transaction } from "@chili3d/core";
import { FeatureStudioNode } from "../featurescript/featureStudioNode";
import { documentStudios } from "../featurescript/studioCompiler";
import { showFeatureStudioEditor, showInsertFeatureDialog } from "../featurescript/ui/featureStudioEditor";
import { showTablesPanel } from "../featurescript/ui/tablesPanel";

/** A studio name not used yet in the document: "Feature Studio 1", "Feature Studio 2", ... */
function nextStudioName(studios: readonly FeatureStudioNode[]): string {
    const taken = new Set(studios.map((studio) => studio.name));
    for (let n = 1; ; n++) {
        const name = `Feature Studio ${n}`;
        if (!taken.has(name)) return name;
    }
}

/** Creates a Feature Studio (seeded with an example feature) and opens it in the editor. */
@command({ key: "featurescript.newStudio", icon: "icon-file-plus" })
export class NewFeatureStudioCommand implements ICommand {
    async execute(application: IApplication): Promise<void> {
        const document = application.activeView?.document;
        if (document === undefined) return;
        const studio = new FeatureStudioNode({ document, name: nextStudioName(documentStudios(document)) });
        Transaction.execute(document, "new feature studio", () => {
            document.modelManager.addNode(studio);
        });
        showFeatureStudioEditor(studio);
    }
}

/** Opens the selected Feature Studio — or the document's only one — in the editor. */
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
        showFeatureStudioEditor(studio as FeatureStudioNode);
    }
}

/** Opens the custom tables panel: the tables the document's studios export, computed over its parts. */
@command({ key: "featurescript.tables", icon: "icon-all" })
export class ShowCustomTablesCommand implements ICommand {
    async execute(application: IApplication): Promise<void> {
        const document = application.activeView?.document;
        if (document === undefined) return;
        showTablesPanel(document);
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

// Double-clicking a Feature Studio in the model tree opens its editor.
PubSub.default.sub("nodeDoubleClicked", (node) => {
    if (node instanceof FeatureStudioNode) showFeatureStudioEditor(node);
});
