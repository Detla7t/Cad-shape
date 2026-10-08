// Part of the Chili3d Project, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

import {
    CommandStore,
    I18n,
    ObservableCollection,
    PubSub,
    Ribbon,
    RibbonGroup,
    RibbonTab,
} from "@chili3d/core";
import { createMockApplication } from "@chili3d/core/test-utils";
import { ContextToolbar } from "../src/ribbon/contextToolbar";
import { RibbonCustomization } from "../src/ribbon/customization";

function click(root: ParentNode, selector: string): HTMLButtonElement {
    const button = root.querySelector<HTMLButtonElement>(selector);
    expect(button).not.toBeNull();
    button!.click();
    return button!;
}

class Line {
    async execute() {}
}
class Circle {
    async execute() {}
}

test("tool search shows icons and filters nested variants by category and words together", () => {
    CommandStore.registerCommand(Line, { key: "create.line", icon: "icon-line" });
    CommandStore.registerCommand(Circle, { key: "create.circle", icon: "icon-circle" });
    const ribbon = new Ribbon(
        [],
        [
            new RibbonTab(
                "ribbon.tab.model",
                new RibbonGroup("ribbon.group.draw", [
                    { type: "split", items: ["create.line", "create.circle"] },
                ]),
            ),
        ],
    );
    const customization = new RibbonCustomization(ribbon);
    const commands: string[] = [];
    const onCommand = (key: string) => commands.push(key);
    PubSub.default.sub("executeCommand", onCommand);
    try {
        customization.searchTools();
        const dialog = document.querySelector<HTMLDialogElement>('dialog[aria-label="Search tools"]');
        expect(dialog).not.toBeNull();
        const category = dialog!.querySelector<HTMLSelectElement>('[aria-label="Tool category"]');
        expect(category).not.toBeNull();
        category!.value = I18n.translate("ribbon.group.draw");
        category!.dispatchEvent(new Event("change"));
        expect(dialog!.querySelectorAll("[data-command]")).toHaveLength(2);
        expect(dialog!.querySelector('[data-command="create.circle"] svg')).not.toBeNull();
        const query = dialog!.querySelector<HTMLInputElement>('input[aria-label="Search tools"]');
        expect(query).not.toBeNull();
        query!.value = `${I18n.translate("ribbon.group.draw")} ${I18n.translate("command.create.circle")}`;
        query!.dispatchEvent(new Event("input"));
        expect(dialog!.querySelectorAll("[data-command]")).toHaveLength(1);
        click(dialog!, '[data-command="create.circle"]');
        expect(commands).toEqual(["create.circle"]);
        expect(document.querySelector('dialog[aria-label="Search tools"]')).toBeNull();
    } finally {
        customization.dispose();
        PubSub.default.remove("executeCommand", onCommand);
        CommandStore.unregisterCommand("create.line");
        CommandStore.unregisterCommand("create.circle");
    }
});

test("a family remembers the last chosen tool and executes its real command", () => {
    CommandStore.registerCommand(Line, { key: "create.line", icon: "icon-line" });
    CommandStore.registerCommand(Circle, { key: "create.circle", icon: "icon-circle" });
    const ribbon = new Ribbon(
        [],
        [
            new RibbonTab(
                "ribbon.tab.model",
                new RibbonGroup("ribbon.group.draw", [
                    { type: "split", items: ["create.line", "create.circle"] },
                ]),
            ),
        ],
    );
    const toolbar = new ContextToolbar(createMockApplication(), ribbon, new RibbonCustomization(ribbon));
    const commands: string[] = [];
    const onCommand = (key: string) => commands.push(key);
    PubSub.default.sub("executeCommand", onCommand);
    document.body.append(toolbar);
    try {
        const menus = toolbar.querySelectorAll<HTMLButtonElement>("[aria-haspopup='menu']");
        expect(menus).toHaveLength(2);
        menus[1].click();
        click(document, "[role='menu'] [data-command='create.circle']");
        expect(commands).toEqual(["create.circle"]);
        expect(document.querySelector("[role='menu']")).toBeNull();
        expect(toolbar.querySelector("[data-command='create.line']")).toBeNull();
        click(toolbar, "[data-command='create.circle']");
        expect(commands).toEqual(["create.circle", "create.circle"]);
    } finally {
        toolbar.remove();
        PubSub.default.remove("executeCommand", onCommand);
        CommandStore.unregisterCommand("create.line");
        CommandStore.unregisterCommand("create.circle");
    }
});

