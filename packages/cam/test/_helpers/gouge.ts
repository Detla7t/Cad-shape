// Part of the Chili3d Project, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

import type { DropCutter } from "../../src";

/**
 * Whether a tip position is within `tolerance` (3D) of the region on or above the
 * cutter-location surface: some point of the ball of that radius around it, sampled, is.
 * (A vertical comparison alone would flag chord-sized overlaps along walls, where the
 * surface height jumps.)
 */
export function withinTolerance(
    drop: DropCutter,
    x: number,
    y: number,
    z: number,
    tolerance: number,
): boolean {
    if (z >= drop.drop(x, y) - tolerance) return true;
    for (let a = 0; a < 7; a++) {
        const phi = (a * Math.PI) / 12;
        for (let k = 0; k < 24; k++) {
            const theta = (k * Math.PI) / 12;
            const t = tolerance * Math.cos(phi);
            const zz = z + tolerance * Math.sin(phi);
            if (drop.drop(x + t * Math.cos(theta), y + t * Math.sin(theta)) <= zz) return true;
        }
    }
    return false;
}
