// Part of the Chili3d Project, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

import { applyRibbonPreferences, Ribbon, RibbonGroup, type RibbonPreferences, RibbonTab } from "../src";

function ribbon() {
    return new Ribbon(
        ["edit.undo"],
        [
            new RibbonTab("ribbon.tab.model", new RibbonGroup("ribbon.group.modify", ["modify.move"])),
            new RibbonTab("ribbon.tab.manager"),
            RibbonTab.fromProfile({ tabName: "ribbon.tab.sketch", contextual: true, groups: [] }),
        ],
    );
}

test("restores pins, named custom tabs, tool additions and tab order from JSON", () => {
    const preferences: RibbonPreferences = {
        pins: ["edit.undo", "modify.move", "modify.move"],
        tabOrder: ["custom.drawing", "ribbon.tab.manager", "ribbon.tab.model"],
        tabs: {
            "custom.drawing": { custom: true, label: "Drawing", commands: ["sketch.line", "sketch.circle"] },
            "ribbon.tab.model": { label: "Design", commands: ["sketch.create"] },
            "ribbon.tab.manager": { hidden: true },
        },
    };
    const model = ribbon();
    applyRibbonPreferences(model, JSON.parse(JSON.stringify(preferences)));
    expect(model.quickCommands.items()).toEqual(["edit.undo", "modify.move"]);
    expect(model.tabs.items().map((tab) => tab.tabName)).toEqual([
        "custom.drawing",
        "ribbon.tab.manager",
        "ribbon.tab.model",
        "ribbon.tab.sketch",
    ]);
    expect(model.tabs.item(0).label).toBe("Drawing");
    expect(model.tabs.item(0).groups.item(0).items.items()).toEqual(["sketch.line", "sketch.circle"]);
    expect(model.tabs.item(2).groups.item(0).items.items()).toEqual(["modify.move"]);
    expect(model.tabs.item(2).groups.item(1).items.items()).toEqual(["sketch.create"]);
    expect(model.tabs.item(1).visible).toBe(false);
    expect(model.tabs.item(3).visible).toBe(false);
    model.openTab("ribbon.tab.sketch");
    expect(model.activeTab).toBe(model.tabs.item(3));
});

test("invalid saved visibility cannot hide every workspace tab", () => {
    const model = ribbon();
    applyRibbonPreferences(model, {
        tabs: { "ribbon.tab.model": { hidden: true }, "ribbon.tab.manager": { hidden: true } },
    });
    expect(model.activeTab.visible).toBe(true);
    expect(model.tabs.item(2).visible).toBe(false);
});

test("applying stored preferences twice does not duplicate user tool groups", () => {
    const model = ribbon();
    const preferences: RibbonPreferences = { tabs: { "ribbon.tab.model": { commands: ["sketch.create"] } } };
    applyRibbonPreferences(model, preferences);
    applyRibbonPreferences(model, preferences);
    expect(
        model.tabs
            .item(0)
            .groups.items()
            .map((group) => group.groupName),
    ).toEqual(["ribbon.group.modify", "ribbon.group.custom"]);
});
