// Part of the Chili3d Project, under the AGPL-3.0 License.
// See LICENSE file in the project root for full license information.

import { type FsValue, fail, toDisplayString } from "../lang/values";
import { enumName, type StdBuilder } from "../std/registry";
import { type EntityRef, entityAttr, type FsBody, type FsContext } from "./fsContext";
import { definitionOf, kernel } from "./operations";
import { entitiesOf, ownerBodies, query, registerQueryType, resolveQuery } from "./queries";

/**
 * Composite parts and named entities. A composite part is a body of its own (BodyType
 * COMPOSITE) holding no geometry, only its constituents by body serial — so it follows
 * them through every rebuild; a closed one consumes them (`qConsumed`). `opNameEntity`
 * names entities by serial for `qNamed`.
 */

const names = new WeakMap<FsContext, Map<string, number[]>>();

function namesOf(ctx: FsContext): Map<string, number[]> {
    let map = names.get(ctx);
    if (map === undefined) {
        map = new Map();
        names.set(ctx, map);
    }
    return map;
}

/** The bodies a query names, composites replaced by their constituents. */
function constituents(ctx: FsContext, refs: readonly EntityRef[]): FsBody[] {
    const result = new Set<FsBody>();
    for (const { body } of ownerBodies(refs)) {
        if (body.flags.composite === undefined) {
            if (body.isModelGeometry) result.add(body);
            continue;
        }
        for (const member of membersOf(ctx, body)) result.add(member);
    }
    return [...result];
}

function membersOf(ctx: FsContext, composite: FsBody): FsBody[] {
    const serials = new Set(composite.flags.composite?.members ?? []);
    return ctx.bodies.filter((body) => serials.has(body.bodyAttr.serial));
}

function composites(ctx: FsContext): FsBody[] {
    return ctx.bodies.filter((body) => body.flags.composite !== undefined);
}

/** Bodies that are constituents of a closed composite part. */
function consumedSerials(ctx: FsContext): Set<number> {
    return new Set(
        composites(ctx)
            .filter((body) => body.flags.composite?.closed === true)
            .flatMap((body) => body.flags.composite?.members ?? []),
    );
}

function wantsClosed(value: FsValue): boolean | undefined {
    if (value === undefined) return undefined;
    return enumName(value, "CompositePartType", "compositePartType") === "CLOSED";
}

export function installCompositeParts(std: StdBuilder): void {
    std.fn("opCreateCompositePart", (args) => {
        const [ctx, id, definition] = definitionOf(args, "opCreateCompositePart");
        const members = constituents(ctx, resolveQuery(ctx, definition.field("bodies")));
        if (members.length === 0) fail("opCreateCompositePart needs bodies");
        const empty = kernel(shapeFactory.combine([]), "opCreateCompositePart");
        const composite = ctx.addBody(empty, id, {
            composite: { closed: definition.field("closed") === true, members: members.map(serialOf) },
        });
        ctx.derive(id, composite.bodyAttr.serial, members.map(serialOf), "create");
        return undefined;
    });
    std.fn("opModifyCompositePart", (args) => {
        const [ctx, id, definition] = definitionOf(args, "opModifyCompositePart");
        const targets = ownerBodies(resolveQuery(ctx, definition.field("composite")))
            .map((ref) => ref.body)
            .filter((body) => body.flags.composite !== undefined);
        if (targets.length !== 1) fail("opModifyCompositePart needs one composite part");
        const composite = targets[0];
        const data = composite.flags.composite;
        if (data === undefined) fail("opModifyCompositePart needs a composite part");
        const add = definition.has("toAdd")
            ? constituents(ctx, resolveQuery(ctx, definition.field("toAdd")))
            : [];
        const remove = new Set(
            definition.has("toRemove")
                ? constituents(ctx, resolveQuery(ctx, definition.field("toRemove"))).map(serialOf)
                : [],
        );
        const members = [...new Set([...data.members, ...add.map(serialOf)])].filter((s) => !remove.has(s));
        if (members.length === 0) fail("opModifyCompositePart would leave the composite part empty");
        data.members = members;
        ctx.derive(id, composite.bodyAttr.serial, [composite.bodyAttr.serial], "modify");
        return undefined;
    });
    std.fn("opNameEntity", (args) => {
        const [ctx, , definition] = definitionOf(args, "opNameEntity");
        const refs = resolveQuery(ctx, definition.field("entity"));
        if (refs.length === 0) fail("opNameEntity: the entity query resolves to nothing");
        const name = toDisplayString(definition.field("entityName"));
        if (refs.length > 1) ctx.notes.warnings.push(`opNameEntity named ${refs.length} entities "${name}"`);
        namesOf(ctx).set(
            name,
            refs.map((ref) => entityAttr(ref).serial),
        );
        return undefined;
    });

    std.fn("qNamed", (args) => query("NAMED", { name: args[0] }));
    std.fn("qContainedInCompositeParts", (args) => query("CONTAINED_IN_COMPOSITE", { query: args[0] }));
    std.fn("qCompositePartsContaining", (args) =>
        query("COMPOSITE_CONTAINING", {
            query: args[0],
            ...(args[1] === undefined ? {} : { compositePartType: args[1] }),
        }),
    );
    std.fn("qCompositePartTypeFilter", (args) =>
        query("COMPOSITE_PART_TYPE_FILTER", { query: args[0], compositePartType: args[1] }),
    );
    std.fn("qConsumed", (args) => query("CONSUMED", { query: args[0], consumed: args[1] }));

    registerQueryType("NAMED", (ctx, value) => {
        const serials = new Set(namesOf(ctx).get(toDisplayString(value.field("name"))) ?? []);
        return ctx.bodies.flatMap((body) =>
            entitiesOf(body, undefined).filter((ref) => serials.has(entityAttr(ref).serial)),
        );
    });
    registerQueryType("CONTAINED_IN_COMPOSITE", (ctx, value) => {
        const parts = ownerBodies(resolveQuery(ctx, value.field("query"))).filter(
            (ref) => ref.body.flags.composite !== undefined,
        );
        return [...new Set(parts.flatMap((ref) => membersOf(ctx, ref.body)))].map((body) => bodyRef(body));
    });
    registerQueryType("COMPOSITE_CONTAINING", (ctx, value) => {
        const bodies = new Set(
            ownerBodies(resolveQuery(ctx, value.field("query"))).map((ref) => serialOf(ref.body)),
        );
        const closed = wantsClosed(value.field("compositePartType"));
        return composites(ctx)
            .filter((composite) => closed === undefined || composite.flags.composite?.closed === closed)
            .filter((composite) => composite.flags.composite?.members.some((serial) => bodies.has(serial)))
            .map(bodyRef);
    });
    registerQueryType("COMPOSITE_PART_TYPE_FILTER", (ctx, value) => {
        const closed = wantsClosed(value.field("compositePartType"));
        return resolveQuery(ctx, value.field("query")).filter(
            (ref) =>
                ref.kind === "BODY" &&
                ref.body.flags.composite !== undefined &&
                (closed === undefined || ref.body.flags.composite.closed === closed),
        );
    });
    registerQueryType("CONSUMED", (ctx, value) => {
        const consumed = consumedSerials(ctx);
        const yes = enumName(value.field("consumed"), "Consumed", "consumed") === "YES";
        return resolveQuery(ctx, value.field("query")).filter(
            (ref) => consumed.has(serialOf(ref.body)) === yes,
        );
    });
}

const serialOf = (body: FsBody): number => body.bodyAttr.serial;
const bodyRef = (body: FsBody): EntityRef => ({ body, kind: "BODY", index: -1 });
