// Part of the Chili3d Project, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

import { I18n, type I18nKeys } from "../i18n";
import type { ICommand } from "./command";
import type { CommandData } from "./commandData";
import { type CommandConstructor, CommandStore } from "./commandStore";

export function command<T extends CommandConstructor>(metadata: CommandData) {
    return (ctor: T) => {
        CommandStore.registerCommand(ctor, metadata);
    };
}

/**
 * The name a command's transaction is recorded under: its translated label ("Extrude"), which
 * is what the history and the version history's microversions show.
 */
export function commandTransactionName(command: ICommand): string {
    const key = CommandStore.getComandData(command)?.key;
    if (key === undefined) return "Edit";
    return I18n.translate(`command.${key}` as I18nKeys) ?? key;
}
