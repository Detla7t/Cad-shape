// Part of the Chili3d Project, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

import {
    command,
    type IApplication,
    type ICommand,
    type IDocument,
    PubSub,
    Transaction,
} from "@chili3d/core";
import { importSourceProject } from "../link/importSource";
import { LINK_SLOT, LinkedPartNode } from "../link/linkedPartNode";
import { linkService } from "../link/linkRegistry";
import type { PartLinkService } from "../link/partLinkService";
import { showLinksPanel, showSourcePickerDialog, showVersionPicker, toast } from "../ui/linkUi";

function service(): PartLinkService | undefined {
    return linkService() as PartLinkService | undefined;
}

function selectedLinkedParts(document: IDocument): LinkedPartNode[] {
    return document.selection
        .getSelectedNodes()
        .filter((node): node is LinkedPartNode => node instanceof LinkedPartNode);
}

/** Inserts a part (or assembly) of another document, at a version, into the Part Studio. */
@command({ key: "link.insertPart", icon: "icon-share" })
export class InsertLinkedPartCommand implements ICommand {
    async execute(application: IApplication): Promise<void> {
        const document = application.activeView?.document;
        const links = service();
        if (document === undefined || links === undefined) return;
        showSourcePickerDialog(links, document, "link.insert.title", async (selection) => {
            const resolved = await links.resolveNew(
                selection.documentId,
                selection.node.id,
                selection.version,
            );
            if (!resolved.isOk) {
                PubSub.default.pub("showToast", "error.default:{0}", resolved.error);
                return;
            }
            const node = new LinkedPartNode({ document, link: resolved.value.link });
            Transaction.execute(document, "insert linked part", () => {
                document.modelManager.addNode(node);
            });
            document.visual.update();
            toast("link.inserted{0}", node.name);
        });
    }
}

/** Updates the selected linked parts (or every one in the document) to their newest version. */
@command({ key: "link.update", icon: "icon-sync-alt" })
export class UpdateLinksCommand implements ICommand {
    async execute(application: IApplication): Promise<void> {
        const document = application.activeView?.document;
        const links = service();
        if (document === undefined || links === undefined) return;
        const selected = selectedLinkedParts(document);
        const consumers =
            selected.length > 0 ? selected : links.consumersOf(document).filter((x) => x.attached);
        let updated = 0;
        for (const consumer of consumers) {
            await links.refresh(consumer);
            for (const slot of consumer.linkSlots()) {
                if (await links.updateToLatest(consumer, slot.slotId)) updated++;
            }
        }
        toast(updated > 0 ? "link.updatedCount{0}" : "link.upToDate", updated);
    }
}

@command({ key: "link.changeVersion", icon: "icon-history" })
export class ChangeLinkVersionCommand implements ICommand {
    async execute(application: IApplication): Promise<void> {
        const document = application.activeView?.document;
        const links = service();
        if (document === undefined || links === undefined) return;
        const node = selectedLinkedParts(document)[0];
        if (node === undefined) {
            showLinksPanel(links, document);
            return;
        }
        await showVersionPicker(links, node, LINK_SLOT);
    }
}

@command({ key: "link.manage", icon: "icon-share" })
export class ManageLinksCommand implements ICommand {
    async execute(application: IApplication): Promise<void> {
        const document = application.activeView?.document;
        const links = service();
        if (document === undefined || links === undefined) return;
        showLinksPanel(links, document);
    }
}

/** Stores a `.chili3d` file from disk as a link source (document + history) without opening it. */
@command({ key: "link.importSource", icon: "icon-folder-open" })
export class ImportLinkSourceCommand implements ICommand {
    async execute(application: IApplication): Promise<void> {
        const links = service();
        if (links === undefined) return;
        const picker = window.document.createElement("input");
        picker.type = "file";
        picker.accept = ".chili3d";
        picker.onchange = async () => {
            const file = picker.files?.[0];
            if (file === undefined) return;
            const imported = await importSourceProject(
                application,
                links.storage,
                new Uint8Array(await file.arrayBuffer()),
            );
            if (!imported.isOk) {
                PubSub.default.pub("showToast", "error.default:{0}", imported.error);
                return;
            }
            links.invalidateSource(imported.value.id);
            toast("link.imported{0}", imported.value.name);
        };
        picker.click();
    }
}
