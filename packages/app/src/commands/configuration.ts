// Part of the Chili3d Project, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

import { command, type IApplication, type ICommand, PubSub } from "@chili3d/core";

/**
 * Opens the active document's Configuration panel: the active configuration on top (one
 * control per input), the inputs and their options below. Nothing is picked or appended — an
 * input edit is its own undo step, and switching configurations is not an edit at all.
 */
@command({ key: "configuration.edit", icon: "icon-layer-group" })
export class EditConfigurationCommand implements ICommand {
    async execute(application: IApplication): Promise<void> {
        const document = application.activeView?.document;
        if (document === undefined) return;
        PubSub.default.pub("editConfiguration", document);
    }
}
