// Part of the Chili3d Project, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

import {
    command,
    DOCUMENT_FILE_EXTENSION,
    I18n,
    type IApplication,
    type ICommand,
    PROJECT_FILE_EXTENSION,
    PubSub,
    readFilesAsync,
} from "@chili3d/core";
import { openDocumentFile } from "../../project/projectFile";

/** Opens a `.chili3d` project, or a legacy `.cd` document file. */
@command({
    key: "doc.open",
    icon: "icon-open",
    isApplicationCommand: true,
})
export class OpenDocument implements ICommand {
    async execute(app: IApplication): Promise<void> {
        PubSub.default.pub(
            "showPermanent",
            async () => {
                const files = await readFilesAsync(
                    `${PROJECT_FILE_EXTENSION},${DOCUMENT_FILE_EXTENSION}`,
                    false,
                );
                if (!files.isOk || files.value.length === 0) return;
                const document = await openDocumentFile(app, files.value[0]);
                if (!document.isOk) {
                    PubSub.default.pub("showToast", "error.default:{0}", document.error);
                    return;
                }
                document.value.application.activeView?.cameraController.fitContent();
            },
            "toast.excuting{0}",
            I18n.translate("command.doc.open"),
        );
    }
}
