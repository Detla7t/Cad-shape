// Part of the Chili3d Project, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

import { CommandStore } from "@chili3d/core";
import { EndCapCommand } from "@chili3d/fabrication/app";
import {
    DefaultRibbon,
    FabricationRibbonProfiles,
    mergeRibbonProfiles,
    ParametricRibbonProfiles,
    SheetMetalRibbonProfiles,
} from "../src/ribbon";

describe("FabricationRibbonProfiles", () => {
    test("End Cap leads the sheet metal tab's round duct group", () => {
        const tabs = mergeRibbonProfiles(DefaultRibbon, [
            ...ParametricRibbonProfiles,
            ...SheetMetalRibbonProfiles,
            ...FabricationRibbonProfiles,
        ]);
        const sheetMetal = tabs.filter((tab) => tab.tabName === "ribbon.tab.sheetMetal");
        expect(sheetMetal).toHaveLength(1);
        const roundDuct = sheetMetal[0].groups.find((group) => group.groupName === "ribbon.group.roundDuct");
        expect(roundDuct?.items).toEqual([
            "sheetMetal.endCap",
            "sheetMetal.roll",
            "sheetMetal.crimp",
            "sheetMetal.bead",
        ]);
    });

    test("the command behind the button is registered by the fabrication module", () => {
        expect(CommandStore.getCommand("sheetMetal.endCap")).toBe(EndCapCommand);
    });
});