test("the full toolset button opens ordered tabs and context switching restores the prior toolset", () => {
    const model = new RibbonTab("ribbon.tab.model", new RibbonGroup("ribbon.group.draw", ["create.line"]));
    const sketch = new RibbonTab("ribbon.tab.sketch");
    sketch.contextual = true;
    sketch.visible = false;
    const ribbon = new Ribbon([], [model, sketch]);
    const toolbar = new ContextToolbar(createMockApplication(), ribbon, new RibbonCustomization(ribbon));
    document.body.append(toolbar);
    try {
        const anchor = click(toolbar, "[aria-label='Choose toolset']");
        expect(document.querySelectorAll("[role='menuitemradio']")).toHaveLength(1);
        expect(anchor.getAttribute("aria-expanded")).toBe("true");
        const menu = document.querySelector<HTMLElement>("[role='menu']")!;
        menu.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
        expect(anchor.getAttribute("aria-expanded")).toBe("false");
        expect(document.activeElement).toBe(anchor);
        ribbon.openTab("ribbon.tab.sketch");
        expect(toolbar.dataset["tab"]).toBe("ribbon.tab.sketch");
        expect(toolbar.querySelector("[data-command='constraint.vertical']")).not.toBeNull();
        expect(toolbar.querySelectorAll("[data-command^='dimension.']")).toHaveLength(1);
        expect(toolbar.querySelector("[data-command='dimension.distance']")).not.toBeNull();
        expect(toolbar.querySelector("[aria-label='Dimensions']")).toBeNull();
        ribbon.closeTab("ribbon.tab.sketch");
        expect(toolbar.dataset["tab"]).toBe("ribbon.tab.model");
        expect(toolbar.querySelector("[data-command='create.line']")).not.toBeNull();
    } finally {
        toolbar.remove();
    }
});

test("new group commands appear after customization without reentering collection notifications", async () => {
    const group = new RibbonGroup("ribbon.group.draw", ["create.line"]);
    const tab = new RibbonTab("ribbon.tab.model", group);
    const ribbon = new Ribbon([], [tab]);
    const toolbar = new ContextToolbar(createMockApplication(), ribbon, new RibbonCustomization(ribbon));
    document.body.append(toolbar);
    try {
        group.items.push("create.circle");
        await Promise.resolve();
        expect(toolbar.querySelector("[data-command='create.circle']")).not.toBeNull();
        const custom = new RibbonGroup("ribbon.group.custom", ["create.arc"]);
        tab.groups.push(custom);
        await Promise.resolve();
        expect(toolbar.querySelector("[data-command='create.arc']")).not.toBeNull();
        custom.items.push("create.rect");
        await Promise.resolve();
        expect(toolbar.querySelector("[data-command='create.rect']")).not.toBeNull();
    } finally {
        toolbar.remove();
    }
});

test("editing context filters pins, copied families and toolsets, then restores modeling tools", () => {
    const model = new RibbonTab("ribbon.tab.model", new RibbonGroup("ribbon.group.draw", ["create.box"]));
    const sketch = RibbonTab.fromProfile({ tabName: "ribbon.tab.sketch", contextual: true, groups: [] });
    sketch.groups.push(
        new RibbonGroup("ribbon.group.custom", [
            new ObservableCollection("feature.extrude", "feature.revolve"),
            { type: "split", items: ["plane.create", "sketch.create"] },
        ]),
    );
    const ribbon = new Ribbon(["feature.extrude", "sketch.line", "doc.save"], [model, sketch]);
    const toolbar = new ContextToolbar(createMockApplication(), ribbon, new RibbonCustomization(ribbon));
    document.body.append(toolbar);
    try {
        expect(toolbar.querySelector("[data-command='sketch.line']")).toBeNull();
        ribbon.openTab("ribbon.tab.sketch");
        ribbon.openTab("ribbon.tab.sketch");
        ribbon.activeTab = model;
        expect(toolbar.dataset["tab"]).toBe("ribbon.tab.sketch");
        expect(toolbar.querySelector("[data-command='sketch.line']")).not.toBeNull();
        expect(toolbar.querySelector("[data-command='doc.save']")).not.toBeNull();
        expect(toolbar.querySelector("[data-command='feature.extrude']")).toBeNull();
        expect(toolbar.querySelector("[data-command='plane.create']")).toBeNull();
        click(toolbar, "[aria-label='Choose toolset']");
        expect(
            Array.from(document.querySelectorAll<HTMLElement>("[role='menuitemradio']")).map(
                (e) => e.dataset["ribbonTab"],
            ),
        ).toEqual(["ribbon.tab.sketch"]);
        ribbon.closeTab("ribbon.tab.sketch");
        expect(document.querySelector("[role='menu']")).toBeNull();
        expect(toolbar.dataset["tab"]).toBe("ribbon.tab.model");
        expect(toolbar.querySelector("[data-command='feature.extrude']")).not.toBeNull();
        expect(toolbar.querySelector("[data-command='sketch.line']")).toBeNull();
    } finally {
        toolbar.remove();
    }
});
