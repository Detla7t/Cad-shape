// Part of the Chili3d Project, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

import { command, type IApplication, type ICommand, PubSub } from "@chili3d/core";

/** Shows or hides the Versions & History panel of the active document. */
@command({
    key: "doc.history",
    icon: "icon-history",
    isApplicationCommand: true,
})
export class VersionHistoryCommand implements ICommand {
    async execute(_application: IApplication): Promise<void> {
        PubSub.default.pub("toggleVersionsPanel");
    }
}
