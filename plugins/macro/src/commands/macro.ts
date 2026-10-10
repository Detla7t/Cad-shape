// Macro Command - Entry point that opens the macro manager

import { type CommandKeys, command, type I18nKeys, type IApplication, type ICommand } from "@chili3d/core";
import { MacroManager } from "../macro/macroManager";

@command({
    key: "macro.open" as CommandKeys,
    icon: {
        type: "path",
        value: "icons/macro.svg",
    },
    helpText: "macro.description" as I18nKeys,
})
export class MacroCommand implements ICommand {
    async execute(application: IApplication): Promise<void> {
        const manager = new MacroManager(application);
        await manager.initialize();
        await manager.show();
    }
}
