// Part of the Chili3d Project, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

import { createMockDocument } from "@chili3d/core/test-utils";
import {
    CamStudioNode,
    machineProfiles,
    registerMachineProfile,
    simultaneousAxes,
    type ToolpathData,
    toolpathLength,
} from "../src";

test("a CAM Studio keeps its setups as data", () => {
    const studio = new CamStudioNode({ document: createMockDocument() });
    expect(studio.setups).toEqual([]);
    const setup = {
        id: "s1",
        name: "Op 1",
        machineId: "generic-3-axis",
        wcs: { origin: [0, 0, 0], xAxis: [1, 0, 0], zAxis: [0, 0, 1] },
        stock: { kind: "box", margin: { x: 2, y: 2, zTop: 1, zBottom: 0 } },
        partIds: ["p1"],
        operations: [],
    } as const;
    studio.setSetups([setup]);
    expect(studio.setups).toEqual([setup]);
    expect(new CamStudioNode({ document: createMockDocument(), setupsJson: "not json" }).setups).toEqual([]);
});

test("machine profiles count their simultaneous axes and list by kind", () => {
    registerMachineProfile({
        id: "test-trunnion",
        name: "Test trunnion",
        kind: "mill",
        linearAxes: [
            { name: "X", min: 0, max: 500 },
            { name: "Y", min: 0, max: 400 },
            { name: "Z", min: -400, max: 0 },
        ],
        rotaryAxes: [
            { name: "A", direction: [1, 0, 0], min: -120, max: 30, carrier: "table" },
            { name: "C", direction: [0, 0, 1], carrier: "table" },
        ],
        maxFeed: 10000,
        rapidFeed: 25000,
        post: { id: "fanuc" },
    });
    const profile = machineProfiles("mill").find((p) => p.id === "test-trunnion");
    expect(profile).not.toBeUndefined();
    expect(simultaneousAxes(profile!)).toBe(5);
    expect(machineProfiles("plasma").some((p) => p.id === "test-trunnion")).toBe(false);
});

test("toolpath length splits cutting from rapid moves", () => {
    const path: ToolpathData = {
        toolId: "t1",
        moves: [
            { kind: "rapid", to: [0, 0, 5] },
            { kind: "rapid", to: [0, 0, 1] },
            { kind: "linear", to: [10, 0, 1], feed: 500 },
            { kind: "linear", to: [10, 10, 1], feed: 500 },
            { kind: "comment", text: "done" },
        ],
    };
    expect(toolpathLength(path)).toEqual({ cutting: 20, rapid: 4 });
});
