// Part of the Chili3d Project, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

import { type Intersection, type Object3D, Points, Vector3 } from "three";

const anchor = new Vector3();
const normal = new Vector3();

/**
 * Raycast hits ordered for picking: by depth, except that a point or line lying on a surface hit
 * nearer the camera comes before that surface — the smaller target wins (vertex, then edge, then
 * face), as with a sketch curve on the plane it was drawn on. A line or point hit reports the
 * nearest point of the ray, which lands before or after the surface crossing by chance, so depth
 * alone cannot order them. `tolerance` is the world distance off the surface still counted as on it.
 */
export function preferSmallerTargets<T extends Object3D>(
    hits: Intersection<T>[],
    tolerance: number,
): Intersection<T>[] {
    const result = [...hits];
    for (let i = 0; i < result.length; i++) {
        const surface = result[i];
        if (!isSurfaceHit(surface)) continue;
        const onSurface: Intersection<T>[] = [];
        for (let j = i + 1; j < result.length; j++) {
            const hit = result[j];
            if (!isSurfaceHit(hit) && liesOnSurface(hit, surface, tolerance)) onSurface.push(hit);
        }
        if (onSurface.length === 0) continue;
        const moved = [
            ...onSurface.filter((hit) => hit.object instanceof Points),
            ...onSurface.filter((hit) => !(hit.object instanceof Points)),
        ];
        const rest = result.filter((hit) => !onSurface.includes(hit));
        rest.splice(i, 0, ...moved);
        result.splice(0, result.length, ...rest);
        i += moved.length;
    }
    return result;
}

function isSurfaceHit(hit: Intersection): boolean {
    return hit.pointOnLine === undefined && !(hit.object instanceof Points) && !!hit.face;
}

function liesOnSurface(hit: Intersection, surface: Intersection, tolerance: number): boolean {
    if (!hitAnchor(hit, anchor) || !surface.face) return false;
    normal.copy(surface.face.normal).transformDirection(surface.object.matrixWorld);
    return Math.abs(anchor.sub(surface.point).dot(normal)) <= tolerance;
}

/** Where a line or point hit lies on its object (not on the ray), in world coordinates. */
function hitAnchor(hit: Intersection, target: Vector3): boolean {
    if (hit.pointOnLine) {
        target.copy(hit.pointOnLine);
        return true;
    }
    if (hit.object instanceof Points && hit.index !== undefined) {
        const position = hit.object.geometry.getAttribute("position");
        if (!position || hit.index >= position.count) return false;
        target.fromBufferAttribute(position, hit.index).applyMatrix4(hit.object.matrixWorld);
        return true;
    }
    return false;
}
