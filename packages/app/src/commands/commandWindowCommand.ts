// Part of the Chili3d Project, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

import { command, type IApplication, type ICommand, PubSub } from "@chili3d/core";

/** Shows or hides the command window under the viewport (AutoCAD's command line). */
@command({
    key: "view.commandWindow",
    icon: "icon-code",
})
export class ToggleCommandWindowCommand implements ICommand {
    async execute(_application: IApplication): Promise<void> {
        PubSub.default.pub("toggleCommandWindow");
    }
}
