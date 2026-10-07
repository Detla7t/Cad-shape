// Part of the Chili3d Project, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

import {
    command,
    download,
    I18n,
    type IApplication,
    type ICommand,
    PROJECT_FILE_EXTENSION,
    PubSub,
} from "@chili3d/core";
import { writeProjectFile } from "../../project/projectFile";

/** Downloads the active document as a `.chili3d` project (zip + manifest). */
@command({
    key: "doc.saveToFile",
    icon: "icon-download",
})
export class SaveDocumentToFile implements ICommand {
    async execute(app: IApplication): Promise<void> {
        const document = app.activeView?.document;
        if (!document) return;
        PubSub.default.pub(
            "showPermanent",
            async () => {
                await new Promise((r) => {
                    setTimeout(r, 100);
                });
                const bytes = await writeProjectFile(document);
                if (!bytes.isOk) {
                    PubSub.default.pub("showToast", "error.default:{0}", bytes.error);
                    return;
                }
                PubSub.default.pub("showToast", "toast.downloading");
                download([bytes.value as BlobPart], `${document.name}${PROJECT_FILE_EXTENSION}`);
            },
            "toast.excuting{0}",
            I18n.translate("command.doc.saveToFile"),
        );
    }
}
