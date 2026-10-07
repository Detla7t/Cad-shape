// Part of the Chili3d Project, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

import { type CamOperationHandler, registerCamOperation } from "../model/operation";
import { chamferOperation } from "./chamfer";
import { contourOperation } from "./contour";
import { markOperation, profileCutOperation } from "./cutting";
import { drillOperation } from "./drill";
import { engraveOperation, vcarveOperation } from "./engrave";
import { faceOperation } from "./face";
import { pocketOperation } from "./pocket";
import { slotOperation } from "./slot";
import { threadMillOperation } from "./threadMill";
import { wireContourOperation } from "./wireEdm";

export * from "./chamfer";
export * from "./common";
export * from "./contour";
export * from "./cutting";
export * from "./drill";
export * from "./engrave";
export * from "./entries";
export * from "./face";
export * from "./geometry";
export * from "./holes";
export * from "./moves";
export { ParamReader } from "./params";
export * from "./passes";
export * from "./pocket";
export * from "./slot";
export * from "./threadMill";
export * from "./wireEdm";

/** The 2D / 2.5D milling, 2D cutting and wire EDM operations. */
export const OPERATIONS_2D: readonly CamOperationHandler[] = [
    faceOperation,
    contourOperation,
    pocketOperation,
    drillOperation,
    chamferOperation,
    engraveOperation,
    vcarveOperation,
    threadMillOperation,
    slotOperation,
    profileCutOperation,
    markOperation,
    wireContourOperation,
];

for (const handler of OPERATIONS_2D) registerCamOperation(handler);
