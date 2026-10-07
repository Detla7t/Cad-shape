// Part of the Chili3d Project, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

import {
    command,
    type IApplication,
    type ICommand,
    type IDocument,
    nextElementName,
    openElement,
    PubSub,
    Transaction,
} from "@chili3d/core";
import { CamStudioNode, isCamStudioNode } from "../camStudioNode";
import { generatorOf } from "../context/generator";
// Registers the CAM Studio element kind and its view.
import "./camStudioElement";

/** The document's CAM Studios, in model-tree order. */
export function documentCamStudios(document: IDocument): CamStudioNode[] {
    return document.modelManager.findNodes(isCamStudioNode) as CamStudioNode[];
}

/** Adds a CAM Studio to the active document (one undo step) and switches to its tab. */
@command({ key: "cam.newStudio", icon: "icon-cog" })
export class NewCamStudioCommand implements ICommand {
    async execute(application: IApplication): Promise<void> {
        const document = application.activeView?.document;
        if (document === undefined) return;
        const studio = new CamStudioNode({ document, name: nextElementName(document, "CAM Studio") });
        Transaction.execute(document, "new CAM studio", () => {
            document.modelManager.addNode(studio);
        });
        openElement(document, studio);
    }
}

/** Switches to the selected CAM Studio — or the document's first, creating one when there is none. */
@command({ key: "cam.openStudio", icon: "icon-layer-group" })
export class OpenCamStudioCommand implements ICommand {
    async execute(application: IApplication): Promise<void> {
        const document = application.activeView?.document;
        if (document === undefined) return;
        const selected = document.selection.getSelectedNodes().find(isCamStudioNode);
        const studio = selected ?? documentCamStudios(document)[0];
        if (studio === undefined) {
            PubSub.default.pub("executeCommand", "cam.newStudio");
            return;
        }
        openElement(document, studio);
    }
}

/** Regenerates every setup of every CAM Studio in the document. */
@command({ key: "cam.generateAll", icon: "icon-sync-alt" })
export class GenerateAllCamCommand implements ICommand {
    async execute(application: IApplication): Promise<void> {
        const document = application.activeView?.document;
        if (document === undefined) return;
        let errors = 0;
        let generated = 0;
        for (const studio of documentCamStudios(document)) {
            const generator = generatorOf(studio);
            await generator.generateAll();
            for (const setup of studio.setups) {
                for (const operation of setup.operations) {
                    const state = generator.status(operation.id).state;
                    if (state === "ok") generated++;
                    if (state === "error") errors++;
                }
            }
        }
        PubSub.default.pub("showToast", "cam.generated{0}{1}", generated, errors);
    }
}
