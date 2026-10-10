// Part of the Chili3d Project, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

import { type EntityRef, entityKey, FsContext } from "../context/fsContext";
import { curveEnds, distinctSketchEdges, orderPaths } from "../context/paths";
import { query, relatedEntities, resolveQuery, transientQuery } from "../context/queries";
import { FsMap, type FsValue, fail, fsArray, fsMap } from "../lang/values";
import type { StdBridge } from "./bridge";
import type { BuiltinRegistry } from "./registry";

/**
 * `@constructPaths`: the edges of a query as std `Path`s. With seed faces, each path's
 * `adjacentFaces` holds the seed faces bounded by its edges (Onshape also grows them
 * over the whole side of the path; only the seeds are reported here).
 */
export function installPathBuiltins(define: BuiltinRegistry, bridge: StdBridge): void {
    define("constructPaths", (args) => {
        const ctx = FsContext.of(args[0]);
        const definition = args[1];
        if (!(definition instanceof FsMap)) fail("constructPaths needs a definition map");
        const refs = distinctSketchEdges(resolveQuery(ctx, bridge.toLocal(definition.field("edges"))));
        if (refs.some((ref) => ref.kind !== "EDGE")) fail("constructPaths takes edges only");
        const seedValue = definition.field("seedFaces");
        const seeds = seedValue === undefined ? [] : resolveQuery(ctx, bridge.toLocal(seedValue));
        const seedKeys = new Set(seeds.filter((ref) => ref.kind === "FACE").map(entityKey));
        const ends = refs.map((ref) => curveEnds(ref.body.edges()[ref.index]));
        const paths = orderPaths(ends).map((chain) => {
            const path: { edges: FsValue; flipped: FsValue; closed: boolean; adjacentFaces?: FsValue } = {
                edges: fsArray(chain.steps.map((step) => transientQuery(refs[step.edge]))),
                flipped: fsArray(chain.steps.map((step) => step.flipped)),
                closed: chain.closed,
            };
            const adjacent = adjacentSeeds(
                chain.steps.map((step) => refs[step.edge]),
                seedKeys,
            );
            if (adjacent.length > 0)
                path.adjacentFaces = query("UNION", { subqueries: fsArray(adjacent.map(transientQuery)) });
            return fsMap(path, "Path");
        });
        return bridge.toStd(fsArray(paths));
    });
}

function adjacentSeeds(edges: readonly EntityRef[], seedKeys: ReadonlySet<string>): EntityRef[] {
    const found = new Map<string, EntityRef>();
    for (const edge of edges) {
        for (const face of relatedEntities(edge, "FACE")) {
            const key = entityKey(face);
            if (seedKeys.has(key)) found.set(key, face);
        }
    }
    return [...found.values()];
}
