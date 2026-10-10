// Part of the Chili3d Project, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

import { expectArray, FsArray } from "../lang/values";
import type { StdBuilder } from "../std/registry";
import { entityAttr, type FsBody, FsContext } from "./fsContext";
import { definitionOf } from "./operations";
import { resolveQuery } from "./queries";

/**
 * `opMergeContexts`: brings another context's bodies (its default planes and origin
 * excepted) into this one, as copies created by the operation — what std's Derived
 * feature builds on. `trackThroughMerge` queries are evaluated in the other context and
 * answered with the transient ids of the copied entities. Mate connector owners and
 * composite constituents are carried over to the copies.
 */
export function installMergeContexts(std: StdBuilder): void {
    std.fn("opMergeContexts", (args) => {
        const [ctx, id, definition] = definitionOf(args, "opMergeContexts");
        const from = FsContext.of(definition.field("contextFrom"));
        if (from === ctx) return new FsArray([]);
        const copies = new Map<FsBody, FsBody>();
        const serials = new Map<number, number>();
        for (const body of from.bodies) {
            if (body.flags.defaultGeometry) continue;
            const copy = ctx.addBody(ctx.track(body.shape.clone()), id, { ...body.flags });
            copy.name = body.name;
            copy.faceAttrs = body.faceAttrs.map((attr, i) => ({ ...copy.faceAttrs[i], cap: attr.cap }));
            copy.edgeAttrs = body.edgeAttrs.map((attr, i) => ({
                ...copy.edgeAttrs[i],
                sketchEntity: attr.sketchEntity,
            }));
            copies.set(body, copy);
            serials.set(body.bodyAttr.serial, copy.bodyAttr.serial);
        }
        // References between bodies (owners, constituents) follow the copies.
        for (const copy of copies.values()) {
            const connector = copy.flags.mateConnector;
            if (connector !== undefined)
                Object.assign(copy.flags, {
                    mateConnector: {
                        ...connector,
                        owner: connector.owner === undefined ? undefined : serials.get(connector.owner),
                        attachedTo:
                            connector.attachedTo === undefined
                                ? undefined
                                : serials.get(connector.attachedTo),
                    },
                });
            const composite = copy.flags.composite;
            if (composite !== undefined)
                Object.assign(copy.flags, {
                    composite: {
                        closed: composite.closed,
                        members: composite.members.flatMap((serial) => serials.get(serial) ?? []),
                    },
                });
        }
        const tracked = definition.field("trackThroughMerge");
        if (tracked === undefined) return new FsArray([]);
        return new FsArray(
            expectArray(tracked, "trackThroughMerge").items.map(
                (q) =>
                    new FsArray(
                        resolveQuery(from, q).flatMap((ref) => {
                            const copy = copies.get(ref.body);
                            if (copy === undefined) return [];
                            // A copy enumerates its sub-shapes as the original does.
                            return [`T${entityAttr({ ...ref, body: copy }).serial}`];
                        }),
                    ),
            ),
        );
    });
}
