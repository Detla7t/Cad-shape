// Part of the Chili3d Project, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

import { createMockDocument } from "@chili3d/core/test-utils";
import {
    BUILT_IN_MACHINES,
    CamStudioNode,
    checkMachineProfile,
    checkTool,
    exportMachineProfiles,
    importMachineProfiles,
    machineProfile,
    postProcessor,
    resolveMachine,
    simultaneousAxes,
    USER_MACHINES_KEY,
    UserMachineLibrary,
    userMachines,
} from "../src";

afterEach(() => {
    globalThis.localStorage?.removeItem(USER_MACHINES_KEY);
    globalThis.localStorage?.removeItem("test.machines");
});

describe("the built-in machine library", () => {
    // The 5-axis profiles are written by the 5-axis module's posts, registered with it.
    const FIVE_AXIS_POSTS: Record<string, string> = {
        "haas-umc500": "haas-umc-5axis",
        "generic-5-axis-trunnion": "fanuc-30i-5axis",
    };

    test("registers ten valid profiles, each with tools and a post for its kind", () => {
        expect(BUILT_IN_MACHINES).toHaveLength(10);
        for (const profile of BUILT_IN_MACHINES) {
            expect(checkMachineProfile(profile).isOk).toBe(true);
            expect(machineProfile(profile.id)).toBe(profile);
            expect(profile.tools?.length).toBeGreaterThan(0);
            for (const tool of profile.tools ?? []) expect(checkTool(tool).isOk).toBe(true);
            const fiveAxis = FIVE_AXIS_POSTS[profile.id];
            if (fiveAxis !== undefined) {
                expect(profile.post.id).toBe(fiveAxis);
                continue;
            }
            expect(postProcessor(profile.post.id)?.machineKinds).toContain(profile.kind);
        }
    });

    test("carries the kinematics the 5-axis posts need and the cutting/wire data", () => {
        const umc = machineProfile("haas-umc500")!;
        expect(simultaneousAxes(umc)).toBe(5);
        expect(umc.kinematics).toMatchObject({ type: "table-table", chain: ["B", "C"] });
        expect(machineProfile("generic-5-axis-trunnion")!.kinematics?.chain).toEqual(["A", "C"]);
        expect(machineProfile("generic-waterjet")!.cutting?.kerf).toBe(0.8);
        expect(machineProfile("generic-plasma")!.cutting).toMatchObject({
            kerf: 1.5,
            torchHeightControl: true,
        });
        expect(machineProfile("generic-wire-edm")!.wire).toMatchObject({ wireDiameter: 0.25, maxTaper: 30 });
        expect(machineProfile("grbl-router")!.post.id).toBe("grbl");
        expect(machineProfile("tormach-1100mx")!.post.id).toBe("linuxcnc");
    });
});

describe("profile files", () => {
    test("export and import round-trip one profile or several", () => {
        const one = machineProfile("haas-vf2")!;
        expect(importMachineProfiles(exportMachineProfiles([one])).value).toEqual([one]);
        const two = [one, machineProfile("generic-plasma")!];
        expect(importMachineProfiles(exportMachineProfiles(two)).value).toEqual(two);
    });

    test.each([
        ["not JSON", "{", "Not a JSON file"],
        ["no id", JSON.stringify({ name: "x" }), "The profile has no id"],
        ["a bad kind", JSON.stringify({ id: "x", name: "x", kind: "lathe" }), 'Unknown machine kind "lathe"'],
        [
            "inverted limits",
            JSON.stringify({ id: "x", name: "x", kind: "mill", linearAxes: [{ name: "X", min: 5, max: 1 }] }),
            "Axis X needs min ≤ max",
        ],
        [
            "a tool without feed",
            JSON.stringify({
                ...machineProfile("generic-3-axis"),
                tools: [{ id: "t", number: 1, name: "T", kind: "drill", diameter: 3, cutting: {} }],
            }),
            'Tool "T" needs cutting.feed',
        ],
    ])("refuses %s", (_name, text, message) => {
        const result = importMachineProfiles(text);
        expect(result.isOk).toBe(false);
        expect(result.isOk ? "" : result.error).toContain(message);
    });
});

describe("where a setup's machine comes from", () => {
    const custom = { ...machineProfile("generic-3-axis")!, name: "Shop mill" };

    test("the browser library keeps profiles and skips broken entries", () => {
        const library = new UserMachineLibrary("test.machines");
        expect(library.list()).toEqual([]);
        expect(library.save(custom)).toBe(true);
        globalThis.localStorage.setItem("test.machines", JSON.stringify([custom, { id: "broken" }]));
        expect(library.list()).toEqual([custom]);
        expect(library.remove(custom.id)).toBe(true);
        expect(library.list()).toEqual([]);
    });

    test("the document's copy shadows the browser library, which shadows the built-in", () => {
        const studio = new CamStudioNode({ document: createMockDocument() });
        expect(resolveMachine(studio, "generic-3-axis")?.source).toBe("library");
        userMachines.save({ ...custom, name: "Mine" });
        expect(resolveMachine(studio, "generic-3-axis")).toMatchObject({
            source: "user",
            profile: { name: "Mine" },
        });
        studio.setMachines([{ ...custom, name: "In the document" }]);
        expect(resolveMachine(studio, "generic-3-axis")).toMatchObject({
            source: "document",
            profile: { name: "In the document" },
        });
        expect(resolveMachine(studio, "nope")).toBeUndefined();
    });
});
