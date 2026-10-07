// Part of the Chili3d Project, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

import type { IEdge, IFace, XYZ, XYZLike } from "@chili3d/core";
import { profileEdgeEntityIds, profileEntityIds } from "./profileEntities";
import { captureRegionFingerprint } from "./profileRef";
import { MATCH_TOLERANCE } from "./refGeometry";

/**
 * Content-derived seed keys for profile regions and their boundary edges.
 *
 * A seed becomes the stem of the stable ids a sweep gives the geometry it generates from
 * a profile (see `sweepProfileTracked` in extrude.ts). It has to be derived from what the
 * region IS, not from where it sits in an enumeration: the kernel is free to re-enumerate
 * faces and edges after any rebuild, and a positional stem would then silently realign
 * onto a neighbour. Entity ids are the sketch's own stable identity, so they are the stem
 * — with a positional ordinal only as the fallback where attribution is unavailable.
 */

/**
 * Seed keys parallel to `all`: `e{id.id...}` of the sorted bounding entity ids,
 * falling back to the positional index when entity ids are unknown. Profiles bounded
 * by the same entity set (crossing-path lens regions) are told apart by an occurrence
 * suffix assigned in region-fingerprint order — content-derived, so the suffix
 * follows the region rather than the kernel's enumeration order. Computed over the
 * FULL profile list: the occurrence suffix of a duplicated entity set must not depend
 * on which profiles the feature selected.
 */
export function profileSeeds(all: IFace[]): string[] {
    const groups = new Map<string, number[]>();
    all.forEach((face, index) => {
        const entities = profileEntityIds(face);
        const key = entities === undefined ? `${index}` : `e${entities.join(".")}`;
        const group = groups.get(key);
        if (group === undefined) groups.set(key, [index]);
        else group.push(index);
    });
    const seeds = new Array<string>(all.length);
    for (const [key, group] of groups) {
        if (group.length === 1) {
            seeds[group[0]] = key;
            continue;
        }
        // Fingerprints are captured once per face — the comparator must stay pure,
        // and each capture is two kernel queries.
        const ranked = group
            .map((index) => ({ index, region: captureRegionFingerprint(all[index]) }))
            .sort((a, b) => compareRegionFingerprints(a.region, b.region));
        ranked.forEach(({ index }, occurrence) => {
            seeds[index] = occurrence === 0 ? key : `${key}~${occurrence}`;
        });
    }
    return seeds;
}

/** Region-fingerprint order (bbox center, then area) — the tiebreak recipe of `matchProfileIndexes`. */
function compareRegionFingerprints(
    a: { center: XYZLike; area: number },
    b: { center: XYZLike; area: number },
): number {
    return a.center.x - b.center.x || a.center.y - b.center.y || a.center.z - b.center.z || a.area - b.area;
}

/**
 * Sketch-scoped seeds of a profile face's boundary edges, for the swept sub-shape ids: the seed
 * of each edge is `ent<entityId>` of the sketch entity that generated it.
 *
 * - **Why entity ids, not ordinals.** They survive wire re-enumeration, where positional
 *   ordinals silently realign onto another edge when a mirrored or rewound profile permutes the
 *   edge order. The ordinal remains the fallback only where entity attribution is unavailable
 *   (test mocks).
 * - **Caller contract:** `edges` must be the face's OWN `findSubShapes(ShapeTypes.edge)`
 *   enumeration in the same order — the registered entity attribution
 *   (`profileEdgeEntityIds`) runs parallel to it.
 */
export function profileEdgeSeeds(face: IFace, baseSeed: string, edges: IEdge[]): string[] {
    const entities = profileEdgeEntityIds(face);
    return edges.map((_, index) => {
        const entity = entities?.[index];
        return entity === undefined ? `${baseSeed}:e${index}` : `${baseSeed}:ent${entity}`;
    });
}

/**
 * Seeds the sweep edges the kernel's edge history leaves unmapped — the end-cap copies of
 * the profile's edges, and the edges its vertices sweep (a prism's lateral lines, a
 * revolve's circles and arcs) — from the profile edges they derive from.
 *
 * Left positional (`${featureId}:${index}`), they realign onto a look-alike whenever the
 * kernel re-enumerates the solid — sub-tolerance noise in a re-solved sketch is enough — and
 * `edgeMatchesRefInvariant` cannot catch it: a rectangle's opposite cap edges are parallel,
 * a revolve's circles coaxial. An edge feature would silently move to the wrong edge.
 *
 * - **Cap copy:** its mid point is a profile edge's mid point carried by `capOf` (the
 *   sweep's motion) → `${edgeSeed}:cap`.
 * - **Vertex sweep:** one end on a profile vertex → the sorted seeds of the profile edges
 *   meeting there, `:sweep`. Two vertices bounded by the same edge pair (a two-edge loop)
 *   are told apart by an occurrence suffix in vertex-coordinate order, the
 *   `profileSeeds` recipe.
 * - Anything else keeps the positional id it already has.
 */
export function seedSweptEdges(
    edgeIds: string[],
    outputEdges: readonly IEdge[],
    edgeMap: readonly number[],
    profileEdges: readonly IEdge[],
    edgeSeeds: readonly string[],
    capOf: (point: XYZ) => XYZ,
): void {
    const near = (a: XYZ, b: XYZ) => a.distanceTo(b) < MATCH_TOLERANCE;
    const capMids = profileEdges.map((edge) => capOf(midPoint(edge)));
    const ends = profileEdges.map((edge) => [edge.startPoint(), edge.endPoint()]);
    const swept = new Map<string, { index: number; vertex: XYZ }[]>();
    for (const [index, edge] of outputEdges.entries()) {
        if (edgeMap[index] >= 0) continue;
        const mid = midPoint(edge);
        const copy = capMids.findIndex((point) => near(point, mid));
        if (copy >= 0) {
            edgeIds[index] = `${edgeSeeds[copy]}:cap`;
            continue;
        }
        const vertex = [edge.startPoint(), edge.endPoint()].find((point) =>
            ends.some((pair) => pair.some((end) => near(end, point))),
        );
        if (vertex === undefined) continue;
        const meeting = [
            ...new Set(edgeSeeds.filter((_, k) => ends[k].some((end) => near(end, vertex)))),
        ].sort();
        const key = `${meeting.join("&")}:sweep`;
        const group = swept.get(key) ?? [];
        group.push({ index, vertex });
        swept.set(key, group);
    }
    for (const [key, group] of swept) {
        group
            .sort((a, b) => a.vertex.x - b.vertex.x || a.vertex.y - b.vertex.y || a.vertex.z - b.vertex.z)
            .forEach(({ index }, occurrence) => {
                edgeIds[index] = occurrence === 0 ? key : `${key}~${occurrence}`;
            });
    }
}

function midPoint(edge: IEdge): XYZ {
    return edge.pointAt((edge.firstParameter() + edge.lastParameter()) / 2);
}
