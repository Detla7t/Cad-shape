// Part of the Chili3d Project, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

import { machineProfile, registerMachineProfile } from "../model/machine";
import { registerCamOperation } from "../model/operation";
import { registerPostProcessor } from "../model/post";
import { FIVE_AXIS_MACHINES } from "./machines";
import { flowlineHandler } from "./ops/flowline";
import { indexedHandler } from "./ops/indexed";
import { contourHandler } from "./ops/surfaceNormal";
import { swarfHandler } from "./ops/swarf";
import { FANUC_30I_POST, GENERIC_NON_TCP_POST, HAAS_UMC_POST } from "./posts/gcodeFamily";
import { HEIDENHAIN_TNC_POST } from "./posts/heidenhain";
import { SIEMENS_840D_POST } from "./posts/siemens840d";

/**
 * 5-axis CAM: kinematics, linearization, the 3+2 / swarf / multi-axis contour / flowline
 * strategies and the 5-axis posts. Helpers (moves, surfaces, post formatting) stay internal
 * to `ops5x/`; import them by path.
 */

export {
    avoidCollision,
    type Collision,
    type ToolAssembly,
    TriangleGrid,
    toolAssembly,
    toolCollision,
} from "./collision";
export {
    FiveAxisKinematics,
    type IkSolution,
    type JointAngles,
    type KinematicsOptions,
    type RotaryJoint,
} from "./kinematics";
export {
    interpolatedTip,
    type LinearizeOptions,
    limitAxisSteps,
    linearizeSegment,
    type MotionPoint,
    motionPoint,
    rotaryDelta,
} from "./linearize";
export {
    FIVE_AXIS_MACHINES,
    GENERIC_AC_TRUNNION,
    GENERIC_AC_TRUNNION_NON_TCP,
    GENERIC_BC_HEAD_TABLE,
    GENERIC_CA_HEAD_HEAD,
} from "./machines";
export { FLOWLINE_5X_TYPE, flowlineHandler } from "./ops/flowline";
export { INDEXED_TYPE, indexedHandler, tiltedContext } from "./ops/indexed";
export { CONTOUR_5X_TYPE, contourHandler } from "./ops/surfaceNormal";
export { SWARF_TYPE, swarfHandler, wallRulings } from "./ops/swarf";
export { FANUC_30I_POST, GENERIC_NON_TCP_POST, HAAS_UMC_POST } from "./posts/gcodeFamily";
export { HEIDENHAIN_TNC_POST } from "./posts/heidenhain";
export {
    type PlannedToolpath,
    type ProgramPlan,
    planProgram as planFiveAxisProgram,
    type ToolpathMode,
    toolpathMode,
} from "./posts/plan";
export { SIEMENS_840D_POST } from "./posts/siemens840d";
export { leadTiltAxis, tipFromContact } from "./toolContact";

/** Registers the 5-axis operations, posts and (missing) generic 5-axis machine profiles. */
export function registerFiveAxis(): void {
    for (const handler of [indexedHandler, swarfHandler, contourHandler, flowlineHandler]) {
        registerCamOperation(handler);
    }
    for (const post of [
        FANUC_30I_POST,
        HAAS_UMC_POST,
        SIEMENS_840D_POST,
        HEIDENHAIN_TNC_POST,
        GENERIC_NON_TCP_POST,
    ]) {
        registerPostProcessor(post);
    }
    for (const profile of FIVE_AXIS_MACHINES) {
        if (machineProfile(profile.id) === undefined) registerMachineProfile(profile);
    }
}

registerFiveAxis();
