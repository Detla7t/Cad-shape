// Part of the Chili3d Project, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

import type { MachineProfileData } from "../../src/model/machine";
import type { CamProgram } from "../../src/model/post";
import type { SetupData } from "../../src/model/setup";
import type { ToolData } from "../../src/model/tool";
import type { ToolpathData, Vec3 } from "../../src/model/toolpath";
import { DEG } from "../../src/ops5x/vec";

/** A short program for post goldens: a 3-axis profile, a 3+2 face, a simultaneous sweep. */

export const BALL_6: ToolData = {
    id: "ball6",
    number: 2,
    name: "Ball 6",
    kind: "ballEndmill",
    diameter: 6,
    fluteLength: 18,
    stickout: 40,
    holder: { diameter: 25, length: 50 },
    cutting: { spindleRpm: 12000, feed: 1200, plungeFeed: 400, coolant: "flood" },
};

export function tilted(polar: number, azimuth: number): Vec3 {
    const p = polar * DEG;
    const a = azimuth * DEG;
    return [Math.sin(p) * Math.cos(a), Math.sin(p) * Math.sin(a), Math.cos(p)];
}

export const SETUP: SetupData = {
    id: "s1",
    name: "Op 1",
    machineId: "generic-5ax-ac-trunnion-kin",
    wcs: { origin: [0, 0, 0], xAxis: [1, 0, 0], zAxis: [0, 0, 1] },
    stock: { kind: "box", margin: { x: 2, y: 2, zTop: 1, zBottom: 0 } },
    partIds: ["p1"],
    operations: [],
    programName: "1234",
};

const THREE_AXIS: ToolpathData = {
    toolId: "ball6",
    label: "Profile",
    moves: [
        { kind: "rapid", to: [0, 0, 20] },
        { kind: "rapid", to: [0, 0, 2] },
        { kind: "linear", to: [0, 0, -1], feed: 400 },
        { kind: "linear", to: [10, 0, -1], feed: 1200 },
        { kind: "arc", to: [20, 10, -1], center: [10, 10, -1], clockwise: false, plane: "XY", feed: 1200 },
        { kind: "rapid", to: [20, 10, 20] },
    ],
};

const AXIS_32 = tilted(30, 90);

const INDEXED: ToolpathData = {
    toolId: "ball6",
    label: "Tilted face",
    moves: [
        { kind: "rapid", to: [0, 10, 30], axis: AXIS_32 },
        { kind: "rapid", to: [0, 2.5, 5.33], axis: AXIS_32 },
        { kind: "linear", to: [0, 0, 1], feed: 400, axis: AXIS_32 },
        { kind: "linear", to: [15, 0, 1], feed: 1200, axis: AXIS_32 },
        { kind: "rapid", to: [15, 10, 30], axis: AXIS_32 },
    ],
};

const SIMULTANEOUS: ToolpathData = {
    toolId: "ball6",
    label: "Sweep",
    moves: [
        { kind: "rapid", to: [0, 0, 10], axis: [0, 0, 1] },
        { kind: "linear", to: [0, 0, 0], feed: 400, axis: [0, 0, 1] },
        { kind: "linear", to: [10, 0, 0], feed: 1000, axis: tilted(10, 180) },
        { kind: "linear", to: [20, 0, 0], feed: 1000, axis: tilted(20, 180) },
        { kind: "rapid", to: [20, 0, 20], axis: tilted(20, 180) },
    ],
};

export function program(machine: MachineProfileData): CamProgram {
    return {
        name: "Bracket",
        machine,
        setup: SETUP,
        tools: new Map([[BALL_6.id, BALL_6]]),
        toolpaths: [THREE_AXIS, INDEXED, SIMULTANEOUS],
    };
}
