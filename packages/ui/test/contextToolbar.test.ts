// Part of the Chili3d Project, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

import { CommandStore, PubSub, Ribbon, RibbonGroup, RibbonTab } from "@chili3d/core";
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
