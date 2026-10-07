// Part of the Chili3d Project, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

import { type ToolData, tipRadius, toolRadius } from "../model/tool";
import type { Vec3 } from "../model/toolpath";
import { addScaled, cross, DEG, dot, length, normalize, perpendicular, reject, scale } from "./vec";

/**
 * Where the tool tip goes for a contact point on a surface: the tool (flat, ball or bull
 * nose: radius R, corner radius r) touches the surface at `contact`, whose outward normal is
 * `normal`, with its axis along `axis`. The corner torus' tube centre sits r along the normal
 * (plus any stock to leave); the tip is r back along the axis and R − r across it, towards the
 * side the surface lies on.
 */
export function tipFromContact(
    tool: ToolData,
    contact: Vec3,
    normal: Vec3,
    axis: Vec3,
    stockToLeave = 0,
): Vec3 {
    const r = tipRadius(tool);
    const flat = toolRadius(tool) - r;
    const n = normalize(normal);
    const a = normalize(axis);
    let tip = addScaled(addScaled(contact, n, r + stockToLeave), a, -r);
    // Across the axis towards the contact side of the corner circle (none when n ∥ a).
    const across = addScaled(scale(a, dot(n, a)), n, -1);
    if (flat > 1e-12 && length(across) > 1e-9) tip = addScaled(tip, normalize(across), -flat);
    return tip;
}

/**
 * The tool axis for a surface normal and feed direction, with the lead angle (tilting the
 * spindle forward, into the feed direction) and the tilt angle (sideways, to the left of the
 * feed seen from the spindle). Degrees.
 */
export function leadTiltAxis(normal: Vec3, feed: Vec3, lead: number, tilt: number): Vec3 {
    const n = normalize(normal);
    let forward = reject(feed, n);
    forward = length(forward) < 1e-9 ? perpendicular(n) : normalize(forward);
    const left = cross(n, forward);
    const l = lead * DEG;
    const t = tilt * DEG;
    const up = addScaled(scale(n, Math.cos(t)), left, Math.sin(t));
    return normalize(addScaled(scale(forward, Math.sin(l)), up, Math.cos(l)));
}
