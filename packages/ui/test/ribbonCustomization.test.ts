// Part of the Chili3d Project, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

import { CommandStore, Config, Ribbon, RibbonGroup, RibbonTab } from "@chili3d/core";
import { createMockApplication } from "@chili3d/core/test-utils";
import { rs } from "@rstest/core";
import { DropdownController } from "../src/ribbon/dropdownController";
import { RibbonUI } from "../src/ribbon/ribbon";
import { RibbonGroupElement } from "../src/ribbon/ribbonGroup";

class LineCommand {
    async execute() {}
}

function button(text: string, root: ParentNode = document): HTMLButtonElement {
    const found = [...root.querySelectorAll<HTMLButtonElement>("button")].find(
        (button) => button.textContent === text,
    );
    expect(found).not.toBeUndefined();
    return found!;
}

test("tool context menu survives the app context-menu handler and persists a pin and shortcut", () => {
    const saved = Config.instance.ribbonPreferences;
    const shortcuts = Config.instance.customShortcuts;
    const save = rs.spyOn(Config.instance, "saveToStorage").mockImplementation(() => {});
    CommandStore.registerCommand(LineCommand, { key: "create.line", icon: "icon-line" });
    const data = new Ribbon(
        [],
        [new RibbonTab("ribbon.tab.model", new RibbonGroup("ribbon.group.draw", ["create.line"]))],
    );
    const parent = document.createElement("div");
    parent.oncontextmenu = (event) => event.stopPropagation();
    const ui = new RibbonUI(createMockApplication(), data);
    parent.append(ui);
    document.body.append(parent);
    try {
        const tool = ui.querySelector<HTMLElement>("ribbon-button");
        expect(tool).not.toBeNull();
        tool!.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, clientX: 50, clientY: 50 }));
        expect(document.querySelector("[role=menu]")).not.toBeNull();
        button("Pin tool").click();
        expect(data.quickCommands.items()).toEqual(["create.line"]);
        expect(Config.instance.ribbonPreferences.pins).toEqual(["create.line"]);
        tool!.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true }));
        button("Assign keyboard shortcut…").click();
        const field = document.querySelector<HTMLInputElement>("input[aria-label='Keyboard shortcut']");
        expect(field).not.toBeNull();
        field!.dispatchEvent(
            new KeyboardEvent("keydown", { key: "k", ctrlKey: true, altKey: true, bubbles: true }),
        );
        button("Save shortcut").click();
        expect(Config.instance.customShortcuts["create.line"]).toBe("ctrl+alt+k");
        expect(save).toHaveBeenCalledTimes(2);
    } finally {
        parent.remove();
        Config.instance.ribbonPreferences = saved;
        Config.instance.customShortcuts = shortcuts;
        save.mockRestore();
        CommandStore.unregisterCommand("create.line");
    }
});

test("the full group header and keyboard open the same dropdown", () => {
    CommandStore.registerCommand(LineCommand, { key: "create.line", icon: "icon-line" });
    const group = new RibbonGroupElement(new RibbonGroup("ribbon.group.modify", [], ["create.line"]));
    document.body.append(group);
    try {
        const header = group.querySelector<HTMLElement>("[role=button]");
        expect(header).not.toBeNull();
        header!.click();
        expect(document.querySelector("[data-command='create.line']")).not.toBeNull();
        DropdownController.closeAll();
        header!.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
        expect(document.querySelector("[data-command='create.line']")).not.toBeNull();
    } finally {
        group.dispose();
        group.remove();
        CommandStore.unregisterCommand("create.line");
    }
});
