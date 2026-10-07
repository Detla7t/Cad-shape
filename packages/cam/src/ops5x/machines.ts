// Part of the Chili3d Project, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

import type { LinearAxisData, MachineProfileData } from "../model/machine";
import type { ToolData } from "../model/tool";

/**
 * Generic 5-axis profiles with full kinematics, one per kinematic family, for the 5-axis
 * strategies and posts (vendor machines live in the machine library).
 */

const LINEAR_AXES: readonly LinearAxisData[] = [
    { name: "X", min: -300, max: 300 },
    { name: "Y", min: -250, max: 250 },
    { name: "Z", min: -400, max: 0 },
];

const TOOLS: readonly ToolData[] = [
    {
        id: "5ax-flat-10",
        number: 1,
        name: "Flat endmill 10 mm",
        kind: "flatEndmill",
        diameter: 10,
        fluteLength: 30,
        stickout: 45,
        holder: { diameter: 32, length: 50 },
        flutes: 3,
        cutting: {
            spindleRpm: 9000,
            feed: 1500,
            plungeFeed: 500,
            stepdown: 5,
            stepover: 4,
            coolant: "flood",
        },
    },
    {
        id: "5ax-ball-6",
        number: 2,
        name: "Ball endmill 6 mm",
        kind: "ballEndmill",
        diameter: 6,
        fluteLength: 18,
        stickout: 40,
        holder: { diameter: 25, length: 50 },
        flutes: 2,
        cutting: { spindleRpm: 12000, feed: 1200, plungeFeed: 400, stepover: 0.5, coolant: "flood" },
    },
    {
        id: "5ax-bull-10",
        number: 3,
        name: "Bull nose 10 mm R1",
        kind: "bullNose",
        diameter: 10,
        cornerRadius: 1,
        fluteLength: 25,
        stickout: 45,
        holder: { diameter: 32, length: 50 },
        flutes: 4,
        cutting: { spindleRpm: 9000, feed: 1500, plungeFeed: 500, stepover: 2, coolant: "flood" },
    },
];

export const GENERIC_AC_TRUNNION: MachineProfileData = {
    id: "generic-5ax-ac-trunnion-kin",
    name: "Generic 5-axis AC trunnion (table-table)",
    kind: "mill",
    linearAxes: LINEAR_AXES,
    rotaryAxes: [
        { name: "A", direction: [1, 0, 0], min: -120, max: 30, carrier: "table" },
        { name: "C", direction: [0, 0, 1], carrier: "table" },
    ],
    kinematics: {
        type: "table-table",
        chain: ["A", "C"],
        tableCenter: [0, 0, 0],
        toolCenterPointControl: true,
    },
    spindle: { minRpm: 100, maxRpm: 15000 },
    maxFeed: 10000,
    rapidFeed: 30000,
    post: { id: "fanuc-30i-5axis" },
    tools: TOOLS,
};

export const GENERIC_BC_HEAD_TABLE: MachineProfileData = {
    id: "generic-5ax-bc-head-table-kin",
    name: "Generic 5-axis BC head-table",
    kind: "mill",
    linearAxes: LINEAR_AXES,
    rotaryAxes: [
        { name: "B", direction: [0, 1, 0], min: -110, max: 110, carrier: "head" },
        { name: "C", direction: [0, 0, 1], carrier: "table" },
    ],
    kinematics: {
        type: "head-table",
        chain: ["B", "C"],
        pivotLength: 150,
        tableCenter: [0, 0, 0],
        toolCenterPointControl: true,
    },
    spindle: { minRpm: 100, maxRpm: 18000 },
    maxFeed: 12000,
    rapidFeed: 30000,
    post: { id: "heidenhain-tnc-5axis" },
    tools: TOOLS,
};

export const GENERIC_CA_HEAD_HEAD: MachineProfileData = {
    id: "generic-5ax-ca-head-head-kin",
    name: "Generic 5-axis CA head-head",
    kind: "mill",
    linearAxes: [
        { name: "X", min: 0, max: 3000 },
        { name: "Y", min: 0, max: 2000 },
        { name: "Z", min: -1000, max: 0 },
    ],
    rotaryAxes: [
        { name: "C", direction: [0, 0, 1], min: -360, max: 360, carrier: "head" },
        { name: "A", direction: [1, 0, 0], min: -105, max: 105, carrier: "head" },
    ],
    kinematics: { type: "head-head", chain: ["C", "A"], pivotLength: 200, toolCenterPointControl: true },
    spindle: { minRpm: 100, maxRpm: 24000 },
    maxFeed: 15000,
    rapidFeed: 40000,
    post: { id: "siemens-840d-5axis" },
    tools: TOOLS,
};

/** The AC trunnion again, without tool centre point control: posted in machine coordinates. */
export const GENERIC_AC_TRUNNION_NON_TCP: MachineProfileData = {
    ...GENERIC_AC_TRUNNION,
    id: "generic-5ax-ac-trunnion-nontcp-kin",
    name: "Generic 5-axis AC trunnion (no TCP)",
    kinematics: { ...GENERIC_AC_TRUNNION.kinematics!, toolCenterPointControl: false },
    post: { id: "generic-5axis-nontcp" },
};

export const FIVE_AXIS_MACHINES: readonly MachineProfileData[] = [
    GENERIC_AC_TRUNNION,
    GENERIC_BC_HEAD_TABLE,
    GENERIC_CA_HEAD_HEAD,
    GENERIC_AC_TRUNNION_NON_TCP,
];
